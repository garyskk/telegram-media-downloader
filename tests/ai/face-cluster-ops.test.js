// Phase 2 integration tests — manual cluster operations + centroid-
// based label preservation. Locks in:
//   - mergeFacePerson: faces flow from B → A, B is deleted, A.count updates
//   - splitFacePerson: selected faces form a new cluster, sources rebalance
//   - reassignFace: single-face hop between clusters
//   - matchClusterToPersistedLabel: closest labelled centroid within eps

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-face-ops-'));
let db;
let api;

const f32Blob = (vec) => Buffer.from(new Float32Array(vec).buffer);

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../../src/core/db.js');
    db = api.getDb();
    // One download row for foreign keys on faces
    api.insertDownload({
        groupId: '-100777',
        groupName: 'Faces Fixture',
        messageId: 1,
        fileName: 'f1.jpg',
        fileSize: 1000,
        fileType: 'photo',
        filePath: 'Faces_Fixture/images/f1.jpg',
    });
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    // Reset clusters + faces between tests
    db.prepare('DELETE FROM faces').run();
    db.prepare('DELETE FROM people').run();
    db.prepare('DELETE FROM excluded_people').run();
});

const downloadId = () => db.prepare('SELECT id FROM downloads LIMIT 1').get().id;

describe('mergeFacePerson', () => {
    it('moves every face from other → target and deletes the empty cluster', () => {
        const did = downloadId();
        const aId = api.insertPerson({
            label: 'Bob',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 2,
        });
        const bId = api.insertPerson({
            label: 'Bob copy',
            centroidBlob: f32Blob([1, 0.05, 0]),
            faceCount: 1,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: aId,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: aId,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0.05, 0]),
            personId: bId,
        });

        const r = api.mergeFacePerson(aId, bId);
        expect(r.moved).toBe(1);
        expect(r.deleted).toBe(1);

        const stillExists = db.prepare('SELECT id FROM people WHERE id = ?').get(bId);
        expect(stillExists).toBeUndefined();
        const newCount = db.prepare('SELECT face_count FROM people WHERE id = ?').get(aId);
        expect(newCount.face_count).toBe(3);
    });

    it('no-ops when target === other or args invalid', () => {
        expect(api.mergeFacePerson(5, 5)).toEqual({ moved: 0, deleted: 0 });
        expect(api.mergeFacePerson(null, 5)).toEqual({ moved: 0, deleted: 0 });
    });
});

describe('splitFacePerson', () => {
    it('creates a new cluster from selected faces and rebalances sources', () => {
        const did = downloadId();
        const pid = api.insertPerson({
            label: 'A',
            centroidBlob: f32Blob([1, 0, 0, 0]),
            faceCount: 4,
        });
        const f1 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0, 0, 0]),
            personId: pid,
        }).lastInsertRowid;
        const f2 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([0.9, 0.1, 0, 0]),
            personId: pid,
        }).lastInsertRowid;
        const f3 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([0, 1, 0, 0]),
            personId: pid,
        }).lastInsertRowid;
        const f4 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([0, 0.9, 0.1, 0]),
            personId: pid,
        }).lastInsertRowid;

        // Pull f3 + f4 (the "wrong" half) into a new cluster
        const r = api.splitFacePerson([f3, f4], 'B');
        expect(r.moved).toBe(2);
        expect(r.personId).toBeGreaterThan(0);

        const old = db.prepare('SELECT face_count FROM people WHERE id = ?').get(pid);
        expect(old.face_count).toBe(2);
        const fresh = db
            .prepare('SELECT face_count, label FROM people WHERE id = ?')
            .get(r.personId);
        expect(fresh.face_count).toBe(2);
        expect(fresh.label).toBe('B');
    });

    it('deletes the source cluster when every face moves out', () => {
        const did = downloadId();
        const pid = api.insertPerson({ centroidBlob: f32Blob([1, 0]), faceCount: 2 });
        const f1 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0]),
            personId: pid,
        }).lastInsertRowid;
        const f2 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0.05]),
            personId: pid,
        }).lastInsertRowid;
        api.splitFacePerson([f1, f2], 'New');
        const remaining = db.prepare('SELECT id FROM people WHERE id = ?').get(pid);
        expect(remaining).toBeUndefined();
    });

    it('returns null personId for empty input', () => {
        expect(api.splitFacePerson([])).toEqual({ personId: null, moved: 0 });
        expect(api.splitFacePerson(null)).toEqual({ personId: null, moved: 0 });
    });
});

