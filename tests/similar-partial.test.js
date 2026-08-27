import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { xorAggregate } from '../src/core/phash.js';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-similar-partial-'));
process.env.TGDL_DATA_DIR = DATA_DIR;

const H0 = 'aaaaaaaaaaaaaaaa';
const H1 = 'bbbbbbbbbbbbbbbb';
const H2 = 'cccccccccccccccc';
const HA = 'dddddddddddddddd';
const HF = 'ffffffffffffffff';

let db;
let api;
let effectivePartialMatchRatio;
let bestSubsequenceMatch;
let findPartialClipGroups;
let analyzeSimilarClips;
let _msg = 1;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../src/core/db.js');
    db = api.getDb();
    ({
        effectivePartialMatchRatio,
        bestSubsequenceMatch,
        findPartialClipGroups,
    } = await import('../src/core/similar/partial.js'));
    ({ analyzeSimilarClips } = await import('../src/core/similar/analyze-runner.js'));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

function framesOf(hashes, start = 0) {
    return hashes.map((phash, i) => ({ tSec: start + i, phash }));
}

function video({ id, durationSec, fileHash, fileSize, hashes }) {
    return {
        id,
        durationSec,
        aggregateHash: xorAggregate(hashes),
        fileHash,
        fileSize,
        fileName: `v${id}.mp4`,
    };
}

describe('effectivePartialMatchRatio', () => {
    it('uses the short-clip ratio at or below the duration cutoff', () => {
        expect(
            effectivePartialMatchRatio(120, {
                matchRatio: 0.5,
                shortClipSec: 300,
                shortMatchRatio: 0.35,
            }),
        ).toBe(0.35);
        expect(
            effectivePartialMatchRatio(300, {
                matchRatio: 0.5,
                shortClipSec: 300,
                shortMatchRatio: 0.35,
            }),
        ).toBe(0.35);
        expect(
            effectivePartialMatchRatio(400, {
                matchRatio: 0.5,
                shortClipSec: 300,
                shortMatchRatio: 0.35,
            }),
        ).toBe(0.5);
    });
});

describe('bestSubsequenceMatch', () => {
    it('finds the local alignment and parent offset', () => {
        const { ratio, startIndex, matched, offsetSec } = bestSubsequenceMatch(
            [H0, H1, H2],
            [HA, H0, H1, H2, HF],
            { frameThreshold: 0 },
        );
        expect(ratio).toBe(1);
        expect(startIndex).toBe(1);
        expect(matched).toBe(3);
        expect(offsetSec).toBe(1);
    });

    it('rejects a clip longer than the parent', () => {
        const { ratio, matched } = bestSubsequenceMatch([H0, H1, H2], [H0, H1], { frameThreshold: 0 });
        expect(ratio).toBe(0);
        expect(matched).toBe(0);
    });

    it('counts per-frame Hamming within the threshold', () => {
        const { ratio, matched } = bestSubsequenceMatch([H0, H1], [H0, HF], { frameThreshold: 0 });
        expect(matched).toBe(1);
        expect(ratio).toBe(0.5);
    });

    it('covers a clip that skipped a parent scene', () => {
        const { ratio, matched, startIndex } = bestSubsequenceMatch([H0, H2], [H0, H1, H2], {
            frameThreshold: 0,
        });
        expect(ratio).toBe(1);
        expect(matched).toBe(2);
        expect(startIndex).toBe(0);
    });
});

