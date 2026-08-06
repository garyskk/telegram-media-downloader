/**
 * HTTP client for the Python face-detection sidecar.
 *
 * Owns nothing persistent: the URL is set by `faces-spawn.js` (Track C)
 * on boot — empty string disables, a non-empty URL switches the client
 * to that sidecar. Docker installs override via the `FACES_SERVICE_URL`
 * env so they talk to the bundled `tgdl-faces` container directly.
 *
 * Wire format (matches faces-service/tgdl_faces/app.py):
 *   POST /detect  { path, min_score, min_box_px, ar_range }
 *                 → 200 { faces: [{ x, y, w, h, score, embedding[], landmarks? }] }
 *                 → 403 { code: 'path_not_allowed' }  (sandbox; fall back to b64)
 *                 → 5xx { error }                     (retry with backoff)
 *
 * Output contract for callers (faces.js / scan-runner.js / index.js):
 *   - `null` on total failure (network gone, retries exhausted, decode died).
 *   - `[]` when the sidecar replied but found no faces.
 *   - `[{x, y, w, h, score, embedding: Float32Array, landmarks?}, …]` on success.
 *     The `embedding` MUST be a `Float32Array` — scan-runner.js's `_f32ToBlob`
 *     reads `.buffer`/`.byteLength` so a plain array breaks the DB write.
 */

import { promises as fs } from 'fs';
import { Buffer } from 'buffer';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { Agent } from 'undici';

import { resolveFacesValue } from './faces-config.js';

// Defaults used when the operator hasn't tuned `advanced.ai.faces.*` and
// hasn't set any of the matching `TGDL_FACES_*` env vars. `applyFacesCfg`
// pushes operator values on top, so this is the bare-install behaviour.
const HEALTH_CACHE_TTL_MS_DEFAULT = 5000;
// CPU-only buffalo_l inference can take 5-30 s per image on slow hardware;
// 60 s gives headroom without hanging the scan loop forever on a dead sidecar.
const REQUEST_TIMEOUT_MS_DEFAULT = 60000;
const MAX_RETRIES_DEFAULT = 3;
const RETRY_BACKOFF_MS_DEFAULT = [300, 600, 1200];
// Fixed floor for the primary sidecar video-detect request timeout — see
// the comment at its use site in `detectFacesInVideo` for why this is a
// fixed value rather than scaled by `max_frames`.
const VIDEO_REQUEST_TIMEOUT_MS_FLOOR = 2 * 60 * 60 * 1000;

// Node's built-in `fetch` (undici) enforces its own `headersTimeout` /
// `bodyTimeout` — 300s each, hardcoded — independent of whatever
// AbortController timeout we set below. A request that's still legitimately
// in flight past 5 minutes gets killed by undici itself with a generic
// "fetch failed" (no useful `cause`), even though our *intended* budget
// (e.g. the 2h video-detect floor, or a scaled batch timeout) hasn't
// elapsed. This used to never matter — every call comfortably finished
// under 5 minutes — but duration-independent video sampling (§4.1) means
// `/detect/video` can legitimately run for tens of minutes on a long or
// dense video. Any fetch whose own timeout can exceed 300s MUST pass a
// matching `dispatcher` or undici's ceiling silently wins first.
// `undici` is a direct dependency (not just Node's bundled copy) because
// the bundled copy's `Agent`/dispatcher classes aren't importable.
const _dispatcherCache = new Map();
function _dispatcherFor(timeoutMs) {
    const ms = Math.max(1, timeoutMs | 0);
    let agent = _dispatcherCache.get(ms);
    if (!agent) {
        agent = new Agent({ headersTimeout: ms, bodyTimeout: ms });
        _dispatcherCache.set(ms, agent);
    }
    return agent;
}

// Mutable runtime knobs. Initialised from defaults; overridden by either:
//   - `applyFacesCfg(resolvedCfg)` — called by faces-spawn at boot.
//   - Env vars on first access — for code paths that import the client
//     before spawn has run (e.g. AI maintenance card during cold boot).
let _healthCacheTtlMs = HEALTH_CACHE_TTL_MS_DEFAULT;
let _requestTimeoutMs = REQUEST_TIMEOUT_MS_DEFAULT;
let _maxRetries = MAX_RETRIES_DEFAULT;
let _retryBackoffMs = RETRY_BACKOFF_MS_DEFAULT.slice();
let _maxConcurrency = 0; // 0 = unlimited
let _inflight = 0;
let _envBootstrapped = false;
let _pathRejectedLogged = false;

let _sidecarUrl = '';
let _healthCache = null; // { value, expiresAt }

/**
 * Apply a resolved faces config snapshot to the client's runtime knobs.
 * Called by `faces-spawn._doStart()` once it's read `loadConfig()` + env.
 * Safe to call multiple times — later calls overwrite earlier values.
 *
 * Treats every key as optional: a partial snapshot only updates the
 * supplied knobs and leaves the rest untouched. Invalid values fall back
 * to the previous setting so a broken env var doesn't disable retries.
 */
export function applyFacesCfg(cfg = {}) {
    if (!cfg || typeof cfg !== 'object') return;
    if (Number.isFinite(cfg.healthCacheTtlMs) && cfg.healthCacheTtlMs >= 0) {
        _healthCacheTtlMs = cfg.healthCacheTtlMs | 0;
    }
    if (Number.isFinite(cfg.requestTimeoutMs) && cfg.requestTimeoutMs > 0) {
        _requestTimeoutMs = cfg.requestTimeoutMs | 0;
    }
    if (Number.isFinite(cfg.maxRetries) && cfg.maxRetries >= 0) {
        _maxRetries = cfg.maxRetries | 0;
    }
    if (Array.isArray(cfg.retryBackoffMs) && cfg.retryBackoffMs.length) {
        const cleaned = cfg.retryBackoffMs
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n) && n >= 0);
        if (cleaned.length) _retryBackoffMs = cleaned;
    }
    if (Number.isFinite(cfg.sidecarMaxConcurrency) && cfg.sidecarMaxConcurrency >= 0) {
        _maxConcurrency = cfg.sidecarMaxConcurrency | 0;
    }
    _envBootstrapped = true;
}

