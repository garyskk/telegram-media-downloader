# Changes from `716a55e1` to `enhancement`

Range: `716a55e1ccf5059098619dfd778364cda7c09374` (`chore(deps-dev): bump the development group with 2 updates (#56)`, 2026-06-14, package **2.24.5**) through `80e0f5b` (tip of `enhancement`, package **2.24.5-26**).

That commit is the merge base, so this is the full tree difference. 121 files, 25,893 insertions, 1,853 deletions. Patch file: `716a55e1-to-enhancement.patch`.

---

## Port decision (`enhancement-v2.32.1`)

**§1 and §2 are not ported.** Video face scanning stays the v2.32.1 sampler, and People stay on the v2.32.1 sort, crop cache, Go DBSCAN, re-cluster, and reindex. The content-adaptive sampler, face-review grid, unclassified-face workflow, exclusion denylist, pinned cover, merge suggestions, and the incremental-vs-rebuild split stay on the old `enhancement` branch.

v2.32.1 already covers the operational overlap: faces-service 0.5.x (CPU budget, quality gate before embedding, streamed frames, `frame_time_sec`), scan rows left unscanned when the sidecar fails, undici timeouts past the old 300 s cap, disk-cached crops at `TGDL_FACE_CROP_CONCURRENCY` (default 4), server-side People sort, and DBSCAN in Go. `scanVideos` stays off unless turned on. Re-cluster still runs Phase B on existing embeddings. Reindex from scratch still wipes detections and clusters, then scans again.

The Faces / people and Faces sidecar rows in §8, the `advanced.ai.faces` knobs in §9, and the face-review / video-sampler tests in §12 are part of this decision. People sort and the crop-concurrency cap are already on this branch from v2.32.1; they are not re-ported from here.

**§3, §4, §5, and §6 are ported** on `enhancement-v2.32.1`. Notes: `CHANGES-similar-clips-port-v2.32.1.md`, `CHANGES-gallery-player-port-v2.32.1.md`, `CHANGES-deletes-port-v2.32.1.md`, `CHANGES-backup-port-v2.32.1.md`. `downloads.user_deleted` is not brought back. Operator deletes write `download_tombstones`, and similar-clips rows cascade on hard delete.

---

## 1. Video face detection — not ported

Not ported. See the port decision above. The description below is what `enhancement` changed relative to `716a55e1`.

Uniform evenly-spaced frame sampling and greedy single-best-frame dedup are replaced by a duration-independent, content-adaptive pipeline. A 10-second clip and a multi-hour video use the same window and floor interval. Sampling density no longer scales with duration.

### Sidecar (`faces-service`)

- Single sequential `cv2.VideoCapture` decode. `CAP_PROP_POS_FRAMES` seeking is gone (it landed on the nearest keyframe on long-GOP H.264/HEVC).
- Fixed window (`videoWindowSec`, default 0.4s): keep the sharpest frame in the window from a cheap luma signature.
- A sample is kept when motion exceeds `videoMotionThreshold` (default 6.0, luma-diff 0–255) or `videoFloorIntervalSec` (default 3.0s) has elapsed.
- Detections stream and are discarded immediately (bounded in-flight concurrency). Memory no longer scales with sample count.
- `_build_face_tracks` merges detections into identity tracks. A face seen in one sampled frame must clear a stricter score and quality bar. A face confirmed across two or more frames still has a quality floor and a landmark-regularity gate (stops the detector repeating the same non-face texture).
- Confirmed identities keep up to 3 pose-diverse embeddings.
- Quality scoring is on for video frames and `/detect/batch-b64`.
- `Face` model includes `landmark_regularity`.
- `videoMaxFrames` is a runaway ceiling (default 20,000), no longer a density control (old default 120).
- `POST /detect/video` accepts optional `job_id` and `nice`.
- `GET /detect/video/status/{job_id}` reports decode position (`video_progress.py` in-memory registry). Poll failure, 404, or an older sidecar does not change the returned faces.
- Per-request Unix nice: request body `nice` overrides `TGDL_FACES_VIDEO_NICE`.
- `preload_named_model` flattens nested insightface model directories so loading does not hit an assertion error.
- Default detector pack in compose is `buffalo_m` (same ResNet50 recognition head as `buffalo_l`, lighter SCRFD detector). Switching packs that change the recognition head still needs a re-scan.
- Default `detSize` is 480 (was 640).
- Confirmed-track floors lowered: quality 0.45 → 0.35, score 0.60 → 0.50, landmark regularity 0.35 → 0.15, so harder poses in group clips are kept.
- `videoWindowSec` and `videoMotionThreshold` are sidecar-only. The Node fallback uses ffmpeg `scene` (0–1), which is a different scale.

### Node client and scan runner

- ffmpeg fallback (`faces-client.js`, used when the sidecar has no shared filesystem): one continuous ffmpeg process, one `select` filter (`isnan(prev_selected_t)+gte(t-prev_selected_t,floor)+gt(scene,threshold)`), incremental JPEG parsing, same track-confirmation logic in JS.
- Shared knobs on the Node side: `videoFloorIntervalSec`, `videoMaxFrames`.
- `detectFacesInVideo` polls progress every `videoProgressPollMs` (default 5s, `TGDL_FACES_VIDEO_PROGRESS_POLL_MS`) and forwards it through `scan-runner.js`.
- Dashboard shows decode progress, for example `Video: clip.mp4 — 42% decoded (3,412/8,120 frames)`. The same line is folded into the 5s-throttled `aiPeople progress` log.
- Faces HTTP calls that can run longer than 300s pass an explicit undici `Agent` so Node’s built-in `headersTimeout` / `bodyTimeout` do not kill a still-running `/detect/video`, `/detect/batch`, or `/detect/batch-b64`. A video that already failed this way was marked scanned with 0 faces and is not retried; it needs “Reindex from scratch” or a cleared `ai_indexed_at`.
- `scanVideos` (default off) opts video files into face scans from Maintenance.
- `videoScanLimit` (default 0 = unlimited) caps unindexed videos per run.
- `videoNice` (default 0) is the Unix nice bump for the video phase (Node, ffmpeg fallback, and sidecar).
- Compose does not inject `TGDL_FACES_VIDEO_SCAN_LIMIT` or `TGDL_FACES_VIDEO_NICE` with `:-0` defaults, because env beats dashboard kv and would ignore the UI.
- Optional commented `cpu_shares: 256` on the faces service when scans starve the main app.
- Job tracker `_shortProgress` accepts both `processed` and `scanned`.
- Progress label is “Files indexed” when `scanVideos` is on, otherwise “Photos indexed”.

---

## 2. People, clustering, and face review — not ported

Not ported. See the port decision above. The description below is what `enhancement` changed relative to `716a55e1`.

### Review faces

