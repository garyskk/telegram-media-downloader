// Soft-delete must keep the downloads tombstone (so Telegram backfill
// does not re-fetch) but wipe faces / embeddings / tags / seekbar rows
// and cancel pending backup jobs for that download.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-soft-del-'));

let db;
let api;

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

function seedDownload(messageId, filePath) {
    api.insertDownload({
        groupId: '-100soft',
        groupName: 'SoftDel',
        messageId,
        fileName: path.basename(filePath),
        fileSize: 100,
        fileType: 'photo',
        filePath,
    });
    return db.prepare('SELECT id FROM downloads WHERE message_id = ?').get(messageId).id;
}

describe('deleteDownloadsBy soft-delete cleanup', () => {
    it('keeps the downloads row but removes faces, tags, embeddings, seekbar, pending backup jobs', () => {
        const id = seedDownload(1, 'SoftDel/images/a.jpg');

        const person = db
            .prepare(
                `INSERT INTO people (label, embedding_centroid, face_count, created_at, updated_at)
                 VALUES ('Alice', ?, 1, ?, ?)`,
            )
            .run(Buffer.alloc(8), Date.now(), Date.now());
        const personId = Number(person.lastInsertRowid);

        api.insertFace({
            downloadId: id,
            x: 0.1,
            y: 0.1,
            w: 0.2,
            h: 0.2,
            embeddingBlob: Buffer.alloc(16, 1),
            personId,
        });
        db.prepare(
            `INSERT INTO image_embeddings (download_id, embedding, model, indexed_at)
             VALUES (?, ?, 'test-model', ?)`,
        ).run(id, Buffer.alloc(8), Date.now());
        db.prepare(`INSERT INTO image_tags (download_id, tag, score) VALUES (?, 'cat', 0.9)`).run(
            id,
        );
        db.prepare(
            `INSERT INTO seekbar_sprites (download_id, sprite_path, meta_path, bytes, generated_at)
             VALUES (?, '/tmp/x.webp', '/tmp/x.json', 10, ?)`,
        ).run(id, Date.now());

        db.prepare(`
            INSERT INTO backup_destinations (name, provider, config_blob, enabled, encryption, mode, created_at)
            VALUES ('t', 'local', ?, 1, 0, 'mirror', ?)
        `).run(Buffer.from([1]), Date.now());
        const destId = db.prepare(`SELECT id FROM backup_destinations LIMIT 1`).get().id;
        db.prepare(`
            INSERT INTO backup_jobs (destination_id, download_id, status, attempts, max_attempts)
            VALUES (?, ?, 'pending', 0, 5)
        `).run(destId, id);
        const doneJob = db
            .prepare(`
            INSERT INTO backup_jobs (destination_id, download_id, status, attempts, max_attempts, finished_at)
            VALUES (?, ?, 'done', 1, 5, ?)
        `)
            .run(destId, id, Date.now()).lastInsertRowid;

        const removed = api.deleteDownloadsBy({ ids: [id] });
        expect(removed).toBe(1);

        const row = db.prepare('SELECT user_deleted FROM downloads WHERE id = ?').get(id);
        expect(row.user_deleted).toBe(1);
        expect(api.isDownloaded('-100soft', 1)).toBe(true);

        expect(db.prepare('SELECT COUNT(*) AS n FROM faces WHERE download_id = ?').get(id).n).toBe(
            0,
        );
        expect(
            db.prepare('SELECT COUNT(*) AS n FROM image_embeddings WHERE download_id = ?').get(id)
                .n,
        ).toBe(0);
        expect(
            db.prepare('SELECT COUNT(*) AS n FROM image_tags WHERE download_id = ?').get(id).n,
        ).toBe(0);
        expect(
            db.prepare('SELECT COUNT(*) AS n FROM seekbar_sprites WHERE download_id = ?').get(id).n,
        ).toBe(0);

        const pending = db
            .prepare(
                `SELECT status, error FROM backup_jobs WHERE download_id = ? AND id != ?`,
            )
            .get(id, doneJob);
        expect(pending.status).toBe('failed');
        expect(pending.error).toMatch(/soft-deleted/i);

        const keptDone = db.prepare('SELECT status FROM backup_jobs WHERE id = ?').get(doneJob);
        expect(keptDone.status).toBe('done');

        // Person with no remaining faces is purged.
        expect(db.prepare('SELECT COUNT(*) AS n FROM people WHERE id = ?').get(personId).n).toBe(0);
    });

    it('purgeSoftDeletedArtifacts cleans leftovers from older soft-deletes', () => {
        const id = seedDownload(2, 'SoftDel/images/legacy.jpg');
        api.insertFace({
            downloadId: id,
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            embeddingBlob: Buffer.alloc(8, 2),
        });
        // Simulate a pre-fix soft-delete that left faces behind.
        db.prepare('UPDATE downloads SET user_deleted = 1 WHERE id = ?').run(id);
        expect(db.prepare('SELECT COUNT(*) AS n FROM faces WHERE download_id = ?').get(id).n).toBe(
            1,
        );

        const r = api.purgeSoftDeletedArtifacts();
        expect(r.faces).toBeGreaterThanOrEqual(1);
        expect(db.prepare('SELECT COUNT(*) AS n FROM faces WHERE download_id = ?').get(id).n).toBe(
            0,
        );
    });

    it('deleteDownloadsBy({ filePaths }) tombstones every row sharing that path', () => {
        const p = 'SoftDel/videos/shared-path.mp4';
        const a = seedDownload(3, p);
        const b = seedDownload(4, p);
        api.insertFace({
            downloadId: a,
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            embeddingBlob: Buffer.alloc(8, 3),
        });
        api.insertFace({
            downloadId: b,
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            embeddingBlob: Buffer.alloc(8, 4),
        });

        const removed = api.deleteDownloadsBy({ filePaths: [p] });
        expect(removed).toBe(2);
        expect(db.prepare('SELECT user_deleted FROM downloads WHERE id = ?').get(a).user_deleted).toBe(
            1,
        );
        expect(db.prepare('SELECT user_deleted FROM downloads WHERE id = ?').get(b).user_deleted).toBe(
            1,
        );
        expect(
            db.prepare('SELECT COUNT(*) AS n FROM faces WHERE download_id IN (?, ?)').get(a, b).n,
        ).toBe(0);
    });

    it('pruneDownloadsForMissingPath wipes faces on every live row for that file', () => {
        const p = 'SoftDel/videos/gone.mp4';
        const keeper = seedDownload(5, p);
        const dupe = seedDownload(6, p);
        api.insertFace({
            downloadId: keeper,
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            embeddingBlob: Buffer.alloc(8, 5),
        });
        // Duplicate already tombstoned (hash-dedup sibling deleted by id)
        // must not protect the keeper's faces once the bytes are gone.
        db.prepare('UPDATE downloads SET user_deleted = 1 WHERE id = ?').run(dupe);

        const n = api.pruneDownloadsForMissingPath(p);
        expect(n).toBe(1);
        expect(
            db.prepare('SELECT user_deleted FROM downloads WHERE id = ?').get(keeper).user_deleted,
        ).toBe(1);
        expect(
            db.prepare('SELECT COUNT(*) AS n FROM faces WHERE download_id = ?').get(keeper).n,
        ).toBe(0);
    });

    it('liveIdsSharingFilePath skips exceptIds (refcount for keep-one deletes)', () => {
        const p = 'SoftDel/videos/refcount.mp4';
        const keeper = seedDownload(7, p);
        const dupe = seedDownload(8, p);
        expect(api.liveIdsSharingFilePath(p).sort()).toEqual([keeper, dupe].sort());
        expect(api.liveIdsSharingFilePath(p, { exceptIds: [dupe] })).toEqual([keeper]);
        expect(api.liveIdsSharingFilePath(p, { exceptIds: [keeper, dupe] })).toEqual([]);
    });
});
