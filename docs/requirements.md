# Requirements: Video Face-Detection Redesign

Status: **Draft — pending approval to start Phase 1**
Owner surface: `faces-service/` (Python sidecar), `src/core/ai/faces-client.js` (Node ffmpeg fallback), `docs/AI.md`

## 1. Problem statement

The current video face pipeline samples a fixed number of **evenly-spaced**
frames (by duration band: ≤3 / ≤30 / ≤60 / ≤`max_frames`) and deduplicates
detections with a single greedy pass. This has four concrete defects:

1. **Missed faces** — uniform time sampling is decoupled from content.
   A person on screen for less time than the sampling interval (e.g.
   1 sample/minute on a 2-hour video) can be skipped entirely.
2. **Seek-accuracy bug** — `cv2.CAP_PROP_POS_FRAMES` seeking is unreliable
   on long-GOP H.264/HEVC; it lands on the nearest keyframe, not the
   requested index, so "evenly spaced" is frequently not what's actually
   decoded.
3. **False positives ("bullshit captures")** — every detection is trusted
   in isolation (quality scoring is currently disabled for video frames);
   one blurry/occluded/misfired frame produces a permanent embedding with
   no corroboration.
4. **Destructive dedup** — the greedy merge collapses every appearance of
   a person to a single best-score frame, discarding pose/angle diversity
   that would otherwise help match that person against other photos.

