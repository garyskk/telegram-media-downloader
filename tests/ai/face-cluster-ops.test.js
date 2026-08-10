// Phase 2 integration tests — manual cluster operations + centroid-
// based label preservation. Locks in:
//   - mergeFacePerson: faces flow from B → A, B is deleted, A.count updates
//   - splitFacePerson: selected faces form a new cluster; source centroid refreshes
//   - listFaceIdsForPersonDownloads: photo-grid split expands to sibling faces
//   - reassignFace: single-face hop; both centroids refresh
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

    it('recomputes source centroid from remaining faces only', () => {
        const did = downloadId();
        // Stale centroid pretends all four faces are still in the cluster
        // (mean of [1,0], [1,0], [0,1], [0,1] = [0.5, 0.5]).
        const pid = api.insertPerson({
            label: 'Mixed',
            centroidBlob: f32Blob([0.5, 0.5]),
            faceCount: 4,
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
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0]),
            personId: pid,
        });
        const leave1 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1]),
            personId: pid,
        }).lastInsertRowid;
        const leave2 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1]),
            personId: pid,
        }).lastInsertRowid;

        api.splitFacePerson([leave1, leave2], 'B');
        const cents = api.listPeopleCentroids().find((p) => p.id === pid);
        expect(cents).toBeTruthy();
        expect(cents.faceCount).toBe(2);
        // Remaining faces are both [1,0] → centroid must be [1,0], not [0.5,0.5]
        expect(cents.centroid[0]).toBeCloseTo(1, 5);
        expect(cents.centroid[1]).toBeCloseTo(0, 5);
    });

    it('clears source cover_face_id when the cover face is moved out', () => {
        const did = downloadId();
        const pid = api.insertPerson({
            label: 'A',
            centroidBlob: f32Blob([1, 0]),
            faceCount: 2,
        });
        const keep = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0]),
            personId: pid,
        }).lastInsertRowid;
        const cover = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1]),
            personId: pid,
        }).lastInsertRowid;
        api.setPersonCoverFace(pid, cover);
        expect(db.prepare('SELECT cover_face_id FROM people WHERE id = ?').get(pid).cover_face_id).toBe(
            cover,
        );

        api.splitFacePerson([cover], 'B');
        expect(db.prepare('SELECT cover_face_id FROM people WHERE id = ?').get(pid).cover_face_id).toBeNull();
        expect(db.prepare('SELECT person_id FROM faces WHERE id = ?').get(keep).person_id).toBe(pid);
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

