/**
 * Smith-Waterman local alignment of perceptual-hash sequences.
 *
 * Substitution is Hamming (match if ≤ matchHamming). Gaps cover extra
 * bumpers and a skipped scene. Callers decide similar vs partial from
 * coverageA/coverageB/coverageShort and duration gates.
 */

import { hammingHex } from '../phash.js';

const DIR_STOP = 0;
const DIR_DIAG = 1;
const DIR_UP = 2;
const DIR_LEFT = 3;

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

function _hamming(a, b) {
    if (!a || !b) return Infinity;
    try {
        return hammingHex(a, b);
    } catch {
        return Infinity;
    }
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

/**
 * @param {Array<{ tSec?: number, phash: string }|string>} seqA
 * @param {Array<{ tSec?: number, phash: string }|string>} seqB
 * @param {{ matchHamming?: number, matchScore?: number, mismatchScore?: number, gapScore?: number }} [opts]
 */
export async function alignHashSequences(seqA, seqB, opts = {}) {
    const matchHamming = Number.isFinite(Number(opts.matchHamming)) ? Number(opts.matchHamming) : 50;
    const matchScore = Number.isFinite(Number(opts.matchScore)) ? Number(opts.matchScore) : 2;
    const mismatchScore = Number.isFinite(Number(opts.mismatchScore)) ? Number(opts.mismatchScore) : -1;
    const gapScore = Number.isFinite(Number(opts.gapScore)) ? Number(opts.gapScore) : -1;
    const signal = opts.signal;

    const a = _norm(seqA);
    const b = _norm(seqB);
    const n = a.length;
    const m = b.length;
    if (!n || !m) return _empty();
    if (signal?.aborted) return { ..._empty(), cancelled: true };

    const cols = m + 1;
    const H = new Float64Array((n + 1) * cols);
    const P = new Uint8Array((n + 1) * cols);
    let best = 0;
    let bestI = 0;
    let bestJ = 0;
    const yieldEvery = Math.max(8, Number(opts.yieldEveryRows) || 24);

    for (let i = 1; i <= n; i++) {
        if (signal && (i === 1 || i % yieldEvery === 0)) {
            if (signal.aborted) return { ..._empty(), cancelled: true };
            await new Promise((r) => setImmediate(r));
        }
        const row = i * cols;
        const prev = (i - 1) * cols;
        for (let j = 1; j <= m; j++) {
            const ham = _hamming(a[i - 1].phash, b[j - 1].phash);
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
                hamming: _hamming(a[i - 1].phash, b[j - 1].phash),
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
