import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-similar-scan-'));
process.env.TGDL_DATA_DIR = DATA_DIR;

const generateFingerprintForDownload = vi.hoisted(() => vi.fn());

vi.mock('../src/core/similar/fingerprint.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        generateFingerprintForDownload,
    };
});

let db;
let api;
let scanSimilarClips;
let fingerprintIsCurrent;
let kvSet;
let kvGet;
let createJobTracker;
let _msg = 1;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../src/core/db.js');
    db = api.getDb();
    kvSet = api.kvSet;
    kvGet = api.kvGet;
    ({ scanSimilarClips, fingerprintIsCurrent } = await import('../src/core/similar/scan-runner.js'));
    ({ createJobTracker } = await import('../src/core/job-tracker.js'));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
    generateFingerprintForDownload.mockReset();
    db.prepare('DELETE FROM downloads').run();
});

function seedVideo(fileHash = 'h') {
    const messageId = _msg++;
    api.insertDownload({
        groupId: '-100simscan',
        groupName: 'SimScan',
        messageId,
        fileName: `v${messageId}.mp4`,
        fileSize: 64,
        fileType: 'video',
        filePath: `SimScan/videos/v${messageId}.mp4`,
        fileHash,
    });
    return db.prepare('SELECT id, file_hash, file_path, file_type, file_size FROM downloads WHERE message_id = ?').get(
        messageId,
    );
}

describe('fingerprintIsCurrent', () => {
    it('is true only when file_hash matches and algo is pdq-scene-v1', () => {
        const row = seedVideo('same-h');
        api.upsertVideoFingerprint({
            downloadId: row.id,
            durationSec: 1,
            aggregateHash: 'c'.repeat(64),
            frameCount: 1,
            algo: 'pdq-scene-v1',
            fileHash: 'same-h',
        });
        expect(fingerprintIsCurrent(row)).toBe(true);
        expect(fingerprintIsCurrent({ ...row, file_hash: 'other' })).toBe(false);
    });

    it('is false for leftover phash-v1 rows even when file_hash matches', () => {
        const row = seedVideo('legacy-h');
        api.upsertVideoFingerprint({
            downloadId: row.id,
            durationSec: 1,
            aggregateHash: 'cccccccccccccccc',
            frameCount: 1,
            algo: 'phash-v1',
            fileHash: 'legacy-h',
        });
        expect(fingerprintIsCurrent(row)).toBe(false);
    });
});

describe('scanSimilarClips', () => {
    it('skips current PDQ fingerprints and regenerates missing/stale/legacy algo', async () => {
        const current = seedVideo('cur-scan');
        api.upsertVideoFingerprint({
            downloadId: current.id,
            durationSec: 1,
            aggregateHash: 'd'.repeat(64),
            frameCount: 1,
            algo: 'pdq-scene-v1',
            fileHash: 'cur-scan',
        });
        const missing = seedVideo('miss-scan');
        const stale = seedVideo('new-scan');
        api.upsertVideoFingerprint({
            downloadId: stale.id,
            durationSec: 1,
            aggregateHash: 'e'.repeat(64),
            frameCount: 1,
            algo: 'pdq-scene-v1',
            fileHash: 'old-scan',
        });
        const legacy = seedVideo('legacy-scan');
        api.upsertVideoFingerprint({
            downloadId: legacy.id,
            durationSec: 1,
            aggregateHash: 'ffffffffffffffff',
            frameCount: 1,
            algo: 'phash-v1',
            fileHash: 'legacy-scan',
        });

        generateFingerprintForDownload.mockImplementation(async (row) => ({
            download_id: row.id,
            frames: 8,
            algo: 'pdq-scene-v1',
        }));

        const result = await scanSimilarClips();
        expect(result.generated).toBe(3);
        expect(result.errored).toBe(0);
        expect(generateFingerprintForDownload).toHaveBeenCalledTimes(3);
        const ids = generateFingerprintForDownload.mock.calls.map((c) => c[0].id).sort();
        expect(ids).toEqual([missing.id, stale.id, legacy.id].sort());
        expect(generateFingerprintForDownload.mock.calls.some((c) => c[0].id === current.id)).toBe(
            false,
        );
    });

    it('counts generate skip/error without writing seekbar sprites', async () => {
        const gone = seedVideo('gone-scan');
        const bad = seedVideo('bad-scan');
        generateFingerprintForDownload.mockImplementation(async (row) => {
            if (row.id === gone.id) return { skipped: 'missing' };
            throw new Error('does not contain any stream');
        });

        const result = await scanSimilarClips();
        expect(result.skipped).toBeGreaterThanOrEqual(1);
        expect(result.errored).toBeGreaterThanOrEqual(1);
        expect(api.getSeekbarSprite(gone.id)).toBeFalsy();
        expect(api.getSeekbarSprite(bad.id)).toBeFalsy();
    });

    it('stops paging when aborted', async () => {
        seedVideo('abort-a');
        seedVideo('abort-b');
        generateFingerprintForDownload.mockResolvedValue({ frames: 1 });
        const ac = new AbortController();
        ac.abort();
        const result = await scanSimilarClips({ signal: ac.signal });
        expect(result.cancelled).toBe(true);
        expect(result.processed).toBe(0);
        expect(generateFingerprintForDownload).not.toHaveBeenCalled();
    });

    it("persists kv['similar_last_scan'] from the JobTracker runFn shape", async () => {
        const t = createJobTracker({
            kind: 'similarScan',
            broadcast: () => {},
            eventPrefix: 'similar',
        });
        const started = t.tryStart(async ({ onProgress, signal }) => {
            const result = await scanSimilarClips({ onProgress, signal });
            kvSet('similar_last_scan', { finishedAt: Date.now(), ...result });
            return result;
        });
        expect(started.started).toBe(true);
        await vi.waitFor(() => {
            expect(t.getStatus().running).toBe(false);
        });
        const last = kvGet('similar_last_scan');
        expect(last).toBeTruthy();
        expect(last).toEqual(
            expect.objectContaining({
                processed: expect.any(Number),
                generated: expect.any(Number),
                skipped: expect.any(Number),
                errored: expect.any(Number),
                durationMs: expect.any(Number),
                finishedAt: expect.any(Number),
            }),
        );
    });
});
