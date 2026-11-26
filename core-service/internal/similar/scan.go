package similar

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ScanResult is the summary stored as the last Scan run.
type ScanResult struct {
	Processed  int   `json:"processed"`
	Generated  int   `json:"generated"`
	Skipped    int   `json:"skipped"`
	Errored    int   `json:"errored"`
	DurationMs int64 `json:"durationMs"`
	Cancelled  bool  `json:"cancelled"`
	UpToDate   bool  `json:"upToDate"`
}

// Scan fingerprints videos whose stored hash is missing or stale.
func Scan(ctx context.Context, db *sql.DB, downloadsDir string, cfg Config, onProgress func(map[string]any)) (ScanResult, error) {
	started := time.Now()
	stats, err := ScanStats(ctx, db)
	if err != nil {
		return ScanResult{}, err
	}
	emit := func(stage string, s ScanResult) {
		if onProgress == nil {
			return
		}
		onProgress(map[string]any{"stage": stage, "processed": s.Processed, "total": stats.Missing, "generated": s.Generated, "skipped": s.Skipped, "errored": s.Errored})
	}
	var result ScanResult
	emit("start", result)
	if stats.Missing == 0 {
		emit("done", result)
		result.DurationMs = time.Since(started).Milliseconds()
		result.UpToDate = true
		result.Cancelled = ctx.Err() != nil
		return result, nil
	}
	cursor := int64(1<<62 - 1)
	lastEmit := time.Now()
	for {
		if ctx.Err() != nil {
			break
		}
		rows, err := PageScan(ctx, db, cursor, 100)
		if err != nil {
			return result, err
		}
		if len(rows) == 0 {
			break
		}
		for _, row := range rows {
			if ctx.Err() != nil {
				break
			}
			cursor = row.ID
			current, err := fingerprintCurrent(ctx, db, row)
			if err != nil {
				return result, err
			}
			if current {
				result.Skipped++
				result.Processed++
				continue
			}
			abs := resolveDownload(downloadsDir, row.Path)
			if abs == "" {
				result.Skipped++
				result.Processed++
				continue
			}
			duration, frames, err := GenerateFingerprint(ctx, abs, cfg)
			if err != nil {
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					break
				}
				result.Errored++
				result.Processed++
				continue
			}
			hash := ""
			if row.FileHash.Valid {
				hash = row.FileHash.String
			}
			if err = UpsertFingerprint(ctx, db, row.ID, duration, XORAggregate(phashes(frames)), len(frames), hash); err != nil {
				return result, err
			}
			if err = ReplaceFrames(ctx, db, row.ID, frames); err != nil {
				return result, err
			}
			result.Generated++
			result.Processed++
			if time.Since(lastEmit) >= time.Second {
				lastEmit = time.Now()
				emit("progress", result)
			}
		}
	}
	emit("done", result)
	result.DurationMs = time.Since(started).Milliseconds()
	result.Cancelled = ctx.Err() != nil
	result.UpToDate = result.Processed == 0 && result.Generated == 0
	return result, nil
}

func phashes(frames []Frame) []string {
	out := make([]string, len(frames))
	for i, f := range frames {
		out[i] = f.Phash
	}
	return out
}

func fingerprintCurrent(ctx context.Context, db *sql.DB, row ScanRow) (bool, error) {
	var algo, hash sql.NullString
	err := db.QueryRowContext(ctx, `SELECT algo, file_hash FROM video_fingerprints WHERE download_id=?`, row.ID).Scan(&algo, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !algo.Valid || algo.String != Algo {
		return false, nil
	}
	if row.FileHash.Valid && row.FileHash.String != "" {
		return hash.Valid && hash.String == row.FileHash.String, nil
	}
	return true, nil
}

func resolveDownload(root, stored string) string {
	if stored == "" {
		return ""
	}
	if filepath.IsAbs(stored) {
		if _, err := os.Stat(stored); err == nil {
			return stored
		}
	}
	s := strings.ReplaceAll(stored, "\\", "/")
	for strings.HasPrefix(s, "data/downloads/") {
		s = strings.TrimPrefix(s, "data/downloads/")
	}
	candidate := filepath.Join(root, filepath.FromSlash(s))
	if _, err := os.Stat(candidate); err == nil {
		return candidate
	}
	if _, err := os.Stat(stored); err == nil {
		return stored
	}
	return ""
}
