// Tombstones keep a deliberately deleted message out of backfill after the
// downloads row is gone. Isolated the same way as tests/db.test.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-tombstone-'));

let db;
let api;

function insert(messageId, fileName) {
    api.insertDownload({
        groupId: '-tomb',
        groupName: 'Tombstone',
        messageId,
        fileName,
        fileSize: 10,
        fileType: 'photo',
        filePath: `Tombstone/images/${fileName}`,
    });
    return db.prepare('SELECT id FROM downloads WHERE group_id = ? AND message_id = ?').get('-tomb', messageId).id;
}

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

describe('delete tombstones', () => {
    it('keeps a deleteDownloadsBy message visible to backfill and out of the gallery table', () => {
        const id = insert(1, 'kept-out.jpg');
        expect(api.deleteDownloadsBy({ ids: [id] })).toBe(1);
        expect(db.prepare('SELECT id FROM downloads WHERE id = ?').get(id)).toBeUndefined();
        expect(api.isDownloaded('-tomb', 1)).toBe(true);
        expect(api.getMessageIdRange('-tomb')).toEqual({
            minMessageId: 1,
            maxMessageId: 1,
            count: 1,
        });
    });

    it('does not tombstone a raw delete', () => {
        const id = insert(2, 'raw.jpg');
        db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
        expect(api.isDownloaded('-tomb', 2)).toBe(false);
        const range = api.getMessageIdRange('-tomb');
        expect(range.minMessageId).toBe(1);
        expect(range.maxMessageId).toBe(1);
        expect(range.count).toBe(1);
    });

    it('treats a group with no rows and no tombstones as never seen', () => {
        expect(api.getMessageIdRange('-empty')).toEqual({
            minMessageId: null,
            maxMessageId: null,
            count: 0,
        });
    });
});

describe('retireUserDeletedColumn', () => {
    it('moves flagged rows into tombstones, keeps the rest, and drops the column', () => {
        db.exec('ALTER TABLE downloads ADD COLUMN user_deleted INTEGER DEFAULT 0');
        db.exec('CREATE INDEX idx_legacy_user_deleted ON downloads(id) WHERE user_deleted = 1');
        const live = insert(3, 'live.jpg');
        const gone = insert(4, 'soft.jpg');
        db.prepare('UPDATE downloads SET user_deleted = 1 WHERE id = ?').run(gone);

        const first = api.retireUserDeletedColumn();
        expect(first.dropped).toBe(true);
        expect(first.migrated).toBe(1);

        const cols = db.prepare('PRAGMA table_info(downloads)').all().map((c) => c.name);
        expect(cols).not.toContain('user_deleted');
        expect(
            db.prepare(`SELECT name FROM sqlite_master WHERE name = 'idx_legacy_user_deleted'`).get(),
        ).toBeUndefined();
        expect(db.prepare('SELECT id FROM downloads WHERE id = ?').get(gone)).toBeUndefined();
        expect(db.prepare('SELECT id FROM downloads WHERE id = ?').get(live)).toBeTruthy();
        expect(api.isDownloaded('-tomb', 4)).toBe(true);
        expect(api.isDownloaded('-tomb', 3)).toBe(true);

        const again = api.retireUserDeletedColumn();
        expect(again).toEqual({ migrated: 0, dropped: false });
    });
});
