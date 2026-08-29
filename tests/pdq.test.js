import { describe, expect, it } from 'vitest';
import { hammingHex, pdqHexFromRgb24, xorAggregate } from '../src/core/phash.js';

const PX = 64;

function fillRgb(value, px = PX) {
    const buf = Buffer.alloc(px * px * 3);
    buf.fill(value);
    return buf;
}

function gradientRgb(axis, px = PX, min = 0, max = 255) {
    const buf = Buffer.alloc(px * px * 3);
    const span = max - min;
    for (let y = 0; y < px; y++) {
        for (let x = 0; x < px; x++) {
            const t = axis === 'x' ? x / (px - 1) : y / (px - 1);
            const v = Math.round(min + t * span);
            const o = (y * px + x) * 3;
            buf[o] = v;
            buf[o + 1] = v;
            buf[o + 2] = v;
        }
    }
    return buf;
}

function sceneRgb(px = PX) {
    const buf = Buffer.alloc(px * px * 3);
    for (let y = 0; y < px; y++) {
        for (let x = 0; x < px; x++) {
            let v = 70 + Math.round((x + y) * 0.35);
            if (x > 8 && x < 28 && y > 10 && y < 42) v = 210;
            if (x > 34 && x < 58 && y > 22 && y < 56) v = 35;
            const o = (y * px + x) * 3;
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

function quantize(buf, step = 4) {
    const out = Buffer.from(buf);
    for (let i = 0; i < out.length; i++) {
        out[i] = Math.round(out[i] / step) * step;
    }
    return out;
}

describe('pdqHexFromRgb24', () => {
    it('is stable for identical tiles and emits 64 hex chars', () => {
        const a = gradientRgb('x');
        const hex = pdqHexFromRgb24(a, PX);
        expect(hex).toBe(pdqHexFromRgb24(Buffer.from(a), PX));
        expect(hex).toMatch(/^[0-9a-f]{64}$/);
    });

    it('keeps a small Hamming distance for a slight brightness shift', () => {
        const base = sceneRgb();
        const dist = hammingHex(pdqHexFromRgb24(base, PX), pdqHexFromRgb24(brighter(base, 8), PX));
        expect(dist).toBeLessThanOrEqual(32);
    });

    it('keeps a small Hamming distance under mild re-encode quantization', () => {
        const base = sceneRgb();
        const dist = hammingHex(pdqHexFromRgb24(base, PX), pdqHexFromRgb24(quantize(base, 4), PX));
        expect(dist).toBeLessThanOrEqual(50);
    });

    it('separates orthogonal gradients', () => {
        const dist = hammingHex(pdqHexFromRgb24(gradientRgb('x'), PX), pdqHexFromRgb24(gradientRgb('y'), PX));
        expect(dist).toBeGreaterThan(32);
    });

    it('hashes a flat gray tile to 64 hex chars', () => {
        expect(pdqHexFromRgb24(fillRgb(128), PX)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('resamples a smaller tile to 64×64 internally', () => {
        const hex = pdqHexFromRgb24(gradientRgb('x', 32), 32);
        expect(hex).toMatch(/^[0-9a-f]{64}$/);
        expect(hex).not.toBe(pdqHexFromRgb24(gradientRgb('y', 32), 32));
    });
});

describe('xorAggregate 256-bit', () => {
    it('pads PDQ hashes to 64 hex chars', () => {
        const a = pdqHexFromRgb24(gradientRgb('x'), PX);
        const b = pdqHexFromRgb24(gradientRgb('y'), PX);
        const agg = xorAggregate([a, b]);
        expect(agg).toMatch(/^[0-9a-f]{64}$/);
        expect(agg).toBe((BigInt(`0x${a}`) ^ BigInt(`0x${b}`)).toString(16).padStart(64, '0'));
    });

    it('xors identical 16-hex stand-ins to zero', () => {
        expect(xorAggregate(['aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa'])).toBe('0000000000000000');
        expect(hammingHex('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa')).toBe(0);
    });
});
