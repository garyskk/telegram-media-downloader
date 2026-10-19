package similar

import (
	"context"
	"math"
	"strconv"
)

const PartialMinClipFrames = 4

func EffectivePartialMatchRatio(clipDuration float64, cfg Config) float64 {
	if !math.IsNaN(clipDuration) && clipDuration <= float64(cfg.PartialShortClipSec) {
		return cfg.PartialShortMatchRatio
	}
	return cfg.PartialMatchRatio
}

type subMatch struct {
	Ratio     float64
	Start     int
	Matched   int
	OffsetSec float64
	Cancelled bool
}

func bestSubsequence(ctx context.Context, clip, parent []Frame, frameThreshold float64) subMatch {
	if len(clip) == 0 || len(parent) == 0 || len(clip) > len(parent) {
		return subMatch{}
	}
	r := AlignHashSequences(ctx, clip, parent, frameThreshold)
	if r.Cancelled {
		return subMatch{Cancelled: true}
	}
	start := r.StartIndexB
	if start < 0 {
		start = 0
	}
	offset := 0.0
	if r.HasOffset {
		offset = r.OffsetBSec
	}
	return subMatch{Ratio: r.CoverageA, Start: start, Matched: r.Matched, OffsetSec: offset}
}

func parentCandidates(clip Video, sorted []Video, bucketSec int) []Video {
	if bucketSec <= 0 {
		bucketSec = 120
	}
	minDur := clip.DurationSec
	if math.IsNaN(minDur) {
		return nil
	}
	minBucket := DurationBucket(minDur, bucketSec)
	start := 0
	for start < len(sorted) && sorted[start].DurationSec+1e-9 < minDur {
		start++
	}
	out := make([]Video, 0, len(sorted)-start)
	for i := start; i < len(sorted); i++ {
		parent := sorted[i]
		if parent.ID == clip.ID || math.IsNaN(parent.DurationSec) {
			continue
		}
		if DurationBucket(parent.DurationSec, bucketSec) < minBucket {
			continue
		}
		out = append(out, parent)
	}
	return out
}

func strictlyLonger(parent, clip Video) bool {
	return parent.DurationSec > clip.DurationSec+1e-9
}

func proposal(clip, parent Video, kind string, ratio float64, matched, clipFrames int, offset float64) Group {
	keep, remove := clip, parent
	if DurationsWithinTolerance(clip.DurationSec, parent.DurationSec, 0.1) {
		if parent.FileSize > clip.FileSize || (parent.FileSize == clip.FileSize && parent.ID < clip.ID) {
			keep, remove = parent, clip
		}
	} else if clip.DurationSec < parent.DurationSec {
		keep, remove = parent, clip
	}
	offsetNote := "offset " + strconv.FormatFloat(offset, 'f', 1, 64) + "s"
	pct := strconv.FormatFloat(ratio*100, 'f', 0, 64)
	frames := strconv.Itoa(matched) + "/" + strconv.Itoa(clipFrames)
	var keepReason, removeReason string
	same := DurationsWithinTolerance(clip.DurationSec, parent.DurationSec, 0.1)
	label := keep.FileName
	if label == "" {
		label = strconv.FormatInt(keep.ID, 10)
	}
	switch {
	case same:
		keepReason = "same-length re-encode; matched " + frames + " frames (" + offsetNote + ")"
		removeReason = "re-encoded copy of " + label + "; match ratio " + pct + "% (" + offsetNote + ")"
	case kind == "partial_review":
		keepReason = "possible parent; matched " + frames + " frames from " + offsetNote + " (below auto-remove threshold)"
		removeReason = "possible clip of " + label + "; match ratio " + pct + "% at " + offsetNote + " — manual review"
	default:
		keepReason = "contains clip; matched " + frames + " frames from " + offsetNote
		removeReason = "partial clip of " + label + "; match ratio " + pct + "% at " + offsetNote
	}
	role := "remove"
	if kind == "partial_review" {
		role = "review"
	}
	return Group{
		Kind: kind, Confidence: ratio, OffsetSec: offset, HasOffset: true,
		Members: []Member{
			{DownloadID: keep.ID, Role: "keep", Reason: keepReason},
			{DownloadID: remove.ID, Role: role, Reason: removeReason},
		},
	}
}

// PartialResult is one partial-clip pass.
type PartialResult struct {
	Groups       []Group
	ClipsScanned int
	Cancelled    bool
}

