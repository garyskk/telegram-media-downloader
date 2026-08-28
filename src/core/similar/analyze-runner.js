/**
 * Similar-clips Analyze. JobTracker contract: `{ onProgress, signal }`.
 *
 * Similar matching is incremental: video N is compared only to 1..N-1
 * (by download id). Finished videos are stored in `similar_video_scans`
 * so a later Analyze only processes new/stale fingerprints. Stop keeps
 * those cursors and groups already written.
 *
 * Partial clips still use `similar_partial_scans` resume.
 */

import {
    deleteSimilarGroupsByKind,
    deleteSimilarGroupsForDownload,
    deleteSimilarVideoScans,
    getVideoFrameHashesForIds,
    insertSimilarGroup,
    listFingerprintsForAnalyze,
    listSimilarGroups,
    listSimilarIgnores,
    listSimilarPartialScans,
    listSimilarVideoScans,
    upsertSimilarPartialScan,
    upsertSimilarVideoScan,
} from '../db.js';
import { FINGERPRINT_ALGO, getSimilarClipsConfig, similarAnalyzeConfigKey } from './config.js';
import { durationBucket, findSimilarVideoGroups, similarPairKey } from './matcher.js';
import { findPartialClipGroups, PARTIAL_MIN_CLIP_FRAMES } from './partial.js';

function _framesById(rows) {
    const map = new Map();
    for (const row of rows || []) {
        const id = Number(row.download_id);
        if (!map.has(id)) map.set(id, []);
        map.get(id).push({ tSec: row.t_sec, phash: row.phash });
    }
    return map;
}

function _yield() {
    return new Promise((r) => setImmediate(r));
}

const HASH_ID_CHUNK = 16;

