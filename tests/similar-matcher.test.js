import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { xorAggregate } from '../src/core/phash.js';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-similar-match-'));
process.env.TGDL_DATA_DIR = DATA_DIR;

let db;
let api;
let durationsWithinTolerance;
let durationBucket;
let findSimilarVideoGroups;
let analyzeSimilarClips;
let kvSet;
let kvGet;
let createJobTracker;
let _msg = 1;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../src/core/db.js');
    db = api.getDb();
    kvSet = api.kvSet;
    kvGet = api.kvGet;
    ({
        durationsWithinTolerance,
        durationBucket,
        findSimilarVideoGroups,
    } = await import('../src/core/similar/matcher.js'));
    ({ analyzeSimilarClips } = await import('../src/core/similar/analyze-runner.js'));
    ({ createJobTracker } = await import('../src/core/job-tracker.js'));
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
    delete process.env.TGDL_SIMILAR_THRESHOLD;
    db.prepare('DELETE FROM similar_groups').run();
    db.prepare('DELETE FROM similar_ignores').run();
    db.prepare('DELETE FROM similar_video_scans').run();
    db.prepare('DELETE FROM similar_partial_scans').run();
    db.prepare('DELETE FROM downloads').run();
});

function flipBits(hex, n) {
    let v = BigInt(`0x${hex}`);
    for (let i = 0; i < n; i++) v ^= 1n << BigInt(i);
    return v.toString(16).padStart(16, '0');
}

const HASH_A = 'aaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbb';

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

describe('durationsWithinTolerance', () => {
    it('accepts ±10% of the longer duration', () => {
        expect(durationsWithinTolerance(10, 10.5, 0.1)).toBe(true);
        expect(durationsWithinTolerance(10, 11, 0.1)).toBe(true);
        expect(durationsWithinTolerance(10, 12, 0.1)).toBe(false);
        expect(durationsWithinTolerance(null, 10, 0.1)).toBe(false);
        expect(durationsWithinTolerance(0, 0, 0.1)).toBe(true);
    });
});

describe('durationBucket', () => {
    it('floors duration into bucketSec windows', () => {
        expect(durationBucket(0, 120)).toBe(0);
        expect(durationBucket(119, 120)).toBe(0);
        expect(durationBucket(120, 120)).toBe(1);
        expect(durationBucket(250, 120)).toBe(2);
    });
});

