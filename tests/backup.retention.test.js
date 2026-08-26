// Snapshot retention: keep N remote archives, unlink local staging after
// upload, prune leftovers, apply to manual mode, and never log a failed
// delete as success.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-bk-retain-'));
const BACKUP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-bk-retain-dest-'));
const SHARE_SECRET = crypto.randomBytes(32).toString('hex');
const STAGING = path.join(DATA_DIR, 'backups');

let db;
let manager;
let logs;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    fs.mkdirSync(path.join(DATA_DIR, 'downloads'), { recursive: true });
    fs.mkdirSync(STAGING, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'config.json'), '{}');
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    manager = await import('../src/core/backup/manager.js');
    manager.init({
        broadcast: () => {},
        log: (e) => {
            logs.push(e);
        },
        getShareSecret: () => SHARE_SECRET,
    });
});

beforeEach(() => {
    logs = [];
    // Wipe remote + staging between cases.
    fs.rmSync(BACKUP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(BACKUP_ROOT, { recursive: true });
    for (const name of fs.readdirSync(STAGING)) {
        if (name.startsWith('snapshot-') || name.startsWith('db-pre-update-')) {
            fs.unlinkSync(path.join(STAGING, name));
        }
    }
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(BACKUP_ROOT, { recursive: true, force: true });
});

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 50 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const v = await fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('timeout waiting for condition');
}

function seedRemoteSnapshots(count) {
    const dir = path.join(BACKUP_ROOT, 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const names = [];
    for (let i = 1; i <= count; i++) {
        const day = String(i).padStart(2, '0');
        const name = `snapshot-202601${day}-120000.tar.gz`;
        fs.writeFileSync(path.join(dir, name), `snap-${i}`);
        // Stagger mtimes so sort-by-mtime is deterministic (newest = highest i).
        const mtime = new Date(Date.UTC(2026, 0, i, 12, 0, 0));
        fs.utimesSync(path.join(dir, name), mtime, mtime);
        names.push(name);
    }
    return names;
}

function listRemoteSnapshots() {
    const dir = path.join(BACKUP_ROOT, 'snapshots');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => n.startsWith('snapshot-')).sort();
}

function listStagingSnapshots() {
    if (!fs.existsSync(STAGING)) return [];
    return fs.readdirSync(STAGING).filter((n) => /^snapshot-.*\.tar\.gz$/.test(n)).sort();
}

