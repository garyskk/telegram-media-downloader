/**
 * Similar-clips fingerprint Scan. JobTracker contract: `{ onProgress, signal }`.
 *
 * Pages local videos (no `.iterate()` across await), skips when
 * `video_fingerprints.file_hash` still matches `downloads.file_hash`,
 * otherwise calls enhanced `generateForDownload` with overwrite always
 * so hover-only sprites are not reused as hashes.
 */

import {
    countSimilarScanPending,
    getVideoFingerprint,
    pageSimilarScanVideos,
    upsertSeekbarSprite,
    videoFingerprintMatchesHash,
} from '../db.js';
import { generateForDownload, getSeekbarConfig } from '../seekbar/generator.js';

const PAGE_SIZE = 100;
const CONCURRENCY = 6;
const PROGRESS_EVERY_MS = 1000;
const SKIP_FORMATS = new Set(['failed', 'missing', 'no_duration']);

export function fingerprintIsCurrent(row) {
    if (!row || row.id == null) return false;
    const fileHash = row.file_hash;
    if (fileHash) return videoFingerprintMatchesHash(row.id, fileHash);
    return Boolean(getVideoFingerprint(row.id));
}

function _markSeekbarSkip(row, reason) {
    if (!SKIP_FORMATS.has(reason)) return;
    try {
        upsertSeekbarSprite({
            downloadId: row.id,
            spritePath: '',
            metaPath: '',
            durationSec: null,
            frames: 0,
            cols: 0,
            rows: 0,
            tileW: 0,
            tileH: 0,
            intervalSec: null,
            format: reason,
            bytes: 0,
            sourceSize: Number(row.file_size) || null,
            sourceMtime: null,
            generatedAt: Date.now(),
        });
    } catch {
        /* best-effort */
    }
}

export async function scanSimilarClips({ onProgress, signal } = {}) {
    const seekbarCfg = getSeekbarConfig();
    const concurrency = Math.max(1, Math.min(16, Number(seekbarCfg.concurrency) || CONCURRENCY));
    const total = countSimilarScanPending();
    let processed = 0;
    let generated = 0;
    let skipped = 0;
    let errored = 0;
    let lastEmit = 0;
    const started = Date.now();

    const emit = (stage) => {
        try {
            onProgress?.({
                stage,
                processed,
                total,
                generated,
                skipped,
                errored,
            });
        } catch {
            /* progress must not abort the scan */
        }
    };

    emit('start');

    const _processOne = async (row) => {
        if (fingerprintIsCurrent(row)) {
            skipped++;
            processed++;
            return;
        }
        try {
            const meta = await generateForDownload(row, seekbarCfg, {
                overwrite: 'always',
                signal,
            });
            if (meta && !meta.pending && !meta.skipped) generated++;
            else {
                skipped++;
                if (meta?.skipped) _markSeekbarSkip(row, meta.skipped);
            }
        } catch (e) {
            errored++;
            if (
                /does not contain any stream|no video stream|Invalid data found|Invalid NAL|moov atom not found/i.test(
                    e?.message || '',
                )
            ) {
                _markSeekbarSkip(row, 'failed');
            }
        }
        processed++;
    };

    let cursor = Number.MAX_SAFE_INTEGER;
    while (true) {
        if (signal?.aborted) break;
        const rows = pageSimilarScanVideos({ beforeId: cursor, limit: PAGE_SIZE });
        if (!rows.length) break;

        for (let i = 0; i < rows.length; i += concurrency) {
            if (signal?.aborted) break;
            const batch = rows.slice(i, i + concurrency);
            await Promise.all(batch.map(_processOne));
            cursor = Number(batch[batch.length - 1].id) || cursor;
            const now = Date.now();
            if (now - lastEmit >= PROGRESS_EVERY_MS) {
                lastEmit = now;
                emit('progress');
                await new Promise((r) => setImmediate(r));
            }
        }
    }

    emit('done');
    return {
        processed,
        generated,
        skipped,
        errored,
        durationMs: Date.now() - started,
        cancelled: !!signal?.aborted,
    };
}