describe('reassignFace', () => {
    it('moves a face between two clusters + updates face_count both ways', () => {
        const did = downloadId();
        const pA = api.insertPerson({ label: 'A', centroidBlob: f32Blob([1, 0]), faceCount: 2 });
        const pB = api.insertPerson({ label: 'B', centroidBlob: f32Blob([0, 1]), faceCount: 1 });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0]),
            personId: pA,
        });
        const moveMe = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([0.5, 0.5]),
            personId: pA,
        }).lastInsertRowid;
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([0, 1]),
            personId: pB,
        });

        const r = api.reassignFace(moveMe, pB);
        expect(r.ok).toBe(true);
        expect(r.oldPersonId).toBe(pA);
        expect(r.newPersonId).toBe(pB);

        expect(db.prepare('SELECT face_count FROM people WHERE id = ?').get(pA).face_count).toBe(1);
        expect(db.prepare('SELECT face_count FROM people WHERE id = ?').get(pB).face_count).toBe(2);
    });

    it('deletes source cluster when its last face leaves', () => {
        const did = downloadId();
        const pA = api.insertPerson({ centroidBlob: f32Blob([1, 0]), faceCount: 1 });
        const pB = api.insertPerson({ centroidBlob: f32Blob([0, 1]), faceCount: 0 });
        const only = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0]),
            personId: pA,
        }).lastInsertRowid;
        api.reassignFace(only, pB);
        expect(db.prepare('SELECT id FROM people WHERE id = ?').get(pA)).toBeUndefined();
    });

    it('reassign to null = unassign', () => {
        const did = downloadId();
        const pA = api.insertPerson({ centroidBlob: f32Blob([1, 0]), faceCount: 1 });
        const fid = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0]),
            personId: pA,
        }).lastInsertRowid;
        const r = api.reassignFace(fid, null);
        expect(r.ok).toBe(true);
        const after = db.prepare('SELECT person_id FROM faces WHERE id = ?').get(fid);
        expect(after.person_id).toBeNull();
    });

    it('returns {ok:false} for unknown face id', () => {
        const r = api.reassignFace(99999, null);
        expect(r.ok).toBe(false);
    });
});

describe('matchClusterToPersistedLabel', () => {
    it('returns the closest labelled centroid within eps', () => {
        api.insertPerson({ label: 'Bob', centroidBlob: f32Blob([1, 0, 0]), faceCount: 5 });
        api.insertPerson({ label: 'Alice', centroidBlob: f32Blob([0, 1, 0]), faceCount: 3 });
        // Query very close to Bob's centroid
        const r = api.matchClusterToPersistedLabel(new Float32Array([0.95, 0.05, 0]), 0.4);
        expect(r).toBeTruthy();
        expect(r.label).toBe('Bob');
        expect(r.distance).toBeLessThan(0.4);
    });

    it('returns null when nothing is within eps', () => {
        api.insertPerson({ label: 'Bob', centroidBlob: f32Blob([1, 0, 0]), faceCount: 5 });
        const r = api.matchClusterToPersistedLabel(new Float32Array([-1, 0, 0]), 0.4);
        expect(r).toBeNull();
    });

    it('ignores unlabelled clusters', () => {
        api.insertPerson({ centroidBlob: f32Blob([1, 0, 0]), faceCount: 5 }); // no label
        const r = api.matchClusterToPersistedLabel(new Float32Array([1, 0, 0]), 0.4);
        expect(r).toBeNull();
    });

    it('returns null for non-Float32Array input', () => {
        expect(api.matchClusterToPersistedLabel(null, 0.4)).toBeNull();
        expect(api.matchClusterToPersistedLabel([1, 2, 3], 0.4)).toBeNull();
    });
});

