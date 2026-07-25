# Face review requirements — per-face preview inside People

Status: **implemented**.
Related: [docs/AI.md](AI.md), [docs/API.md](API.md).

> **Implementation note:** the shipped feature is **additive/opt-in**, not
> a replacement of the existing per-photo grid. A new "Review faces"
> toggle on the selected cluster's action bar reveals the face-crop grid
> described below; the default flow (clicking a Person shows the
> existing one-tile-per-photo grid) is completely unchanged. This
> deviates from the original "replace the grid" framing in §5 FR-2 and
> §7 below — those sections have been updated to reflect what shipped.

## 1. Problem statement

The People feature (`src/core/ai/faces.js` DBSCAN clustering + the
`#ai-pane-people` UI) successfully groups detected faces into clusters
("collections") and lets an operator rename / merge / split / delete a
cluster. What it does **not** do is show the operator *which face was
actually detected* inside each item of a cluster.

Confirmed in code:

- The People grid renders one avatar per **cluster**
  (`_personTile`, [src/web/public/js/maintenance-ai.js:1628](../src/web/public/js/maintenance-ai.js)),
  fetched via `GET /api/ai/person/:id/face`
  ([src/web/server.js:8461](../src/web/server.js)). This is a single
  representative face crop and works correctly.
- Clicking a cluster card calls `_showPersonPhotos()`
  ([src/web/public/js/maintenance-ai.js:1683](../src/web/public/js/maintenance-ai.js)),
  which hits `GET /api/ai/people/:id/photos`
  ([src/web/server.js:8573](../src/web/server.js)) →
  `listPhotosForPerson()` ([src/core/db.js:2820](../src/core/db.js)).
  That query uses
  `ROW_NUMBER() OVER (PARTITION BY download_id ORDER BY quality_score DESC, w*h DESC)`
  to collapse the result to **one row per source photo/video**, not one
  row per face.
- The resulting tiles (`_photoTile`,
  [src/web/public/js/maintenance-ai.js:1778](../src/web/public/js/maintenance-ai.js))
  render `<img src="/api/thumbs/{download_id}?w=320">` — the **full
  original photo**, cropped to nothing. The best `face_id` for that
  download is stashed in `data-face-id` but is only read later, when
  committing a split; it is never used to display the actual detected
  face region.
- A per-face crop endpoint already exists and already does the right
  thing, but nothing in the People UI calls it:
  `GET /api/ai/faces/:id/crop` ([src/web/server.js:8518](../src/web/server.js)),
  which extracts `faces.x/y/w/h` with 40% padding and returns a JPEG.

