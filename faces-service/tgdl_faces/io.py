"""Image input helpers for the sidecar.

Two ingress paths:

* :func:`load_image_from_path` — the sidecar reads bytes off disk.
  Cheap on standalone installs where the sidecar shares the host
  filesystem with the Node app, but requires an allow-list to stop
  forged requests from reading arbitrary files. The Node side passes
  the absolute path under ``data/downloads``; the allow-list is
  injected via ``TGDL_FACES_ALLOW_ROOTS``.

* :func:`load_image_from_b64` — Node ships the bytes as base64.
  Used in the Docker compose deployment where the sidecar container
  doesn't share a volume with the Node container, and as a fallback
  whenever path mode trips the allow-list.

Both helpers return an ``H×W×3`` ``uint8`` BGR ndarray (the layout
:mod:`cv2` produces and :mod:`insightface` expects).
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
from pathlib import Path
from typing import Iterator

import cv2
import numpy as np


_LOG = logging.getLogger(__name__)


class PathNotAllowedError(PermissionError):
    """Raised when ``path`` falls outside any allowed root.

    The FastAPI layer maps this to a ``403`` response.
    """


class ImageDecodeError(ValueError):
    """Raised when bytes are valid but can't be decoded as an image format.

    The FastAPI layer maps this to a soft 200 with ``{"error": "decode_failed"}``
    so the Node retry loop doesn't crash on a single corrupt frame.
    """


class Base64DecodeError(ImageDecodeError):
    """Raised when the ``image_b64`` string is not valid base64.

    Distinct from :class:`ImageDecodeError` so the FastAPI layer can
    return ``415 Unsupported Media Type`` (the client sent garbage, not an
    image in an unexpected format).
    """


def _norm(p: str | os.PathLike[str]) -> str:
    """Resolve, normalise and casefold a path for prefix comparison.

    Windows is case-insensitive on the filesystem, so the allow-list
    check needs to be too — otherwise ``C:\\Data\\downloads`` and
    ``c:\\data\\downloads`` would be treated as different roots and a
    legitimate request from the Node side would 403.
    """
    return os.path.normcase(os.path.realpath(str(p)))


def _is_under(path: str, root: str) -> bool:
    """Return True iff ``path`` lives at or below ``root``.

    Uses ``os.path.commonpath`` over normalised, real-path-resolved
    inputs so symlink trickery can't escape the allow-list. Both inputs
    must already be absolute — callers pass realpath output.
    """
    if not path or not root:
        return False
    try:
        common = os.path.commonpath([path, root])
    except ValueError:
        # Different drives on Windows raise ValueError — treat as
        # "not under".
        return False
    return common == root


def _apply_exif_orientation(bgr: np.ndarray, raw_bytes: bytes) -> np.ndarray:
    """Rotate/flip ``bgr`` to match the EXIF orientation tag in ``raw_bytes``.

    ``cv2.imdecode`` ignores EXIF rotation tags (orientations 3, 6, 8),
    which causes portrait photos taken on phones to appear sideways or
    upside-down when fed directly to the face detector.  Pillow reads EXIF
    reliably on all platforms (including Windows where libjpeg-turbo can
    behave differently), so we use it as the authority for the rotation.

    Orientations:
      1 — normal (no-op)
      3 — 180° rotation
      6 — 90° clockwise (270° counter-clockwise)
      8 — 90° counter-clockwise (270° clockwise)

    All other values are treated as no-op to avoid breaking unusual EXIF
    data.
    """
    try:
        from PIL import Image  # noqa: PLC0415
        import io as _io  # noqa: PLC0415

        with Image.open(_io.BytesIO(raw_bytes)) as pil_img:
            exif = pil_img.getexif() if hasattr(pil_img, "getexif") else {}
            # Tag 0x0112 is Orientation
            orientation = exif.get(0x0112, 1) if exif else 1
    except Exception:
        # Pillow not importable, image has no EXIF, or EXIF is unreadable —
        # return the image as-is so we don't silently break non-JPEG inputs.
        return bgr

    if orientation == 3:
        # 180° rotation
        return cv2.rotate(bgr, cv2.ROTATE_180)
    if orientation == 6:
        # 90° clockwise
        return cv2.rotate(bgr, cv2.ROTATE_90_CLOCKWISE)
    if orientation == 8:
        # 90° counter-clockwise
        return cv2.rotate(bgr, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return bgr


def load_image_from_path(path: str, allow_roots: list[str]) -> np.ndarray:
    """Read ``path`` off disk after checking the allow-list.

    Parameters
    ----------
    path
        Absolute path supplied by the caller (the Node side).
    allow_roots
        Whitelist of absolute roots — ``path`` must resolve inside
        one of them. If empty, every request is rejected: that's the
        opt-in stance the README documents.

    Raises
    ------
    PathNotAllowedError
        ``path`` doesn't resolve under any allow_root.
    FileNotFoundError
        The file is missing or unreadable as an image.
    """
    if not path:
        raise FileNotFoundError("empty path")
    if not allow_roots:
        raise PathNotAllowedError(
            "path mode is disabled (TGDL_FACES_ALLOW_ROOTS is empty)"
        )

    target = _norm(path)
    roots = [_norm(r) for r in allow_roots if r]
    if not any(_is_under(target, r) for r in roots):
        raise PathNotAllowedError(f"path {path!r} is outside TGDL_FACES_ALLOW_ROOTS")

    # Open with O_NOFOLLOW where available to prevent TOCTOU symlink
    # swap between the realpath() validation above and the actual read.
    _open_flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        _open_flags |= os.O_NOFOLLOW
    try:
        fd = os.open(target, _open_flags)
        try:
            with open(fd, "rb", closefd=False) as fh:
                raw = fh.read()
        finally:
            os.close(fd)
    except (OSError, FileNotFoundError) as exc:
        raise FileNotFoundError(f"could not read {path!r}: {exc}") from exc

    if not raw:
        raise FileNotFoundError(f"file {path!r} is empty")

    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        # cv2 fails on animated WebP and some uncommon encodings — try Pillow.
        # For animated images (animated WebP, APNG, GIF) the image object
        # starts at frame 0 but some Pillow builds reject convert("RGB") until
        # seek(0) is called explicitly to materialise a concrete frame.
        try:
            from PIL import Image as _PilImage  # noqa: PLC0415
            import io as _bio  # noqa: PLC0415
            with _PilImage.open(_bio.BytesIO(raw)) as pil:
                try:
                    pil.seek(0)
                except (AttributeError, EOFError):
                    pass
                frame = pil.convert("RGB")
                img = cv2.cvtColor(np.array(frame, dtype=np.uint8), cv2.COLOR_RGB2BGR)
        except Exception:
            img = None
    if img is None:
        raise ImageDecodeError(f"failed to decode image at {path!r}")
    return _apply_exif_orientation(img, raw)


# Fixed sampling constants (see docs/requirements.md §4.1) — deliberately
# NOT scaled by video duration. A 10-second clip and a 4-hour video are
# walked with identical logic; only the *number* of windows differs.
#
#   DEFAULT_WINDOW_SEC         is the real recall-latency driver: motion is
#                              re-checked every window against the last kept
#                              sample, so this is how fast a brief on-screen
#                              appearance gets noticed.
#   DEFAULT_FLOOR_INTERVAL_SEC is only a backstop for stretches where
#                              nothing ever triggers motion (a genuinely
#                              static scene) — looser than window_sec is
#                              fine since it isn't the recall mechanism.
#   DEFAULT_MOTION_THRESHOLD   is the sensitivity dial: how much luma
#                              change (0-255 scale, on a downscaled
#                              signature) counts as "the picture changed".
DEFAULT_WINDOW_SEC = 0.4
DEFAULT_FLOOR_INTERVAL_SEC = 3.0
DEFAULT_MOTION_THRESHOLD = 6.0

_ACTIVITY_SIZE = (160, 90)  # (width, height) of the downscaled luma signature — the
# actual full-resolution frame is still used for detection; this only feeds the
# cheap motion/sharpness signal that decides *which* frames to keep. Kept larger
# than a typical motion-detector proxy would use so a small/distant face entering
# frame still perturbs enough cells to register — still trivially cheap next to
# the ArcFace/RetinaFace inference cost that dominates this pipeline regardless.


def _activity_signature(frame: np.ndarray, size: tuple[int, int] = _ACTIVITY_SIZE) -> np.ndarray:
    """Cheap per-frame signature for motion/scene-change comparison.

    Pure-NumPy nearest-neighbour downsample + luma grayscale. Deliberately
    avoids a second cv2 call per frame (the caller already paid for one
    decode) — a coarse ~48x27 signal is plenty to tell "the picture
    changed" apart from "identical scene" without pixel-perfect comparison,
    and staying in NumPy keeps this testable independent of cv2's own
    resize/color-convert behaviour.
    """
    h, w = frame.shape[:2]
    tw, th = size
    xs = np.clip((np.arange(tw) * w) // max(1, tw), 0, w - 1)
    ys = np.clip((np.arange(th) * h) // max(1, th), 0, h - 1)
    small = frame[ys][:, xs]  # th x tw x 3, BGR (cv2 decode order)
    b = small[..., 0].astype(np.float32)
    g = small[..., 1].astype(np.float32)
    r = small[..., 2].astype(np.float32)
    return b * 0.114 + g * 0.587 + r * 0.299


def _activity_diff(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute difference between two activity signatures (0..255 scale)."""
    return float(np.abs(a - b).mean())