A fifth defect surfaced during design review of an earlier draft of this
spec: **duration-dependent behavior**. Tying sampling density (or a "floor
budget") to the video's total duration or to `max_frames` means a 10-second
clip and a 4-hour recording get fundamentally different *treatment*, not
just different totals — short videos were implicitly favored with denser
relative coverage, long videos were starved. That's fixed in §4 below by
making the sampling decision **duration-independent**: the same fixed-size
window and floor interval apply identically regardless of video length.

## 2. Goals

- **Duration-independent sampling**: a fixed window size and a fixed floor
  interval apply identically to a 10-second clip and a 4-hour video — no
  duration bands, no per-video budget scaling. Every second of every video
  gets the same baseline treatment; motion only ever adds density on top,
  uniformly.
- Eliminate frame-seek drift: single sequential decode, no
  `CAP_PROP_POS_FRAMES` seeking.
- Temporal confirmation: a face detected in only one sampled frame must
  clear a stricter confidence+quality bar than one corroborated across
  multiple frames, to suppress one-off false positives.
- Keep pose-diverse representative faces per identity-in-video (up to a
  small N) instead of collapsing to one embedding, to improve downstream
  cross-photo/video clustering.
- Apply the same fix to **both** detection paths: the primary sidecar
  path (`faces-service`, `cv2.VideoCapture`) and the Node-side ffmpeg
  b64 fallback (`src/core/ai/faces-client.js`, used when the sidecar has
  no shared filesystem access).

## 3. Non-goals / explicit constraints

- **No new dependencies.** No PySceneDetect, PyAV, etc. Scene/motion
  segmentation is implemented with plain OpenCV/NumPy (already a
  dependency) on the Python side, and ffmpeg's built-in `select='gt(scene,…)'`
  / `fps=` filters (ffmpeg is already a runtime dependency via `thumbs.js`)
  on the Node fallback side.
- **Speed is explicitly not a priority for this change** — accuracy/recall
  wins over throughput, confirmed twice by the operator. A 2-hour video may
  now involve thousands of detection calls instead of 120; that is accepted
  and intentional, not a bug. What we still must not do regardless of speed
  is **blow up memory** — see §4.2 (streaming pipeline), which is a
  correctness/stability requirement, not a speed optimization.
- No changes to the DBSCAN clustering math in `faces.js` — this only
  affects what goes **into** the `faces` table from video sources.
- No changes to photo-path detection (`/detect`, `/detect/batch`) beyond
  removing the "skip quality for video" shortcut where it's shared code.

## 4. Architecture

### 4.1 Sampling — fixed, duration-independent cadence

Single sequential decode, start to end, no seeking. **All constants below
are fixed regardless of video length** — a 10-second clip and a 4-hour
video are walked with the exact same logic:

- The video is split into fixed `window_sec` (default 0.4s) windows. Within
  each window, keep the sharpest frame (least motion-blur) as that
  window's candidate — computed on a cheap downscaled luma signature
  (~48×27), not full resolution.
- A candidate becomes a **kept sample** when its signature differs from
  the previously kept sample by more than `motion_threshold` (content
  actually changed), OR the fixed `floor_interval_sec` (default 3.0s) has
  elapsed since the last kept sample.
- There is no per-video "budget". The only global limit is `max_frames`,
  and it is now purely a runaway-safety ceiling (§4.2/§6), not a shaping
  parameter — it should essentially never bind for real-world video
  lengths given the streaming pipeline below.

**`window_sec` and `floor_interval_sec` play different roles — they are
not both "the recall guarantee", which an earlier draft of this spec
implied incorrectly:**

- **`window_sec` is the actual recall-latency driver.** Motion is
  recomputed at *every* window boundary, compared against the last kept
  sample — not just at floor checkpoints. So the instant a person enters
  frame (a real pixel change against whatever was there before), the very
  next window boundary — within `window_sec` — triggers a motion-sample.
  This is what determines whether a brief appearance gets caught: it must
  be smaller than the shortest on-screen duration worth catching. At 0.4s,
  someone visible for ~1s gets 2 chances to be sampled; going much below
  ~0.2s buys little extra recall (most detections need a reasonably
  settled, non-blurred frame anyway) while doubling compute for no
  practical gain.
- **`floor_interval_sec` is only a backstop**, not the recall mechanism —
  it only matters when *nothing* ever triggers motion for a stretch (a
  genuinely static scene: unmoving background, unmoving subject). Its
  job is periodic reconfirmation (so a person present the whole video
  still contributes more than one pose to the §4.4 diversity logic) and
  insurance against `motion_threshold` missing something subtle. Because
  it isn't the primary recall guarantee, it can be looser — 3s is plenty;
  tightening it further has no real recall benefit, only cost.
- **`motion_threshold` is the sensitivity dial** — too low and it fires on
  compression noise every window (wasted compute, no benefit since
  near-duplicates get merged by the tracker anyway); too high and it
  misses someone entering small/distant/low-contrast. This is the one
  knob that genuinely benefits from empirical tuning against real footage
  rather than a formula, which is why it's exposed as a config value
  rather than hardcoded.

**Worked example — same constants, two very different videos:**

| Video | Floor samples (zero-motion baseline, `floor_interval_sec=3.0`) | Notes |
|---|---|---|
| 10s clip | `10 / 3.0` ≈ 4 | same constants as any other video |
| 2-hour video | `7200 / 3.0` = 2400 | same constants, no down-scaling |

Both get identical per-second floor treatment. But the actual recall
guarantee for *brief* appearances comes from `window_sec` (checked every
0.4s throughout, in both videos identically) layered on top of that floor
— not from the floor interval itself.

### 4.2 Streaming pipeline (memory safety, not a speed optimization)

Removing duration scaling means long videos can legitimately produce
thousands of samples (3600+ for a 2-hour video from the floor alone, more
with motion). Collecting that many full-resolution decoded frames into a
`list[np.ndarray]` before detection — the current/previous-draft contract
— would hold gigabytes of raw pixel data in RAM at once. That is a real
stability bug, independent of speed:

- `extract_video_frames` changes from "decode everything, return a list"
  to a **generator** that yields one sampled frame at a time as the
  sequential decode produces it.
- The caller (`_do_detect_video_sync`) detects each yielded frame
  immediately and keeps only the small resulting face dicts (bbox +
  512-float embedding + score) — the raw frame is discarded right after
  detection, so peak memory is bounded by a small constant (one frame,
  or `max_workers` frames under GPU parallelism), **not** by total sample
  count or video length.
- GPU parallelism is preserved via a bounded in-flight window (submit up
  to `2 × max_workers` frames ahead into a thread pool, consume completed
  results, submit more as slots free up) instead of materializing the
  full frame list and calling `pool.map` over it.
- Track state (§4.4) accumulates only tiny embeddings/metadata per
  detected face, not frames — safe to keep for the full length of even a
  very long video (existing code already notes real-world identity counts
  per video stay small).
- The Node ffmpeg fallback gets the equivalent treatment in §4.5: one
  continuous ffmpeg process piping frames out, read and dispatched
  incrementally, instead of collecting every extracted JPEG buffer into
  an array before sending anything.

This is the fix that makes "no duration-dependent behavior" actually safe
to ship — density is decoupled from video length, and now so is memory.

### 4.3 Detection

Unchanged detector call (`detect_and_embed` / `insightface`). One change:
**quality scoring is re-enabled for video frames** (currently short-circuited
via `_skip_quality_score=True` in both `/detect/video` and
`/detect/batch-b64`) — it's required as the confidence gate in §4.4, and
per §3, throughput is not the priority here.

### 4.4 Track-based confirmation + best-N dedup (replaces greedy dedup)

Per-frame detection lists (temporal order preserved via the streaming
pipeline in §4.2) are merged into per-identity **tracks** via running
cosine similarity (≥0.50 — the existing dedup threshold, unchanged)
against each track's running mean embedding:

- A track confirmed by **≥2 sampled frames** is accepted, **but still must
  clear a universal quality floor: `quality_score ≥ 0.30`.**
- A track seen in only **1** sampled frame is accepted only if it clears
  a stricter bar (`score ≥ 0.75` AND `quality_score ≥ 0.55`) — otherwise
  dropped as unconfirmed noise.
- Confirmed tracks keep up to **3** representative faces, chosen by
  score descending while skipping near-duplicate poses (pairwise cosine
  similarity ≥ 0.85 against already-kept faces) — preserves angle
  diversity instead of collapsing to one embedding.

**Why confirmed tracks still need a quality floor, not just corroboration:**
temporal confirmation ("seen in ≥2 frames") only defends against *random*
one-off noise — a single blurry/misfired frame that nothing else
corroborates. It does **not** defend against a *systematic* false
positive: the detector consistently misfiring on the same non-face region
(a patch of skin, a clothing pattern, a textured surface — the same class
of false positive the existing aspect-ratio filter already targets for
"window frames, chair legs") because the lighting/texture is stable
throughout the scene. That kind of error repeats just as reliably as a
real face across every sampled frame, so hit-count alone would wave it
through. `quality_score` — driven mostly by landmark regularity (are the
predicted eye/nose/mouth positions arranged like an actual face?) and pose
frontalness — is a signal that's orthogonal to repetition count: a
non-face texture doesn't become face-shaped just because the detector
keeps making the same mistake on it. The 0.30 floor is deliberately loose
(corroboration still counts for something) but non-zero, so it catches
this category without over-rejecting legitimate faces caught mid-motion,
in poor lighting, or at an angle.

This logic is implemented once in Python (`faces-service/tgdl_faces/app.py`)
and once in JS (`src/core/ai/faces-client.js`) for the two independent
code paths; both must stay behaviorally in sync (same thresholds/constants,
called out in code comments referencing each other).

### 4.5 Node ffmpeg fallback (`_extractVideoFrames` in `faces-client.js`)

Replaces per-frame `-ss <pos> -frames:v 1` seeking (one ffmpeg process per
frame — slow, seek-accuracy-prone, and collects every frame into an array
before sending anything) with **one continuous** ffmpeg process combining:

- a fixed-rate `fps=1/<floor_interval_sec>` component (the duration-independent
  floor from §4.1), and
- the `select='gt(scene,<motion_threshold_equiv>)'` scene-change filter (the
  motion-triggered component),

piped as `image2pipe`/`mjpeg` frames on `stdout`. Node reads the stream
incrementally (parsing JPEG frame boundaries as bytes arrive) and dispatches
each frame to `/detect` (or a small batched window of frames to
`/detect/batch-b64`) as soon as it's available, discarding the buffer once
sent — mirroring §4.2's streaming/memory approach so the fallback path
scales the same way regardless of video length. Exact filter graph and
chunking finalized in Phase 3.

## 5. Config / tunables

New env vars (Python sidecar, following the existing `TGDL_FACES_*` pattern)
and matching `advanced.ai.faces.*` config keys (Node, following the existing
`videoMaxFrames` pattern). None of these scale with or depend on video
duration — they're the same fixed values for every video:

| Knob | Default | Notes |
|---|---|---|
| `TGDL_FACES_VIDEO_WINDOW_SEC` / `videoWindowSec` | 0.4 | **the real recall-latency driver** — motion is checked every window, so this is how fast a brief appearance gets noticed (fixed, all videos) |
| `TGDL_FACES_VIDEO_FLOOR_INTERVAL_SEC` / `videoFloorIntervalSec` | 3.0 | backstop only, not the recall mechanism — max gap between samples when nothing ever triggers motion (fixed, all videos) |
| `TGDL_FACES_VIDEO_MOTION_THRESHOLD` / `videoMotionThreshold` | 6.0 | the sensitivity dial — luma-diff (0-255 scale) that triggers an extra motion-driven sample; most in need of empirical tuning |
| `TGDL_FACES_VIDEO_MAX_FRAMES` / `videoMaxFrames` | 20000 | pure runaway-safety ceiling — not a density control, should not bind for real videos |
| `TGDL_FACES_VIDEO_SINGLETON_MIN_SCORE` | 0.75 | unconfirmed (1-hit) single-frame acceptance bar (score) |
| `TGDL_FACES_VIDEO_SINGLETON_MIN_QUALITY` | 0.55 | unconfirmed (1-hit) single-frame acceptance bar (quality) |
| `TGDL_FACES_VIDEO_CONFIRMED_MIN_QUALITY` | 0.30 | universal quality floor for **confirmed** (≥2-hit) tracks — catches systematic false positives (skin/fabric/texture) that repetition alone would wave through |

All existing knobs (`min_score`, `min_box_px`, `ar_range`) are unchanged.

## 6. Safety / resource constraints

- Memory no longer scales with sample count or video length (§4.2) — the
  streaming pipeline is what makes duration-independent sampling safe to
  default-enable for arbitrarily long videos.
- `max_frames` is retained purely as a defensive ceiling against pathological
  inputs (e.g. corrupted duration metadata causing a runaway decode loop),
  set high enough (20000) that it should never bind for any realistic
  video length. It is explicitly **not** used to shape sampling density.
- Compute time is accepted to grow substantially for long videos (a 2-hour
  video's floor alone is ~3600 detection calls vs. today's 120) — this is
  an intentional trade documented in §3, not an oversight.
- No behavior change to `/detect`, `/detect/batch` (photo paths).

## 7. Phased implementation plan (test-and-approve each before next)

1. **Phase 1 — Streaming sampler.** Rewrite `extract_video_frames` in
   `faces-service/tgdl_faces/io.py` as a generator per §4.1/§4.2 (fixed
   `window_sec`/`floor_interval_sec`, no duration bands, no seeking).
   Update `faces-service/tests/test_video.py::TestExtractVideoFrames` for
   the new behavior (deterministic motion + floor cases at both short and
   long simulated durations, proving identical treatment).
2. **Phase 2 — Streaming detection + tracking dedup.** Update
   `_do_detect_video_sync` in `faces-service/tgdl_faces/app.py` to consume
   the generator with bounded in-flight concurrency (§4.2) instead of
   materializing a frame list; replace `_dedupe_video_faces` with
   `_build_face_tracks` per §4.4; re-enable quality scoring for video +
   batch-b64. Update `TestDedupeVideoFaces` → new tracking tests, plus a
   memory-bound regression test (e.g. mock a very long video and assert
   peak retained frame count stays constant, not proportional to samples).
3. **Phase 3 — Node fallback.** Rewrite `_extractVideoFrames` (continuous
   ffmpeg process, `fps=` + `select=scene` filters, incremental read) and
   `_dedupeVideoFaces` (port tracking logic) in
   `src/core/ai/faces-client.js` per §4.4/§4.5. Update
   `tests/ai/faces-client.test.js`.
4. **Phase 4 — Config + docs.** Add the §5 tunables through
   `faces-config.js` / `manager.js` config resolution, update
   `docs/AI.md`'s "Video face scanning" section, `.env.example`, and
   `CHANGELOG.md`.

Each phase ends with: affected test file(s) run, pass/fail output shown,
and explicit approval requested before starting the next phase.

## 8. Acceptance criteria

- A 10-second simulated video and a 4-hour simulated video (same fixed
  mocked frame content) produce sample **rates** (samples ÷ duration) that
  match to within rounding — proves duration-independence, not just that
  both respect some cap.
- A synthetic test video where a distinct "face-like" frame block appears
  briefly between two floor checkpoints is captured by the sampler (proves
  the miss-brief-appearance bug is fixed) — tested at both a short and a
  long simulated duration.
- A single spurious low-quality detection with no corroborating frame is
  dropped by the tracker (proves the false-positive bug is fixed) unless
  it clears the strict singleton bar.
- A *systematic* false positive — the same non-face region (simulated via
  a fixed low-`quality_score`, high-`score` detection) recurring across
  every sampled frame — is still dropped despite clearing the ≥2-hit
  corroboration bar, because it fails the universal `quality_score ≥ 0.30`
  floor (proves confirmation-by-repetition alone isn't enough).
- A person appearing in ≥2 sampled frames with varying pose keeps up to 3
  diverse representative embeddings instead of 1.
- No `cv2.CAP_PROP_POS_FRAMES` / `cap.set(...)` calls remain in the
  sampler (proves the seek-drift bug is fixed).
- A test simulating a very long video (e.g. mocked multi-hour frame count)
  asserts peak in-memory frame count stays bounded (constant / tied to
  `max_workers`, not to total samples) — proves the streaming fix actually
  decouples memory from duration.
- Existing photo-path tests (`test_app.py`, `test_insight.py`) remain green
  (no regression to non-video code paths).
