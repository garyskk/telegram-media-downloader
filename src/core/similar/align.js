/**
 * Smith-Waterman local alignment of perceptual-hash sequences.
 *
 * Substitution is Hamming (match if ≤ matchHamming). Gaps cover extra
 * bumpers and a skipped scene. Callers decide similar vs partial from
 * coverageA/coverageB/coverageShort and duration gates.
 *
 * The SW matrix runs on a `worker_threads` worker (same isolation HTTP
 * gets from the seekbar sidecar's fetch) so Analyze does not stall the
 * main event loop. SQLite, incremental scans, Stop, and WS progress
 * stay on the parent. `SIMILAR_ALIGN_WORKER_DISABLE=1` falls back to
 * the sync path (tests / restricted runtimes).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const DIR_STOP = 0;
const DIR_DIAG = 1;
const DIR_UP = 2;
const DIR_LEFT = 3;

const POP8 = new Uint8Array(256);
for (let i = 1; i < 256; i++) POP8[i] = POP8[i >> 1] + (i & 1);

function _norm(seq) {
    const list = Array.isArray(seq) ? seq : [];
    return list.map((item, i) => {
        if (item == null) return { tSec: i, phash: '' };
        if (typeof item === 'string') return { tSec: i, phash: item };
        const t = Number(item.tSec);
        return {
            tSec: Number.isFinite(t) ? t : i,
            phash: String(item.phash || ''),
        };
    });
}

function _toBytes(hex) {
    const s = String(hex || '');
    const n = s.length >> 1;
    if (!n) return null;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const hi = _nibble(s.charCodeAt(i * 2));
        const lo = _nibble(s.charCodeAt(i * 2 + 1));
        if (hi < 0 || lo < 0) return null;
        out[i] = (hi << 4) | lo;
    }
    return out;
}

function _nibble(c) {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 97 && c <= 102) return c - 87;
    if (c >= 65 && c <= 70) return c - 55;
    return -1;
}

function _hammingBytes(a, b) {
    if (!a || !b) return Infinity;
    const n = Math.min(a.length, b.length);
    let d = 0;
    for (let i = 0; i < n; i++) d += POP8[a[i] ^ b[i]];
    return d;
}

function _empty() {
    return {
        score: 0,
        matched: 0,
        alignedPairs: 0,
        meanHamming: Infinity,
        coverageA: 0,
        coverageB: 0,
        coverageShort: 0,
        startIndexA: -1,
        startIndexB: -1,
        offsetASec: null,
        offsetBSec: null,
        cancelled: false,
    };
}

function _cancelled() {
    return { ..._empty(), cancelled: true };
}

function _scoreOpts(opts = {}) {
    const matchHamming = Number.isFinite(Number(opts.matchHamming)) ? Number(opts.matchHamming) : 50;
    const matchScore = Number.isFinite(Number(opts.matchScore)) ? Number(opts.matchScore) : 2;
    const mismatchScore = Number.isFinite(Number(opts.mismatchScore)) ? Number(opts.mismatchScore) : -1;
    const gapScore = Number.isFinite(Number(opts.gapScore)) ? Number(opts.gapScore) : -1;
    return { matchHamming, matchScore, mismatchScore, gapScore };
}

/**
 * CPU-bound SW. Safe to call from a worker. Does not yield; abort is
 * the parent's `worker.terminate()`.
 */
