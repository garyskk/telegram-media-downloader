# Changes from `enhancement-v2.32.1` onto `v3.4.15`

Range: base tag **v3.4.15** (`5b0439e`, `release: v3.4.15 — large files download several parts at once`) on branch `enhancement-v3.4.15`. The working tree is **uncommitted**. The behavior being ported is the Go-server reading of `enhancement-v2.32.1` (tip `46f7717`). Notes for that branch: `CHANGES-716a55e1-to-enhancement.md`, `CHANGES-similar-clips-port-v2.32.1.md`, `CHANGES-gallery-player-port-v2.32.1.md`, `CHANGES-deletes-port-v2.32.1.md`, `CHANGES-backup-port-v2.32.1.md`, `CHANGES-safari-hevc-hvc1.md`.

Against `HEAD`: 27 tracked files, 1,000 insertions, 65 deletions, plus untracked files under `core-service/internal/similar/`, `similar_api.go`, `similar_tombstone_test.go`, `hevc.go`, `hevc_test.go`, `catalog_extra.go`, `gallery-shuffle.js`, `maintenance-similar.js`, and `docs/SIMILAR-CLIPS.md`.

`CHANGELOG.md` is not touched. No patch file.

---

## Port decision

Ported onto the Go server (`core-service`): similar clips (`pdq-scene-v1`), operator-delete tombstones and `downloads.user_deleted` retirement, gallery `pinned=0` plus one shuffle session, a docked video stage, the backup gaps that lived in `manager.go` / `queue.go`, and the HEVC `hev1` → `hvc1` retag.

Already on v3.4.15 and left alone:

- The player buffering spinner. `viewer.js` still ignores `stalled` and still uses the sticky `waiting` / seeking delay. This diff only adds `controls-collapsed` and a shuffle branch in `navigateMedia`.
- Seekbar sprites, the long-video budget, and the seekbar sidecar. Fingerprints are a separate ffmpeg walk.
- The faststart data-track retry. `optimize` in `internal/faststart/handler.go` already repeated with `-map -0:d` on `Could not find tag for codec`. This diff adds `-tag:v hvc1` on that same argument list.
- Shared-path unlink, the duplicates listing, the integrity sweep, and the disk-usage counter. None of those files are in this diff.
- Faces, People, clustering, and the faces sidecar as they already run on this server. No face-scan, unclassified-face, or merge-suggestion files are in the diff.

Deliberately not ported (they stay on the old `enhancement` description in `CHANGES-716a55e1-to-enhancement.md` §1–§2):

- Content-adaptive video face scan (window, motion floor, track confirmation, streamed detections).
- Unclassified-face grid, suggestions, new-person, and single-detection delete.
- Exclusion denylist as a feature. If an older database still has `excluded_people`, boot drops the table.
- Pinned covers. If `people.cover_face_id` is present, boot drops the column. People rows stay.
- Merge suggestions and the incremental-versus-rebuild split.

`downloads.user_deleted` is not kept as a live column.

---

## 1. Schema boot

`RunMigrations` calls `migrateCatalogExtras` (`internal/store/catalog_extra.go`).

Tables, all `CREATE TABLE IF NOT EXISTS`:

- `download_tombstones` — primary key `(group_id, message_id)`, `created_at`.
- `video_fingerprints` — `download_id` PK, `algo` default `pdq-scene-v1`, `file_hash`, cascade on `downloads(id)`. Indexes `video_fingerprints_file_hash_idx`, `video_fingerprints_aggregate_hash_idx`.
- `video_frame_hashes` — PK `(download_id, t_sec)`, cascade.
- `similar_groups` — `kind` in `similar | partial | partial_review`.
- `similar_group_members` — `role` in `keep | remove | review`, cascade from the group and from the download.
- `similar_ignores` — `UNIQUE (kind, a_id, b_id)`, `a_id < b_id`, cascade.
- `similar_partial_scans`, `similar_video_scans` — one row per download, cascade.