- Maintenance panel: one tile per detected face, cropped to the face box, for auditing detection. Photo grid stays the default.
- `GET /api/ai/people/:id/faces` lists every face for a person (does not collapse to one row per download).
- Opening the viewer from a review tile highlights that face.

### Unclassified faces

- `countUnclassifiedFaces` / `getAiCounts({ facesEpsilon })` count faces that are unassigned and not near an excluded centroid.
- `GET /api/ai/faces/unclassified` — paginated crops (`limit`, `offset`).
- `GET /api/ai/faces/:id/suggestions` — nearest People within `labelMatchEps`, plus same-download (“clip”) co-occurrence. Same-clip ranks first.
- `POST /api/ai/faces/:id/new-person` — `{label?}` creates a person from one face.
- `DELETE /api/ai/faces/:id` — permanently deletes one detection.
- UI: select, assign, remove. **Select all** selects faces already loaded in the grid (including Show more). It does not select unloaded pages.
- Page size for unclassified and review grids is 24.
- Crop tiles use `data-src`. A queue loads 4 crops at a time as they scroll into view (`face-crop-queue.js`).
- Crop endpoints run at most 4 generations at once (`TGDL_FACE_CROP_CONCURRENCY`, clamp 1–8, default 4).

### Clustering

- `POST /api/ai/faces/recluster` — incremental Phase B only. Unassigned faces attach to existing people. Merges and labels stay. New clusters link on the tighter `labelMatchEps`. Faces near excluded centroids stay unassigned.
- `POST /api/ai/faces/rebuild` — full DBSCAN. Wipes people and the exclusion denylist and reshapes every cluster. Labels and covers carry over when centroids match. Exclusions are cleared and previously excluded identities can return.
- `POST /api/ai/faces/reindex` — wipes detections, clusters, and the exclusion denylist, then re-scans. Broadcasts `ai_faces_reindexed`.
- Split: `splitFacePerson` recomputes centroids for the surviving source cluster. If `downloadIds` are sent, the split expands to sibling faces on those downloads (`listFaceIdsForPersonDownloads`). The split UI shows clustered face crops.

### Cover, exclude, merge, sort

- `POST /api/ai/people/:id/cover` with `{faceId}` pins the avatar. `people.cover_face_id` and `excluded_people.cover_face_id`. Pinned cover wins over the auto-picked face. Survives recluster; restored after resets when the face still matches.
- `POST /api/ai/people/:id/exclude` snapshots the centroid into `excluded_people` and drops the cluster so it does not come back on recluster. `DELETE /api/ai/people/:id` is still temporary (faces become unassigned and may return).
- `GET /api/ai/people/excluded` lists the denylist. `DELETE /api/ai/people/excluded/:id` restores one entry. Rebuild and full reindex clear the denylist.
- `GET /api/ai/people/:id/suggestions` ranks other people by centroid distance within `labelMatchEps` and same-download co-occurrence. UI: detail-panel chips and a ranked **Merge into…** picker.
- `GET /api/ai/people` accepts `sortBy` / `sort` (`face_count` | `avg_quality` | `name`) and `sortDir` / `dir` (`asc` | `desc`). Default remains `face_count` + `desc`.
- People grid: shared Asc/Desc toggle beside Faces / Quality / Name. Re-clicking the active field flips direction. Direction persists across field changes.
- Name sort includes unlabeled people. They lead on Asc and trail on Desc (ordered by id among themselves). Labeled names sort A–Z / Z–A.

---

## 3. Similar clips — ported

Ported. Verified on this branch: `src/core/phash.js`, `src/core/similar/` (fingerprint, scan, matcher, align, partial, analyze, config), `pdq-scene-v1`, `pregenerateFingerprint` from the downloader, the seven similar tables, the 13 `/api/maintenance/similar/` routes, the five `similar_*` WebSocket events, and `maintenance-similar.js`. Smith-Waterman stays on a `worker_threads` worker. The Go sidecar still deletes `.fp.raw` with the sprite. Defaults match (`similarThreshold` 50, `partialFrameThreshold` 90, `partialMatchRatio` 0.5, `fingerprintMaxFrames` 7200). A stored `fingerprintFps` is dropped on merge.

Adapted to this base: no `user_deleted` predicates (member rows cascade, and a group left with fewer than two members is pruned); the page lives under Tools (`#/settings/tools/library/similar`), with `#/maintenance/similar` redirecting there. Detail: `CHANGES-similar-clips-port-v2.32.1.md`.

The description below is what `enhancement` changed relative to `716a55e1`.

New subsystem for near-duplicate videos and for shorter excerpts inside longer videos. Byte-identical files stay on Maintenance → Duplicates (SHA-256).

Documented in `docs/SIMILAR-CLIPS.md`. UI: Maintenance hub card and `#/maintenance/similar` (`maintenance-similar.js`).

### Fingerprints

- Algorithm id `pdq-scene-v1`.
- Separate Node ffmpeg walk from hover sprites. Hover sprites stay a uniform fps + tile WebP from the Seekbar page / Go sidecar.
- Scene-or-floor `select` (`sceneThreshold` default 0.1, `floorIntervalSec` default 3s), 64×64 tiles, PDQ-256, real presentation timestamps.
- `src/core/phash.js` plus `src/core/similar/` (`fingerprint.js`, `scan-runner.js`, `matcher.js`, `align.js`, `partial.js`, `analyze-runner.js`, `config.js`, `index.js`).
- New downloads call `pregenerateFingerprint`.
- Scan skips a file when `file_hash` matches and `algo` is `pdq-scene-v1`.
- Early design stored 1 fps hashes from the seekbar ffmpeg pass and a dual RGB24 dump (`.fp.raw`). That path was replaced by the separate scene-aware walk. The Go sidecar still deletes `.fp.raw` alongside `.webp` / `.jpg` / `.json` on sprite delete. The main image still compiles the Go sidecar and ships it at `SEEKBAR_BIN` for hover sprites when `SEEKBAR_SIDECAR_URL` is unset.

### Analyze

- Rebuilds `kind='similar'` groups with Smith-Waterman alignment (bumpers and excerpts, not only t=0 Hamming).
- Alignment runs on a `worker_threads` worker so HTTP stays responsive. SQLite, incremental `similar_video_scans`, Stop, and WebSocket progress stay on the main thread.
- Partial-clip search is optional in the API body (`checkPartialClips`) and a checkbox in the UI, on by default.
- A new file is compared as a clip against longer parents. A new longer parent is also compared against already-scanned shorter clips. Already-grouped remove/review clips stay skipped.
- Same-length pairs are Similar-only.
- Partial auto-confirm defaults: at least 4 matched scenes and at least 50% coverage of the clip (`partialMatchRatio` 0.5, `partialReviewMinMatchedFrames` 4).
- Review band: `partialReviewMatchRatio` 0.35.
- Short-clip band: `partialShortClipSec` 300, `partialShortMatchRatio` 0.5.
- `partialFrameThreshold` default 90 (was 70 during development) on the PDQ-256 Hamming scale. `similarThreshold` default 50. Both clamp 0–128.
- Duration bucket `durationBucketSec` 120, `durationTolerance` 0.1. Analyze config key includes `cov0.7`.
- `fingerprintMaxFrames` 7200, `fingerprintTilePx` 64.
- Saved knobs are not rewritten on upgrade. Change them in Settings. Precedence: `TGDL_SIMILAR_*` env, then `advanced.similarClips`, then defaults. Empty env is ignored. Stored `fingerprintFps` is dropped on merge.