describe('listFacesForPerson', () => {
    it('returns one row per face, not collapsed per download (unlike listPhotosForPerson)', () => {
        const did = downloadId();
        const pid = api.insertPerson({ label: 'Group', centroidBlob: f32Blob([1, 0]), faceCount: 2 });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 50,
            h: 50,
            embeddingBlob: f32Blob([1, 0]),
            personId: pid,
            qualityScore: 0.9,
        });
        api.insertFace({
            downloadId: did,
            x: 60,
            y: 0,
            w: 50,
            h: 50,
            embeddingBlob: f32Blob([1, 0.02]),
            personId: pid,
            qualityScore: 0.3,
        });

        // Two faces from the SAME download — listPhotosForPerson collapses
        // this to 1 row, listFacesForPerson must return both.
        const photos = api.listPhotosForPerson(pid, {});
        expect(photos.files.length).toBe(1);
        expect(photos.total).toBe(1);

        const faces = api.listFacesForPerson(pid, {});
        expect(faces.faces.length).toBe(2);
        expect(faces.total).toBe(2);
        for (const row of faces.faces) {
            expect(row.download_id).toBe(did);
            expect(Number.isFinite(row.face_id)).toBe(true);
            expect(row.file_name).toBe('f1.jpg');
        }
    });

    it('clamps limit to [1, 200] and offset to >= 0', () => {
        const did = downloadId();
        const pid = api.insertPerson({ centroidBlob: f32Blob([1, 0]), faceCount: 1 });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 50,
            h: 50,
            embeddingBlob: f32Blob([1, 0]),
            personId: pid,
        });
        expect(() => api.listFacesForPerson(pid, { limit: 9999, offset: -5 })).not.toThrow();
        const r = api.listFacesForPerson(pid, { limit: 9999, offset: -5 });
        expect(r.faces.length).toBe(1);
    });

    it('returns empty result for a person with no faces', () => {
        const r = api.listFacesForPerson(999999, {});
        expect(r.faces).toEqual([]);
        expect(r.total).toBe(0);
    });
});

describe('setFaceQualityScore', () => {
    it('persists quality_score on an existing face row', () => {
        const did = downloadId();
        const fid = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            embeddingBlob: f32Blob([1, 0]),
        }).lastInsertRowid;
        api.setFaceQualityScore(fid, 0.91);
        const row = db.prepare('SELECT quality_score FROM faces WHERE id = ?').get(fid);
        expect(row.quality_score).toBeCloseTo(0.91, 5);
    });
});

