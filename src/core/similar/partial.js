/**
 * Partial-clip matcher: shorter scene sequence aligned inside a
 * same-or-longer parent (Smith-Waterman). Confirmed vs partial_review
 * bands.
 *
 * Parent lookup is duration-sorted (same length or longer), not the
 * similar-video ±1 bucket gate — a 10 s clip must still see a 250 s
 * parent. Incremental Analyze also treats a new video as a parent
 * against already-scanned shorter clips (BCD then ABCDEF). Exact
 * SHA-256 pairs and similar_ignores are skipped.
 */

import { alignHashSequences } from './align.js';
import { durationBucket, durationsWithinTolerance, similarPairKey } from './matcher.js';

const YIELD_EVERY_PARENTS = 50;
export const PARTIAL_MIN_CLIP_FRAMES = 4;

export function effectivePartialMatchRatio(
    clipDurationSec,
    { matchRatio = 0.5, shortClipSec = 300, shortMatchRatio = 0.5 } = {},
) {
    const d = Number(clipDurationSec);
    if (Number.isFinite(d) && d <= Number(shortClipSec)) return Number(shortMatchRatio);
    return Number(matchRatio);
}

/**
 * Best local alignment of clip hashes inside parent hashes.
 * `ratio` is coverage of the clip (shorter) sequence.
 * @returns {{ ratio: number, startIndex: number, matched: number, offsetSec: number }}
 */
export async function bestSubsequenceMatch(
    clipHashes,
    parentHashes,
    { frameThreshold = 90, signal } = {},
) {
    const clip = Array.isArray(clipHashes) ? clipHashes : [];
    const parent = Array.isArray(parentHashes) ? parentHashes : [];
    if (!clip.length || !parent.length || clip.length > parent.length) {
        return { ratio: 0, startIndex: 0, matched: 0, offsetSec: 0 };
    }
    const cap = Number.isFinite(Number(frameThreshold)) ? Number(frameThreshold) : 90;
    const r = await alignHashSequences(clip, parent, { matchHamming: cap, signal });
    if (r.cancelled) {
        return { ratio: 0, startIndex: 0, matched: 0, offsetSec: 0, cancelled: true };
    }
    return {
        ratio: r.coverageA,
        startIndex: Math.max(0, r.startIndexB),
        matched: r.matched,
        offsetSec: r.offsetBSec == null ? 0 : r.offsetBSec,
    };
}

export function iterParentCandidates(
    clip,
    sortedVideos,
    { durationBucketSec = 120, minParentRatio = 1 } = {},
) {
    if (clip?.id == null || clip.durationSec == null) return [];
    const minDur = Number(clip.durationSec) * Number(minParentRatio || 1);
    if (!Number.isFinite(minDur)) return [];
    const minBucket = durationBucket(minDur, durationBucketSec);
    const list = Array.isArray(sortedVideos) ? sortedVideos : [];
    let start = 0;
    while (start < list.length && Number(list[start].durationSec) + 1e-9 < minDur) start++;
    const out = [];
    for (let i = start; i < list.length; i++) {
        const parent = list[i];
        if (parent.id == null || Number(parent.id) === Number(clip.id)) continue;
        if (parent.durationSec == null) continue;
        if (durationBucket(parent.durationSec, durationBucketSec) < minBucket) continue;
        out.push(parent);
    }
    return out;
}

function _pickKeepRemove(clip, parent) {
    if (durationsWithinTolerance(clip.durationSec, parent.durationSec)) {
        const cs = Number(clip.fileSize) || 0;
        const ps = Number(parent.fileSize) || 0;
        if (cs !== ps) return cs > ps ? [clip, parent] : [parent, clip];
        return Number(clip.id) < Number(parent.id) ? [clip, parent] : [parent, clip];
    }
    return Number(clip.durationSec) >= Number(parent.durationSec) ? [clip, parent] : [parent, clip];
}

function _isStrictlyLonger(parent, clip) {
    return Number(parent.durationSec) > Number(clip.durationSec) + 1e-9;
}