**Net effect:** an operator opening "Person #7" sees a wall of full
photos (one per appearance), often group photos with several people in
frame, with no visual indication of which face in the photo the
algorithm attributed to this cluster. This makes it impossible to
visually audit false positives (wrong face merged into a cluster),
false negatives (a face that should be here but isn't), or to tell two
clusters apart at a glance when they contain visually similar people.
This is the exact gap the operator flagged: clustering ("collection")
works, but there is no face-level preview/review.

## 2. Goals

- Let an operator opt into seeing **one tile per detected face**, cropped
  to the face region, so they can audit exactly what the model detected
  and decide — per face — whether it's a correct match, before renaming,
  merging, splitting, or deleting a cluster.
- Reuse the already-built backend primitives (crop endpoint, reassign,
  quality score) rather than inventing new ones where existing ones
  already fit.
- **Do not change the current/default flow.** Selecting a Person must
  keep showing the existing per-photo grid exactly as it does today; the
  face-level view is an explicit, opt-in action (a toggle button), not a
  replacement.
- Keep parity with existing interaction patterns already used elsewhere
  in the People panel (visual person-picker, viewer hookup, toasts) so
  the change feels native, not bolted on.

## 3. Non-goals

- No change to the clustering algorithm (DBSCAN, `epsilon`, `minPoints`)
  or to the detector/embedding model.
- No new face attributes (gender, landmarks, age) are introduced or
  displayed — those columns exist in schema but are explicitly out of
  scope here (see [docs/AI.md](AI.md#configuration) for their current
  unused state).
- No video-frame timestamp/index tracking — video faces are treated the
  same as photo faces today and this doc does not change that.
- No redesign of merge/rename/delete flows — only *adds* a new opt-in
  panel and its own action bar; the surrounding cluster action bar
  (Merge / Split / Delete) and the existing photo grid are untouched.
- No change to the existing `/photos` endpoint, `listPhotosForPerson()`,
  `_showPersonPhotos()`, or `_photoTile()` — they remain the default and
  are not called by, or coupled to, the new face-review panel.
- Split mode (`_enterSplitMode` / `POST /api/ai/people/:id/split`)
  remains scoped to the original photo grid only — it does **not**
  operate on face-review tiles (see §5 FR-3 for why).

## 4. Current state summary (for implementer reference)

### 4.1 Data model — no migration required

Both tables already carry everything a face-level view needs
([src/core/db.js:365-396](../src/core/db.js)):

```sql
CREATE TABLE faces (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id INTEGER NOT NULL,
    x REAL, y REAL, w REAL, h REAL,   -- bbox, absolute px
    embedding   BLOB    NOT NULL,      -- 512-dim ArcFace, unused by UI
    person_id   INTEGER,               -- FK people, NULL = unassigned/noise
    quality_score REAL,                -- composite [0,1], added later via ALTER
    gender      TEXT                   -- unused, out of scope
);
CREATE TABLE people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT,
    embedding_centroid BLOB NOT NULL,
    face_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    gender TEXT                        -- unused, out of scope
);
```

No new columns, tables, or migrations are needed for the feature
described in this document.

### 4.2 Relevant existing endpoints

| Method | Path | Purpose | Reused as-is? |
|---|---|---|---|
| `GET` | `/api/ai/people` | Cluster list with cover face + count | yes, unchanged |
| `GET` | `/api/ai/people/:id/photos` | One row per **download** (current gallery) | yes, unchanged — still the default view, untouched by this feature |
| `GET` | `/api/ai/faces/:id/crop?w=` | JPEG crop of one face's bbox, 40% padding | **yes — this is the core primitive the new grid calls** |
| `GET` | `/api/ai/person/:id/face?w=` | Best-face avatar for a cluster | yes, unchanged (used on cluster cards) |
| `GET` | `/api/ai/faces/by-download/:id` | All face boxes for one photo, used by the viewer overlay | yes, unchanged (used when opening the source photo from a face tile) |
| `POST` | `/api/ai/faces/:id/reassign` | `{personId\|null}` — move one face to another cluster, or unassign when `personId` is `null` | yes, unchanged — now also triggered from the face-review panel (move icon + "not this person" icon) |
| `POST` | `/api/ai/people/:id/split` | `{faceIds[], label?}` — new cluster from selected faces | yes, unchanged — still only reachable from the original photo grid's split mode |
| `PATCH` / `DELETE` / `POST /merge` | `/api/ai/people/:id` | Rename / delete / merge cluster | yes, unchanged |

### 4.3 Current frontend flow (as shipped)

The default path is byte-for-byte unchanged:

```
_personTile()          → cluster avatar (unaffected)
  click
    → _showPersonPhotos()
        → GET /api/ai/people/:id/photos      (1 row per download)
        → grid.innerHTML = files.map(_photoTile)
            → <img src="/api/thumbs/{download_id}?w=320">   <-- unchanged default
```

A new, entirely additive path hangs off the same detail panel, toggled
by a button rather than triggered automatically:

```
"Review faces" button click  → _toggleFaceReview()
  → _openFaceReview()
      - hides #ai-people-photos-grid (the existing grid, DOM untouched)
      - shows the new sibling panel #ai-face-review
      - GET /api/ai/people/:id/faces?limit=&offset=   (1 row per FACE)
      - grid.innerHTML = faces.map(_faceReviewTile)
          → <img src="/api/ai/faces/{face_id}/crop?w=160">   <-- actual crop
  → click "Review faces" again, or select a different Person
      → _closeFaceReview() restores #ai-people-photos-grid, unchanged
```

`_enterSplitMode()` / `_exitSplitMode()`
([src/web/public/js/maintenance-ai.js](../src/web/public/js/maintenance-ai.js))
continue to toggle a `.split-overlay` element per tile and track
selection by `data-face-id` **on the original photo grid only** — this
selection mechanic was intentionally *not* pointed at the new face-crop
tiles (see §5 FR-3). Opening "Review faces" while split mode is active
exits split mode first, and vice versa, so the two grids never have
conflicting selection state active at once.

## 5. Functional requirements

### FR-1 — Face-level list endpoint

**Shipped as a standalone new endpoint** (not a `mode=` variant of
`/photos`, to keep the two code paths fully decoupled per the
additive-only requirement):

```
GET /api/ai/people/:id/faces?limit=&offset=
```

Backed by `listFacesForPerson(personId, { limit, offset })`
([src/core/db.js](../src/core/db.js)) — a standalone function, not a
parameterized version of `listPhotosForPerson()`.

Response shape (mirrors `listPhotosForPerson`'s existing envelope):

```json
{
  "success": true,
  "personId": 7,
  "faces": [
    {
      "face_id": 1234,
      "download_id": 55,
      "file_name": "photo.jpg",
      "file_type": "photo",
      "file_path": "…",
      "file_size": 204800,
      "group_id": null,
      "group_name": "",
      "message_id": 991,
      "pinned": false,
      "x": 120, "y": 80, "w": 96, "h": 96,
      "quality_score": 0.82,
      "created_at": 1732000000000
    }
  ],
  "total": 341
}
```

Requirements:

- Source query joins `faces` → `downloads` filtered by
  `person_id = :id AND (user_deleted IS NULL OR user_deleted = 0)`,
  ordered by `created_at DESC, face_id DESC` (or quality — TBD by
  implementer, not a hard requirement).
- **No** `ROW_NUMBER()` collapse — every face row for the person is a
  candidate result (this is the entire point of the feature).
- Pagination cap: same ceiling as `listPhotosForPerson` — clamp `limit`
  to `[1, 200]`, default `50`; clamp `offset` to `>= 0`.
- `total` = `COUNT(*)` of matching face rows (not distinct downloads).

### FR-2 — Face-crop tiles in a new, additive "Review faces" panel

- `_showPersonPhotos()` and `_photoTile()` are **not modified**. A new
  `#ai-person-review-faces-btn` toggle button sits on the cluster's
  action bar (alongside Merge / Split / Delete); clicking it calls the
  new faces endpoint into a **new** sibling grid, `#ai-face-review-grid`
  inside panel `#ai-face-review`.
- Each face tile's `<img>` source is
  `/api/ai/faces/{face_id}/crop?w=160` (existing endpoint, unchanged)
  — never `/api/thumbs/{download_id}?w=320`.
- Tile count equals **number of faces in the cluster**, not number of
  distinct source files. Its own count label (`#ai-face-review-count`)
  shows "N detected faces" — the existing `#ai-person-photo-count`
  label (used by the default photo grid) is untouched and keeps
  showing "N appearances" for the photo grid.
- Toggling the panel closed, or selecting a different Person, restores
  `#ai-people-photos-grid` to visible with no re-fetch needed (it was
  only hidden via a CSS class, never unmounted).

### FR-3 — Per-face actions ("decide if this is a correct match")

Each face tile supports the following, reusing existing endpoints — no
new mutation APIs were added:

- **Open source** — clicking a tile (its image, specifically
  `.ai-face-review-open`) opens the existing media viewer on the tile's
  `download_id` via `_personPhotoToViewerFile()` (reused as-is). The
  clicked face's id is attached to the viewer's file object as
  `highlightFaceId` before opening. The viewer's existing face overlay
  (`GET /api/ai/faces/by-download/:id`,
  [src/web/public/js/viewer.js](../src/web/public/js/viewer.js)) reads
  that id and renders the matching `.face-box` with an added
  `.face-box-highlighted` class — a pulsing amber outline (see
  `main.css`) — plus programmatic `.focus()` so `:focus-visible` also
  draws the eye to it. No new overlay endpoint needed; `by-download`
  already returns every box for that image, matched client-side.
- **Reassign single face** — a small "⇄" icon shown on tile hover
  (`.ai-face-review-reassign`) opens the same visual person-picker sheet
  already built for `_mergeSelectedPerson()`
  ([src/web/public/js/maintenance-ai.js](../src/web/public/js/maintenance-ai.js)),
  then calls `POST /api/ai/faces/:id/reassign` with the chosen target
  person id. On success the tile is removed from the panel immediately.
- **"Not this person" (quick unassign)** — a second hover icon, "✕"
  (`.ai-face-review-unassign`), is the fast path for the "decide if
  that is a correct match" requirement: one click calls the same
  `POST /api/ai/faces/:id/reassign` endpoint with `personId: null`,
  clearing `faces.person_id` without requiring the operator to pick a
  destination cluster first. This action was **not** in the original
  proposal but was added because reassigning to *some other* cluster is
  the wrong shape for "this face doesn't belong to anyone in particular
  right now" — unassigning is a first-class outcome of a review pass.
- **Split selection — intentionally NOT wired to face-crop tiles.**
  The original proposal suggested pointing `_enterSplitMode` /
  `_splitSelectedDlIds` at face-review tiles since they already key off
  `data-face-id`. This was **not done**, per the "do not change the
  current flow" constraint: split mode continues to operate exclusively
  on the original `#ai-people-photos-grid` (`_photoTile`, unchanged).
  The face-review panel provides its own dedicated per-face actions
  (reassign / unassign above) instead of participating in split
  selection. Opening "Review faces" while split mode is active exits
  split mode first (`_splitSelectedPerson()` / `_openFaceReview()` each
  close the other's panel before activating), so the two never overlap.

### FR-4 — Quality indicator per face

Reuses the existing HQ/MQ/LQ convention already applied to cluster cards
(`_personTile`'s quality badge, thresholds `>=0.7` / `>=0.4` / below —
factored into a shared `_qualityBadgeLabel()` helper) on each individual
face tile (top-left pill), driven by that face's own `quality_score` —
this lets an operator spot the specific low-quality detections
responsible for a bad match, not just the cluster average.

### FR-5 — Pagination / "load more"

The face-review grid fetches from the server in pages of 100
(`_FACE_REVIEW_PAGE_SIZE`) via `limit`/`offset` on the new endpoint,
appending on "Load more" rather than client-side chunking an
already-fully-fetched array — this mirrors the *intent* of
`INITIAL_RENDER` / `LOAD_MORE_SIZE` in `_renderPeopleGrid` (progressive
reveal so large clusters don't block on one giant fetch) while being
driven by the server-side `limit`/`offset` params from FR-1, since
unlike the People grid the full per-cluster face list can be far larger
than what fits in one response.

## 6. API changes needed (summary)

| Change | Type | Notes |
|---|---|---|
| `GET /api/ai/people/:id/faces` | new endpoint | Standalone, not a `/photos` query-param toggle. Response shape from §5 FR-1. |
| `listFacesForPerson(personId, {limit, offset})` | new `db.js` function | Analogous to `listPhotosForPerson`, without the `ROW_NUMBER()` collapse. Both functions coexist unmodified. |
| `GET /api/ai/faces/:id/crop` | **no change** | Already fit; now also called from the new face-review tiles. |
| `POST /api/ai/faces/:id/reassign` | **no change** | Already fit both the "move to another person" and the "unassign" (`personId: null`) actions. |
| `POST /api/ai/people/:id/split` | **no change, and not reused here** | Still exclusive to the original photo grid's split mode (see §5 FR-3). |

No changes were required to `src/core/ai/faces.js` (detection/clustering
logic), `src/core/ai/scan-runner.js`, or the sidecar wire protocol —
this was purely a read-path + UI addition. `src/web/public/js/viewer.js`
did gain a small, backward-compatible addition: `_renderFaceOverlay()`
now accepts an optional second `highlightFaceId` argument (`undefined`
in every pre-existing call site, so default viewer behavior for
non-face-review opens is unchanged).

## 7. UI/UX requirements

- The face-crop grid is an **additive, opt-in panel** — per the
  corrected product decision, this *is* a toggle, not a replacement.
  A new "Review faces" button (`#ai-person-review-faces-btn`, icon
  `ri-focus-3-line`) sits on the cluster's action bar. Clicking it hides
  `#ai-people-photos-grid` (CSS `hidden` class only — never removed from
  the DOM) and reveals a new sibling panel, `#ai-face-review`, containing
  its own header (count + close button) and grid
  (`#ai-face-review-grid`). Clicking the button again, clicking the
  panel's own close button, or selecting a different Person restores
  the default photo grid exactly as it was.
- Grid layout, spacing, and responsive breakpoints match the existing
  grid classes on `#ai-people-photos-grid`
  ([src/web/public/index.html](../src/web/public/index.html)) — no new
  CSS framework or layout system; `#ai-face-review-grid` uses the same
  Tailwind grid utility classes.
- Empty state: if a cluster has 0 faces (shouldn't normally happen since
  `people` rows require `face_count > 0` per
  `listPeople()`'s `HAVING`-style filter, [src/core/db.js](../src/core/db.js)),
  the face-review panel shows "No faces in this cluster." — a distinct
  i18n key (`maintenance.ai.no_faces`) from the photo grid's existing
  "No photos in this cluster." (`maintenance.ai.no_photos`, untouched).
- Error state: same pattern as today — render the error message text in
  the grid container on a failed fetch.
- Split-mode hint banner and action bar (`#ai-split-hint`,
  `#ai-split-bar`) behavior is **fully unchanged** — they still operate
  only on the original photo grid's `data-face-id` tiles. Opening
  "Review faces" collapses split mode first if it was active
  (`_openFaceReview()` calls `_exitSplitMode()`), and clicking the
  existing Split button collapses the face-review panel first if that
  was open (`_splitSelectedPerson()` calls `_closeFaceReview()`), so the
  two panels never show conflicting selection UI at once.
- Face-review tile hover affordance distinguishes "open source" from
  the mutating actions: the tile's image is one full-bleed
  click-to-open button (`.ai-face-review-open`); "⇄ reassign" and
  "✕ unassign" are separate small icon buttons pinned to the top-right
  corner, only visible on hover/focus (`opacity-0 group-hover:opacity-100`),
  so operators don't accidentally reassign while browsing.
- A quality badge (HQ/MQ/LQ, from FR-4) sits top-left on each face tile;
  a filename label fades in on hover along the bottom edge, matching
  the existing `_photoTile` treatment.

## 8. Non-functional requirements

- **Performance**: the new list query must use the existing
  `idx_faces_person` index ([src/core/db.js:386](../src/core/db.js)) —
  i.e. filter directly on `faces.person_id = ?` with no additional
  full-table scans. Response time budget: comparable to the existing
  `/photos` endpoint for the same cluster size (no `ROW_NUMBER()`
  window function needed, so it should be at least as fast).
- **Caching**: face-crop responses must keep the existing
  `cache-control: public, max-age=604800, immutable` header already set
  by `/api/ai/faces/:id/crop` ([src/web/server.js:8561](../src/web/server.js)).
  No server-side thumbnail caching/pre-generation is required — crops
  remain generated on demand, consistent with current behavior.
- **No new dependencies**: implementation must use the existing `sharp`
  crop pipeline, `better-sqlite3` queries, and vanilla-JS frontend
  patterns already present in the codebase — no new npm packages.
- **Backward compatibility**: `GET /api/ai/people/:id/photos` and
  `listPhotosForPerson()` remain unchanged and functional, since they
  may still be used elsewhere (e.g. any future full-photo export view)
  — confirmed additive, not a replacement of the API. `_showPersonPhotos()`,
  `_photoTile()`, `_enterSplitMode()`/`_exitSplitMode()`/`_commitSplit()`
  and their DOM ids/classes were not modified.

## 9. Acceptance criteria

- [x] Selecting a Person card shows the existing per-photo grid exactly
      as before this feature — no automatic switch to face-level view.
- [x] Clicking "Review faces" on a cluster with *N* faces across *M*
      distinct photos (N ≥ M, e.g. two people-cluster faces appear in
      the same group photo) shows **N** tiles in the new panel; the
      original photo grid (still hidden, not destroyed) would still
      show **M** tiles if revealed again.
- [x] Each face-review tile's image is visibly cropped to a face region
      (verifiable by comparing against the full source photo in the
      viewer), not the full original image.
- [x] Opening a face tile's source photo in the viewer highlights
      (persistent amber outline, not just hover) the specific face that
      tile represented, among all boxes on that photo.
- [x] Reassigning a single face via the "⇄" icon moves only that face
      (`faces.person_id` changes for one row) and the tile disappears
      from the panel on success.
- [x] Clicking the "✕" icon unassigns the face (`faces.person_id` set to
      `NULL`) in one action, without requiring the operator to pick a
      destination cluster.
- [x] Split mode, entered via the existing Split button, still selects
      by `face_id` on the **original photo grid only** and calls
      `POST /api/ai/people/:id/split` with the correct `faceIds` array —
      fully unchanged from before this feature; it is not reachable
      from the face-review panel.
- [x] A cluster with >200 faces paginates via "Load more" in the
      face-review panel without loading everything up front (page size
      100 per request).
- [x] No new database migration was required.
- [x] `npm test` (`vitest run`, executed against Node 24 — matching the
      Dockerfile's `node:24.16.0-bookworm-slim`, not the stale
      `.nvmrc: 20` — via a `docker run` mounting the repo, since no
      local Node runtime was available in the sandbox) passes for
      `tests/ai/face-cluster-ops.test.js` (17/17, including 3 new
      `listFacesForPerson` cases) and the full suite (605/609 passed,
      2 skipped; the only 2 failures — `cluster.sweep.test.js` and
      `integrity.test.js` — were confirmed pre-existing on a clean
      checkout via `git stash`, unrelated to this feature).

## 10. Out of scope (explicitly)

- Gender badge display (`faces.gender` / `people.gender` remain unused).
- Video frame index/timestamp metadata on face rows.
- Face landmark visualization.
- Persisted/pre-generated face-crop thumbnails (on-demand generation is
  sufficient for this scope).
- Any change to DBSCAN parameters, detector model, or embedding
  pipeline.
- Bulk "reject all low-quality faces in this cluster" tooling (a
  reasonable follow-up, but not required to close this gap).
- Wiring split mode / multi-select to face-review tiles (originally
  proposed in §5 FR-3, explicitly descoped per the "don't change the
  current flow" requirement — split stays scoped to the photo grid).
- Making the face-review panel the default view, or removing/replacing
  the photo grid — both were the original proposal and were superseded
  by the additive-toggle requirement.
