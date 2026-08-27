import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-similar-cfg-'));
process.env.TGDL_DATA_DIR = DATA_DIR;

let getSimilarClipsConfig;
let SIMILAR_CLIPS_DEFAULTS;
let db;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    ({ getSimilarClipsConfig, SIMILAR_CLIPS_DEFAULTS } = await import(
        '../src/core/similar/config.js'
    ));
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
    delete process.env.TGDL_SIMILAR_PARTIAL_FRAME_THRESHOLD;
    delete process.env.TGDL_SIMILAR_SCENE_THRESHOLD;
    delete process.env.TGDL_SIMILAR_FLOOR_INTERVAL_SEC;
});

describe('getSimilarClipsConfig', () => {
    it('uses PDQ-256 Hamming and scene-sample defaults when env is unset', () => {
        const cfg = getSimilarClipsConfig();
        expect(cfg.similarThreshold).toBe(50);
        expect(cfg.partialFrameThreshold).toBe(70);
        expect(cfg.sceneThreshold).toBe(0.1);
        expect(cfg.floorIntervalSec).toBe(3);
        expect(cfg.fingerprintTilePx).toBe(64);
        expect(cfg.fingerprintMaxFrames).toBe(7200);
        expect(cfg.fingerprintFps).toBeUndefined();
    });

    it('lets TGDL_SIMILAR_* override kv defaults', () => {
        process.env.TGDL_SIMILAR_THRESHOLD = '40';
        process.env.TGDL_SIMILAR_SCENE_THRESHOLD = '0.25';
        process.env.TGDL_SIMILAR_FLOOR_INTERVAL_SEC = '5';
        const cfg = getSimilarClipsConfig();
        expect(cfg.similarThreshold).toBe(40);
        expect(cfg.sceneThreshold).toBe(0.25);
        expect(cfg.floorIntervalSec).toBe(5);
    });

    it('does not expose leftover fingerprintFps from env', () => {
        process.env.TGDL_SIMILAR_FINGERPRINT_FPS = '0.5';
        const cfg = getSimilarClipsConfig();
        expect(cfg.fingerprintFps).toBeUndefined();
        expect(SIMILAR_CLIPS_DEFAULTS.sceneThreshold).toBe(0.1);
        expect(SIMILAR_CLIPS_DEFAULTS).not.toHaveProperty('fingerprintFps');
    });

    it('ignores blank env so compose does not pin 0', () => {
        process.env.TGDL_SIMILAR_THRESHOLD = '';
        process.env.TGDL_SIMILAR_SCENE_THRESHOLD = '  ';
        expect(getSimilarClipsConfig().similarThreshold).toBe(50);
        expect(getSimilarClipsConfig().sceneThreshold).toBe(0.1);
    });
});