function _proposal({ clip, parent, kind, ratio, matched, clipFrameCount, offsetSec }) {
    const [keep, remove] = _pickKeepRemove(clip, parent);
    const sameLength = durationsWithinTolerance(clip.durationSec, parent.durationSec);
    const offsetNote = `offset ${Number(offsetSec).toFixed(1)}s`;
    let keepReason;
    let removeReason;
    if (sameLength) {
        keepReason = `same-length re-encode; matched ${matched}/${clipFrameCount} frames (${offsetNote})`;
        removeReason = `re-encoded copy of ${keep.fileName || keep.id}; match ratio ${(ratio * 100).toFixed(0)}% (${offsetNote})`;
    } else if (kind === 'partial_review') {
        keepReason = `possible parent; matched ${matched}/${clipFrameCount} frames from ${offsetNote} (below auto-remove threshold)`;
        removeReason = `possible clip of ${keep.fileName || keep.id}; match ratio ${(ratio * 100).toFixed(0)}% at ${offsetNote} — manual review`;
    } else {
        keepReason = `contains clip; matched ${matched}/${clipFrameCount} frames from ${offsetNote}`;
        removeReason = `partial clip of ${keep.fileName || keep.id}; match ratio ${(ratio * 100).toFixed(0)}% at ${offsetNote}`;
    }
    const removeRole = kind === 'partial_review' ? 'review' : 'remove';
    return {
        kind,
        confidence: ratio,
        offsetSec: Number(offsetSec) || 0,
        meanHamming: null,
        members: [
            { downloadId: keep.id, role: 'keep', reason: keepReason },
            { downloadId: remove.id, role: removeRole, reason: removeReason },
        ],
    };
}

async function _matchClipAgainstParents(clip, parents, ctx) {
    const {
        framesById,
        ignored,
        blocked,
        durationTolerance,
        frameThreshold,
        signal,
        reviewMinMatchedFrames,
        matchRatio,
        shortClipSec,
        shortMatchRatio,
        reviewMatchRatio,
    } = ctx;
    const clipFrames = framesById.get(clip.id) || [];
    const requiredRatio = effectivePartialMatchRatio(clip.durationSec, {
        matchRatio,
        shortClipSec,
        shortMatchRatio,
    });
    const clipGroups = [];
    let bestReview = null;
    let compared = 0;

    for (const parent of parents) {
        const key = similarPairKey(clip.id, parent.id);
        if (ignored.has(key) || blocked.has(key)) continue;
        const hashA = clip.fileHash;
        const hashB = parent.fileHash;
        if (hashA && hashB && String(hashA) === String(hashB)) continue;
        if (durationsWithinTolerance(clip.durationSec, parent.durationSec, durationTolerance)) {
            continue;
        }

        compared++;
        if (compared % YIELD_EVERY_PARENTS === 0) {
            if (signal?.aborted) {
                return { clipGroups, clipFrames, cancelled: true };
            }
            await new Promise((r) => setImmediate(r));
        }

        const parentFrames = framesById.get(parent.id) || [];
        if (clipFrames.length > parentFrames.length) continue;

        const {
            ratio,
            startIndex,
            matched,
            offsetSec: alignedOffset,
            cancelled: alignCancelled,
        } = await bestSubsequenceMatch(clipFrames, parentFrames, { frameThreshold, signal });
        if (alignCancelled || signal?.aborted) {
            return { clipGroups, clipFrames, cancelled: true };
        }
        const offsetSec = Number.isFinite(alignedOffset)
            ? alignedOffset
            : (parentFrames[startIndex]?.tSec ?? startIndex);
        if (matched < reviewMinMatchedFrames) continue;
        if (ratio >= requiredRatio) {
            clipGroups.push(
                _proposal({
                    clip,
                    parent,
                    kind: 'partial',
                    ratio,
                    matched,
                    clipFrameCount: clipFrames.length,
                    offsetSec,
                }),
            );
            blocked.add(key);
            continue;
        }
        if (ratio < reviewMatchRatio) continue;
        if (!bestReview || ratio > bestReview.ratio) {
            bestReview = { parent, ratio, startIndex, matched, offsetSec };
        }
    }

    if (!clipGroups.length && bestReview) {
        const key = similarPairKey(clip.id, bestReview.parent.id);
        if (!ignored.has(key) && !blocked.has(key)) {
            clipGroups.push(
                _proposal({
                    clip,
                    parent: bestReview.parent,
                    kind: 'partial_review',
                    ratio: bestReview.ratio,
                    matched: bestReview.matched,
                    clipFrameCount: clipFrames.length,
                    offsetSec: bestReview.offsetSec,
                }),
            );
            blocked.add(key);
        }
    }

    return { clipGroups, clipFrames, cancelled: false };
}

/**
 * Pairwise partial / partial_review groups.
 * `ignoredPairs` is `"minId:maxId"` strings. `skipClipIds` skips already
 * scanned or already-grouped clips as *clips* (resume). A later longer
 * parent still rechecks those scanned clips unless they are in
 * `skipDetectedIds` (already grouped as remove/review).
 */