`retireUserDeleted` runs when `PRAGMA table_info(downloads)` still has `user_deleted`:

- Drops indexes on `downloads` whose `sqlite_master.sql` mentions `user_deleted`.
- Copies `user_deleted = 1` rows into `download_tombstones` (`INSERT OR IGNORE`), 500 per transaction, then deletes those download rows.
- `ALTER TABLE downloads DROP COLUMN user_deleted`.
- Rows with `user_deleted` 0 or null stay. A second boot finds no column. Fresh databases never have the column.

`retireEnhancementFaceSchema`:

- If `people` exists and has `cover_face_id`, drops indexes that mention the column, then `ALTER TABLE people DROP COLUMN cover_face_id`. The people row stays.
- `DROP TABLE IF EXISTS excluded_people`.

---

## 2. Similar clips

Package `internal/similar`. Algorithm id `pdq-scene-v1`. `docs/SIMILAR-CLIPS.md` is the copied Node spec (it still says `worker_threads` and Node delete). The code that runs is this package.

### Fingerprint

`GenerateFingerprint` runs one ffmpeg per video: `select` of scene-change or floor interval (`BuildFingerprintFilter`), scale and pad to a square RGB24 tile, `showinfo` pts, raw video on stdout. `ZipRawFrames` turns each tile into a 64-hex PDQ-256 hash (`PDQHex`). Default tile 64, floor 3s, scene 0.1, max frames 7200. Timeout is the probe duration, clamped to 5 minutes–1 hour. Frames are stored with `UpsertFingerprint` / `ReplaceFrames`. The walk does not write `{id}.fp.raw`. `PurgeRecords` still calls `UnlinkLeftoverRaws` on `{dataDir}/seekbar` for any leftover `.fp.raw`.

A stored fingerprint is current when `algo` is `pdq-scene-v1` and `file_hash` matches (`fingerprintCurrent`). Exact byte-identical pairs are skipped in the matcher (`FileHash` equal) and stay on Duplicates.

New videos: `ingest.go` calls `enqueueFingerprint` after `enqueueSeekbar` for `file_type=video`. One goroutine (`drainFingerprints`) takes ids off a buffer of 200. A full buffer drops the id.

### Analyze and partial

`Analyze` rebuilds `kind=similar` with Smith-Waterman (`AlignHashSequences`). A match is Hamming at or below `similarThreshold` (default 50). Both coverages must be at least 0.7 (`defaultMinCoverage`). Duration tolerance default 0.1. Duration bucket default 120s; a video is compared with the previous, same, and next bucket, and only with a lower id. The larger `file_size` is `keep`. Config key is `pdq-scene-v1|{threshold}|{tolerance}|{bucket}|cov0.7`. Resume is `similar_video_scans` (`skipLeft`).

Partial is optional (`checkPartialClips` on the POST body). Kinds `partial` and `partial_review`. Defaults: `partialMatchRatio` 0.5, `partialFrameThreshold` 90, `partialShortClipSec` 300, `partialShortMatchRatio` 0.5, `partialReviewMatchRatio` 0.35, `partialReviewMinMatchedFrames` 4. Clips with fewer than 4 frames are skipped (`PartialMinClipFrames`). A new longer parent rechecks already-scanned shorter clips. Same-length pairs stay on the similar pass.

`Load` precedence: `TGDL_SIMILAR_*` env, then `advanced.similarClips`, then defaults. Empty env is ignored. `fingerprintFps` is not a field, so a stored legacy value is dropped. `.env.example` comments five of the env names.

Scan and Analyze each run one video (one left-hand sequence) at a time on the job goroutine. There is no worker pool. `AlignHashSequences` checks `ctx` between matrix rows and returns `Cancelled`. The matcher also checks between left videos and between pairs. Stop does not abort the current row.

### Routes and jobs

All admin (`requireAdmin`), in `registerSimilarRoutes`:

