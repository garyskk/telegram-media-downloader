/**
 * HTTP client for the seekbar-service Go sidecar.
 *
 * Mirrors the shape of `src/core/ai/faces-client.js`: a module-scoped
 * URL + bearer token, set once by the spawn module at boot, consumed
 * by the per-row generator and the maintenance routes.
 */

let _baseUrl = '';
let _token = '';

export function setSidecarUrl(url, token = '') {
    _baseUrl = String(url || '').replace(/\/+$/, '');
    _token = String(token || '');
}

export function getSidecarUrl() {
    return _baseUrl;
}

function _headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (_token) h['X-API-Token'] = _token;
    return h;
}

async function _fetch(path, opts = {}) {
    if (!_baseUrl) throw new Error('seekbar sidecar URL not configured');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 120_000);
    // Forward external abort signal so JobTracker cancellation kills
    // in-flight HTTP requests immediately instead of waiting for the
    // sidecar's 10-minute processing timeout.
    if (opts.signal) {
        if (opts.signal.aborted) {
            ctrl.abort();
        } else {
            opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
        }
    }
    try {
        const r = await fetch(_baseUrl + path, {
            ...opts,
            signal: ctrl.signal,
            headers: _headers(opts.headers || {}),
        });
        const ct = r.headers.get('content-type') || '';
        const body = ct.includes('json') ? await r.json() : await r.text();
        if (!r.ok) {
            const msg = typeof body === 'string' ? body : body?.error || `HTTP ${r.status}`;
            const err = new Error(msg);
            err.status = r.status;
            err.body = body;
            throw err;
        }
        return body;
    } finally {
        clearTimeout(t);
    }
}

/**
 * Probe the sidecar's `/health` endpoint with a 5 s timeout.
 * Retries up to 3 times on network errors / 5xx before returning
 * a failure so a single transient blip doesn't flip the status card
 * red on the maintenance page.
 *
 * NEVER throws — returns `{ ok: false, error }` on failure.
 */
export async function health() {
    const maxAttempts = 3;
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const result = await _fetch('/health', { method: 'GET', timeoutMs: 5_000 });
            return result;
        } catch (e) {
            lastErr = e;
        }
    }
    return { ok: false, error: lastErr?.message || String(lastErr) };
}

/**
 * Submit one video. The Go service returns the metadata row (or a
 * pending stub when `async:true`).
 *
 * `cfg` is an optional config overlay forwarded as per-job params —
 * allows runtime config changes to take effect without restarting the
 * sidecar (the sidecar merges job-level overrides on top of its env
 * defaults). Unknown fields are silently ignored by older sidecars so
 * callers can always forward the full cfg snapshot.
 */
export async function submitOne({
    videoId,
    srcPath,
    priority = 1,
    async = false,
    cfg = null,
    signal = null,
}) {
    const body = {
        video_id: String(videoId),
        path: String(srcPath),
        priority: Number(priority) || 0,
        async: !!async,
    };
    if (cfg && typeof cfg === 'object') {
        if (Number.isFinite(cfg.intervalSec) && cfg.intervalSec > 0) {
            body.interval_sec = cfg.intervalSec;
        }
        if (Number.isFinite(cfg.tileWidth) && cfg.tileWidth > 0) {
            body.tile_w = cfg.tileWidth;
        }
        if (Number.isFinite(cfg.columns) && cfg.columns > 0) {
            body.cols = cfg.columns;
        }
        if (Number.isFinite(cfg.maxTiles) && cfg.maxTiles > 0) {
            body.max_tiles = cfg.maxTiles;
        }
        if (cfg.format) {
            body.format = String(cfg.format);
        }
        if (Number.isFinite(cfg.quality) && cfg.quality > 0) {
            body.quality = cfg.quality;
        }
    }
    return _fetch('/v1/sprite', {
        method: 'POST',
        body: JSON.stringify(body),
        // Async submit is a short enqueue; sync waits up to 60s on the
        // sidecar then returns. Neither needs the old 10-minute hang.
        timeoutMs: async ? 30_000 : 90_000,
        signal,
    });
}

export async function getJob(jobId, opts = {}) {
    return _fetch(`/v1/jobs/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        timeoutMs: opts.timeoutMs || 15_000,
        signal: opts.signal || null,
    });
}

const _TERMINAL_JOB = new Set(['done', 'failed', 'cancelled', 'error']);

/**
 * Poll GET /v1/jobs/:id until the sidecar job reaches a terminal status
 * or `timeoutMs` elapses. Short GETs avoid Go WriteTimeout / undici
 * bodyTimeout ceilings that make a single long sync POST unusable for
 * 1h+ clips.
 *
 * Throws `ffmpeg timeout Ns` (transient — not a no-stream error) when
 * the budget runs out while the job is still pending/running.
 */
export async function waitForJob(jobId, { timeoutMs, signal, pollMs = 1000 } = {}) {
    const id = String(jobId || '');
    if (!id) throw new Error('job id required');
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5 * 60_000;
    const interval = Math.max(1, Number(pollMs) || 1000);
    const deadline = Date.now() + budget;
    let last = null;
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
        }
        try {
            last = await getJob(id, { signal });
            const status = String(last?.status || '').toLowerCase();
            if (_TERMINAL_JOB.has(status)) return last;
        } catch (e) {
            if (e?.status === 404) throw e;
            if (signal?.aborted || e?.name === 'AbortError') throw e;
            last = e;
        }
        const wait = Math.min(interval, Math.max(0, deadline - Date.now()));
        if (wait <= 0) break;
        await new Promise((r) => setTimeout(r, wait));
    }
    const sec = Math.max(1, Math.round(budget / 1000));
    throw new Error(`ffmpeg timeout ${sec}s`);
}

export async function submitBatch(items) {
    return _fetch('/v1/batch', {
        method: 'POST',
        body: JSON.stringify({ items }),
        timeoutMs: 60_000,
    });
}

export async function deleteSprite(videoId) {
    return _fetch(`/v1/sprite/${encodeURIComponent(videoId)}`, {
        method: 'DELETE',
        timeoutMs: 15_000,
    });
}

export async function probeHwaccel() {
    return _fetch('/v1/hwaccel', { method: 'GET', timeoutMs: 30_000 });
}

export async function stats() {
    return _fetch('/v1/stats', { method: 'GET', timeoutMs: 5_000 });
}