### Maintenance actions

- Scan start / stop, Analyze start / stop, status, stats.
- Groups with keep/remove members, filtered by `kind=similar|partial|partial_review`.
- Delete uses the same path as exact-dedup.
- Ignore / list / un-ignore false-positive pairs (`kind` defaults to `similar`).
- **Purge Analyze** (`POST /api/maintenance/similar/analyze/purge`) wipes groups and Analyze cursors. Fingerprints, ignores, and hover sprites stay. Does not start Analyze. Broadcasts `similar_purged` with `scope:'analyze'`.
- **Purge records** (`POST /api/maintenance/similar/purge`) wipes hashes, groups, and resume cursors. Ignores and hover sprites stay. Does not start Scan.
- Either purge returns `409` `{code:'ALREADY_RUNNING'}` if Scan or Analyze is running.
- A no-op Scan (nothing pending) is 100% / up to date. It used to stick at 5% because the job finished before the POST response and the page treated an empty progress object as 5%.
- Stats survive restart via `kv['similar_last_scan']` and `kv['similar_last_analyze']`.
- Hub running pill is Scan or Analyze.
- Settings on the similar page autosave (`settings.autosave.label.similar`).

### WebSocket

- `similar_progress` — `{stage, processed, total, generated, skipped, errored}`
- `similar_done` — `{processed, generated, skipped, errored, durationMs, cancelled}`
- `similar_analyze_progress` — `{stage, processed, total, comparedPairs, groups}`
- `similar_analyze_done` — `{similarGroups, comparedPairs, cancelled, durationMs, checkPartialClips, partialSkipped, partialGroups, partialReviewGroups, partialClipsScanned}`
- `similar_purged` — `{ts}` (analyze-scope purge also sends `scope:'analyze'`)

---

## 4. Gallery and player — ported

Ported. The buffering spinner (ignores `stalled`, 200 ms `waiting` / `seeking` delay), the long-video sprite budget (`spriteBudgetMs`, clamp 5 min / 1× realtime / 60 min), and the faststart `-map -0:d` retry were already on v2.32.1. This branch adds the unpinned filter (`pinned=0` on gallery, group, and search, including federated), one shuffle session (`GET /api/downloads/ids`, `POST /api/downloads/by-ids`, shared by the grid chip and the player), and the docked player (`#video-stage`, `#video-controls` with `controls-collapsed`, `#preview-strip-container` removed).

The faststart sweep does not skip `user_deleted` rows. Hard delete already removes the row. Detail: `CHANGES-gallery-player-port-v2.32.1.md`.

The description below is what `enhancement` changed relative to `716a55e1`.

### Shuffle

- One session shared by the media-tabs Shuffle chip and the player button.
- Enabling from the grid shuffles the full filtered ID set into the gallery without opening the lightbox. Closing the player keeps that order.
- Infinite scroll hydrates the next shuffle window, not chronological pages.
- Time-section headers (Today / Yesterday / Older) are hidden while shuffled.
- Filter, group, or scope reloads clear the session.
- Player shuffle is a no-repeat playlist of every file matching the current filters (group / All Media, type chip, pinned chip, federation scope), not only the loaded page.
- Enabling from the player keeps the current item first. Continuous play reshuffles when the playlist wraps.
- `GET /api/downloads/ids` returns the full matching ID set (no page limit). Same filters as `/api/downloads/all`: `type`, `pinned`, `groupId`, `include`, `peerId`. Local: `{ids: number[], total}`. Federated: `{ids: [{id, peer_id}], total}`. Guests are forced to `local`.
- `POST /api/downloads/by-ids` hydrates up to 100 ids in request order as gallery tiles. Guest-allowed; peer keys are ignored for guests.
- Delete while shuffle is active drops the id from keys, cache, and backup playlist and advances to the next remaining item, including on WebSocket `file_deleted`.

### Unpinned filter

- Download queries accept unpinned-only (`pinned = 0`) in addition to pinned-only. Gallery, group, and search paths, including federated lists. Peer rows are always `pinned = 0`, so they stay in an unpinned filter.

### Video player layout and buffering

- Column layout: video stage and controls are separate. Controls dock below the video and auto-hide; the stage expands into that space. Controls collapse when hidden.
- Removed unused `#preview-strip-container` (`min-h-[72px]`), which reserved an empty band under the seekbar filmstrip.
- Buffering spinner ignores the network `stalled` event (browsers fire it when the byte-range download pauses after the buffer is full, while frames keep advancing).
- Spinner follows a sticky `waiting` flag plus in-progress `seeking` while playing, with a 200ms delay so buffered skips do not flash. `readyState` alone missed mid-playback waits because Chrome can stay at `HAVE_ENOUGH_DATA` while firing `waiting`.

### Seekbar sprites for long videos

- Sprite encodes for videos of about an hour or more used the 120s thumbnail ffmpeg kill and treated a 60s sidecar sync wait as a miss, which started a second ffmpeg and surfaced a fake “does not contain any stream” error.
- Node submits async, polls the sidecar job, and uses `spriteTimeoutMs`: `clamp(5 min, 1× realtime, 60 min)`.
- Timeouts stay retryable. Gallery thumbs stay at 120s.
- `runFfmpegArgs` / `_runFfmpeg` take `timeoutMs`. Timeout errors report the actual seconds.
- `purgeSeekbarForDownload` always deletes the `seekbar_sprites` row, including when the caller already fetched the row (soft-delete used to leave orphans).
- Spawn looks for `SEEKBAR_BIN` first, then `seekbar-service/bin/seekbar-server`.

### Faststart

- Remux retries once with `-map -0:d` when ffmpeg fails with “Could not find tag for codec … codec not currently supported”. That covers iPhone/QuickTime `mebx` metadata data tracks, which the MP4 muxer cannot tag. Data tracks carry no audio, video, or subtitle payload.
- Faststart sweeps skip `user_deleted` rows.

---

## 5. Deletes, dedup, and disk accounting — ported

Ported, without `downloads.user_deleted`. Shared-path unlink (`idsWithFileInUse`), `GET /api/maintenance/dedup/sets`, the `/files` missing-file prune, cascade of faces and the other side rows, and the disk-quota counter that pulls down to the catalogue total were already on v2.32.1. A missing source on a face crop calls that same prune. An operator delete writes `download_tombstones` so catch-up and pull-older do not fetch the message again; a boot migration copies any leftover `user_deleted = 1` rows into that table and drops the column. Cluster conflict still hard-deletes and tombstones. Detail: `CHANGES-deletes-port-v2.32.1.md`.