describe('listFaceIdsForPersonDownloads', () => {
    it('returns every face of the person on the given downloads', () => {
        const did = downloadId();
        const pid = api.insertPerson({
            label: 'A',
            centroidBlob: f32Blob([1, 0]),
            faceCount: 3,
        });
        const other = api.insertPerson({
            label: 'B',
            centroidBlob: f32Blob([0, 1]),
            faceCount: 1,
        });
        const f1 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0]),
            personId: pid,
        }).lastInsertRowid;
        const f2 = api.insertFace({
            downloadId: did,
            x: 10,
            y: 10,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.95, 0.05]),
            personId: pid,
        }).lastInsertRowid;
        api.insertFace({
            downloadId: did,
            x: 20,
            y: 20,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1]),
            personId: other,
        });

        const ids = api.listFaceIdsForPersonDownloads(pid, [did]);
        expect(ids.sort((a, b) => a - b)).toEqual([f1, f2].sort((a, b) => a - b));
    });

    it('returns empty for invalid args', () => {
        expect(api.listFaceIdsForPersonDownloads(null, [1])).toEqual([]);
        expect(api.listFaceIdsForPersonDownloads(1, [])).toEqual([]);
        expect(api.listFaceIdsForPersonDownloads(1, null)).toEqual([]);
    });

    it('split via expanded download ids moves every sibling face and refreshes centroid', () => {
        const did = downloadId();
        // Source starts with a mixed stale centroid
        const pid = api.insertPerson({
            label: 'Mixed',
            centroidBlob: f32Blob([0.5, 0.5]),
            faceCount: 3,
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
        const sibling1 = api.insertFace({
            downloadId: did,
            x: 5,
            y: 5,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1]),
            personId: pid,
        }).lastInsertRowid;
        const sibling2 = api.insertFace({
            downloadId: did,
            x: 10,
            y: 10,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1]),
            personId: pid,
        }).lastInsertRowid;

        // Keep face on a second download so peeling `did` leaves the source alive.
        const did2 = api.insertDownload({
            groupId: '-100777',
            groupName: 'Faces Fixture',
            messageId: 2,
            fileName: 'f2.jpg',
            fileSize: 1000,
            fileType: 'photo',
            filePath: 'Faces_Fixture/images/f2.jpg',
        }).lastInsertRowid;
        db.prepare('UPDATE faces SET download_id = ? WHERE person_id = ? AND id NOT IN (?, ?)').run(
            did2,
            pid,
            sibling1,
            sibling2,
        );

        const faceIds = api.listFaceIdsForPersonDownloads(pid, [did]);
        expect(faceIds.sort((a, b) => a - b)).toEqual(
            [sibling1, sibling2].sort((a, b) => a - b),
        );
        const r = api.splitFacePerson(faceIds, 'Bob');
        expect(r.moved).toBe(2);

        const src = api.listPeopleCentroids().find((p) => p.id === pid);
        expect(src.faceCount).toBe(1);
        expect(src.centroid[0]).toBeCloseTo(1, 5);
        expect(src.centroid[1]).toBeCloseTo(0, 5);

        const bob = api.listPeopleCentroids().find((p) => p.id === r.personId);
        expect(bob.faceCount).toBe(2);
        expect(bob.centroid[0]).toBeCloseTo(0, 5);
        expect(bob.centroid[1]).toBeCloseTo(1, 5);
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

    it('recomputes both centroids after a move', () => {
        const did = downloadId();
        const pA = api.insertPerson({
            label: 'A',
            centroidBlob: f32Blob([1, 0]),
            faceCount: 2,
        });
        const pB = api.insertPerson({
            label: 'B',
            centroidBlob: f32Blob([0, 1]),
            faceCount: 1,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0]),
            personId: pA,
        });
        const moveMe = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1]),
            personId: pA,
        }).lastInsertRowid;
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1]),
            personId: pB,
        });

        api.reassignFace(moveMe, pB);
        const a = api.listPeopleCentroids().find((p) => p.id === pA);
        const b = api.listPeopleCentroids().find((p) => p.id === pB);
        expect(a.faceCount).toBe(1);
        expect(a.centroid[0]).toBeCloseTo(1, 5);
        expect(a.centroid[1]).toBeCloseTo(0, 5);
        expect(b.faceCount).toBe(2);
        expect(b.centroid[0]).toBeCloseTo(0, 5);
        expect(b.centroid[1]).toBeCloseTo(1, 5);
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

    it('countUnclassifiedFaces omits faces near an excluded centroid', () => {
        const did = downloadId();
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

        // True noise far from the exclusion
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: null,
        });

        expect(api.countUnclassifiedFaces(0.5)).toBe(1);
        expect(api.getAiCounts({ facesEpsilon: 0.5 }).noiseFaces).toBe(1);
        api.clearExcludedPeople();
        expect(api.countUnclassifiedFaces(0.5)).toBe(2);
    });

    it('listUnclassifiedFaces returns noise and omits near-excluded faces', () => {
        const did = downloadId();
        const alice = api.insertPerson({
            label: 'Alice',
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
            personId: alice,
        });
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

        const noiseId = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1, 0]),
            personId: null,
        }).lastInsertRowid;

        const listed = api.listUnclassifiedFaces({ facesEpsilon: 0.5, limit: 50, offset: 0 });
        expect(listed.total).toBe(1);
        expect(listed.faces).toHaveLength(1);
        expect(listed.faces[0].face_id).toBe(noiseId);
        expect(listed.faces[0].embedding).toBeUndefined();
    });

    it('count/list unclassified omit faces on user-deleted downloads', () => {
        const live = api.insertDownload({
            groupId: '-100777',
            groupName: 'Faces Fixture',
            messageId: 9101,
            fileName: 'live.jpg',
            fileSize: 1000,
            fileType: 'photo',
            filePath: 'Faces_Fixture/images/live.jpg',
        }).lastInsertRowid;
        const gone = api.insertDownload({
            groupId: '-100777',
            groupName: 'Faces Fixture',
            messageId: 9102,
            fileName: 'gone.jpg',
            fileSize: 1000,
            fileType: 'photo',
            filePath: 'Faces_Fixture/images/gone.jpg',
        }).lastInsertRowid;

        api.insertFace({
            downloadId: live,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: null,
        });
        api.insertFace({
            downloadId: gone,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1, 0]),
            personId: null,
        });

        expect(api.countUnclassifiedFaces(0.5)).toBe(2);
        expect(api.listUnclassifiedFaces({ facesEpsilon: 0.5 }).total).toBe(2);

        db.prepare('UPDATE downloads SET user_deleted = 1 WHERE id = ?').run(gone);

        expect(api.countUnclassifiedFaces(0.5)).toBe(1);
        const listed = api.listUnclassifiedFaces({ facesEpsilon: 0.5, limit: 50, offset: 0 });
        expect(listed.total).toBe(1);
        expect(listed.faces).toHaveLength(1);
        expect(listed.faces[0].download_id).toBe(live);
        expect(api.getAiCounts({ facesEpsilon: 0.5 }).noiseFaces).toBe(1);
    });

    it('suggestPeopleForFace returns nearest within matchEps', () => {
        const did = downloadId();
        const alice = api.insertPerson({
            label: 'Alice',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 1,
        });
        api.insertPerson({
            label: 'Bob',
            centroidBlob: f32Blob([0, 1, 0]),
            faceCount: 1,
        });
        const faceId = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.98, 0.02, 0]),
            personId: null,
        }).lastInsertRowid;

        const near = api.suggestPeopleForFace(faceId, { matchEps: 0.4, limit: 5 });
        expect(near.ok).toBe(true);
        expect(near.suggestions.length).toBeGreaterThanOrEqual(1);
        expect(near.suggestions[0].id).toBe(alice);
        expect(near.suggestions[0].label).toBe('Alice');

        const farFace = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 0, 1]),
            personId: null,
        }).lastInsertRowid;
        const none = api.suggestPeopleForFace(farFace, { matchEps: 0.4, limit: 5 });
        expect(none.ok).toBe(true);
        expect(none.suggestions).toEqual([]);
    });

    it('suggestPeopleForFace includes same-clip people even outside matchEps', () => {
        const clipA = api.insertDownload({
            groupId: '-100777',
            groupName: 'Faces Fixture',
            messageId: 9001,
            fileName: 'clip.mp4',
            fileSize: 5000,
            fileType: 'video',
            filePath: 'Faces_Fixture/videos/clip.mp4',
        }).lastInsertRowid;
        const clipB = api.insertDownload({
            groupId: '-100777',
            groupName: 'Faces Fixture',
            messageId: 9002,
            fileName: 'other.mp4',
            fileSize: 5000,
            fileType: 'video',
            filePath: 'Faces_Fixture/videos/other.mp4',
        }).lastInsertRowid

        // Alice appears on the same clip; embedding is far from the query face
        // so pure centroid match within matchEps would miss her.
        const alice = api.insertPerson({
            label: 'Alice',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 1,
        });
        api.insertFace({
            downloadId: clipA,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: alice,
        });

        // Bob is embedding-close but on a different clip — still a valid match.
        const bob = api.insertPerson({
            label: 'Bob',
            centroidBlob: f32Blob([0, 1, 0]),
            faceCount: 1,
        });
        api.insertFace({
            downloadId: clipB,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1, 0]),
            personId: bob,
        });

        // Query face is near Bob in embedding space, far from Alice centroid,
        // but shares clipA with Alice.
        const faceId = api.insertFace({
            downloadId: clipA,
            x: 10,
            y: 10,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.05, 0.95, 0]),
            personId: null,
        }).lastInsertRowid;

        const r = api.suggestPeopleForFace(faceId, { matchEps: 0.25, limit: 5 });
        expect(r.ok).toBe(true);
        const byId = Object.fromEntries(r.suggestions.map((s) => [s.id, s]));
        expect(byId[alice]).toBeTruthy();
        expect(byId[alice].sameClip).toBe(true);
        expect(byId[bob]).toBeTruthy();
        expect(byId[bob].sameClip).toBeFalsy();
        // Same-clip Alice ranks ahead of embedding-only Bob.
        expect(r.suggestions[0].id).toBe(alice);
    });

    it('suggestPeopleForPerson returns nearest within matchEps and excludes self', () => {
        const alice = api.insertPerson({
            label: 'Alice',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 2,
        });
        const aliceTwin = api.insertPerson({
            label: 'Alice copy',
            centroidBlob: f32Blob([0.98, 0.02, 0]),
            faceCount: 1,
        });
        api.insertPerson({
            label: 'Bob',
            centroidBlob: f32Blob([0, 1, 0]),
            faceCount: 1,
        });
        api.insertPerson({
            label: 'Carol',
            centroidBlob: f32Blob([0, 0, 1]),
            faceCount: 1,
        });

        const near = api.suggestPeopleForPerson(alice, { matchEps: 0.4, limit: 5 });
        expect(near.ok).toBe(true);
        expect(near.suggestions.length).toBeGreaterThanOrEqual(1);
        expect(near.suggestions[0].id).toBe(aliceTwin);
        expect(near.suggestions[0].label).toBe('Alice copy');
        expect(near.suggestions.every((s) => s.id !== alice)).toBe(true);

        // Orthogonal-ish centroid stays outside a tight matchEps.
        const far = api.insertPerson({
            label: 'Far',
            centroidBlob: f32Blob([0.577, 0.577, 0.577]),
            faceCount: 1,
        });
        const empty = api.suggestPeopleForPerson(far, { matchEps: 0.15, limit: 5 });
        expect(empty.ok).toBe(true);
        expect(empty.suggestions).toEqual([]);
    });

    it('suggestPeopleForPerson rejects invalid or missing people', () => {
        expect(api.suggestPeopleForPerson(0).ok).toBe(false);
        expect(api.suggestPeopleForPerson(0).reason).toBe('invalid_id');
        expect(api.suggestPeopleForPerson(-1).ok).toBe(false);
        expect(api.suggestPeopleForPerson(999999).ok).toBe(false);
        expect(api.suggestPeopleForPerson(999999).reason).toBe('not_found');
    });

    it('suggestPeopleForPerson includes same-clip people even outside matchEps', () => {
        const clipA = api.insertDownload({
            groupId: '-100777',
            groupName: 'Faces Fixture',
            messageId: 9201,
            fileName: 'shared-merge.mp4',
            fileSize: 5000,
            fileType: 'video',
            filePath: 'Faces_Fixture/videos/shared-merge.mp4',
        }).lastInsertRowid;
        const clipB = api.insertDownload({
            groupId: '-100777',
            groupName: 'Faces Fixture',
            messageId: 9202,
            fileName: 'alone-merge.mp4',
            fileSize: 5000,
            fileType: 'video',
            filePath: 'Faces_Fixture/videos/alone-merge.mp4',
        }).lastInsertRowid;

        // Alice and twin share clipA but centroids are far apart.
        const alice = api.insertPerson({
            label: 'Alice',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 1,
        });
        const aliceTwin = api.insertPerson({
            label: 'Alice copy',
            centroidBlob: f32Blob([0, 0, 1]),
            faceCount: 1,
        });
        api.insertFace({
            downloadId: clipA,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: alice,
        });
        api.insertFace({
            downloadId: clipA,
            x: 10,
            y: 10,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 0, 1]),
            personId: aliceTwin,
        });

        // Bob is embedding-close to Alice but never shares a download.
        const bob = api.insertPerson({
            label: 'Bob',
            centroidBlob: f32Blob([0.98, 0.02, 0]),
            faceCount: 1,
        });
        api.insertFace({
            downloadId: clipB,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.98, 0.02, 0]),
            personId: bob,
        });

        const r = api.suggestPeopleForPerson(alice, { matchEps: 0.25, limit: 5 });
        expect(r.ok).toBe(true);
        const byId = Object.fromEntries(r.suggestions.map((s) => [s.id, s]));
        expect(byId[aliceTwin]).toBeTruthy();
        expect(byId[aliceTwin].sameClip).toBe(true);
        expect(byId[bob]).toBeTruthy();
        expect(byId[bob].sameClip).toBeFalsy();
        // Same-clip twin ranks ahead of embedding-only Bob.
        expect(r.suggestions[0].id).toBe(aliceTwin);
    });

    it('splitFacePerson on an unassigned face creates a person (new-person path)', () => {
        const did = downloadId();
        const faceId = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1, 0]),
            personId: null,
        }).lastInsertRowid;
        expect(api.listUnclassifiedFaces({ facesEpsilon: 0.5 }).total).toBe(1);

        const r = api.splitFacePerson([faceId], 'Newbie');
        expect(r.personId).toBeTruthy();
        expect(r.moved).toBe(1);
        expect(api.listUnclassifiedFaces({ facesEpsilon: 0.5 }).total).toBe(0);
        expect(api.listPeople({}).people.some((p) => p.label === 'Newbie')).toBe(true);
    });

    it('deleteFace removes an unclassified face permanently', () => {
        const did = downloadId();
        const faceId = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 1, 0]),
            personId: null,
        }).lastInsertRowid;
        expect(api.listUnclassifiedFaces({ facesEpsilon: 0.5 }).total).toBe(1);

        const r = api.deleteFace(faceId);
        expect(r.ok).toBe(true);
        expect(r.faceId).toBe(faceId);
        expect(r.oldPersonId).toBeNull();
        expect(api.listUnclassifiedFaces({ facesEpsilon: 0.5 }).total).toBe(0);
        expect(db.prepare('SELECT id FROM faces WHERE id = ?').get(faceId)).toBeUndefined();
    });

    it('deleteFace refreshes or drops the owning person', () => {
        const did = downloadId();
        const pid = api.insertPerson({
            label: 'Solo',
            centroidBlob: f32Blob([1, 0]),
            faceCount: 1,
        });
        const faceId = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0]),
            personId: pid,
        }).lastInsertRowid;
        const r = api.deleteFace(faceId);
        expect(r.ok).toBe(true);
        expect(r.personDeleted).toBe(true);
        expect(api.countPeople()).toBe(0);
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

        // Nearby singleton (DBSCAN noise) still links via tight matchEps;
        // far pair forms a new cluster (no existing person nearby).
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

    it('cluster-then-link: face inside eps but outside matchEps stays unassigned', async () => {
        // Old greedy attach used full eps and would pull this into Alice.
        // Alice [1,0,0]; face [0.68, 0.32, 0] → d≈0.453 (≤eps=0.5, >matchEps=0.4)
        const did = downloadId();
        const alice = api.insertPerson({
            label: 'Alice',
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
            personId: alice,
        });
        const fringe = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.68, 0.32, 0]),
            personId: null,
        }).lastInsertRowid;

        await scanRunner._test.runIncrementalPhaseB({
            state: { phase: 'A', faceCount: 0, peopleCount: 0, noiseFaces: 0 },
            signal: { aborted: false },
            log: () => {},
            cfg: { faces: { epsilon: 0.5, minPoints: 2, labelMatchEps: 0.4 } },
            bcast: () => {},
        });

        expect(db.prepare('SELECT person_id FROM faces WHERE id = ?').get(fringe).person_id).toBeNull();
        expect(Number(api.listPeople({}).people.find((p) => p.label === 'Alice').face_count)).toBe(1);
    });

    it('cluster-then-link: DBSCAN cluster links to existing person via matchEps', async () => {
        const did = downloadId();
        const alice = api.insertPerson({
            label: 'Alice',
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
            personId: alice,
        });
        // Two close faces near Alice → one DBSCAN cluster whose centroid
        // is within matchEps of Alice → all members link to Alice.
        const f1 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.97, 0.03, 0]),
            personId: null,
        }).lastInsertRowid;
        const f2 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.96, 0.04, 0]),
            personId: null,
        }).lastInsertRowid;

        await scanRunner._test.runIncrementalPhaseB({
            state: { phase: 'A', faceCount: 0, peopleCount: 0, noiseFaces: 0 },
            signal: { aborted: false },
            log: () => {},
            cfg: { faces: { epsilon: 0.5, minPoints: 2, labelMatchEps: 0.4 } },
            bcast: () => {},
        });

        expect(db.prepare('SELECT person_id FROM faces WHERE id = ?').get(f1).person_id).toBe(alice);
        expect(db.prepare('SELECT person_id FROM faces WHERE id = ?').get(f2).person_id).toBe(alice);
        expect(api.countPeople()).toBe(1);
        expect(Number(api.listPeople({}).people[0].face_count)).toBe(3);
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

    it('split→exclude: faces do not reattach to sibling when exclusion is farther than sibling', async () => {
        // Geometry that used to bleed: face closer to kept sibling than to
        // excluded centroid, but still within eps of the exclusion.
        // Alice [1,0,0]; Bob excl [0.7,0.3,0]; face [0.92,0.08,0]
        //   d(Alice)≈0.113  d(Bob)≈0.311  — both ≤ eps=0.5, Alice wins on distance
        const did = downloadId();
        const alice = api.insertPerson({
            label: 'Alice',
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
            personId: alice,
        });
        const bob = api.insertPerson({
            label: 'Bob',
            centroidBlob: f32Blob([0.7, 0.3, 0]),
            faceCount: 1,
        });
        const bobFace = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.92, 0.08, 0]),
            personId: bob,
        }).lastInsertRowid;
        api.excludePerson(bob);
        expect(db.prepare('SELECT person_id FROM faces WHERE id = ?').get(bobFace).person_id).toBeNull();

        await scanRunner._test.runIncrementalPhaseB({
            state: { phase: 'A', faceCount: 0, peopleCount: 0, noiseFaces: 0 },
            signal: { aborted: false },
            log: () => {},
            cfg: { faces: { epsilon: 0.5, minPoints: 2, labelMatchEps: 0.4 } },
            bcast: () => {},
        });

        expect(db.prepare('SELECT person_id FROM faces WHERE id = ?').get(bobFace).person_id).toBeNull();
        expect(Number(api.listPeople({}).people.find((p) => p.label === 'Alice').face_count)).toBe(1);
    });

    it('excluded faces outside labelMatchEps but inside eps stay unassigned (no sibling attach)', async () => {
        // Threshold mismatch: face within attach eps of Alice, outside the
        // tighter labelMatchEps of the excluded centroid — must still skip.
        // Alice [1,0,0]; Bob excl [0.6,0.4,0]; face [0.9,0.1,0]
        //   d(Alice)≈0.141 ≤ eps=0.5
        //   d(Bob)≈0.424  > matchEps=0.4  but ≤ eps=0.5
        const did = downloadId();
        const alice = api.insertPerson({
            label: 'Alice',
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
            personId: alice,
        });
        const bob = api.insertPerson({
            label: 'Bob',
            centroidBlob: f32Blob([0.6, 0.4, 0]),
            faceCount: 1,
        });
        const bobFace = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.9, 0.1, 0]),
            personId: bob,
        }).lastInsertRowid;
        api.excludePerson(bob);

        await scanRunner._test.runIncrementalPhaseB({
            state: { phase: 'A', faceCount: 0, peopleCount: 0, noiseFaces: 0 },
            signal: { aborted: false },
            log: () => {},
            cfg: { faces: { epsilon: 0.5, minPoints: 2, labelMatchEps: 0.4 } },
            bcast: () => {},
        });

        expect(db.prepare('SELECT person_id FROM faces WHERE id = ?').get(bobFace).person_id).toBeNull();
        expect(Number(api.listPeople({}).people.find((p) => p.label === 'Alice').face_count)).toBe(1);
    });

    it('near-excluded faces are filtered from leftover DBSCAN (no new person)', async () => {
        // No kept person nearby — two faces near an exclusion must not form
        // a new cluster via the leftover DBSCAN path.
        const did = downloadId();
        const far = api.insertPerson({
            label: 'Far',
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
            personId: far,
        });
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
            embeddingBlob: f32Blob([0.02, 0, 0.98]),
            personId: null,
        }).lastInsertRowid;
        const u2 = api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0, 0.02, 0.98]),
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
        expect(api.countPeople()).toBe(1);
    });
});

