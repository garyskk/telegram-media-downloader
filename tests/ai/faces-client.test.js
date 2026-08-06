// Track I — faces-client env overrides + retry behaviour with mocked
// fetch. The full integration is exercised against a live sidecar (gated
// by FACES_SERVICE_URL); these tests pin the wire shape + env-driven
// knobs so a future refactor can't silently drop them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as client from '../../src/core/ai/faces-client.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('TGDL_FACES_')) delete process.env[k];
    }
    client._resetForTests();
});

afterEach(() => {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('TGDL_FACES_')) delete process.env[k];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    vi.restoreAllMocks();
});

describe('setSidecarUrl / getSidecarUrl', () => {
    it('trims and normalises trailing slashes', () => {
        client.setSidecarUrl('http://host:8011/');
        expect(client.getSidecarUrl()).toBe('http://host:8011');
        client.setSidecarUrl('');
        expect(client.getSidecarUrl()).toBeNull();
    });
});

describe('health() — basic + enriched fields', () => {
    it('returns sidecar_url_unset when URL is empty', async () => {
        const h = await client.health();
        expect(h.ok).toBe(false);
        expect(h.error).toBe('sidecar_url_unset');
    });

    it('parses enriched Phase-6 fields from /health response', async () => {
        client.setSidecarUrl('http://host:8011');
        const body = {
            ok: true,
            version: '0.1.0',
            model: 'buffalo_l',
            dim: 512,
            ready: true,
            providers_resolved: ['CoreMLExecutionProvider', 'CPUExecutionProvider'],
            providers_requested: 'auto',
            det_size: 640,
            platform: 'darwin/arm64',
            python: '3.12.4',
        };
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => body,
        });
        const h = await client.health();
        expect(h.ok).toBe(true);
        expect(h.providersResolved).toEqual(['CoreMLExecutionProvider', 'CPUExecutionProvider']);
        expect(h.providersRequested).toBe('auto');
        expect(h.detSize).toBe(640);
        expect(h.platform).toBe('darwin/arm64');
        expect(h.python).toBe('3.12.4');
    });

    it('older sidecars (no enriched fields) gracefully return nulls', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                ok: true,
                version: '0.0.9',
                model: 'buffalo_l',
                dim: 512,
                ready: true,
            }),
        });
        const h = await client.health();
        expect(h.providersResolved).toBeNull();
        expect(h.providersRequested).toBeNull();
        expect(h.detSize).toBeNull();
        expect(h.platform).toBeNull();
        expect(h.python).toBeNull();
    });

    it('caches the health probe within TTL', async () => {
        client.setSidecarUrl('http://host:8011');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        await client.health();
        await client.health();
        await client.health();
        // 3 calls but only 1 fetch because of the 5 s cache.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});

describe('applyFacesCfg + runtime knobs', () => {
    it('overrides health TTL / timeout / retries / backoff / concurrency', () => {
        client.applyFacesCfg({
            healthCacheTtlMs: 1234,
            requestTimeoutMs: 9999,
            maxRetries: 7,
            retryBackoffMs: [10, 20, 30],
            sidecarMaxConcurrency: 4,
        });
        const k = client._runtimeKnobs();
        expect(k.healthCacheTtlMs).toBe(1234);
        expect(k.requestTimeoutMs).toBe(9999);
        expect(k.maxRetries).toBe(7);
        expect(k.retryBackoffMs).toEqual([10, 20, 30]);
        expect(k.sidecarMaxConcurrency).toBe(4);
    });

    it('keeps previous value when given a bad input', () => {
        client.applyFacesCfg({ healthCacheTtlMs: 5000, maxRetries: 3 });
        client.applyFacesCfg({ healthCacheTtlMs: -1, maxRetries: 'no' });
        const k = client._runtimeKnobs();
        expect(k.healthCacheTtlMs).toBe(5000);
        expect(k.maxRetries).toBe(3);
    });
});

describe('env auto-bootstrap (no applyFacesCfg yet)', () => {
    it('reads TGDL_FACES_HEALTH_CACHE_TTL_MS on first health() call', async () => {
        process.env.TGDL_FACES_HEALTH_CACHE_TTL_MS = '100';
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        await client.health();
        const k = client._runtimeKnobs();
        expect(k.healthCacheTtlMs).toBe(100);
    });
});

describe('detectFaces retry behaviour', () => {
    it('retries on 503 then succeeds', async () => {
        process.env.TGDL_FACES_RETRY_BACKOFF_MS = '1,1';
        process.env.TGDL_FACES_MAX_RETRIES = '3';
        client.setSidecarUrl('http://host:8011');
        // First two calls 503, third 200.
        const calls = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            if (calls.length < 3) {
                return {
                    ok: false,
                    status: 503,
                    clone() {
                        return this;
                    },
                    json: async () => ({ error: 'service unavailable' }),
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    faces: [
                        {
                            x: 10,
                            y: 20,
                            w: 100,
                            h: 100,
                            score: 0.9,
                            embedding: new Array(512).fill(0.1),
                        },
                    ],
                    image_w: 1000,
                    image_h: 1000,
                }),
            };
        });

        const out = await client.detectFaces('/tmp/x.jpg', { minDetectionScore: 0.5 });
        expect(out).toHaveLength(1);
        expect(out[0].embedding).toBeInstanceOf(Float32Array);
        expect(out[0].embedding.length).toBe(512);
        expect(calls).toHaveLength(3);
        // All calls hit /detect.
        for (const c of calls) {
            expect(c.url).toBe('http://host:8011/detect');
        }
    });

    it('returns null after exhausting retries on persistent 503', async () => {
        process.env.TGDL_FACES_RETRY_BACKOFF_MS = '1';
        process.env.TGDL_FACES_MAX_RETRIES = '2';
        client.setSidecarUrl('http://host:8011');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 503,
            clone() {
                return this;
            },
            json: async () => ({ error: 'unavailable' }),
        });
        const out = await client.detectFaces('/tmp/x.jpg', {});
        expect(out).toBeNull();
        // 2 retries on path-mode (b64 fallback not triggered because the
        // error is 503, not 403 path_not_allowed).
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('forwards ar_range from cfg.faces.arRange', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedBody = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 100, image_h: 100 }),
            };
        });
        await client.detectFaces('/tmp/x.jpg', {
            faces: { arRange: [0.7, 1.4] },
        });
        expect(capturedBody.ar_range).toEqual([0.7, 1.4]);
    });
});