describe('findPartialClipGroups', () => {
    const opts = {
        matchRatio: 0.8,
        frameThreshold: 0,
        durationBucketSec: 120,
        shortClipSec: 300,
        shortMatchRatio: 0.35,
        reviewMatchRatio: 0.1,
        reviewMinMatchedFrames: 2,
    };

    it('groups a shorter clip inside a longer parent and keeps the parent', async () => {
        const clipH = [H0, H1, H2];
        const parentH = [HA, H0, H1, H2, HF];
        const { groups } = await findPartialClipGroups(
            [
                video({ id: 1, durationSec: 10, fileHash: 'clip', fileSize: 100, hashes: clipH }),
                video({ id: 2, durationSec: 60, fileHash: 'full', fileSize: 1000, hashes: parentH }),
            ],
            {
                ...opts,
                framesById: new Map([
                    [1, framesOf(clipH)],
                    [2, framesOf(parentH)],
                ]),
            },
        );
        expect(groups).toHaveLength(1);
        expect(groups[0].kind).toBe('partial');
        expect(groups[0].offsetSec).toBe(1);
        expect(groups[0].members.find((m) => m.role === 'keep').downloadId).toBe(2);
        expect(groups[0].members.find((m) => m.role === 'remove').downloadId).toBe(1);
    });

    it('keeps the larger file when durations match (same-length re-encode)', async () => {
        const hashes = [H0, H1, H2];
        const { groups } = await findPartialClipGroups(
            [
                video({ id: 1, durationSec: 30, fileHash: 'hi', fileSize: 2000, hashes }),
                video({ id: 2, durationSec: 30, fileHash: 'lo', fileSize: 800, hashes }),
            ],
            { ...opts, framesById: new Map([[1, framesOf(hashes)], [2, framesOf(hashes)]]) },
        );
        expect(groups).toHaveLength(1);
        expect(groups[0].members.find((m) => m.role === 'keep').downloadId).toBe(1);
        expect(groups[0].members.find((m) => m.role === 'remove').downloadId).toBe(2);
        expect(groups[0].members.find((m) => m.role === 'keep').reason).toMatch(/re-encode/i);
    });

    it('rejects pairs below the match ratio', async () => {
        const clipH = [H0, H1, H2];
        const parentH = [HA, HF, HF, HF];
        const { groups } = await findPartialClipGroups(
            [
                video({ id: 1, durationSec: 10, fileHash: 'clip', fileSize: 100, hashes: clipH }),
                video({ id: 2, durationSec: 60, fileHash: 'full', fileSize: 1000, hashes: parentH }),
            ],
            {
                ...opts,
                framesById: new Map([
                    [1, framesOf(clipH)],
                    [2, framesOf(parentH)],
                ]),
            },
        );
        expect(groups).toHaveLength(0);
    });

    it('flags a weak hit as partial_review', async () => {
        const clipH = [H0, H1, H2];
        const parentH = [HA, H0, H1, HF, HF];
        const { groups } = await findPartialClipGroups(
            [
                video({ id: 1, durationSec: 400, fileHash: 'clip', fileSize: 100, hashes: clipH }),
                video({ id: 2, durationSec: 500, fileHash: 'full', fileSize: 1000, hashes: parentH }),
            ],
            {
                ...opts,
                framesById: new Map([
                    [1, framesOf(clipH)],
                    [2, framesOf(parentH)],
                ]),
            },
        );
        expect(groups).toHaveLength(1);
        expect(groups[0].kind).toBe('partial_review');
        expect(groups[0].members.find((m) => m.role === 'review').downloadId).toBe(1);
        expect(groups[0].members.find((m) => m.role === 'keep').downloadId).toBe(2);
    });

    it('skips ignored pairs and exact SHA-256 pairs', async () => {
        const clipH = [H0, H1, H2];
        const parentH = [HA, H0, H1, H2, HF];
        const framesById = new Map([
            [1, framesOf(clipH)],
            [2, framesOf(parentH)],
            [3, framesOf(clipH)],
            [4, framesOf(parentH)],
        ]);
        const ignored = await findPartialClipGroups(
            [
                video({ id: 1, durationSec: 10, fileHash: 'c1', fileSize: 100, hashes: clipH }),
                video({ id: 2, durationSec: 60, fileHash: 'p1', fileSize: 1000, hashes: parentH }),
            ],
            { ...opts, ignoredPairs: ['1:2'], framesById },
        );
        expect(ignored.groups).toHaveLength(0);

        const exact = await findPartialClipGroups(
            [
                video({ id: 3, durationSec: 10, fileHash: 'same', fileSize: 100, hashes: clipH }),
                video({ id: 4, durationSec: 60, fileHash: 'same', fileSize: 1000, hashes: parentH }),
            ],
            { ...opts, framesById },
        );
        expect(exact.groups).toHaveLength(0);
    });

    it('still compares a short clip against a parent in a later duration bucket', async () => {
        const clipH = [H0, H1, H2];
        const parentH = [HA, H0, H1, H2, HF];
        const { groups } = await findPartialClipGroups(
            [
                video({ id: 1, durationSec: 10, fileHash: 'clip', fileSize: 100, hashes: clipH }),
                video({ id: 2, durationSec: 250, fileHash: 'full', fileSize: 1000, hashes: parentH }),
            ],
            {
                ...opts,
                framesById: new Map([
                    [1, framesOf(clipH)],
                    [2, framesOf(parentH)],
                ]),
            },
        );
        expect(groups).toHaveLength(1);
        expect(groups[0].kind).toBe('partial');
    });

    it('uses parent t_sec as offset, not a 1 fps frame index', async () => {
        const clipH = [H0, H1, H2];
        const parentH = [HA, H0, H1, H2, HF];
        const parentFrames = [
            { tSec: 0, phash: HA },
            { tSec: 3.1, phash: H0 },
            { tSec: 5.7, phash: H1 },
            { tSec: 11, phash: H2 },
            { tSec: 20, phash: HF },
        ];
        const { groups } = await findPartialClipGroups(
            [
                video({ id: 1, durationSec: 10, fileHash: 'clip', fileSize: 100, hashes: clipH }),
                video({ id: 2, durationSec: 60, fileHash: 'full', fileSize: 1000, hashes: parentH }),
            ],
            {
                ...opts,
                framesById: new Map([
                    [1, framesOf(clipH)],
                    [2, parentFrames],
                ]),
            },
        );
        expect(groups).toHaveLength(1);
        expect(groups[0].offsetSec).toBeCloseTo(3.1, 5);
    });
});

