import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-similar-cfg-'));
process.env.TGDL_DATA_DIR = DATA_DIR;

let getSimilarClipsConfig;
let db;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    ({ getSimilarClipsConfig } = await import('../src/core/similar/config.js'));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
    delete process.env.TGDL_SIMILAR_FINGERPRINT_FPS;
    delete process.env.TGDL_SIMILAR_THRESHOLD;
});

describe('getSimilarClipsConfig', () => {
    it('uses defaults when env is unset', () => {
        const cfg = getSimilarClipsConfig();
        expect(cfg.fingerprintFps).toBe(1);
        expect(cfg.fingerprintMaxFrames).toBe(7200);
        expect(cfg.similarThreshold).toBe(5);
    });

    it('lets TGDL_SIMILAR_* override kv defaults', () => {
        process.env.TGDL_SIMILAR_FINGERPRINT_FPS = '0.5';
        process.env.TGDL_SIMILAR_THRESHOLD = '8';
        const cfg = getSimilarClipsConfig();
        expect(cfg.fingerprintFps).toBe(0.5);
        expect(cfg.similarThreshold).toBe(8);
    });

    it('ignores blank env so compose does not pin 0', () => {
        process.env.TGDL_SIMILAR_THRESHOLD = '';
        expect(getSimilarClipsConfig().similarThreshold).toBe(5);
    });
});