describe('full rebuild Phase B (clears exclusions)', () => {
    let scanRunner;

    beforeAll(async () => {
        scanRunner = await import('../../src/core/ai/scan-runner.js');
    });

    it('clears excluded_people and recreates a person from formerly excluded faces', async () => {
        const did = downloadId();
        const keep = api.insertPerson({
            label: 'Keep',
            centroidBlob: f32Blob([1, 0, 0]),
            faceCount: 2,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([1, 0, 0]),
            personId: keep,
        });
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.99, 0.01, 0]),
            personId: keep,
        });

        const ex = api.insertPerson({
            label: 'Nope',
            centroidBlob: f32Blob([0, 0, 1]),
            faceCount: 2,
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
        api.insertFace({
            downloadId: did,
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            embeddingBlob: f32Blob([0.01, 0, 0.99]),
            personId: ex,
        });
        api.excludePerson(ex);
        expect(api.listExcludedPeople({}).total).toBe(1);

        await scanRunner._test.runFullRebuildPhaseB({
            state: { phase: 'A', faceCount: 0, peopleCount: 0, noiseFaces: 0 },
            signal: { aborted: false },
            log: () => {},
            cfg: { faces: { epsilon: 0.5, minPoints: 2, labelMatchEps: 0.4 } },
            bcast: () => {},
            db,
        });

        expect(api.listExcludedPeople({}).total).toBe(0);
        expect(api.countPeople()).toBeGreaterThanOrEqual(2);
        // Formerly excluded faces are assigned again (not left as denylist noise).
        const unassigned = db.prepare('SELECT COUNT(*) AS n FROM faces WHERE person_id IS NULL').get()
            .n;
        expect(unassigned).toBe(0);
    });
});