The description below is what `enhancement` changed relative to `716a55e1`.

### Soft-delete

- `downloads.user_deleted` (integer, default 0). Operator delete sets `user_deleted = 1` and keeps the row so backfill does not re-fetch.
- `deleteDownloadsBy` also deletes faces, embeddings, tags, and seekbar rows, and fails pending upload jobs for those ids.
- Boot integrity runs one-shot `purgeSoftDeletedArtifacts()` for leftovers from older builds.
- Gallery, search, counts, CLI `viewDownloads` group totals, disk quota, and faststart queries exclude `user_deleted` rows.
- Disk quota uses `getTotalSizeBytes()` (live DB sum) instead of a filesystem cache that was never decremented on delete. `decrementDiskUsage` still exists on the downloader and runtime for the cache path.

### Shared file paths

- Hash-dedup can store two download rows against one on-disk path.
- Deleting the last live reference unlinks the file and wipes faces. Deleting a duplicate keeps the file when another live row still points at it (`liveIdsSharingFilePath`).
- A crop or `/files` 404 for a missing source tombstones every live row on that path and deletes their faces immediately. The integrity sweep still catches stragglers.
- The same “do not unlink if another live row shares the path” check is in disk rotation, rescue unlink, and cluster conflict resolution.
- Cluster conflict resolution soft-deletes through `deleteDownloadsBy` instead of `DELETE FROM downloads` plus an unconditional unlink.

### Duplicates maintenance

- `GET /api/maintenance/dedup/sets` feeds the duplicates UI (set listing used by the maintenance duplicates page).

---

## 6. Backup — ported

Ported. Keyset catch-up (no `.iterate()`), a missing local file failing that job without setting destination `last_error`, clearing `last_error` after a successful mirror run, snapshot retention, and the edit-wizard secret merge were already on v2.32.1. This branch adds the five gaps: cron is stored only for snapshot mode, retention also runs for manual mode, a boot pass clears a retention backlog, mirror Run now deletes remote orphans and skips `snapshots/`, and the Backup page shows the coverage tip with the cron badge limited to snapshot cards. The live set is every remaining `downloads` row. Detail: `CHANGES-backup-port-v2.32.1.md`.

The description below is what `enhancement` changed relative to `716a55e1`.

- Mirror **Run now** lists the destination, uploads missing live files (`user_deleted = 0`), and deletes remote orphans. Soft-deletes stay on the remote until the next Run now. The `snapshots/` prefix is skipped so a shared bucket with a snapshot destination stays intact.
- Catch-up no longer uses better-sqlite3 `.iterate()` while enqueueing on the same connection (that raised “database connection is busy”). It uses keyset-paginated `.all()` batches.
- A missing local file fails that upload job permanently. It does not set destination `last_error`, and it does not crash the process via an uncaught `ENOENT` on `createReadStream().pipe(...)`.
- A successful mirror Run now clears `last_error` and bumps `last_success_at`, so a previous per-file error does not leave the card red when the later run uploaded nothing new.
- Snapshot retention runs after a successful or skipped snapshot upload, for snapshot and manual modes. It unlinks local staging `data/backups/snapshot-*.tar.gz`, caps leftover local archives to `retain_count`, prunes remote copies, and logs prune success only when delete succeeds. It logs `listed/keep/pruned`.
- Retention resets `total_files` / `total_bytes` from the kept remotes so the card shrinks. It re-runs on boot for snapshot/manual destinations so a backlog clears without waiting for the next upload.
- Edit wizard prefills non-secret fields (endpoint, bucket, prefix, rootPath, host, and the rest). Secrets stay blank (“leave blank to keep”). Omitted or blank secrets merge into the stored blob.
- Mirror destination cards do not show a cron schedule. Cron applies to snapshot mode. Saving a non-snapshot destination clears a leftover cron.
- Maintenance → Backup shows a coverage tip: one destination is one mode; full recovery needs both a continuous mirror (media) and a scheduled or manual snapshot (DB including faces, config, sessions). Snapshots use `snapshots/` under the same root.

---

## 7. Database

Schema review against `enhancement-v2.32.1`: nothing added for this port is unused, so nothing is dropped. The §1 / §2 objects were never created.

In `src/core/db.js` and read by the ported code:

| Object | Role |
|---|---|
| `download_tombstones` | §5. `(group_id, message_id)` primary key, `created_at`. `isDownloaded` and `getMessageIdRange` read it. |
| `video_fingerprints` | §3. Indexes on `file_hash` and `aggregate_hash`. |
| `video_frame_hashes` | §3. Index on `download_id`. |
| `similar_groups` | §3. `kind`, `confidence`, `offset_sec`. |
| `similar_group_members` | §3. Index on `download_id`. `role` and `reason` are shown on the page. |
| `similar_ignores` | §3. Pair key plus optional `note`. |
| `similar_partial_scans` | §3. Partial-analyze resume. |
| `similar_video_scans` | §3. Incremental analyze cursor (`file_hash`, `algo`, `config_key`). |

Per-download rows use `ON DELETE CASCADE` on `downloads(id)`. A group left with fewer than two members is pruned in code. There is no `user_deleted` predicate.

Not in this schema. `initSchema` does not create them:

| Object | Why it stays out |
|---|---|
| `downloads.user_deleted` | §5. `retireUserDeletedColumn` copies `user_deleted = 1` rows into `download_tombstones`, deletes those downloads, and `DROP COLUMN`s. A fresh database never has the column. |
| `people.cover_face_id` | §2, not ported. `retireEnhancementFaceSchema` drops the column (and any index on it) on boot. The People query's `f.id AS cover_face_id` is an alias, not this column. |
| `excluded_people` | §2, not ported. The same boot step `DROP TABLE`s it. Exclusion rows are not kept. |

`faces.frame_time_sec` is already on v2.32.1 and is read by the face-crop path. It is not part of the unported sampler.

The list below is what `enhancement` changed relative to `716a55e1`. It is not the schema of this branch.

| Object | Change |
|---|---|
| `downloads.user_deleted` | `INTEGER DEFAULT 0` |
| `faces.frame_time_sec` | `REAL` |
| `people.cover_face_id` | `INTEGER` |
| `excluded_people` | durable exclusion denylist; later `cover_face_id INTEGER` |
| `video_fingerprints` | per-file fingerprint; indexes on `file_hash`, `aggregate_hash` |
| `video_frame_hashes` | per-frame PDQ hashes; index on `download_id` |
| `similar_groups` | similar / partial / partial_review groups |
| `similar_group_members` | members; index on `download_id` |
| `similar_ignores` | ignored pairs |
| `similar_partial_scans` | partial-analyze resume |
| `similar_video_scans` | incremental analyze cursors |

