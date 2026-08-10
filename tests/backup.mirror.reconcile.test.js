// Mirror reconcile: list remote, delete orphans not in the live local library.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-bk-recon-'));
const BACKUP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-bk-recon-dest-'));
const SHARE_SECRET = crypto.randomBytes(32).toString('hex');

let db;
let manager;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    fs.mkdirSync(path.join(DATA_DIR, 'downloads'), { recursive: true });
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    manager = await import('../src/core/backup/manager.js');
    manager.init({
        broadcast: () => {},
        log: () => {},
        getShareSecret: () => SHARE_SECRET,
    });
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(BACKUP_ROOT, { recursive: true, force: true });
});

describe('backup mirror reconcile', () => {
    it('Run now prunes remote files that are not in the live local library', async () => {
        const destId = manager.addDestination({
            name: 'recon-local',
            provider: 'local',
            mode: 'mirror',
            enabled: true,
            config: { rootPath: BACKUP_ROOT },
        });
        manager.pause(destId);

        // Live local file + matching remote copy.
        const liveRel = 'g/photos/live.jpg';
        const liveAbs = path.join(DATA_DIR, 'downloads', liveRel);
        fs.mkdirSync(path.dirname(liveAbs), { recursive: true });
        fs.writeFileSync(liveAbs, 'live');
        db.prepare(`
            INSERT INTO downloads (group_id, message_id, file_name, file_size, file_type, file_path)
            VALUES ('-1', 1, 'live.jpg', 4, 'photo', ?)
        `).run(liveRel);
        const remoteLive = path.join(BACKUP_ROOT, ...liveRel.split('/'));
        fs.mkdirSync(path.dirname(remoteLive), { recursive: true });
        fs.writeFileSync(remoteLive, 'live');

        // Soft-deleted local row — remote copy should be pruned.
        const goneRel = 'g/photos/gone.jpg';
        db.prepare(`
            INSERT INTO downloads (group_id, message_id, file_name, file_size, file_type, file_path, user_deleted)
            VALUES ('-1', 2, 'gone.jpg', 4, 'photo', ?, 1)
        `).run(goneRel);
        const remoteGone = path.join(BACKUP_ROOT, ...goneRel.split('/'));
        fs.mkdirSync(path.dirname(remoteGone), { recursive: true });
        fs.writeFileSync(remoteGone, 'gone');

        // Orphan remote with no DB row at all.
        const orphanRel = 'g/photos/orphan.jpg';
        const remoteOrphan = path.join(BACKUP_ROOT, ...orphanRel.split('/'));
        fs.writeFileSync(remoteOrphan, 'orphan');

        // Snapshot archive must NOT be touched.
        const snapDir = path.join(BACKUP_ROOT, 'snapshots');
        fs.mkdirSync(snapDir, { recursive: true });
        const snapFile = path.join(snapDir, 'snapshot-keep.tar.gz');
        fs.writeFileSync(snapFile, 'snap');

        const r = await manager.runBackup(destId);
        expect(r.mode).toBe('mirror');
        expect(r.pruned).toBeGreaterThanOrEqual(2);

        expect(fs.existsSync(remoteLive)).toBe(true);
        expect(fs.existsSync(remoteGone)).toBe(false);
        expect(fs.existsSync(remoteOrphan)).toBe(false);
        expect(fs.existsSync(snapFile)).toBe(true);
    });
});