def _sharpness(sig: np.ndarray) -> float:
    """Cheap sharpness proxy: variance of the signature's local gradient.

    Computed on the already-downscaled activity signature so picking the
    least motion-blurred frame within a sampling window costs nothing
    beyond the diff signature every frame already needs.
    """
    if sig.shape[0] < 2 or sig.shape[1] < 2:
        return 0.0
    gx = np.diff(sig, axis=1)
    gy = np.diff(sig, axis=0)
    return float(gx.var() + gy.var())


def extract_video_frames(
    path: str,
    allow_roots: list[str],
    max_frames: int = 120,
    *,
    window_sec: float = DEFAULT_WINDOW_SEC,
    floor_interval_sec: float = DEFAULT_FLOOR_INTERVAL_SEC,
    motion_threshold: float = DEFAULT_MOTION_THRESHOLD,
) -> Iterator[np.ndarray]:
    """Yield content-adaptive frames from a video via one sequential decode.

    Replaces the previous evenly-spaced-by-duration-band sampler. Uniform
    time sampling misses any face whose on-screen appearance is shorter
    than the sampling interval, and ``cv2``'s ``CAP_PROP_POS_FRAMES`` seek
    is unreliable on long-GOP H.264/HEVC (it lands on the nearest keyframe,
    not the requested index). This walks the video exactly once, start to
    end — no seeking — and decides on the fly which frames are worth
    keeping, using **fixed** constants that do not scale with video
    duration (see docs/requirements.md §4.1):

    - The video is split into ``window_sec`` windows. Within each window,
      the least motion-blurred frame (cheapest-possible sharpness proxy on
      a downscaled luma signature) is that window's candidate.
    - A candidate is *kept* when it differs from the previously kept
      sample by more than ``motion_threshold`` — the picture actually
      changed — checked at every window boundary, which is what lets a
      brief appearance get caught regardless of video length.
    - A candidate is also kept if ``floor_interval_sec`` has elapsed since
      the last kept sample, even with zero detected motion — a backstop
      for genuinely static scenes, not the primary recall mechanism.
    - ``max_frames`` is a hard ceiling — a runaway-safety net, not a
      duration-based budget. It should rarely bind for real videos.

    Frames are yielded as in-memory BGR ndarrays in temporal order — no
    temp files written to disk, no seeking. This is a generator so a
    caller that detects-and-discards each frame as it arrives (the
    streaming pipeline in docs/requirements.md §4.2) never holds more than
    a handful of decoded frames in memory regardless of video length.

    Raises
    ------
    PathNotAllowedError
        ``path`` falls outside TGDL_FACES_ALLOW_ROOTS.
    FileNotFoundError
        ``path`` is missing or cv2 cannot open it as a video.
    """
    if not allow_roots:
        raise PathNotAllowedError(
            "path mode is disabled (TGDL_FACES_ALLOW_ROOTS is empty)"
        )
    target = _norm(path)
    roots = [_norm(r) for r in allow_roots if r]
    if not any(_is_under(target, r) for r in roots):
        raise PathNotAllowedError(f"path {path!r} is outside TGDL_FACES_ALLOW_ROOTS")

    cap = cv2.VideoCapture(target)
    if not cap.isOpened():
        raise FileNotFoundError(f"cv2 cannot open video {path!r}")

    try:
        raw_fps = cap.get(cv2.CAP_PROP_FPS)
        fps = raw_fps if raw_fps and raw_fps > 0 else 25.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        if total_frames <= 0:
            # Some containers don't report frame count — grab one frame.
            ret, frame = cap.read()
            if ret and frame is not None:
                yield frame
            return

        window_frames = max(1, round(fps * window_sec))
        floor_frames = max(window_frames, round(fps * floor_interval_sec))

        prev_sig: np.ndarray | None = None
        last_kept_idx = -floor_frames
        kept = 0

        best_sharp = -1.0
        best_frame: np.ndarray | None = None
        best_sig: np.ndarray | None = None
        best_idx = 0
        window_start = 0

        for idx in range(total_frames):
            ret, frame = cap.read()
            if not ret or frame is None:
                break
            sig = _activity_signature(frame)
            sharp = _sharpness(sig)
            if sharp > best_sharp:
                best_sharp, best_frame, best_sig, best_idx = sharp, frame, sig, idx

            at_window_end = (idx - window_start + 1) >= window_frames
            at_video_end = idx == total_frames - 1
            if best_frame is not None and (at_window_end or at_video_end):
                motion = (
                    _activity_diff(prev_sig, best_sig)
                    if prev_sig is not None
                    else float("inf")
                )
                hit_floor = (best_idx - last_kept_idx) >= floor_frames
                if prev_sig is None or motion >= motion_threshold or hit_floor:
                    yield best_frame
                    prev_sig = best_sig
                    last_kept_idx = best_idx
                    kept += 1
                    if kept >= max_frames:
                        return
                best_sharp, best_frame, best_sig = -1.0, None, None
                window_start = idx + 1
    finally:
        cap.release()


def load_image_from_b64(data: str) -> np.ndarray:
    """Decode a base64-encoded image into a BGR ndarray.

    Strips an optional ``data:image/...;base64,`` prefix to be tolerant
    of Web-platform pasting habits.

    Raises
    ------
    ImageDecodeError
        The bytes can't be base64-decoded or aren't a recognised image
        format.
    """
    if not data or not isinstance(data, str):
        raise Base64DecodeError("image_b64 must be a non-empty string")

    payload = data.strip()
    if payload.startswith("data:") and ";base64," in payload:
        payload = payload.split(";base64,", 1)[1]

    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise Base64DecodeError(f"image_b64 is not valid base64: {exc}") from exc

    if not raw:
        raise Base64DecodeError("image_b64 decoded to zero bytes")

    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ImageDecodeError("image_b64 bytes could not be decoded as an image")
    return _apply_exif_orientation(img, raw)