Soft-delete cleanup also removes similar-group membership and ignore rows that point at `user_deleted` ids. On this branch the cascade does that when the download row is deleted.

---

## 8. HTTP API added or changed

Checked against `src/web/server.js` and `faces-service/tgdl_faces/app.py`. Routes follow the section they belong to. Nothing in the unported face-review list is registered.

### On this branch

| Method | Path | Status |
|---|---|---|
| `GET` | `/api/downloads/ids` | Ported with §4. |
| `POST` | `/api/downloads/by-ids` | Ported with §4. Guest-allowed, cap 100. |
| download lists | `pinned=0` | Ported with §4. No `user_deleted` query filter; a deleted message is a tombstone (§5). |
| 13 routes | `/api/maintenance/similar/…` | Ported with §3. Same paths as the table below. |
| `GET` | `/api/maintenance/dedup/sets` | Already on v2.32.1 (§5). Listed under Faces in the enhancement inventory; it is the duplicates page, not a face route. |
| `POST` | `/api/ai/faces/recluster` | Already on v2.32.1. Starts a faces scan: Phase A for anything still unindexed, then Phase B. It is not enhancement's incremental-only recluster. |
| `POST` | `/api/ai/faces/reindex` | Already on v2.32.1. Deletes `faces` and `people`, then clears `ai_indexed_at`. There is no exclusion denylist to clear. |
| `GET` | `/api/ai/people` | Already on v2.32.1. Query is `sort` and `dir` (`face_count`, `avg_quality`, `name`). `sortBy` / `sortDir` are not read. |
| `DELETE` | `/api/ai/people/:id` | Already on v2.32.1. Deletes the person row. `faces.person_id` is `ON DELETE SET NULL`, so the faces stay and can cluster again. |
| `POST` | `/detect/video` | Already on v2.32.1. Body is `path`, thresholds, and `max_frames` (default 120, max 500). No `job_id` or `nice`. |

### Not registered

Left out with §1 and §2:

| Method | Path |
|---|---|
| `POST` | `/api/ai/faces/rebuild` |
| `GET` | `/api/ai/faces/unclassified` |
| `GET` | `/api/ai/faces/:id/suggestions` |
| `POST` | `/api/ai/faces/:id/new-person` |
| `DELETE` | `/api/ai/faces/:id` |
| `GET` | `/api/ai/people/:id/faces` |
| `GET` | `/api/ai/people/:id/suggestions` |
| `POST` | `/api/ai/people/:id/cover` |
| `POST` | `/api/ai/people/:id/exclude` |
| `GET` | `/api/ai/people/excluded` |
| `DELETE` | `/api/ai/people/excluded/:id` |
| `GET` | `/detect/video/status/{job_id}` |

The tables below are what `enhancement` changed relative to `716a55e1`. They are not a list of missing work.

### Downloads

Ported with §4. Lists take `pinned=0`. There is no `user_deleted` filter; a deleted message is a `download_tombstones` row (§5).

| Method | Path | Change |
|---|---|---|
| `GET` | `/api/downloads/ids` | New. Full filtered ID set for shuffle. |
| `POST` | `/api/downloads/by-ids` | New. Hydrate up to 100 tiles. Guest-allowed. |
| existing download lists | | `unpinnedOnly` / unpinned filter; `user_deleted` excluded. |

### Similar clips (all new)

Ported with §3. All 13 routes are registered.

| Method | Path |
|---|---|
| `POST` | `/api/maintenance/similar/scan` |
| `POST` | `/api/maintenance/similar/scan/stop` |
| `GET` | `/api/maintenance/similar/status` |
| `GET` | `/api/maintenance/similar/stats` |
| `POST` | `/api/maintenance/similar/analyze` |
| `POST` | `/api/maintenance/similar/analyze/stop` |
| `GET` | `/api/maintenance/similar/groups` |
| `POST` | `/api/maintenance/similar/delete` |
| `POST` | `/api/maintenance/similar/ignore` |
| `GET` | `/api/maintenance/similar/ignore` |
| `DELETE` | `/api/maintenance/similar/ignore/:id` |
| `POST` | `/api/maintenance/similar/analyze/purge` |
| `POST` | `/api/maintenance/similar/purge` |

### Faces / people

Not ported with §1 and §2, except the four routes already on v2.32.1 called out above. People sort (`sort` / `dir`) is already on v2.32.1.

| Method | Path | Change |
|---|---|---|
| `POST` | `/api/ai/faces/recluster` | Now incremental Phase B only. |
| `POST` | `/api/ai/faces/rebuild` | New. Full DBSCAN reshape. |
| `POST` | `/api/ai/faces/reindex` | Also clears the exclusion denylist. |
| `GET` | `/api/ai/faces/unclassified` | New. |
| `GET` | `/api/ai/faces/:id/suggestions` | New. |
| `POST` | `/api/ai/faces/:id/new-person` | New. |
| `DELETE` | `/api/ai/faces/:id` | New. |
| `GET` | `/api/ai/people` | `sortBy` / `sortDir` (aliases `sort` / `dir`). |
| `GET` | `/api/ai/people/:id/faces` | New. One row per face. |
| `GET` | `/api/ai/people/:id/suggestions` | New. |
| `POST` | `/api/ai/people/:id/cover` | New. |
| `POST` | `/api/ai/people/:id/exclude` | New. |
| `GET` | `/api/ai/people/excluded` | New. |
| `DELETE` | `/api/ai/people/excluded/:id` | New. |
| `DELETE` | `/api/ai/people/:id` | Still a temporary drop. |
| `GET` | `/api/maintenance/dedup/sets` | New listing used by the duplicates page. |

### Faces sidecar

Not ported with §1. v2.32.1 keeps evenly spaced frames, `CAP_PROP_POS_FRAMES` seeks, and a 120-frame cap.

| Method | Path | Change |
|---|---|---|
| `POST` | `/detect/video` | Optional `job_id`, `nice`. New sampler and tracker. |
| `GET` | `/detect/video/status/{job_id}` | New. |

Ported with §4. Lists take `pinned=0`. There is no `user_deleted` filter; a deleted message is a `download_tombstones` row (§5).

| Method | Path | Change |
|---|---|---|
| `GET` | `/api/downloads/ids` | New. Full filtered ID set for shuffle. |
| `POST` | `/api/downloads/by-ids` | New. Hydrate up to 100 tiles. Guest-allowed. |
| existing download lists | | `unpinnedOnly` / unpinned filter; `user_deleted` excluded. |

### Similar clips (all new)

Ported with §3. All 13 routes are registered.

