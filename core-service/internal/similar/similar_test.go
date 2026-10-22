package similar

import (
	"context"
	"math"
	"strings"
	"testing"
)

func fillRGB(value byte, px int) []byte {
	buf := make([]byte, px*px*3)
	for i := range buf {
		buf[i] = value
	}
	return buf
}

func gradientRGB(axis string, px int) []byte {
	buf := make([]byte, px*px*3)
	for y := 0; y < px; y++ {
		for x := 0; x < px; x++ {
			t := float64(y) / float64(px-1)
			if axis == "x" {
				t = float64(x) / float64(px-1)
			}
			v := byte(math.Round(t * 255))
			o := (y*px + x) * 3
			buf[o], buf[o+1], buf[o+2] = v, v, v
		}
	}
	return buf
}

func TestPDQStableAndSeparatesGradients(t *testing.T) {
	a := gradientRGB("x", 64)
	hex := PDQHex(a, 64)
	if hex != PDQHex(append([]byte(nil), a...), 64) || len(hex) != 64 {
		t.Fatalf("hash %q", hex)
	}
	if HammingHex(hex, PDQHex(gradientRGB("y", 64), 64)) <= 32 {
		t.Fatal("orthogonal gradients were too close")
	}
	flat := PDQHex(fillRGB(128, 64), 64)
	if len(flat) != 64 {
		t.Fatalf("flat %q", flat)
	}
	if XORAggregate([]string{"aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa"}) != "0000000000000000" {
		t.Fatal("xor of identical hashes")
	}
	if HammingHex("aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa") != 0 {
		t.Fatal("hamming of identical hashes")
	}
}