// Lazy env bootstrap for code paths that import the client before spawn —
// e.g. the AI maintenance card hitting `/api/ai/status` during cold boot.
// Once `applyFacesCfg` has run we trust the snapshot it pushed.
function _bootstrapFromEnv() {
    if (_envBootstrapped) return;
    _envBootstrapped = true;
    const probe = (key) => resolveFacesValue(key, {});
    const ttl = probe('healthCacheTtlMs');
    if (Number.isFinite(ttl) && ttl >= 0) _healthCacheTtlMs = ttl | 0;
    const to = probe('requestTimeoutMs');
    if (Number.isFinite(to) && to > 0) _requestTimeoutMs = to | 0;
    const mr = probe('maxRetries');
    if (Number.isFinite(mr) && mr >= 0) _maxRetries = mr | 0;
    const bo = probe('retryBackoffMs');
    if (Array.isArray(bo) && bo.length) _retryBackoffMs = bo;
    const mc = probe('sidecarMaxConcurrency');
    if (Number.isFinite(mc) && mc >= 0) _maxConcurrency = mc | 0;
}

/**
 * Set the sidecar base URL. Empty string disables the client entirely
 * (callers see `getSidecarUrl()` return null). Called by `faces-spawn.js`
 * once the child process is healthy, and by Docker boot when
 * `FACES_SERVICE_URL` env is present.
 *
 * Mutating the URL invalidates the cached health probe so the next caller
 * doesn't see a stale "down" / "up" answer from the previous sidecar.
 */
export function setSidecarUrl(url) {
    const next = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
    if (next === _sidecarUrl) return;
    _sidecarUrl = next;
    _healthCache = null;
}

/** Current sidecar URL or null when none is configured. */
export function getSidecarUrl() {
    return _sidecarUrl || null;
}

const HEALTH_PROBE_TIMEOUT_MS = 5000;
const HEALTH_PROBE_RETRIES = 3;

/**
 * Probe the sidecar's `/health` endpoint. Result is cached for 5 s — the
 * AI maintenance card polls this on every redraw and the sidecar's
 * `/health` is otherwise hit several times per second during a scan.
 *
 * Retries up to `HEALTH_PROBE_RETRIES` times on network / 5xx errors
 * before caching a failure so a single transient blip doesn't flip the
 * status card red. Uses a dedicated 5 s timeout (not `_requestTimeoutMs`)
 * so a hung sidecar never blocks the maintenance page.
 *
 * NEVER throws — a thrown error here would cascade into a broken card
 * (the AI panel is the only thing that reports sidecar status, so it
 * must always render). On failure returns `{ ok: false, error }`.
 */
export async function health() {
    _bootstrapFromEnv();
    const url = getSidecarUrl();
    if (!url) return { ok: false, error: 'sidecar_url_unset' };
    const now = Date.now();
    if (_healthCache && _healthCache.expiresAt > now) {
        return _healthCache.value;
    }
    let value;
    let lastErr = null;
    for (let attempt = 0; attempt < HEALTH_PROBE_RETRIES; attempt++) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS);
            let res;
            try {
                res = await globalThis.fetch(`${url}/health`, {
                    method: 'GET',
                    signal: ctrl.signal,
                });
            } finally {
                clearTimeout(timer);
            }
            if (!res.ok) {
                lastErr = new Error(`http_${res.status}`);
                // 5xx is retryable; 4xx is a final answer.
                if (res.status < 500) {
                    value = { ok: false, error: `http_${res.status}` };
                    break;
                }
                continue;
            }
            const body = await res.json();
            value = {
                ok: body?.ok === true,
                version: body?.version ?? null,
                model: body?.model ?? null,
                dim: body?.dim ?? null,
                ready: body?.ready === true,
                // Forward the new diagnostic fields (Phase 6) so the AI
                // maintenance card can render real state instead of just
                // a green dot. Older sidecars (pre-Track-I) don't ship
                // these — leave them null so the UI knows to fall back.
                providersResolved: Array.isArray(body?.providers_resolved)
                    ? body.providers_resolved.slice()
                    : null,
                providersRequested: body?.providers_requested ?? null,
                detSize: Number.isFinite(body?.det_size) ? body.det_size : null,
                platform: typeof body?.platform === 'string' ? body.platform : null,
                python: typeof body?.python === 'string' ? body.python : null,
            };
            lastErr = null;
            break;
        } catch (e) {
            lastErr = e;
        }
    }
    if (value === undefined) {
        value = { ok: false, error: lastErr?.message || String(lastErr) };
    }
    _healthCache = { value, expiresAt: now + _healthCacheTtlMs };
    return value;
}

/**
 * Detect faces in one image via the sidecar. Path mode first; on
 * `403 path_not_allowed` falls back to b64 mode (POSTs the bytes
 * directly — needed for Docker installs where the sidecar container
 * cannot see host-side paths).
 *
 * @param {string} absPath absolute path to the source image
 * @param {object} cfg     `advanced.ai` config slice
 * @param {function?} onLog optional `({source, level, msg}) => void`
 * @returns {Promise<Array | null>}
 */
export async function detectFaces(absPath, cfg = {}, onLog = null) {
    _bootstrapFromEnv();
    const url = getSidecarUrl();
    if (!url) {
        _log(onLog, 'warn', 'sidecar URL unset — detectFaces returning null');
        return null;
    }
    // Resolve detection thresholds with the same precedence as the rest of
    // the stack: explicit `cfg.faces.*` > legacy flat alias > env override >
    // hardcoded default. The caller passes `cfg.advanced.ai` (or the
    // already-flattened `cfg`), so we probe both shapes.
    const facesCfg = cfg?.faces || cfg || {};
    const minScore = _pickNumber([cfg?.minDetectionScore, facesCfg.minDetectionScore], 0.5);
    const minBoxPx = _pickNumber([cfg?.minFaceSizePx, facesCfg.minFaceSizePx], 60);
    const arRange =
        Array.isArray(facesCfg.arRange) && facesCfg.arRange.length === 2
            ? facesCfg.arRange
            : [0.5, 2.0];

    const baseBody = { min_score: minScore, min_box_px: minBoxPx, ar_range: arRange };
    const pathBody = { ...baseBody, path: absPath };

    // Concurrency gate — operator can cap inflight detects on shared NAS
    // hardware where running 16 simultaneous detections OOMs the box.
    // 0 = unlimited (default).
    if (_maxConcurrency > 0) {
        while (_inflight >= _maxConcurrency) {
            await _sleep(25);
        }
    }
    _inflight++;
    try {
        return await _detectInner(absPath, pathBody, baseBody, url, onLog);
    } finally {
        _inflight = Math.max(0, _inflight - 1);
    }
}