describe('detectFacesInVideo', () => {
    it('returns null when sidecar URL is unset', async () => {
        const out = await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(out).toBeNull();
    });

    it('calls POST /detect/video with correct body shape', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedUrl = null;
        let capturedBody = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
            capturedUrl = url;
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 0, image_h: 0 }),
            };
        });
        await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(capturedUrl).toBe('http://host:8011/detect/video');
        expect(capturedBody.path).toBe('/tmp/video.mp4');
        // Pure safety-ceiling default (§4.1/§5) — not a density control.
        expect(capturedBody.max_frames).toBe(20000);
        expect(Number.isFinite(capturedBody.min_score)).toBe(true);
        expect(Number.isFinite(capturedBody.min_box_px)).toBe(true);
        expect(Array.isArray(capturedBody.ar_range)).toBe(true);
        expect(capturedBody.ar_range).toHaveLength(2);
        expect(capturedBody.nice).toBe(0);
    });

    it('forwards faces.videoNice as body.nice so UI can override sidecar env', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedBody = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 0, image_h: 0 }),
            };
        });
        await client.detectFacesInVideo('/tmp/video.mp4', { faces: { videoNice: 12 } });
        expect(capturedBody.nice).toBe(12);
    });

    it('returns Float32Array embeddings on success', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                faces: [
                    {
                        x: 10,
                        y: 20,
                        w: 80,
                        h: 80,
                        score: 0.92,
                        embedding: new Array(512).fill(0.1),
                    },
                ],
                image_w: 1280,
                image_h: 720,
            }),
        });
        const out = await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(out).toHaveLength(1);
        expect(out[0].embedding).toBeInstanceOf(Float32Array);
        expect(out[0].embedding.length).toBe(512);
    });

    it('returns null on 403 — no b64 fallback for video', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({ code: 'path_not_allowed', error: 'outside roots' }),
        });
        const out = await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(out).toBeNull();
    });

    it('returns [] on 200 + error: file_not_found (soft error)', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ faces: [], error: 'file_not_found', image_w: 0, image_h: 0 }),
        });
        const out = await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(out).toEqual([]);
    });

    it('returns [] on 200 + error: no_frames (soft error)', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ faces: [], error: 'no_frames', image_w: 0, image_h: 0 }),
        });
        const out = await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(out).toEqual([]);
    });

    it('returns null on network error', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        const out = await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(out).toBeNull();
    });

    it('respects cfg.faces.videoMaxFrames → sets max_frames in body', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedBody = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 0, image_h: 0 }),
            };
        });
        await client.detectFacesInVideo('/tmp/video.mp4', { faces: { videoMaxFrames: 60 } });
        expect(capturedBody.max_frames).toBe(60);
    });

    it('clamps max_frames to 200000 max', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedBody = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 0, image_h: 0 }),
            };
        });
        await client.detectFacesInVideo('/tmp/video.mp4', { faces: { videoMaxFrames: 999_999 } });
        expect(capturedBody.max_frames).toBe(200_000);
    });

    it('resolves videoMaxFrames via TGDL_FACES_VIDEO_MAX_FRAMES env override', async () => {
        client.setSidecarUrl('http://host:8011');
        process.env.TGDL_FACES_VIDEO_MAX_FRAMES = '333';
        let capturedBody = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 0, image_h: 0 }),
            };
        });
        await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(capturedBody.max_frames).toBe(333);
    });
});