export function alignHashSequencesSync(seqA, seqB, opts = {}) {
    const { matchHamming, matchScore, mismatchScore, gapScore } = _scoreOpts(opts);
    const a = _norm(seqA);
    const b = _norm(seqB);
    const n = a.length;
    const m = b.length;
    if (!n || !m) return _empty();

    const aBytes = a.map((row) => _toBytes(row.phash));
    const bBytes = b.map((row) => _toBytes(row.phash));
    const cols = m + 1;
    const H = new Float64Array((n + 1) * cols);
    const P = new Uint8Array((n + 1) * cols);
    let best = 0;
    let bestI = 0;
    let bestJ = 0;

    for (let i = 1; i <= n; i++) {
        const row = i * cols;
        const prev = (i - 1) * cols;
        const leftBytes = aBytes[i - 1];
        for (let j = 1; j <= m; j++) {
            const ham = _hammingBytes(leftBytes, bBytes[j - 1]);
            const sub = ham <= matchHamming ? matchScore : mismatchScore;
            const diag = H[prev + (j - 1)] + sub;
            const up = H[prev + j] + gapScore;
            const left = H[row + (j - 1)] + gapScore;
            let v = 0;
            let dir = DIR_STOP;
            if (diag > v) {
                v = diag;
                dir = DIR_DIAG;
            }
            if (up > v) {
                v = up;
                dir = DIR_UP;
            }
            if (left > v) {
                v = left;
                dir = DIR_LEFT;
            }
            if (v <= 0) {
                v = 0;
                dir = DIR_STOP;
            }
            H[row + j] = v;
            P[row + j] = dir;
            if (v > best || (v === best && i + j > bestI + bestJ)) {
                best = v;
                bestI = i;
                bestJ = j;
            }
        }
    }

    if (best <= 0) return _empty();

    const pairs = [];
    let i = bestI;
    let j = bestJ;
    while (i > 0 && j > 0) {
        const dir = P[i * cols + j];
        if (dir === DIR_STOP) break;
        if (dir === DIR_DIAG) {
            pairs.push({
                i: i - 1,
                j: j - 1,
                hamming: _hammingBytes(aBytes[i - 1], bBytes[j - 1]),
            });
            i--;
            j--;
        } else if (dir === DIR_UP) {
            i--;
        } else {
            j--;
        }
    }
    pairs.reverse();
    if (!pairs.length) return _empty();

    let hamSum = 0;
    let matched = 0;
    for (const p of pairs) {
        hamSum += p.hamming;
        if (p.hamming <= matchHamming) matched++;
    }

    const startA = pairs[0].i;
    const startB = pairs[0].j;
    const shorter = Math.min(n, m) || 1;
    return {
        score: best,
        matched,
        alignedPairs: pairs.length,
        meanHamming: hamSum / pairs.length,
        coverageA: matched / n,
        coverageB: matched / m,
        coverageShort: matched / shorter,
        startIndexA: startA,
        startIndexB: startB,
        offsetASec: a[startA].tSec,
        offsetBSec: b[startB].tSec,
        cancelled: false,
    };
}

if (!isMainThread) {
    parentPort.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        const { jobId } = msg;
        try {
            const result = alignHashSequencesSync(msg.seqA, msg.seqB, msg.opts || {});
            parentPort.postMessage({ jobId, ok: true, result });
        } catch (err) {
            parentPort.postMessage({
                jobId,
                ok: false,
                error: err?.message || String(err),
            });
        }
    });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = path.join(__dirname, 'align.js');
const DISABLED = process.env.SIMILAR_ALIGN_WORKER_DISABLE === '1';

/** @type {{ worker: Worker, busy: boolean } | null} */
let _slot = null;
let _nextJobId = 1;
const _waiters = [];
const _inFlight = new Map();
let _shuttingDown = false;

function _ensureWorker() {
    if (_slot || DISABLED || !isMainThread || _shuttingDown) return;
    _slot = _makeSlot();
}

function _makeSlot() {
    const worker = new Worker(WORKER_FILE);
    const slot = { worker, busy: false };
    worker.on('message', (msg) => {
        const { jobId, ok, result } = msg || {};
        const pending = _inFlight.get(jobId);
        if (!pending) return;
        _inFlight.delete(jobId);
        slot.busy = false;
        pending.settled = true;
        pending.unlistenAbort?.();
        pending.resolve(ok ? result || _empty() : _empty());
        _drainWaiters();
    });
    worker.on('error', () => {
        _failInFlight(slot, _cancelled());
        if (!_shuttingDown) _replaceSlot(slot);
    });
    worker.on('exit', () => {
        _failInFlight(slot, _cancelled());
        if (!_shuttingDown && _slot && _slot.worker === slot.worker) {
            _slot = _makeSlot();
            _drainWaiters();
        }
    });
    return slot;
}

