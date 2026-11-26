package similar

import (
	"context"
	"math"
	"strconv"
)

const (
	aggregateGateMin   = 64
	defaultMinCoverage = 0.7
)

// Video is one fingerprinted download compared during Analyze.
type Video struct {
	ID            int64
	DurationSec   float64
	AggregateHash string
	FrameCount    int
	FileHash      string
	FileSize      int64
	FileName      string
}

// Member is one side of a similar or partial group.
type Member struct {
	DownloadID int64
	Role       string
	Reason     string
}

// Group is a pair the operator can keep, remove, or review.
type Group struct {
	Kind       string
	Confidence float64
	OffsetSec  float64
	HasOffset  bool
	Members    []Member
}

// MatchResult is one similar-video pass.
type MatchResult struct {
	Groups        []Group
	ComparedPairs int
	Cancelled     bool
}

func DurationsWithinTolerance(left, right, tolerance float64) bool {
	if math.IsNaN(left) || math.IsNaN(right) {
		return false
	}
	longer := left
	if right > longer {
		longer = right
	}
	if longer == 0 {
		return left == right
	}
	diff := left - right
	if diff < 0 {
		diff = -diff
	}
	return diff/longer <= tolerance
}

func DurationBucket(durationSec float64, bucketSec int) int {
	if durationSec < 0 || bucketSec <= 0 || math.IsNaN(durationSec) {
		return 0
	}
	return int(math.Floor(durationSec / float64(bucketSec)))
}

func PairKey(a, b int64) string {
	if a > b {
		a, b = b, a
	}
	return strconv.FormatInt(a, 10) + ":" + strconv.FormatInt(b, 10)
}

// FindSimilarVideoGroups pairs near-duplicate videos. Each video is compared
// only with earlier ids. skipLeft resumes a previous Analyze. ignored and
// existing pairs are "min:max" keys.
func FindSimilarVideoGroups(ctx context.Context, videos []Video, cfg Config, frames map[int64][]Frame, ignored, existing map[string]bool, skipLeft map[int64]bool, onProgress func(map[string]any), onLeft func(Video, []Group)) MatchResult {
	if ctx == nil {
		ctx = context.Background()
	}
	maxHamming := float64(cfg.SimilarThreshold)
	if maxHamming < 0 {
		maxHamming = 50
	}
	bucketSec := cfg.DurationBucketSec
	if bucketSec <= 0 {
		bucketSec = 120
	}
	list := append([]Video(nil), videos...)
	sortVideosByID(list)
	buckets := map[int][]Video{}
	for _, v := range list {
		b := DurationBucket(v.DurationSec, bucketSec)
		buckets[b] = append(buckets[b], v)
	}
	pending := make([]Video, 0, len(list))
	for _, v := range list {
		if !skipLeft[v.ID] {
			pending = append(pending, v)
		}
	}
	if onProgress != nil {
		onProgress(map[string]any{"stage": "matching", "processed": 0, "total": len(pending), "skipped": len(skipLeft), "comparedPairs": 0, "groups": 0})
	}
	var groups []Group
	compared := 0
	processed := 0
	for _, left := range pending {
		if ctx.Err() != nil {
			return MatchResult{Groups: groups, ComparedPairs: compared, Cancelled: true}
		}
		b0 := DurationBucket(left.DurationSec, bucketSec)
		neighbors := append(append(append([]Video{}, buckets[b0-1]...), buckets[b0]...), buckets[b0+1]...)
		var fresh []Group
		for _, right := range neighbors {
			if right.ID >= left.ID {
				continue
			}
			key := PairKey(left.ID, right.ID)
			if ignored[key] || existing[key] {
				continue
			}
			compared++
			if ctx.Err() != nil {
				return MatchResult{Groups: groups, ComparedPairs: compared, Cancelled: true}
			}
			if left.FileHash != "" && left.FileHash == right.FileHash {
				continue
			}
			if !DurationsWithinTolerance(left.DurationSec, right.DurationSec, cfg.DurationTolerance) {
				continue
			}
			framesA := frames[left.ID]
			framesB := frames[right.ID]
			if len(framesA) > 0 && len(framesA) == len(framesB) && aggregateTooFar(left.AggregateHash, right.AggregateHash, maxHamming) {
				continue
			}
			aligned := AlignHashSequences(ctx, framesA, framesB, maxHamming)
			if aligned.Cancelled || ctx.Err() != nil {
				return MatchResult{Groups: groups, ComparedPairs: compared, Cancelled: true}
			}
			if aligned.CoverageA < defaultMinCoverage || aligned.CoverageB < defaultMinCoverage {
				continue
			}
			if math.IsInf(aligned.MeanHamming, 0) || aligned.MeanHamming > maxHamming {
				continue
			}
			keep, remove := left, right
			if right.FileSize > left.FileSize || (right.FileSize == left.FileSize && right.ID < left.ID) {
				keep, remove = right, left
			}
			bits := 64.0
			sample := framesA
			if len(sample) == 0 {
				sample = framesB
			}
			if len(sample) > 0 && len(sample[0].Phash) >= 64 {
				bits = 256
			}
			group := Group{
				Kind:       "similar",
				Confidence: math.Max(0, 1-aligned.MeanHamming/bits),
				Members: []Member{
					{DownloadID: keep.ID, Role: "keep", Reason: "similar video; larger file (" + strconv.FormatInt(keep.FileSize, 10) + " bytes)"},
					{DownloadID: remove.ID, Role: "remove", Reason: "similar video; mean hamming " + strconv.FormatFloat(aligned.MeanHamming, 'f', 2, 64) + "; smaller file (" + strconv.FormatInt(remove.FileSize, 10) + " bytes)"},
				},
			}
			fresh = append(fresh, group)
			groups = append(groups, group)
			existing[key] = true
		}
		processed++
		if onLeft != nil {
			onLeft(left, fresh)
		}
		if onProgress != nil {
			onProgress(map[string]any{"stage": "matching", "processed": processed, "total": len(pending), "skipped": len(skipLeft), "comparedPairs": compared, "groups": len(groups)})
		}
	}
	return MatchResult{Groups: groups, ComparedPairs: compared}
}

func aggregateTooFar(a, b string, threshold float64) bool {
	if a == "" || b == "" {
		return false
	}
	dist := HammingHex(a, b)
	if dist < 0 {
		return false
	}
	cap := threshold * 4
	if cap < aggregateGateMin {
		cap = aggregateGateMin
	}
	return float64(dist) > cap
}

func sortVideosByID(list []Video) {
	for i := 1; i < len(list); i++ {
		v := list[i]
		j := i
		for j > 0 && list[j-1].ID > v.ID {
			list[j] = list[j-1]
			j--
		}
		list[j] = v
	}
}
