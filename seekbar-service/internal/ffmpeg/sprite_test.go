package ffmpeg

import (
	"strings"
	"testing"
)

func TestPlanFingerprintDefaultRate(t *testing.T) {
	p := PlanFingerprint(10, 1, 7200, 32)
	if p.Frames != 10 {
		t.Fatalf("frames=%d want 10", p.Frames)
	}
	if p.IntervalSec != 1 {
		t.Fatalf("interval=%v want 1", p.IntervalSec)
	}
	if p.TilePx != 32 {
		t.Fatalf("tilePx=%d want 32", p.TilePx)
	}
}

func TestPlanFingerprintCapsLongVideo(t *testing.T) {
	p := PlanFingerprint(14400, 1, 7200, 32)
	if p.Frames != 7200 {
		t.Fatalf("frames=%d want 7200", p.Frames)
	}
	if p.IntervalSec != 2 {
		t.Fatalf("interval=%v want 2", p.IntervalSec)
	}
}

func TestPlanSpriteStillSparseOnLongVideo(t *testing.T) {
	hover := Plan(7200, 4, 10, 240, 160)
	if hover.Frames != 240 {
		t.Fatalf("hover frames=%d want 240", hover.Frames)
	}
	fp := PlanFingerprint(7200, 1, 7200, 32)
	if fp.Frames != 7200 {
		t.Fatalf("fp frames=%d want 7200", fp.Frames)
	}
}

func TestBuildArgsDualSplit(t *testing.T) {
	plan := Plan(10, 4, 10, 240, 160)
	fp := PlanFingerprint(10, 1, 7200, 32)
	args := BuildArgs("in.mp4", "out.tmp.webp", plan, "webp", 70, nil, "", "", 2, "out.fp.raw", &fp)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-filter_complex") {
		t.Fatalf("missing filter_complex: %s", joined)
	}
	if strings.Contains(joined, " -vf ") {
		t.Fatalf("legacy -vf should not appear with dual output: %s", joined)
	}
	if !strings.Contains(joined, "split=2") {
		t.Fatalf("missing split: %s", joined)
	}
	if !strings.Contains(joined, "rawvideo") || !strings.Contains(joined, "out.fp.raw") {
		t.Fatalf("missing fingerprint raw output: %s", joined)
	}
	maps := 0
	for _, a := range args {
		if a == "-map" {
			maps++
		}
	}
	if maps != 2 {
		t.Fatalf("map count=%d want 2", maps)
	}
}

func TestBuildArgsHoverOnlyWithoutFingerprint(t *testing.T) {
	plan := Plan(10, 4, 10, 240, 160)
	args := BuildArgs("in.mp4", "out.tmp.webp", plan, "webp", 70, nil, "", "", 2, "", nil)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-vf") {
		t.Fatalf("hover-only path should keep -vf: %s", joined)
	}
	if strings.Contains(joined, "filter_complex") || strings.Contains(joined, "rawvideo") {
		t.Fatalf("hover-only path should not dual-output: %s", joined)
	}
}