- `POST /api/maintenance/similar/scan`, `POST /api/maintenance/similar/scan/stop`
- `GET /api/maintenance/similar/status`, `GET /api/maintenance/similar/stats`
- `POST /api/maintenance/similar/analyze`, `POST /api/maintenance/similar/analyze/stop`
- `GET /api/maintenance/similar/groups` (`kind` empty or `similar|partial|partial_review`)
- `POST /api/maintenance/similar/delete` — `deleteRows` (tombstone, then the usual file cleanup)
- `POST /api/maintenance/similar/ignore`, `GET /api/maintenance/similar/ignore`, `DELETE /api/maintenance/similar/ignore/{id}`
- `POST /api/maintenance/similar/purge`, `POST /api/maintenance/similar/analyze/purge`

A second start of the same job returns `409` `{code:ALREADY_RUNNING}`. Either purge returns the same code while scan or analyze is running. Purge records wipes fingerprints, frame hashes, groups, partial scans, video scans, and the kv keys `similar_last_scan`, `similar_last_analyze`, `pending_job_similarScan`, `pending_job_similarAnalyze`. Ignores stay. Purge Analyze wipes groups, partial scans, and video scans, plus `similar_last_analyze` and `pending_job_similarAnalyze`. Fingerprints and ignores stay.

`startSimilar` writes `pending_job_similarScan` / `pending_job_similarAnalyze` at start and `"null"` at the end, and stores the last result under `similar_last_scan` / `similar_last_analyze`. Nothing on boot reads the pending keys, so a restart does not resume the job.

WebSocket (`Flat: true`): `similar_progress`, `similar_done`, `similar_analyze_progress`, `similar_analyze_done`, `similar_purged` (analyze purge adds `scope:analyze`).

Reload used to paint the bar from `GET /status`, then the socket-open call of `_recoverStatus` hid it while the scan was still inside ffmpeg. The progress callback stored the caller's map by reference and did not put `running` on the frame, so a later empty tick came back with no counters and the page added `hidden`. Status and each progress frame are now a copy stamped `running: true` with the last counters merged in. An empty tick does not wipe them. The page ignores an empty frame and any status response that started before a newer progress paint. Explicit `running: false`, `similar_done`, and `similar_analyze_done` still hide the bar. Covered by `similar_progress_test.go`. The dashboard is embedded, so a running container does not show this until the image is rebuilt.

`PruneIncompleteGroups` deletes a group left with fewer than two members. Called from `deleteMatching`, disk rotation, rescue expiry, and `ListGroups`.

### UI

Tools catalog: `similar` in the `library` group. Page `#/settings/tools/library/similar` renders `maintenance-similar` (`nav.js` already maps `/settings/tools/:group/:tool`). `#/maintenance/similar` still goes to the group page with `?focus=similar` (existing redirect; `nav.js` was not edited).

`maintenance-similar.js`: scan, analyze, stop, partial checkbox (`localStorage` `tgdl.similar.checkPartialClips`, default checked), groups, ignore, both purges, the websocket events above. Settings knobs on that page autosave through `_gatherScopedPayload('maintenance-similar')`. The form does not send `fingerprintMaxFrames` or `fingerprintTilePx`; those stay at defaults unless the env vars are set. `settings-search.js` has no similar entry. `tools.group.library_desc` in `en.json` / `th.json` is unchanged; the catalog fallback string mentions similar clips, the stored translation does not.

92 new keys in `en.json` and the same 92 in `th.json` (shuffle toasts, unpinned filter, similar page).

---

## 3. Deletes and `download_tombstones`

`deleteByWhere` is `deleteMatching(..., tombstone=true)`. `RememberDeletedDownloads` inserts `(group_id, message_id)` with `INSERT OR IGNORE` inside the delete transaction, before the `DELETE`.

Tombstones are written from:

- `deleteRows` / `deleteByWhere`: gallery delete, similar delete, dedup delete, NSFW delete, `write_api` deletes, forward delete, cluster conflict delete, cluster file delete.
- `disk_rotator.go` `rotateBatch`, per id, then `PruneIncompleteGroups`.
- `rescue.go` `sweepRescue`, per id, then `PruneIncompleteGroups`.

