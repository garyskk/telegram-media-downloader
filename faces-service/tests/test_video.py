"""Tests for video face detection infrastructure.

Covers:
* ``_build_face_tracks`` — temporal-confirmation identity tracking + best-N
  dedup across frames (docs/requirements.md §4.4).
* ``extract_video_frames`` — cv2-based frame sampler (cv2 fully mocked).
* ``POST /detect/video`` — FastAPI endpoint validation + soft-error paths.

No real insightface / cv2 / model weights needed — all heavy dependencies
are mocked at the module boundary.
"""

from __future__ import annotations

import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Iterator
from unittest.mock import MagicMock, patch

import numpy as np
import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _face(score: float = 0.8, quality: float = 0.6, emb: list[float] | None = None) -> dict:
    if emb is None:
        emb = [1.0] + [0.0] * 511
    return {
        "x": 10,
        "y": 10,
        "w": 60,
        "h": 60,
        "score": score,
        "quality_score": quality,
        "embedding": list(emb),
        "landmarks": [],
    }


def _unit(idx: int, dim: int = 512) -> list[float]:
    """Return an L2-unit vector with 1.0 at position *idx* and 0.0 elsewhere."""
    v = [0.0] * dim
    v[idx] = 1.0
    return v


def _near(idx: int, noise: float = 0.436, dim: int = 512) -> list[float]:
    """Return a vector near _unit(idx): dot product with _unit(idx) ≈ 0.9 (> 0.50)."""
    v = [0.0] * dim
    v[idx] = 0.9
    v[(idx + 1) % dim] = noise
    return v


def _diverse_variant(idx: int, variant: int, dim: int = 512) -> list[float]:
    """Return a unit vector sharing a dominant component at *idx* (so it
    still matches the same identity/track) but with a distinct secondary
    component per *variant* — pairwise similarity between variants stays
    well under the 0.85 near-duplicate-pose threshold, while similarity to
    the shared dominant direction stays above the 0.50 track-match bar.
    """
    v = [0.0] * dim
    v[idx] = 0.85
    v[(idx + 1 + variant) % dim] = 0.53
    norm = (v[idx] ** 2 + v[(idx + 1 + variant) % dim] ** 2) ** 0.5
    return [x / norm for x in v]


# ---------------------------------------------------------------------------
# Tests: _build_face_tracks
# ---------------------------------------------------------------------------


