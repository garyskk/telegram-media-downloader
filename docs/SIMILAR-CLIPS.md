# Similar clips

Near-duplicate **videos** and **partial clips** (a shorter video that
appears inside a longer one). Scan writes scene-aware **PDQ-256**
fingerprints with its own ffmpeg walk. Analyze aligns hash sequences
with Smith-Waterman. Matching, the Maintenance UI, and delete stay in
Node. Hover sprites stay on the Seekbar page — they are a separate
pipeline.

Exact byte-identical files are **not** this feature. Those stay on
Maintenance → Duplicates (SHA-256 in `src/core/dedup.js`).

> **Status.** Scene-aware sampling + PDQ + sequence alignment is in the
> tree. This file is the living spec (same role as
> [docs/AI.md](AI.md) for faces).

**Out of scope:** similar still images, heavy crop / zoom recuts,
DINOv2, the faces sidecar, a second SQLite file, GOP-keyframe-only
decode (`-skip_frame nokey`).

## Architecture

```
video ──► Seekbar ffmpeg          → data/seekbar/{id}.webp  (player hover)
     └──► Similar ffmpeg          → video_fingerprints
              select scene|floor      video_frame_hashes     (same data/db.sqlite)
              64×64 PDQ-256 + pts

Analyze (Node, Smith-Waterman)
              ├─ similar          (coverage of both ≥ ~0.7, duration ±10%)
              └─ partial          (coverage of the shorter sequence)
Ignore        → similar_ignores   (kept across Purge records)
Partial resume → similar_partial_scans
Delete        → existing dedup.deleteByIds
```

There is **no** faces-service endpoint. Similar Scan never calls
`generateForDownload` or the Go seekbar sidecar.

Freshness: `file_hash` match **and** `algo === pdq-scene-v1`. New
downloads also call `pregenerateFingerprint` next to
`pregenerateSeekbar` (two walks).

Old 1 fps pHash rows (`phash-v1`) are stale. Purge records (or a
one-off sqlite3 wipe of those tables) then Scan.

## Configuration

Surface: `config.advanced.similarClips` (`kv['config']`). Hover-sprite
density stays under `advanced.seekbar.*` and does **not** control
fingerprint sampling.

Env-var precedence (same rule as faces): `TGDL_SIMILAR_*` > kv-config >
default. Scan reads these through `src/core/similar/config.js`.

### Config + env var reference

| Config key | Env var | Default | Description |
|---|---|---|---|
| `similarThreshold` | `TGDL_SIMILAR_THRESHOLD` | `50` | Max mean aligned Hamming (PDQ-256 bits) for similar whole videos. Clamp 0–128 |
| `durationTolerance` | `TGDL_SIMILAR_DURATION_TOLERANCE` | `0.1` | Similar pair: durations within ± this fraction |
| `partialMatchRatio` | `TGDL_SIMILAR_PARTIAL_MATCH_RATIO` | `0.5` | Min coverage of the shorter sequence for a confirmed partial |
| `partialFrameThreshold` | `TGDL_SIMILAR_PARTIAL_FRAME_THRESHOLD` | `70` | Max per-scene Hamming for a SW match. Clamp 0–128 |
| `partialShortClipSec` | `TGDL_SIMILAR_PARTIAL_SHORT_CLIP_SEC` | `300` | Clips ≤ this duration use the short-clip ratio |
| `partialShortMatchRatio` | `TGDL_SIMILAR_PARTIAL_SHORT_MATCH_RATIO` | `0.35` | Match ratio for short clips |
| `partialReviewMatchRatio` | `TGDL_SIMILAR_PARTIAL_REVIEW_MATCH_RATIO` | `0.1` | Weak hits land in `partial_review` |
| `partialReviewMinMatchedFrames` | `TGDL_SIMILAR_PARTIAL_REVIEW_MIN_MATCHED_FRAMES` | `2` | Min matched scenes for a review candidate |
| `sceneThreshold` | `TGDL_SIMILAR_SCENE_THRESHOLD` | `0.1` | ffmpeg `scene` score; sample when exceeded (or floor) |
| `floorIntervalSec` | `TGDL_SIMILAR_FLOOR_INTERVAL_SEC` | `3` | Minimum seconds between samples |
| `fingerprintMaxFrames` | `TGDL_SIMILAR_FINGERPRINT_MAX_FRAMES` | `7200` | Runaway cap on packed RGB frames |
| `fingerprintTilePx` | `TGDL_SIMILAR_FINGERPRINT_TILE_PX` | `64` | ffmpeg scale before PDQ (32–64; PDQ resamples to 64) |
| `durationBucketSec` | `TGDL_SIMILAR_DURATION_BUCKET_SEC` | `120` | Similar-video cheap filter (±1 neighbour). Partial parents are duration-sorted, not ±1 bucket |