Not tombstoned:

- Missing-file prune on a media GET. `autoPruneMissingFile` calls `deleteMatching(..., false, ...)` after the parent directory still exists. The row goes away. The message can be fetched again. `similar_tombstone_test.go` covers this.
- The integrity sweep. `pruneMissingRows` is a raw `DELETE FROM downloads`. It does not call `RememberDeletedDownloads` or `PruneIncompleteGroups`.
- Library and group wipe in `purge_api.go`. Raw `DELETE FROM downloads`. No tombstone.

`Tombstoned` is checked in `ingestTelegram` (returns an empty record) and in `checkpointHistory` (the message is not enqueued). `MessageBounds` is `MIN`/`MAX` over the union of `downloads` (non-story, message id 1..2147483647) and `download_tombstones`. `pull-older` uses the min. `catch-up` uses the max.

---

## 4. Gallery shuffle, `pinned=0`, player dock

### Unpinned

`galleryPinFlags`: `pinned` truthy is pinned-only; `0` or `false` is unpinned-only; pinned-only wins when the value is truthy. `galleryNarrowing` adds `d.pinned = 0`. Applied on `GET /api/downloads/all`, `GET /api/downloads/{id}`, and `GET /api/downloads/search`.

Peer rows are selected as `0 AS pinned`. Pinned-only rewrites that predicate to `0 = 1`, so peers stay out. Unpinned-only keeps `d.pinned = 0`, so peers stay in. Federation still requires an admin session and `include=peers` or `include=all` (`queryGalleryFiles`).

Toolbar: fourth Order radio `unpinned` in `gallery-toolbar.js`. `state.pinnedFilter` is the string `'unpinned'`. It is not written to `tgdl-pinned-first`. `pinnedQs()` returns `&pinned=0`. Copy: `gallery.filter.pinned_unpinned`, `gallery.filter.state_unpinned`.

`_galleryViewKey()` still does `state.pinnedFilter ? 1 : 0`. `'unpinned'` and pinned-only (`true`) share the same key. The empty-state label still checks `getPinnedMode() === 'only'` only. Clear filters sets `state.pinnedFilter = false` directly.

### Shuffle

`gallery-shuffle.js`. One session. `GET /api/downloads/ids` returns the matching id set with no page cap (`collectIDs`). Local ids are numbers. Admin `include=peers` ids are `{id, peer_id}`. `POST /api/downloads/by-ids` accepts up to 100 ids, keeps request order, skips a missing id, and drops a non-`self` peer key unless the session is admin. Over 100 is 400. `GET /api/downloads/{id}` treats `id=ids` as not a group, same as `search`.

Filters on the id request: type tab, `pinnedQs()`, `state.currentGroupId`, gallery scope, `state.searchQuery`. Fisher–Yates. First hydrate is 100 tiles; the rest hydrate in the background and then `materialize()` replaces `state.files`. Both `#gallery-shuffle-btn` and `#modal-shuffle-btn` call `toggleShuffle({ openPlayer: true })`, so the grid chip opens the player. The current item is not pinned first. Turning shuffle off restores the backed-up `state.files`.

`navigateMedia` treats the filter as `all` while shuffle is active. Wrap-around runs only when auto-advance is on and `shuffleComplete()` (every key is already in `state.files`). The order is not rebuilt. Nothing listens for `file_deleted` or removes an id from `session.keys`.

`groupFilesByTime` is still called on `state.files`. A page reload does not call a shuffle clear.

### Dock

`#video-container` is `flex flex-col`. Picture, tap layer, seek overlays, center play, and error overlay sit in `#video-stage`. `#video-controls` is `relative shrink-0` with `bg-black/90`. `_showControls` removes `controls-collapsed`. Hide adds it. CSS is `#video-stage { flex: 1 1 auto; min-height: 0 }` and `.video-controls.controls-collapsed { display: none }`.