class TestVideoConfigResolution:
    """Phase 4 (docs/requirements.md §5) — env-var wiring for the sampling
    and track-confirmation knobs. Each ``TGDL_FACES_VIDEO_*`` var must
    override its hardcoded default, and fall back cleanly when unset or
    garbage."""

    def setup_method(self):
        self._env_keys = [
            "TGDL_FACES_VIDEO_WINDOW_SEC",
            "TGDL_FACES_VIDEO_FLOOR_INTERVAL_SEC",
            "TGDL_FACES_VIDEO_MOTION_THRESHOLD",
            "TGDL_FACES_VIDEO_MAX_FRAMES",
            "TGDL_FACES_VIDEO_SINGLETON_MIN_SCORE",
            "TGDL_FACES_VIDEO_SINGLETON_MIN_QUALITY",
            "TGDL_FACES_VIDEO_CONFIRMED_MIN_QUALITY",
        ]
        for k in self._env_keys:
            os.environ.pop(k, None)

    def teardown_method(self):
        for k in self._env_keys:
            os.environ.pop(k, None)

    def test_sampling_params_default_when_unset(self):
        from tgdl_faces.app import _resolve_video_sampling_params
        from tgdl_faces.io import (
            DEFAULT_FLOOR_INTERVAL_SEC,
            DEFAULT_MOTION_THRESHOLD,
            DEFAULT_WINDOW_SEC,
        )

        window_sec, floor_interval_sec, motion_threshold = _resolve_video_sampling_params()
        assert window_sec == DEFAULT_WINDOW_SEC
        assert floor_interval_sec == DEFAULT_FLOOR_INTERVAL_SEC
        assert motion_threshold == DEFAULT_MOTION_THRESHOLD

    def test_sampling_params_env_override(self):
        from tgdl_faces.app import _resolve_video_sampling_params

        os.environ["TGDL_FACES_VIDEO_WINDOW_SEC"] = "0.8"
        os.environ["TGDL_FACES_VIDEO_FLOOR_INTERVAL_SEC"] = "5.0"
        os.environ["TGDL_FACES_VIDEO_MOTION_THRESHOLD"] = "10.0"
        window_sec, floor_interval_sec, motion_threshold = _resolve_video_sampling_params()
        assert window_sec == 0.8
        assert floor_interval_sec == 5.0
        assert motion_threshold == 10.0

    def test_sampling_params_garbage_env_falls_back_to_default(self):
        from tgdl_faces.app import _resolve_video_sampling_params
        from tgdl_faces.io import DEFAULT_WINDOW_SEC

        os.environ["TGDL_FACES_VIDEO_WINDOW_SEC"] = "not-a-number"
        window_sec, _, _ = _resolve_video_sampling_params()
        assert window_sec == DEFAULT_WINDOW_SEC

    def test_track_thresholds_default_when_unset(self):
        from tgdl_faces.app import _resolve_video_track_thresholds

        score, quality, confirmed = _resolve_video_track_thresholds()
        assert score == 0.75
        assert quality == 0.55
        assert confirmed == 0.30

    def test_track_thresholds_env_override(self):
        from tgdl_faces.app import _resolve_video_track_thresholds

        os.environ["TGDL_FACES_VIDEO_SINGLETON_MIN_SCORE"] = "0.8"
        os.environ["TGDL_FACES_VIDEO_SINGLETON_MIN_QUALITY"] = "0.6"
        os.environ["TGDL_FACES_VIDEO_CONFIRMED_MIN_QUALITY"] = "0.4"
        score, quality, confirmed = _resolve_video_track_thresholds()
        assert score == 0.8
        assert quality == 0.6
        assert confirmed == 0.4

    def test_default_max_frames_is_20000_when_unset(self):
        from tgdl_faces.app import _default_max_frames

        assert _default_max_frames() == 20000

    def test_default_max_frames_env_override(self):
        from tgdl_faces.app import _default_max_frames

        os.environ["TGDL_FACES_VIDEO_MAX_FRAMES"] = "5000"
        assert _default_max_frames() == 5000

    def test_default_max_frames_garbage_env_falls_back(self):
        from tgdl_faces.app import _default_max_frames

        os.environ["TGDL_FACES_VIDEO_MAX_FRAMES"] = "not-a-number"
        assert _default_max_frames() == 20000

    def test_video_request_max_frames_uses_env_default_when_omitted(self):
        from tgdl_faces.app import VideoDetectRequest

        os.environ["TGDL_FACES_VIDEO_MAX_FRAMES"] = "777"
        req = VideoDetectRequest(path="/tmp/x.mp4")
        assert req.max_frames == 777

    def test_video_request_explicit_max_frames_wins_over_env(self):
        from tgdl_faces.app import VideoDetectRequest

        os.environ["TGDL_FACES_VIDEO_MAX_FRAMES"] = "777"
        req = VideoDetectRequest(path="/tmp/x.mp4", max_frames=42)
        assert req.max_frames == 42


