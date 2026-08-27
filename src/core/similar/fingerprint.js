/**
 * Similar-clips fingerprint runner. Own ffmpeg (not seekbar, not the
 * Go sidecar): scene-or-floor `select`, 64×64 RGB, PDQ-256, real pts
 * from `showinfo`.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readdir, unlink } from 'fs/promises';
import path from 'path';

import { getDownloadById, getVideoFingerprint, replaceVideoFrameHashes, upsertVideoFingerprint } from '../db.js';
import { pdqHexFromRgb24, xorAggregate } from '../phash.js';
import { getDataDir, getDownloadsDir } from '../paths.js';
import { hasFfmpeg, resolveFfmpegBin, resolveFfprobeBin } from '../thumbs.js';
import { FINGERPRINT_ALGO, getSimilarClipsConfig } from './config.js';

export { FINGERPRINT_ALGO };

const DOWNLOADS_DIR = getDownloadsDir();
const DEFAULT_FLOOR_SEC = 3;
const DEFAULT_SCENE_THRESH = 0.1;
const PDQ_TILE_PX = 64;
const TIMEOUT_FLOOR_MS = 5 * 60_000;
const TIMEOUT_CAP_MS = 60 * 60_000;

function _timeoutMs(durationSec) {
    const d = Number(durationSec);
    if (!Number.isFinite(d) || d <= 0) return TIMEOUT_FLOOR_MS;
    return Math.min(TIMEOUT_CAP_MS, Math.max(TIMEOUT_FLOOR_MS, Math.ceil(d * 1000)));
}

export function buildFingerprintFilter({
    floorIntervalSec = DEFAULT_FLOOR_SEC,
    sceneThreshold = DEFAULT_SCENE_THRESH,
    tilePx = PDQ_TILE_PX,
} = {}) {
    const floor = Number.isFinite(Number(floorIntervalSec)) ? Number(floorIntervalSec) : DEFAULT_FLOOR_SEC;
    const thresh = Number.isFinite(Number(sceneThreshold)) ? Number(sceneThreshold) : DEFAULT_SCENE_THRESH;
    const px = Math.max(8, Math.min(64, Math.floor(Number(tilePx) || PDQ_TILE_PX)));
    const select =
        `isnan(prev_selected_t)+gte(t-prev_selected_t\\,${floor})` + `+gt(scene\\,${thresh})`;
    return (
        `select='${select}',` +
        `scale=${px}:${px}:force_original_aspect_ratio=decrease:flags=fast_bilinear,` +
        `pad=${px}:${px}:(ow-iw)/2:(oh-ih)/2:black,format=rgb24,showinfo`
    );
}

export function buildFingerprintFfmpegArgs({
    srcAbs,
    floorIntervalSec = DEFAULT_FLOOR_SEC,
    sceneThreshold = DEFAULT_SCENE_THRESH,
    tilePx = PDQ_TILE_PX,
} = {}) {
    return [
        '-hide_banner',
        '-loglevel',
        'info',
        '-i',
        srcAbs,
        '-an',
        '-vf',
        buildFingerprintFilter({ floorIntervalSec, sceneThreshold, tilePx }),
        '-vsync',
        '0',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
    ];
}

export function parseShowinfoPts(stderr) {
    const out = [];
    const re = /pts_time:\s*(-?\d+(?:\.\d+)?)/g;
    const text = String(stderr || '');
    let m;
    while ((m = re.exec(text))) {
        const t = Number(m[1]);
        if (Number.isFinite(t)) out.push(t);
    }
    return out;
}

export function zipRawFramesWithPts(buf, pts, tilePx = PDQ_TILE_PX) {
    const px = Math.max(8, Math.floor(Number(tilePx) || PDQ_TILE_PX));
    const frameSize = px * px * 3;
    const times = Array.isArray(pts) ? pts : [];
    if (!buf?.length || frameSize <= 0 || !times.length) return [];
    const n = Math.floor(buf.length / frameSize);
    if (n !== times.length) return [];
    const frames = [];
    for (let i = 0; i < n; i++) {
        const slice = buf.subarray(i * frameSize, (i + 1) * frameSize);
        frames.push({
            tSec: times[i],
            phash: pdqHexFromRgb24(slice, px),
        });
    }
    return frames;
}

function _resolveDownloadAbs(stored) {
    if (!stored) return null;
    if (path.isAbsolute(stored) && existsSync(stored)) return stored;
    let s = String(stored).replace(/\\/g, '/');
    while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
    const candidate = path.join(DOWNLOADS_DIR, s);
    if (existsSync(candidate)) return candidate;
    if (existsSync(stored)) return stored;
    return null;
}

function _ffprobeDuration(absPath) {
    return new Promise((resolve) => {
        try {
            const probe = resolveFfprobeBin();
            const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', absPath];
            const p = spawn(probe, args, { windowsHide: true });
            const chunks = [];
            p.stdout.on('data', (c) => chunks.push(c));
            p.on('error', () => resolve(null));
            p.on('close', (code) => {
                if (code !== 0) return resolve(null);
                const v = parseFloat(Buffer.concat(chunks).toString('utf8').trim());
                resolve(Number.isFinite(v) && v > 0 ? v : null);
            });
        } catch {
            resolve(null);
        }
    });
}

function _runFingerprintFfmpeg(srcAbs, args, { timeoutMs, signal, maxBytes } = {}) {
    return new Promise((resolve, reject) => {
        const bin = resolveFfmpegBin();
        let proc;
        try {
            proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            reject(e);
            return;
        }
        const stdoutChunks = [];
        const stderrChunks = [];
        let stdoutBytes = 0;
        let timedOut = false;
        let aborted = false;
        const onAbort = () => {
            aborted = true;
            try {
                proc.kill('SIGKILL');
            } catch {
                /* already gone */
            }
        };
        if (signal) {
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }
        const timer =
            Number.isFinite(timeoutMs) && timeoutMs > 0
                ? setTimeout(() => {
                      timedOut = true;
                      try {
                          proc.kill('SIGKILL');
                      } catch {
                          /* already gone */
                      }
                  }, timeoutMs)
                : null;
        proc.stdout.on('data', (c) => {
            stdoutBytes += c.length;
            if (Number.isFinite(maxBytes) && stdoutBytes > maxBytes) {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    /* already gone */
                }
                return;
            }
            stdoutChunks.push(c);
        });
        proc.stderr.on('data', (c) => stderrChunks.push(c));
        proc.on('error', (e) => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
            reject(e);
        });
        proc.on('close', (code) => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
            const stderr = Buffer.concat(stderrChunks).toString('utf8');
            const stdout = Buffer.concat(stdoutChunks);
            if (aborted) {
                reject(Object.assign(new Error('aborted'), { aborted: true }));
                return;
            }
            if (timedOut) {
                reject(new Error(`ffmpeg timeout ${Math.round((timeoutMs || 0) / 1000)}s`));
                return;
            }
            if (code !== 0) {
                reject(new Error(`ffmpeg: exit ${code} (stderr: ${stderr.slice(-400)})`));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

function persistFingerprintFrames({ downloadId, durationSec, fileHash, frames }) {
    const id = Number(downloadId);
    const list = Array.isArray(frames) ? frames : [];
    if (!Number.isInteger(id) || id <= 0 || !list.length) return null;
    const aggregateHash = xorAggregate(list.map((f) => f.phash));
    upsertVideoFingerprint({
        downloadId: id,
        durationSec,
        aggregateHash,
        frameCount: list.length,
        algo: FINGERPRINT_ALGO,
        fileHash: fileHash == null ? null : String(fileHash),
    });
    replaceVideoFrameHashes(id, list);
    return { frameCount: list.length, aggregateHash, algo: FINGERPRINT_ALGO };
}

/**
 * Decode one video into PDQ-256 scene hashes. Never calls seekbar generate.
 */
export async function generateFingerprintForDownload(row, opts = {}) {
    if (!hasFfmpeg()) return null;
    if (!row || row.id == null) return null;
    if (row.file_type && row.file_type !== 'video') return null;
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    const srcAbs = _resolveDownloadAbs(row.file_path);
    if (!srcAbs) return { skipped: 'missing' };

    const cfg = getSimilarClipsConfig();
    const floorRaw = Number(cfg.floorIntervalSec);
    const floorIntervalSec =
        Number.isFinite(floorRaw) && floorRaw > 0 ? floorRaw : DEFAULT_FLOOR_SEC;
    const sceneRaw = Number(cfg.sceneThreshold);
    const sceneThreshold = Number.isFinite(sceneRaw) && sceneRaw >= 0 ? sceneRaw : DEFAULT_SCENE_THRESH;
    const maxFrames = Math.max(1, Math.floor(Number(cfg.fingerprintMaxFrames) || 7200));
    const tilePx = Math.max(32, Math.min(64, Math.floor(Number(cfg.fingerprintTilePx) || PDQ_TILE_PX)));

    if (opts.signal?.aborted) return null;
    const duration = await _ffprobeDuration(srcAbs);
    if (opts.signal?.aborted) return null;
    if (!duration) return { skipped: 'no_duration' };

    const args = buildFingerprintFfmpegArgs({
        srcAbs,
        floorIntervalSec,
        sceneThreshold,
        tilePx,
    });
    const maxBytes = maxFrames * tilePx * tilePx * 3;
    let raw;
    try {
        raw = await _runFingerprintFfmpeg(srcAbs, args, {
            timeoutMs: _timeoutMs(duration),
            signal: opts.signal,
            maxBytes,
        });
    } catch (e) {
        if (e?.aborted) return null;
        throw e;
    }

    let pts = parseShowinfoPts(raw.stderr);
    let buf = raw.stdout;
    const frameSize = tilePx * tilePx * 3;
    const packed = Math.floor((buf?.length || 0) / frameSize);
    if (packed > maxFrames) {
        buf = buf.subarray(0, maxFrames * frameSize);
        pts = pts.slice(0, maxFrames);
    }
    const frames = zipRawFramesWithPts(buf, pts, tilePx);
    if (!frames.length) {
        throw new Error('fingerprint: pts/frame count mismatch or empty sample');
    }

    const fileHash = row.file_hash ?? getDownloadById(id)?.file_hash ?? null;
    const persisted = persistFingerprintFrames({
        downloadId: id,
        durationSec: duration,
        fileHash,
        frames,
    });
    return {
        download_id: id,
        duration_sec: duration,
        frames: persisted.frameCount,
        algo: FINGERPRINT_ALGO,
    };
}

export function sourceExists(row) {
    return Boolean(_resolveDownloadAbs(row?.file_path));
}

const _bgQueue = [];
const _inFlight = new Set();
let _bgRunning = false;
const _BG_QUEUE_CAP = 200;

function _fingerprintIsCurrent(row) {
    if (!row?.id) return false;
    const fp = getVideoFingerprint(row.id);
    if (!fp || fp.algo !== FINGERPRINT_ALGO) return false;
    if (row.file_hash) return fp.file_hash === String(row.file_hash);
    return true;
}

/** Post-download hook. Independent of seekbar pregenerate. */
export function pregenerateFingerprint(downloadId) {
    const id = Number(downloadId);
    if (!Number.isInteger(id) || id <= 0) return;
    queueMicrotask(() => {
        if (_bgQueue.length >= _BG_QUEUE_CAP) return;
        if (_inFlight.has(id) || _bgQueue.includes(id)) return;
        _bgQueue.push(id);
        _drainBg();
    });
}

async function _drainBg() {
    if (_bgRunning) return;
    _bgRunning = true;
    try {
        while (_bgQueue.length) {
            const id = _bgQueue.shift();
            if (id == null || _inFlight.has(id)) continue;
            _inFlight.add(id);
            try {
                const row = getDownloadById(id);
                if (!row || row.file_type !== 'video') continue;
                if (_fingerprintIsCurrent(row)) continue;
                await generateFingerprintForDownload(row);
            } catch (e) {
                console.warn('[similar-pregenerate] failed for download', id, String(e?.message || e));
            } finally {
                _inFlight.delete(id);
            }
            await new Promise((r) => setImmediate(r));
        }
    } finally {
        _bgRunning = false;
        if (_bgQueue.length) queueMicrotask(_drainBg);
    }
}

/**
 * Best-effort unlink of leftover dual-output `{id}.fp.raw` under the
 * seekbar dir. Does not touch hover WebP/JSON.
 * @param {string} [dir]
 * @returns {Promise<number>} files removed
 */
export async function unlinkLeftoverFingerprintRaws(dir) {
    const root = dir || path.join(getDataDir(), 'seekbar');
    let names;
    try {
        names = await readdir(root);
    } catch (e) {
        if (e && e.code === 'ENOENT') return 0;
        throw e;
    }
    let n = 0;
    for (const name of names) {
        if (!name.endsWith('.fp.raw')) continue;
        try {
            await unlink(path.join(root, name));
            n++;
        } catch {
            /* best-effort */
        }
    }
    return n;
}
