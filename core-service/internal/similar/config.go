// Package similar finds near-duplicate videos and shorter excerpts inside
// longer videos. Fingerprints use the scene-aware PDQ algorithm pdq-scene-v1.
package similar

import (
	"os"
	"strconv"
	"strings"
)

const Algo = "pdq-scene-v1"

// Config is the operator tuning for Scan and Analyze.
// Precedence is TGDL_SIMILAR_* environment, then stored advanced.similarClips,
// then these defaults. A stored legacy fingerprintFps value is ignored.
type Config struct {
	SimilarThreshold              int     `json:"similarThreshold"`
	DurationTolerance             float64 `json:"durationTolerance"`
	PartialMatchRatio             float64 `json:"partialMatchRatio"`
	PartialFrameThreshold         int     `json:"partialFrameThreshold"`
	PartialShortClipSec           int     `json:"partialShortClipSec"`
	PartialShortMatchRatio        float64 `json:"partialShortMatchRatio"`
	PartialReviewMatchRatio       float64 `json:"partialReviewMatchRatio"`
	PartialReviewMinMatchedFrames int     `json:"partialReviewMinMatchedFrames"`
	FingerprintMaxFrames          int     `json:"fingerprintMaxFrames"`
	FingerprintTilePx             int     `json:"fingerprintTilePx"`
	DurationBucketSec             int     `json:"durationBucketSec"`
	SceneThreshold                float64 `json:"sceneThreshold"`
	FloorIntervalSec              float64 `json:"floorIntervalSec"`
}

func Defaults() Config {
	return Config{
		SimilarThreshold:              50,
		DurationTolerance:             0.1,
		PartialMatchRatio:             0.5,
		PartialFrameThreshold:         90,
		PartialShortClipSec:           300,
		PartialShortMatchRatio:        0.5,
		PartialReviewMatchRatio:       0.35,
		PartialReviewMinMatchedFrames: 4,
		FingerprintMaxFrames:          7200,
		FingerprintTilePx:             64,
		DurationBucketSec:             120,
		SceneThreshold:                0.1,
		FloorIntervalSec:              3,
	}
}

func (c Config) AnalyzeKey() string {
	return Algo + "|" + strconv.Itoa(c.SimilarThreshold) + "|" + formatFloat(c.DurationTolerance) + "|" + strconv.Itoa(c.DurationBucketSec) + "|cov0.7"
}

func formatFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// Load merges stored advanced.similarClips with the environment.
func Load(stored map[string]any) Config {
	cfg := Defaults()
	applyStored(&cfg, stored)
	applyEnv(&cfg)
	return cfg
}

func applyStored(cfg *Config, stored map[string]any) {
	if stored == nil {
		return
	}
	setInt(&cfg.SimilarThreshold, stored["similarThreshold"])
	setFloat(&cfg.DurationTolerance, stored["durationTolerance"])
	setFloat(&cfg.PartialMatchRatio, stored["partialMatchRatio"])
	setInt(&cfg.PartialFrameThreshold, stored["partialFrameThreshold"])
	setInt(&cfg.PartialShortClipSec, stored["partialShortClipSec"])
	setFloat(&cfg.PartialShortMatchRatio, stored["partialShortMatchRatio"])
	setFloat(&cfg.PartialReviewMatchRatio, stored["partialReviewMatchRatio"])
	setInt(&cfg.PartialReviewMinMatchedFrames, stored["partialReviewMinMatchedFrames"])
	setInt(&cfg.FingerprintMaxFrames, stored["fingerprintMaxFrames"])
	setInt(&cfg.FingerprintTilePx, stored["fingerprintTilePx"])
	setInt(&cfg.DurationBucketSec, stored["durationBucketSec"])
	setFloat(&cfg.SceneThreshold, stored["sceneThreshold"])
	setFloat(&cfg.FloorIntervalSec, stored["floorIntervalSec"])
}

func applyEnv(cfg *Config) {
	envInt("TGDL_SIMILAR_THRESHOLD", &cfg.SimilarThreshold)
	envFloat("TGDL_SIMILAR_DURATION_TOLERANCE", &cfg.DurationTolerance)
	envFloat("TGDL_SIMILAR_PARTIAL_MATCH_RATIO", &cfg.PartialMatchRatio)
	envInt("TGDL_SIMILAR_PARTIAL_FRAME_THRESHOLD", &cfg.PartialFrameThreshold)
	envInt("TGDL_SIMILAR_PARTIAL_SHORT_CLIP_SEC", &cfg.PartialShortClipSec)
	envFloat("TGDL_SIMILAR_PARTIAL_SHORT_MATCH_RATIO", &cfg.PartialShortMatchRatio)
	envFloat("TGDL_SIMILAR_PARTIAL_REVIEW_MATCH_RATIO", &cfg.PartialReviewMatchRatio)
	envInt("TGDL_SIMILAR_PARTIAL_REVIEW_MIN_MATCHED_FRAMES", &cfg.PartialReviewMinMatchedFrames)
	envInt("TGDL_SIMILAR_FINGERPRINT_MAX_FRAMES", &cfg.FingerprintMaxFrames)
	envInt("TGDL_SIMILAR_FINGERPRINT_TILE_PX", &cfg.FingerprintTilePx)
	envInt("TGDL_SIMILAR_DURATION_BUCKET_SEC", &cfg.DurationBucketSec)
	envFloat("TGDL_SIMILAR_SCENE_THRESHOLD", &cfg.SceneThreshold)
	envFloat("TGDL_SIMILAR_FLOOR_INTERVAL_SEC", &cfg.FloorIntervalSec)
}

func setInt(dst *int, v any) {
	switch n := v.(type) {
	case float64:
		*dst = int(n)
	case int:
		*dst = n
	case int64:
		*dst = int(n)
	case string:
		if i, err := strconv.Atoi(strings.TrimSpace(n)); err == nil {
			*dst = i
		}
	}
}

func setFloat(dst *float64, v any) {
	switch n := v.(type) {
	case float64:
		*dst = n
	case int:
		*dst = float64(n)
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(n), 64); err == nil {
			*dst = f
		}
	}
}

func envInt(name string, dst *int) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return
	}
	if n, err := strconv.Atoi(raw); err == nil {
		*dst = n
	}
}

func envFloat(name string, dst *float64) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return
	}
	if n, err := strconv.ParseFloat(raw, 64); err == nil {
		*dst = n
	}
}