class TestBuildFaceTracks:
    """`_build_face_tracks(frames_faces)` per docs/requirements.md §4.4.

    ``frames_faces`` is ``list[list[dict]]`` — one list of detections per
    *sampled frame*, in temporal order (not a flat list) — this is what
    lets the tracker count "how many distinct frames corroborated this
    identity" rather than just "how many detections total".
    """

    def setup_method(self):
        from tgdl_faces.app import _build_face_tracks
        self._fn = _build_face_tracks

    def test_empty_input_returns_empty(self):
        assert self._fn([]) == []

    def test_empty_frames_return_empty(self):
        assert self._fn([[], [], []]) == []

    def test_single_hit_high_confidence_kept(self):
        f = _face(score=0.9, quality=0.9)
        result = self._fn([[f]])
        assert result == [f]

    def test_single_hit_below_score_bar_dropped(self):
        f = _face(score=0.6, quality=0.9)  # below the 0.75 singleton score bar
        assert self._fn([[f]]) == []

    def test_single_hit_below_quality_bar_dropped(self):
        f = _face(score=0.9, quality=0.4)  # below the 0.55 singleton quality bar
        assert self._fn([[f]]) == []

    def test_single_hit_at_exact_bars_kept(self):
        f = _face(score=0.75, quality=0.55)
        assert self._fn([[f]]) == [f]

    def test_two_hits_same_person_confirmed_and_deduped_to_best(self):
        """Mirrors the old greedy-dedup behaviour for near-identical poses:
        confirmed by 2 hits, but the poses are too similar to count as
        diverse, so only the highest-scoring one survives."""
        low = _face(score=0.6, quality=0.5, emb=_unit(0))
        high = _face(score=0.95, quality=0.5, emb=_near(0))
        result = self._fn([[low], [high]])
        assert len(result) == 1
        assert result[0]["score"] == 0.95

    def test_two_hits_confirmed_regardless_of_frame_order(self):
        high = _face(score=0.95, quality=0.5, emb=_unit(0))
        low = _face(score=0.6, quality=0.5, emb=_near(0))
        result = self._fn([[high], [low]])
        assert len(result) == 1
        assert result[0]["score"] == 0.95

    def test_confirmed_track_below_universal_quality_floor_dropped(self):
        """The core false-positive-class fix: a systematic misfire (same
        non-face region detected consistently) shouldn't survive just
        because it repeats — every face in the track fails the 0.30 floor."""
        a = _face(score=0.9, quality=0.1, emb=_unit(5))
        b = _face(score=0.9, quality=0.1, emb=_near(5))
        assert self._fn([[a], [b]]) == []

    def test_confirmed_track_meeting_quality_floor_kept(self):
        a = _face(score=0.9, quality=0.35, emb=_unit(6))
        b = _face(score=0.9, quality=0.35, emb=_near(6))
        result = self._fn([[a], [b]])
        assert len(result) == 1

    def test_different_people_across_frames_kept_separately(self):
        frame1 = [_face(score=0.8, quality=0.6, emb=_unit(0)), _face(score=0.8, quality=0.6, emb=_unit(1))]
        frame2 = [_face(score=0.8, quality=0.6, emb=_near(0)), _face(score=0.8, quality=0.6, emb=_near(1))]
        result = self._fn([frame1, frame2])
        # Each identity confirmed by 2 hits, but near-duplicate poses within
        # each identity collapse to 1 representative -> 2 identities total.
        assert len(result) == 2

    def test_three_unique_identities_plus_one_unconfirmed_low_conf_dropped(self):
        frames = [
            [_face(score=0.8, quality=0.6, emb=_unit(0)), _face(score=0.8, quality=0.6, emb=_unit(1))],
            [_face(score=0.9, quality=0.6, emb=_near(0)), _face(score=0.7, quality=0.6, emb=_near(1))],
            [_face(score=0.8, quality=0.6, emb=_unit(2))],  # single-hit but confident -> kept
            [_face(score=0.5, quality=0.3, emb=_unit(9))],  # single-hit, weak -> dropped
        ]
        result = self._fn(frames)
        assert len(result) == 3

    def test_keeps_up_to_three_diverse_representatives(self):
        faces = [
            _face(score=0.9 - 0.05 * k, quality=0.7, emb=_diverse_variant(0, k))
            for k in range(5)
        ]
        result = self._fn([[f] for f in faces])
        assert len(result) <= 3
        assert len(result) >= 2  # confirmed by 5 hits, diverse poses -> more than 1 kept
        scores = sorted((r["score"] for r in result), reverse=True)
        assert scores == sorted(scores, reverse=True)

    def test_near_duplicate_poses_collapse_to_fewer_representatives(self):
        """Same identity, 5 hits, but every pose is a near-duplicate of the
        top scorer — diversity gate should keep far fewer than 5."""
        top = _face(score=0.95, quality=0.7, emb=_unit(3))
        dupes = [_face(score=0.7, quality=0.7, emb=_near(3)) for _ in range(4)]
        result = self._fn([[top]] + [[d] for d in dupes])
        assert len(result) == 1
        assert result[0]["score"] == 0.95


# ---------------------------------------------------------------------------
# Tests: extract_video_frames
# ---------------------------------------------------------------------------