/**
 * Detect faces in a batch of images via the sidecar's `/detect/batch`
 * endpoint — one HTTP round-trip for up to `batchSize` files.
 *
 * @param {string[]}  absPaths absolute paths to source images
 * @param {object}    cfg      `advanced.ai` config slice
 * @param {function?} onLog    optional `({source, level, msg}) => void`
 * @returns {Promise<Array<Array|null>>} same order as input;
 *   `null`  = sidecar error / path unresolvable
 *   `[]`    = processed but no faces found
 *   `[…]`  = detected faces
 *   Items rejected with `path_not_allowed` (Docker sandbox) are retried
 *   individually via the single-detect b64 fallback path.
 */
export async function detectFacesBatch(absPaths, cfg = {}, onLog = null, signal = null) {
    _bootstrapFromEnv();
    if (!absPaths.length) return [];
    const url = getSidecarUrl();
    if (!url) {
        _log(onLog, 'warn', 'sidecar URL unset — detectFacesBatch returning nulls');
        return absPaths.map(() => null);
    }

    // Path mode already known to fail — detect individually via b64.
    if (_pathRejectedLogged) {
        const out = [];
        for (const p of absPaths) {
            if (signal?.aborted) {
                out.push(null);
                continue;
            }
            out.push(await detectFaces(p, cfg, onLog));
        }
        return out;
    }

    const facesCfg = cfg?.faces || cfg || {};
    const minScore = _pickNumber([cfg?.minDetectionScore, facesCfg.minDetectionScore], 0.5);
    const minBoxPx = _pickNumber([cfg?.minFaceSizePx, facesCfg.minFaceSizePx], 60);
    const arRange =
        Array.isArray(facesCfg.arRange) && facesCfg.arRange.length === 2
            ? facesCfg.arRange
            : [0.5, 2.0];

    // Sidecar processes the batch sequentially — scale timeout with count.
    const batchTimeoutMs = Math.max(absPaths.length * _requestTimeoutMs, 120_000);
    const body = { files: absPaths, min_score: minScore, min_box_px: minBoxPx, ar_range: arRange };

    let batchRes;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), batchTimeoutMs);
        if (signal) {
            if (signal.aborted) ctrl.abort();
            else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
        }
        try {
            batchRes = await globalThis.fetch(`${url}/detect/batch`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal,
                dispatcher: _dispatcherFor(batchTimeoutMs),
            });
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        _log(onLog, 'warn', `detectFacesBatch: network error — ${e?.message || e}`);
        return absPaths.map(() => null);
    }

    if (!batchRes.ok) {
        _log(onLog, 'warn', `detectFacesBatch: sidecar returned ${batchRes.status}`);
        return absPaths.map(() => null);
    }

    let batchBody;
    try {
        batchBody = await batchRes.json();
    } catch (e) {
        _log(onLog, 'warn', `detectFacesBatch: invalid JSON — ${e?.message || e}`);
        return absPaths.map(() => null);
    }

    const resultMap = new Map();
    for (const item of batchBody?.results ?? []) {
        resultMap.set(item.file, item);
    }

    const output = new Array(absPaths.length).fill(null);
    const pathFallbacks = [];

    for (let i = 0; i < absPaths.length; i++) {
        const item = resultMap.get(absPaths[i]);
        if (!item) continue; // path missing from response → null
        if (item.error === 'path_not_allowed') {
            pathFallbacks.push(i);
            continue;
        }
        if (item.error) {
            // decode_failed is expected for animated/compressed non-image files
            // (e.g. gzip-wrapped Telegram sticker documents with a .webp extension).
            // Log at info to keep the log feed clean; other soft errors stay at warn.
            const lvl = item.error === 'decode_failed' ? 'info' : 'warn';
            _log(onLog, lvl, `batch detect ${absPaths[i]}: sidecar soft-error="${item.error}"`);
            output[i] = []; // soft error → empty (sidecar reached the file)
            continue;
        }
        output[i] = _parseFacesList(item.faces);
    }

    if (pathFallbacks.length) {
        _log(onLog, 'info', 'path mode rejected by sidecar; switching to b64 for all files');
        _pathRejectedLogged = true;
    }
    for (const idx of pathFallbacks) {
        output[idx] = await detectFaces(absPaths[idx], cfg, onLog);
    }

    return output;
}

/**
 * Detect faces in a video file via the sidecar's `/detect/video` endpoint.
 * Frames are extracted and deduplicated server-side — no temp files on disk.
 * The returned faces land in the same `faces` table as photo-source faces,
 * so DBSCAN Phase B clusters them together automatically.
 *
 * @param {string}    absPath absolute path to the video file
 * @param {object}    cfg     `advanced.ai` config slice
 * @param {function?} onLog   optional `({source, level, msg}) => void`
 * @param {AbortSignal?} signal
 * @param {function?} onVideoProgress optional `({path, frames_decoded,
 *   total_frames, pct, elapsed_sec}) => void`, called roughly every
 *   `videoProgressPollMs` while the request is in flight — see
 *   docs/AI.md "video scan progress reporting". Best-effort: a poll
 *   failure (network hiccup, sidecar too old to know `job_id`, or the
 *   request already finished) never throws and never affects the
 *   returned faces. Omit to skip polling entirely (zero extra requests).
 * @returns {Promise<Array | null>}
 *   `null` = sidecar error / file unresolvable
 *   `[]`   = processed but no faces found
 *   `[…]` = detected unique faces (one embedding per person per video)
 */
