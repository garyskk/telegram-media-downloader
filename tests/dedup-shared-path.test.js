// Hash-dedup can store two download rows against one on-disk file.
// Deleting the duplicate by id must keep the file (and the keeper's
// faces) when another live row still points at that path.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-dedup-share-'));
const DL_DIR = path.join(DATA_DIR, 'downloads');

let db;
let dbApi;
let dedup;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    fs.mkdirSync(path.join(DL_DIR, 'ShareGrp', 'videos'), { recursive: true });
    dbApi = await import('../src/core/db.js');
    dedup = await import('../src/core/dedup.js');
    db = dbApi.getDb();
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

function seed(messageId, relPath) {
    dbApi.insertDownload({
        groupId: `-100${messageId}`,
        groupName: 'ShareGrp',
        messageId,
        fileName: path.basename(relPath),
        fileSize: 12,
        fileType: 'video',
        filePath: relPath,
    });
    return db.prepare('SELECT id FROM downloads WHERE message_id = ?').get(messageId).id;
}

describe('deleteByIds shared-path refcount', () => {
    it('does not unlink a file still referenced by another live download', () => {
        const rel = 'ShareGrp/videos/shared.mp4';
        const abs = path.join(DL_DIR, rel);
        fs.writeFileSync(abs, 'keep-me-bytes');
        const keeper = seed(1, rel);
        const dupe = seed(2, rel);
        dbApi.insertFace({
            downloadId: keeper,
            x: 1,
            y: 1,
            w: 2,
            h: 2,
            embeddingBlob: Buffer.alloc(8, 7),
        });

        const r = dedup.deleteByIds([dupe]);
        expect(r.removed).toBe(1);
        expect(fs.existsSync(abs)).toBe(true);
        expect(db.prepare('SELECT user_deleted FROM downloads WHERE id = ?').get(dupe).user_deleted).toBe(
            1,
        );
        expect(
            db.prepare('SELECT user_deleted FROM downloads WHERE id = ?').get(keeper).user_deleted,
        ).toBe(0);
        expect(
            db.prepare('SELECT COUNT(*) AS n FROM faces WHERE download_id = ?').get(keeper).n,
        ).toBe(1);
    });

    it('unlinks and wipes faces when the last live reference is deleted', () => {
        const rel = 'ShareGrp/videos/last-ref.mp4';
        const abs = path.join(DL_DIR, rel);
        fs.writeFileSync(abs, 'gone-soon');
        const keeper = seed(3, rel);
        dbApi.insertFace({
            downloadId: keeper,
            x: 1,
            y: 1,
            w: 2,
            h: 2,
            embeddingBlob: Buffer.alloc(8, 8),
        });

        const r = dedup.deleteByIds([keeper]);
        expect(r.removed).toBe(1);
        expect(fs.existsSync(abs)).toBe(false);
        expect(
            db.prepare('SELECT COUNT(*) AS n FROM faces WHERE download_id = ?').get(keeper).n,
        ).toBe(0);
    });
});
