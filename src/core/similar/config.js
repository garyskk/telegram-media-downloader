/**
 * similarClips config: TGDL_SIMILAR_* env > kv `advanced.similarClips` > defaults.
 * Empty env is ignored so compose must not inject `:-0` pins.
 * Sampling is scene-or-floor (`sceneThreshold` / `floorIntervalSec`).
 */

import { loadConfig } from '../../config/manager.js';

export const FINGERPRINT_ALGO = 'pdq-scene-v1';

export const SIMILAR_CLIPS_DEFAULTS = Object.freeze({
    similarThreshold: 50,
    durationTolerance: 0.1,
    partialMatchRatio: 0.5,
    partialFrameThreshold: 90,
    partialShortClipSec: 300,
    partialShortMatchRatio: 0.35,
    partialReviewMatchRatio: 0.1,
    partialReviewMinMatchedFrames: 2,
    fingerprintMaxFrames: 7200,
    fingerprintTilePx: 64,
    durationBucketSec: 120,
    sceneThreshold: 0.1,
    floorIntervalSec: 3,
});

const ENV_MAP = Object.freeze({
    similarThreshold: 'TGDL_SIMILAR_THRESHOLD',
    durationTolerance: 'TGDL_SIMILAR_DURATION_TOLERANCE',
    partialMatchRatio: 'TGDL_SIMILAR_PARTIAL_MATCH_RATIO',
    partialFrameThreshold: 'TGDL_SIMILAR_PARTIAL_FRAME_THRESHOLD',
    partialShortClipSec: 'TGDL_SIMILAR_PARTIAL_SHORT_CLIP_SEC',
    partialShortMatchRatio: 'TGDL_SIMILAR_PARTIAL_SHORT_MATCH_RATIO',
    partialReviewMatchRatio: 'TGDL_SIMILAR_PARTIAL_REVIEW_MATCH_RATIO',
    partialReviewMinMatchedFrames: 'TGDL_SIMILAR_PARTIAL_REVIEW_MIN_MATCHED_FRAMES',
    fingerprintMaxFrames: 'TGDL_SIMILAR_FINGERPRINT_MAX_FRAMES',
    fingerprintTilePx: 'TGDL_SIMILAR_FINGERPRINT_TILE_PX',
    durationBucketSec: 'TGDL_SIMILAR_DURATION_BUCKET_SEC',
    sceneThreshold: 'TGDL_SIMILAR_SCENE_THRESHOLD',
    floorIntervalSec: 'TGDL_SIMILAR_FLOOR_INTERVAL_SEC',
});

const INT_KEYS = new Set([
    'similarThreshold',
    'partialFrameThreshold',
    'partialShortClipSec',
    'partialReviewMinMatchedFrames',
    'fingerprintMaxFrames',
    'fingerprintTilePx',
    'durationBucketSec',
]);

function _parseEnv(key, raw) {
    const s = String(raw).trim();
    if (INT_KEYS.has(key)) {
        const n = Number.parseInt(s, 10);
        return Number.isFinite(n) ? n : undefined;
    }
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : undefined;
}

export function similarAnalyzeConfigKey(cfg = SIMILAR_CLIPS_DEFAULTS) {
    return [
        FINGERPRINT_ALGO,
        Number(cfg.similarThreshold),
        Number(cfg.durationTolerance),
        Number(cfg.durationBucketSec),
        'cov0.7',
    ].join('|');
}

export function getSimilarClipsConfig() {
    let stored = {};
    try {
        stored = loadConfig()?.advanced?.similarClips || {};
    } catch {
        /* defaults */
    }
    const merged = { ...SIMILAR_CLIPS_DEFAULTS, ...stored };
    delete merged.fingerprintFps;
    for (const [key, envName] of Object.entries(ENV_MAP)) {
        const raw = process.env[envName];
        if (raw === undefined || raw === null || String(raw).trim() === '') continue;
        const parsed = _parseEnv(key, raw);
        if (parsed !== undefined) merged[key] = parsed;
    }
    return merged;
}