function _failInFlight(slot, result) {
    for (const [jid, pending] of _inFlight) {
        if (pending.worker !== slot.worker) continue;
        _inFlight.delete(jid);
        pending.unlistenAbort?.();
        pending.resolve(result);
    }
    slot.busy = false;
}

function _replaceSlot(dead) {
    if (_shuttingDown) return;
    if (_slot && _slot.worker === dead.worker) {
        _slot = _makeSlot();
        _drainWaiters();
    }
}

function _abortJob(job) {
    if (job.settled) return;
    job.settled = true;
    job.unlistenAbort?.();
    const wi = _waiters.indexOf(job);
    if (wi >= 0) _waiters.splice(wi, 1);
    if (job.jobId != null && _inFlight.has(job.jobId)) {
        _inFlight.delete(job.jobId);
        const slot = _slot;
        if (slot && slot.worker === job.worker) {
            slot.busy = true;
            slot.worker.terminate().catch(() => {});
        }
    }
    job.resolve(_cancelled());
}

function _drainWaiters() {
    if (!_slot || _slot.busy || !_waiters.length || _shuttingDown) return;
    const job = _waiters.shift();
    if (job.settled) {
        _drainWaiters();
        return;
    }
    if (job.signal?.aborted) {
        job.settled = true;
        job.unlistenAbort?.();
        job.resolve(_cancelled());
        _drainWaiters();
        return;
    }
    const jobId = _nextJobId++;
    job.jobId = jobId;
    job.worker = _slot.worker;
    _slot.busy = true;
    _inFlight.set(jobId, job);
    try {
        _slot.worker.postMessage({
            jobId,
            seqA: job.seqA,
            seqB: job.seqB,
            opts: job.opts,
        });
    } catch {
        _inFlight.delete(jobId);
        _slot.busy = false;
        job.settled = true;
        job.unlistenAbort?.();
        job.resolve(_cancelled());
    }
}

/**
 * Align on a worker thread. Abort (`signal`) terminates the in-flight
 * worker so Stop does not wait for the current pair.
 *
 * @param {Array<{ tSec?: number, phash: string }|string>} seqA
 * @param {Array<{ tSec?: number, phash: string }|string>} seqB
 * @param {{ matchHamming?: number, matchScore?: number, mismatchScore?: number, gapScore?: number, signal?: AbortSignal }} [opts]
 */
export function alignHashSequences(seqA, seqB, opts = {}) {
    const signal = opts.signal;
    if (signal?.aborted) return Promise.resolve(_cancelled());
    const scored = _scoreOpts(opts);
    const a = _norm(seqA);
    const b = _norm(seqB);
    if (!a.length || !b.length) return Promise.resolve(_empty());

    if (DISABLED || !isMainThread) {
        return Promise.resolve(alignHashSequencesSync(a, b, scored));
    }

    _ensureWorker();
    if (!_slot) {
        return Promise.resolve(alignHashSequencesSync(a, b, scored));
    }

    return new Promise((resolve) => {
        const job = {
            seqA: a,
            seqB: b,
            opts: scored,
            signal,
            resolve: (value) => {
                if (job.finished) return;
                job.finished = true;
                resolve(value);
            },
            settled: false,
            jobId: null,
            worker: null,
            unlistenAbort: null,
        };
        if (signal) {
            const onAbort = () => _abortJob(job);
            signal.addEventListener('abort', onAbort, { once: true });
            job.unlistenAbort = () => signal.removeEventListener('abort', onAbort);
        }
        _waiters.push(job);
        _drainWaiters();
    });
}

/**
 * Tear the align worker down. Idempotent. Pending jobs resolve cancelled.
 */
export async function shutdownAlignPool() {
    _shuttingDown = true;
    const slot = _slot;
    _slot = null;
    while (_waiters.length) {
        const job = _waiters.shift();
        job.settled = true;
        job.unlistenAbort?.();
        job.resolve(_cancelled());
    }
    for (const [, pending] of _inFlight) {
        pending.unlistenAbort?.();
        pending.resolve(_cancelled());
    }
    _inFlight.clear();
    if (slot) {
        try {
            await slot.worker.terminate();
        } catch {
            /* already gone */
        }
    }
    _shuttingDown = false;
}