describe('findSimilarVideoGroups', () => {
    const opts = {
        threshold: 5,
        durationTolerance: 0.1,
        durationBucketSec: 120,
    };

    it('groups near-duplicate videos and keeps the larger file', async () => {
        const hashesA = [HASH_A, HASH_A, HASH_A];
        const hashesB = hashesA.map((h) => flipBits(h, 3));
        const left = video({ id: 1, durationSec: 10, fileHash: 'sha-a', fileSize: 2000, hashes: hashesA });
        const right = video({ id: 2, durationSec: 10.5, fileHash: 'sha-b', fileSize: 900, hashes: hashesB });
        const { groups } = await findSimilarVideoGroups([left, right], {
            ...opts,
            framesById: new Map([
                [1, framesOf(hashesA)],
                [2, framesOf(hashesB)],
            ]),
        });
        expect(groups).toHaveLength(1);
        expect(groups[0].kind).toBe('similar');
        expect(groups[0].members.find((m) => m.role === 'keep').downloadId).toBe(1);
        expect(groups[0].members.find((m) => m.role === 'remove').downloadId).toBe(2);
        expect(groups[0].meanHamming).toBe(3);
        expect(groups[0].confidence).toBeCloseTo(1 - 3 / 64, 5);
    });

    it('rejects pairs outside duration tolerance', async () => {
        const hashes = [HASH_A, HASH_A];
        const { groups } = await findSimilarVideoGroups(
            [
                video({ id: 1, durationSec: 10, fileHash: 'a', fileSize: 2, hashes }),
                video({ id: 2, durationSec: 20, fileHash: 'b', fileSize: 1, hashes }),
            ],
            { ...opts, framesById: new Map([[1, framesOf(hashes)], [2, framesOf(hashes)]]) },
        );
        expect(groups).toHaveLength(0);
    });

    it('rejects pairs whose mean Hamming exceeds the threshold', async () => {
        const hashesA = [HASH_A, HASH_A];
        const hashesB = hashesA.map((h) => flipBits(h, 10));
        const { groups } = await findSimilarVideoGroups(
            [
                video({ id: 1, durationSec: 10, fileHash: 'a', fileSize: 2, hashes: hashesA }),
                video({ id: 2, durationSec: 10, fileHash: 'b', fileSize: 1, hashes: hashesB }),
            ],
            { ...opts, framesById: new Map([[1, framesOf(hashesA)], [2, framesOf(hashesB)]]) },
        );
        expect(groups).toHaveLength(0);
    });

    it('skips exact SHA-256 pairs (Duplicates page owns those)', async () => {
        const hashes = [HASH_A, HASH_A];
        const { groups } = await findSimilarVideoGroups(
            [
                video({ id: 1, durationSec: 10, fileHash: 'same', fileSize: 2, hashes }),
                video({ id: 2, durationSec: 10, fileHash: 'same', fileSize: 1, hashes }),
            ],
            { ...opts, framesById: new Map([[1, framesOf(hashes)], [2, framesOf(hashes)]]) },
        );
        expect(groups).toHaveLength(0);
    });

    it('skips ignored pairs', async () => {
        const hashes = [HASH_A, HASH_A];
        const { groups } = await findSimilarVideoGroups(
            [
                video({ id: 1, durationSec: 10, fileHash: 'a', fileSize: 2, hashes }),
                video({ id: 2, durationSec: 10, fileHash: 'b', fileSize: 1, hashes }),
            ],
            {
                ...opts,
                ignoredPairs: ['1:2'],
                framesById: new Map([[1, framesOf(hashes)], [2, framesOf(hashes)]]),
            },
        );
        expect(groups).toHaveLength(0);
    });

    it('compares each video only to earlier ids', async () => {
        const hashes = [HASH_A, HASH_A, HASH_A];
        const v1 = video({ id: 1, durationSec: 10, fileHash: 'a', fileSize: 3, hashes });
        const v2 = video({ id: 2, durationSec: 10, fileHash: 'b', fileSize: 2, hashes });
        const v3 = video({ id: 3, durationSec: 10, fileHash: 'c', fileSize: 1, hashes });
        const framesById = new Map([
            [1, framesOf(hashes)],
            [2, framesOf(hashes)],
            [3, framesOf(hashes)],
        ]);
        const all = await findSimilarVideoGroups([v1, v2, v3], { ...opts, framesById });
        expect(all.comparedPairs).toBe(3);
        expect(all.groups).toHaveLength(3);
        const resume = await findSimilarVideoGroups([v1, v2, v3], {
            ...opts,
            framesById,
            skipLeftIds: [1, 2],
        });
        expect(resume.comparedPairs).toBe(2);
        expect(resume.groups).toHaveLength(2);
    });

    it('does not compare videos more than one duration bucket apart', async () => {
        const hashes = [HASH_A, HASH_A];
        const { groups } = await findSimilarVideoGroups(
            [
                video({ id: 1, durationSec: 10, fileHash: 'a', fileSize: 2, hashes }),
                video({ id: 2, durationSec: 250, fileHash: 'b', fileSize: 1, hashes }),
            ],
            {
                ...opts,
                durationTolerance: 1,
                framesById: new Map([[1, framesOf(hashes)], [2, framesOf(hashes)]]),
            },
        );
        expect(groups).toHaveLength(0);
    });

    it('still compares adjacent duration buckets', async () => {
        const hashes = [HASH_A, HASH_A];
        const { groups } = await findSimilarVideoGroups(
            [
                video({ id: 1, durationSec: 115, fileHash: 'a', fileSize: 2, hashes }),
                video({ id: 2, durationSec: 125, fileHash: 'b', fileSize: 1, hashes }),
            ],
            { ...opts, framesById: new Map([[1, framesOf(hashes)], [2, framesOf(hashes)]]) },
        );
        expect(groups).toHaveLength(1);
    });

    it('groups videos that share content despite an extra intro bumper', async () => {
        const content = [HASH_A, HASH_A, HASH_A, HASH_A];
        const withBumper = [HASH_B, ...content];
        const { groups } = await findSimilarVideoGroups(
            [
                video({ id: 1, durationSec: 10, fileHash: 'sha-a', fileSize: 2000, hashes: withBumper }),
                video({ id: 2, durationSec: 10.5, fileHash: 'sha-b', fileSize: 900, hashes: content }),
            ],
            {
                ...opts,
                framesById: new Map([
                    [1, framesOf(withBumper)],
                    [2, framesOf(content)],
                ]),
            },
        );
        expect(groups).toHaveLength(1);
        expect(groups[0].kind).toBe('similar');
    });

    it('rejects pairs whose aligned coverage is below minCoverage', async () => {
        const hashesA = [HASH_A, HASH_A];
        const hashesB = [HASH_A, HASH_A, HASH_B, HASH_B, HASH_B];
        const { groups } = await findSimilarVideoGroups(
            [
                video({ id: 1, durationSec: 10, fileHash: 'a', fileSize: 2, hashes: hashesA }),
                video({ id: 2, durationSec: 10, fileHash: 'b', fileSize: 1, hashes: hashesB }),
            ],
            {
                ...opts,
                framesById: new Map([
                    [1, framesOf(hashesA)],
                    [2, framesOf(hashesB)],
                ]),
            },
        );
        expect(groups).toHaveLength(0);
    });
});

