/**
 * Similar-clips fingerprint Scan. JobTracker contract: `{ onProgress, signal }`.
 *
 * Pages local videos (no `.iterate()` across await), skips when
 * `file_hash` matches **and** `algo === pdq-scene-v1`, otherwise runs
 * the similar-only ffmpeg fingerprint runner. Never calls seekbar
 * `generateForDownload`.
 */

import {
    countSimilarScanPending,
    getVideoFingerprint,
    pageSimilarScanVideos,
    videoFingerprintMatchesHash,
} from '../db.js';
import { FINGERPRINT_ALGO } from './config.js';
import { generateFingerprintForDownload } from './fingerprint.js';

const PAGE_SIZE = 100;
const CONCURRENCY = 2;
const PROGRESS_EVERY_MS = 1000;

export function fingerprintIsCurrent(row) {
    if (!row || row.id == null) return false;
    const fp = getVideoFingerprint(row.id);
    if (!fp || fp.algo !== FINGERPRINT_ALGO) return false;
    const fileHash = row.file_hash;
    if (fileHash) return videoFingerprintMatchesHash(row.id, fileHash);
    return true;
}

export async function scanSimilarClips({ onProgress, signal } = {}) {
    const concurrency = CONCURRENCY;
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
            const meta = await generateFingerprintForDownload(row, { signal });
            if (meta && !meta.skipped) generated++;
            else skipped++;
        } catch {
            errored++;
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