class TestExtractVideoFrames:
    """Covers the fixed-cadence, duration-independent sampler.

    `extract_video_frames` is a **generator** — see docs/requirements.md
    §4.1/§4.2. Calling it just builds the generator object without running
    any code (including the allow-list / cv2-open checks), so every test
    that expects an error or a result has to force iteration via
    ``list(...)`` inside the assertion context.
    """

    def _make_frame(self, size=(480, 640)) -> np.ndarray:
        return np.zeros((*size, 3), dtype=np.uint8)

    def _mock_cv2(self, mock_cap) -> MagicMock:
        mock_cv2 = MagicMock()
        mock_cv2.VideoCapture.return_value = mock_cap
        mock_cv2.CAP_PROP_FPS = 5
        mock_cv2.CAP_PROP_FRAME_COUNT = 7
        mock_cv2.CAP_PROP_POS_FRAMES = 8
        return mock_cv2

    def test_empty_allow_roots_raises_path_not_allowed(self):
        from tgdl_faces.io import PathNotAllowedError, extract_video_frames
        with pytest.raises(PathNotAllowedError):
            list(extract_video_frames("/some/path/video.mp4", allow_roots=[]))

    def test_path_outside_allow_roots_raises_path_not_allowed(self, tmp_path):
        from tgdl_faces.io import PathNotAllowedError, extract_video_frames
        outside = str(tmp_path / "video.mp4")
        with pytest.raises(PathNotAllowedError):
            list(extract_video_frames(outside, allow_roots=["/not/this/dir"]))

    def test_cv2_cannot_open_raises_file_not_found(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = False
        mock_cv2 = self._mock_cv2(mock_cap)

        with patch("tgdl_faces.io.cv2", mock_cv2):
            with pytest.raises(FileNotFoundError):
                list(extract_video_frames(target, allow_roots=[str(tmp_path)]))

    def test_zero_total_frames_reads_one_frame_and_returns_it(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()
        frame = self._make_frame()

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, frame)
        mock_cap.get.side_effect = lambda prop: 0
        mock_cv2 = self._mock_cv2(mock_cap)

        with patch("tgdl_faces.io.cv2", mock_cv2):
            result = list(extract_video_frames(target, allow_roots=[str(tmp_path)]))

        assert len(result) == 1
        assert result[0] is frame

    def test_cap_release_called_even_when_empty_frames(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()

        fps = 30.0
        total_frames = 150

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (False, None)
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)
        mock_cv2 = self._mock_cv2(mock_cap)

        with patch("tgdl_faces.io.cv2", mock_cv2):
            result = list(extract_video_frames(target, allow_roots=[str(tmp_path)]))

        mock_cap.release.assert_called_once()
        assert result == []

    def test_never_seeks(self, tmp_path):
        """Proves the seek-drift bug is fixed: no `cap.set(...)` calls at all —
        one sequential decode, start to end, no `CAP_PROP_POS_FRAMES`."""
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()
        frame = self._make_frame()

        fps = 30.0
        total_frames = 900  # 30s

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, frame)
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)
        mock_cv2 = self._mock_cv2(mock_cap)

        with patch("tgdl_faces.io.cv2", mock_cv2):
            list(extract_video_frames(target, allow_roots=[str(tmp_path)]))

        mock_cap.set.assert_not_called()

    def _static_video(self, tmp_path, total_frames: int, fps: float = 30.0):
        """A mocked video where every decoded frame is identical (zero
        motion) — isolates the floor-checkpoint behaviour from motion."""
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()
        frame = self._make_frame((64, 64))

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, frame)
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)
        mock_cv2 = self._mock_cv2(mock_cap)

        with patch("tgdl_faces.io.cv2", mock_cv2):
            return list(extract_video_frames(target, allow_roots=[str(tmp_path)], max_frames=100000))

    def test_static_video_short_and_long_have_matching_sample_rate(self, tmp_path):
        """Duration-independence: a short and a long zero-motion video must
        get the *same per-second floor rate* — no duration bands, no
        special-casing by video length (docs/requirements.md §4.1/§8)."""
        short = self._static_video(tmp_path, total_frames=300, fps=30.0)  # 10s
        long = self._static_video(tmp_path, total_frames=3000, fps=30.0)  # 100s

        rate_short = len(short) / (300 / 30.0)
        rate_long = len(long) / (3000 / 30.0)

        # Both rates should approximate 1 / floor_interval_sec (default 3.0s
        # -> ~0.33/s); loose tolerance absorbs first-sample/rounding effects
        # at window boundaries, not a duration-band difference.
        assert abs(rate_short - rate_long) < 0.15, (
            f"sample rate should be duration-independent: "
            f"short={rate_short:.3f}/s long={rate_long:.3f}/s"
        )
        # Sanity: neither collapses to the old hardcoded bands (3 / 30 / 60).
        assert 2 <= len(short) <= 8
        assert 20 <= len(long) <= 45

    def test_zero_motion_video_respects_floor_interval(self, tmp_path):
        """A fully static 10s video samples roughly once per
        `floor_interval_sec` (default 3.0s), not once per minute like the
        old evenly-spaced sampler would for a video this short-but-long-ish."""
        result = self._static_video(tmp_path, total_frames=300, fps=30.0)  # 10s
        assert 2 <= len(result) <= 6

    def test_brief_content_change_is_captured(self, tmp_path):
        """A short-lived, visually distinct block of frames (simulating a
        person briefly on screen) between two floor checkpoints is caught
        by motion detection, not skipped — the core bug this rewrite fixes."""
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()

        fps = 30.0
        total_frames = 300  # 10s
        blank = np.zeros((64, 64, 3), dtype=np.uint8)
        gradient_row = np.linspace(0, 255, 64, dtype=np.uint8)
        gradient = np.tile(gradient_row, (64, 1))
        gradient_frame = np.stack([gradient, gradient, gradient], axis=-1).astype(np.uint8)

        frames_seq = [blank.copy() for _ in range(total_frames)]
        for i in range(40, 46):  # ~0.2s block — shorter than window_sec
            frames_seq[i] = gradient_frame

        state = {"i": 0}

        def _read(*_a, **_kw):
            i = state["i"]
            state["i"] += 1
            if i >= len(frames_seq):
                return (False, None)
            return (True, frames_seq[i])

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.side_effect = _read
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)
        mock_cv2 = self._mock_cv2(mock_cap)

        with patch("tgdl_faces.io.cv2", mock_cv2):
            result = list(extract_video_frames(target, allow_roots=[str(tmp_path)]))

        assert any(int(f[0, 0, 0]) == int(gradient_frame[0, 0, 0]) for f in result), (
            "the brief gradient block should have been sampled via motion "
            "detection despite falling between floor checkpoints"
        )

    def test_max_frames_ceiling_stops_sampling(self, tmp_path):
        """`max_frames` is a hard ceiling — with constant high motion (every
        frame different) it must still cap total samples, proving it's a
        safety net independent of the (now-fixed, non-duration-scaled)
        sampling cadence."""
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()

        fps = 30.0
        total_frames = 300
        state = {"i": 0}

        def _read(*_a, **_kw):
            i = state["i"]
            state["i"] += 1
            if i >= total_frames:
                return (False, None)
            # Distinct, textured content every frame -> motion fires on
            # (almost) every window boundary.
            val = (i * 37) % 256
            row = np.linspace(0, val, 64, dtype=np.uint8)
            plane = np.tile(row, (64, 1))
            return (True, np.stack([plane, plane, plane], axis=-1).astype(np.uint8))

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.side_effect = _read
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)
        mock_cv2 = self._mock_cv2(mock_cap)

        with patch("tgdl_faces.io.cv2", mock_cv2):
            result = list(
                extract_video_frames(target, allow_roots=[str(tmp_path)], max_frames=5)
            )

        assert len(result) == 5

    def test_progress_cb_called_once_per_decoded_frame(self, tmp_path):
        """`progress_cb(idx, total_frames)` fires on every raw decode
        iteration — independent of the sampling cadence (kept-frame count)
        — so a caller can report decode position for a long video."""
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()

        fps = 30.0
        total_frames = 10
        frame = self._make_frame()

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, frame)
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)
        mock_cv2 = self._mock_cv2(mock_cap)

        calls = []
        with patch("tgdl_faces.io.cv2", mock_cv2):
            list(
                extract_video_frames(
                    target,
                    allow_roots=[str(tmp_path)],
                    progress_cb=lambda idx, total: calls.append((idx, total)),
                )
            )

        assert calls == [(i, total_frames) for i in range(total_frames)]

    def test_progress_cb_not_called_when_read_stops_early(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()

        fps = 30.0
        total_frames = 10
        frame = self._make_frame()

        state = {"i": 0}

        def _read(*_a, **_kw):
            i = state["i"]
            state["i"] += 1
            if i >= 3:
                return (False, None)
            return (True, frame)

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.side_effect = _read
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)
        mock_cv2 = self._mock_cv2(mock_cap)

        calls = []
        with patch("tgdl_faces.io.cv2", mock_cv2):
            list(
                extract_video_frames(
                    target,
                    allow_roots=[str(tmp_path)],
                    progress_cb=lambda idx, total: calls.append((idx, total)),
                )
            )

        assert calls == [(0, total_frames), (1, total_frames), (2, total_frames)]

    def test_progress_cb_not_called_on_zero_total_frames_fallback(self, tmp_path):
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()
        frame = self._make_frame()

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, frame)
        mock_cap.get.side_effect = lambda prop: 0
        mock_cv2 = self._mock_cv2(mock_cap)

        calls = []
        with patch("tgdl_faces.io.cv2", mock_cv2):
            list(
                extract_video_frames(
                    target,
                    allow_roots=[str(tmp_path)],
                    progress_cb=lambda idx, total: calls.append((idx, total)),
                )
            )

        assert calls == []

    def test_progress_cb_none_is_the_default_and_safe(self, tmp_path):
        """No `progress_cb` given -> behaves exactly as before (no crash,
        no behavior change to yielded frames)."""
        from tgdl_faces.io import extract_video_frames

        target = str(tmp_path / "video.mp4")
        Path(target).touch()
        frame = self._make_frame()

        fps = 30.0
        total_frames = 5

        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, frame)
        mock_cap.get.side_effect = lambda prop: fps if prop == 5 else float(total_frames)
        mock_cv2 = self._mock_cv2(mock_cap)

        with patch("tgdl_faces.io.cv2", mock_cv2):
            result = list(extract_video_frames(target, allow_roots=[str(tmp_path)]))

        assert len(result) >= 1