function seedVideo({ fileHash = 'h', fileSize = 1000, fileName } = {}) {
    const messageId = _msg++;
    api.insertDownload({
        groupId: '-100simmatch',
        groupName: 'SimMatch',
        messageId,
        fileName: fileName || `v${messageId}.mp4`,
        fileSize,
        fileType: 'video',
        filePath: `SimMatch/videos/v${messageId}.mp4`,
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

describe('analyzeSimilarClips', () => {
    it('persists similar groups without dropping partial rows', async () => {
        const hashes = [HASH_A, HASH_A, HASH_A];
        const keep = seedVideo({ fileHash: 'sha-keep', fileSize: 5000 });
        const remove = seedVideo({ fileHash: 'sha-rm', fileSize: 800 });
        seedFingerprint(keep, { durationSec: 8, fileHash: 'sha-keep', hashes });
        seedFingerprint(remove, { durationSec: 8.2, fileHash: 'sha-rm', hashes });

        const partialId = api.insertSimilarGroup({
            kind: 'partial',
            confidence: 0.5,
            offsetSec: 3,
            members: [
                { downloadId: keep, role: 'keep' },
                { downloadId: remove, role: 'remove' },
            ],
        });

        const result = await analyzeSimilarClips();
        expect(result.similarGroups).toBe(1);
        expect(result.cancelled).toBe(false);
        expect(result.partialSkipped).toBe(true);

        const groups = api.listSimilarGroups();
        expect(groups.some((g) => g.id === partialId && g.kind === 'partial')).toBe(true);
        const fresh = groups.filter((g) => g.kind === 'similar');
        expect(fresh).toHaveLength(1);
        const roles = Object.fromEntries(fresh[0].members.map((m) => [m.role, m.download_id]));
        expect(roles.keep).toBe(keep);
        expect(roles.remove).toBe(remove);
        expect(fresh[0].members.find((m) => m.role === 'keep').file_size).toBe(5000);
    });

    it('only compares a newly fingerprinted video to earlier ones', async () => {
        const hashes = [HASH_A, HASH_A, HASH_A];
        const a = seedVideo({ fileHash: 'inc-a', fileSize: 3000 });
        const b = seedVideo({ fileHash: 'inc-b', fileSize: 2000 });
        seedFingerprint(a, { durationSec: 8, fileHash: 'inc-a', hashes });
        seedFingerprint(b, { durationSec: 8, fileHash: 'inc-b', hashes });
        const first = await analyzeSimilarClips();
        expect(first.similarGroups).toBe(1);
        expect(first.comparedPairs).toBe(1);

        const again = await analyzeSimilarClips();
        expect(again.similarGroups).toBe(0);
        expect(again.comparedPairs).toBe(0);
        expect(api.listSimilarGroups({ kind: 'similar' })).toHaveLength(1);

        const c = seedVideo({ fileHash: 'inc-c', fileSize: 1000 });
        seedFingerprint(c, { durationSec: 8, fileHash: 'inc-c', hashes });
        const third = await analyzeSimilarClips();
        expect(third.comparedPairs).toBe(2);
        expect(third.similarGroups).toBe(2);
        expect(api.listSimilarGroups({ kind: 'similar' })).toHaveLength(3);
    });

    it('reports skipped videos and stays up to date when nothing is new', async () => {
        const hashes = [HASH_A, HASH_A, HASH_A];
        const a = seedVideo({ fileHash: 'utd-a', fileSize: 3000 });
        const b = seedVideo({ fileHash: 'utd-b', fileSize: 2000 });
        seedFingerprint(a, { durationSec: 8, fileHash: 'utd-a', hashes });
        seedFingerprint(b, { durationSec: 8, fileHash: 'utd-b', hashes });
        await analyzeSimilarClips();
        const progress = [];
        const again = await analyzeSimilarClips({
            onProgress: (p) => progress.push({ ...p }),
        });
        expect(again.comparedPairs).toBe(0);
        expect(again.similarGroups).toBe(0);
        expect(again.upToDate).toBe(true);
        expect(again.skipped).toBeGreaterThanOrEqual(2);
        expect(progress.some((p) => Number(p.skipped) >= 2 && Number(p.total) === 0)).toBe(true);
    });

    it('emits matching 0/N before the first pair compare', async () => {
        const hashes = [HASH_A, HASH_A, HASH_A];
        const a = seedVideo({ fileHash: 'tick-a', fileSize: 3000 });
        const b = seedVideo({ fileHash: 'tick-b', fileSize: 2000 });
        seedFingerprint(a, { durationSec: 8, fileHash: 'tick-a', hashes });
        seedFingerprint(b, { durationSec: 8, fileHash: 'tick-b', hashes });
        const progress = [];
        await analyzeSimilarClips({ onProgress: (p) => progress.push({ ...p }) });
        const first = progress.find((p) => p.stage === 'matching');
        expect(first).toMatchObject({ processed: 0, total: 2, comparedPairs: 0 });
    });

    it('honours similar_ignores and skips exact SHA-256 pairs', async () => {
        const hashes = [HASH_A, HASH_A];
        const a = seedVideo({ fileHash: 'ign-a', fileSize: 20 });
        const b = seedVideo({ fileHash: 'ign-b', fileSize: 10 });
        seedFingerprint(a, { durationSec: 4, fileHash: 'ign-a', hashes });
        seedFingerprint(b, { durationSec: 4, fileHash: 'ign-b', hashes });
        api.addSimilarIgnore({ aId: a, bId: b, kind: 'similar' });

        const exactA = seedVideo({ fileHash: 'dup-sha', fileSize: 30 });
        const exactB = seedVideo({ fileHash: 'dup-sha', fileSize: 15 });
        seedFingerprint(exactA, { durationSec: 4, fileHash: 'dup-sha', hashes });
        seedFingerprint(exactB, { durationSec: 4, fileHash: 'dup-sha', hashes });

        const result = await analyzeSimilarClips();
        const similar = api.listSimilarGroups({ kind: 'similar' });
        const hasPair = (x, y) =>
            similar.some((g) => {
                const m = new Set(g.members.map((row) => row.download_id));
                return m.has(x) && m.has(y);
            });
        expect(hasPair(a, b)).toBe(false);
        expect(hasPair(exactA, exactB)).toBe(false);
        expect(result.cancelled).toBe(false);
    });

    it('skips partial matching unless checkPartialClips is set', async () => {
        const before = api.listSimilarGroups({ kind: 'partial' }).length;
        const result = await analyzeSimilarClips();
        expect(result.checkPartialClips).toBe(false);
        expect(result.partialSkipped).toBe(true);
        expect(api.listSimilarGroups({ kind: 'partial' })).toHaveLength(before);
    });

    it("persists kv['similar_last_analyze'] from the JobTracker runFn shape", async () => {
        const t = createJobTracker({
            kind: 'similarAnalyze',
            broadcast: () => {},
            eventPrefix: 'similar_analyze',
        });
        const started = t.tryStart(async ({ onProgress, signal }) => {
            const result = await analyzeSimilarClips({ onProgress, signal });
            kvSet('similar_last_analyze', { finishedAt: Date.now(), ...result });
            return result;
        });
        expect(started.started).toBe(true);
        await vi.waitFor(() => {
            expect(t.getStatus().running).toBe(false);
        });
        const last = kvGet('similar_last_analyze');
        expect(last).toEqual(
            expect.objectContaining({
                similarGroups: expect.any(Number),
                comparedPairs: expect.any(Number),
                cancelled: expect.any(Boolean),
                finishedAt: expect.any(Number),
            }),
        );
    });
});