function seedVideo({ fileHash = 'h', fileSize = 1000 } = {}) {
    const messageId = _msg++;
    api.insertDownload({
        groupId: '-100simpartial',
        groupName: 'SimPartial',
        messageId,
        fileName: `v${messageId}.mp4`,
        fileSize,
        fileType: 'video',
        filePath: `SimPartial/videos/v${messageId}.mp4`,
        fileHash,
    });
    return db.prepare('SELECT id FROM downloads WHERE message_id = ?').get(messageId).id;
}

function seedFingerprint(id, { durationSec, fileHash, hashes }) {
    api.upsertVideoFingerprint({
        downloadId: id,
        durationSec,
        aggregateHash: xorAggregate(hashes),
        frameCount: hashes.length,
        algo: 'pdq-scene-v1',
        fileHash,
        indexedAt: Date.now(),
    });
    api.replaceVideoFrameHashes(
        id,
        hashes.map((phash, i) => ({ tSec: i, phash })),
    );
}

describe('analyzeSimilarClips partial', () => {
    beforeEach(() => {
        // These fixtures use 16-hex tags, not PDQ-256. Keep per-scene
        // Hamming exact so HA/H0/… stay distinct under the new default 70.
        process.env.TGDL_SIMILAR_PARTIAL_FRAME_THRESHOLD = '0';
        process.env.TGDL_SIMILAR_THRESHOLD = '5';
    });
    afterEach(() => {
        delete process.env.TGDL_SIMILAR_PARTIAL_FRAME_THRESHOLD;
        delete process.env.TGDL_SIMILAR_THRESHOLD;
        db.prepare('DELETE FROM downloads').run();
        _msg = 1;
    });
    it('does not run partial matching unless checkPartialClips is set', async () => {
        const clipH = [H0, H1, H2];
        const parentH = [HA, H0, H1, H2, HF];
        const clip = seedVideo({ fileHash: 'off-c', fileSize: 100 });
        const parent = seedVideo({ fileHash: 'off-p', fileSize: 900 });
        seedFingerprint(clip, { durationSec: 10, fileHash: 'off-c', hashes: clipH });
        seedFingerprint(parent, { durationSec: 60, fileHash: 'off-p', hashes: parentH });

        const result = await analyzeSimilarClips();
        expect(result.checkPartialClips).toBe(false);
        expect(result.partialSkipped).toBe(true);
        expect(result.partialGroups).toBe(0);
        const hasPair = api.listSimilarGroups({ kind: 'partial' }).some((g) => {
            const m = new Set(g.members.map((row) => row.download_id));
            return m.has(clip) && m.has(parent);
        });
        expect(hasPair).toBe(false);
    });

    it('persists partial groups, scan cursors, and resumes without duplicating', async () => {
        const clipH = [H0, H1, H2];
        const parentH = [HA, H0, H1, H2, HF];
        const clip = seedVideo({ fileHash: 'run-c', fileSize: 100 });
        const parent = seedVideo({ fileHash: 'run-p', fileSize: 900 });
        seedFingerprint(clip, { durationSec: 10, fileHash: 'run-c', hashes: clipH });
        seedFingerprint(parent, { durationSec: 60, fileHash: 'run-p', hashes: parentH });

        const first = await analyzeSimilarClips({ checkPartialClips: true });
        expect(first.partialSkipped).toBe(false);
        expect(first.partialGroups).toBe(1);
        expect(first.partialReviewGroups).toBe(0);
        const groups1 = api.listSimilarGroups({ kind: 'partial' }).filter((g) => {
            const m = new Set(g.members.map((row) => row.download_id));
            return m.has(clip) && m.has(parent);
        });
        expect(groups1).toHaveLength(1);
        expect(groups1[0].offset_sec).toBe(1);
        expect(api.getSimilarPartialScan(clip)?.frame_count).toBe(3);

        const second = await analyzeSimilarClips({ checkPartialClips: true });
        expect(second.partialGroups).toBe(0);
        expect(
            api.listSimilarGroups({ kind: 'partial' }).filter((g) => {
                const m = new Set(g.members.map((row) => row.download_id));
                return m.has(clip) && m.has(parent);
            }),
        ).toHaveLength(1);

        const clip2H = [HA, H2, HF];
        const clip2 = seedVideo({ fileHash: 'run-c2', fileSize: 80 });
        seedFingerprint(clip2, { durationSec: 10, fileHash: 'run-c2', hashes: clip2H });
        const third = await analyzeSimilarClips({ checkPartialClips: true });
        expect(third.partialGroups).toBe(1);
        expect(
            api.listSimilarGroups({ kind: 'partial' }).filter((g) => {
                const m = new Set(g.members.map((row) => row.download_id));
                return m.has(clip2) && m.has(parent);
            }),
        ).toHaveLength(1);
    });

    it('honours partial ignores across resume', async () => {
        const clipH = [H0, H1, H2];
        const parentH = [HA, H0, H1, H2, HF];
        const clip = seedVideo({ fileHash: 'ign-c', fileSize: 100 });
        const parent = seedVideo({ fileHash: 'ign-p', fileSize: 900 });
        seedFingerprint(clip, { durationSec: 10, fileHash: 'ign-c', hashes: clipH });
        seedFingerprint(parent, { durationSec: 60, fileHash: 'ign-p', hashes: parentH });
        api.addSimilarIgnore({ aId: clip, bId: parent, kind: 'partial' });

        await analyzeSimilarClips({ checkPartialClips: true });
        const paired = api.listSimilarGroups({ kind: 'partial' }).some((g) => {
            const m = new Set(g.members.map((row) => row.download_id));
            return m.has(clip) && m.has(parent);
        });
        expect(paired).toBe(false);
    });
});
