// Phase 3 (docs/requirements.md §4.4/§4.5) — Node ffmpeg fallback rewrite.
//
// Covers the two pieces that replace the old evenly-spaced-`-ss`-seeking +
// greedy-dedupe implementation in `src/core/ai/faces-client.js`:
//
//   * `_dedupeVideoFaces`   — JS port of the Python `_build_face_tracks`
//                             track-confirmation + best-N dedup (§4.4).
//   * `_extractVideoFrames` — one continuous ffmpeg process using a single
//                             `select` filter (duration-independent floor +
//                             scene-change motion trigger), streamed via
//                             incremental JPEG-boundary parsing (§4.5).
//
// Both are exported test-only (matching the existing `_resetForTests` /
// `_runtimeKnobs` convention) so they can be unit-tested directly instead
// of only indirectly through the full `detectFacesInVideo` HTTP flow.

import { EventEmitter } from 'events';
import { Readable } from 'stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'child_process';
import * as client from '../../src/core/ai/faces-client.js';

afterEach(() => {
    vi.restoreAllMocks();
    client._resetForTests();
});

// ---------------------------------------------------------------------------
// Helpers (mirrors faces-service/tests/test_video.py's _face/_unit/_near)
// ---------------------------------------------------------------------------

function _face({ score = 0.8, quality = 0.6, emb, regularity = 0.5 } = {}) {
    const e = emb ?? _unit(0);
    return {
        x: 10,
        y: 10,
        w: 60,
        h: 60,
        score,
        qualityScore: quality,
        landmarkRegularity: regularity,
        embedding: Float32Array.from(e),
        landmarks: [],
    };
}

function _unit(idx, dim = 512) {
    const v = new Array(dim).fill(0);
    v[idx] = 1.0;
    return v;
}

function _near(idx, noise = 0.436, dim = 512) {
    const v = new Array(dim).fill(0);
    v[idx] = 0.9;
    v[(idx + 1) % dim] = noise;
    return v;
}

function _diverseVariant(idx, variant, dim = 512) {
    const v = new Array(dim).fill(0);
    v[idx] = 0.85;
    const j = (idx + 1 + variant) % dim;
    v[j] = 0.53;
    const norm = Math.sqrt(v[idx] ** 2 + v[j] ** 2);
    return v.map((x) => x / norm);
}

// ---------------------------------------------------------------------------
// Tests: _dedupeVideoFaces
// ---------------------------------------------------------------------------