export async function findPartialClipGroups(videos, opts = {}) {
    const matchRatio = opts.matchRatio ?? 0.5;
    const frameThreshold = opts.frameThreshold ?? 90;
    const durationBucketSec = Number(opts.durationBucketSec) || 120;
    const durationTolerance = opts.durationTolerance ?? 0.1;
    const shortClipSec = opts.shortClipSec ?? 300;
    const shortMatchRatio = opts.shortMatchRatio ?? 0.5;
    const reviewMatchRatio = opts.reviewMatchRatio ?? 0.35;
    const reviewMinMatchedFrames = opts.reviewMinMatchedFrames ?? 4;
    const minClipFrames = Math.max(2, Number(opts.minClipFrames) || PARTIAL_MIN_CLIP_FRAMES);
    const minParentRatio = opts.minParentRatio ?? 1;
    const ignored = new Set(opts.ignoredPairs || []);
    const skipClipIds = new Set([...(opts.skipClipIds || [])].map(Number));
    const skipDetectedIds = new Set([...(opts.skipDetectedIds || [])].map(Number));
    const framesById = opts.framesById instanceof Map ? opts.framesById : new Map();
    const blocked = new Set(opts.blockedPairs || []);
    const signal = opts.signal;
    const onProgress = opts.onProgress;
    const onClipComplete = opts.onClipComplete;

    const list = (Array.isArray(videos) ? videos : []).filter(
        (v) => v && v.id != null && v.durationSec != null,
    );
    const sortedVideos = [...list].sort(
        (a, b) => Number(a.durationSec) - Number(b.durationSec) || Number(a.id) - Number(b.id),
    );
    const clips = list.filter((v) => (framesById.get(v.id) || []).length >= minClipFrames);

    const groups = [];
    let clipsScanned = 0;
    let processed = 0;
    const pending = clips.filter((v) => !skipClipIds.has(Number(v.id)));
    const pendingIds = new Set(pending.map((v) => Number(v.id)));
    const recheckClips = clips.filter((clip) => {
        const id = Number(clip.id);
        if (!skipClipIds.has(id) || skipDetectedIds.has(id)) return false;
        return pending.some((p) => _isStrictlyLonger(p, clip));
    });
    const total = pending.length + recheckClips.length;
    const skipped = skipClipIds.size;
    const matchCtx = {
        framesById,
        ignored,
        blocked,
        durationTolerance,
        frameThreshold,
        signal,
        reviewMinMatchedFrames,
        matchRatio,
        shortClipSec,
        shortMatchRatio,
        reviewMatchRatio,
    };

    const emitProgress = () => {
        try {
            onProgress?.({
                stage: 'partial',
                processed,
                total,
                skipped,
                clipsScanned,
                groups: groups.length,
            });
        } catch {
            /* progress must not abort matching */
        }
    };

    const finishClip = async (clip, clipGroups, clipFrames, { markScanned } = {}) => {
        for (const g of clipGroups) groups.push(g);
        clipsScanned++;
        if (markScanned) skipClipIds.add(Number(clip.id));
        try {
            onClipComplete?.(clip, clipGroups, clipFrames.length);
        } catch {
            /* persist must not abort matching */
        }
        processed++;
        emitProgress();
        await new Promise((r) => setImmediate(r));
    };

    try {
        onProgress?.({
            stage: 'partial',
            processed: 0,
            total,
            skipped,
            groups: 0,
        });
    } catch {
        /* progress must not abort matching */
    }

    // New/stale videos as parents vs already-scanned shorter clips.
    for (const clip of recheckClips) {
        if (signal?.aborted) {
            return { groups, clipsScanned, cancelled: true };
        }
        const parents = iterParentCandidates(clip, sortedVideos, {
            durationBucketSec,
            minParentRatio,
        }).filter((p) => pendingIds.has(Number(p.id)) && _isStrictlyLonger(p, clip));
        const { clipGroups, clipFrames, cancelled } = await _matchClipAgainstParents(
            clip,
            parents,
            matchCtx,
        );
        if (cancelled || signal?.aborted) {
            return { groups, clipsScanned, cancelled: true };
        }
        await finishClip(clip, clipGroups, clipFrames, { markScanned: false });
    }

    for (const clip of pending) {
        if (signal?.aborted) {
            return { groups, clipsScanned, cancelled: true };
        }
        const parents = iterParentCandidates(clip, sortedVideos, {
            durationBucketSec,
            minParentRatio,
        });
        const { clipGroups, clipFrames, cancelled } = await _matchClipAgainstParents(
            clip,
            parents,
            matchCtx,
        );
        if (cancelled || signal?.aborted) {
            return { groups, clipsScanned, cancelled: true };
        }
        await finishClip(clip, clipGroups, clipFrames, { markScanned: true });
    }

    return { groups, clipsScanned, cancelled: false };
}
