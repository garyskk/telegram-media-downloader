// Integration tests for the scanVideos gate in startFacesScan (Phase A videos).
//
// Uses a real tmpdir DB (TGDL_DATA_DIR) and mocked faces-client so no
// sidecar process is required. Mirrors the DB-setup pattern from
// face-cluster-ops.test.js.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/core/ai/faces-client.js', async (importOriginal) => {
    const orig = await importOriginal();
    return {
        ...orig,
        detectFacesBatch: vi.fn().mockResolvedValue([]),
        detectFacesInVideo: vi.fn().mockResolvedValue([]),
    };
});

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-scan-video-'));
let db;
let dbApi;
let scannerApi;
let clientMock;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../../src/core/db.js');
    db = dbApi.getDb();
    scannerApi = await import('../../src/core/ai/scan-runner.js');
    clientMock = await import('../../src/core/ai/faces-client.js');
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    vi.clearAllMocks();
    scannerApi._resetForTests();
    db.prepare('DELETE FROM faces').run();
    db.prepare('DELETE FROM people').run();
    db.prepare('UPDATE downloads SET ai_indexed_at = NULL').run();
    db.prepare('DELETE FROM downloads').run();
});

async function waitForScan(timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (!scannerApi.getScanState('faces')?.running) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('scan timed out');
}

function insertVideoRow(filePath) {
    dbApi.insertDownload({
        groupId: '-100999',
        groupName: 'Video Test',
        messageId: Math.floor(Math.random() * 1e9),
        fileName: path.basename(filePath),
        fileSize: 1024,
        fileType: 'video',
        filePath,
    });
    return db.prepare('SELECT id FROM downloads ORDER BY id DESC LIMIT 1').get().id;
}

describe('scanVideos gate', () => {
    it('scanVideos: false — detectFacesInVideo never called, video row stays unindexed', async () => {
        const relPath = 'test.mp4';
        insertVideoRow(relPath);

        const result = await scannerApi.startFacesScan(
            { faces: { scanVideos: false, fileTypes: ['photo'] } },
            null,
            null,
            null,
        );
        expect(result).toEqual({ started: true });
        await waitForScan();

        expect(clientMock.detectFacesInVideo).not.toHaveBeenCalled();
        const row = db
            .prepare('SELECT ai_indexed_at FROM downloads WHERE file_type = ?')
            .get('video');
        expect(row.ai_indexed_at).toBeNull();
    });

    it('scanVideos: true — video row gets ai_indexed_at stamped after scan', async () => {
        const downloadsDir = path.join(DATA_DIR, 'downloads');
        fs.mkdirSync(downloadsDir, { recursive: true });
        const videoFile = path.join(downloadsDir, 'scannable.mp4');
        fs.writeFileSync(videoFile, 'fake-video');
        const relPath = 'scannable.mp4';
        const rowId = insertVideoRow(relPath);

        clientMock.detectFacesInVideo.mockResolvedValue([]);

        scannerApi.startFacesScan(
            { faces: { scanVideos: true, fileTypes: ['photo'] } },
            null,
            null,
            null,
        );
        await waitForScan();

        const row = db.prepare('SELECT ai_indexed_at FROM downloads WHERE id = ?').get(rowId);
        expect(row.ai_indexed_at).not.toBeNull();
    });

    it('scanVideos: true, video file missing on disk — row stamped, detectFacesInVideo not called', async () => {
        const relPath = 'ghost_video.mp4';
        const rowId = insertVideoRow(relPath);

        scannerApi.startFacesScan(
            { faces: { scanVideos: true, fileTypes: ['photo'] } },
            null,
            null,
            null,
        );
        await waitForScan();

        expect(clientMock.detectFacesInVideo).not.toHaveBeenCalled();
        const row = db.prepare('SELECT ai_indexed_at FROM downloads WHERE id = ?').get(rowId);
        expect(row.ai_indexed_at).not.toBeNull();
    });

    it('scanVideos: true, detectFacesInVideo returns faces — insertFace called, row stamped', async () => {
        const downloadsDir = path.join(DATA_DIR, 'downloads');
        fs.mkdirSync(downloadsDir, { recursive: true });
        const videoFile = path.join(downloadsDir, 'with_faces.mp4');
        fs.writeFileSync(videoFile, 'fake-video');
        const relPath = 'with_faces.mp4';
        const rowId = insertVideoRow(relPath);

        const fakeEmbedding = Float32Array.from({ length: 512 }, () => 0.1);
        clientMock.detectFacesInVideo.mockResolvedValue([
            { x: 10, y: 10, w: 80, h: 80, score: 0.9, embedding: fakeEmbedding },
        ]);

        scannerApi.startFacesScan(
            { faces: { scanVideos: true, fileTypes: ['photo'] } },
            null,
            null,
            null,
        );
        await waitForScan();

        const row = db.prepare('SELECT ai_indexed_at FROM downloads WHERE id = ?').get(rowId);
        expect(row.ai_indexed_at).not.toBeNull();

        const face = db.prepare('SELECT * FROM faces WHERE download_id = ?').get(rowId);
        expect(face).not.toBeUndefined();
        expect(face.x).toBe(10);
        expect(face.w).toBe(80);
    });
});

