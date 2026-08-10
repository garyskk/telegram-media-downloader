// Mirror catch-up must not hold a better-sqlite3 `.iterate()` cursor while
// calling hasJobForDownload / enqueue on the same connection — that surfaces
// as "This database connection is busy executing a query".
// Missing on-disk files must fail the job, not crash via uncaught ENOENT.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-backup-run-'));
const BACKUP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-backup-dest-'));
const SHARE_SECRET = crypto.randomBytes(32).toString('hex');

let db;
let queue;
let manager;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    fs.mkdirSync(path.join(DATA_DIR, 'downloads'), { recursive: true });
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    queue = await import('../src/core/backup/queue.js');
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

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const v = fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('timeout waiting for condition');
}

describe('backup/manager runBackup mirror catch-up', () => {
    it('enqueues every download without busy-connection errors', async () => {
        const destId = manager.addDestination({
            name: 'mirror-catchup',
            provider: 'local',
            mode: 'mirror',
            enabled: true,
            config: { rootPath: BACKUP_ROOT },
        });
        // Keep the worker from racing the enqueue loop under test.
        manager.pause(destId);

        const insert = db.prepare(`
            INSERT INTO downloads (group_id, message_id, file_name, file_size, file_type, file_path)
            VALUES (?, ?, ?, 100, 'photo', ?)
        `);
        for (let i = 1; i <= 25; i++) {
            insert.run('-1001', 1000 + i, `f${i}.jpg`, `g/photos/f${i}.jpg`);
        }

        const r = await manager.runBackup(destId);
        expect(r.started).toBe(true);
        expect(r.mode).toBe('mirror');
        expect(r.enqueued).toBe(25);

        const total = db
            .prepare(`SELECT COUNT(*) AS n FROM backup_jobs WHERE destination_id = ?`)
            .get(destId).n;
        expect(total).toBe(25);

        // Idempotent — second run does not double-enqueue
        const r2 = await manager.runBackup(destId);
        expect(r2.enqueued).toBe(0);
    });

    it('skips soft-deleted downloads during mirror catch-up', async () => {
        const destId = manager.addDestination({
            name: 'mirror-skip-deleted',
            provider: 'local',
            mode: 'mirror',
            enabled: true,
            config: { rootPath: BACKUP_ROOT },
        });
        manager.pause(destId);

        db.prepare(`
            INSERT INTO downloads (group_id, message_id, file_name, file_size, file_type, file_path, user_deleted)
            VALUES ('-1003', 77, 'gone.jpg', 100, 'photo', 'gone/photos/gone.jpg', 1)
        `).run();
        db.prepare(`
            INSERT INTO downloads (group_id, message_id, file_name, file_size, file_type, file_path)
            VALUES ('-1003', 78, 'live.jpg', 100, 'photo', 'live/photos/live.jpg')
        `).run();

        const r = await manager.runBackup(destId);
        const jobs = db
            .prepare(
                `SELECT d.file_path, d.user_deleted FROM backup_jobs j
                   JOIN downloads d ON d.id = j.download_id
                  WHERE j.destination_id = ?`,
            )
            .all(destId);
        expect(jobs.some((j) => j.file_path === 'gone/photos/gone.jpg')).toBe(false);
        expect(jobs.some((j) => j.file_path === 'live/photos/live.jpg')).toBe(true);
        expect(r.enqueued).toBeGreaterThanOrEqual(1);
    });

    it('marks job failed when local file is missing (no uncaught ENOENT)', async () => {
        const destId = manager.addDestination({
            name: 'mirror-missing',
            provider: 'local',
            mode: 'mirror',
            enabled: true,
            config: { rootPath: BACKUP_ROOT },
        });

        db.prepare(`
            INSERT INTO downloads (group_id, message_id, file_name, file_size, file_type, file_path)
            VALUES ('-1002', 42, 'gone.mp4', 100, 'video', 'gone/videos/gone.mp4')
        `).run();
        const dl = db.prepare(`SELECT id FROM downloads WHERE message_id = 42`).get();

        queue.enqueue({
            destinationId: destId,
            downloadId: dl.id,
            remotePath: 'gone/videos/gone.mp4',
        });
        manager.resume(destId);

        const job = await waitFor(() => {
            const row = db
                .prepare(
                    `SELECT status, error FROM backup_jobs WHERE destination_id = ? AND download_id = ?`,
                )
                .get(destId, dl.id);
            return row?.status === 'failed' ? row : null;
        });
        expect(job.error).toMatch(/local file missing/i);
    });
});
