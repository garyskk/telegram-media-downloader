import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-similar-purge-'));
process.env.TGDL_DATA_DIR = DATA_DIR;

let db;
let api;
let unlinkLeftoverFingerprintRaws;
let _msg = 1;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../src/core/db.js');
    db = api.getDb();
    ({ unlinkLeftoverFingerprintRaws } = await import('../src/core/similar/fingerprint.js'));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

function seedVideo(fileHash = 'h') {
    const messageId = _msg++;
    api.insertDownload({
        groupId: '-100simpurge',
        groupName: 'SimPurge',
        messageId,
        fileName: `v${messageId}.mp4`,
        fileSize: 1000,
        fileType: 'video',
        filePath: `SimPurge/videos/v${messageId}.mp4`,
        fileHash,
    });
    return db.prepare('SELECT id FROM downloads WHERE message_id = ?').get(messageId).id;
}

describe('purgeSimilarClipsRecords', () => {
    it('wipes fingerprints, groups, and resume cursors but keeps ignores and hover sprites', () => {
        const keep = seedVideo('purge-keep');
        const gone = seedVideo('purge-gone');
        api.upsertVideoFingerprint({
            downloadId: keep,
            durationSec: 8,
            aggregateHash: 'aaaaaaaaaaaaaaaa',
            frameCount: 2,
            algo: 'pdq-scene-v1',
            fileHash: 'purge-keep',
        });
        api.replaceVideoFrameHashes(keep, [
            { tSec: 0, phash: '1111111111111111' },
            { tSec: 1, phash: '2222222222222222' },
        ]);
        api.upsertVideoFingerprint({
            downloadId: gone,
            durationSec: 3,
            aggregateHash: 'bbbbbbbbbbbbbbbb',
            frameCount: 1,
            algo: 'pdq-scene-v1',
            fileHash: 'purge-gone',
        });
        api.replaceVideoFrameHashes(gone, [{ tSec: 0, phash: '3333333333333333' }]);
        api.insertSimilarGroup({
            kind: 'similar',
            confidence: 0.9,
            members: [
                { downloadId: keep, role: 'keep', reason: 'larger' },
                { downloadId: gone, role: 'remove', reason: 'smaller' },
            ],
        });
        api.insertSimilarGroup({
            kind: 'partial',
            confidence: 0.6,
            offsetSec: 2,
            members: [
                { downloadId: keep, role: 'keep', reason: 'parent' },
                { downloadId: gone, role: 'remove', reason: 'clip' },
            ],
        });
        api.addSimilarIgnore({ aId: keep, bId: gone, kind: 'similar', note: 'keep-me' });
        api.upsertSimilarPartialScan({ downloadId: gone, frameCount: 4, scannedAt: 99 });
        api.upsertSeekbarSprite({
            downloadId: keep,
            spritePath: 'seekbar/1.webp',
            metaPath: 'seekbar/1.json',
            durationSec: 8,
            frames: 8,
            generatedAt: 1,
        });
        api.kvSet('similar_last_scan', { finishedAt: 1, generated: 2 });
        api.kvSet('similar_last_analyze', { finishedAt: 2, similarGroups: 1 });
        api.kvSet('pending_job_similarScan', { startedAt: 3 });
        api.kvSet('pending_job_similarAnalyze', { startedAt: 4 });

        const r = api.purgeSimilarClipsRecords();
        expect(r).toEqual({ fingerprints: 2, groups: 2, partialScans: 1 });

        expect(api.getVideoFingerprint(keep)).toBeNull();
        expect(api.getVideoFingerprint(gone)).toBeNull();
        expect(api.getVideoFrameHashes(keep)).toEqual([]);
        expect(api.getVideoFrameHashes(gone)).toEqual([]);
        expect(api.listSimilarGroups()).toEqual([]);
        expect(api.getSimilarPartialScan(gone)).toBeNull();
        expect(api.kvGet('similar_last_scan')).toBeNull();
        expect(api.kvGet('similar_last_analyze')).toBeNull();
        expect(api.kvGet('pending_job_similarScan')).toBeNull();
        expect(api.kvGet('pending_job_similarAnalyze')).toBeNull();

        const ignores = api.listSimilarIgnores();
        expect(ignores).toHaveLength(1);
        expect(ignores[0].note).toBe('keep-me');
        expect(api.isSimilarPairIgnored(keep, gone, 'similar')).toBe(true);

        expect(api.getSeekbarSprite(keep)).toBeTruthy();
        expect(api.getSeekbarSprite(keep).sprite_path).toBe('seekbar/1.webp');
        expect(db.prepare('SELECT id FROM downloads WHERE id = ?').get(keep)).toBeTruthy();
        expect(db.prepare('SELECT id FROM downloads WHERE id = ?').get(gone)).toBeTruthy();
    });

    it('returns zeros when there is nothing to wipe', () => {
        expect(api.purgeSimilarClipsRecords()).toEqual({
            fingerprints: 0,
            groups: 0,
            partialScans: 0,
        });
    });
});

describe('unlinkLeftoverFingerprintRaws', () => {
    it('unlinks only leftover {id}.fp.raw files, not hover WebP/JSON', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-fp-raw-'));
        fs.writeFileSync(path.join(dir, '12.fp.raw'), 'raw');
        fs.writeFileSync(path.join(dir, '13.fp.raw'), 'raw');
        fs.writeFileSync(path.join(dir, '12.webp'), 'webp');
        fs.writeFileSync(path.join(dir, '12.json'), '{}');
        const n = await unlinkLeftoverFingerprintRaws(dir);
        expect(n).toBe(2);
        expect(fs.existsSync(path.join(dir, '12.fp.raw'))).toBe(false);
        expect(fs.existsSync(path.join(dir, '13.fp.raw'))).toBe(false);
        expect(fs.existsSync(path.join(dir, '12.webp'))).toBe(true);
        expect(fs.existsSync(path.join(dir, '12.json'))).toBe(true);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns 0 when the seekbar dir is missing', async () => {
        const missing = path.join(os.tmpdir(), `tgdl-fp-raw-missing-${Date.now()}`);
        expect(await unlinkLeftoverFingerprintRaws(missing)).toBe(0);
    });
});
