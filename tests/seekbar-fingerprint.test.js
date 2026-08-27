// Dual-output seekbar: hover WebP + 1 fps RGB24 raw for pHash.
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
let getVideoFrameHashes;
let spawn;
let _msgId = 1;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    generator = await import('../src/core/seekbar/generator.js');
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    insertDownload = dbMod.insertDownload;
    getVideoFingerprint = dbMod.getVideoFingerprint;
    getVideoFrameHashes = dbMod.getVideoFrameHashes;
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
        if (!s.includes(DATA_DIR) && !s.includes('.tmp.') && !s.endsWith('.fp.raw')) continue;
        if (s.startsWith('-')) continue;
        fs.mkdirSync(path.dirname(s), { recursive: true });
        if (s.includes('.fp.raw')) {
            fs.writeFileSync(s, Buffer.alloc(32 * 32 * 3, 90));
        } else if (/\.(webp|jpg|tmp)/.test(s) || s.includes('.tmp.')) {
            fs.writeFileSync(s, Buffer.alloc(48, 2));
        }
    }
}

describe('planFingerprint', () => {
    it('uses 1 fps without stretching like hover maxTiles', () => {
        const fp = generator.planFingerprint(7200, { fingerprintFps: 1, fingerprintMaxFrames: 7200 });
        expect(fp.frames).toBe(7200);
        expect(fp.intervalSec).toBe(1);
        expect(fp.tilePx).toBe(32);

        const hover = generator.planSprite(7200, {
            intervalSec: 4,
            maxTiles: 240,
            columns: 10,
            tileWidth: 160,
        });
        expect(hover.frames).toBe(240);
        expect(hover.intervalSec).toBeGreaterThan(20);
    });

    it('caps at fingerprintMaxFrames and stretches interval', () => {
        const fp = generator.planFingerprint(14_400, {
            fingerprintFps: 1,
            fingerprintMaxFrames: 7200,
        });
        expect(fp.frames).toBe(7200);
        expect(fp.intervalSec).toBe(2);
    });

    it('plans a 10 s clip as 10 frames at 1 s', () => {
        const fp = generator.planFingerprint(10, {});
        expect(fp.frames).toBe(10);
        expect(fp.intervalSec).toBe(1);
        expect(fp.tilePx).toBe(32);
    });
});

describe('buildDualFilterComplex', () => {
    it('splits one decode into hover tile + 32px padded fingerprint', () => {
        const hover = generator.planSprite(10, {
            intervalSec: 4,
            maxTiles: 240,
            columns: 10,
            tileWidth: 160,
        });
        const fp = generator.planFingerprint(10, {});
        const graph = generator.buildDualFilterComplex(hover, fp, null);
        expect(graph).toContain('split=2');
        expect(graph).toContain(`tile=${hover.cols}x${hover.rows}`);
        expect(graph).toContain('scale=160:-2');
        expect(graph).toContain('scale=32:32:force_original_aspect_ratio=decrease');
        expect(graph).toContain('pad=32:32:');
        expect(graph).toContain('[hout]');
        expect(graph).toContain('[fout]');
    });
});

describe('buildSpriteFfmpegArgs', () => {
    it('uses filter_complex with two maps, not a global -frames:v 1', () => {
        const plan = generator.planSprite(10, {
            intervalSec: 4,
            maxTiles: 240,
            columns: 10,
            tileWidth: 160,
        });
        const fpPlan = generator.planFingerprint(10, {});
        const args = generator.buildSpriteFfmpegArgs({
            srcAbs: '/tmp/in.mp4',
            dstTmp: '/tmp/out.tmp.webp',
            plan,
            fpPlan,
            fpRawAbs: '/tmp/1.fp.raw',
            useWebp: true,
            quality: 75,
            hwArgs: [],
            scaleVf: null,
        });
        const joined = args.join(' ');
        expect(joined).toContain('-filter_complex');
        expect(joined).not.toMatch(/(^|\s)-vf\s/);
        expect(args.filter((a) => a === '-map')).toHaveLength(2);
        expect(joined).toContain('rawvideo');
        expect(joined).toContain('/tmp/1.fp.raw');
        const framesIdx = args.indexOf('-frames:v');
        expect(framesIdx).toBeGreaterThan(-1);
        expect(args[framesIdx - 2]).toBe('-map');
        expect(args.includes('libwebp')).toBe(true);
    });
});

