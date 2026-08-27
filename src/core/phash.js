/**
 * 64-bit DCT perceptual hash (pHash) for 32×32 RGB/gray tiles.
 *
 * Matches the classic imagehash algorithm: 2D DCT → 8×8 low-frequency
 * block → bits vs median (DC included). Output is 16 lowercase hex
 * chars. Frame sequences XOR-fold into `aggregate_hash`.
 */

const DCT_N = 32;
const HASH_N = 8;

let _cosTable = null;
let _alpha = null;

function _ensureDctTables(n) {
    if (_cosTable && _cosTable.length === n) return;
    _cosTable = Array.from({ length: n }, () => new Float64Array(n));
    _alpha = new Float64Array(n);
    const factor = Math.PI / (2 * n);
    for (let k = 0; k < n; k++) {
        _alpha[k] = k === 0 ? Math.SQRT1_2 : 1;
        for (let i = 0; i < n; i++) {
            _cosTable[k][i] = Math.cos(factor * (2 * i + 1) * k);
        }
    }
}

/** Separable orthonormal 2D DCT-II of an n×n row-major gray buffer. */
export function dct2d(gray, n = DCT_N) {
    _ensureDctTables(n);
    const scale = 2 / n;
    const tmp = new Float64Array(n * n);
    const out = new Float64Array(n * n);
    for (let y = 0; y < n; y++) {
        for (let k = 0; k < n; k++) {
            let sum = 0;
            for (let x = 0; x < n; x++) sum += gray[y * n + x] * _cosTable[k][x];
            tmp[y * n + k] = _alpha[k] * sum;
        }
    }
    for (let x = 0; x < n; x++) {
        for (let k = 0; k < n; k++) {
            let sum = 0;
            for (let y = 0; y < n; y++) sum += tmp[y * n + x] * _cosTable[k][y];
            out[k * n + x] = scale * _alpha[k] * sum;
        }
    }
    return out;
}

export function rgb24ToGray(buf, px) {
    const n = px * px;
    const gray = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const o = i * 3;
        gray[i] = buf[o] * 0.299 + buf[o + 1] * 0.587 + buf[o + 2] * 0.114;
    }
    return gray;
}

/**
 * 64-bit pHash of a packed RGB24 tile (`px * px * 3` bytes).
 * `px` should be 32 (native); other sizes still take the 8×8 DCT corner.
 */
export function phashHexFromRgb24(buf, px = DCT_N) {
    const n = Math.max(HASH_N, Math.floor(Number(px) || DCT_N));
    const gray = rgb24ToGray(buf, n);
    const dct = dct2d(gray, n);
    const block = new Float64Array(HASH_N * HASH_N);
    for (let y = 0; y < HASH_N; y++) {
        for (let x = 0; x < HASH_N; x++) {
            block[y * HASH_N + x] = dct[y * n + x];
        }
    }
    const sorted = Float64Array.from(block).sort();
    const median = (sorted[31] + sorted[32]) / 2;
    let bits = 0n;
    for (let i = 0; i < 64; i++) {
        if (block[i] > median) bits |= 1n << BigInt(63 - i);
    }
    return bits.toString(16).padStart(16, '0');
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
    for (const h of hexes || []) {
        if (!h) continue;
        acc ^= BigInt(`0x${h}`);
    }
    return acc.toString(16).padStart(16, '0');
}

/**
 * Slice a concatenated RGB24 raw dump into `{ tSec, phash }` rows.
 * Leftover bytes shorter than one frame are ignored.
 */
export function hashRgb24Sequence(buf, tilePx, intervalSec) {
    const px = Math.max(HASH_N, Math.floor(Number(tilePx) || DCT_N));
    const frameSize = px * px * 3;
    if (!buf?.length || frameSize <= 0) return [];
    const n = Math.floor(buf.length / frameSize);
    const step = Number(intervalSec);
    const interval = Number.isFinite(step) && step > 0 ? step : 1;
    const frames = [];
    for (let i = 0; i < n; i++) {
        const slice = buf.subarray(i * frameSize, (i + 1) * frameSize);
        frames.push({
            tSec: i * interval,
            phash: phashHexFromRgb24(slice, px),
        });
    }
    return frames;
}