Do **not** inject these with compose `:-0` defaults — that would pin
the value and ignore Maintenance settings. Leave unset unless you
intend a deploy-time override.

## How it works

### Scan

1. Page videos with a resolvable local `file_path` (skip peer/federated
   rows).
2. If `video_fingerprints.file_hash` still equals `downloads.file_hash`
   **and** `algo` is `pdq-scene-v1`, skip.
3. Otherwise run similar-only ffmpeg: `select` scene-or-floor, 64×64
   RGB, `showinfo` pts, PDQ-256. Reject the run if packed-frame count
   disagrees with pts count.
4. Persist `video_fingerprints` + replace `video_frame_hashes` for that
   `download_id`.

Progress is decode-bound (no hover WebP encode). JobTracker + WS
`similar_progress` / `similar_done`. Last-run summary in
`kv['similar_last_scan']`.

### Analyze

Pipeline order: **similar → optional partial**. Exact SHA-256 pairs are
left to the Duplicates page and are not re-checked here.

- **Similar** — duration within ±10% **and** Smith-Waterman coverage of
  **both** sequences ≥ ~0.7 **and** mean aligned Hamming ≤
  `similarThreshold`. Extra intro/bumper frames are gaps, not a t=0
  prefix compare. Cheap filter: duration buckets (±1 neighbour) plus a
  loose `aggregate_hash` XOR gate (only when both sequences have the
  same length). Keep the **larger** file. Re-analyze replaces
  `kind='similar'` groups; `partial` / `partial_review` rows stay.
  Last-run summary in `kv['similar_last_analyze']`. JobTracker + WS
  `similar_analyze_progress` / `similar_analyze_done`.
- **Partial** (checkbox, off by default) — high coverage of the
  **shorter** sequence inside a same-or-longer parent. `offset_sec` is
  the parent’s real `t_sec` at the alignment start (not a 1 fps index).
  Confirmed vs `partial_review` bands. Keep the **longer** video (or
  the larger file when durations match). Interrupt-safe via
  `similar_partial_scans`. Exact SHA-256 pairs and `similar_ignores`
  are skipped.

False-positive pairs go to `similar_ignores` (canonical `a_id < b_id`)
and survive re-analyze **and** Purge records.

### Purge records

Confirm-gated overflow control on the similar page.
`POST /api/maintenance/similar/purge`:

- `409` `ALREADY_RUNNING` if Scan or Analyze is running
- Deletes fingerprints, frame hashes, groups (CASCADE members), and
  partial-resume cursors
- Keeps `similar_ignores` and hover `seekbar_sprites`
- Best-effort unlink of leftover `{id}.fp.raw` under `data/seekbar/`
- Does **not** start a Scan. Operator hits Scan afterwards.
- Broadcasts `similar_purged`

### Delete

Selected `remove` / `review` members go through
`dedup.deleteByIds` so thumbs, faces, seekbar files, and these
fingerprint rows stay consistent. Soft-delete also purges similar-clips
artifacts (the downloads tombstone is kept so Telegram does not
re-fetch).