export async function detectFacesInVideo(
    absPath,
    cfg = {},
    onLog = null,
    signal = null,
    onVideoProgress = null,
) {
    _bootstrapFromEnv();
    const url = getSidecarUrl();
    if (!url) {
        _log(onLog, 'warn', 'sidecar URL unset — detectFacesInVideo returning null');
        return null;
    }

    // Path mode already known to fail — skip straight to b64 fallback.
    // (Progress polling isn't wired for the b64 fallback — see docs/AI.md.)
    if (_pathRejectedLogged) {
        return _detectVideoB64Fallback(absPath, cfg, url, onLog, signal);
    }

    const facesCfg = cfg?.faces || cfg || {};
    const minScore = _pickNumber([cfg?.minDetectionScore, facesCfg.minDetectionScore], 0.5);
    const minBoxPx = _pickNumber([cfg?.minFaceSizePx, facesCfg.minFaceSizePx], 60);
    const arRange =
        Array.isArray(facesCfg.arRange) && facesCfg.arRange.length === 2
            ? facesCfg.arRange
            : [0.5, 2.0];
    // `videoMaxFrames` is a pure runaway-safety ceiling (§4.1/§5/§6), not a
    // density control or a frame-count estimate — resolved the same way as
    // every other faces.* knob (env > config > default) instead of the old
    // ad-hoc direct-property read.
    const maxFrames = _pickNumber(
        [resolveFacesValue('videoMaxFrames', facesCfg), cfg?.videoMaxFrames],
        20000,
    );
    const videoNice = Math.max(
        0,
        Math.min(
            19,
            _pickNumber([resolveFacesValue('videoNice', facesCfg), facesCfg.videoNice], 0) | 0,
        ),
    );

    // A `job_id` is only generated (and only sent to the sidecar) when the
    // caller actually wants progress updates — an older/simpler caller that
    // doesn't pass `onVideoProgress` gets the exact previous wire format.
    const jobId = typeof onVideoProgress === 'function' ? randomUUID() : null;

    const body = {
        path: absPath,
        min_score: minScore,
        min_box_px: minBoxPx,
        ar_range: arRange,
        max_frames: Math.max(1, Math.min(200_000, maxFrames)),
        // Always send so dashboard videoNice=0 can override a sidecar
        // TGDL_FACES_VIDEO_NICE env pin (request beats env on the Python side).
        nice: videoNice,
        ...(jobId ? { job_id: jobId } : {}),
    };

    // Video detection is much slower than a single image, and now that
    // `max_frames` is a safety ceiling rather than a frame-count estimate
    // (a video can legitimately take thousands of detection calls, §3/§6)
    // it's no longer a sane timeout multiplier — scaling by it would turn
    // a 20000 ceiling into a multi-day timeout. Use a fixed generous
    // ceiling instead (2h — matches what the old 120-frame default already
    // computed).
    const videoTimeoutMs = Math.max(_requestTimeoutMs, VIDEO_REQUEST_TIMEOUT_MS_FLOOR);

    // Poll GET /detect/video/status/{job_id} on a short interval for the
    // whole lifetime of the main request — cleared in the `finally` below
    // no matter which path the main request exits through.
    let pollTimer = null;
    if (jobId) {
        const pollMs = Math.max(
            1000,
            _pickNumber(
                [resolveFacesValue('videoProgressPollMs', facesCfg), cfg?.videoProgressPollMs],
                5000,
            ),
        );
        const pollState = { inFlight: false };
        pollTimer = setInterval(
            () => _pollVideoProgress(url, jobId, absPath, onVideoProgress, pollState),
            pollMs,
        );
    }

    try {
        let res;
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), videoTimeoutMs);
            if (signal) {
                if (signal.aborted) ctrl.abort();
                else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
            }
            try {
                res = await globalThis.fetch(`${url}/detect/video`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: ctrl.signal,
                    dispatcher: _dispatcherFor(videoTimeoutMs),
                });
            } finally {
                clearTimeout(timer);
            }
        } catch (e) {
            _log(
                onLog,
                'warn',
                `detectFacesInVideo: network error for ${absPath} — ${e?.message || e}`,
            );
            return null;
        }

        if (res.status === 403) {
            let code = null;
            try {
                const body = await res.clone().json();
                code = body?.code || null;
            } catch {}
            if (code === 'path_not_allowed') {
                if (!_pathRejectedLogged) {
                    _log(
                        onLog,
                        'info',
                        'video path mode rejected by sidecar; switching to b64 fallback for all files',
                    );
                    _pathRejectedLogged = true;
                }
                return _detectVideoB64Fallback(absPath, cfg, url, onLog, signal);
            }
            _log(onLog, 'warn', `detectFacesInVideo: sidecar returned 403 for ${absPath}`);
            return null;
        }

        if (!res.ok) {
            _log(
                onLog,
                'warn',
                `detectFacesInVideo: sidecar returned ${res.status} for ${absPath}`,
            );
            return null;
        }

        let resBody;
        try {
            resBody = await res.json();
        } catch (e) {
            _log(
                onLog,
                'warn',
                `detectFacesInVideo: invalid JSON from sidecar: ${e?.message || e}`,
            );
            return null;
        }

        if (resBody?.error) {
            const lvl = resBody.error === 'file_not_found' ? 'warn' : 'info';
            _log(
                onLog,
                lvl,
                `detectFacesInVideo ${absPath}: sidecar soft-error="${resBody.error}"`,
            );
            return [];
        }

        return _parseFacesList(Array.isArray(resBody?.faces) ? resBody.faces : []);
    } finally {
        if (pollTimer) clearInterval(pollTimer);
    }
}

/**
 * One progress-poll tick for `detectFacesInVideo`. Fire-and-forget from a
 * `setInterval` callback (never awaited by the caller) — `pollState.inFlight`
 * skips a tick if the previous poll is still in flight (e.g. a slow/stalled
 * sidecar), so overlapping GETs can't pile up. Any failure — network error,
 * non-2xx (404 once the job is done, or a sidecar too old to know `job_id`),
 * invalid JSON — is swallowed: this is best-effort telemetry only.
 */
async function _pollVideoProgress(url, jobId, absPath, onVideoProgress, pollState) {
    if (pollState.inFlight) return;
    pollState.inFlight = true;
    try {
        const res = await _fetchWithTimeout(`${url}/detect/video/status/${jobId}`);
        if (!res || !res.ok) return;
        const p = await res.json();
        onVideoProgress({ path: absPath, ...p });
    } catch {
        // best-effort telemetry — never propagate.
    } finally {
        pollState.inFlight = false;
    }
}

async function _sendB64(absPath, baseBody, url, onLog) {
    let bytes;
    try {
        bytes = await fs.readFile(absPath);
    } catch (e) {
        _log(onLog, 'warn', `b64 read failed for ${absPath}: ${e?.message || e}`);
        return null;
    }
    const b64Body = { ...baseBody, image_b64: Buffer.from(bytes).toString('base64') };
    try {
        return await _postWithRetry(`${url}/detect`, b64Body, onLog);
    } catch (e) {
        _log(onLog, 'warn', `detect b64-mode failed for ${absPath}: ${e?.message || e}`);
        return null;
    }
}

