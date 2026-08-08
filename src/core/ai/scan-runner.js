/**
 * Faces scan runner. Search + Auto-tag flows were removed; this module
 * now owns only the face detection + DBSCAN clustering pipeline.
 *
 *   - `startFacesScan(cfg, …)` has two phases:
 *     (a) per-row face detection + persistence into the `faces` table,
 *     (b) one DBSCAN pass over every face embedding to populate `people`
 *         and link `faces.person_id`. Phase (b) is cheap compared to (a);
 *         we run it inside the same job so the UI sees one done event.
 *
 * Fire-and-forget: caller polls `getScanState('faces')` or subscribes to
 * the WS events the route layer broadcasts. Single-flight — a second
 * `startFacesScan` while one is running returns `{ alreadyRunning: true }`.
 */

import { existsSync } from 'fs';
import path from 'path';

import {
    clearAllPeople,
    countPeople,
    deleteFacesForDownload,
    getDb,
    getUnindexedAiBatch,
    insertFace,
    insertPerson,
    iterateAllFaces,
    iterateUnassignedFaces,
    listExcludedCentroids,
    listPeopleCentroids,
    listPinnedCoverFaceIds,
    recomputePersonCentroid,
    restorePinnedCoverFaces,
    setAiIndexedAt,
    setFacePerson,
} from '../db.js';
import { clusterFaces, FACE_DEFAULTS, qualityFilter } from './faces.js';
import { detectFacesBatch, detectFacesInVideo } from './faces-client.js';
import { resolveFacesValue } from './faces-config.js';
import { getDataDir } from '../paths.js';

const DATA_DIR = getDataDir();