| Method | Path |
|---|---|
| `POST` | `/api/maintenance/similar/scan` |
| `POST` | `/api/maintenance/similar/scan/stop` |
| `GET` | `/api/maintenance/similar/status` |
| `GET` | `/api/maintenance/similar/stats` |
| `POST` | `/api/maintenance/similar/analyze` |
| `POST` | `/api/maintenance/similar/analyze/stop` |
| `GET` | `/api/maintenance/similar/groups` |
| `POST` | `/api/maintenance/similar/delete` |
| `POST` | `/api/maintenance/similar/ignore` |
| `GET` | `/api/maintenance/similar/ignore` |
| `DELETE` | `/api/maintenance/similar/ignore/:id` |
| `POST` | `/api/maintenance/similar/analyze/purge` |
| `POST` | `/api/maintenance/similar/purge` |

### Faces / people

Not ported with §1 and §2. People sort (`sort` / `dir`) is already on v2.32.1.

| Method | Path | Change |
|---|---|---|
| `POST` | `/api/ai/faces/recluster` | Now incremental Phase B only. |
| `POST` | `/api/ai/faces/rebuild` | New. Full DBSCAN reshape. |
| `POST` | `/api/ai/faces/reindex` | Also clears the exclusion denylist. |
| `GET` | `/api/ai/faces/unclassified` | New. |
| `GET` | `/api/ai/faces/:id/suggestions` | New. |
| `POST` | `/api/ai/faces/:id/new-person` | New. |
| `DELETE` | `/api/ai/faces/:id` | New. |
| `GET` | `/api/ai/people` | `sortBy` / `sortDir` (aliases `sort` / `dir`). |
| `GET` | `/api/ai/people/:id/faces` | New. One row per face. |
| `GET` | `/api/ai/people/:id/suggestions` | New. |
| `POST` | `/api/ai/people/:id/cover` | New. |
| `POST` | `/api/ai/people/:id/exclude` | New. |
| `GET` | `/api/ai/people/excluded` | New. |
| `DELETE` | `/api/ai/people/excluded/:id` | New. |
| `DELETE` | `/api/ai/people/:id` | Still a temporary drop. |
| `GET` | `/api/maintenance/dedup/sets` | New listing used by the duplicates page. |

### Faces sidecar

Not ported with §1. v2.32.1 keeps evenly spaced frames, `CAP_PROP_POS_FRAMES` seeks, and a 120-frame cap.

| Method | Path | Change |
|---|---|---|
| `POST` | `/detect/video` | Optional `job_id`, `nice`. New sampler and tracker. |
| `GET` | `/detect/video/status/{job_id}` | New. |

---

## 9. Configuration and environment

### `advanced.ai.faces` (new or changed defaults)

Not ported with §1 and §2. `scanVideos` and `TGDL_FACE_CROP_CONCURRENCY` already exist on v2.32.1 at the defaults this tree uses (`false` and `4`). `detSize` stays 640. `videoMaxFrames` stays the 120 density cap.

| Key | Env | Default | Role |
|---|---|---|---|
| `detSize` | `TGDL_FACES_DET_SIZE` | `480` | Was 640. |
| `scanVideos` | | `false` | Include videos in face scans. |
| `videoScanLimit` | `TGDL_FACES_VIDEO_SCAN_LIMIT` | `0` | Max unindexed videos per run. 0 = unlimited. |
| `videoNice` | `TGDL_FACES_VIDEO_NICE` | `0` | Unix nice during the video phase. |
| `videoFloorIntervalSec` | `TGDL_FACES_VIDEO_FLOOR_INTERVAL_SEC` | `3.0` | Shared floor interval. |
| `videoMaxFrames` | `TGDL_FACES_VIDEO_MAX_FRAMES` | `20000` | Runaway ceiling. |
| `videoProgressPollMs` | `TGDL_FACES_VIDEO_PROGRESS_POLL_MS` | `5000` | Node poll interval. |
| `videoWindowSec` | `TGDL_FACES_VIDEO_WINDOW_SEC` | `0.4` | Sidecar only. |
| `videoMotionThreshold` | `TGDL_FACES_VIDEO_MOTION_THRESHOLD` | `6.0` | Sidecar only. |
| | `TGDL_FACES_VIDEO_CONFIRMED_MIN_QUALITY` | `0.35` | Sidecar only. |
| | `TGDL_FACES_VIDEO_CONFIRMED_MIN_SCORE` | `0.50` | Sidecar only. |
| | `TGDL_FACES_VIDEO_SINGLETON_MIN_QUALITY` | `0.55` | Sidecar only. |
| | `TGDL_FACES_VIDEO_SINGLETON_MIN_SCORE` | `0.75` | Sidecar only. |
| | `TGDL_FACES_VIDEO_MIN_LANDMARK_REGULARITY` | `0.15` | Sidecar only. |
| | `TGDL_FACES_DETECTOR_MODEL` | `buffalo_m` in compose | Was documented as `buffalo_l`. |
| | `TGDL_FACE_CROP_CONCURRENCY` | `4` | Crop generation cap, clamp 1–8. |

`docs/AI.md` env reference grew from 27 knobs to 39.

### `advanced.similarClips`

Ported with §3. Stored under that key. Env overrides are `TGDL_SIMILAR_*` as in section 3. Settings page fields:

`similarThreshold`, `durationTolerance`, `durationBucketSec`, `sceneThreshold`, `floorIntervalSec`, `partialMatchRatio`, `partialFrameThreshold`, `partialShortClipSec`, `partialShortMatchRatio`, `partialReviewMatchRatio`, `partialReviewMinMatchedFrames`.

`fingerprintMaxFrames` and `fingerprintTilePx` are config/env only (not in the similar-page autosave payload).

---

## 10. Docker, packaging, and runtime

- `docker-compose.yml`: `telegram-downloader` builds locally (`build: .`) instead of pulling `ghcr.io/botnick/telegram-media-downloader:latest`. `NODE_ENV=development`.
- Faces services build from `./faces-service` instead of pulling `ghcr.io/botnick/tgdl-faces:latest`.
- `autoheal` and `watchtower` services are commented out. Labels and `WATCHTOWER_URL` on the app services remain.
- Main `Dockerfile`: deps stage installs `python3`, `make`, and `g++` so `bufferutil` (via `websocket` / gramJS) can compile on linux/arm64 + Node 24. New `seekbar` stage compiles a static Go 1.22 binary (`CGO_ENABLED=0`) to `/app/seekbar-service/bin/seekbar-server`. `SEEKBAR_BIN` points there. `intel-media-va-driver` and `i965-va-driver` are commented out; `vainfo` stays.
- `.dockerignore` ignores `seekbar-service/bin` and `seekbar-service/data` so a host-built binary is not copied over the image build.
- Entrypoint, as root before dropping to `node`: `chmod a+r /etc/hosts /etc/resolv.conf /etc/hostname`. Mode 0640 on those files caused `getaddrinfo EAI_AGAIN` for the non-root user.
- Faces service packaging moved from pip `requirements*.txt` to `uv` + `uv.lock`. Deleted: `requirements.txt`, `requirements-cuda.txt`, `requirements-directml.txt`. `pyproject.toml` has `dependency-groups` `dev` and `build` (`pyinstaller`) and pytest discovery settings. Dockerfiles copy `uv`, run `uv sync --frozen`, and ship `/app/.venv` instead of `/root/.local`.
- Faces image variants still select CPU, `gpu`, or `openvino` extras. DirectML remains a host `uv sync --extra directml` path.
- Release workflow `.github/workflows/release-faces-service.yml` uses `astral-sh/setup-uv` and `uv sync` / `uv run pyinstaller` instead of pip.
- `faces-service/.dockerignore`, `faces-service/build.sh`, and adjustments to `Makefile`, `build-pyinstaller.sh`, `build-pyinstaller.ps1`, `Dockerfile.arm64`, `Dockerfile.cuda`.
- Service worker `VERSION` is `v2.24.5-26`, served from `package.json`.