# ---------------------------------------------------------------------------
# Fixtures for endpoint tests (mirror test_app.py patterns)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def temp_root() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="tgdl-video-test-") as tmp:
        yield Path(tmp).resolve()


@pytest.fixture(scope="module")
def outside_dir() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="tgdl-video-outside-") as tmp:
        yield Path(tmp).resolve()


@pytest.fixture(scope="module")
def client(temp_root: Path):
    os.environ["TGDL_FACES_ALLOW_ROOTS"] = str(temp_root)
    from fastapi.testclient import TestClient
    from tgdl_faces.app import app
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Tests: POST /detect/video endpoint
# ---------------------------------------------------------------------------


def test_video_missing_path_returns_422(client) -> None:
    resp = client.post("/detect/video", json={})
    assert resp.status_code in (400, 422)


def test_video_ar_range_lo_ge_hi_returns_422(client, temp_root: Path) -> None:
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "x.mp4"), "ar_range": [1.0, 0.5]},
    )
    assert resp.status_code in (400, 422)


def test_video_ar_range_lo_equals_hi_returns_422(client, temp_root: Path) -> None:
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "x.mp4"), "ar_range": [1.0, 1.0]},
    )
    assert resp.status_code in (400, 422)


def test_video_max_frames_zero_returns_422(client, temp_root: Path) -> None:
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "x.mp4"), "max_frames": 0},
    )
    assert resp.status_code in (400, 422)


