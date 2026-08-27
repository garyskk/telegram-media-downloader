import { describe, expect, it } from 'vitest';
import {
    hammingHex,
    hashRgb24Sequence,
    phashHexFromRgb24,
    xorAggregate,
} from '../src/core/phash.js';

const PX = 32;

function fillRgb(value) {
    const buf = Buffer.alloc(PX * PX * 3);
    buf.fill(value);
    return buf;
}

function gradientRgb(axis) {
    const buf = Buffer.alloc(PX * PX * 3);
    for (let y = 0; y < PX; y++) {
        for (let x = 0; x < PX; x++) {
            const v = axis === 'x' ? Math.round((x * 255) / (PX - 1)) : Math.round((y * 255) / (PX - 1));
            const o = (y * PX + x) * 3;
            buf[o] = v;
            buf[o + 1] = v;
            buf[o + 2] = v;
        }
    }
    return buf;
}

function brighter(buf, delta) {
    const out = Buffer.from(buf);
    for (let i = 0; i < out.length; i++) {
        out[i] = Math.min(255, out[i] + delta);
    }
    return out;
}

describe('phashHexFromRgb24', () => {
    it('is stable for identical tiles', () => {
        const a = gradientRgb('x');
        expect(phashHexFromRgb24(a, PX)).toBe(phashHexFromRgb24(Buffer.from(a), PX));
        expect(phashHexFromRgb24(a, PX)).toMatch(/^[0-9a-f]{16}$/);
    });

    it('keeps a small Hamming distance for a slight brightness shift', () => {
        const base = gradientRgb('x');
        const dist = hammingHex(phashHexFromRgb24(base, PX), phashHexFromRgb24(brighter(base, 8), PX));
        expect(dist).toBeLessThanOrEqual(16);
    });

    it('separates orthogonal gradients', () => {
        const dist = hammingHex(
            phashHexFromRgb24(gradientRgb('x'), PX),
            phashHexFromRgb24(gradientRgb('y'), PX),
        );
        expect(dist).toBeGreaterThan(8);
    });

    it('hashes a flat gray tile to 16 hex chars', () => {
        expect(phashHexFromRgb24(fillRgb(128), PX)).toMatch(/^[0-9a-f]{16}$/);
    });
});

describe('hashRgb24Sequence + xorAggregate', () => {
    it('emits one row per packed frame and timestamps by interval', () => {
        const a = gradientRgb('x');
        const b = gradientRgb('y');
        const buf = Buffer.concat([a, b]);
        const frames = hashRgb24Sequence(buf, PX, 1);
        expect(frames).toHaveLength(2);
        expect(frames[0].tSec).toBe(0);
        expect(frames[1].tSec).toBe(1);
        expect(frames[0].phash).not.toBe(frames[1].phash);
        expect(xorAggregate(frames.map((f) => f.phash))).toBe(
            (
                BigInt(`0x${frames[0].phash}`) ^ BigInt(`0x${frames[1].phash}`)
            ).toString(16).padStart(16, '0'),
        );
    });

    it('drops a trailing partial frame', () => {
        const buf = Buffer.concat([fillRgb(40), Buffer.alloc(10, 1)]);
        expect(hashRgb24Sequence(buf, PX, 1)).toHaveLength(1);
    });
});
