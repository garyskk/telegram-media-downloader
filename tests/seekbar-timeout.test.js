// Duration-scaled seekbar sprite timeouts:
//   spriteTimeoutMs clamp, sidecar submit+poll (no second ffmpeg),
//   and runFfmpegArgs timeout override (thumbs stay at 120s).

import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-seekbar-to-'));
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
let spawn;
let _msgId = 1;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    generator = await import('../src/core/seekbar/generator.js');
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    insertDownload = dbMod.insertDownload;
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

function fakeFfprobeProc(duration = '3600.0') {
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

function seedVideo() {
    const abs = path.join(DATA_DIR, 'downloads', 'g', 'videos', `clip-${_msgId}.mp4`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(64));
    const r = insertDownload({
        groupId: '-100seekbar',
        groupName: 'SeekbarTO',
        messageId: _msgId++,
        fileName: path.basename(abs),
        fileSize: 64,
        fileType: 'video',
        filePath: abs,
    });
    return { id: Number(r.lastInsertRowid), abs };
}

describe('spriteTimeoutMs', () => {
    it.each([
        [15, 5 * 60_000],
        [600, 10 * 60_000],
        [3600, 60 * 60_000],
        [7200, 60 * 60_000],
        [0, 5 * 60_000],
        [NaN, 5 * 60_000],
        [null, 5 * 60_000],
        [undefined, 5 * 60_000],
        [-10, 5 * 60_000],
    ])('duration %s → %s ms', (durationSec, expected) => {
        expect(generator.spriteTimeoutMs(durationSec)).toBe(expected);
    });
});

describe('generateForDownload — sidecar poll, no local ffmpeg', () => {
    beforeEach(() => {
        spawn.mockImplementation((bin, args, opts) => {
            if ((args || []).some((a) => String(a).includes('duration'))) {
                return fakeFfprobeProc('3600.0');
            }
            return childHolder.spawn(bin, args, opts);
        });
        getSidecarUrl.mockReturnValue('http://127.0.0.1:9999');
    });

    it('polls after sidecar timeout and does not spawn local ffmpeg', async () => {
        const { id, abs: src } = seedVideo();
        const sidecarSprite = path.join(DATA_DIR, 'from-sidecar.webp');
        fs.writeFileSync(sidecarSprite, Buffer.alloc(32));
        submitOne.mockResolvedValue({ status: 'timeout', job_id: 'job-1' });
        waitForJob.mockResolvedValue({
            status: 'done',
            id: 'job-1',
            sprite_path: sidecarSprite,
            duration: 3600,
            frames: 400,
            cols: 10,
            rows: 40,
            tile_w: 160,
            format: 'webp',
            bytes: 32,
        });

        const meta = await generator.generateForDownload(
            { id, file_path: src, file_type: 'video' },
            { format: 'webp', intervalSec: 4, maxTiles: 240, columns: 10, tileWidth: 160 },
            { overwrite: 'always' },
        );

        expect(submitOne).toHaveBeenCalledOnce();
        expect(submitOne.mock.calls[0][0].async).toBe(true);
        expect(waitForJob).toHaveBeenCalledWith(
            'job-1',
            expect.objectContaining({ timeoutMs: 60 * 60_000 }),
        );
        expect(runFfmpegArgs).not.toHaveBeenCalled();
        expect(meta?.download_id).toBe(id);
        expect(meta?.frames).toBe(400);
    });

    it('does not fall through to local ffmpeg when the sidecar poll times out', async () => {
        const { id, abs: src } = seedVideo();
        submitOne.mockResolvedValue({ status: 'pending', id: 'job-2' });
        waitForJob.mockRejectedValue(new Error('ffmpeg timeout 3600s'));

        await expect(
            generator.generateForDownload(
                { id, file_path: src, file_type: 'video' },
                { format: 'webp' },
                { overwrite: 'always' },
            ),
        ).rejects.toThrow(/ffmpeg timeout 3600s/);
        expect(runFfmpegArgs).not.toHaveBeenCalled();
    });
});

describe('waitForJob (real client)', () => {
    let client;

    beforeAll(async () => {
        client = await vi.importActual('../src/core/seekbar/client.js');
    });

    afterEach(() => {
        client.setSidecarUrl('');
    });

    function jsonRes(body, status = 200) {
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: () => 'application/json' },
            json: async () => body,
            text: async () => JSON.stringify(body),
        };
    }

    it('polls until status is done', async () => {
        client.setSidecarUrl('http://sidecar.test');
        const statuses = ['pending', 'running', 'done'];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            const status = statuses.shift() || 'done';
            return jsonRes({
                id: 'j1',
                status,
                sprite_path: status === 'done' ? '/tmp/x.webp' : undefined,
            });
        });
        const r = await client.waitForJob('j1', { timeoutMs: 5_000, pollMs: 1 });
        expect(r.status).toBe('done');
        expect(r.sprite_path).toBe('/tmp/x.webp');
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('throws ffmpeg timeout Ns when the job never completes', async () => {
        client.setSidecarUrl('http://sidecar.test');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ id: 'j1', status: 'running' }));
        await expect(client.waitForJob('j1', { timeoutMs: 30, pollMs: 5 })).rejects.toThrow(
            /ffmpeg timeout 1s/,
        );
    });
});

describe('runFfmpegArgs timeout override', () => {
    it('keeps the 120s default for thumbs', async () => {
        const thumbs = await vi.importActual('../src/core/thumbs.js');
        expect(thumbs.FFMPEG_TIMEOUT_MS).toBe(120_000);
    });

    it('rejects with ffmpeg timeout Ns when the override elapses', async () => {
        const thumbs = await vi.importActual('../src/core/thumbs.js');
        const hanging = new EventEmitter();
        hanging.stdout = new EventEmitter();
        hanging.stderr = new EventEmitter();
        hanging.kill = vi.fn();
        const { spawn: realSpawn } = await import('child_process');
        realSpawn.mockImplementationOnce(() => hanging);

        await expect(thumbs.runFfmpegArgs(['-version'], { timeoutMs: 50 })).rejects.toThrow(
            /^ffmpeg timeout 1s$/,
        );
        expect(hanging.kill).toHaveBeenCalled();
    });
});