async function _detectInner(absPath, pathBody, baseBody, url, onLog) {
    let res;

    if (_pathRejectedLogged) {
        res = await _sendB64(absPath, baseBody, url, onLog);
        if (res === null) return null;
    } else {
        try {
            res = await _postWithRetry(`${url}/detect`, pathBody, onLog);
        } catch (e) {
            _log(onLog, 'warn', `detect path-mode failed for ${absPath}: ${e?.message || e}`);
            return null;
        }

        if (res && res.status === 403) {
            let code = null;
            try {
                const body = await res.clone().json();
                code = body?.code || null;
            } catch {}
            if (code === 'path_not_allowed') {
                _log(
                    onLog,
                    'info',
                    'path mode rejected by sidecar; switching to b64 for all files',
                );
                _pathRejectedLogged = true;
                res = await _sendB64(absPath, baseBody, url, onLog);
                if (res === null) return null;
            }
        }
    }

    if (!res || !res.ok) {
        const status = res?.status ?? 'no_response';
        _log(onLog, 'warn', `detect ${absPath}: sidecar returned ${status}`);
        return null;
    }

    let body;
    try {
        body = await res.json();
    } catch (e) {
        _log(onLog, 'warn', `detect ${absPath}: invalid JSON from sidecar: ${e?.message || e}`);
        return null;
    }

    // The sidecar returns 200 + an `error` field for soft failures
    // (file_not_found, decode_failed). Log them so the scan summary
    // shows *why* a photo yielded 0 faces instead of silently moving on.
    if (body?.error) {
        _log(
            onLog,
            'warn',
            `detect ${absPath}: sidecar soft-error="${body.error}" — 0 faces stored`,
        );
    }
    return _parseFacesList(Array.isArray(body?.faces) ? body.faces : []);
}

// Parse a raw faces array from the sidecar into typed Face objects.
// Shared by both single-detect and batch paths.
function _parseFacesList(faces) {
    if (!Array.isArray(faces)) return [];
    return faces
        .map((f) => {
            // Embedding must be Float32Array — downstream (`_f32ToBlob`)
            // reads `.buffer` / `.byteLength`. A plain JS array breaks the
            // DB write silently (writes [object Array] as text).
            const emb = Array.isArray(f?.embedding) ? Float32Array.from(f.embedding) : null;
            if (!emb || !emb.length) return null;
            const out = {
                x: Number(f.x) || 0,
                y: Number(f.y) || 0,
                w: Number(f.w) || 0,
                h: Number(f.h) || 0,
                score: Number.isFinite(f.score) ? Number(f.score) : 0,
                qualityScore: Number.isFinite(f.quality_score) ? Number(f.quality_score) : null,
                landmarkRegularity: Number.isFinite(f.landmark_regularity)
                    ? Number(f.landmark_regularity)
                    : 0.5,
                embedding: emb,
            };
            if (f.landmarks != null) out.landmarks = f.landmarks;
            const fts = f.frame_time_sec ?? f.frameTimeSec;
            if (Number.isFinite(fts) && fts >= 0) out.frameTimeSec = Number(fts);
            return out;
        })
        .filter(Boolean);
}

/**
 * POST with linear-backoff retry on 5xx / network errors. 403 / 4xx
 * (except 408 / 429) return the response immediately so the caller can
 * inspect the body — those are not retryable.
 */
async function _postWithRetry(url, body, onLog) {
    const maxRetries = Math.max(1, _maxRetries);
    const base = _baseUrl(url);
    let lastErr = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        let bail = false;
        let bailReason = '';
        try {
            const res = await _fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            // Retry only on 5xx, 408, 429 — everything else (200/4xx) is
            // a final answer the caller needs to see.
            if (res.status >= 500 || res.status === 408 || res.status === 429) {
                lastErr = new Error(`sidecar http ${res.status}`);
            } else {
                return res;
            }
        } catch (e) {
            lastErr = e;
            if (attempt < maxRetries - 1) {
                if (e?.name === 'AbortError') {
                    // Client-side timeout: sidecar is alive but slow — don't retry
                    // (piling up requests against a slow CPU just makes it worse).
                    bail = true;
                    bailReason = `— timed out after ${_requestTimeoutMs}ms, skipping image`;
                } else {
                    // Network error: quick health probe to detect a crashed sidecar.
                    const alive = await _quickHealthProbe(base);
                    if (!alive) {
                        bail = true;
                        bailReason = '— sidecar unreachable, aborting';
                        _healthCache = null;
                    }
                }
            }
        }
        const hasMore = attempt < maxRetries - 1 && !bail;
        const backoff =
            _retryBackoffMs[attempt] ?? _retryBackoffMs[_retryBackoffMs.length - 1] ?? 300;
        const suffix = bail ? bailReason : hasMore ? `— retrying in ${backoff} ms` : '— giving up';
        _log(
            onLog,
            'warn',
            `sidecar POST ${url} attempt ${attempt + 1}/${maxRetries} failed: ${
                lastErr?.message || lastErr
            } ${suffix}`,
        );
        if (bail) break;
        if (hasMore) await _sleep(backoff);
    }
    throw lastErr || new Error('sidecar POST: retries exhausted');
}

/** Strip the endpoint path to get the sidecar base URL for health probing. */
function _baseUrl(endpointUrl) {
    try {
        const u = new URL(endpointUrl);
        return `${u.protocol}//${u.host}`;
    } catch {
        return endpointUrl.replace(/\/[^/]*$/, '');
    }
}

/**
 * Single-attempt health probe with a 1 s timeout. Used inside the retry
 * loop to detect a crashed sidecar without waiting for the full
 * `health()` cache TTL or its 3-retry budget.
 */
async function _quickHealthProbe(baseUrl) {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1000);
        try {
            const r = await globalThis.fetch(`${baseUrl}/health`, { signal: ctrl.signal });
            return r.ok;
        } finally {
            clearTimeout(t);
        }
    } catch {
        return false;
    }
}

/** fetch() with a hard timeout via AbortController. */
async function _fetchWithTimeout(url, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
        try {
            ctrl.abort();
        } catch {
            /* AbortController.abort() never throws but defend anyway */
        }
    }, _requestTimeoutMs);
    try {
        return await globalThis.fetch(url, {
            ...init,
            signal: ctrl.signal,
            dispatcher: _dispatcherFor(_requestTimeoutMs),
        });
    } finally {
        clearTimeout(timer);
    }
}

function _pickNumber(candidates, fallback) {
    for (const c of candidates) {
        if (Number.isFinite(c)) return c;
    }
    return fallback;
}

function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function _log(onLog, level, msg) {
    if (typeof onLog !== 'function') return;
    try {
        onLog({ source: 'ai-faces-client', level, msg });
    } catch {
        /* logging must never throw out of the client */
    }
}

// ---- Video b64 fallback (external sidecar without shared filesystem) ----

let _ffmpegBin = null;

async function _resolveFfmpegForFaces() {
    if (_ffmpegBin !== null) return _ffmpegBin;
    try {
        const mod = await import('../thumbs.js');
        _ffmpegBin = mod.resolveFfmpegBin();
    } catch {
        _ffmpegBin = 'ffmpeg';
    }
    return _ffmpegBin;
}

