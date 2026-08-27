/**
 * Perceptual hashes for video fingerprints.
 *
 * Similar-clips uses PDQ-256 (64×64 luma → 16×16 AC coefficients,
 * DC skipped per Meta PDQ, 64 hex). Hamming and XOR aggregate work on
 * any even-length hex string.
 */

const PDQ_N = 64;
const PDQ_HASH_N = 16;

const _dctTables = new Map();

function _ensureDctTables(n) {
    let t = _dctTables.get(n);
    if (t) return t;
    const cosTable = Array.from({ length: n }, () => new Float64Array(n));
    const alpha = new Float64Array(n);
    const factor = Math.PI / (2 * n);
    for (let k = 0; k < n; k++) {
        alpha[k] = k === 0 ? Math.SQRT1_2 : 1;
        for (let i = 0; i < n; i++) {
            cosTable[k][i] = Math.cos(factor * (2 * i + 1) * k);
        }
    }
    t = { cosTable, alpha };
    _dctTables.set(n, t);
    return t;
}

/** Separable orthonormal 2D DCT-II of an n×n row-major gray buffer. */
function dct2d(gray, n = PDQ_N) {
    const { cosTable, alpha } = _ensureDctTables(n);
    const scale = 2 / n;
    const tmp = new Float64Array(n * n);
    const out = new Float64Array(n * n);
    for (let y = 0; y < n; y++) {
        for (let k = 0; k < n; k++) {
            let sum = 0;
            for (let x = 0; x < n; x++) sum += gray[y * n + x] * cosTable[k][x];
            tmp[y * n + k] = alpha[k] * sum;
        }
    }
    for (let x = 0; x < n; x++) {
        for (let k = 0; k < n; k++) {
            let sum = 0;
            for (let y = 0; y < n; y++) sum += tmp[y * n + x] * cosTable[k][y];
            out[k * n + x] = scale * alpha[k] * sum;
        }
    }
    return out;
}

function rgb24ToGray(buf, px) {
    const n = px * px;
    const gray = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const o = i * 3;
        gray[i] = buf[o] * 0.299 + buf[o + 1] * 0.587 + buf[o + 2] * 0.114;
    }
    return gray;
}

export function hammingHex(a, b) {
    const x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
    let n = 0;
    let v = x;
    while (v) {
        n += Number(v & 1n);
        v >>= 1n;
    }
    return n;
}

export function xorAggregate(hexes) {
    let acc = 0n;
    let width = 16;
    for (const h of hexes || []) {
        if (!h) continue;
        width = Math.max(width, String(h).length);
        acc ^= BigInt(`0x${h}`);
    }
    return acc.toString(16).padStart(width, '0');
}

function _resampleGrayNearest(gray, srcPx, dstPx) {
    if (srcPx === dstPx) return gray;
    const out = new Float64Array(dstPx * dstPx);
    const scale = srcPx / dstPx;
    for (let y = 0; y < dstPx; y++) {
        const sy = Math.min(srcPx - 1, Math.floor((y + 0.5) * scale));
        for (let x = 0; x < dstPx; x++) {
            const sx = Math.min(srcPx - 1, Math.floor((x + 0.5) * scale));
            out[y * dstPx + x] = gray[sy * srcPx + sx];
        }
    }
    return out;
}

/**
 * 256-bit PDQ of a packed RGB24 tile (`px * px * 3` bytes).
 * Native size is 64×64; other sizes are nearest-neighbour resampled.
 * Meta PDQ uses frequencies 1..16 (DC skipped), bits vs median.
 */
export function pdqHexFromRgb24(buf, px = PDQ_N) {
    const srcPx = Math.max(1, Math.floor(Number(px) || PDQ_N));
    const gray = _resampleGrayNearest(rgb24ToGray(buf, srcPx), srcPx, PDQ_N);
    const dct = dct2d(gray, PDQ_N);
    const block = new Float64Array(PDQ_HASH_N * PDQ_HASH_N);
    for (let y = 0; y < PDQ_HASH_N; y++) {
        for (let x = 0; x < PDQ_HASH_N; x++) {
            block[y * PDQ_HASH_N + x] = dct[(y + 1) * PDQ_N + (x + 1)];
        }
    }
    const sorted = Float64Array.from(block).sort();
    const median = (sorted[127] + sorted[128]) / 2;
    let bits = 0n;
    for (let i = 0; i < 256; i++) {
        if (block[i] > median) bits |= 1n << BigInt(255 - i);
    }
    return bits.toString(16).padStart(64, '0');
}
