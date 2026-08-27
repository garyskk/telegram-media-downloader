// Similar-clips tables live in the existing db.sqlite (not a second file).
// Schema + accessors are created in getDb() / initSchema.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-similar-clips-'));

let db;
let api;
let _msg = 1;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../src/core/db.js');
    db = api.getDb();
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

function seedVideo(fileHash = 'abc') {
    const messageId = _msg++;
    api.insertDownload({
        groupId: '-100similar',
        groupName: 'Similar',
        messageId,
        fileName: `v${messageId}.mp4`,
        fileSize: 1000,
        fileType: 'video',
        filePath: `Similar/videos/v${messageId}.mp4`,
        fileHash,
    });
    return db.prepare('SELECT id FROM downloads WHERE message_id = ?').get(messageId).id;
}

describe('similar-clips schema', () => {
    it('creates fingerprint tables on the same db.sqlite as downloads', () => {
        expect(fs.existsSync(path.join(DATA_DIR, 'db.sqlite'))).toBe(true);
        const names = db
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all()
            .map((r) => r.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'downloads',
                'video_fingerprints',
                'video_frame_hashes',
                'similar_groups',
                'similar_group_members',
                'similar_ignores',
                'similar_partial_scans',
            ]),
        );
    });

    it('has the expected fingerprint columns', () => {
        const cols = db
            .prepare('PRAGMA table_info(video_fingerprints)')
            .all()
            .map((r) => r.name);
        expect(cols).toEqual(
            expect.arrayContaining([
                'download_id',
                'duration_sec',
                'aggregate_hash',
                'frame_count',
                'algo',
                'indexed_at',
                'file_hash',
            ]),
        );
    });
});

describe('video fingerprint accessors', () => {
    it('upserts a fingerprint and replaces frame hashes', () => {
        const id = seedVideo('hash-1');
        api.upsertVideoFingerprint({
            downloadId: id,
            durationSec: 12.5,
            aggregateHash: '0123456789abcdef',
            frameCount: 2,
            algo: 'phash-v1',
            fileHash: 'hash-1',
            indexedAt: 1_700_000_000_000,
        });
        api.replaceVideoFrameHashes(id, [
            { tSec: 0, phash: 'aaaaaaaaaaaaaaaa' },
            { tSec: 1, phash: 'bbbbbbbbbbbbbbbb' },
        ]);

        const fp = api.getVideoFingerprint(id);
        expect(fp.duration_sec).toBe(12.5);
        expect(fp.aggregate_hash).toBe('0123456789abcdef');
        expect(fp.frame_count).toBe(2);
        expect(fp.algo).toBe('phash-v1');
        expect(fp.file_hash).toBe('hash-1');
        expect(api.videoFingerprintMatchesHash(id, 'hash-1')).toBe(true);
        expect(api.videoFingerprintMatchesHash(id, 'other')).toBe(false);

        const frames = api.getVideoFrameHashes(id);
        expect(frames).toEqual([
            { download_id: id, t_sec: 0, phash: 'aaaaaaaaaaaaaaaa' },
            { download_id: id, t_sec: 1, phash: 'bbbbbbbbbbbbbbbb' },
        ]);

        api.replaceVideoFrameHashes(id, [{ tSec: 0, phash: 'cccccccccccccccc' }]);
        expect(api.getVideoFrameHashes(id)).toHaveLength(1);
        expect(api.getVideoFrameHashes(id)[0].phash).toBe('cccccccccccccccc');
    });
});

describe('similar groups, ignores, partial-scan resume', () => {
    it('stores a group with keep/remove members', () => {
        const keep = seedVideo('g-keep');
        const remove = seedVideo('g-rm');
        const groupId = api.insertSimilarGroup({
            kind: 'similar',
            confidence: 0.9,
            offsetSec: null,
            members: [
                { downloadId: keep, role: 'keep', reason: 'larger file' },
                { downloadId: remove, role: 'remove', reason: 'smaller re-encode' },
            ],
        });
        expect(groupId).toBeGreaterThan(0);
        const members = api.listSimilarGroupMembers(groupId);
        expect(members.map((m) => m.role).sort()).toEqual(['keep', 'remove']);
    });

    it('canonicalizes ignore pairs so (b,a) matches (a,b)', () => {
        const a = seedVideo('ign-a');
        const b = seedVideo('ign-b');
        const id1 = api.addSimilarIgnore({ aId: b, bId: a, kind: 'partial' });
        expect(id1).toBeGreaterThan(0);
        expect(() => api.addSimilarIgnore({ aId: a, bId: b, kind: 'partial' })).toThrow();
        expect(api.isSimilarPairIgnored(a, b, 'partial')).toBe(true);
        expect(api.isSimilarPairIgnored(b, a, 'partial')).toBe(true);
        expect(api.isSimilarPairIgnored(a, b, 'similar')).toBe(false);
    });

    it('records a partial-scan resume cursor', () => {
        const clip = seedVideo('partial-clip');
        api.upsertSimilarPartialScan({ downloadId: clip, frameCount: 40, scannedAt: 123 });
        const row = api.getSimilarPartialScan(clip);
        expect(row.frame_count).toBe(40);
        expect(row.scanned_at).toBe(123);
    });
});

describe('similar-clips cleanup', () => {
    it('hard-deleting a download cascades fingerprints and frame hashes', () => {
        const id = seedVideo('cascade');
        api.upsertVideoFingerprint({
            downloadId: id,
            durationSec: 1,
            aggregateHash: 'deadbeefdeadbeef',
            frameCount: 1,
            fileHash: 'cascade',
        });
        api.replaceVideoFrameHashes(id, [{ tSec: 0, phash: 'ffffffffffffffff' }]);
        db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
        expect(api.getVideoFingerprint(id)).toBeNull();
        expect(api.getVideoFrameHashes(id)).toEqual([]);
    });

    it('soft-delete purges fingerprints, groups, ignores, and partial scans', () => {
        const keep = seedVideo('soft-keep');
        const gone = seedVideo('soft-gone');
        api.upsertVideoFingerprint({
            downloadId: gone,
            durationSec: 3,
            aggregateHash: '1111111111111111',
            frameCount: 1,
            fileHash: 'soft-gone',
        });
        api.replaceVideoFrameHashes(gone, [{ tSec: 0, phash: '2222222222222222' }]);
        const groupId = api.insertSimilarGroup({
            kind: 'partial',
            confidence: 0.7,
            offsetSec: 4.5,
            members: [
                { downloadId: keep, role: 'keep', reason: 'parent' },
                { downloadId: gone, role: 'remove', reason: 'clip' },
            ],
        });
        api.addSimilarIgnore({ aId: keep, bId: gone, kind: 'partial' });
        api.upsertSimilarPartialScan({ downloadId: gone, frameCount: 8 });

        expect(api.deleteDownloadsBy({ ids: [gone] })).toBe(1);

        expect(api.getVideoFingerprint(gone)).toBeNull();
        expect(api.getVideoFrameHashes(gone)).toEqual([]);
        expect(api.getSimilarPartialScan(gone)).toBeNull();
        expect(api.isSimilarPairIgnored(keep, gone, 'partial')).toBe(false);
        expect(api.listSimilarGroupMembers(groupId)).toHaveLength(1);
        expect(api.listSimilarGroupMembers(groupId)[0].download_id).toBe(keep);
    });
});