// Fixed sampling constants (docs/requirements.md §4.5 — the Node mirror of
// the Python §4.1 sampler). Deliberately NOT scaled by video duration.
//
//   DEFAULT_FLOOR_INTERVAL_SEC mirrors Python's constant of the same name
//                              (faces-service/tgdl_faces/io.py) — backstop
//                              for stretches where nothing ever triggers
//                              motion, not the primary recall mechanism.
//   DEFAULT_SCENE_THRESHOLD    is ffmpeg's own normalised (0..1) `scene`
//                              score, NOT the same scale as Python's 0-255
//                              luma-diff `motion_threshold` — the two
//                              detectors use different metrics, so this is
//                              tuned independently. Most in need of
//                              empirical tuning, like its Python cousin.
const DEFAULT_FLOOR_INTERVAL_SEC = 3.0;
const DEFAULT_SCENE_THRESHOLD = 0.1;
// Pure runaway-safety ceiling (mirrors Python's TGDL_FACES_VIDEO_MAX_FRAMES
// default) — not a density control, should never bind on a real video.
const MAX_FRAMES_SAFETY_CEILING = 20000;

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

/**
 * Stream content-adaptive JPEG frames from a video via one continuous
 * ffmpeg process — no per-frame process spawn, no `-ss` seeking (replaces
 * the old evenly-spaced-seek implementation; see docs/requirements.md
 * §4.5, the Node mirror of the Python §4.1 sampler).
 *
 * A single `select` filter combines both triggers using ffmpeg's
 * `prev_selected_t` variable so one filter graph does the job of the
 * Python sampler's window/floor/motion logic:
 *   - `isnan(prev_selected_t)`                        — always keep frame 0.
 *   - `gte(t-prev_selected_t, floorIntervalSec)`       — duration-independent
 *     floor: keep a frame once this much time has passed with nothing else
 *     triggering, regardless of video length.
 *   - `gt(scene, sceneThreshold)`                      — ffmpeg's built-in
 *     scene-change score; the motion-triggered component.
 *
 * This is an async generator: it yields raw JPEG `Buffer`s in temporal
 * order as they're parsed out of the `mjpeg`/`image2pipe` byte stream, so
 * a caller can process-and-discard each frame as it arrives instead of
 * buffering the whole video in memory (mirrors the Python streaming
 * pipeline, §4.2).
 */
async function* _extractVideoFrames(absPath, onLog, opts = {}) {
    const floorIntervalSec = opts.floorIntervalSec ?? DEFAULT_FLOOR_INTERVAL_SEC;
    const sceneThreshold = opts.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD;
    const maxFramesCeiling = opts.maxFramesCeiling ?? MAX_FRAMES_SAFETY_CEILING;
    const bin = await _resolveFfmpegForFaces();

    const selectExpr =
        `isnan(prev_selected_t)+gte(t-prev_selected_t\\,${floorIntervalSec})` +
        `+gt(scene\\,${sceneThreshold})`;
    const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        absPath,
        '-vf',
        `select='${selectExpr}'`,
        '-vsync',
        '0',
        '-f',
        'image2pipe',
        '-c:v',
        'mjpeg',
        '-q:v',
        '3',
        'pipe:1',
    ];

    let proc;
    try {
        const nice = Math.max(0, opts.nice ?? 0) | 0;
        if (nice > 0 && process.platform !== 'win32') {
            proc = spawn('nice', ['-n', String(Math.min(19, nice)), bin, ...args], {
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            });
        } else {
            proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        }
    } catch (e) {
        _log(onLog, 'warn', `video b64 fallback: failed to spawn ffmpeg — ${e?.message || e}`);
        return;
    }
    proc.on('error', (e) => {
        _log(onLog, 'warn', `video b64 fallback: ffmpeg process error — ${e?.message || e}`);
    });

    let buf = Buffer.alloc(0);
    let yielded = 0;
    try {
        for await (const chunk of proc.stdout) {
            buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
            let popped;
            while ((popped = _popJpegFrame(buf))) {
                buf = popped.rest;
                yield popped.bytes;
                if (++yielded >= maxFramesCeiling) return;
            }
        }
    } catch (e) {
        _log(onLog, 'warn', `video b64 fallback: ffmpeg stream read error — ${e?.message || e}`);
    } finally {
        try {
            proc.kill('SIGKILL');
        } catch {
            /* process may have already exited */
        }
    }
}

/** Pop one complete JPEG frame (SOI..EOI) off the front of `buf`, if any. */
function _popJpegFrame(buf) {
    const soi = buf.indexOf(JPEG_SOI);
    if (soi === -1) return null;
    const eoi = buf.indexOf(JPEG_EOI, soi + 2);
    if (eoi === -1) return null;
    return { bytes: buf.subarray(soi, eoi + 2), rest: buf.subarray(eoi + 2) };
}

// Track-confirmation thresholds — JS port of the Python `_build_face_tracks`
// (faces-service/tgdl_faces/app.py) per docs/requirements.md §4.4. Keep
// both in sync: same thresholds, same track-matching logic. Unlike
// `videoFloorIntervalSec`/`videoMaxFrames` (wired through faces-config.js
// in Phase 4), these have no matching Node config key by design (§5's
// table only lists Python env vars for them) — they stay fixed constants.
const TRACK_MATCH_THRESHOLD = 0.5; // unchanged from the old greedy dedup
const TRACK_MAX_REPRESENTATIVES = 3;
const TRACK_POSE_DEDUP_THRESHOLD = 0.85;
const SINGLETON_MIN_SCORE = 0.75;
const SINGLETON_MIN_QUALITY = 0.55;
const CONFIRMED_MIN_QUALITY = 0.35;
const CONFIRMED_MIN_SCORE = 0.5;
const MIN_LANDMARK_REGULARITY = 0.15;

/**
 * Merge per-frame detections into per-identity tracks and return the
 * faces worth keeping — JS port of the Python `_build_face_tracks`
 * (§4.4). Replaces the old greedy `_dedupeVideoFaces` (single
 * "keep highest score" per identity, no temporal-confirmation/quality
 * distinction).
 *
 * `framesFaces` is one detection array per *sampled frame*, in temporal
 * order (not a flat array) — this is what lets a track's hit-count
 * reflect "how many distinct frames corroborated this identity" rather
 * than a raw detection count.
 *
 * - A track confirmed by >= 2 frames is kept only if at least one of its
 *   faces clears `CONFIRMED_MIN_QUALITY` (0.35), `CONFIRMED_MIN_SCORE`
 *   (0.50), and `MIN_LANDMARK_REGULARITY` (0.15) — defends against a
 *   *systematic* false positive (the detector consistently misfiring on
 *   the same non-face texture) that mere repetition would otherwise wave
 *   through.
 * - A track seen in exactly 1 frame is kept only if that face clears the
 *   stricter `SINGLETON_MIN_SCORE`/`SINGLETON_MIN_QUALITY` bars (0.75 /
 *   0.55) plus the landmark regularity floor — otherwise dropped as
 *   unconfirmed noise.
 * - Confirmed tracks return up to 3 representative faces, see
 *   `_selectDiverseRepresentatives`.
 */