describe('excludePerson (durable denylist)', () => {
    it('moves centroid to excluded_people and deletes the person; faces unassigned', () => {
        const did = downloadId();
        const pid = api.insertPerson({
            label: 'Stranger',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 2,
        });
        const fLow = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 50,
            h: 50,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: pid,
            qualityScore: 0.2,
        }).lastInsertRowid;
        const fHigh = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 50,
            h: 50,
            embeddingBlob: f32Blob([0.99, 0.01, 0]),
            personId: pid,
            qualityScore: 0.95,
        }).lastInsertRowid;

        const r = api.excludePerson(pid);
        expect(r.ok).toBe(true);
        expect(r.excludedId).toBeTruthy();
        expect(r.label).toBe('Stranger');
        expect(r.coverFaceId).toBe(fHigh);
        expect(r.coverFaceId).not.toBe(fLow);

        expect(db.prepare('SELECT id FROM people WHERE id = ?').get(pid)).toBeUndefined();
        const facesLeft = db
            .prepare('SELECT person_id FROM faces WHERE person_id IS NOT NULL')
            .all();
        expect(facesLeft).toEqual([]);

        const listed = api.listExcludedPeople({});
        expect(listed.total).toBe(1);
        expect(listed.excluded[0].label).toBe('Stranger');
        expect(listed.excluded[0].id).toBe(r.excludedId);
        expect(listed.excluded[0].cover_face_id).toBe(fHigh);
    });

    it('backfills cover_face_id for legacy exclusions missing a cover', () => {
        const did = downloadId();
        const pid = api.insertPerson({
            label: 'Legacy',
            centroidBlob: f32Blob([0.2, 0.8, 0]),
            faceCount: 1,
        });
        const fid = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.21, 0.79, 0]),
            personId: pid,
            qualityScore: 0.8,
        }).lastInsertRowid;
        // Simulate pre-cover_face_id exclude: insert denylist row without cover.
        db.prepare(
            `INSERT INTO excluded_people (embedding_centroid, label, created_at, cover_face_id)
             VALUES (?, ?, ?, NULL)`,
        ).run(f32Blob([0.2, 0.8, 0]), 'Legacy', Date.now());
        db.prepare('DELETE FROM people WHERE id = ?').run(pid);

        const listed = api.listExcludedPeople({});
        expect(listed.total).toBe(1);
        expect(listed.excluded[0].cover_face_id).toBe(fid);
    });

    it('survives clearAllPeople (Phase B wipe of people table)', () => {
        const pid = api.insertPerson({
            label: 'Noise',
            centroidBlob: f32Blob([0, 1, 0]),
            faceCount: 1,
        });
        const r = api.excludePerson(pid);
        expect(r.ok).toBe(true);

        api.clearAllPeople();
        expect(api.listExcludedPeople({}).total).toBe(1);
        const match = api.matchExcludedCentroid(new Float32Array([0, 1, 0]), 0.4);
        expect(match).toBeTruthy();
        expect(match.id).toBe(r.excludedId);
    });

    it('matchExcludedCentroid returns null when outside eps', () => {
        const pid = api.insertPerson({
            label: 'Far',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 1,
        });
        api.excludePerson(pid);
        expect(api.matchExcludedCentroid(new Float32Array([-1, 0, 0]), 0.4)).toBeNull();
    });

    it('deletePerson does NOT add to the exclusion denylist', () => {
        const pid = api.insertPerson({
            label: 'Temp',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 1,
        });
        expect(api.deletePerson(pid)).toBe(1);
        expect(api.listExcludedPeople({}).total).toBe(0);
        expect(api.matchExcludedCentroid(new Float32Array([1, 0, 0]), 0.4)).toBeNull();
    });

    it('deleteExcludedPerson restores — match no longer hits', () => {
        const pid = api.insertPerson({
            label: 'Back',
            centroidBlob: f32Blob([0, 0, 1]),
            faceCount: 1,
        });
        const r = api.excludePerson(pid);
        expect(api.deleteExcludedPerson(r.excludedId)).toBe(1);
        expect(api.listExcludedPeople({}).total).toBe(0);
        expect(api.matchExcludedCentroid(new Float32Array([0, 0, 1]), 0.4)).toBeNull();
    });

    it('clearExcludedPeople / resetAllAiData wipe the denylist', () => {
        const a = api.insertPerson({ centroidBlob: f32Blob([1, 0]), faceCount: 1 });
        api.excludePerson(a);
        expect(api.clearExcludedPeople()).toBe(1);
        expect(api.listExcludedPeople({}).total).toBe(0);

        const b = api.insertPerson({ centroidBlob: f32Blob([0, 1]), faceCount: 1 });
        api.excludePerson(b);
        const reset = api.resetAllAiData();
        expect(reset.excluded).toBeGreaterThanOrEqual(1);
        expect(api.listExcludedPeople({}).total).toBe(0);
    });

    it('returns not_found for missing person', () => {
        expect(api.excludePerson(999999)).toEqual({ ok: false, reason: 'not_found' });
        expect(api.excludePerson(-1).ok).toBe(false);
    });

    it('listExcludedCentroids returns Float32Array centroids for Phase B', () => {
        const pid = api.insertPerson({
            label: 'Vec',
            centroidBlob: f32Blob([0.5, 0.5, 0]),
            faceCount: 1,
        });
        api.excludePerson(pid);
        const cents = api.listExcludedCentroids();
        expect(cents).toHaveLength(1);
        expect(cents[0].centroid).toBeInstanceOf(Float32Array);
        expect(cents[0].centroid[0]).toBeCloseTo(0.5, 5);
        expect(cents[0].label).toBe('Vec');
    });
});

