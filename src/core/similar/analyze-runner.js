/**
 * Similar-clips Analyze. JobTracker contract: `{ onProgress, signal }`.
 *
 * Pipeline: similar whole-videos, then optional partial clips when
 * `checkPartialClips` is set. Partial resume skips clips already in
 * `similar_partial_scans` (same frame_count) or already a remove/review
 * member of a non-ignored partial group.
 */

import {
    deleteSimilarGroupsByKind,
    getVideoFrameHashesForIds,
    insertSimilarGroup,
    listFingerprintsForAnalyze,
    listSimilarGroups,
    listSimilarIgnores,
    listSimilarPartialScans,
    upsertSimilarPartialScan,
} from '../db.js';
import { getSimilarClipsConfig } from './config.js';
import { findSimilarVideoGroups, similarPairKey } from './matcher.js';
import { findPartialClipGroups } from './partial.js';

function _framesById(rows) {
    const map = new Map();
    for (const row of rows || []) {
        const id = Number(row.download_id);
        if (!map.has(id)) map.set(id, []);
        map.get(id).push({ tSec: row.t_sec, phash: row.phash });
    }
    return map;
}

function _pairKeyFromGroup(group) {
    const ids = (group.members || [])
        .map((m) => Number(m.download_id ?? m.downloadId))
        .filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length < 2) return null;
    return similarPairKey(ids[0], ids[1]);
}

function _emptyPartial() {
    return { partialGroups: 0, partialReviewGroups: 0, partialClipsScanned: 0 };
}

export async function analyzeSimilarClips({ onProgress, signal, checkPartialClips } = {}) {
    const cfg = getSimilarClipsConfig();
    const started = Date.now();
    const wantPartial = Boolean(checkPartialClips);

    const emit = (stage, extra = {}) => {
        try {
            onProgress?.({ stage, ...extra });
        } catch {
            /* progress must not abort analyze */
        }
    };

    const done = (extra) => ({
        similarGroups: 0,
        comparedPairs: 0,
        ..._emptyPartial(),
        cancelled: false,
        checkPartialClips: wantPartial,
        partialSkipped: !wantPartial,
        durationMs: Date.now() - started,
        ...extra,
    });

    emit('load');
    const rows = listFingerprintsForAnalyze();
    const videos = rows.map((r) => ({
        id: Number(r.id),
        durationSec: r.duration_sec,
        aggregateHash: r.aggregate_hash,
        fileHash: r.file_hash,
        fileSize: r.file_size,
        fileName: r.file_name,
    }));
    const ignoredSimilar = listSimilarIgnores({ kind: 'similar' }).map((r) =>
        similarPairKey(r.a_id, r.b_id),
    );
    const framesById = _framesById(getVideoFrameHashesForIds(videos.map((v) => v.id)));

    if (signal?.aborted) {
        return done({ cancelled: true, partialSkipped: true });
    }

    const { groups, comparedPairs, cancelled } = await findSimilarVideoGroups(videos, {
        threshold: cfg.similarThreshold,
        durationTolerance: cfg.durationTolerance,
        durationBucketSec: cfg.durationBucketSec,
        ignoredPairs: ignoredSimilar,
        framesById,
        signal,
        onProgress: (p) => emit(p.stage || 'matching', p),
    });

    if (cancelled || signal?.aborted) {
        return done({ comparedPairs, cancelled: true, partialSkipped: true });
    }

    emit('persist', { processed: videos.length, total: videos.length, groups: groups.length });
    deleteSimilarGroupsByKind('similar');
    let similarInserted = 0;
    for (const g of groups) {
        insertSimilarGroup({
            kind: g.kind,
            confidence: g.confidence,
            members: g.members,
        });
        similarInserted++;
    }

    if (!wantPartial) {
        return done({
            similarGroups: similarInserted,
            comparedPairs,
            partialSkipped: true,
        });
    }

    if (signal?.aborted) {
        return done({
            similarGroups: similarInserted,
            comparedPairs,
            cancelled: true,
            partialSkipped: true,
        });
    }

    const existingPartial = [
        ...listSimilarGroups({ kind: 'partial' }),
        ...listSimilarGroups({ kind: 'partial_review' }),
    ];
    const ignoredPartial = [
        ...listSimilarIgnores({ kind: 'partial' }),
        ...listSimilarIgnores({ kind: 'partial_review' }),
    ].map((r) => similarPairKey(r.a_id, r.b_id));
    const ignoredPartialSet = new Set(ignoredPartial);

    const skipDetected = new Set();
    const blockedPairs = new Set(ignoredPartial);
    for (const g of existingPartial) {
        const key = _pairKeyFromGroup(g);
        if (key) blockedPairs.add(key);
        const ignored = key && ignoredPartialSet.has(key);
        if (ignored) continue;
        for (const m of g.members || []) {
            if (m.role === 'remove' || m.role === 'review') {
                skipDetected.add(Number(m.download_id));
            }
        }
    }

    const frameCountById = new Map();
    for (const v of videos) {
        frameCountById.set(v.id, (framesById.get(v.id) || []).length);
    }
    const skipScanned = new Set();
    for (const row of listSimilarPartialScans()) {
        const id = Number(row.download_id);
        if (frameCountById.get(id) === Number(row.frame_count)) skipScanned.add(id);
    }

    const skipClipIds = new Set([...skipDetected, ...skipScanned]);
    let partialGroups = 0;
    let partialReviewGroups = 0;

    emit('partial', { processed: 0, total: videos.length, skipped: skipClipIds.size });
    const partialResult = await findPartialClipGroups(videos, {
        matchRatio: cfg.partialMatchRatio,
        frameThreshold: cfg.partialFrameThreshold,
        durationBucketSec: cfg.durationBucketSec,
        shortClipSec: cfg.partialShortClipSec,
        shortMatchRatio: cfg.partialShortMatchRatio,
        reviewMatchRatio: cfg.partialReviewMatchRatio,
        reviewMinMatchedFrames: cfg.partialReviewMinMatchedFrames,
        ignoredPairs: ignoredPartial,
        blockedPairs,
        skipClipIds,
        framesById,
        signal,
        onProgress: (p) => emit(p.stage || 'partial', p),
        onClipComplete: (clip, clipGroups, frameCount) => {
            for (const g of clipGroups) {
                insertSimilarGroup({
                    kind: g.kind,
                    confidence: g.confidence,
                    offsetSec: g.offsetSec,
                    members: g.members,
                });
                if (g.kind === 'partial_review') partialReviewGroups++;
                else partialGroups++;
            }
            upsertSimilarPartialScan({
                downloadId: clip.id,
                frameCount,
            });
        },
    });

    return done({
        similarGroups: similarInserted,
        comparedPairs,
        partialGroups,
        partialReviewGroups,
        partialClipsScanned: partialResult.clipsScanned,
        cancelled: Boolean(partialResult.cancelled || signal?.aborted),
        partialSkipped: false,
    });
}
