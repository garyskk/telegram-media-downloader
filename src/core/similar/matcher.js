/**
 * Similar-video matcher using Smith-Waterman over hash sequences.
 *
 * Similar = duration within ±tolerance, coverage of both sequences
 * ≥ minCoverage, and mean aligned Hamming ≤ similarThreshold. Cheap
 * pair filter: 120 s duration buckets (±1 neighbour) plus a loose
 * aggregate_hash Hamming gate. Exact SHA-256 pairs and similar_ignores
 * are skipped.
 */

import { hammingHex } from '../phash.js';
import { alignHashSequences } from './align.js';

const AGGREGATE_GATE_MIN = 64;
const DEFAULT_MIN_COVERAGE = 0.7;

export function durationsWithinTolerance(left, right, tolerance = 0.1) {
    if (left == null || right == null) return false;
    const a = Number(left);
    const b = Number(right);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const longer = Math.max(a, b);
    if (longer === 0) return a === b;
    return Math.abs(a - b) / longer <= Number(tolerance);
}

export function durationBucket(durationSec, bucketSec) {
    const d = Number(durationSec);
    const w = Number(bucketSec);
    if (!Number.isFinite(d) || d < 0 || !Number.isFinite(w) || w <= 0) return 0;
    return Math.floor(d / w);
}

export function similarPairKey(aId, bId) {
    const a = Number(aId);
    const b = Number(bId);
    return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function _hashBits(frames) {
    const hex = String(frames?.[0]?.phash || frames?.[0] || '');
    return hex.length >= 64 ? 256 : 64;
}

function _aggregateTooFar(aggA, aggB, threshold) {
    if (!aggA || !aggB) return false;
    try {
        const cap = Math.max(AGGREGATE_GATE_MIN, Number(threshold) * 4);
        return hammingHex(String(aggA), String(aggB)) > cap;
    } catch {
        return false;
    }
}

function _pickKeep(left, right) {
    const ls = Number(left.fileSize) || 0;
    const rs = Number(right.fileSize) || 0;
    if (ls !== rs) return ls > rs ? left : right;
    return Number(left.id) < Number(right.id) ? left : right;
}

/**
 * Pairwise similar-video groups. Each video is compared only to
 * earlier ids (2 vs 1, 3 vs 1–2, …). `skipLeftIds` resumes by not
 * re-comparing videos that already finished that pass.
 * `ignoredPairs` / `existingPairKeys` are `"minId:maxId"` strings.
 */
export async function findSimilarVideoGroups(videos, opts = {}) {
    const threshold = Number(opts.threshold);
    const maxHamming = Number.isFinite(threshold) && threshold >= 0 ? threshold : 50;
    const durationTolerance = opts.durationTolerance ?? 0.1;
    const durationBucketSec = Number(opts.durationBucketSec) || 120;
    const minCoverage = Number.isFinite(Number(opts.minCoverage))
        ? Number(opts.minCoverage)
        : DEFAULT_MIN_COVERAGE;
    const ignored = new Set(opts.ignoredPairs || []);
    const framesById = opts.framesById instanceof Map ? opts.framesById : new Map();
    const signal = opts.signal;
    const onProgress = opts.onProgress;

    const list = (Array.isArray(videos) ? videos : [])
        .filter((v) => v && v.id != null)
        .sort((a, b) => Number(a.id) - Number(b.id) || 0);
    const skipLeft = new Set([...(opts.skipLeftIds || [])].map(Number));
    const existingPairs = new Set(opts.existingPairKeys || []);
    const onLeftComplete = opts.onLeftComplete;
    const buckets = new Map();
    for (const v of list) {
        const b = durationBucket(v.durationSec, durationBucketSec);
        if (!buckets.has(b)) buckets.set(b, []);
        buckets.get(b).push(v);
    }

    const groups = [];
    let comparedPairs = 0;
    let processed = 0;
    const pending = list.filter((v) => !skipLeft.has(Number(v.id)));
    try {
        onProgress?.({
            stage: 'matching',
            processed: 0,
            total: pending.length,
            skipped: skipLeft.size,
            comparedPairs: 0,
            groups: 0,
        });
    } catch {
        /* progress must not abort matching */
    }

    for (const left of pending) {
        if (signal?.aborted) {
            return { groups, comparedPairs, cancelled: true };
        }
        const b0 = durationBucket(left.durationSec, durationBucketSec);
        const neighbors = [
            ...(buckets.get(b0 - 1) || []),
            ...(buckets.get(b0) || []),
            ...(buckets.get(b0 + 1) || []),
        ];
        const newGroups = [];
        for (const right of neighbors) {
            if (Number(right.id) >= Number(left.id)) continue;
            const key = similarPairKey(left.id, right.id);
            if (ignored.has(key) || existingPairs.has(key)) continue;
            comparedPairs++;
            if (signal?.aborted) {
                return { groups, comparedPairs, cancelled: true };
            }
            await new Promise((r) => setImmediate(r));

            const hashA = left.fileHash;
            const hashB = right.fileHash;
            if (hashA && hashB && String(hashA) === String(hashB)) continue;
            if (!durationsWithinTolerance(left.durationSec, right.durationSec, durationTolerance)) {
                continue;
            }
            const framesA = framesById.get(left.id);
            const framesB = framesById.get(right.id);
            // Extra/missing scenes (bumpers) change the XOR a lot; only
            // use the cheap gate when both sequences have the same length.
            if (
                Array.isArray(framesA) &&
                Array.isArray(framesB) &&
                framesA.length === framesB.length &&
                _aggregateTooFar(left.aggregateHash, right.aggregateHash, maxHamming)
            ) {
                continue;
            }

            const aligned = await alignHashSequences(framesA, framesB, {
                matchHamming: maxHamming,
                signal,
            });
            if (aligned.cancelled || signal?.aborted) {
                return { groups, comparedPairs, cancelled: true };
            }
            if (aligned.coverageA < minCoverage || aligned.coverageB < minCoverage) continue;
            const mean = aligned.meanHamming;
            if (!Number.isFinite(mean) || mean > maxHamming) continue;

            const keep = _pickKeep(left, right);
            const remove = keep === left ? right : left;
            const bits = _hashBits(framesA || framesB);
            const group = {
                kind: 'similar',
                confidence: Math.max(0, 1 - mean / bits),
                meanHamming: mean,
                members: [
                    {
                        downloadId: keep.id,
                        role: 'keep',
                        reason: `similar video; larger file (${Number(keep.fileSize) || 0} bytes)`,
                    },
                    {
                        downloadId: remove.id,
                        role: 'remove',
                        reason: `similar video; mean hamming ${mean.toFixed(2)}; smaller file (${Number(remove.fileSize) || 0} bytes)`,
                    },
                ],
            };
            newGroups.push(group);
            groups.push(group);
            existingPairs.add(key);
        }
        processed++;
        try {
            await onLeftComplete?.(left, newGroups);
        } catch {
            /* persist must not abort matching */
        }
        try {
            onProgress?.({
                stage: 'matching',
                processed,
                total: pending.length,
                skipped: skipLeft.size,
                comparedPairs,
                groups: groups.length,
            });
        } catch {
            /* progress must not abort matching */
        }
    }

    return { groups, comparedPairs, cancelled: false };
}
