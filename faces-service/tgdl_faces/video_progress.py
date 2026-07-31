"""In-memory registry for in-flight ``/detect/video`` decode progress.

A 2-hour video can legitimately take many minutes to process, during
which the single blocking ``POST /detect/video`` request gives the
caller zero feedback. ``_do_detect_video_sync`` (see ``app.py``) reports
its decode position here as it walks the video, keyed by a caller-
supplied ``job_id``; ``GET /detect/video/status/{job_id}`` (also in
``app.py``) lets the Node client poll it mid-request.

Deliberately tiny and process-local — no persistence, no cross-worker
sharing. Entries are removed by the caller (via :func:`finish`) once the
request completes, so nothing survives a crashed request beyond the
process's own lifetime.
"""

from __future__ import annotations

import threading
import time
from typing import Any

_LOCK = threading.Lock()
_JOBS: dict[str, dict[str, Any]] = {}


def report(job_id: str, **fields: Any) -> None:
    """Upsert progress fields for ``job_id``.

    Sets ``started_at`` only on the first call for a given ``job_id``;
    every call (including the first) refreshes ``updated_at``.
    """
    if not job_id:
        return
    now = time.time()
    with _LOCK:
        job = _JOBS.setdefault(job_id, {"job_id": job_id, "started_at": now})
        job.update(fields)
        job["updated_at"] = now


def get(job_id: str) -> dict[str, Any] | None:
    """Return a snapshot of ``job_id``'s progress, or ``None`` if unknown.

    Also computes ``pct`` (0-100, rounded) and ``elapsed_sec`` from the
    stored ``frames_decoded``/``total_frames``/``started_at`` — derived
    on read so :func:`report` callers never have to compute them.
    """
    if not job_id:
        return None
    with _LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return None
        snapshot = dict(job)

    total = snapshot.get("total_frames")
    decoded = snapshot.get("frames_decoded")
    if isinstance(total, (int, float)) and total > 0 and isinstance(decoded, (int, float)):
        snapshot["pct"] = max(0, min(100, round(decoded / total * 100)))
    else:
        snapshot["pct"] = None

    started_at = snapshot.get("started_at")
    if isinstance(started_at, (int, float)):
        snapshot["elapsed_sec"] = round(time.time() - started_at, 1)
    else:
        snapshot["elapsed_sec"] = None

    return snapshot


def finish(job_id: str) -> None:
    """Remove ``job_id`` from the registry. No-op if already absent."""
    if not job_id:
        return
    with _LOCK:
        _JOBS.pop(job_id, None)


def _reset_for_tests() -> None:
    """Test-only: clear the registry between tests."""
    with _LOCK:
        _JOBS.clear()