func TestAlignIdenticalAndPartial(t *testing.T) {
	same := []Frame{{0, "aaaa"}, {1, "bbbb"}, {2, "cccc"}}
	got := AlignHashSequences(context.Background(), same, same, 0)
	if got.Cancelled || got.CoverageA < 1 || got.CoverageB < 1 || got.MeanHamming != 0 {
		t.Fatalf("identical %+v", got)
	}
	parent := []Frame{{0, "0000"}, {1, "1111"}, {2, "aaaa"}, {3, "bbbb"}, {4, "ffff"}}
	clip := []Frame{{10, "aaaa"}, {11, "bbbb"}}
	part := AlignHashSequences(context.Background(), clip, parent, 0)
	if part.CoverageA < 1 || part.StartIndexB != 2 || part.OffsetBSec != 2 {
		t.Fatalf("partial %+v", part)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	stopped := AlignHashSequences(ctx, same, same, 0)
	if !stopped.Cancelled {
		t.Fatal("expected cancellation")
	}
	rights := make([][]Frame, 8)
	for i := range rights {
		rights[i] = same
	}
	if _, cancelled := parallelAlign(ctx, same, rights, 0); !cancelled {
		t.Fatal("parallel align kept running after cancel")
	}
}

func TestSimilarGroupsSkipExactHashAndPreferLargerFile(t *testing.T) {
	frames := map[int64][]Frame{
		1: {{0, "aaaa"}, {1, "bbbb"}, {2, "cccc"}, {3, "dddd"}},
		2: {{0, "aaaa"}, {1, "bbbb"}, {2, "cccc"}, {3, "dddd"}},
		3: {{0, "aaaa"}, {1, "bbbb"}, {2, "cccc"}, {3, "dddd"}},
	}
	videos := []Video{
		{ID: 1, DurationSec: 12, FileSize: 100, FileHash: "same"},
		{ID: 2, DurationSec: 12, FileSize: 50, FileHash: "same"},
		{ID: 3, DurationSec: 12, FileSize: 80, FileHash: "other"},
	}
	got := FindSimilarVideoGroups(context.Background(), videos, Defaults(), frames, map[string]bool{}, map[string]bool{}, map[int64]bool{}, nil, nil)
	if got.Cancelled || len(got.Groups) != 2 {
		t.Fatalf("groups %+v", got)
	}
	paired := map[string]bool{}
	var keptLarger bool
	for _, g := range got.Groups {
		if len(g.Members) != 2 {
			t.Fatalf("members %+v", g.Members)
		}
		paired[PairKey(g.Members[0].DownloadID, g.Members[1].DownloadID)] = true
		if g.Members[0].Role == "keep" && g.Members[0].DownloadID == 1 && g.Members[1].DownloadID == 3 {
			keptLarger = true
		}
	}
	if paired["1:2"] || !paired["1:3"] || !paired["2:3"] || !keptLarger {
		t.Fatalf("pairs %+v groups %+v", paired, got.Groups)
	}
	if !DurationsWithinTolerance(10, 11, 0.1) || DurationsWithinTolerance(10, 20, 0.1) {
		t.Fatal("duration tolerance")
	}
}

func TestPartialClipInsideLongerVideo(t *testing.T) {
	frames := map[int64][]Frame{
		1: {{0, "aaaa"}, {1, "bbbb"}, {2, "cccc"}, {3, "dddd"}},
		2: {{0, "0000"}, {1, "1111"}, {2, "aaaa"}, {3, "bbbb"}, {4, "cccc"}, {5, "dddd"}, {6, "eeee"}, {7, "ffff"}},
	}
	videos := []Video{
		{ID: 1, DurationSec: 8, FileSize: 10, FileName: "clip.mp4", FrameCount: 4},
		{ID: 2, DurationSec: 40, FileSize: 80, FileName: "full.mp4", FrameCount: 8},
	}
	cfg := Defaults()
	cfg.PartialMatchRatio = 0.5
	cfg.PartialReviewMinMatchedFrames = 2
	got := FindPartialClipGroups(context.Background(), videos, cfg, frames, map[string]bool{}, map[string]bool{}, map[int64]bool{}, map[int64]bool{}, nil, nil)
	if got.Cancelled || len(got.Groups) != 1 || got.Groups[0].Kind != "partial" {
		t.Fatalf("partial %+v", got)
	}
	if got.Groups[0].Members[0].DownloadID != 2 || got.Groups[0].Members[0].Role != "keep" {
		t.Fatalf("parent should be kept: %+v", got.Groups[0].Members)
	}
}

func TestPartialMatchesStayInParentOrderWhenParallel(t *testing.T) {
	h := func(c byte) string { return strings.Repeat(string(c), 64) }
	clip := []Frame{{0, h('0')}, {1, h('a')}, {2, h('5')}, {3, h('c')}}
	match := []Frame{{0, h('f')}, {1, h('f')}, {2, h('0')}, {3, h('a')}, {4, h('5')}, {5, h('c')}, {6, h('3')}, {7, h('3')}}
	other := []Frame{{0, h('f')}, {1, h('f')}, {2, h('f')}, {3, h('f')}, {4, h('3')}, {5, h('3')}, {6, h('3')}, {7, h('3')}}
	frames := map[int64][]Frame{1: clip}
	videos := []Video{{ID: 1, DurationSec: 8, FileSize: 10, FileName: "clip.mp4", FrameCount: len(clip)}}
	var want []int64
	for id := int64(2); id <= 9; id++ {
		parent := other
		if id == 4 || id == 7 {
			parent = match
			want = append(want, id)
		}
		frames[id] = parent
		videos = append(videos, Video{ID: id, DurationSec: 20 + float64(id)*10, FileSize: 80, FileName: "parent.mp4", FrameCount: len(parent)})
	}
	cfg := Defaults()
	cfg.PartialReviewMinMatchedFrames = 2
	got := FindPartialClipGroups(context.Background(), videos, cfg, frames, map[string]bool{}, map[string]bool{}, map[int64]bool{}, map[int64]bool{}, nil, nil)
	if got.Cancelled {
		t.Fatalf("cancelled %+v", got)
	}
	var gotIDs []int64
	for _, g := range got.Groups {
		if len(g.Members) != 2 || g.Members[1].DownloadID != 1 {
			continue
		}
		if g.Kind != "partial" || g.Members[0].Role != "keep" {
			t.Fatalf("clip group %+v", g)
		}
		gotIDs = append(gotIDs, g.Members[0].DownloadID)
	}
	if len(gotIDs) != len(want) {
		t.Fatalf("parents %v want %v", gotIDs, want)
	}
	for i, id := range want {
		if gotIDs[i] != id {
			t.Fatalf("parents %v want %v", gotIDs, want)
		}
	}
}

func TestConfigEnvOverridesStoredAndDropsLegacyFPS(t *testing.T) {
	t.Setenv("TGDL_SIMILAR_THRESHOLD", "12")
	cfg := Load(map[string]any{"similarThreshold": 80, "fingerprintFps": 2, "sceneThreshold": 0.4})
	if cfg.SimilarThreshold != 12 || cfg.SceneThreshold != 0.4 {
		t.Fatalf("config %+v", cfg)
	}
	if Defaults().AnalyzeKey() == "" {
		t.Fatal("empty analyze key")
	}
}

func TestShowinfoAndZip(t *testing.T) {
	pts := ParseShowinfoPts("n:0 pts_time:1.5\nn:1 pts_time:4")
	if len(pts) != 2 || pts[0] != 1.5 || pts[1] != 4 {
		t.Fatalf("pts %v", pts)
	}
	tile := 8
	raw := fillRGB(10, tile)
	raw = append(raw, fillRGB(200, tile)...)
	frames := ZipRawFrames(raw, []float64{1, 4}, tile)
	if len(frames) != 2 || frames[0].TSec != 1 || len(frames[0].Phash) != 64 {
		t.Fatalf("frames %+v", frames)
	}
	filter := BuildFingerprintFilter(3, 0.1, 64)
	if !strings.Contains(filter, "select=") || !strings.Contains(filter, "showinfo") || !strings.Contains(filter, "64:64") {
		t.Fatal(filter)
	}
}