function _dedupeVideoFaces(framesFaces) {
    const tracks = []; // { faces: [], embSum: number[], hits: number }

    for (const frameFaces of framesFaces) {
        for (const face of frameFaces) {
            const emb = face.embedding;
            let bestI = -1;
            let bestSim = -1;
            for (let i = 0; i < tracks.length; i++) {
                const tr = tracks[i];
                const mean = _scaleVec(tr.embSum, 1 / Math.max(1, tr.hits));
                const norm = Math.sqrt(_dotProduct(mean, mean));
                const sim = norm > 1e-9 ? _dotProduct(emb, mean) / norm : -1;
                if (sim > bestSim) {
                    bestI = i;
                    bestSim = sim;
                }
            }
            if (bestI >= 0 && bestSim >= TRACK_MATCH_THRESHOLD) {
                const tr = tracks[bestI];
                tr.faces.push(face);
                tr.embSum = _addVec(tr.embSum, emb);
                tr.hits += 1;
            } else {
                tracks.push({ faces: [face], embSum: Array.from(emb), hits: 1 });
            }
        }
    }

    const kept = [];
    for (const tr of tracks) {
        const faces = tr.faces;
        if (tr.hits >= 2) {
            const bestQuality = Math.max(...faces.map((f) => _qualityOf(f)));
            const bestScore = Math.max(...faces.map((f) => f.score || 0));
            const bestRegularity = Math.max(...faces.map((f) => _regularityOf(f)));
            if (
                bestQuality < CONFIRMED_MIN_QUALITY ||
                bestScore < CONFIRMED_MIN_SCORE ||
                bestRegularity < MIN_LANDMARK_REGULARITY
            ) {
                continue;
            }
            kept.push(
                ..._selectDiverseRepresentatives(faces, TRACK_MAX_REPRESENTATIVES, {
                    minQuality: CONFIRMED_MIN_QUALITY,
                    minScore: CONFIRMED_MIN_SCORE,
                    minRegularity: MIN_LANDMARK_REGULARITY,
                }),
            );
        } else {
            const face = faces[0];
            if (
                face.score >= SINGLETON_MIN_SCORE &&
                _qualityOf(face) >= SINGLETON_MIN_QUALITY &&
                _regularityOf(face) >= MIN_LANDMARK_REGULARITY
            ) {
                kept.push(face);
            }
        }
    }
    return kept;
}

function _qualityOf(face) {
    return Number.isFinite(face.qualityScore) ? face.qualityScore : 0;
}

function _regularityOf(face) {
    return Number.isFinite(face.landmarkRegularity) ? face.landmarkRegularity : 0.5;
}

/**
 * Pick up to `limit` faces from one confirmed track, highest score first,
 * skipping any pose that's a near-duplicate (cosine similarity >= 0.85) of
 * an already-kept face — preserves angle/pose diversity instead of
 * collapsing the whole track down to one embedding.
 *
 * Only faces clearing `minQuality`, `minScore`, and `minRegularity` are
 * eligible — weaker frames in an admitted track are dropped here.
 */
function _selectDiverseRepresentatives(faces, limit = TRACK_MAX_REPRESENTATIVES, floors = {}) {
    const minQuality = floors.minQuality ?? 0;
    const minScore = floors.minScore ?? 0;
    const minRegularity = floors.minRegularity ?? 0;
    const eligible = faces.filter(
        (f) =>
            _qualityOf(f) >= minQuality &&
            (f.score || 0) >= minScore &&
            _regularityOf(f) >= minRegularity,
    );
    const ordered = [...eligible].sort((a, b) => b.score - a.score);
    const kept = [];
    const keptEmbs = [];
    for (const face of ordered) {
        const emb = face.embedding;
        if (keptEmbs.some((k) => _dotProduct(emb, k) >= TRACK_POSE_DEDUP_THRESHOLD)) continue;
        kept.push(face);
        keptEmbs.push(emb);
        if (kept.length >= limit) break;
    }
    return kept;
}

function _dotProduct(a, b) {
    let sum = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) sum += a[i] * b[i];
    return sum;
}

function _addVec(a, b) {
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
    return out;
}

function _scaleVec(a, s) {
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] * s;
    return out;
}

/**
 * Video b64 fallback: stream frames locally from ffmpeg (`_extractVideoFrames`)
 * and dispatch each small window of frames to the sidecar as it fills
 * (`_streamFramesToSidecar`), discarding raw JPEG bytes immediately after
 * — mirrors the Python streaming pipeline (§4.2) so memory usage here
 * doesn't scale with video length either. Then applies the same
 * track-confirmation dedup (`_dedupeVideoFaces`, §4.4) as the primary
 * sidecar path.
 */
async function _detectVideoB64Fallback(absPath, cfg, url, onLog, signal) {
    const facesCfg = cfg?.faces || cfg || {};
    const minScore = _pickNumber([cfg?.minDetectionScore, facesCfg.minDetectionScore], 0.5);
    const minBoxPx = _pickNumber([cfg?.minFaceSizePx, facesCfg.minFaceSizePx], 60);
    const arRange =
        Array.isArray(facesCfg.arRange) && facesCfg.arRange.length === 2
            ? facesCfg.arRange
            : [0.5, 2.0];
    const floorIntervalSec = _pickNumber(
        [resolveFacesValue('videoFloorIntervalSec', facesCfg)],
        DEFAULT_FLOOR_INTERVAL_SEC,
    );
    const maxFramesCeiling = _pickNumber(
        [resolveFacesValue('videoMaxFrames', facesCfg)],
        MAX_FRAMES_SAFETY_CEILING,
    );
    const videoNice = Math.max(
        0,
        _pickNumber([resolveFacesValue('videoNice', facesCfg), facesCfg.videoNice], 0) | 0,
    );

    _log(onLog, 'info', `video b64 fallback: streaming frames from ${absPath}`);
    const frameGen = _extractVideoFrames(absPath, onLog, {
        floorIntervalSec,
        maxFramesCeiling,
        nice: videoNice,
    });
    const framesFaces = await _streamFramesToSidecar(
        frameGen,
        { minScore, minBoxPx, arRange },
        url,
        onLog,
        signal,
        (sampleIdx) => sampleIdx * floorIntervalSec,
    );

    if (!framesFaces.length) {
        _log(onLog, 'warn', `video b64 fallback: no frames extracted for ${absPath}`);
        return [];
    }
    _log(onLog, 'info', `video b64 fallback: processed ${framesFaces.length} frames`);
    return _dedupeVideoFaces(framesFaces);
}