// Video scan progress reporting — a `job_id` in the POST body lets the
// sidecar's GET /detect/video/status/{job_id} be polled while the main
// request is in flight (see docs/AI.md). Polling is opt-in: it only
// happens when the caller passes an `onVideoProgress` callback.
describe('detectFacesInVideo — job_id progress polling', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    function _mockFetchWithStatusPolling() {
        let resolveMain;
        const mainPromise = new Promise((resolve) => {
            resolveMain = resolve;
        });
        let statusCallCount = 0;
        const statusCalls = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
            if (String(url).includes('/detect/video/status/')) {
                statusCallCount++;
                statusCalls.push(String(url));
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        job_id: 'fake-job',
                        frames_decoded: statusCallCount * 10,
                        total_frames: 100,
                        pct: statusCallCount * 10,
                        elapsed_sec: statusCallCount,
                    }),
                };
            }
            return mainPromise;
        });
        return {
            resolveMain: (body) =>
                resolveMain({ ok: true, status: 200, json: async () => body }),
            statusCalls,
            getStatusCallCount: () => statusCallCount,
        };
    }

    it('omits job_id and never polls when onVideoProgress is not provided', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedBody = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 0, image_h: 0 }),
            };
        });
        await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(capturedBody.job_id).toBeUndefined();
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('includes a job_id in the POST body when onVideoProgress is provided', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedBody = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
            if (String(url).endsWith('/detect/video')) capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 0, image_h: 0 }),
            };
        });
        await client.detectFacesInVideo('/tmp/video.mp4', {}, null, null, () => {});
        expect(typeof capturedBody.job_id).toBe('string');
        expect(capturedBody.job_id.length).toBeGreaterThan(0);
    });

    it('polls the status endpoint every videoProgressPollMs and forwards parsed fields', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.useFakeTimers();
        const { resolveMain, getStatusCallCount } = _mockFetchWithStatusPolling();

        const progressCalls = [];
        const resultPromise = client.detectFacesInVideo(
            '/tmp/video.mp4',
            {},
            null,
            null,
            (p) => progressCalls.push(p),
        );

        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(5000);

        expect(getStatusCallCount()).toBe(2);
        expect(progressCalls).toHaveLength(2);
        expect(progressCalls[0]).toMatchObject({
            path: '/tmp/video.mp4',
            frames_decoded: 10,
            total_frames: 100,
            pct: 10,
        });
        expect(progressCalls[1].frames_decoded).toBe(20);

        resolveMain({ faces: [], image_w: 0, image_h: 0 });
        await resultPromise;
    });

    it('stops polling once the main request settles', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.useFakeTimers();
        const { resolveMain, getStatusCallCount } = _mockFetchWithStatusPolling();

        const progressCalls = [];
        const resultPromise = client.detectFacesInVideo(
            '/tmp/video.mp4',
            {},
            null,
            null,
            (p) => progressCalls.push(p),
        );

        await vi.advanceTimersByTimeAsync(5000);
        expect(getStatusCallCount()).toBe(1);

        resolveMain({ faces: [], image_w: 0, image_h: 0 });
        await resultPromise;

        const countAfterSettle = getStatusCallCount();
        await vi.advanceTimersByTimeAsync(30000);
        expect(getStatusCallCount()).toBe(countAfterSettle);
    });

    it('a poll failure is swallowed and never affects the returned faces', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.useFakeTimers();

        let resolveMain;
        const mainPromise = new Promise((resolve) => {
            resolveMain = resolve;
        });
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
            if (String(url).includes('/detect/video/status/')) {
                throw new Error('ECONNRESET');
            }
            return mainPromise;
        });

        const progressCalls = [];
        const resultPromise = client.detectFacesInVideo(
            '/tmp/video.mp4',
            {},
            null,
            null,
            (p) => progressCalls.push(p),
        );

        await vi.advanceTimersByTimeAsync(5000);
        expect(progressCalls).toHaveLength(0);

        resolveMain({ ok: true, status: 200, json: async () => ({ faces: [], image_w: 0, image_h: 0 }) });
        const out = await resultPromise;
        expect(out).toEqual([]);
    });

    it('a 404 status response (job already gone) is swallowed, not surfaced', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.useFakeTimers();

        let resolveMain;
        const mainPromise = new Promise((resolve) => {
            resolveMain = resolve;
        });
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
            if (String(url).includes('/detect/video/status/')) {
                return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
            }
            return mainPromise;
        });

        const progressCalls = [];
        const resultPromise = client.detectFacesInVideo(
            '/tmp/video.mp4',
            {},
            null,
            null,
            (p) => progressCalls.push(p),
        );

        await vi.advanceTimersByTimeAsync(5000);
        expect(progressCalls).toHaveLength(0);

        resolveMain({ ok: true, status: 200, json: async () => ({ faces: [], image_w: 0, image_h: 0 }) });
        await resultPromise;
    });

    it('resolves a custom videoProgressPollMs from cfg', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.useFakeTimers();
        const { resolveMain, getStatusCallCount } = _mockFetchWithStatusPolling();

        const resultPromise = client.detectFacesInVideo(
            '/tmp/video.mp4',
            { faces: { videoProgressPollMs: 2000 } },
            null,
            null,
            () => {},
        );

        await vi.advanceTimersByTimeAsync(2000);
        expect(getStatusCallCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(getStatusCallCount()).toBe(2);

        resolveMain({ faces: [], image_w: 0, image_h: 0 });
        await resultPromise;
    });

    it('resolves videoProgressPollMs via TGDL_FACES_VIDEO_PROGRESS_POLL_MS env override', async () => {
        client.setSidecarUrl('http://host:8011');
        process.env.TGDL_FACES_VIDEO_PROGRESS_POLL_MS = '3000';
        vi.useFakeTimers();
        const { resolveMain, getStatusCallCount } = _mockFetchWithStatusPolling();

        const resultPromise = client.detectFacesInVideo(
            '/tmp/video.mp4',
            {},
            null,
            null,
            () => {},
        );

        await vi.advanceTimersByTimeAsync(2999);
        expect(getStatusCallCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(getStatusCallCount()).toBe(1);

        resolveMain({ faces: [], image_w: 0, image_h: 0 });
        await resultPromise;
    });

    it('clamps a too-small videoProgressPollMs to a 1000ms floor', async () => {
        client.setSidecarUrl('http://host:8011');
        vi.useFakeTimers();
        const { resolveMain, getStatusCallCount } = _mockFetchWithStatusPolling();

        const resultPromise = client.detectFacesInVideo(
            '/tmp/video.mp4',
            { faces: { videoProgressPollMs: 10 } },
            null,
            null,
            () => {},
        );

        await vi.advanceTimersByTimeAsync(999);
        expect(getStatusCallCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(getStatusCallCount()).toBe(1);

        resolveMain({ faces: [], image_w: 0, image_h: 0 });
        await resultPromise;
    });
});