---

## 11. Localization and docs

Face-review, unclassified-face, exclude, cover, and merge-suggestion strings, plus `docs/FACE-REVIEW-REQUIREMENTS.md` and the video face-detection parts of `docs/requirements.md`, are not ported with §1 and §2.

- `src/web/public/locales/en.json` and `th.json`: strings for face review, unclassified faces, select-all, People sort, merge suggestions, exclude, cover, shuffle, similar clips (including the up-to-date scan status), and related settings labels.
- New docs: `docs/requirements.md` (video face-detection redesign, phases 1–4, plus the progress-reporting follow-up), `docs/FACE-REVIEW-REQUIREMENTS.md`, `docs/SIMILAR-CLIPS.md`.
- Updated: `CHANGELOG.md` (Unreleased through 2.24.5-26), `docs/AI.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/BACKUP.md`, `docs/TROUBLESHOOTING.md`, `README.md` (version line), `faces-service/README.md`, `.env.example`.

---

## 12. Tests added or expanded

Face-review and video-sampler tests are not ported with §1 and §2: `tests/ai/face-crop-queue.test.js`, `tests/ai/faces-client-video.test.js`, `tests/ai/unclassified-select-all.test.js`, `faces-service/tests/test_video_progress.py`, and the §1 portions of `tests/ai/scan-runner-video.test.js`, `tests/ai/face-cluster-ops.test.js`, `tests/ai/faces-client.test.js`, `faces-service/tests/test_video.py`, and `faces-service/tests/test_app.py`. v2.32.1 already has its own scan-runner video gate tests and face-crop tests.

New files:

- `tests/ai/face-crop-queue.test.js`
- `tests/ai/faces-client-video.test.js`
- `tests/ai/scan-runner-video.test.js`
- `tests/ai/unclassified-select-all.test.js`
- `tests/backup.destination.edit.test.js`
- `tests/backup.manager.run.test.js`
- `tests/backup.mirror.reconcile.test.js`
- `tests/backup.retention.test.js`
- `tests/db-shuffle-ids.test.js`
- `tests/db-similar-clips.test.js`
- `tests/db-similar-purge.test.js`
- `tests/db-soft-delete.test.js`
- `tests/dedup-shared-path.test.js`
- `tests/pdq.test.js`
- `tests/seekbar-fingerprint.test.js`
- `tests/seekbar-timeout.test.js`
- `tests/similar-align.test.js`
- `tests/similar-config.test.js`
- `tests/similar-fingerprint.test.js`
- `tests/similar-matcher.test.js`
- `tests/similar-partial.test.js`
- `tests/similar-scan.test.js`
- `tests/viewer-shuffle.test.js`
- `tests/viewer-spinner.test.js`
- `faces-service/tests/test_video_progress.py`

Expanded: `tests/ai/face-cluster-ops.test.js`, `tests/ai/faces-client.test.js`, `tests/config-manager.test.js`, `tests/db-federated-gallery.test.js`, `tests/db.test.js`, `tests/integrity.test.js`, `tests/job-tracker.test.js`, `faces-service/tests/test_video.py`, `faces-service/tests/test_app.py`.

---

## 13. Files touched

### Added

- `docs/FACE-REVIEW-REQUIREMENTS.md`
- `docs/SIMILAR-CLIPS.md`
- `docs/requirements.md`
- `faces-service/.dockerignore`
- `faces-service/build.sh`
- `faces-service/tests/test_video_progress.py`
- `faces-service/tgdl_faces/video_progress.py`
- `faces-service/uv.lock`
- `src/core/phash.js`
- `src/core/similar/align.js`
- `src/core/similar/analyze-runner.js`
- `src/core/similar/config.js`
- `src/core/similar/fingerprint.js`
- `src/core/similar/index.js`
- `src/core/similar/matcher.js`
- `src/core/similar/partial.js`
- `src/core/similar/scan-runner.js`
- `src/web/public/js/face-crop-queue.js`
- `src/web/public/js/maintenance-similar.js`
- and the new test files in section 12

### Deleted

- `faces-service/requirements.txt`
- `faces-service/requirements-cuda.txt`
- `faces-service/requirements-directml.txt`

### Modified (every remaining path in the diff)

`.dockerignore`, `.env.example`, `.github/workflows/release-faces-service.yml`, `CHANGELOG.md`, `Dockerfile`, `README.md`, `docker-compose.yml`, `docs/AI.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/BACKUP.md`, `docs/TROUBLESHOOTING.md`, `faces-service/Dockerfile`, `faces-service/Dockerfile.arm64`, `faces-service/Dockerfile.cuda`, `faces-service/Makefile`, `faces-service/README.md`, `faces-service/build-pyinstaller.ps1`, `faces-service/build-pyinstaller.sh`, `faces-service/pyproject.toml`, `faces-service/test_real_scan.py`, `faces-service/tests/test_app.py`, `faces-service/tests/test_video.py`, `faces-service/tgdl_faces/__main__.py`, `faces-service/tgdl_faces/app.py`, `faces-service/tgdl_faces/insight.py`, `faces-service/tgdl_faces/io.py`, `package-lock.json`, `package.json`, `scripts/docker-entrypoint.sh`, `seekbar-service/internal/api/server.go`, `src/config/manager.js`, `src/core/ai/faces-client.js`, `src/core/ai/faces-config.js`, `src/core/ai/faces-spawn.js`, `src/core/ai/scan-runner.js`, `src/core/backup/manager.js`, `src/core/cluster/sweep.js`, `src/core/db.js`, `src/core/dedup.js`, `src/core/disk-rotator.js`, `src/core/downloader.js`, `src/core/faststart.js`, `src/core/integrity.js`, `src/core/job-tracker.js`, `src/core/rescue.js`, `src/core/runtime.js`, `src/core/seekbar/client.js`, `src/core/seekbar/generator.js`, `src/core/seekbar/index.js`, `src/core/seekbar/spawn.js`, `src/core/thumbs.js`, `src/index.js`, `src/web/public/css/main.css`, `src/web/public/index.html`, `src/web/public/js/app.js`, `src/web/public/js/maintenance-ai.js`, `src/web/public/js/maintenance-backup.js`, `src/web/public/js/maintenance-duplicates.js`, `src/web/public/js/maintenance-hub.js`, `src/web/public/js/pwa.js`, `src/web/public/js/settings.js`, `src/web/public/js/store.js`, `src/web/public/js/viewer.js`, `src/web/public/locales/en.json`, `src/web/public/locales/th.json`, `src/web/public/sw.js`, `src/web/server.js`, plus the expanded tests in section 12.