describe('backup snapshot retention', () => {
    it('keeps exactly retain_count remote archives (newest by mtime)', async () => {
        const destId = manager.addDestination({
            name: 'retain-remote',
            provider: 'local',
            mode: 'snapshot',
            cron: '0 3 * * *',
            retainCount: 3,
            enabled: true,
            config: { rootPath: BACKUP_ROOT },
        });
        manager.pause(destId);

        seedRemoteSnapshots(7);
        expect(listRemoteSnapshots()).toHaveLength(7);

        await manager._applyRetention(destId);

        const left = listRemoteSnapshots();
        expect(left).toHaveLength(3);
        // Newest three (days 05, 06, 07) remain.
        expect(left).toEqual([
            'snapshot-20260105-120000.tar.gz',
            'snapshot-20260106-120000.tar.gz',
            'snapshot-20260107-120000.tar.gz',
        ]);
    });

    it('applies retention for manual mode destinations', async () => {
        const destId = manager.addDestination({
            name: 'retain-manual',
            provider: 'local',
            mode: 'manual',
            retainCount: 2,
            enabled: true,
            config: { rootPath: BACKUP_ROOT },
        });
        manager.pause(destId);

        seedRemoteSnapshots(5);
        await manager._applyRetention(destId);

        expect(listRemoteSnapshots()).toHaveLength(2);
        expect(listRemoteSnapshots()).toEqual([
            'snapshot-20260104-120000.tar.gz',
            'snapshot-20260105-120000.tar.gz',
        ]);
    });

    it('removes local staging archive after successful snapshot upload', async () => {
        const destId = manager.addDestination({
            name: 'retain-staging',
            provider: 'local',
            mode: 'snapshot',
            cron: '0 3 * * *',
            retainCount: 7,
            enabled: true,
            config: { rootPath: BACKUP_ROOT },
        });

        await manager.runBackup(destId);

        const done = await waitFor(() => {
            const row = db
                .prepare(
                    `SELECT status FROM backup_jobs
                      WHERE destination_id = ? AND snapshot_path IS NOT NULL
                      ORDER BY id DESC LIMIT 1`,
                )
                .get(destId);
            return row?.status === 'done' ? row : null;
        });
        expect(done.status).toBe('done');

        // Staging copy for the uploaded job must be gone.
        expect(listStagingSnapshots()).toHaveLength(0);

        // Remote has the new archive.
        expect(listRemoteSnapshots().length).toBeGreaterThanOrEqual(1);
    });

    it('prunes leftover local staging snapshot-*.tar.gz to retain_count', async () => {
        const destId = manager.addDestination({
            name: 'retain-local-prune',
            provider: 'local',
            mode: 'snapshot',
            cron: '0 3 * * *',
            retainCount: 2,
            enabled: true,
            config: { rootPath: BACKUP_ROOT },
        });
        manager.pause(destId);

        // Leftover staging from prior crashes — plus a pre-update sqlite
        // that must never be touched by snapshot retention.
        for (let i = 1; i <= 5; i++) {
            const day = String(i).padStart(2, '0');
            fs.writeFileSync(
                path.join(STAGING, `snapshot-202602${day}-010000.tar.gz`),
                `old-${i}`,
            );
        }
        fs.writeFileSync(path.join(STAGING, 'db-pre-update-20260201-010000.sqlite'), 'db');

        await manager._applyRetention(destId);

        const left = listStagingSnapshots();
        expect(left).toHaveLength(2);
        expect(left).toEqual([
            'snapshot-20260204-010000.tar.gz',
            'snapshot-20260205-010000.tar.gz',
        ]);
        expect(fs.existsSync(path.join(STAGING, 'db-pre-update-20260201-010000.sqlite'))).toBe(
            true,
        );
    });

    it('reconciles destination total_files/bytes to remaining remotes', async () => {
        const destId = manager.addDestination({
            name: 'retain-stats',
            provider: 'local',
            mode: 'snapshot',
            cron: '0 3 * * *',
            retainCount: 3,
            enabled: true,
            config: { rootPath: BACKUP_ROOT },
        });
        manager.pause(destId);

        // Inflate the lifetime counters the way production did before
        // retention reconciled them (upload bumps, prune never shrank).
        db.prepare(
            `UPDATE backup_destinations SET total_files = 40, total_bytes = 999999 WHERE id = ?`,
        ).run(destId);

        seedRemoteSnapshots(7);
        await manager._applyRetention(destId);

        const row = db
            .prepare(`SELECT total_files, total_bytes FROM backup_destinations WHERE id = ?`)
            .get(destId);
        expect(row.total_files).toBe(3);
        // Newest three files are snap-5/6/7 — each "snap-N" is N bytes of
        // ASCII payload from seedRemoteSnapshots (`snap-${i}`).
        const expectedBytes = Buffer.byteLength('snap-5') + Buffer.byteLength('snap-6') + Buffer.byteLength('snap-7');
        expect(row.total_bytes).toBe(expectedBytes);

        const summary = logs.find(
            (l) => l.level === 'info' && /retention: listed 7, keep 3, pruned 4/.test(l.msg || ''),
        );
        expect(summary).toBeTruthy();
    });

    it('does not log retention pruned when delete fails', async () => {
        const destId = manager.addDestination({
            name: 'retain-delete-fail',
            provider: 'local',
            mode: 'snapshot',
            cron: '0 3 * * *',
            retainCount: 1,
            enabled: true,
            config: { rootPath: BACKUP_ROOT },
        });
        manager.pause(destId);
        seedRemoteSnapshots(3);

        const { LocalProvider } = await import('../src/core/backup/providers/local.js');
        const orig = LocalProvider.prototype.delete;
        LocalProvider.prototype.delete = async () => {
            throw new Error('simulated delete failure');
        };
        try {
            await manager._applyRetention(destId);
        } finally {
            LocalProvider.prototype.delete = orig;
        }

        const prunedOk = logs.filter(
            (l) => l.level === 'info' && /retention pruned/.test(l.msg || ''),
        );
        const prunedFail = logs.filter(
            (l) => l.level === 'warn' && /retention delete failed/.test(l.msg || ''),
        );
        expect(prunedOk).toHaveLength(0);
        expect(prunedFail.length).toBeGreaterThanOrEqual(1);
        // Files remain because deletes failed.
        expect(listRemoteSnapshots()).toHaveLength(3);
    });
});
