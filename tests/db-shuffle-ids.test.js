// Playlist ID helpers for player shuffle — full-library listing + ordered hydrate.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-shuffle-ids-'));

let db;
let api;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../src/core/db.js');
    db = api.getDb();

    const seed = [
        { messageId: 1, fileName: 'a.jpg', fileType: 'photo', groupId: '-100a', pinned: 0 },
        { messageId: 2, fileName: 'b.mp4', fileType: 'video', groupId: '-100a', pinned: 1 },
        { messageId: 3, fileName: 'c.jpg', fileType: 'photo', groupId: '-100b', pinned: 0 },
        { messageId: 4, fileName: 'd.pdf', fileType: 'document', groupId: '-100b', pinned: 0 },
        { messageId: 5, fileName: 'e.jpg', fileType: 'photo', groupId: '-100a', pinned: 0 },
    ];
    for (const s of seed) {
        api.insertDownload({
            groupId: s.groupId,
            groupName: s.groupId,
            messageId: s.messageId,
            fileName: s.fileName,
            fileSize: 100 + s.messageId,
            fileType: s.fileType,
            filePath: `${s.groupId}/${s.fileType}/${s.fileName}`,
        });
        if (s.pinned) {
            const id = db.prepare('SELECT id FROM downloads WHERE message_id = ?').get(s.messageId)
                .id;
            api.setDownloadPinned(id, true);
        }
    }
    // Soft-delete one photo — must never appear in playlist ids.
    const delId = db.prepare('SELECT id FROM downloads WHERE message_id = 5').get().id;
    api.deleteDownloadsBy({ ids: [delId] });
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('listDownloadIds', () => {
    it('returns every non-deleted id (no page limit)', () => {
        const { ids, total } = api.listDownloadIds('all');
        expect(total).toBe(4);
        expect(ids).toHaveLength(4);
        expect(ids.every((id) => Number.isFinite(id))).toBe(true);
    });

    it('filters by type', () => {
        const { ids } = api.listDownloadIds('images');
        expect(ids).toHaveLength(2); // a.jpg + c.jpg (e.jpg soft-deleted)
        const rows = api.getDownloadsByIds(ids);
        expect(rows.every((r) => r.file_type === 'photo')).toBe(true);
    });

    it('honors pinnedOnly / unpinnedOnly', () => {
        const pinned = api.listDownloadIds('all', { pinnedOnly: true });
        expect(pinned.total).toBe(1);
        const unpinned = api.listDownloadIds('all', { unpinnedOnly: true });
        expect(unpinned.total).toBe(3);
    });
});

describe('listDownloadIdsForGroup', () => {
    it('scopes to one group', () => {
        const { ids, total } = api.listDownloadIdsForGroup('-100a', 'all');
        expect(total).toBe(2); // a.jpg + b.mp4 (e soft-deleted)
        expect(ids).toHaveLength(2);
    });
});

describe('getDownloadsByIds', () => {
    it('preserves request order and skips missing/soft-deleted', () => {
        const all = api.listDownloadIds('all').ids;
        const reversed = all.slice().reverse();
        const deleted = db.prepare('SELECT id FROM downloads WHERE message_id = 5').get().id;
        const rows = api.getDownloadsByIds([...reversed, deleted, 999999]);
        expect(rows.map((r) => r.id)).toEqual(reversed);
    });
});