describe('persistFingerprintFromRaw', () => {
    it('hashes the raw dump, upserts rows, and deletes the temp file', async () => {
        const { id } = seedVideo('persist-hash');
        const rawPath = path.join(DATA_DIR, 'seekbar', `${id}.fp.raw`);
        fs.mkdirSync(path.dirname(rawPath), { recursive: true });
        const frame = Buffer.alloc(32 * 32 * 3, 40);
        fs.writeFileSync(rawPath, Buffer.concat([frame, Buffer.alloc(32 * 32 * 3, 200)]));

        const fpPlan = generator.planFingerprint(2, {});
        const result = await generator.persistFingerprintFromRaw({
            downloadId: id,
            rawPath,
            fpPlan,
            durationSec: 2,
            fileHash: 'persist-hash',
        });

        expect(result.frameCount).toBe(2);
        expect(fs.existsSync(rawPath)).toBe(false);
        const row = getVideoFingerprint(id);
        expect(row.file_hash).toBe('persist-hash');
        expect(row.frame_count).toBe(2);
        expect(row.algo).toBe('phash-v1');
        expect(row.aggregate_hash).toMatch(/^[0-9a-f]{16}$/);
        const frames = getVideoFrameHashes(id);
        expect(frames).toHaveLength(2);
        expect(frames[0].t_sec).toBe(0);
        expect(frames[1].phash).not.toBe(frames[0].phash);
    });

    it('returns null when the raw file is missing', async () => {
        const r = await generator.persistFingerprintFromRaw({
            downloadId: 999,
            rawPath: path.join(DATA_DIR, 'missing.fp.raw'),
            fpPlan: generator.planFingerprint(1, {}),
            durationSec: 1,
            fileHash: 'x',
        });
        expect(r).toBeNull();
    });
});

describe('generateForDownload — dual output', () => {
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

    it('persists 1 fps hashes from the local ffmpeg raw output', async () => {
        const { id, abs } = seedVideo('gen-hash');
        const meta = await generator.generateForDownload(
            { id, file_path: abs, file_type: 'video', file_hash: 'gen-hash' },
            { format: 'webp', intervalSec: 4, maxTiles: 240, columns: 10, tileWidth: 160 },
            { overwrite: 'always' },
        );

        expect(meta?.download_id).toBe(id);
        expect(runFfmpegArgs).toHaveBeenCalled();
        const args = runFfmpegArgs.mock.calls[0][0];
        expect(args.join(' ')).toContain('-filter_complex');
        expect(args.join(' ')).toContain('split=2');

        const fp = getVideoFingerprint(id);
        expect(fp).toBeTruthy();
        expect(fp.file_hash).toBe('gen-hash');
        expect(fp.frame_count).toBeGreaterThanOrEqual(1);
        expect(getVideoFrameHashes(id).length).toBe(fp.frame_count);
        expect(fs.existsSync(path.join(DATA_DIR, 'seekbar', `${id}.fp.raw`))).toBe(false);
    });

    it('forwards fingerprint knobs on sidecar submit and hashes fp_raw_path', async () => {
        const { id, abs } = seedVideo('sidecar-hash');
        getSidecarUrl.mockReturnValue('http://127.0.0.1:9999');
        const sidecarSprite = path.join(DATA_DIR, 'from-sidecar.webp');
        const sidecarRaw = path.join(DATA_DIR, `${id}.fp.raw`);
        fs.writeFileSync(sidecarSprite, Buffer.alloc(32));
        fs.writeFileSync(sidecarRaw, Buffer.alloc(32 * 32 * 3, 70));
        submitOne.mockResolvedValue({
            status: 'done',
            sprite_path: sidecarSprite,
            fp_raw_path: sidecarRaw,
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
        expect(body.cfg.fingerprintFps).toBe(1);
        expect(body.cfg.fingerprintMaxFrames).toBe(7200);
        expect(body.cfg.fingerprintTilePx).toBe(32);
        expect(meta?.download_id).toBe(id);
        expect(getVideoFingerprint(id)?.file_hash).toBe('sidecar-hash');
        expect(fs.existsSync(sidecarRaw)).toBe(false);
    });
});