def test_video_max_frames_over_ceiling_returns_422(client, temp_root: Path) -> None:
    """`max_frames` is a pure safety ceiling (§4.1/§6, default 20000) — the
    real cap moved from the old density-control 500 up to 200000, but the
    field is still bounded so a client can't request an unbounded decode."""
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "x.mp4"), "max_frames": 200_001},
    )
    assert resp.status_code in (400, 422)


def test_video_max_frames_20000_is_valid(client, temp_root: Path) -> None:
    """20000 — the new §5 safety-ceiling default — must itself be an
    accepted value, not just values below it."""
    from tgdl_faces import insight
    from tgdl_faces import app as app_mod

    with patch.object(insight, "_APP", MagicMock()), patch.object(
        insight, "_APP_ERROR", None
    ), patch.object(app_mod, "extract_video_frames", lambda *a, **kw: []):
        resp = client.post(
            "/detect/video",
            json={"path": str(temp_root / "x.mp4"), "max_frames": 20000},
        )
    assert resp.status_code == 200


def test_video_model_not_ready_returns_503(monkeypatch, client, temp_root: Path) -> None:
    from tgdl_faces import insight
    monkeypatch.setattr(insight, "_APP", None)
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "x.mp4")},
    )
    assert resp.status_code == 503


def test_video_path_outside_allow_roots_returns_403(
    monkeypatch, client, outside_dir: Path
) -> None:
    from tgdl_faces import insight
    monkeypatch.setattr(insight, "_APP", MagicMock())
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    target = str(outside_dir / "outside.mp4")
    resp = client.post("/detect/video", json={"path": target})
    assert resp.status_code == 403
    assert resp.json()["code"] == "path_not_allowed"


