# Similar clips

Near-duplicate **videos** and **partial clips** (a shorter video that
appears inside a longer one). Backed by 1 fps perceptual hashes written
during the existing seekbar ffmpeg pass — one decode, two outputs
(hover WebP + hashes in `data/db.sqlite`). Matching, the Maintenance
UI, and delete all stay in Node.

Exact byte-identical files are **not** this feature. Those stay on
Maintenance → Duplicates (SHA-256 in `src/core/dedup.js`).

> **Status.** Phase 1 (schema + this doc) is in the tree. Scan / Analyze /
> UI land in later phases. This file is the living spec (same role as
> [docs/AI.md](AI.md) for faces).

**Out of scope:** similar still images, heavy crop / mirror / speed
change, DINOv2, the faces sidecar, a second SQLite file, hashing old
4 s hover sprites as a fingerprint shortcut.

## Architecture

```
Maintenance → Similar clips Scan
        │
        ▼
video ──► existing seekbar ffmpeg (one decode)
              ├─ branch A: fps≈1/4, scale 160px, tile
              │              → data/seekbar/{id}.webp  (player hover, unchanged)
              └─ branch B: fps=1,   scale 32px
                             → video_fingerprints
                             → video_frame_hashes     (same data/db.sqlite)

Analyze (Node)  → similar_groups / similar_group_members
Ignore          → similar_ignores
Partial resume  → similar_partial_scans
Delete          → existing dedup.deleteByIds
```

There is **no** faces-service endpoint and **no** second video decoder.
Missing fingerprints are filled by calling the same
`generateForDownload` path the Seekbar page already uses (overwrite when
no current fingerprint). New downloads hit that path via
`pregenerateSeekbar` after faststart, once the dual-output generator
ships.

Old hover-only sprites are **not** reused as hashes — they are too
sparse on long videos (default `maxTiles: 240` stretches a 2-hour file
to ~30 s per tile). Scan regenerates through the enhanced generator.

## Configuration

Surface: `config.advanced.similarClips` (`kv['config']`). Hover-sprite
density stays under `advanced.seekbar.*` and does **not** control
fingerprint cadence (fixed 1 fps).

Env-var precedence (same rule as faces): `TGDL_SIMILAR_*` > kv-config >
default. Env wiring lands with Scan/Analyze; the keys below are already
seeded in `DEFAULT_CONFIG`.

### Config + env var reference

| Config key | Env var | Default | Description |
|---|---|---|---|
| `similarThreshold` | `TGDL_SIMILAR_THRESHOLD` | `5` | Max Hamming distance (bits) for similar whole videos |
| `durationTolerance` | `TGDL_SIMILAR_DURATION_TOLERANCE` | `0.1` | Similar pair: durations within ± this fraction |
| `partialMatchRatio` | `TGDL_SIMILAR_PARTIAL_MATCH_RATIO` | `0.5` | Min time-aligned frame match ratio for a confirmed partial |
| `partialFrameThreshold` | `TGDL_SIMILAR_PARTIAL_FRAME_THRESHOLD` | `10` | Max per-frame Hamming distance in partial matching |
| `partialShortClipSec` | `TGDL_SIMILAR_PARTIAL_SHORT_CLIP_SEC` | `300` | Clips ≤ this duration use the short-clip ratio |
| `partialShortMatchRatio` | `TGDL_SIMILAR_PARTIAL_SHORT_MATCH_RATIO` | `0.35` | Match ratio for short clips |
| `partialReviewMatchRatio` | `TGDL_SIMILAR_PARTIAL_REVIEW_MATCH_RATIO` | `0.1` | Weak hits land in `partial_review` |
| `partialReviewMinMatchedFrames` | `TGDL_SIMILAR_PARTIAL_REVIEW_MIN_MATCHED_FRAMES` | `2` | Min matched frames for a review candidate |
| `fingerprintFps` | `TGDL_SIMILAR_FINGERPRINT_FPS` | `1` | Fingerprint branch sample rate (do not tie to seekbar `intervalSec`) |
| `fingerprintMaxFrames` | `TGDL_SIMILAR_FINGERPRINT_MAX_FRAMES` | `7200` | Runaway cap (~2 h at 1 fps) |
| `fingerprintTilePx` | `TGDL_SIMILAR_FINGERPRINT_TILE_PX` | `32` | Scale on the hash branch (pHash native size) |
| `durationBucketSec` | `TGDL_SIMILAR_DURATION_BUCKET_SEC` | `120` | Parent lookup bucket width for partial analyze |

Do **not** inject these with compose `:-0` defaults — that would pin
the value and ignore Maintenance settings. Leave unset unless you
intend a deploy-time override.

## How it works

### Scan

1. Page videos with a resolvable local `file_path` (skip peer/federated
   rows, skip seekbar `failed` / `missing` / `no_duration` markers).
2. If `video_fingerprints.file_hash` still equals `downloads.file_hash`,
   skip — no regenerate.