describe('setPersonCoverFace (pinned People avatar)', () => {
    it('pins a face and listPeople returns it as cover_face_id over higher-quality auto-pick', () => {
        const did = downloadId();
        const pid = api.insertPerson({
            label: 'Pin',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 2,
        });
        const fLow = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: pid,
            qualityScore: 0.2,
        }).lastInsertRowid;
        const fHigh = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 80,
            h: 80,
            embeddingBlob: f32Blob([0.99, 0.01, 0]),
            personId: pid,
            qualityScore: 0.99,
        }).lastInsertRowid;

        // Auto-pick would prefer fHigh.
        expect(api.listPeople({}).people[0].cover_face_id).toBe(fHigh);

        const r = api.setPersonCoverFace(pid, fLow);
        expect(r).toEqual({ ok: true, coverFaceId: fLow });
        expect(api.listPeople({}).people[0].cover_face_id).toBe(fLow);
        expect(api.listPinnedCoverFaceIds()).toEqual([fLow]);
    });

    it('rejects face belonging to another person', () => {
        const did = downloadId();
        const a = api.insertPerson({ centroidBlob: f32Blob([1, 0]), faceCount: 1 });
        const b = api.insertPerson({ centroidBlob: f32Blob([0, 1]), faceCount: 1 });
        const fa = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0]),
            personId: a,
        }).lastInsertRowid;
        expect(api.setPersonCoverFace(b, fa)).toEqual({ ok: false, reason: 'mismatch' });
        expect(api.setPersonCoverFace(999999, fa).reason).toBe('person_not_found');
        expect(api.setPersonCoverFace(a, 999999).reason).toBe('face_not_found');
    });

    it('restorePinnedCoverFaces re-applies after clearAllPeople + reassign', () => {
        const did = downloadId();
        const pid = api.insertPerson({
            label: 'Keep',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 1,
        });
        const fid = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 50,
            h: 50,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: pid,
            qualityScore: 0.5,
        }).lastInsertRowid;
        api.setPersonCoverFace(pid, fid);
        const snap = api.listPinnedCoverFaceIds();
        expect(snap).toEqual([fid]);

        api.clearAllPeople();
        const newPid = api.insertPerson({
            label: 'Keep',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 1,
        });
        api.setFacePerson(fid, newPid);
        expect(api.restorePinnedCoverFaces(snap)).toBe(1);
        expect(api.listPeople({}).people[0].cover_face_id).toBe(fid);
        expect(api.listPeople({}).people[0].id).toBe(newPid);
    });

    it('excludePerson uses pinned cover when set', () => {
        const did = downloadId();
        const pid = api.insertPerson({
            label: 'PinnedEx',
            centroidBlob: f32Blob([0, 1, 0]),
            faceCount: 2,
        });
        const fLow = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 30,
            h: 30,
            embeddingBlob: f32Blob([0, 1, 0]),
            personId: pid,
            qualityScore: 0.1,
        }).lastInsertRowid;
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 90,
            h: 90,
            embeddingBlob: f32Blob([0.01, 0.99, 0]),
            personId: pid,
            qualityScore: 0.95,
        });
        api.setPersonCoverFace(pid, fLow);
        const r = api.excludePerson(pid);
        expect(r.ok).toBe(true);
        expect(r.coverFaceId).toBe(fLow);
        expect(api.listExcludedPeople({}).excluded[0].cover_face_id).toBe(fLow);
    });
});