describe('_dedupeVideoFaces (tracker port of Python _build_face_tracks)', () => {
    it('returns [] for empty input', () => {
        expect(client._dedupeVideoFaces([])).toEqual([]);
    });

    it('returns [] when every frame has no faces', () => {
        expect(client._dedupeVideoFaces([[], [], []])).toEqual([]);
    });

    it('keeps a confident single-hit face', () => {
        const f = _face({ score: 0.9, quality: 0.9 });
        expect(client._dedupeVideoFaces([[f]])).toEqual([f]);
    });

    it('drops a single-hit face below the singleton score bar (0.75)', () => {
        const f = _face({ score: 0.6, quality: 0.9 });
        expect(client._dedupeVideoFaces([[f]])).toEqual([]);
    });

    it('drops a single-hit face below the singleton quality bar (0.55)', () => {
        const f = _face({ score: 0.9, quality: 0.4 });
        expect(client._dedupeVideoFaces([[f]])).toEqual([]);
    });

    it('keeps a single-hit face exactly at both bars', () => {
        const f = _face({ score: 0.75, quality: 0.55 });
        expect(client._dedupeVideoFaces([[f]])).toEqual([f]);
    });

    it('confirms + collapses two near-identical-pose hits to the best-scoring one', () => {
        const low = _face({ score: 0.6, quality: 0.5, emb: _unit(0) });
        const high = _face({ score: 0.95, quality: 0.5, emb: _near(0) });
        const result = client._dedupeVideoFaces([[low], [high]]);
        expect(result).toHaveLength(1);
        expect(result[0].score).toBe(0.95);
    });

    it('confirms regardless of frame order', () => {
        const high = _face({ score: 0.95, quality: 0.5, emb: _unit(0) });
        const low = _face({ score: 0.6, quality: 0.5, emb: _near(0) });
        const result = client._dedupeVideoFaces([[high], [low]]);
        expect(result).toHaveLength(1);
        expect(result[0].score).toBe(0.95);
    });

    it('drops a confirmed (>=2 hit) track that fails the universal quality floor (0.45)', () => {
        const a = _face({ score: 0.9, quality: 0.1, emb: _unit(5) });
        const b = _face({ score: 0.9, quality: 0.1, emb: _near(5) });
        expect(client._dedupeVideoFaces([[a], [b]])).toEqual([]);
    });

    it('keeps a confirmed track that meets the quality floor', () => {
        const a = _face({ score: 0.9, quality: 0.5, emb: _unit(6) });
        const b = _face({ score: 0.9, quality: 0.5, emb: _near(6) });
        expect(client._dedupeVideoFaces([[a], [b]])).toHaveLength(1);
    });

    it('drops a confirmed track below the score floor (0.60)', () => {
        const a = _face({ score: 0.55, quality: 0.6, emb: _unit(7) });
        const b = _face({ score: 0.55, quality: 0.6, emb: _near(7) });
        expect(client._dedupeVideoFaces([[a], [b]])).toEqual([]);
    });

    it('drops a confirmed track below the landmark regularity floor (0.35)', () => {
        const a = _face({ score: 0.9, quality: 0.6, regularity: 0.2, emb: _unit(8) });
        const b = _face({ score: 0.9, quality: 0.6, regularity: 0.2, emb: _near(8) });
        expect(client._dedupeVideoFaces([[a], [b]])).toEqual([]);
    });

    it('drops sub-floor representatives from an otherwise valid track', () => {
        const good = _face({ score: 0.9, quality: 0.6, emb: _unit(10) });
        const weak = _face({ score: 0.9, quality: 0.38, emb: _diverseVariant(10, 1) });
        const result = client._dedupeVideoFaces([[good], [weak]]);
        expect(result).toHaveLength(1);
        expect(result[0].qualityScore).toBe(0.6);
    });

    it('keeps different identities across frames separately', () => {
        const frame1 = [
            _face({ score: 0.8, quality: 0.6, emb: _unit(0) }),
            _face({ score: 0.8, quality: 0.6, emb: _unit(1) }),
        ];
        const frame2 = [
            _face({ score: 0.8, quality: 0.6, emb: _near(0) }),
            _face({ score: 0.8, quality: 0.6, emb: _near(1) }),
        ];
        expect(client._dedupeVideoFaces([frame1, frame2])).toHaveLength(2);
    });

    it('keeps up to 3 diverse representatives for one identity', () => {
        const faces = Array.from({ length: 5 }, (_, k) =>
            _face({ score: 0.9 - 0.05 * k, quality: 0.7, emb: _diverseVariant(0, k) }),
        );
        const result = client._dedupeVideoFaces(faces.map((f) => [f]));
        expect(result.length).toBeLessThanOrEqual(3);
        expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('collapses near-duplicate poses of the same identity to fewer representatives', () => {
        const top = _face({ score: 0.95, quality: 0.7, emb: _unit(3) });
        const dupes = Array.from({ length: 4 }, () =>
            _face({ score: 0.7, quality: 0.7, emb: _near(3) }),
        );
        const result = client._dedupeVideoFaces([[top], ...dupes.map((d) => [d])]);
        expect(result).toHaveLength(1);
        expect(result[0].score).toBe(0.95);
    });
});

// ---------------------------------------------------------------------------
// Tests: _extractVideoFrames
// ---------------------------------------------------------------------------

function _fakeProc(stdoutChunks) {
    const proc = new EventEmitter();
    proc.stdout = Readable.from(stdoutChunks);
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    return proc;
}

function _jpeg(byte) {
    // Minimal synthetic "JPEG": SOI, one payload byte, EOI.
    return Buffer.from([0xff, 0xd8, byte, 0xff, 0xd9]);
}

describe('_extractVideoFrames (continuous ffmpeg select filter)', () => {
    beforeEach(() => {
        spawn.mockReset();
    });

    it('spawns one continuous ffmpeg process with a single select filter — no -ss seeking', async () => {
        spawn.mockReturnValue(_fakeProc([]));
        const gen = client._extractVideoFrames('/tmp/video.mp4', null);
        const results = [];
        for await (const frame of gen) results.push(frame);
        expect(results).toEqual([]);

        expect(spawn).toHaveBeenCalledTimes(1);
        const [, args] = spawn.mock.calls[0];
        expect(args).not.toContain('-ss');
        const vfIdx = args.indexOf('-vf');
        expect(vfIdx).toBeGreaterThanOrEqual(0);
        expect(args[vfIdx + 1]).toContain('select=');
        expect(args[vfIdx + 1]).toContain('prev_selected_t');
        expect(args[vfIdx + 1]).toContain('scene');
    });

    it('yields frames in order, parsed from a single concatenated chunk', async () => {
        const f1 = _jpeg(1);
        const f2 = _jpeg(2);
        const f3 = _jpeg(3);
        spawn.mockReturnValue(_fakeProc([Buffer.concat([f1, f2, f3])]));

        const results = [];
        for await (const frame of client._extractVideoFrames('/tmp/video.mp4', null)) {
            results.push(Buffer.from(frame));
        }
        expect(results).toHaveLength(3);
        expect(results[0].equals(f1)).toBe(true);
        expect(results[1].equals(f2)).toBe(true);
        expect(results[2].equals(f3)).toBe(true);
    });

    it('reassembles a frame split across multiple stream chunks', async () => {
        const f1 = _jpeg(9);
        // Split the single JPEG frame's bytes across three arbitrary chunk
        // boundaries — proves the parser buffers partial frames correctly.
        const chunks = [f1.subarray(0, 1), f1.subarray(1, 3), f1.subarray(3)];
        spawn.mockReturnValue(_fakeProc(chunks));

        const results = [];
        for await (const frame of client._extractVideoFrames('/tmp/video.mp4', null)) {
            results.push(Buffer.from(frame));
        }
        expect(results).toHaveLength(1);
        expect(results[0].equals(f1)).toBe(true);
    });

    it('yields nothing for an empty stream', async () => {
        spawn.mockReturnValue(_fakeProc([]));
        const results = [];
        for await (const frame of client._extractVideoFrames('/tmp/video.mp4', null)) {
            results.push(frame);
        }
        expect(results).toEqual([]);
    });

    it('honours a custom floorIntervalSec in the select filter expression', async () => {
        spawn.mockReturnValue(_fakeProc([]));
        for await (const _f of client._extractVideoFrames('/tmp/video.mp4', null, {
            floorIntervalSec: 7.5,
        })) {
            /* drain */
        }
        const [, args] = spawn.mock.calls[0];
        const vfIdx = args.indexOf('-vf');
        expect(args[vfIdx + 1]).toContain('7.5');
    });

    it('stops yielding once maxFramesCeiling is reached (safety net)', async () => {
        const frames = Buffer.concat([_jpeg(1), _jpeg(2), _jpeg(3), _jpeg(4), _jpeg(5)]);
        spawn.mockReturnValue(_fakeProc([frames]));

        const results = [];
        for await (const frame of client._extractVideoFrames('/tmp/video.mp4', null, {
            maxFramesCeiling: 2,
        })) {
            results.push(Buffer.from(frame));
        }
        expect(results).toHaveLength(2);
    });
});
