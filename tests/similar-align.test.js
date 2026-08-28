import { describe, expect, it } from 'vitest';
import { alignHashSequences } from '../src/core/similar/align.js';

/** 64-hex tags: same letter = Hamming 0; different letters are far. */
function hx(ch) {
    return String(ch).repeat(64);
}

function seq(tags, t0 = 0, dt = 3) {
    return tags.map((ch, i) => ({ tSec: t0 + i * dt, phash: hx(ch) }));
}

describe('alignHashSequences', () => {
    it('covers identical sequences fully with mean Hamming 0', async () => {
        const a = seq(['1', '2', '3', '4']);
        const r = await alignHashSequences(a, seq(['1', '2', '3', '4']));
        expect(r.matched).toBe(4);
        expect(r.coverageA).toBe(1);
        expect(r.coverageB).toBe(1);
        expect(r.meanHamming).toBe(0);
        expect(r.startIndexA).toBe(0);
        expect(r.startIndexB).toBe(0);
        expect(r.offsetASec).toBe(0);
        expect(r.offsetBSec).toBe(0);
    });

    it('aligns through a bumper/intro on the longer side', async () => {
        const parent = seq(['b', '1', '2', '3', '4']);
        const clip = seq(['1', '2', '3', '4']);
        const r = await alignHashSequences(parent, clip, { matchHamming: 50 });
        expect(r.matched).toBe(4);
        expect(r.coverageB).toBe(1);
        expect(r.coverageA).toBeCloseTo(0.8);
        expect(r.startIndexA).toBe(1);
        expect(r.startIndexB).toBe(0);
        expect(r.offsetASec).toBe(3);
        expect(r.offsetBSec).toBe(0);
        expect(r.coverageShort).toBe(1);
    });

    it('places an excerpt inside a parent and reports parent offset', async () => {
        const parent = seq(['1', '2', '3', '4', '5']);
        const clip = seq(['3', '4']);
        const r = await alignHashSequences(clip, parent, { matchHamming: 50 });
        expect(r.matched).toBe(2);
        expect(r.coverageA).toBe(1);
        expect(r.coverageShort).toBe(1);
        expect(r.startIndexA).toBe(0);
        expect(r.startIndexB).toBe(2);
        expect(r.offsetBSec).toBe(6);
    });

    it('allows a skipped scene via a gap', async () => {
        const parent = seq(['1', '2', '3']);
        const clip = seq(['1', '3']);
        const r = await alignHashSequences(clip, parent, { matchHamming: 50 });
        expect(r.matched).toBe(2);
        expect(r.coverageA).toBe(1);
        expect(r.startIndexB).toBe(0);
        expect(r.offsetBSec).toBe(0);
    });

    it('rejects unrelated sequences', async () => {
        const r = await alignHashSequences(seq(['a', 'b', 'c', 'd']), seq(['1', '2', '3', '4']), {
            matchHamming: 50,
        });
        expect(r.matched).toBe(0);
        expect(r.coverageShort).toBe(0);
        expect(r.score).toBe(0);
        expect(r.startIndexA).toBe(-1);
    });

    it('returns an empty result for missing sequences', async () => {
        const r = await alignHashSequences([], seq(['1']));
        expect(r.matched).toBe(0);
        expect(r.coverageA).toBe(0);
        expect(r.coverageB).toBe(0);
        expect(Number.isFinite(r.meanHamming)).toBe(false);
    });

    it('stops when the abort signal is already aborted', async () => {
        const c = new AbortController();
        c.abort();
        const r = await alignHashSequences(seq(['1', '2', '3']), seq(['1', '2', '3']), {
            signal: c.signal,
        });
        expect(r.cancelled).toBe(true);
        expect(r.matched).toBe(0);
    });
});