3. Otherwise run enhanced `generateForDownload`: one ffmpeg walk writes
   the hover sprite **and** 1 fps pHashes. Aspect is normalized
   (letterbox-to-square / strip bars) on the 32 px branch before DCT
   pHash. Timestamps are `i * 1.0s` on that branch.
4. Persist `video_fingerprints` + replace `video_frame_hashes` for that
   `download_id`.

Progress is decode-bound. JobTracker + WS `similar_progress` /
`similar_done`. Last-run summary in `kv['similar_last_scan']`.

### Analyze

Pipeline order: **similar → optional partial**. Exact SHA-256 pairs are
left to the Duplicates page and are not re-checked here.

- **Similar** — duration within ±10% and time-aligned Hamming on the
  frame hashes. Cheap filter: 64-bit `aggregate_hash` + 120 s duration
  buckets. Keep the **larger** file; suggest remove for the smaller
  re-encode.
- **Partial** (checkbox, off by default) — shorter sequence as a
  contiguous time-aligned run inside a longer parent. Confirmed vs
  `partial_review` bands. Keep the **longer** video (or the larger file
  when durations match). Interrupt-safe via `similar_partial_scans`.

False-positive pairs go to `similar_ignores` (canonical `a_id < b_id`)
and survive re-analyze.

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
| `video_fingerprints` | One row per video: duration, aggregate 64-bit hash, frame count, `algo` (`phash-v1`), `file_hash`, `indexed_at` |
| `video_frame_hashes` | `(download_id, t_sec)` → 16-char hex pHash |
| `similar_groups` | `kind` ∈ `similar` \| `partial` \| `partial_review`, confidence, optional `offset_sec` |
| `similar_group_members` | `role` ∈ `keep` \| `remove` \| `review` |
| `similar_ignores` | False-positive pairs (`CHECK a_id < b_id`) |
| `similar_partial_scans` | Per-clip resume cursor for long partial analyze |

`ON DELETE CASCADE` from `downloads`. Soft-delete (row kept,
`user_deleted=1`) wipes the same artifacts explicitly — FK CASCADE only
fires on a hard `DELETE`.

## API surface

All endpoints are admin-only. See [docs/API.md](API.md#similar-clips)
for the table. Handlers land with Scan / Analyze / UI.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/maintenance/similar/scan` | Dual-output seekbar generate |
| `POST` | `/api/maintenance/similar/scan/stop` | Cancel |
| `GET`  | `/api/maintenance/similar/status` | JobTracker snapshot |
| `GET`  | `/api/maintenance/similar/stats` | Coverage + last scan |
| `POST` | `/api/maintenance/similar/analyze` | `{ checkPartialClips?: bool }` |
| `GET`  | `/api/maintenance/similar/groups` | Persisted groups |
| `POST` | `/api/maintenance/similar/delete` | `{ ids: […] }` |
| `POST` | `/api/maintenance/similar/ignore` | `{ aId, bId, kind }` |
| `GET`  | `/api/maintenance/similar/ignore` | List |
| `DELETE` | `/api/maintenance/similar/ignore/:id` | Un-ignore |

WS: `similar_progress`, `similar_done`.

## Related subsystem knobs

### Seekbar hover sprite

`advanced.seekbar.intervalSec` (default 4) and `maxTiles` (default 240)
shape the **player** WebP only. They must stay modest so hour-long
videos do not ship a huge hover sheet. Fingerprint density is
`similarClips.fingerprintFps` (1.0), not those knobs.

### Exact duplicates

Maintenance → Duplicates (`/api/maintenance/dedup/*`) remains
SHA-256-only. Similar-clips Analyze skips pairs that already share
`downloads.file_hash`.

### Faces sidecar

Not used. Insightface embeddings identify people, not clips. Do not
point `FACES_SERVICE_URL` at this feature.

## Troubleshooting

**Scan will take as long as a Seekbar rebuild.** Each video without a
current fingerprint is a full sequential ffmpeg decode. That is
expected. Cancel via Stop; already-written fingerprints are kept.

**“No groups after Analyze.”** Scan must finish first. Photos are
ignored. Peer `_clusterref` rows have no local file. Seekbar skip
markers (`failed` / `missing` / `no_duration`) are not unique videos —
they are skipped, not hashed.

**Short clip not found inside a long video.** Partial is off by default.
Turn on `checkPartialClips`. The parent must have 1 fps fingerprints
(Scan / regenerate), not a leftover hover-only sprite.

**Faces sidecar is down.** Irrelevant. Similar clips does not call it.

**Duplicates page still shows the same files.** Those are byte-identical
copies. Remove them there; similar-clips is for re-encodes and excerpts.

## Phased delivery

| Phase | Status | What |
|---|---|---|
| 1. Schema + this doc | **done** | Tables, accessors, soft-delete purge |
| 2. Seekbar dual output | pending | ffmpeg `split`, pHash helper |
| 3. Scan JobTracker | pending | regenerate / skip by `file_hash` |
| 4. Similar matcher | pending | groups + APIs |
| 5. Partial matcher | pending | duration buckets, ignore, resume |
| 6. Maintenance UI | pending | hub card, page, i18n |
