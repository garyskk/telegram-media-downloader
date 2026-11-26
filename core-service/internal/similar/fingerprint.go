package similar

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var ptsTime = regexp.MustCompile(`pts_time:\s*(-?\d+(?:\.\d+)?)`)

// BuildFingerprintFilter is the ffmpeg select graph: a scene change or the
// floor interval, scaled to a square RGB tile.
func BuildFingerprintFilter(floor, scene float64, tile int) string {
	if floor <= 0 {
		floor = 3
	}
	if scene < 0 {
		scene = 0.1
	}
	if tile < 8 {
		tile = 8
	}
	if tile > 64 {
		tile = 64
	}
	px := strconv.Itoa(tile)
	selectExpr := "isnan(prev_selected_t)+gte(t-prev_selected_t\\," + strconv.FormatFloat(floor, 'f', -1, 64) + ")+gt(scene\\," + strconv.FormatFloat(scene, 'f', -1, 64) + ")"
	return "select='" + selectExpr + "',scale=" + px + ":" + px + ":force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=" + px + ":" + px + ":(ow-iw)/2:(oh-ih)/2:black,format=rgb24,showinfo"
}

// ParseShowinfoPts reads pts_time values from ffmpeg showinfo stderr.
func ParseShowinfoPts(stderr string) []float64 {
	var out []float64
	for _, m := range ptsTime.FindAllStringSubmatch(stderr, -1) {
		if t, err := strconv.ParseFloat(m[1], 64); err == nil {
			out = append(out, t)
		}
	}
	return out
}

// ZipRawFrames hashes packed RGB24 frames in lockstep with showinfo timestamps.
func ZipRawFrames(buf []byte, pts []float64, tile int) []Frame {
	if tile < 8 {
		tile = 64
	}
	frameSize := tile * tile * 3
	if frameSize <= 0 || len(buf) < frameSize || len(pts) == 0 {
		return nil
	}
	n := len(buf) / frameSize
	if n > len(pts) {
		n = len(pts)
	}
	frames := make([]Frame, 0, n)
	for i := 0; i < n; i++ {
		slice := buf[i*frameSize : (i+1)*frameSize]
		frames = append(frames, Frame{TSec: pts[i], Phash: PDQHex(slice, tile)})
	}
	return frames
}

// GenerateFingerprint decodes one video into PDQ scene hashes. A missing
// ffmpeg binary returns ErrNoFFmpeg. The caller persists the frames.
func GenerateFingerprint(ctx context.Context, path string, cfg Config) (float64, []Frame, error) {
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		return 0, nil, ErrNoFFmpeg
	}
	probe, err := exec.LookPath("ffprobe")
	if err != nil {
		return 0, nil, ErrNoFFmpeg
	}
	duration, err := probeDuration(ctx, probe, path)
	if err != nil {
		return 0, nil, err
	}
	if duration <= 0 {
		return 0, nil, errors.New("fingerprint: no duration")
	}
	tile := cfg.FingerprintTilePx
	if tile < 32 {
		tile = 32
	}
	if tile > 64 {
		tile = 64
	}
	maxFrames := cfg.FingerprintMaxFrames
	if maxFrames < 1 {
		maxFrames = 7200
	}
	args := []string{"-hide_banner", "-loglevel", "info", "-i", path, "-an", "-vf", BuildFingerprintFilter(cfg.FloorIntervalSec, cfg.SceneThreshold, tile), "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"}
	timeout := time.Duration(duration * float64(time.Second))
	if timeout < 5*time.Minute {
		timeout = 5 * time.Minute
	}
	if timeout > time.Hour {
		timeout = time.Hour
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitWriter{buf: &stdout, max: maxFrames * tile * tile * 3}
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	if ctx.Err() != nil {
		return 0, nil, ctx.Err()
	}
	if runErr != nil && !errors.Is(runCtx.Err(), context.DeadlineExceeded) && stdout.Len() == 0 {
		msg := stderr.String()
		if len(msg) > 400 {
			msg = msg[len(msg)-400:]
		}
		return 0, nil, errors.New("ffmpeg: " + strings.TrimSpace(msg))
	}
	pts := ParseShowinfoPts(stderr.String())
	raw := stdout.Bytes()
	frameSize := tile * tile * 3
	if len(raw)/frameSize > maxFrames {
		raw = raw[:maxFrames*frameSize]
	}
	if len(pts) > maxFrames {
		pts = pts[:maxFrames]
	}
	frames := ZipRawFrames(raw, pts, tile)
	if len(frames) == 0 {
		return 0, nil, errors.New("fingerprint: pts/frame count mismatch or empty sample")
	}
	return duration, frames, nil
}

// ErrNoFFmpeg means the fingerprint runner cannot start.
var ErrNoFFmpeg = errors.New("ffmpeg not available")

func probeDuration(ctx context.Context, bin, path string) (float64, error) {
	cmd := exec.CommandContext(ctx, bin, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path)
	out, err := cmd.Output()
	if err != nil {
		return 0, err
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil || v <= 0 {
		return 0, nil
	}
	return v, nil
}

type limitWriter struct {
	buf *bytes.Buffer
	max int
}

func (w *limitWriter) Write(p []byte) (int, error) {
	if w.buf.Len() >= w.max {
		return len(p), nil
	}
	room := w.max - w.buf.Len()
	if len(p) > room {
		p = p[:room]
	}
	_, err := w.buf.Write(p)
	return len(p), err
}

// UnlinkLeftoverRaws removes leftover {id}.fp.raw sidecars under dir.
func UnlinkLeftoverRaws(dir string) (int, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".fp.raw") {
			continue
		}
		if os.Remove(dir+"/"+e.Name()) == nil {
			n++
		}
	}
	return n, nil
}