async function _mergeFrames(framesById, ids, { signal } = {}) {
    const missing = [...new Set((ids || []).map(Number))].filter(
        (id) => Number.isInteger(id) && id > 0 && !framesById.has(id),
    );
    if (!missing.length) return framesById;
    for (let i = 0; i < missing.length; i += HASH_ID_CHUNK) {
        if (signal?.aborted) return framesById;
        const extra = _framesById(getVideoFrameHashesForIds(missing.slice(i, i + HASH_ID_CHUNK)));
        for (const [id, frames] of extra) framesById.set(id, frames);
        await _yield();
    }
    return framesById;
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

function _scanIsCurrent(scan, video, configKey) {
    if (!scan || !video) return false;
    if (String(scan.config_key) !== String(configKey)) return false;
    if (String(scan.algo || '') !== FINGERPRINT_ALGO) return false;
    if (Number(scan.frame_count) !== Number(video.frameCount)) return false;
    const sh = scan.file_hash == null ? '' : String(scan.file_hash);
    const vh = video.fileHash == null ? '' : String(video.fileHash);
    return sh === vh;
}

function _similarHashIds(videos, skipLeftIds, durationBucketSec) {
    const pending = videos.filter((v) => !skipLeftIds.has(Number(v.id)));
    if (!pending.length) return [];
    const buckets = new Map();
    for (const v of videos) {
        const b = durationBucket(v.durationSec, durationBucketSec);
        if (!buckets.has(b)) buckets.set(b, []);
        buckets.get(b).push(v);
    }
    const ids = new Set();
    for (const left of pending) {
        ids.add(Number(left.id));
        const b0 = durationBucket(left.durationSec, durationBucketSec);
        for (const right of [
            ...(buckets.get(b0 - 1) || []),
            ...(buckets.get(b0) || []),
            ...(buckets.get(b0 + 1) || []),
        ]) {
            if (Number(right.id) < Number(left.id)) ids.add(Number(right.id));
        }
    }
    return [...ids];
}

function _partialHashIds(videos, skipClipIds) {
    const pending = videos.filter((v) => !skipClipIds.has(Number(v.id)));
    if (!pending.length) return [];
    const ids = new Set();
    for (const clip of pending) {
        ids.add(Number(clip.id));
        const clipDur = Number(clip.durationSec);
        for (const parent of videos) {
            if (Number(parent.id) === Number(clip.id)) continue;
            if (Number(parent.durationSec) + 1e-9 >= clipDur) ids.add(Number(parent.id));
        }
    }
    return [...ids];
}

export async function analyzeSimilarClips({ onProgress, signal, checkPartialClips } = {}) {
    const cfg = getSimilarClipsConfig();
    const configKey = similarAnalyzeConfigKey(cfg);
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
        skipped: 0,
        upToDate: false,
        ..._emptyPartial(),
        cancelled: false,
        checkPartialClips: wantPartial,
        partialSkipped: !wantPartial,
        durationMs: Date.now() - started,
        ...extra,
    });

    const rows = listFingerprintsForAnalyze();
    const videos = rows.map((r) => ({
        id: Number(r.id),
        durationSec: r.duration_sec,
        aggregateHash: r.aggregate_hash,
        frameCount: Number(r.frame_count) || 0,
        algo: r.algo,
        fileHash: r.file_hash,
        fileSize: r.file_size,
        fileName: r.file_name,
    }));
    const ignoredSimilar = listSimilarIgnores({ kind: 'similar' }).map((r) =>
        similarPairKey(r.a_id, r.b_id),
    );

    if (signal?.aborted) {
        return done({ cancelled: true, partialSkipped: true });
    }

    const byId = new Map(videos.map((v) => [v.id, v]));
    const scans = listSimilarVideoScans();
    const configChanged = scans.some((s) => String(s.config_key) !== configKey);
    if (configChanged) {
        deleteSimilarVideoScans();
        deleteSimilarGroupsByKind('similar');
    }
    const skipLeftIds = new Set();
    if (!configChanged) {
        for (const scan of scans) {
            const id = Number(scan.download_id);
            const video = byId.get(id);
            if (_scanIsCurrent(scan, video, configKey)) {
                skipLeftIds.add(id);
            } else {
                deleteSimilarGroupsForDownload(id);
            }
        }
    }

    const pendingSimilar = videos.length - skipLeftIds.size;
    const existingSimilar = listSimilarGroups({ kind: 'similar' });
    if (pendingSimilar > 0 || !wantPartial) {
        emit('matching', {
            processed: 0,
            total: pendingSimilar,
            skipped: skipLeftIds.size,
            groups: existingSimilar.length,
            comparedPairs: 0,
        });
        await _yield();
    }

    const existingPairKeys = [];
    for (const g of existingSimilar) {
        const key = _pairKeyFromGroup(g);
        if (key) existingPairKeys.push(key);
    }

    const framesById = new Map();
    let similarInserted = 0;
    let comparedPairs = 0;
    let cancelled = false;

    if (pendingSimilar > 0) {
        await _mergeFrames(
            framesById,
            _similarHashIds(videos, skipLeftIds, cfg.durationBucketSec),
            { signal },
        );
        const matched = await findSimilarVideoGroups(videos, {
            threshold: cfg.similarThreshold,
            durationTolerance: cfg.durationTolerance,
            durationBucketSec: cfg.durationBucketSec,
            ignoredPairs: ignoredSimilar,
            existingPairKeys,
            skipLeftIds,
            framesById,
            signal,
            onProgress: (p) =>
                emit(p.stage || 'matching', { skipped: skipLeftIds.size, ...p }),
            onLeftComplete: (left, newGroups) => {
                for (const g of newGroups || []) {
                    insertSimilarGroup({
                        kind: g.kind,
                        confidence: g.confidence,
                        members: g.members,
                    });
                    similarInserted++;
                }
                upsertSimilarVideoScan({
                    downloadId: left.id,
                    fileHash: left.fileHash,
                    frameCount: (framesById.get(left.id) || []).length || left.frameCount,
                    algo: FINGERPRINT_ALGO,
                    configKey,
                });
            },
        });
        comparedPairs = matched.comparedPairs;
        cancelled = matched.cancelled;
    }

    if (cancelled || signal?.aborted) {
        return done({
            similarGroups: similarInserted,
            comparedPairs,
            skipped: skipLeftIds.size,
            cancelled: true,
            partialSkipped: true,
        });
    }

    if (!wantPartial) {
        return done({
            similarGroups: similarInserted,
            comparedPairs,
            skipped: skipLeftIds.size,
            upToDate: pendingSimilar === 0,
            partialSkipped: true,
        });
    }

    if (signal?.aborted) {
        return done({
            similarGroups: similarInserted,
            comparedPairs,
            skipped: skipLeftIds.size,
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

    const skipScanned = new Set();
    for (const row of listSimilarPartialScans()) {
        const id = Number(row.download_id);
        const video = byId.get(id);
        if (video && Number(video.frameCount) === Number(row.frame_count)) skipScanned.add(id);
    }

    const skipClipIds = new Set([...skipDetected, ...skipScanned]);
    const skippedPartial = skipClipIds.size;
    const pendingPartial = videos.filter(
        (v) => !skipClipIds.has(Number(v.id)) && Number(v.frameCount) >= PARTIAL_MIN_CLIP_FRAMES,
    ).length;
    let partialGroups = 0;
    let partialReviewGroups = 0;

    emit('partial', {
        processed: 0,
        total: pendingPartial,
        skipped: skippedPartial,
        groups: existingPartial.length,
    });
    await _yield();

    if (pendingPartial === 0) {
        return done({
            similarGroups: similarInserted,
            comparedPairs,
            skipped: skipLeftIds.size,
            upToDate: pendingSimilar === 0,
            partialSkipped: false,
        });
    }

    await _mergeFrames(framesById, _partialHashIds(videos, skipClipIds), { signal });
    const partialResult = await findPartialClipGroups(videos, {
        matchRatio: cfg.partialMatchRatio,
        frameThreshold: cfg.partialFrameThreshold,
        durationBucketSec: cfg.durationBucketSec,
        durationTolerance: cfg.durationTolerance,
        shortClipSec: cfg.partialShortClipSec,
        shortMatchRatio: cfg.partialShortMatchRatio,
        reviewMatchRatio: cfg.partialReviewMatchRatio,
        reviewMinMatchedFrames: cfg.partialReviewMinMatchedFrames,
        ignoredPairs: ignoredPartial,
        blockedPairs,
        skipClipIds,
        framesById,
        signal,
        onProgress: (p) => emit(p.stage || 'partial', { skipped: skippedPartial, ...p }),
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
        skipped: skipLeftIds.size,
        upToDate: pendingSimilar === 0 && pendingPartial === 0,
        partialGroups,
        partialReviewGroups,
        partialClipsScanned: partialResult.clipsScanned,
        cancelled: Boolean(partialResult.cancelled || signal?.aborted),
        partialSkipped: false,
    });
}
