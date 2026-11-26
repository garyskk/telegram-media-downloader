package similar

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

// AnalyzeResult is the summary stored as the last Analyze run.
type AnalyzeResult struct {
	SimilarGroups       int   `json:"similarGroups"`
	ComparedPairs       int   `json:"comparedPairs"`
	Skipped             int   `json:"skipped"`
	UpToDate            bool  `json:"upToDate"`
	PartialGroups       int   `json:"partialGroups"`
	PartialReviewGroups int   `json:"partialReviewGroups"`
	PartialClipsScanned int   `json:"partialClipsScanned"`
	Cancelled           bool  `json:"cancelled"`
	CheckPartialClips   bool  `json:"checkPartialClips"`
	PartialSkipped      bool  `json:"partialSkipped"`
	DurationMs          int64 `json:"durationMs"`
}

// Analyze aligns stored fingerprints. Partial clips run only when requested.
// Stop keeps groups and cursors already written.
func Analyze(ctx context.Context, db *sql.DB, cfg Config, partial bool, onProgress func(map[string]any)) (AnalyzeResult, error) {
	started := nowMillis()
	done := func(extra AnalyzeResult) AnalyzeResult {
		extra.CheckPartialClips = partial
		if extra.DurationMs == 0 {
			extra.DurationMs = nowMillis() - started
		}
		return extra
	}
	videos, err := ListAnalyzeVideos(ctx, db)
	if err != nil {
		return AnalyzeResult{}, err
	}
	byID := map[int64]Video{}
	for _, v := range videos {
		byID[v.ID] = v
	}
	ignoredSimilar, err := IgnoreIDs(ctx, db, "similar")
	if err != nil {
		return AnalyzeResult{}, err
	}
	if ctx.Err() != nil {
		return done(AnalyzeResult{Cancelled: true, PartialSkipped: true}), nil
	}
	key := cfg.AnalyzeKey()
	scans, err := ListVideoScans(ctx, db)
	if err != nil {
		return AnalyzeResult{}, err
	}
	configChanged := false
	for _, s := range scans {
		if s.ConfigKey != key {
			configChanged = true
			break
		}
	}
	if configChanged {
		if err = ClearVideoScans(ctx, db); err != nil {
			return AnalyzeResult{}, err
		}
		if err = DeleteGroupsByKind(ctx, db, "similar"); err != nil {
			return AnalyzeResult{}, err
		}
		scans = nil
	}
	skipLeft := map[int64]bool{}
	if !configChanged {
		for _, s := range scans {
			video, ok := byID[s.DownloadID]
			hash := ""
			if s.FileHash.Valid {
				hash = s.FileHash.String
			}
			if ok && s.ConfigKey == key && s.Algo == Algo && s.FrameCount == video.FrameCount && hash == video.FileHash {
				skipLeft[s.DownloadID] = true
			} else if err = DeleteGroupsForDownload(ctx, db, s.DownloadID); err != nil {
				return AnalyzeResult{}, err
			}
		}
	}
	pendingSimilar := len(videos) - len(skipLeft)
	existingSimilar, err := ListGroups(ctx, db, "similar")
	if err != nil {
		return AnalyzeResult{}, err
	}
	if onProgress != nil && (pendingSimilar > 0 || !partial) {
		onProgress(map[string]any{"stage": "matching", "processed": 0, "total": pendingSimilar, "skipped": len(skipLeft), "groups": len(existingSimilar), "comparedPairs": 0})
	}
	existingPairs := map[string]bool{}
	for _, g := range existingSimilar {
		members, _ := g["members"].([]map[string]any)
		if k := PairKeyFromMembers(members); k != "" {
			existingPairs[k] = true
		}
	}
	frames := map[int64][]Frame{}
	inserted, compared := 0, 0
	cancelled := false
	if pendingSimilar > 0 {
		ids := similarHashIDs(videos, skipLeft, cfg.DurationBucketSec)
		frames, err = FramesFor(ctx, db, ids)
		if err != nil {
			return AnalyzeResult{}, err
		}
		matched := FindSimilarVideoGroups(ctx, videos, cfg, frames, ignoredSimilar, existingPairs, skipLeft, func(p map[string]any) {
			if onProgress != nil {
				p["skipped"] = len(skipLeft)
				onProgress(p)
			}
		}, func(left Video, groups []Group) {
			for _, g := range groups {
				if err == nil {
					err = InsertGroup(ctx, db, g)
					inserted++
				}
			}
			n := len(frames[left.ID])
			if n == 0 {
				n = left.FrameCount
			}
			if err == nil {
				err = UpsertVideoScan(ctx, db, left, n, key)
			}
		})
		if err != nil {
			return AnalyzeResult{}, err
		}
		compared = matched.ComparedPairs
		cancelled = matched.Cancelled
	}
	if cancelled || ctx.Err() != nil {
		return done(AnalyzeResult{SimilarGroups: inserted, ComparedPairs: compared, Skipped: len(skipLeft), Cancelled: true, PartialSkipped: true}), nil
	}
	if !partial {
		return done(AnalyzeResult{SimilarGroups: inserted, ComparedPairs: compared, Skipped: len(skipLeft), UpToDate: pendingSimilar == 0, PartialSkipped: true}), nil
	}
	return analyzePartial(ctx, db, cfg, videos, byID, frames, inserted, compared, pendingSimilar, len(skipLeft), onProgress, done)
}