## Schema

All tables are in the existing `data/db.sqlite` (`CREATE TABLE IF NOT EXISTS`
in `src/core/db.js` `initSchema`). **No second database.**

| Table | Role |
|---|---|
| `video_fingerprints` | One row per video: duration, aggregate hash, frame count, `algo` (`pdq-scene-v1`), `file_hash`, `indexed_at` |
| `video_frame_hashes` | `(download_id, t_sec)` → 64-char hex PDQ |
| `similar_groups` | `kind` ∈ `similar` \| `partial` \| `partial_review`, confidence, optional `offset_sec` |
| `similar_group_members` | `role` ∈ `keep` \| `remove` \| `review` |
| `similar_ignores` | False-positive pairs (`CHECK a_id < b_id`) |
| `similar_partial_scans` | Per-clip resume cursor for long partial analyze |

`ON DELETE CASCADE` from `downloads`. Soft-delete (row kept,
`user_deleted=1`) wipes the same artifacts explicitly — FK CASCADE only
fires on a hard `DELETE`.

## API surface

All endpoints are admin-only. See [docs/API.md](API.md#similar-clips).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/maintenance/similar/scan` | Similar-only ffmpeg; skip when `file_hash` + `algo` current |
| `POST` | `/api/maintenance/similar/scan/stop` | Cancel |
| `GET`  | `/api/maintenance/similar/status` | Scan snapshot + nested `analyze` |
| `GET`  | `/api/maintenance/similar/stats` | Coverage + last scan / analyze |
| `POST` | `/api/maintenance/similar/analyze` | `{ checkPartialClips?: bool }` |
| `POST` | `/api/maintenance/similar/analyze/stop` | Cancel Analyze |
| `GET`  | `/api/maintenance/similar/groups` | Persisted groups |
| `POST` | `/api/maintenance/similar/delete` | `{ ids: […] }` |
| `POST` | `/api/maintenance/similar/ignore` | `{ aId, bId, kind }` |
| `GET`  | `/api/maintenance/similar/ignore` | List |
| `DELETE` | `/api/maintenance/similar/ignore/:id` | Un-ignore |
| `POST` | `/api/maintenance/similar/purge` | Wipe hashes/groups/resume; keep ignores; `409` if busy |

WS: `similar_progress` / `similar_done` (Scan),
`similar_analyze_progress` / `similar_analyze_done` (Analyze),
`similar_purged` (Purge records).

## Related subsystem knobs

### Seekbar hover sprite

`advanced.seekbar.intervalSec` (default 4) and `maxTiles` (default 240)
shape the **player** WebP only. Fingerprint sampling is
`sceneThreshold` / `floorIntervalSec`, not those knobs.

### Exact duplicates

Maintenance → Duplicates (`/api/maintenance/dedup/*`) remains
SHA-256-only. Similar-clips Analyze skips pairs that already share
`downloads.file_hash`.

### Faces sidecar

Not used. Insightface embeddings identify people, not clips. Do not
point `FACES_SERVICE_URL` at this feature.

## Troubleshooting

**Scan is still decode-bound.** Scene `select` walks every frame. It no
longer pays hover WebP encode or a 1 fps packed dump. Cancel via Stop;
already-written fingerprints are kept.

**“No groups after Analyze.”** Scan must finish first (`algo` =
`pdq-scene-v1`). Photos are ignored. Peer `_clusterref` rows have no
local file.

**Short clip not found inside a long video.** Partial is off by default.
Turn on `checkPartialClips`. The parent must have scene+PDQ
fingerprints, not a leftover `phash-v1` row.

**Stale `phash-v1` rows skipped forever?** Skip requires current algo.
Purge records (or sqlite3 delete of fingerprint tables) then Scan.

**Faces sidecar is down.** Irrelevant. Similar clips does not call it.

**Duplicates page still shows the same files.** Those are byte-identical
copies. Remove them there; similar-clips is for re-encodes and excerpts.