// FindPartialClipGroups aligns shorter sequences inside same-or-longer parents.
// skipClip skips clips already scanned. skipDetected skips clips already grouped
// as remove/review. A new longer parent still rechecks scanned shorter clips.
func FindPartialClipGroups(ctx context.Context, videos []Video, cfg Config, frames map[int64][]Frame, ignored, blocked map[string]bool, skipClip, skipDetected map[int64]bool, onProgress func(map[string]any), onClip func(Video, []Group, int)) PartialResult {
	if ctx == nil {
		ctx = context.Background()
	}
	bucket := cfg.DurationBucketSec
	if bucket <= 0 {
		bucket = 120
	}
	sorted := append([]Video(nil), videos...)
	sortByDuration(sorted)
	var clips []Video
	for _, v := range videos {
		if len(frames[v.ID]) >= PartialMinClipFrames {
			clips = append(clips, v)
		}
	}
	var pending []Video
	pendingIDs := map[int64]bool{}
	for _, v := range clips {
		if !skipClip[v.ID] {
			pending = append(pending, v)
			pendingIDs[v.ID] = true
		}
	}
	var recheck []Video
	for _, clip := range clips {
		if !skipClip[clip.ID] || skipDetected[clip.ID] {
			continue
		}
		for _, p := range pending {
			if strictlyLonger(p, clip) {
				recheck = append(recheck, clip)
				break
			}
		}
	}
	total := len(pending) + len(recheck)
	if onProgress != nil {
		onProgress(map[string]any{"stage": "partial", "processed": 0, "total": total, "skipped": len(skipClip), "groups": 0})
	}
	var groups []Group
	scanned, processed := 0, 0
	finish := func(clip Video, found []Group, mark bool) bool {
		groups = append(groups, found...)
		scanned++
		if mark {
			skipClip[clip.ID] = true
		}
		if onClip != nil {
			onClip(clip, found, len(frames[clip.ID]))
		}
		processed++
		if onProgress != nil {
			onProgress(map[string]any{"stage": "partial", "processed": processed, "total": total, "skipped": len(skipClip), "clipsScanned": scanned, "groups": len(groups)})
		}
		return ctx.Err() != nil
	}
	match := func(clip Video, parents []Video) ([]Group, bool) {
		clipFrames := frames[clip.ID]
		required := EffectivePartialMatchRatio(clip.DurationSec, cfg)
		var found []Group
		var best *struct {
			parent  Video
			ratio   float64
			matched int
			offset  float64
		}
		compared := 0
		for _, parent := range parents {
			key := PairKey(clip.ID, parent.ID)
			if ignored[key] || blocked[key] {
				continue
			}
			if clip.FileHash != "" && clip.FileHash == parent.FileHash {
				continue
			}
			if DurationsWithinTolerance(clip.DurationSec, parent.DurationSec, cfg.DurationTolerance) {
				continue
			}
			compared++
			if compared%50 == 0 && ctx.Err() != nil {
				return found, true
			}
			parentFrames := frames[parent.ID]
			if len(clipFrames) > len(parentFrames) {
				continue
			}
			got := bestSubsequence(ctx, clipFrames, parentFrames, float64(cfg.PartialFrameThreshold))
			if got.Cancelled || ctx.Err() != nil {
				return found, true
			}
			offset := got.OffsetSec
			if got.Matched < cfg.PartialReviewMinMatchedFrames {
				continue
			}
			if got.Ratio >= required {
				found = append(found, proposal(clip, parent, "partial", got.Ratio, got.Matched, len(clipFrames), offset))
				blocked[key] = true
				continue
			}
			if got.Ratio < cfg.PartialReviewMatchRatio {
				continue
			}
			if best == nil || got.Ratio > best.ratio {
				best = &struct {
					parent  Video
					ratio   float64
					matched int
					offset  float64
				}{parent, got.Ratio, got.Matched, offset}
			}
		}
		if len(found) == 0 && best != nil {
			key := PairKey(clip.ID, best.parent.ID)
			if !ignored[key] && !blocked[key] {
				found = append(found, proposal(clip, best.parent, "partial_review", best.ratio, best.matched, len(clipFrames), best.offset))
				blocked[key] = true
			}
		}
		return found, false
	}
	for _, clip := range recheck {
		if ctx.Err() != nil {
			return PartialResult{Groups: groups, ClipsScanned: scanned, Cancelled: true}
		}
		var parents []Video
		for _, p := range parentCandidates(clip, sorted, bucket) {
			if pendingIDs[p.ID] && strictlyLonger(p, clip) {
				parents = append(parents, p)
			}
		}
		found, cancelled := match(clip, parents)
		if cancelled {
			return PartialResult{Groups: groups, ClipsScanned: scanned, Cancelled: true}
		}
		if finish(clip, found, false) {
			return PartialResult{Groups: groups, ClipsScanned: scanned, Cancelled: true}
		}
	}
	for _, clip := range pending {
		if ctx.Err() != nil {
			return PartialResult{Groups: groups, ClipsScanned: scanned, Cancelled: true}
		}
		found, cancelled := match(clip, parentCandidates(clip, sorted, bucket))
		if cancelled {
			return PartialResult{Groups: groups, ClipsScanned: scanned, Cancelled: true}
		}
		if finish(clip, found, true) {
			return PartialResult{Groups: groups, ClipsScanned: scanned, Cancelled: true}
		}
	}
	return PartialResult{Groups: groups, ClipsScanned: scanned}
}

func sortByDuration(list []Video) {
	for i := 1; i < len(list); i++ {
		v := list[i]
		j := i
		for j > 0 && (list[j-1].DurationSec > v.DurationSec || (list[j-1].DurationSec == v.DurationSec && list[j-1].ID > v.ID)) {
			list[j] = list[j-1]
			j--
		}
		list[j] = v
	}
}