func analyzePartial(ctx context.Context, db *sql.DB, cfg Config, videos []Video, byID map[int64]Video, frames map[int64][]Frame, inserted, compared, pendingSimilar, skipped int, onProgress func(map[string]any), done func(AnalyzeResult) AnalyzeResult) (AnalyzeResult, error) {
	partialGroups, err := ListGroups(ctx, db, "partial")
	if err != nil {
		return AnalyzeResult{}, err
	}
	reviewGroups, err := ListGroups(ctx, db, "partial_review")
	if err != nil {
		return AnalyzeResult{}, err
	}
	existing := append(partialGroups, reviewGroups...)
	ignored, err := IgnoreIDs(ctx, db, "partial")
	if err != nil {
		return AnalyzeResult{}, err
	}
	reviewIgnored, err := IgnoreIDs(ctx, db, "partial_review")
	if err != nil {
		return AnalyzeResult{}, err
	}
	for k, v := range reviewIgnored {
		ignored[k] = v
	}
	blocked := map[string]bool{}
	for k, v := range ignored {
		blocked[k] = v
	}
	skipDetected := map[int64]bool{}
	for _, g := range existing {
		members, _ := g["members"].([]map[string]any)
		key := PairKeyFromMembers(members)
		if key != "" {
			blocked[key] = true
		}
		if ignored[key] {
			continue
		}
		for _, m := range members {
			role, _ := m["role"].(string)
			if role == "remove" || role == "review" {
				skipDetected[int64From(m["download_id"])] = true
			}
		}
	}
	scans, err := ListPartialScans(ctx, db)
	if err != nil {
		return AnalyzeResult{}, err
	}
	skipScanned := map[int64]bool{}
	for _, row := range scans {
		if video, ok := byID[row.DownloadID]; ok && video.FrameCount == row.FrameCount {
			skipScanned[row.DownloadID] = true
		}
	}
	skipClip := map[int64]bool{}
	for id := range skipDetected {
		skipClip[id] = true
	}
	for id := range skipScanned {
		skipClip[id] = true
	}
	pendingPartial := 0
	for _, v := range videos {
		if !skipClip[v.ID] && v.FrameCount >= PartialMinClipFrames {
			pendingPartial++
		}
	}
	if onProgress != nil {
		onProgress(map[string]any{"stage": "partial", "processed": 0, "total": pendingPartial, "skipped": len(skipClip), "groups": len(existing)})
	}
	if pendingPartial == 0 {
		return done(AnalyzeResult{SimilarGroups: inserted, ComparedPairs: compared, Skipped: skipped, UpToDate: pendingSimilar == 0}), nil
	}
	ids := partialHashIDs(videos, skipClip)
	more, err := FramesFor(ctx, db, ids)
	if err != nil {
		return AnalyzeResult{}, err
	}
	for id, list := range more {
		frames[id] = list
	}
	partialN, reviewN := 0, 0
	result := FindPartialClipGroups(ctx, videos, cfg, frames, ignored, blocked, skipClip, skipDetected, func(p map[string]any) {
		if onProgress != nil {
			p["skipped"] = len(skipClip)
			onProgress(p)
		}
	}, func(clip Video, groups []Group, n int) {
		for _, g := range groups {
			if err == nil {
				err = InsertGroup(ctx, db, g)
			}
			if g.Kind == "partial_review" {
				reviewN++
			} else {
				partialN++
			}
		}
		if err == nil {
			err = UpsertPartialScan(ctx, db, clip.ID, n)
		}
	})
	if err != nil {
		return AnalyzeResult{}, err
	}
	return done(AnalyzeResult{
		SimilarGroups: inserted, ComparedPairs: compared, Skipped: skipped,
		UpToDate:      pendingSimilar == 0 && pendingPartial == 0,
		PartialGroups: partialN, PartialReviewGroups: reviewN, PartialClipsScanned: result.ClipsScanned,
		Cancelled: result.Cancelled || ctx.Err() != nil,
	}), nil
}

func similarHashIDs(videos []Video, skip map[int64]bool, bucket int) []int64 {
	var pending []Video
	for _, v := range videos {
		if !skip[v.ID] {
			pending = append(pending, v)
		}
	}
	if len(pending) == 0 {
		return nil
	}
	buckets := map[int][]Video{}
	for _, v := range videos {
		b := DurationBucket(v.DurationSec, bucket)
		buckets[b] = append(buckets[b], v)
	}
	seen := map[int64]bool{}
	var ids []int64
	add := func(id int64) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, left := range pending {
		add(left.ID)
		b0 := DurationBucket(left.DurationSec, bucket)
		for _, right := range append(append(append([]Video{}, buckets[b0-1]...), buckets[b0]...), buckets[b0+1]...) {
			if right.ID < left.ID {
				add(right.ID)
			}
		}
	}
	return ids
}

func partialHashIDs(videos []Video, skip map[int64]bool) []int64 {
	var pending []Video
	for _, v := range videos {
		if !skip[v.ID] {
			pending = append(pending, v)
		}
	}
	if len(pending) == 0 {
		return nil
	}
	seen := map[int64]bool{}
	var ids []int64
	add := func(id int64) {
		if id > 0 && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, clip := range pending {
		add(clip.ID)
		for _, other := range videos {
			if other.ID == clip.ID {
				continue
			}
			if other.DurationSec+1e-9 >= clip.DurationSec {
				add(other.ID)
			}
			if skip[other.ID] && other.DurationSec-1e-9 <= clip.DurationSec {
				add(other.ID)
			}
		}
	}
	return ids
}

func nowMillis() int64 { return time.Now().UnixMilli() }

// MarshalResult encodes a run summary for the kv last-run row.
func MarshalResult(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(raw)
}