// Video scan progress reporting — detectFacesInVideo's 5th arg
// (onVideoProgress) is wired to state.currentVideo, broadcast via bump().
describe('state.currentVideo (video scan progress reporting)', () => {
    it('is set from the progress callback while a video is processing, and cleared after', async () => {
        const downloadsDir = path.join(DATA_DIR, 'downloads');
        fs.mkdirSync(downloadsDir, { recursive: true });
        fs.writeFileSync(path.join(downloadsDir, 'progress.mp4'), 'fake-video');
        insertVideoRow('progress.mp4');

        let capturedDuring = null;
        clientMock.detectFacesInVideo.mockImplementation(
            async (_abs, _cfg, _log, _signal, onVideoProgress) => {
                onVideoProgress({ frames_decoded: 42, total_frames: 100, pct: 42 });
                capturedDuring = scannerApi.getScanState('faces').currentVideo;
                return [];
            },
        );

        scannerApi.startFacesScan(
            { faces: { scanVideos: true, fileTypes: ['photo'] } },
            null,
            null,
            null,
        );
        await waitForScan();

        expect(capturedDuring).toEqual({
            name: 'progress.mp4',
            pct: 42,
            framesDecoded: 42,
            totalFrames: 100,
        });
        expect(scannerApi.getScanState('faces').currentVideo).toBeNull();
    });

    it('tolerates a progress payload missing pct/frames fields (nulls, not NaN/undefined)', async () => {
        const downloadsDir = path.join(DATA_DIR, 'downloads');
        fs.mkdirSync(downloadsDir, { recursive: true });
        fs.writeFileSync(path.join(downloadsDir, 'sparse.mp4'), 'fake-video');
        insertVideoRow('sparse.mp4');

        let capturedDuring = null;
        clientMock.detectFacesInVideo.mockImplementation(
            async (_abs, _cfg, _log, _signal, onVideoProgress) => {
                onVideoProgress({});
                capturedDuring = scannerApi.getScanState('faces').currentVideo;
                return [];
            },
        );

        scannerApi.startFacesScan(
            { faces: { scanVideos: true, fileTypes: ['photo'] } },
            null,
            null,
            null,
        );
        await waitForScan();

        expect(capturedDuring).toEqual({
            name: 'sparse.mp4',
            pct: null,
            framesDecoded: null,
            totalFrames: null,
        });
    });

    it('resets to null between videos so stale progress never leaks into the next one', async () => {
        const downloadsDir = path.join(DATA_DIR, 'downloads');
        fs.mkdirSync(downloadsDir, { recursive: true });
        fs.writeFileSync(path.join(downloadsDir, 'first.mp4'), 'fake-video');
        fs.writeFileSync(path.join(downloadsDir, 'second.mp4'), 'fake-video');
        insertVideoRow('first.mp4');
        insertVideoRow('second.mp4');

        const nullAtEntry = [];
        clientMock.detectFacesInVideo.mockImplementation(
            async (_abs, _cfg, _log, _signal, onVideoProgress) => {
                nullAtEntry.push(scannerApi.getScanState('faces').currentVideo === null);
                onVideoProgress({ frames_decoded: 1, total_frames: 10, pct: 10 });
                return [];
            },
        );

        scannerApi.startFacesScan(
            { faces: { scanVideos: true, fileTypes: ['photo'] } },
            null,
            null,
            null,
        );
        await waitForScan();

        expect(nullAtEntry).toEqual([true, true]);
        expect(scannerApi.getScanState('faces').currentVideo).toBeNull();
    });

    it('stays null throughout when detectFacesInVideo never calls the progress callback', async () => {
        const downloadsDir = path.join(DATA_DIR, 'downloads');
        fs.mkdirSync(downloadsDir, { recursive: true });
        fs.writeFileSync(path.join(downloadsDir, 'no-progress.mp4'), 'fake-video');
        insertVideoRow('no-progress.mp4');

        clientMock.detectFacesInVideo.mockResolvedValue([]);

        scannerApi.startFacesScan(
            { faces: { scanVideos: true, fileTypes: ['photo'] } },
            null,
            null,
            null,
        );
        await waitForScan();

        expect(scannerApi.getScanState('faces').currentVideo).toBeNull();
    });
});