def test_video_file_not_found_returns_200_with_error(
    monkeypatch, client, temp_root: Path
) -> None:
    from tgdl_faces import insight
    from tgdl_faces import app as app_mod
    monkeypatch.setattr(insight, "_APP", MagicMock())
    monkeypatch.setattr(insight, "_APP_ERROR", None)

    def _raise_fnf(path, allow_roots, **kwargs):
        raise FileNotFoundError("cv2 cannot open")

    monkeypatch.setattr(app_mod, "extract_video_frames", _raise_fnf)
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "missing.mp4")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] == "file_not_found"
    assert body["faces"] == []


def test_video_no_frames_extracted_returns_200_with_error(
    monkeypatch, client, temp_root: Path
) -> None:
    from tgdl_faces import insight
    from tgdl_faces import app as app_mod
    monkeypatch.setattr(insight, "_APP", MagicMock())
    monkeypatch.setattr(insight, "_APP_ERROR", None)

    monkeypatch.setattr(app_mod, "extract_video_frames", lambda *a, **kw: [])
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "empty.mp4")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] == "no_frames"
    assert body["faces"] == []


def test_video_happy_path_streams_frames_into_confirmed_track(
    monkeypatch, client, temp_root: Path
) -> None:
    """End-to-end: `extract_video_frames` generator -> per-frame detection
    -> `_build_face_tracks` -> response. Also asserts quality scoring is
    no longer force-skipped for video (Phase 2 §4.4 requirement)."""
    from tgdl_faces import insight
    from tgdl_faces import app as app_mod

    monkeypatch.setattr(insight, "_APP", MagicMock())
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    monkeypatch.setattr(app_mod, "gpu_available", lambda: False)

    frame = np.zeros((20, 30, 3), dtype=np.uint8)

    def _frame_gen(*_a, **_kw):
        yield frame
        yield frame

    monkeypatch.setattr(app_mod, "extract_video_frames", _frame_gen)

    seen_kwargs: list[dict] = []
    template = _face(score=0.9, quality=0.6, emb=_unit(0))

    def _fake_detect(_img, **kwargs):
        seen_kwargs.append(kwargs)
        return [dict(template)]

    monkeypatch.setattr(app_mod, "detect_and_embed", _fake_detect)

    resp = client.post("/detect/video", json={"path": str(temp_root / "ok.mp4")})
    assert resp.status_code == 200
    body = resp.json()
    assert body["image_w"] == 30
    assert body["image_h"] == 20
    assert len(body["faces"]) == 1
    assert body["faces"][0]["score"] == 0.9
    assert len(seen_kwargs) == 2
    assert all("_skip_quality_score" not in kw for kw in seen_kwargs)


def test_video_streaming_bounds_in_flight_frames_to_max_workers(
    monkeypatch, client, temp_root: Path
) -> None:
    """Regression test for the §4.2/§8 memory-bound requirement: even for a
    very long simulated video, at most `max_workers` decoded frames are
    ever concurrently "in flight" (submitted-but-not-yet-detected) — proves
    the streaming rewrite decouples peak memory from total sample count."""
    from tgdl_faces import insight
    from tgdl_faces import app as app_mod

    monkeypatch.setattr(insight, "_APP", MagicMock())
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    monkeypatch.setattr(app_mod, "gpu_available", lambda: True)
    monkeypatch.setattr(app_mod, "_resolve_max_concurrency", lambda: 4)

    total_frames = 2000

    def _frame_gen(*_a, **_kw):
        for _ in range(total_frames):
            yield np.zeros((8, 8, 3), dtype=np.uint8)

    monkeypatch.setattr(app_mod, "extract_video_frames", _frame_gen)

    in_flight = {"current": 0, "peak": 0}
    lock = threading.Lock()

    def _slow_detect(_frame, **_kwargs):
        with lock:
            in_flight["current"] += 1
            in_flight["peak"] = max(in_flight["peak"], in_flight["current"])
        time.sleep(0.001)
        with lock:
            in_flight["current"] -= 1
        return []

    monkeypatch.setattr(app_mod, "detect_and_embed", _slow_detect)

    resp = client.post("/detect/video", json={"path": str(temp_root / "long.mp4")})
    assert resp.status_code == 200
    assert resp.json()["faces"] == []
    assert in_flight["peak"] <= 4


# ---------------------------------------------------------------------------
# Tests: job_id progress -> GET /detect/video/status/{job_id}
# ---------------------------------------------------------------------------


def test_video_status_unknown_job_id_returns_404(client) -> None:
    resp = client.get("/detect/video/status/does-not-exist")
    assert resp.status_code == 404
    assert resp.json()["code"] == "job_not_found"