// Regression coverage for the undici default headers/body timeout (300s,
// hardcoded, independent of our own AbortController timeout) silently
// killing long-running requests with a generic "fetch failed" — see the
// comment above `_dispatcherFor`'s definition in faces-client.js. Every
// fetch whose own intended timeout can exceed 300s must pass a `dispatcher`
// with matching headers/body timeouts, or undici's ceiling wins first.
describe('_dispatcherFor — undici timeout ceiling fix', () => {
    it('caches one Agent per distinct timeout value', () => {
        const a = client._dispatcherFor(60_000);
        const b = client._dispatcherFor(60_000);
        const c = client._dispatcherFor(120_000);
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });

    it('/detect/video passes a dispatcher matching the 2h video timeout floor', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedInit = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            capturedInit = init;
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [], image_w: 0, image_h: 0 }),
            };
        });
        await client.detectFacesInVideo('/tmp/video.mp4', {});
        expect(capturedInit.dispatcher).toBeTruthy();
        expect(capturedInit.dispatcher).toBe(client._dispatcherFor(2 * 60 * 60 * 1000));
    });

    it('/detect/batch passes a dispatcher scaled with file count', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedInit = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            capturedInit = init;
            return {
                ok: true,
                status: 200,
                json: async () => ({ results: [] }),
            };
        });
        // _requestTimeoutMs defaults to 60000 (unset by _resetForTests in beforeEach).
        await client.detectFacesBatch(['/tmp/a.jpg', '/tmp/b.jpg'], {});
        // batchTimeoutMs = max(2 * 60000, 120000) = 120000
        expect(capturedInit.dispatcher).toBe(client._dispatcherFor(120_000));
    });

    it('/detect (single image, via _postWithRetry) passes a dispatcher matching requestTimeoutMs', async () => {
        client.setSidecarUrl('http://host:8011');
        let capturedInit = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            capturedInit = init;
            return {
                ok: true,
                status: 200,
                json: async () => ({ faces: [] }),
            };
        });
        await client.detectFaces('/tmp/a.jpg', {});
        expect(capturedInit.dispatcher).toBe(client._dispatcherFor(60_000));
    });
});