const STREAM_BATCH_SIZE = 8;

/**
 * Consume `frameGen` (an async-iterable of raw JPEG `Buffer`s — normally
 * `_extractVideoFrames`'s generator) in small windows, sending each window
 * to `/detect/batch-b64` as soon as it fills and discarding the raw bytes
 * right after — peak memory is tied to `STREAM_BATCH_SIZE`, not to how
 * many frames the video yields (§4.2). Falls back to sequential `/detect`
 * per-frame the first time `/detect/batch-b64` turns out to be unavailable
 * (404/405/network error — older sidecar).
 *
 * Returns `framesFaces`: one detection array per frame, in temporal order
 * — the shape `_dedupeVideoFaces` expects.
 */
async function _streamFramesToSidecar(
    frameGen,
    opts,
    url,
    onLog,
    signal,
    frameTimeForSample = null,
) {
    const framesFaces = [];
    let batch = [];
    let batchB64Available = true;
    let sampleIdx = 0;

    const tagFaces = (faces) => {
        if (typeof frameTimeForSample !== 'function') return faces;
        const t = frameTimeForSample(sampleIdx);
        sampleIdx += 1;
        if (!Number.isFinite(t) || t < 0) return faces;
        return faces.map((f) => ({ ...f, frameTimeSec: t }));
    };

    const flush = async () => {
        if (!batch.length) return;
        const toSend = batch;
        batch = [];
        if (batchB64Available) {
            const result = await _sendBatchB64Chunk(toSend, opts, url, onLog, signal);
            if (result !== null) {
                for (const frameFaces of result) {
                    framesFaces.push(tagFaces(frameFaces));
                }
                return;
            }
            batchB64Available = false;
            _log(onLog, 'info', 'batch-b64 unavailable, falling back to sequential /detect');
        }
        for (const buf of toSend) {
            framesFaces.push(tagFaces(await _detectOneFrameB64(buf, opts, url, onLog)));
        }
    };

    for await (const frameBuf of frameGen) {
        if (signal?.aborted) break;
        batch.push(frameBuf);
        if (batch.length >= STREAM_BATCH_SIZE) await flush();
    }
    if (!signal?.aborted) await flush();
    return framesFaces;
}

/**
 * Send one window of raw JPEG frames to `/detect/batch-b64`. Returns
 * `null` when the endpoint itself is unavailable (404/405/network error)
 * — the caller's signal to switch to the sequential fallback — or an
 * array of per-frame face arrays (same length/order as `chunk`) otherwise.
 */
async function _sendBatchB64Chunk(chunk, { minScore, minBoxPx, arRange }, url, onLog, signal) {
    if (signal?.aborted) return chunk.map(() => []);
    const body = {
        images: chunk.map((buf) => buf.toString('base64')),
        min_score: minScore,
        min_box_px: minBoxPx,
        ar_range: arRange,
    };
    const timeoutMs = Math.max(chunk.length * _requestTimeoutMs, 60_000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    let res;
    try {
        res = await globalThis.fetch(`${url}/detect/batch-b64`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
            dispatcher: _dispatcherFor(timeoutMs),
        });
    } catch (e) {
        _log(onLog, 'warn', `batch-b64 request failed — ${e?.message || e}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
    if (res.status === 404 || res.status === 405) return null;
    if (!res.ok) return chunk.map(() => []);
    let resBody;
    try {
        resBody = await res.json();
    } catch {
        return chunk.map(() => []);
    }
    const results = Array.isArray(resBody?.results) ? resBody.results : [];
    return chunk.map((_buf, i) => {
        const item = results[i];
        if (!item || item.error) return [];
        return _parseFacesList(Array.isArray(item.faces) ? item.faces : []);
    });
}

async function _detectOneFrameB64(frameBuf, { minScore, minBoxPx, arRange }, url, onLog) {
    const b64Body = {
        image_b64: frameBuf.toString('base64'),
        min_score: minScore,
        min_box_px: minBoxPx,
        ar_range: arRange,
    };
    let res;
    try {
        res = await _postWithRetry(`${url}/detect`, b64Body, onLog);
    } catch {
        return [];
    }
    if (!res || !res.ok) return [];
    let resBody;
    try {
        resBody = await res.json();
    } catch {
        return [];
    }
    return _parseFacesList(Array.isArray(resBody?.faces) ? resBody.faces : []);
}

/** Test-only: clear cached URL + health probe so each spec starts fresh. */
export function _resetForTests() {
    _sidecarUrl = '';
    _healthCache = null;
    _healthCacheTtlMs = HEALTH_CACHE_TTL_MS_DEFAULT;
    _requestTimeoutMs = REQUEST_TIMEOUT_MS_DEFAULT;
    _maxRetries = MAX_RETRIES_DEFAULT;
    _retryBackoffMs = RETRY_BACKOFF_MS_DEFAULT.slice();
    _maxConcurrency = 0;
    _inflight = 0;
    _envBootstrapped = false;
    _pathRejectedLogged = false;
    _ffmpegBin = null;
    _dispatcherCache.clear();
}

/** Test-only: snapshot the resolved runtime knobs. */
export function _runtimeKnobs() {
    return {
        healthCacheTtlMs: _healthCacheTtlMs,
        requestTimeoutMs: _requestTimeoutMs,
        maxRetries: _maxRetries,
        retryBackoffMs: _retryBackoffMs.slice(),
        sidecarMaxConcurrency: _maxConcurrency,
    };
}

// Test-only exports for the video b64-fallback internals (§4.4/§4.5) —
// mirrors how faces-service/tests/test_video.py unit-tests
// `_build_face_tracks`/`extract_video_frames` directly rather than only
// through the full HTTP flow.
export { _extractVideoFrames, _dedupeVideoFaces, _streamFramesToSidecar };

// Test-only: the undici dispatcher factory that keeps every long-running
// fetch's headers/body timeout in sync with its AbortController timeout
// (see the comment above `_dispatcherFor`'s definition).
export { _dispatcherFor };