def test_video_status_reports_progress_mid_request_and_cleans_up_after(
    monkeypatch, client, temp_root: Path
) -> None:
    """End-to-end: a `job_id` in the POST body makes `_do_detect_video_sync`
    report decode position into `video_progress` as `extract_video_frames`
    walks the video, pollable via GET /detect/video/status/{job_id} — and
    the entry is gone once the request completes (success path)."""
    from tgdl_faces import insight
    from tgdl_faces import app as app_mod

    monkeypatch.setattr(insight, "_APP", MagicMock())
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    monkeypatch.setattr(app_mod, "gpu_available", lambda: False)
    monkeypatch.setattr(app_mod, "detect_and_embed", lambda *_a, **_kw: [])

    frame = np.zeros((20, 30, 3), dtype=np.uint8)
    reached_midpoint = threading.Event()
    release = threading.Event()

    def _frame_gen(*_a, progress_cb=None, **_kw):
        if progress_cb:
            progress_cb(0, 4)
        yield frame
        if progress_cb:
            progress_cb(1, 4)
        reached_midpoint.set()
        assert release.wait(timeout=5), "test deadlocked waiting for release"
        if progress_cb:
            progress_cb(2, 4)
        yield frame
        if progress_cb:
            progress_cb(3, 4)

    monkeypatch.setattr(app_mod, "extract_video_frames", _frame_gen)

    job_id = "job-mid-flight-test"
    result_holder: dict = {}

    def _do_request():
        result_holder["resp"] = client.post(
            "/detect/video",
            json={"path": str(temp_root / "x.mp4"), "job_id": job_id},
        )

    thread = threading.Thread(target=_do_request)
    thread.start()
    try:
        assert reached_midpoint.wait(timeout=5), "request never reached the midpoint"

        status_resp = client.get(f"/detect/video/status/{job_id}")
        assert status_resp.status_code == 200
        body = status_resp.json()
        assert body["job_id"] == job_id
        assert body["frames_decoded"] == 2
        assert body["total_frames"] == 4
        assert body["pct"] == 50
        assert body["elapsed_sec"] >= 0
    finally:
        release.set()
        thread.join(timeout=5)

    assert result_holder["resp"].status_code == 200

    final_status = client.get(f"/detect/video/status/{job_id}")
    assert final_status.status_code == 404


def test_video_status_cleaned_up_after_soft_error(monkeypatch, client, temp_root: Path) -> None:
    """job_id cleanup also fires on the file_not_found soft-error path —
    the try/finally wraps the whole detect body, not just the happy path."""
    from tgdl_faces import insight
    from tgdl_faces import app as app_mod

    monkeypatch.setattr(insight, "_APP", MagicMock())
    monkeypatch.setattr(insight, "_APP_ERROR", None)

    def _raise_fnf(*_a, **_kw):
        raise FileNotFoundError("cv2 cannot open")

    monkeypatch.setattr(app_mod, "extract_video_frames", _raise_fnf)

    job_id = "job-soft-error-test"
    resp = client.post(
        "/detect/video",
        json={"path": str(temp_root / "missing.mp4"), "job_id": job_id},
    )
    assert resp.status_code == 200
    assert resp.json()["error"] == "file_not_found"

    assert client.get(f"/detect/video/status/{job_id}").status_code == 404


def test_video_without_job_id_never_registers_progress(
    monkeypatch, client, temp_root: Path
) -> None:
    """Omitting job_id (old client / no-op default) means extract_video_frames
    is called with progress_cb=None — no registry entry is ever created."""
    from tgdl_faces import insight
    from tgdl_faces import app as app_mod

    monkeypatch.setattr(insight, "_APP", MagicMock())
    monkeypatch.setattr(insight, "_APP_ERROR", None)
    monkeypatch.setattr(app_mod, "gpu_available", lambda: False)
    monkeypatch.setattr(app_mod, "detect_and_embed", lambda *_a, **_kw: [])

    seen_progress_cb = {"value": "unset"}

    def _frame_gen(*_a, progress_cb=None, **_kw):
        seen_progress_cb["value"] = progress_cb
        yield np.zeros((4, 4, 3), dtype=np.uint8)

    monkeypatch.setattr(app_mod, "extract_video_frames", _frame_gen)

    resp = client.post("/detect/video", json={"path": str(temp_root / "no-job-id.mp4")})
    assert resp.status_code == 200
    assert seen_progress_cb["value"] is None
