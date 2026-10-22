package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/faststart"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

const faststartAutoKey = "faststart_auto"

// faststartAuto runs the streaming rewrite for each new download. Live
// downloads go ahead of history backfill. One drain keeps ffmpeg to a
// single file at a time.
type faststartAuto struct {
	mu       sync.Mutex
	realtime []int64
	backfill []int64
	queued   map[int64]bool
	draining bool
	stats    faststartAutoStats
}

type faststartAutoStats struct {
	Total      int    `json:"total"`
	Optimized  int    `json:"optimized"`
	Already    int    `json:"already"`
	Skipped    int    `json:"skipped"`
	Errored    int    `json:"errored"`
	LastAt     int64  `json:"lastAt,omitempty"`
	LastResult string `json:"lastResult,omitempty"`
	LastError  string `json:"lastError,omitempty"`
}

func newFaststartAuto() *faststartAuto {
	return &faststartAuto{queued: map[int64]bool{}}
}

func faststartName(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".mp4", ".m4v", ".mov", ".3gp":
		return true
	}
	return false
}

func (a *App) loadFaststartAuto(ctx context.Context) {
	raw, _ := a.kvGetJSON(ctx, faststartAutoKey).(map[string]any)
	if raw == nil || a.faststartAuto == nil {
		return
	}
	s := &a.faststartAuto.stats
	s.Total = jsonInt(raw["total"])
	s.Optimized = jsonInt(raw["optimized"])
	s.Already = jsonInt(raw["already"])
	s.Skipped = jsonInt(raw["skipped"])
	s.Errored = jsonInt(raw["errored"])
	s.LastAt = int64(jsonInt(raw["lastAt"]))
	s.LastResult, _ = raw["lastResult"].(string)
	s.LastError, _ = raw["lastError"].(string)
}

func jsonInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	default:
		return 0
	}
}

func (a *App) enqueueFaststart(id int64, realtime bool) {
	s := a.faststartAuto
	if s == nil || id <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.queued[id] {
		return
	}
	queue := &s.backfill
	if realtime {
		queue = &s.realtime
	}
	*queue = append(*queue, id)
	s.queued[id] = true
	if s.draining {
		return
	}
	done, ok := a.beginMaintenance()
	if !ok {
		s.realtime, s.backfill = nil, nil
		clear(s.queued)
		return
	}
	s.draining = true
	go func() {
		defer done()
		a.drainFaststart()
	}()
}

func (s *faststartAuto) pop() (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var id int64
	switch {
	case len(s.realtime) > 0:
		id, s.realtime = s.realtime[0], s.realtime[1:]
	case len(s.backfill) > 0:
		id, s.backfill = s.backfill[0], s.backfill[1:]
	default:
		s.draining = false
		return 0, false
	}
	delete(s.queued, id)
	return id, true
}

func (a *App) drainFaststart() {
	s := a.faststartAuto
	for {
		if a.ctx.Err() != nil {
			s.mu.Lock()
			s.realtime, s.backfill = nil, nil
			clear(s.queued)
			s.draining = false
			s.mu.Unlock()
			return
		}
		id, ok := s.pop()
		if !ok {
			return
		}
		a.optimizeDownload(a.ctx, id)
	}
}

func (a *App) optimizeDownload(ctx context.Context, id int64) {
	result, errMsg := a.rewriteDownload(ctx, id)
	if result == "" {
		return
	}
	a.noteFaststartAuto(result, errMsg)
	if a.hub == nil {
		return
	}
	payload := map[string]any{"id": id, "result": result}
	if errMsg != "" {
		payload["error"] = errMsg
	}
	a.hub.Broadcast(ws.Event{Type: "faststart_auto_done", Flat: true, Payload: payload})
}

func (a *App) rewriteDownload(ctx context.Context, id int64) (result, errMsg string) {
	var stored string
	err := a.db.Reader.QueryRowContext(ctx, `SELECT COALESCE(file_path,'') FROM downloads WHERE id=?`, id).Scan(&stored)
	if err != nil || !faststartName(stored) {
		return "skipped", ""
	}
	name := filepath.FromSlash(stored)
	if filepath.IsAbs(name) || !filepath.IsLocal(name) {
		return "skipped", ""
	}
	abs := filepath.Join(a.downloadsDir, name)
	if faststart.PlaybackReady(abs) {
		return "already", ""
	}
	status, size, err := faststart.Optimize(ctx, abs)
	if err != nil {
		if ctx.Err() != nil {
			return "", ""
		}
		msg := err.Error()
		if len(msg) > 200 {
			msg = msg[:200]
		}
		return "errored", msg
	}
	if status == "optimized" && size > 0 {
		_, _ = a.db.Writer.ExecContext(ctx, `UPDATE downloads SET file_size=? WHERE id=?`, size, id)
	}
	if status != "optimized" && status != "already" {
		return "skipped", ""
	}
	return status, ""
}

func (a *App) noteFaststartAuto(result, errMsg string) {
	s := a.faststartAuto
	s.mu.Lock()
	st := &s.stats
	st.Total++
	switch result {
	case "optimized":
		st.Optimized++
		st.LastError = ""
	case "already":
		st.Already++
	case "errored":
		st.Errored++
		st.LastError = errMsg
	default:
		st.Skipped++
		result = "skipped"
	}
	st.LastAt = time.Now().UnixMilli()
	st.LastResult = result
	saved := *st
	s.mu.Unlock()
	a.kvSetJSON(context.Background(), faststartAutoKey, saved)
}

func (a *App) faststartAutoView() (faststartAutoStats, bool) {
	if a.faststartAuto == nil {
		return faststartAutoStats{}, false
	}
	a.faststartAuto.mu.Lock()
	defer a.faststartAuto.mu.Unlock()
	return a.faststartAuto.stats, ffmpegAvailable()
}

func ffmpegAvailable() bool {
	if bin := strings.TrimSpace(os.Getenv("FFMPEG_PATH")); bin != "" {
		st, err := os.Stat(bin)
		return err == nil && !st.IsDir()
	}
	_, err := exec.LookPath("ffmpeg")
	return err == nil
}
