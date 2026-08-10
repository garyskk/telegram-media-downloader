// Scrubbed destination config must echo non-secret fields for the edit
// wizard, and updateDestination must merge blank/omitted secrets so they
// are not wiped on save.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-bk-edit-'));
const SHARE_SECRET = crypto.randomBytes(32).toString('hex');
const BACKUP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-bk-edit-root-'));

let db;
let manager;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
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

describe('backup destination edit scrub + merge', () => {
    it('listDestinations returns public config fields but strips secrets', () => {
        const id = manager.addDestination({
            name: 'r2',
            provider: 's3',
            mode: 'mirror',
            enabled: false,
            config: {
                endpoint: 'https://acct.r2.cloudflarestorage.com',
                region: 'auto',
                bucket: 'tgdl',
                accessKeyId: 'AKIAEXAMPLE',
                secretAccessKey: 'super-secret-value',
                prefix: 'tgdl/',
                forcePathStyle: 'auto',
            },
        });

        const dest = manager.listDestinations().find((d) => d.id === id);
        expect(dest.config).toBeTruthy();
        expect(dest.config.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
        expect(dest.config.region).toBe('auto');
        expect(dest.config.bucket).toBe('tgdl');
        expect(dest.config.prefix).toBe('tgdl/');
        expect(dest.config.forcePathStyle).toBe('auto');
        expect(dest.config.accessKeyId).toBeUndefined();
        expect(dest.config.secretAccessKey).toBeUndefined();
    });

    it('updateDestination merges omitted secrets into the existing blob', async () => {
        const id = manager.addDestination({
            name: 'local-nas',
            provider: 'local',
            mode: 'mirror',
            enabled: false,
            config: { rootPath: BACKUP_ROOT },
        });

        const updated = manager.updateDestination(id, {
            name: 'local-nas-renamed',
            config: { rootPath: BACKUP_ROOT },
        });
        expect(updated.name).toBe('local-nas-renamed');
        expect(updated.config.rootPath).toBe(BACKUP_ROOT);

        const s3Id = manager.addDestination({
            name: 's3-merge',
            provider: 's3',
            mode: 'mirror',
            enabled: false,
            config: {
                endpoint: 'https://example.com',
                region: 'us-east-1',
                bucket: 'b1',
                accessKeyId: 'KEY',
                secretAccessKey: 'SECRET',
                prefix: 'old/',
            },
        });
        manager.updateDestination(s3Id, {
            config: {
                endpoint: 'https://example.com',
                region: 'us-east-1',
                bucket: 'b1',
                prefix: 'new/',
            },
        });

        const scrubbed = manager.listDestinations().find((d) => d.id === s3Id);
        expect(scrubbed.config.prefix).toBe('new/');
        expect(scrubbed.config.bucket).toBe('b1');

        manager.updateDestination(s3Id, {
            config: {
                endpoint: 'https://example.com',
                region: 'us-east-1',
                bucket: 'b1',
                prefix: 'new/',
                accessKeyId: '',
                secretAccessKey: '',
            },
        });

        const { decryptConfig } = await import('../src/core/backup/credentials.js');
        const row = db.prepare('SELECT config_blob FROM backup_destinations WHERE id = ?').get(s3Id);
        const cfg = decryptConfig(row.config_blob, SHARE_SECRET);
        expect(cfg.secretAccessKey).toBe('SECRET');
        expect(cfg.accessKeyId).toBe('KEY');
        expect(cfg.prefix).toBe('new/');
    });
});
