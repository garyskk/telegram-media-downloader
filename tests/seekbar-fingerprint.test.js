// Hover-only seekbar: WebP sprite, no fingerprint dual-output.
// Mocks ffmpeg the same way tests/seekbar-timeout.test.js does.

import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-seekbar-fp-'));
process.env.TGDL_DATA_DIR = DATA_DIR;

const getSidecarUrl = vi.hoisted(() => vi.fn(() => ''));
const submitOne = vi.hoisted(() => vi.fn());
const waitForJob = vi.hoisted(() => vi.fn());
const runFfmpegArgs = vi.hoisted(() => vi.fn());

vi.mock('../src/core/seekbar/client.js', () => ({
    getSidecarUrl,
    submitOne,
    waitForJob,
    getJob: vi.fn(),
    setSidecarUrl: vi.fn(),
    health: vi.fn(),
    submitBatch: vi.fn(),
    deleteSprite: vi.fn(),
    probeHwaccel: vi.fn(),
    stats: vi.fn(),
}));

vi.mock('../src/core/thumbs.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        runFfmpegArgs,
        hasFfmpeg: () => true,
        ffmpegHasLibwebp: () => true,
        hwaccelUploadPipeline: () => ({ inputArgs: [], scaleVf: null }),
    };
});

const childHolder = vi.hoisted(() => ({ spawn: null }));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const spawn = vi.fn((...args) => actual.spawn(...args));
    childHolder.spawn = actual.spawn;
    return { ...actual, spawn };
});

let generator;
let db;
let insertDownload;
let getVideoFingerprint;
let spawn;
let _msgId = 1;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    generator = await import('../src/core/seekbar/generator.js');
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    insertDownload = dbMod.insertDownload;
    getVideoFingerprint = dbMod.getVideoFingerprint;
    ({ spawn } = await import('child_process'));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
    getSidecarUrl.mockReset();
    getSidecarUrl.mockReturnValue('');
    submitOne.mockReset();
    waitForJob.mockReset();
    runFfmpegArgs.mockReset();
    spawn.mockImplementation((...args) => childHolder.spawn(...args));
    vi.restoreAllMocks();
});

function fakeFfprobeProc(duration = '10.0') {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {};
    queueMicrotask(() => {
        p.stdout.emit('data', Buffer.from(String(duration)));
        p.emit('close', 0);
    });
    return p;
}

function seedVideo(fileHash = 'fp-hash-1') {
    const abs = path.join(DATA_DIR, 'downloads', 'g', 'videos', `clip-${_msgId}.mp4`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(64));
    const r = insertDownload({
        groupId: '-100seekbarfp',
        groupName: 'SeekbarFp',
        messageId: _msgId++,
        fileName: path.basename(abs),
        fileSize: 64,
        fileType: 'video',
        filePath: abs,
        fileHash,
    });
    return { id: Number(r.lastInsertRowid), abs };
}

function writeMockOutputs(args) {
    for (const a of args) {
        const s = String(a);
        if (!s.includes(DATA_DIR) && !s.includes('.tmp.')) continue;
        if (s.startsWith('-')) continue;
        fs.mkdirSync(path.dirname(s), { recursive: true });
        if (/\.(webp|jpg|tmp)/.test(s) || s.includes('.tmp.')) {
            fs.writeFileSync(s, Buffer.alloc(48, 2));
        }
    }
}

describe('buildSpriteFfmpegArgs', () => {
    it('uses hover-only -vf, not filter_complex dual-output', () => {
        const plan = generator.planSprite(10, {
            intervalSec: 4,
            maxTiles: 240,
            columns: 10,
            tileWidth: 160,
        });
        const args = generator.buildSpriteFfmpegArgs({
            srcAbs: '/tmp/in.mp4',
            dstTmp: '/tmp/out.tmp.webp',
            plan,
            useWebp: true,
            quality: 75,
            hwArgs: [],
            scaleVf: null,
        });
        const joined = args.join(' ');
        expect(joined).toMatch(/(^|\s)-vf\s/);
        expect(joined).not.toContain('-filter_complex');
        expect(joined).not.toContain('rawvideo');
        expect(joined).not.toContain('.fp.raw');
        expect(args.filter((a) => a === '-map')).toHaveLength(0);
        expect(args.includes('libwebp')).toBe(true);
    });
});

describe('generateForDownload — hover only', () => {
    beforeEach(() => {
        spawn.mockImplementation((bin, args) => {
            if ((args || []).some((a) => String(a).includes('duration'))) {
                return fakeFfprobeProc('10.0');
            }
            return childHolder.spawn(bin, args);
        });
        getSidecarUrl.mockReturnValue('');
        runFfmpegArgs.mockImplementation(async (args) => {
            writeMockOutputs(args);
        });
    });

    it('does not persist video fingerprints', async () => {
        const { id, abs } = seedVideo('gen-hash');
        const meta = await generator.generateForDownload(
            { id, file_path: abs, file_type: 'video', file_hash: 'gen-hash' },
            { format: 'webp', intervalSec: 4, maxTiles: 240, columns: 10, tileWidth: 160 },
            { overwrite: 'always' },
        );

        expect(meta?.download_id).toBe(id);
        expect(runFfmpegArgs).toHaveBeenCalled();
        const args = runFfmpegArgs.mock.calls[0][0];
        expect(args.join(' ')).toContain('-vf');
        expect(args.join(' ')).not.toContain('split=2');
        expect(getVideoFingerprint(id)).toBeNull();
    });

    it('does not forward fingerprint knobs on sidecar submit', async () => {
        const { id, abs } = seedVideo('sidecar-hash');
        getSidecarUrl.mockReturnValue('http://127.0.0.1:9999');
        const sidecarSprite = path.join(DATA_DIR, 'from-sidecar.webp');
        fs.writeFileSync(sidecarSprite, Buffer.alloc(32));
        submitOne.mockResolvedValue({
            status: 'done',
            sprite_path: sidecarSprite,
            duration: 10,
            frames: 8,
            cols: 10,
            rows: 1,
            tile_w: 160,
            format: 'webp',
            bytes: 32,
        });

        const meta = await generator.generateForDownload(
            { id, file_path: abs, file_type: 'video', file_hash: 'sidecar-hash' },
            { format: 'webp', intervalSec: 4, maxTiles: 240, columns: 10, tileWidth: 160 },
            { overwrite: 'always' },
        );

        expect(runFfmpegArgs).not.toHaveBeenCalled();
        expect(submitOne).toHaveBeenCalledOnce();
        const body = submitOne.mock.calls[0][0];
        expect(body.cfg.fingerprintFps).toBeUndefined();
        expect(body.cfg.fingerprintMaxFrames).toBeUndefined();
        expect(meta?.download_id).toBe(id);
        expect(getVideoFingerprint(id)).toBeNull();
    });
});