// Float32Array <-> Buffer helpers. Previously came from vector-store.js
// (deleted with Search/Tags); inlined because clustering is now the only
// remaining caller.
function _f32ToBlob(f) {
    return Buffer.from(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
}

// Duty-cycle throttle: sleep for `ratio * elapsedMs` after a detection call
// so the CPU gets proportional rest between work bursts. Dynamic by design —
// slow hardware (long elapsed) gets longer rests; fast GPU barely notices it.
// Capped at 5 000 ms so a single stalled video doesn't freeze the loop.
async function _throttleSleep(elapsedMs, ratio) {
    if (!ratio || ratio <= 0) return;
    const sleepMs = Math.min(Math.round(elapsedMs * ratio), 5000);
    if (sleepMs >= 10) await new Promise((r) => setTimeout(r, sleepMs));
}

/** Lower this Node process's CPU priority during the video phase (Unix only). */
function _applyVideoNice(niceLevel) {
    if (!Number.isFinite(niceLevel) || niceLevel <= 0) return null;
    if (process.platform === 'win32') return null;
    if (typeof process.setPriority !== 'function') return null;
    try {
        const prev = process.getPriority();
        const target = Math.max(-20, Math.min(19, niceLevel | 0));
        if (target > prev) process.setPriority(target);
        return prev;
    } catch {
        return null;
    }
}

function _restoreVideoNice(prev) {
    if (prev === null || typeof process.setPriority !== 'function') return;
    try {
        process.setPriority(prev);
    } catch {
        /* EPERM on some containers — best effort */
    }
}

// Pick the first finite number from a list of candidates; fall back to
// `fallback` if none match. Used to resolve cluster knobs with the
// "new path > legacy alias > env override > default" precedence.
function _pickNumber(candidates, fallback) {
    for (const c of candidates) {
        if (Number.isFinite(c)) return c;
    }
    return fallback;
}
function _blobToF32(blob) {
    const dim = blob.byteLength / 4;
    const out = new Float32Array(dim);
    const view = new Float32Array(blob.buffer, blob.byteOffset, dim);
    out.set(view);
    return out;
}

function _euclid(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return Math.sqrt(sum);
}

function _resolveClusterEps(cfg) {
    const facesCfg = cfg?.faces || {};
    const eps = _pickNumber(
        [resolveFacesValue('epsilon', facesCfg), facesCfg.epsilon, cfg.facesEpsilon],
        FACE_DEFAULTS.facesEpsilon,
    );
    const minPts = _pickNumber(
        [resolveFacesValue('minPoints', facesCfg), facesCfg.minPoints, cfg.facesMinPoints],
        FACE_DEFAULTS.facesMinPoints,
    );
    const matchEpsEnv = resolveFacesValue('labelMatchEps', facesCfg);
    const matchEps = _pickNumber(
        [facesCfg.labelMatchEps, cfg.facesLabelMatchEps, matchEpsEnv],
        Math.max(0.2, Math.min(0.6, eps * 0.9)),
    );
    return { eps, minPts, matchEps };
}

function _isNearExcluded(centroid, excludedSnapshot, matchEps) {
    for (const s of excludedSnapshot) {
        if (_euclid(centroid, s.centroid) <= matchEps) return true;
    }
    return false;
}

/**
 * Incremental Phase B — keep existing people / merges; only assign faces
 * with person_id IS NULL.
 *
 * Exclusion denylist (A+B): any unassigned face within `eps` of an
 * excluded centroid is left unassigned — never attached to an existing
 * person and never fed into leftover DBSCAN. Using `eps` (same radius as
 * attach) rather than the tighter `labelMatchEps` prevents split→exclude
 * faces from bleeding back into a sibling cluster.
 */
async function _runIncrementalPhaseB({ state, signal, log, cfg, bcast }) {
    if (signal.aborted) return;
    log('info', 'faces scan: starting incremental clustering pass');
    const { eps, minPts } = _resolveClusterEps(cfg);

    const unassigned = [];
    for (const r of iterateUnassignedFaces()) {
        unassigned.push({
            id: r.id,
            embedding: _blobToF32(r.embedding),
        });
    }

    state.phase = 'B';
    state.faceCount = unassigned.length;
    bcast(true);

    if (!unassigned.length) {
        state.peopleCount = countPeople();
        state.noiseFaces = 0;
        log('info', 'faces scan: incremental Phase B — no unassigned faces; people unchanged');
        return;
    }

    const people = listPeopleCentroids();
    const excludedSnapshot = listExcludedCentroids();
    const touched = new Set();
    const leftover = [];
    let attached = 0;
    let excludedFaces = 0;

    for (const face of unassigned) {
        if (signal.aborted) return;
        // Filter first: near-excluded faces stay noise (no attach, no DBSCAN).
        if (_isNearExcluded(face.embedding, excludedSnapshot, eps)) {
            excludedFaces += 1;
            continue;
        }
        let bestPerson = null;
        let bestDist = Infinity;
        for (const p of people) {
            const dist = _euclid(face.embedding, p.centroid);
            if (dist < bestDist && dist <= eps) {
                bestDist = dist;
                bestPerson = p;
            }
        }
        if (bestPerson) {
            setFacePerson(face.id, bestPerson.id);
            touched.add(bestPerson.id);
            const n = (bestPerson.faceCount || 0) + 1;
            const c = bestPerson.centroid;
            for (let i = 0; i < c.length; i++) {
                c[i] = (c[i] * (n - 1) + face.embedding[i]) / n;
            }
            bestPerson.faceCount = n;
            attached += 1;
        } else {
            leftover.push(face);
        }
    }

    for (const pid of touched) {
        recomputePersonCentroid(pid);
    }

    let peopleInserted = 0;
    let excludedSkipped = 0;
    let noiseCount = 0;

    if (leftover.length) {
        log(
            'info',
            `faces scan: incremental — attached ${attached} to existing people; ` +
                `skipped ${excludedFaces} near-excluded; ` +
                `DBSCAN on ${leftover.length} leftover (eps=${eps}, minPts=${minPts})`,
        );
        const { clusters, noise } = clusterFaces(leftover, { eps, minPts });
        noiseCount = noise.length;
        await new Promise((r) => setImmediate(r));
        let i = 0;
        for (const c of clusters) {
            // Safety net — faces already filtered; still skip if a leftover
            // cluster centroid drifts onto an exclusion.
            if (_isNearExcluded(c.centroid, excludedSnapshot, eps)) {
                excludedSkipped += 1;
                i += 1;
                if (i % 100 === 0) await new Promise((r) => setImmediate(r));
                continue;
            }
            const personId = insertPerson({
                label: null,
                centroidBlob: _f32ToBlob(c.centroid),
                faceCount: c.faceCount,
            });
            peopleInserted += 1;
            for (const memberIdx of c.memberIdxs) {
                setFacePerson(leftover[memberIdx].id, personId);
            }
            i += 1;
            if (i % 100 === 0) await new Promise((r) => setImmediate(r));
        }
    } else {
        log(
            'info',
            `faces scan: incremental — attached ${attached} to existing people; ` +
                `skipped ${excludedFaces} near-excluded; no leftovers`,
        );
    }

    state.peopleCount = countPeople();
    state.noiseFaces = noiseCount;
    log(
        'info',
        `faces scan: incremental Phase B done — attached=${attached}, ` +
            `excludedFaces=${excludedFaces}, newPeople=${peopleInserted}, ` +
            `excludedNew=${excludedSkipped}, noise=${noiseCount}, ` +
            `peopleTotal=${state.peopleCount}, eps=${eps}`,
    );
}

/**
 * Full rebuild Phase B — clearAllPeople + DBSCAN over every face.
 * Used by Rebuild all clusters (ε reshuffle). Preserves labels/covers/exclusions.
 */
async function _runFullRebuildPhaseB({ state, signal, log, cfg, bcast, db }) {
    if (signal.aborted) return;
    log('info', 'faces scan: starting full rebuild clustering pass');
    const faces = [];
    for (const r of iterateAllFaces()) {
        faces.push({
            id: r.id,
            embedding: _blobToF32(r.embedding),
            qualityScore: Number.isFinite(r.quality_score) ? r.quality_score : null,
        });
    }
    if (!faces.length) {
        log('info', 'faces scan: no faces detected — clustering skipped');
        return;
    }
    state.phase = 'B';
    state.faceCount = faces.length;
    bcast(true);
    if (faces.length > 50000) {
        log(
            'warn',
            `faces scan: ${faces.length} faces is a large input for DBSCAN — clustering may take a while`,
        );
    }
    const { eps, minPts, matchEps } = _resolveClusterEps(cfg);
    log(
        'info',
        `faces scan: full rebuild clustering ${faces.length} faces (eps=${eps}, minPts=${minPts})`,
    );
    const { clusters, noise } = clusterFaces(faces, { eps, minPts });
    await new Promise((r) => setImmediate(r));

    const labelSnapshot = (() => {
        const out = [];
        const stmt = db.prepare(
            'SELECT label, embedding_centroid FROM people WHERE label IS NOT NULL',
        );
        for (const r of stmt.iterate()) {
            if (!r.embedding_centroid) continue;
            out.push({ label: r.label, centroid: _blobToF32(r.embedding_centroid) });
        }
        return out;
    })();
    const findCarryOverLabel = (centroid) => {
        let best = null;
        let bestDist = Infinity;
        for (const s of labelSnapshot) {
            const dist = _euclid(centroid, s.centroid);
            if (dist < bestDist && dist <= matchEps) {
                bestDist = dist;
                best = s.label;
            }
        }
        return best;
    };

    const excludedSnapshot = listExcludedCentroids();
    const coverFaceSnapshot = listPinnedCoverFaceIds();

    clearAllPeople();
    let i = 0;
    let preservedCount = 0;
    let excludedSkipped = 0;
    let peopleInserted = 0;
    for (const c of clusters) {
        if (_isNearExcluded(c.centroid, excludedSnapshot, matchEps)) {
            excludedSkipped += 1;
            i += 1;
            if (i % 100 === 0) await new Promise((r) => setImmediate(r));
            continue;
        }
        const carryOver = findCarryOverLabel(c.centroid);
        const personId = insertPerson({
            label: carryOver,
            centroidBlob: _f32ToBlob(c.centroid),
            faceCount: c.faceCount,
        });
        peopleInserted += 1;
        if (carryOver) preservedCount += 1;
        for (const memberIdx of c.memberIdxs) {
            setFacePerson(faces[memberIdx].id, personId);
        }
        i += 1;
        if (i % 100 === 0) await new Promise((r) => setImmediate(r));
    }
    const coversRestored = restorePinnedCoverFaces(coverFaceSnapshot);
    state.peopleCount = peopleInserted;
    state.noiseFaces = noise.length;
    log(
        'info',
        `faces scan: full rebuild clustered ${faces.length} faces into ${clusters.length} groups ` +
            `(${peopleInserted} people, ${excludedSkipped} excluded, ` +
            `${preservedCount}/${labelSnapshot.length} labels preserved, ` +
            `${coversRestored}/${coverFaceSnapshot.length} covers restored, ` +
            `eps=${matchEps.toFixed(3)})`,
    );
}

// Per-feature state. Only `faces` survives; the slot map is kept for
// shape compatibility with callers that read `getScanState(feature)`.
const _scans = {
    faces: _emptyState(),
};

function _emptyState() {
    return {
        running: false,
        scanned: 0,
        total: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        phase: 'A', // 'A' = detection, 'B' = clustering
        faceCount: 0, // total face embeddings found in phase A
        peopleCount: 0, // clusters produced by phase B
        noiseFaces: 0, // faces not assigned to any cluster
        // Decode-position progress for whichever video is currently mid-flight
        // (video scan progress reporting) — null between videos, during the
        // photo phase, and whenever the sidecar doesn't report a job_id
        // (older sidecar version, or onVideoProgress polling never started).
        currentVideo: null,
        abort: null,
    };
}

export function getScanState(feature) {
    const s = _scans[feature];
    if (!s) return null;
    const { abort: _abort, ...rest } = s;
    return rest;
}

export function isScanRunning(feature) {
    return Boolean(_scans[feature]?.running);
}

export function cancelScan(feature) {
    const s = _scans[feature];
    if (!s?.abort) return false;
    try {
        s.abort.abort();
    } catch {}
    return true;
}

/**
 * Resolve a stored relative download path to an absolute one. Mirrors the
 * NSFW resolver — DB stores `Group/images/foo.jpg`, files live under
 * `data/downloads/...`.
 */
function _resolveAbs(storedPath) {
    if (!storedPath) return null;
    if (path.isAbsolute(storedPath) && existsSync(storedPath)) return storedPath;
    let s = String(storedPath).replace(/\\/g, '/');
    while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
    const candidate = path.join(DATA_DIR, 'downloads', s);
    if (existsSync(candidate)) return candidate;
    if (existsSync(storedPath)) return storedPath;
    return null;
}

// Generic envelope: claim slot → run worker → release. Worker owns its own
// progress reporting via the `bump` callback.
async function _runScan(feature, cfg, worker, onProgress, onDone, onLog) {
    const log = (levelOrEntry, msg) => {
        try {
            if (typeof onLog !== 'function') return;
            if (levelOrEntry !== null && typeof levelOrEntry === 'object') {
                // faces.js / faces-client.js call onLog({source, level, msg}) directly.
                // Pass the object through so the server's log() can destructure it.
                onLog(levelOrEntry);
            } else {
                onLog({ source: `ai-scan-${feature}`, level: levelOrEntry, msg });
            }
        } catch {}
    };
    if (_scans[feature]?.running) {
        log('warn', `start${feature} called while already running — ignoring`);
        return { alreadyRunning: true };
    }
    const ctrl = new AbortController();
    const state = (_scans[feature] = {
        ..._emptyState(),
        running: true,
        startedAt: Date.now(),
        abort: ctrl,
    });

    let lastBroadcast = 0;
    const bcast = (force = false) => {
        const now = Date.now();
        if (!force && now - lastBroadcast < 500) return;
        lastBroadcast = now;
        try {
            if (typeof onProgress === 'function') onProgress(getScanState(feature));
        } catch {}
    };
    const bump = ({ scanned, total } = {}) => {
        if (Number.isFinite(scanned)) state.scanned = scanned;
        if (Number.isFinite(total)) state.total = total;
        bcast();
    };

    (async () => {
        try {
            await worker(state, ctrl.signal, bump, log, cfg, bcast);
        } catch (e) {
            state.error = e?.message || String(e);
            log('error', `${feature} scan crashed: ${state.error}`);
        } finally {
            state.running = false;
            state.finishedAt = Date.now();
            state.abort = null;
            bcast(true);
            try {
                if (typeof onDone === 'function') onDone(getScanState(feature));
            } catch {}
        }
    })().catch(() => {
        /* never throw out of the IIFE */
    });

    return { started: true };
}

// ---- Faces scan + clustering pass ---------------------------------------

export function startFacesScan(cfg, onProgress, onDone, onLog) {
    return _runScan(
        'faces',
        cfg,
        async (state, signal, bump, log, cfg, bcast) => {
            // Resolve `fileTypes` with the same precedence as the cluster
            // knobs: new path > legacy flat alias > env override > default.
            const facesCfgIn = cfg?.faces || {};
            const envFileTypes = resolveFacesValue('fileTypes', facesCfgIn);
            const fileTypes = Array.isArray(facesCfgIn.fileTypes)
                ? facesCfgIn.fileTypes
                : Array.isArray(cfg?.fileTypes)
                  ? cfg.fileTypes
                  : Array.isArray(envFileTypes)
                    ? envFileTypes
                    : ['photo'];
            const db = getDb();
            const clusterMode =
                String(cfg?.facesClusterMode || facesCfgIn.clusterMode || 'incremental')
                    .toLowerCase() === 'full'
                    ? 'full'
                    : 'incremental';
            const skipPhaseA = cfg?.skipPhaseA === true || facesCfgIn.skipPhaseA === true;

            // Full rebuild: wipe+DBSCAN only (no detection). Used by
            // Rebuild all clusters when the operator changes ε.
            if (clusterMode === 'full') {
                await _runFullRebuildPhaseB({ state, signal, log, cfg, bcast, db });
                return;
            }

            // Re-cluster button: Phase B only — do not pick up unscanned media.
            if (skipPhaseA) {
                await _runIncrementalPhaseB({ state, signal, log, cfg, bcast });
                return;
            }

            // Phase A — detect faces on every photo we haven't visited yet.
            // Visited = "ai_indexed_at IS NOT NULL"; even photos that yield
            // zero faces get stamped so the next pass doesn't re-decode.
            const phaseATotal = db
                .prepare(`
                    SELECT COUNT(*) AS n FROM downloads
                     WHERE file_type IN (${fileTypes.map(() => '?').join(',')})
                       AND ai_indexed_at IS NULL
                       AND (user_deleted IS NULL OR user_deleted = 0)
                `)
                .get(...fileTypes).n;
            const scanVideos = facesCfgIn.scanVideos === true;
            const videoScanLimitRaw = _pickNumber(
                [resolveFacesValue('videoScanLimit', facesCfgIn), facesCfgIn.videoScanLimit],
                0,
            );
            const videoScanLimit = Math.max(0, videoScanLimitRaw | 0);
            const videoNice = Math.max(
                0,
                _pickNumber(
                    [resolveFacesValue('videoNice', facesCfgIn), facesCfgIn.videoNice],
                    0,
                ) | 0,
            );
            const videoTotal = scanVideos
                ? db
                      .prepare(
                          `SELECT COUNT(*) AS n FROM downloads WHERE file_type = 'video' AND ai_indexed_at IS NULL AND (user_deleted IS NULL OR user_deleted = 0)`,
                      )
                      .get().n
                : 0;
            const videoToScan =
                videoScanLimit > 0 ? Math.min(videoTotal, videoScanLimit) : videoTotal;
            state.total = phaseATotal + videoToScan;
            bump();
            log(
                'info',
                `faces scan: ${phaseATotal} photos${videoToScan ? ` + ${videoToScan} videos${videoScanLimit > 0 && videoTotal > videoToScan ? ` (limit ${videoScanLimit}, ${videoTotal - videoToScan} deferred)` : ''}` : videoTotal ? ` + ${videoTotal} videos` : ''} to scan in phase A`,
            );

            // `batchSize` precedence (same model as fileTypes above).
            const envBatch = resolveFacesValue('batchSize', facesCfgIn);
            const batchSizeRaw = _pickNumber([facesCfgIn.batchSize, cfg?.batchSize, envBatch], 16);
            const batchSize = Math.max(1, Math.min(200, Number(batchSizeRaw) || 32));

            // Duty-cycle CPU throttle ratio (0 = off, default 0.5 = rest for
            // half the time spent on detection). Configurable so GPU users
            // can set it to 0 and run at full speed.
            const envThrottle = resolveFacesValue('cpuThrottleRatio', facesCfgIn);
            const throttleRatioRaw = _pickNumber(
                [facesCfgIn.cpuThrottleRatio, cfg?.cpuThrottleRatio, envThrottle],
                0.5,
            );
            const throttleRatio = Math.max(0, Math.min(5, Number(throttleRatioRaw) || 0.5));

            // Extensions to skip without sending to the sidecar — stamped as
            // indexed immediately so they don't appear in future scans.
            // Useful for animated WebP stickers that reliably decode_failed.
            const envExclude = resolveFacesValue('excludeExtensions', facesCfgIn);
            const excludeExtsRaw = Array.isArray(facesCfgIn.excludeExtensions)
                ? facesCfgIn.excludeExtensions
                : Array.isArray(envExclude)
                  ? envExclude
                  : [];
            const excludeExts = new Set(
                excludeExtsRaw.map((e) => String(e).toLowerCase().replace(/^\.?/, '.')),
            );

            let _statNull = 0; // detectFaces returned null (sidecar error / file missing)
            let _statSkip = 0; // skipped by excludeExtensions
            let _statEmpty = 0; // detectFaces returned [] (processed but no faces detected)
            let _statFaces = 0; // total face embeddings stored
            let _statPhotos = 0; // photos with ≥1 face
            let _nextStatLog = 200; // log a summary every N photos
            while (!signal.aborted) {
                const batch = getUnindexedAiBatch({ fileTypes, limit: batchSize });
                if (!batch.length) break;
                // One HTTP round-trip for the whole batch — the sidecar's
                // /detect/batch endpoint processes files sequentially in its
                // threadpool and returns all results together. This replaces
                // the old Promise.all approach that sent N concurrent requests
                // to a CPU-only sidecar, causing queue build-up and timeouts.
                const items = batch.map((row) => ({ row, abs: _resolveAbs(row.file_path) }));
                const nullItems = items.filter((i) => !i.abs);
                const skipItems = excludeExts.size
                    ? items.filter(
                          (i) => i.abs && excludeExts.has(path.extname(i.abs).toLowerCase()),
                      )
                    : [];
                const skipSet = new Set(skipItems.map((i) => i.row.id));
                const validItems = items.filter((i) => i.abs && !skipSet.has(i.row.id));

                for (const { row } of skipItems) {
                    _statSkip++;
                    setAiIndexedAt(row.id);
                    state.scanned += 1;
                    bump();
                }

                for (const { row } of nullItems) {
                    _statNull++;
                    setAiIndexedAt(row.id);
                    state.scanned += 1;
                    bump();
                }

                if (signal.aborted) continue;

                let batchResults = [];
                if (validItems.length) {
                    const _t0 = Date.now();
                    // Split the batch into parallel chunks so the sidecar's
                    // concurrency semaphore can process multiple files at once
                    // instead of one sequential batch blocking a single slot.
                    const CHUNK = Math.max(1, Math.min(4, Math.ceil(validItems.length / 4)));
                    const chunks = [];
                    for (let ci = 0; ci < validItems.length; ci += CHUNK) {
                        chunks.push(validItems.slice(ci, ci + CHUNK));
                    }
                    try {
                        const chunkResults = await Promise.all(
                            chunks.map((chunk) =>
                                detectFacesBatch(
                                    chunk.map((i) => i.abs),
                                    cfg,
                                    log,
                                    signal,
                                ).catch((e) => {
                                    log('warn', `detectFacesBatch threw: ${e?.message || e}`);
                                    return chunk.map(() => null);
                                }),
                            ),
                        );
                        batchResults = chunkResults.flat();
                    } catch (e) {
                        log('warn', `detectFacesBatch threw: ${e?.message || e}`);
                        batchResults = validItems.map(() => null);
                    }
                    await _throttleSleep(Date.now() - _t0, throttleRatio);
                }

                for (let bi = 0; bi < validItems.length; bi++) {
                    const { row } = validItems[bi];
                    const detected = batchResults[bi] ?? null;
                    if (detected === null) {
                        _statNull++;
                    } else if (detected.length === 0) {
                        _statEmpty++;
                    } else {
                        _statFaces += detected.length;
                        _statPhotos++;
                    }
                    if (Array.isArray(detected) && detected.length) {
                        deleteFacesForDownload(row.id);
                        for (const f of detected) {
                            if (!f.embedding || !f.embedding.length) continue;
                            insertFace({
                                downloadId: row.id,
                                x: f.x,
                                y: f.y,
                                w: f.w,
                                h: f.h,
                                embeddingBlob: _f32ToBlob(f.embedding),
                                qualityScore: Number.isFinite(f.qualityScore)
                                    ? f.qualityScore
                                    : Number.isFinite(f.score)
                                      ? f.score
                                      : null,
                                frameTimeSec: Number.isFinite(f.frameTimeSec)
                                    ? f.frameTimeSec
                                    : null,
                            });
                        }
                    }
                    setAiIndexedAt(row.id);
                    state.scanned += 1;
                    bump();
                }
                if (state.scanned >= _nextStatLog) {
                    log(
                        'info',
                        `faces scan progress: ${state.scanned}/${phaseATotal} — ` +
                            `${_statPhotos} with faces (${_statFaces} total), ` +
                            `${_statEmpty} no-face, ${_statNull} errors` +
                            (_statSkip ? `, ${_statSkip} ext-skipped` : ''),
                    );
                    _nextStatLog = state.scanned + 200;
                }
                await new Promise((r) => setImmediate(r));
            }
            log(
                'info',
                `faces scan: phase A (photos) done — ${_statPhotos} photos had faces ` +
                    `(${_statFaces} total embeddings), ` +
                    `${_statEmpty} no-face, ${_statNull} sidecar errors` +
                    (_statSkip ? `, ${_statSkip} ext-skipped` : ''),
            );

            // Phase A (videos) — same faces table, same DBSCAN pass in Phase B.
            // One video at a time: each can produce many frames so we don't want
            // to hold a large batch in memory. Faces stored here cluster with
            // photo-source faces automatically because the embedding space is
            // identical regardless of whether the frame came from a photo or video.
            // Gated by cfg.faces.scanVideos — off by default, opt-in via UI toggle.
            if (!signal.aborted && scanVideos) {
                if (videoTotal > 0) {
                    const limitNote =
                        videoScanLimit > 0
                            ? ` (limit ${videoScanLimit}${videoTotal > videoScanLimit ? `, ${videoTotal - videoScanLimit} deferred` : ''})`
                            : '';
                    const niceNote = videoNice > 0 ? `, nice=${videoNice}` : '';
                    log('info', `faces scan: starting video phase — ${videoToScan} videos${limitNote}${niceNote}`);
                    let _vNull = 0,
                        _vEmpty = 0,
                        _vFaces = 0,
                        _vVids = 0,
                        _vProcessed = 0;
                    const savedNice = _applyVideoNice(videoNice);
                    try {
                        while (!signal.aborted) {
                        if (videoScanLimit > 0 && _vProcessed >= videoScanLimit) {
                            log(
                                'info',
                                `faces scan: video scan limit (${videoScanLimit}) reached — ${videoTotal - _vProcessed} videos deferred to a later scan`,
                            );
                            break;
                        }
                        const [row] = getUnindexedAiBatch({ fileTypes: ['video'], limit: 1 });
                        if (!row) break;
                        const abs = _resolveAbs(row.file_path);
                        if (!abs) {
                            _vNull++;
                            setAiIndexedAt(row.id);
                            state.scanned += 1;
                            bump();
                            continue;
                        }
                        let detected = null;
                        const _tv0 = Date.now();
                        try {
                            detected = await detectFacesInVideo(abs, cfg, log, signal, (p) => {
                                state.currentVideo = {
                                    name: path.basename(abs),
                                    pct: Number.isFinite(p?.pct) ? p.pct : null,
                                    framesDecoded: Number.isFinite(p?.frames_decoded)
                                        ? p.frames_decoded
                                        : null,
                                    totalFrames: Number.isFinite(p?.total_frames)
                                        ? p.total_frames
                                        : null,
                                };
                                bump();
                            });
                        } catch (e) {
                            log('warn', `detectFacesInVideo threw for ${abs}: ${e?.message || e}`);
                        }
                        await _throttleSleep(Date.now() - _tv0, throttleRatio);
                        if (detected === null) {
                            _vNull++;
                        } else if (detected.length === 0) {
                            _vEmpty++;
                        } else {
                            _vFaces += detected.length;
                            _vVids++;
                        }
                        if (Array.isArray(detected) && detected.length) {
                            const facesCfg = cfg?.faces || cfg || {};
                            detected = qualityFilter(detected, facesCfg);
                            deleteFacesForDownload(row.id);
                            for (const f of detected) {
                                if (!f.embedding || !f.embedding.length) continue;
                                insertFace({
                                    downloadId: row.id,
                                    x: f.x,
                                    y: f.y,
                                    w: f.w,
                                    h: f.h,
                                    embeddingBlob: _f32ToBlob(f.embedding),
                                    qualityScore: Number.isFinite(f.qualityScore)
                                        ? f.qualityScore
                                        : Number.isFinite(f.score)
                                          ? f.score
                                          : null,
                                    frameTimeSec: Number.isFinite(f.frameTimeSec)
                                        ? f.frameTimeSec
                                        : null,
                                });
                            }
                        }
                        setAiIndexedAt(row.id);
                        state.scanned += 1;
                        _vProcessed += 1;
                        // Clear so this video's stale progress doesn't linger
                        // once it's done — the next iteration's callback (or
                        // nothing, once the phase ends) sets it again.
                        state.currentVideo = null;
                        bump();
                        await new Promise((r) => setImmediate(r));
                    }
                    } finally {
                        _restoreVideoNice(savedNice);
                    }
                    log(
                        'info',
                        `faces scan: phase A (videos) done — ${_vVids} videos had faces ` +
                            `(${_vFaces} total embeddings), ${_vEmpty} no-face, ${_vNull} errors`,
                    );
                }
            }

            // Phase B — incremental: keep existing people/merges; assign
            // only unassigned faces (match existing centroids or DBSCAN leftovers).
            await _runIncrementalPhaseB({ state, signal, log, cfg, bcast });
        },
        onProgress,
        onDone,
        onLog,
    );
}

/** For tests — clear in-memory state so the next test starts fresh. */
export function _resetForTests() {
    _scans.faces = _emptyState();
}

/** @internal test hooks */
export const _test = {
    runIncrementalPhaseB: _runIncrementalPhaseB,
    runFullRebuildPhaseB: _runFullRebuildPhaseB,
};