describe('incremental Phase B (preserve merges)', () => {
    let scanRunner;

    beforeAll(async () => {
        scanRunner = await import('../../src/core/ai/scan-runner.js');
    });

    it('mergeFacePerson recomputes target centroid from all faces', () => {
        const did = downloadId();
        const a = api.insertPerson({
            label: 'A',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 1,
        });
        const b = api.insertPerson({
            label: 'B',
            centroidBlob: f32Blob([0, 1, 0]),
            faceCount: 1,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: a,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1, 0]),
            personId: b,
        });
        const r = api.mergeFacePerson(a, b);
        expect(r.moved).toBe(1);
        expect(r.deleted).toBe(1);
        const cents = api.listPeopleCentroids();
        expect(cents).toHaveLength(1);
        expect(cents[0].id).toBe(a);
        expect(cents[0].faceCount).toBe(2);
        // Mean of [1,0,0] and [0,1,0]
        expect(cents[0].centroid[0]).toBeCloseTo(0.5, 5);
        expect(cents[0].centroid[1]).toBeCloseTo(0.5, 5);
    });

    it('incremental Phase B leaves a merged person intact and attaches nearby unassigned faces', async () => {
        const did = downloadId();
        const a = api.insertPerson({
            label: 'Merged',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 1,
        });
        const b = api.insertPerson({
            label: 'Other',
            centroidBlob: f32Blob([0.95, 0.05, 0]),
            faceCount: 1,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: a,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.95, 0.05, 0]),
            personId: b,
        });
        api.mergeFacePerson(a, b);
        expect(api.countPeople()).toBe(1);

        // Nearby unassigned face should attach; far face forms new cluster.
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.98, 0.02, 0]),
            personId: null,
        });
        const far1 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 0, 1]),
            personId: null,
        }).lastInsertRowid;
        const far2 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.01, 0, 0.99]),
            personId: null,
        }).lastInsertRowid;

        const state = {
            phase: 'A',
            faceCount: 0,
            peopleCount: 0,
            noiseFaces: 0,
        };
        const cfg = { faces: { epsilon: 0.5, minPoints: 2, labelMatchEps: 0.4 } };
        await scanRunner._test.runIncrementalPhaseB({
            state,
            signal: { aborted: false },
            log: () => {},
            cfg,
            bcast: () => {},
        });

        expect(api.countPeople()).toBeGreaterThanOrEqual(2); // merged + new far cluster
        const people = api.listPeople({});
        const merged = people.people.find((p) => p.label === 'Merged');
        expect(merged).toBeTruthy();
        expect(Number(merged.face_count)).toBeGreaterThanOrEqual(3); // 2 merged + nearby

        const farPerson = db.prepare('SELECT person_id FROM faces WHERE id = ?').get(far1);
        const farPerson2 = db.prepare('SELECT person_id FROM faces WHERE id = ?').get(far2);
        expect(farPerson.person_id).toBeTruthy();
        expect(farPerson.person_id).toBe(farPerson2.person_id);
        expect(farPerson.person_id).not.toBe(merged.id);
    });

    it('incremental Phase B is a no-op when every face is already assigned', async () => {
        const did = downloadId();
        const pid = api.insertPerson({
            label: 'Solo',
            centroidBlob: f32Blob([1, 0]),
            faceCount: 1,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0]),
            personId: pid,
        });
        const before = api.countPeople();
        await scanRunner._test.runIncrementalPhaseB({
            state: { phase: 'A', faceCount: 0, peopleCount: 0, noiseFaces: 0 },
            signal: { aborted: false },
            log: () => {},
            cfg: { faces: { epsilon: 0.5, minPoints: 2 } },
            bcast: () => {},
        });
        expect(api.countPeople()).toBe(before);
        expect(api.listPeople({}).people[0].id).toBe(pid);
    });

    it('excluded centroid blocks attaching / new people for nearby unassigned faces', async () => {
        const did = downloadId();
        const pid = api.insertPerson({
            label: 'Keep',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 1,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: pid,
        });
        // Exclude a far identity, then insert unassigned faces near that exclusion.
        const ex = api.insertPerson({
            label: 'Nope',
            centroidBlob: f32Blob([0, 0, 1]),
            faceCount: 1,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 0, 1]),
            personId: ex,
        });
        api.excludePerson(ex);

        const u1 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.01, 0, 0.99]),
            personId: null,
        }).lastInsertRowid;
        const u2 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 0.01, 0.98]),
            personId: null,
        }).lastInsertRowid;

        await scanRunner._test.runIncrementalPhaseB({
            state: { phase: 'A', faceCount: 0, peopleCount: 0, noiseFaces: 0 },
            signal: { aborted: false },
            log: () => {},
            cfg: { faces: { epsilon: 0.5, minPoints: 2, labelMatchEps: 0.4 } },
            bcast: () => {},
        });

        expect(db.prepare('SELECT person_id FROM faces WHERE id = ?').get(u1).person_id).toBeNull();
        expect(db.prepare('SELECT person_id FROM faces WHERE id = ?').get(u2).person_id).toBeNull();
        expect(api.listPeople({}).people.some((p) => p.label === 'Keep')).toBe(true);
    });
});