`src/core/ai/faces-config.js` is new in behavior (video knobs and env resolution) and is in the modified set. `src/web/public/js/store.js` and `pwa.js` carry the small client-state and cache-bust pieces for the new UI.

---

## 14. Commits on `enhancement` after `716a55e1`

Merge commits are included. Subjects are the commit subjects.

1. `0343807` refactor: update docker-compose and Dockerfile for development environment
2. `74e132f` feat: add face review feature for enhanced face detection auditing
3. `a7be91b` Merge pull request #1 from garyskk/enhancement-face-clustering
4. `f8cbbff` refactor: enhance video player layout and controls
5. `ecfd44e` Merge pull request #3 from garyskk/video-player-non-overlay-controls
6. `8956fb3` feat: add requirements document for video face-detection redesign
7. `b477e3c` feat: implement video face tracking with quality scoring
8. `28a77f6` feat: enhance video face detection pipeline with new sampling and configuration options
9. `994f604` feat: enhance job progress formatting in job tracker
10. `f738c7e` feat: implement video scan progress reporting for long video requests
11. `0d75fbb` feat: enhance video processing configuration and documentation
12. `cf9f3eb` feat: implement durable exclusion for AI people management
13. `98be763` feat: add cover face functionality for People avatars
14. `ff4909d` feat: implement incremental and full rebuild phases for face clustering
15. `13e4413` feat: refine video processing configuration and request handling
16. `4b03b42` Merge branch 'video-face-detection-redesign' into enhancement
17. `c069421` feat: enhance face clustering and splitting functionality
18. `9f06338` Merge branch 'video-face-detection-redesign' into enhancement
19. `4b730b9` chore: update package version to 2.24.5-1
20. `4d7e307` chore: update default detector size to 480 for improved performance
21. `95128cd` chore: update insightface model configuration and flattening logic
22. `eb9d5ec` chore: update video face detection thresholds and version (2.24.5-2)
23. `e79a85d` chore: update version and enhance download filtering options (2.24.5-3, unpinned filter)
24. `caef3d3` chore: update version and refine incremental clustering logic (2.24.5-4)
25. `7a03f56` chore: bump version to 2.24.5-5 and refine incremental clustering logic
26. `5d23af0` chore: bump version to 2.24.5-6 and update clustering documentation
27. `ba40d8b` feat: enhance AI counts and unclassified faces handling
28. `104af11` feat: implement unclassified faces review and suggestions (2.24.5-7)
29. `270972b` feat: implement soft-delete for downloads and cleanup artifacts
30. `9c9defe` feat: enhance video processing and backup functionalities (2.24.5-8)
31. `3ed0e15` Merge branch 'fix-backup-job' into enhancement
32. `79c4b94` feat: add person merge suggestions based on centroid distance
33. `c8a7837` feat: add People merge suggestions and enhance documentation (2.24.5-9)
34. `bd6e231` Merge branch 'face-cluster-merge-suggestion' into enhancement
35. `a2dcf20` feat: implement shuffle functionality for media viewer
36. `a6ad6d5` feat: enhance media playback with full library shuffle and API updates (2.24.5-10)
37. `6373185` Merge branch 'random-next' into enhancement
38. `b2c9166` feat: add shuffle button and enhance viewer shuffle functionality
39. `9322b30` feat: enhance shuffle functionality and API updates (2.24.5-11, gallery shuffle synced with player)
40. `30f88b5` Merge branch 'random-next' into enhancement
41. `e9ce756` chore: update version to 2.24.5-12 and fix UI issues (empty seekbar gap)
42. `4bd0e59` chore: update version to 2.24.5-13 and fix video buffering spinner issue
43. `198bdcd` feat: implement sorting functionality for People grid (2.24.5-14)
44. `097cd5e` fix: address long video processing and sprite generation issues (2.24.5-15)
45. `a4fed15` Merge branch 'fix/seekbar-generate-timeout' into enhancement
46. `b8412f3` fix: improve video buffering spinner behavior
47. `d45b6e4` fix: improve snapshot retention and cleanup process (2.24.5-16)
48. `e91bafe` fix: enhance Docker entrypoint script for improved permissions and readability
49. `ef57e36` fix: reconcile snapshot retention counters and improve cleanup process (2.24.5-17)
50. `9c90468` fix: clear sticky error state after successful backup run
51. `e3053fa` Merge branch 'fix/dns-lookup' into enhancement
52. `7222568` Merge branch 'fix/backup-snapshot-retention' into enhancement
53. `90720fa` fix: update People grid sorting logic to include unlabeled names (2.24.5-19)
54. `10b66ca` Merge branch 'fix/ai-face-clusting-sorting' into enhancement
55. `dbbf2d1` fix: enhance file deletion logic to prevent orphaned downloads (2.24.5-20)
56. `50bc4b7` Merge branch 'fix/stale-faces' into enhancement
57. `d45e324` feat: introduce similar clips feature for near-duplicate video detection
58. `59946a2` feat: enhance seekbar service with fingerprinting and dual-output support
59. `45416f3` feat: implement similar clips scanning and configuration
60. `b587699` feat: enhance similar clips functionality with analysis and management features
61. `5b7b824` feat: enhance similar clips functionality with partial matching support
62. `9fa27f7` feat: implement maintenance hub for similar clips management
63. `9ded821` chore: update version to 2.24.5-21 and document new features in CHANGELOG
64. `c6df88f` feat: enhance similar clips functionality with scene-aware fingerprinting and management features (2.24.5-22)
65. `4ab004d` feat: enhance similar clips functionality with new purge and analysis features (2.24.5-23)
66. `279480d` feat: enhance similar clips functionality with improved analysis and configuration options (worker Smith-Waterman)
67. `ffd681a` fix: resolve scan progress issue for similar clips
68. `dc57114` Merge branch 'feat/similar-clips' into enhancement
69. `ccce942` feat: implement face crop loading queue and select-all functionality for unclassified faces
70. `1c40db6` Merge branch 'fix/load-too-much-unclassified-faces' into enhancement
71. `80e0f5b` fix: improve similar clips analysis by rechecking shorter clips against longer parents (2.24.5-26)
