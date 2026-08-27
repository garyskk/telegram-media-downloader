/**
 * Similar-clips Analyze. JobTracker contract: `{ onProgress, signal }`.
 *
 * Rebuilds `kind='similar'` groups from fingerprints. Partial matching
 * (`checkPartialClips`) is a no-op until Phase 5.
 */

import {
    deleteSimilarGroupsByKind,
    getVideoFrameHashesForIds,
    insertSimilarGroup,
    listFingerprintsForAnalyze,
    listSimilarIgnores,
} from '../db.js';
import { getSimilarClipsConfig } from './config.js';
import { findSimilarVideoGroups, similarPairKey } from './matcher.js';

function _framesById(rows) {
    const map = new Map();
    for (const row of rows || []) {
        const id = Number(row.download_id);
        if (!map.has(id)) map.set(id, []);
        map.get(id).push({ tSec: row.t_sec, phash: row.phash });
    }
    return map;
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
    const ignoredPairs = listSimilarIgnores({ kind: 'similar' }).map((r) =>
        similarPairKey(r.a_id, r.b_id),
    );
    const framesById = _framesById(getVideoFrameHashesForIds(videos.map((v) => v.id)));

    if (signal?.aborted) {
        return {
            similarGroups: 0,
            comparedPairs: 0,
            cancelled: true,
            checkPartialClips: wantPartial,
            partialSkipped: wantPartial,
            durationMs: Date.now() - started,
        };
    }

    const { groups, comparedPairs, cancelled } = await findSimilarVideoGroups(videos, {
        threshold: cfg.similarThreshold,
        durationTolerance: cfg.durationTolerance,
        durationBucketSec: cfg.durationBucketSec,
        ignoredPairs,
        framesById,
        signal,
        onProgress: (p) => emit(p.stage || 'matching', p),
    });

    if (cancelled || signal?.aborted) {
        return {
            similarGroups: 0,
            comparedPairs,
            cancelled: true,
            checkPartialClips: wantPartial,
            partialSkipped: wantPartial,
            durationMs: Date.now() - started,
        };
    }

    emit('persist', { processed: videos.length, total: videos.length, groups: groups.length });
    deleteSimilarGroupsByKind('similar');
    let inserted = 0;
    for (const g of groups) {
        insertSimilarGroup({
            kind: g.kind,
            confidence: g.confidence,
            members: g.members,
        });
        inserted++;
    }

    return {
        similarGroups: inserted,
        comparedPairs,
        cancelled: false,
        checkPartialClips: wantPartial,
        partialSkipped: wantPartial,
        durationMs: Date.now() - started,
    };
}
