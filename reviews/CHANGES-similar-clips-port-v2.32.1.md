# Similar clips: port of `enhancement` §3 to `enhancement-v2.32.1`

Follow-up to `CHANGES-716a55e1-to-enhancement.md` §3 (Similar clips, lines 89–142). That review
described the PDQ scene-fingerprint / Smith-Waterman "near-duplicate video" subsystem the old
`enhancement` branch added on top of `716a55e1`. None of it existed on `enhancement-v2.32.1`
(package 2.32.1), so the whole subsystem is ported. Core modules are copied unchanged; the
schema, delete paths, navigation and one test are adapted to the v2.32.1 base (§2–§4).

Algorithm id `pdq-scene-v1`. Design and tuning notes live in `docs/SIMILAR-CLIPS.md`.

Files touched: `src/core/phash.js`, `src/core/similar/{align,analyze-runner,config,fingerprint,
index,matcher,partial,scan-runner}.js`, `src/core/db.js`, `src/core/downloader.js`,
`src/config/manager.js`, `src/web/server.js`, `seekbar-service/internal/api/server.go`,
`src/web/public/index.html`, `src/web/public/js/{app,settings,settings-search,tools-catalog,
tools-hub,maintenance-similar}.js`, `src/web/public/locales/{en,th}.json`, `.env.example`,
`docs/SIMILAR-CLIPS.md`, `tests/contract/{inventory.json,fixtures/schema.sql}`, and the tests
listed under **Tests**.

`CHANGELOG.md` is intentionally **not** touched.

---

## 1. What was ported

- **Fingerprinting** (`similar/fingerprint.js`, `phash.js`): one Node ffmpeg walk per video
  (scene-change or floor-interval frames, 64×64 tile, PDQ-256 hash, `showinfo` pts). Stored as a
  `.fp.raw` blob beside the seekbar sprite and as `video_fingerprints` / `video_frame_hashes` rows.
  `downloader.js` calls `pregenerateFingerprint(newId, …)` right after `pregenerateSeekbar`.
- **Analyze** (`similar/align.js`, `analyze-runner.js`, `matcher.js`): Smith-Waterman alignment
  of hash sequences in a `worker_threads` pool, grouped by duration bucket, abortable.
- **Partial clips** (`similar/partial.js`): kinds `similar | partial | partial_review`, with
  separate ratio / frame-distance thresholds for short clips and a review band.
- **Config** (`similar/config.js`, `config/manager.js`): precedence `TGDL_SIMILAR_*` env →
  `advanced.similarClips` → defaults. Defaults: `similarThreshold 50`, `sceneThreshold 0.1`,
  `floorIntervalSec 3`, `partialFrameThreshold 90`, `fingerprintMaxFrames 7200`, and the
  remaining partial/bucket knobs. A stored legacy `fingerprintFps` is dropped on load.
- **Jobs**: `_jobTrackers.similarScan` (`similar_*`) and `similarAnalyze` (`similar_analyze_*`),
  with pending-job resume via `kv` keys `pending_job_similarScan` / `pending_job_similarAnalyze`
  and last-run keys `similar_last_scan` / `similar_last_analyze`.
- **API** (13 routes, all admin-only via the default-deny guest gate), under
  `/api/maintenance/similar/`: `scan`, `scan/stop`, `status`, `stats`, `analyze`,
  `analyze/stop`, `groups`, `delete`, `ignore` (POST + GET), `ignore/:id` (DELETE), `purge`,
  `analyze/purge`. The two purge routes answer `409 {code:'ALREADY_RUNNING'}` while their job runs.
- **WS events**: `similar_progress`, `similar_done`, `similar_analyze_progress`,
  `similar_analyze_done`, `similar_purged`.
- **UI**: `maintenance-similar.js` page (groups, compare/review in the media viewer, ignore list,
  purge, tuning knobs with autosave), wired into Settings autosave / hydration / search and the
  Tools hub. 83 new i18n keys in `en.json` and `th.json`.
- **Env**: `TGDL_SIMILAR_*` block in `.env.example`.

---

## 2. Adaptation: hard-delete schema

`enhancement` soft-deletes downloads (`downloads.user_deleted`); v2.32.1 hard-deletes.

- Seven tables are added inside the existing seekbar `db.exec` block: `video_fingerprints`,
  `video_frame_hashes`, `similar_groups`, `similar_group_members`, `similar_ignores`,
  `similar_partial_scans`, `similar_video_scans`. Per-download rows use `ON DELETE CASCADE` on
  `downloads(id)`; `foreign_keys = ON` is already set.
