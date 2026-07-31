"""Tests for tgdl_faces.video_progress — the in-flight /detect/video
decode-position registry polled via GET /detect/video/status/{job_id}.
"""

from __future__ import annotations

import time

import pytest

from tgdl_faces import video_progress


@pytest.fixture(autouse=True)
def _clean_registry():
    video_progress._reset_for_tests()
    yield
    video_progress._reset_for_tests()


class TestReportAndGet:
    def test_unknown_job_returns_none(self):
        assert video_progress.get("does-not-exist") is None

    def test_report_then_get_roundtrips_fields(self):
        video_progress.report("job-1", path="/videos/a.mp4", frames_decoded=10, total_frames=100)
        job = video_progress.get("job-1")
        assert job is not None
        assert job["job_id"] == "job-1"
        assert job["path"] == "/videos/a.mp4"
        assert job["frames_decoded"] == 10
        assert job["total_frames"] == 100

    def test_second_report_updates_fields_in_place(self):
        video_progress.report("job-1", frames_decoded=10, total_frames=100)
        video_progress.report("job-1", frames_decoded=50, total_frames=100)
        job = video_progress.get("job-1")
        assert job["frames_decoded"] == 50

    def test_started_at_is_set_once_and_stable_across_updates(self):
        video_progress.report("job-1", frames_decoded=1, total_frames=100)
        first = video_progress.get("job-1")["started_at"]
        time.sleep(0.01)
        video_progress.report("job-1", frames_decoded=2, total_frames=100)
        second = video_progress.get("job-1")["started_at"]
        assert first == second

    def test_updated_at_advances_on_every_report(self):
        video_progress.report("job-1", frames_decoded=1, total_frames=100)
        first = video_progress.get("job-1")["updated_at"]
        time.sleep(0.01)
        video_progress.report("job-1", frames_decoded=2, total_frames=100)
        second = video_progress.get("job-1")["updated_at"]
        assert second > first

    def test_empty_job_id_is_a_no_op(self):
        video_progress.report("", frames_decoded=1, total_frames=100)
        assert video_progress.get("") is None


class TestPctDerivation:
    def test_pct_computed_from_frames_decoded_and_total(self):
        video_progress.report("job-1", frames_decoded=25, total_frames=100)
        assert video_progress.get("job-1")["pct"] == 25

    def test_pct_rounds_to_nearest_int(self):
        video_progress.report("job-1", frames_decoded=1, total_frames=3)
        assert video_progress.get("job-1")["pct"] == 33

    def test_pct_clamped_to_100(self):
        # Defensive — frames_decoded should never exceed total_frames, but
        # don't let a rounding/off-by-one report a nonsensical >100%.
        video_progress.report("job-1", frames_decoded=101, total_frames=100)
        assert video_progress.get("job-1")["pct"] == 100

    def test_pct_none_when_total_frames_missing(self):
        video_progress.report("job-1", frames_decoded=10)
        assert video_progress.get("job-1")["pct"] is None

    def test_pct_none_when_total_frames_zero(self):
        video_progress.report("job-1", frames_decoded=0, total_frames=0)
        assert video_progress.get("job-1")["pct"] is None


class TestElapsedSec:
    def test_elapsed_sec_is_nonnegative_number(self):
        video_progress.report("job-1", frames_decoded=1, total_frames=100)
        elapsed = video_progress.get("job-1")["elapsed_sec"]
        assert isinstance(elapsed, float)
        assert elapsed >= 0

    def test_elapsed_sec_grows_between_reads(self):
        video_progress.report("job-1", frames_decoded=1, total_frames=100)
        first = video_progress.get("job-1")["elapsed_sec"]
        time.sleep(0.05)
        second = video_progress.get("job-1")["elapsed_sec"]
        assert second >= first


class TestFinish:
    def test_finish_removes_the_job(self):
        video_progress.report("job-1", frames_decoded=1, total_frames=100)
        video_progress.finish("job-1")
        assert video_progress.get("job-1") is None

    def test_finish_unknown_job_is_a_no_op(self):
        video_progress.finish("never-existed")  # must not raise

    def test_finish_empty_job_id_is_a_no_op(self):
        video_progress.finish("")  # must not raise
