import { describe, expect, it } from 'vitest';
import {
    FINGERPRINT_ALGO,
    buildFingerprintFfmpegArgs,
    parseShowinfoPts,
    zipRawFramesWithPts,
} from '../src/core/similar/fingerprint.js';
import { pdqHexFromRgb24 } from '../src/core/phash.js';

const PX = 64;
const FRAME = PX * PX * 3;

describe('buildFingerprintFfmpegArgs', () => {
    it('uses scene-or-floor select, 64px pad, vsync 0, and raw RGB to stdout', () => {
        const args = buildFingerprintFfmpegArgs({
            srcAbs: '/tmp/in.mp4',
            floorIntervalSec: 3,
            sceneThreshold: 0.1,
            tilePx: 64,
        });
        const joined = args.join(' ');
        expect(joined).toContain("select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,3)+gt(scene\\,0.1)'");
        expect(joined).toContain('scale=64:64:force_original_aspect_ratio=decrease');
        expect(joined).toContain('pad=64:64:');
        expect(joined).toContain('showinfo');
        expect(joined).toContain('-vsync');
        expect(args[args.indexOf('-vsync') + 1]).toBe('0');
        expect(joined).toContain('rawvideo');
        expect(joined).toContain('rgb24');
        expect(joined).toContain('pipe:1');
        expect(joined).not.toContain('filter_complex');
        expect(joined).not.toContain('libwebp');
        expect(joined).not.toContain('.fp.raw');
    });
});

describe('parseShowinfoPts', () => {
    it('extracts pts_time in order', () => {
        const stderr = [
            '[Parsed_showinfo_3 @ 0x1] n:   0 pts:      0 pts_time:0',
            '[Parsed_showinfo_3 @ 0x1] n:   1 pts:  75000 pts_time:3.012',
            'noise',
            '[Parsed_showinfo_3 @ 0x1] n:   2 pts: 150000 pts_time:12.5',
        ].join('\n');
        expect(parseShowinfoPts(stderr)).toEqual([0, 3.012, 12.5]);
    });
});

describe('zipRawFramesWithPts', () => {
    it('pairs packed RGB24 frames with real pts and PDQ hashes', () => {
        const a = Buffer.alloc(FRAME, 40);
        const b = Buffer.alloc(FRAME, 200);
        const frames = zipRawFramesWithPts(Buffer.concat([a, b]), [0, 3]);
        expect(frames).toHaveLength(2);
        expect(frames[0].tSec).toBe(0);
        expect(frames[1].tSec).toBe(3);
        expect(frames[0].phash).toMatch(/^[0-9a-f]{64}$/);
        expect(frames[1].phash).toBe(pdqHexFromRgb24(b, PX));
        expect(frames[0].phash).not.toBe(frames[1].phash);
    });

    it('returns empty when pts count disagrees with packed frames', () => {
        const buf = Buffer.alloc(FRAME * 2, 10);
        expect(zipRawFramesWithPts(buf, [0])).toEqual([]);
        expect(zipRawFramesWithPts(buf, [0, 3, 6])).toEqual([]);
        expect(zipRawFramesWithPts(Buffer.alloc(10), [0])).toEqual([]);
    });
});

describe('FINGERPRINT_ALGO', () => {
    it('is pdq-scene-v1', () => {
        expect(FINGERPRINT_ALGO).toBe('pdq-scene-v1');
    });
});