- Every `user_deleted = 0` predicate in the ported accessors was removed.
- `deleteDownloadsBy` now calls `_pruneIncompleteSimilarGroups(getDb())` after a successful
  delete: the cascade removes the deleted download's member rows, and a group left with fewer
  than two members is no longer a pair.
- `POST /api/maintenance/similar/delete` reuses `dedupDeleteByIds`, `purgeThumbsForDownload`,
  `purgeSeekbarForDownload` and `startDrain` instead of the soft-delete helper.
- `seekbar-service` `handleDeleteSprite` also removes `.fp.raw`, so deleting a sprite does not
  leave an orphan fingerprint blob.

## 3. Adaptation: Tools-page navigation

v2.32.1 replaced the Maintenance hub with Tools pages (`#/settings/tools/<group>/<tool>`).

- No `maintenance-hub.js` edits: `similar` is a tool in the `library` group in
  `tools-catalog.js`; `tools-hub.js` gets the `similar()` status loader, `JOB_TOOLS` and
  `WS_EVENTS` entries. `app.js` routes `#/settings/tools/library/similar` to the page and adds
  the header icon. `#/maintenance/similar` redirects there through the existing `?focus=` path.
- `tools.group.library_desc` updated to mention similar clips; `tools.similar.pending` added.
- The page markup is `#page-maintenance-similar` in `index.html` (balanced `<div>` count checked).

## 4. Adaptation: sidecar-based seekbar generator

v2.32.1's seekbar generator delegates to the Go sidecar and has no `buildSpriteFfmpegArgs`.
`tests/seekbar-fingerprint.test.js` was adapted: the client mock is extended, the
`buildSpriteFfmpegArgs` test is removed (its assertions moved into the hover-only
`generateForDownload` test), and the mocked sidecar result carries `id` / `video_id`.

---

## 5. Contract suite and config tests

Found in the "anything missing?" pass:

- `tests/contract/inventory.json` and `fixtures/schema.sql` were stale (the contract inventory
  test failed on both). Regenerated with `npm run contract:inventory` and
  `npm run contract:schema`.
- The 13 new routes and 5 new WS events have no golden HTTP exchange (they need ffmpeg and real
  videos), so each carries a `skip` reason pointing at `tests/similar-*.test.js` /
  `tests/db-similar-*.test.js`. Coverage is now 278 covered + 14 skipped of 292 routes.
- `tests/config-manager.test.js` gains the three `similarClips` cases from `enhancement` (defaults
  seeded on a partial config, legacy `fingerprintFps` stripped, operator-saved partial knobs kept).
- `tests/similar-config.test.js`: the "no leftover `fingerprintFps`" test no longer sets the dead
  `TGDL_SIMILAR_FINGERPRINT_FPS` env var. `tests/env-knobs.test.js` fails any test-set `TGDL_*`
  name the app does not read; the assertion on the config object is unchanged.

---

## Tests

New / ported: `db-similar-clips`, `db-similar-purge`, `pdq`, `similar-align`, `similar-config`,
`similar-fingerprint`, `similar-matcher`, `similar-partial`, `similar-scan`. Adapted:
`seekbar-fingerprint`. Extended: `config-manager`. Regenerated: `contract/inventory.json`,
`contract/fixtures/schema.sql`.

```
node node_modules/vitest/vitest.mjs run tests/env-knobs.test.js tests/config-manager.test.js \
  tests/similar-*.test.js tests/db-similar-*.test.js tests/pdq.test.js tests/seekbar-fingerprint.test.js
node node_modules/vitest/vitest.mjs run --config tests/contract/vitest.config.js \
  tests/contract/inventory.contract.test.js
```

- 12 files / 110 tests: all pass except one timing flake under parallel load,
  `similar-align › runs SW off the main thread so queued immediates flush` (passes 10/10 in
  each of 3 isolated runs; it assumes the worker outlasts a 25-tick `setImmediate` pump).
- Contract inventory: 9/9.
- Full `vitest run`: 27 files fail, all for reasons outside this port: `compression` and
  `tailwindcss` are not installed in `node_modules`, so `server.js` cannot boot and every e2e
  suite fails; `tgdl-core` is not built (gocore / integrity / dbscan suites). The one failure this
  port caused (`env-knobs`) is fixed above. The new HTTP routes were therefore **not** exercised
  end-to-end.

## Not done

- `docs/API.md` and `docs/ARCHITECTURE.md` have no similar-clips section (only
  `docs/SIMILAR-CLIPS.md`).
- `package.json` / `sw.js` `VERSION` not bumped, so the PWA cache does not bust for the new page.
- No browser click-through of the page, and no real-video fingerprint/analyze run.