`#preview-strip-container` is still in `index.html` (`min-h-[72px]`). The light-theme solid control bar was not added.

---

## 5. Backup gaps in this tree

Server only. `maintenance-backup.js` is not in the diff.

1. Cron. `Create` stores an empty cron unless `mode == snapshot`. `Update` clears `cron` whenever the stored mode is not `snapshot`. Snapshot with an empty cron still errors.
2. Manual retention. `retention` prunes remote `snapshots/` when mode is `snapshot` or `manual`. A job id of 0 skips the local staging unlink. Both existing call sites go through that function, so a finished manual archive job is included.
3. Boot backlog. `NewManager` starts `reconcileRetention`. For each enabled `snapshot` or `manual` destination it opens the provider and calls `pruneRemoteSnapshots`. Failures are logged. Mirror destinations are skipped.
4. Mirror orphans. After a mirror catch-up enqueue, `deleteMirrorOrphans` lists the remote tree, builds the live set from `downloads.file_path`, skips `snapshots` and `snapshots/`, and deletes the rest. A failure is logged and does not fail the catch-up. `listBackupTree` uses `List(".")` for the local provider and `List("")` otherwise.

The wizard still submits `#bk-cron` for every mode (`cron: cron || null`) and still shows a cron badge when `dest.cron` is set. The server drops that cron on create and on update. The retain row is still shown only for snapshot; the payload still sends `retainCount`. There is no coverage-tip banner.

---

## 6. HEVC `hev1` → `hvc1`

`internal/faststart/hevc.go` `NeedsHvc1Retag`. Walks top-level boxes by size (a large `mdat` is not read through) and descends only `moov / trak / mdia / minf / stbl`. An `stsd` over 1 MB aborts the scan. A video sample entry is retaggable when the fourcc is `hev1` and the following `hvcC` (`numOfArrays` at byte 22) contains NAL types 32 (VPS), 33 (SPS), and 34 (PPS). The `hvcC` child is sought 78 bytes after the sample-entry header. An `hev1` entry whose `hvcC` does not already contain NAL types 32, 33 and 34 is remuxed even when `moov` is already at the front. The stream copy is `-bsf:v hevc_mp4toannexb,extract_extradata -tag:v hvc1` (Annex B first, because this server's ffmpeg 5.1 `extract_extradata` only sees start codes); if `extract_extradata` is missing, a two-step Annex B remux through MPEG-TS still copies audio. The temp file replaces the original only when the sample entry is `hvc1` and `hvcC` contains types 32, 33 and 34 — otherwise the original is kept and faststart returns an error. `avc1`, `avc3`, `avc4`, `vp08`, `vp09`, `av01`, `mp4v`, `h263`, `s263`, `encv`, `dvh1`, `dvhe` set a conflict. Any conflict means no retag and no extract. `-tag:v hvc1` would apply to every video stream.

`optimize`: `PlaybackReady` is the skip. It requires the second atom to be `moov`, no top-level `moof`, and neither a retag nor an in-band extract (`status: already`). A fragmented MP4 still starts `ftyp` / `moov` / `moof` / `mdat`…, with empty `stts`/`stsc`/`stco`/`stsz` tables, so “`moov` is second” is not enough. Those files are pending and are stream-copied to one progressive `moov` (no HEVC tag). If the temp file still has a `moof`, the original is kept and faststart returns an error. This is the layout behind the two library files checked on 2026-10-19: `2026-10-18T07-18-21_9239.mp4` (404 `moof`/`mdat` pairs) and `2026-10-18T07-18-24_9254.mp4` (406 pairs). Both are H.264 (`avc1`) plus AAC-LC, not HEVC. Safari media error 3 on the second file is that empty init `moov`, not a missing `hvcC`. The files were not rewritten in place. A manual Optimize videos sweep after this build is running selects them. Nothing stores a faststart-done flag. This server does not faststart on download.

`-tag:v hvc1` is inserted after `-map` and before `-movflags +faststart`, including on the `-map -0:d` retry. The extract filter is not added on the tag-only path. The 0.8×–1.1× size check and the rename are unchanged. The maintenance scan (`handleFaststartScan`) treats a fragmented file, or `moov` plus a needed retag or in-band extract, as work, and on `status: optimized` writes `downloads.file_size` from `newSize`. `file_hash` is not updated. `handleFaststartStats` counts those files as `pending`.

---

## Tests

New or extended files in the tree. A prior run of `go test ./internal/app/ ./internal/backup/ ./internal/faststart/ ./internal/similar/ ./internal/store/ ./internal/download/ -count=1` was reported passing. No download package files are in this diff. This note does not re-run them.

- `internal/store/migrate_test.go` — `TestRetireUserDeletedAndEnhancementFaceSchema`. Flagged row becomes a tombstone and leaves `downloads`. Unflagged row stays. `user_deleted` and `cover_face_id` are gone. `excluded_people` is gone. The people label stays. `video_fingerprints` exists. `RunMigrations` is called again after the retire helpers.
- `internal/similar/similar_test.go` — `TestPDQStableAndSeparatesGradients`, `TestAlignIdenticalAndPartial` (cancel), `TestSimilarGroupsSkipExactHashAndPreferLargerFile`, `TestPartialClipInsideLongerVideo`, `TestConfigEnvOverridesStoredAndDropsLegacyFPS`, `TestShowinfoAndZip`.
- `internal/app/similar_tombstone_test.go` — `TestOperatorDeleteWritesTombstoneAndMissingFileDoesNot` (shared file kept, auto-prune writes no tombstone, bounds are 9..10), `TestSimilarIgnoreGroupsAndPurge` (analyze, ignore kept across purge, fingerprints cleared, purge 409 while scan is marked running), `TestGalleryUnpinnedIDsAndByIDs` (pinned=0, id list, request order, missing id skipped, 101 ids rejected).
- `internal/backup/manager_test.go` — `TestMirrorDropsCronAndDeletesRemoteOrphans`. Mirror create drops a submitted cron. A later mode change leaves cron null. `Run` deletes `orphan.bin`, keeps `keep.bin`, and leaves `snapshots/snapshot-20260101-000000.tar.gz`.
- `internal/faststart/hevc_test.go` — `TestNeedsHvc1Retag` (parameter sets retag, empty `hvcC` does not, `hev1` plus a conflicting tag does not), tag-only remux argv, in-band extract argv (`hevc_mp4toannexb,extract_extradata`), fragmented `moov` is not `PlaybackReady`, and a fragmented remux that still emits `moof` is rejected. `go test ./internal/faststart/ ./internal/app/ -count=1 -timeout 120s` passed after the HEVC extract change and again after the fragment change (`internal/faststart` 0.107s, `internal/app` 31.4s).
- `internal/app/similar_progress_test.go` — a running scan keeps `running: true` and the last counters across an empty progress tick. `go test -count=1 -timeout 120s ./internal/app/` passed (31.4s).

---

## Gaps still thinner than `enhancement-v2.32.1`

- Similar Analyze runs Smith-Waterman on the job goroutine, one left video at a time. Cancel is noticed between matrix rows and between videos, not inside a row. There is no `worker_threads` pool. Scan and the ingest fingerprint queue are also one ffmpeg at a time, and the queue drops an id when 200 are waiting. Pending-job kv keys are written and cleared; boot does not resume them. `docs/SIMILAR-CLIPS.md` still describes the Node layout.
- Shuffle does not drop a deleted id from the session. Continuous play does not reshuffle at the end; it wraps the existing order once every id is hydrated. The grid chip opens the player. The current item is not kept first. The full id list is pulled into `state.files` after the first 100, not windowed. Time headers still run. `_galleryViewKey` does not distinguish unpinned from pinned-only.
- The dock still leaves `#preview-strip-container` in the modal. Controls collapse with `display: none`.
- Backup cron and mirror-orphan behavior are server-side. The wizard still submits cron for mirror and manual, still shows a stored cron badge, still hides retain for manual, and has no coverage tip.
- Missing-file prune and the integrity sweep do not tombstone. A library or group wipe does not tombstone. Face-scan redesign, unclassified faces, the exclusion denylist, pinned covers, and merge suggestions are not ported; boot only drops `cover_face_id` and `excluded_people` when an older database still has them.
- Similar scan progress and the faststart fragment/`hev1` remux are in the working tree only. The container on port 3000 still serves the previous embedded dashboard and the previous server until the image is rebuilt. Existing fragmented and `hev1` files change only when Optimize videos runs after that build.

---

## 7. Compose

Diffed `v2.32.1`..`enhancement-v2.32.1` for `docker-compose.yml`, `docker-compose.synology.yml`, `seekbar-service/docker-compose.yml`, `Dockerfile`, `.dockerignore`, and `.env.example`. Synology and the seekbar compose file did not change. `TGDL_FACES_VIDEO_*` is not in that `.env.example` or compose diff (commit `af30aad` only adds review files).

`docker-compose.yml` on this branch now follows that local-stack delta, adapted to the Go server:

- `telegram-downloader` uses `build: .`. `image: ghcr.io/botnick/telegram-media-downloader:latest` and `pull_policy: always` stay in the file, commented, so a reader can switch back to the published image. Header and service comments say the app image is built from this tree with `docker compose up -d --build`.
- `autoheal` has `profiles: [autoheal]` and `watchtower` has `profiles: [autoupdate]`. A plain `up` does not start watchtower, so it does not replace the locally built app image. Start them with `docker compose --profile autoheal --profile autoupdate up -d --build`. Memory limit `TGDL_MEM_LIMIT`, healthcheck, labels, socket mounts, and `network_mode: none` on autoheal were left as they are. This compose file has no `read_only`, `cap_drop`, `security_opt`, or `user:` keys to preserve.
- `NODE_ENV=development` was not applied. The 3.x compose and Dockerfile do not set `NODE_ENV`; the runtime is the Go server.
- Faces CPU cap (`cpus: ${TGDL_FACES_CPU_LIMIT:-6}` and the `.env.example` `# TGDL_FACES_CPU_LIMIT=6` line) was skipped. No `tgdl-faces` service exists in the 3.4.15 compose files, and one was not added.
- `docker-compose.synology.yml` was not in the 2.x delta. It still pulls `ghcr.io/botnick/telegram-media-downloader:latest` and was left unchanged. `seekbar-service/docker-compose.yml` did not change on the 2.x branch either.
- The Dockerfile seekbar stage, VA-API arch split, and `.dockerignore` `seekbar-service/bin` lines belong to the Node image. The Go `Dockerfile` already builds this tree, so those files were not changed.

`.env.example` already commented five `TGDL_SIMILAR_*` names. The other eight names from the 2.x example were appended, still commented, with the same defaults the Go loader uses: `TGDL_SIMILAR_DURATION_BUCKET_SEC`, `TGDL_SIMILAR_PARTIAL_FRAME_THRESHOLD`, `TGDL_SIMILAR_PARTIAL_SHORT_CLIP_SEC`, `TGDL_SIMILAR_PARTIAL_SHORT_MATCH_RATIO`, `TGDL_SIMILAR_PARTIAL_REVIEW_MATCH_RATIO`, `TGDL_SIMILAR_PARTIAL_REVIEW_MIN_MATCHED_FRAMES`, `TGDL_SIMILAR_FINGERPRINT_MAX_FRAMES`, `TGDL_SIMILAR_FINGERPRINT_TILE_PX`. The five existing lines were not rewritten. 2.x compose never passed these into the service `environment:` block, and this compose does not either. A bare-metal process sees them when they are exported. Compose forwards a `.env` entry only when the compose file references it.
