package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/similar"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

type similarJobs struct {
	mu        sync.Mutex
	scan      similarSlot
	analyze   similarSlot
	fp        chan int64
	fpStarted bool
}

type similarSlot struct {
	running bool
	cancel  context.CancelFunc
	status  map[string]any
}

func newSimilarJobs() *similarJobs {
	return &similarJobs{
		scan:    similarSlot{status: similarIdle()},
		analyze: similarSlot{status: similarIdle()},
		fp:      make(chan int64, 200),
	}
}

func similarIdle() map[string]any {
	return map[string]any{"running": false, "stage": "idle", "progress": map[string]any{}, "result": nil, "error": nil, "startedAt": int64(0), "finishedAt": int64(0)}
}

func registerSimilarRoutes(mux *http.ServeMux, a *App) {
	admin := func(pattern string, fn http.HandlerFunc) {
		mux.Handle(pattern, a.requireAdmin(fn))
	}
	admin("POST /api/maintenance/similar/scan", a.handleSimilarScan)
	admin("POST /api/maintenance/similar/scan/stop", a.handleSimilarScanStop)
	admin("GET /api/maintenance/similar/status", a.handleSimilarStatus)
	admin("GET /api/maintenance/similar/stats", a.handleSimilarStats)
	admin("POST /api/maintenance/similar/analyze", a.handleSimilarAnalyze)
	admin("POST /api/maintenance/similar/analyze/stop", a.handleSimilarAnalyzeStop)
	admin("GET /api/maintenance/similar/groups", a.handleSimilarGroups)
	admin("POST /api/maintenance/similar/delete", a.handleSimilarDelete)
	admin("POST /api/maintenance/similar/ignore", a.handleSimilarIgnore)
	admin("GET /api/maintenance/similar/ignore", a.handleSimilarIgnoreList)
	admin("DELETE /api/maintenance/similar/ignore/{id}", a.handleSimilarIgnoreDelete)
	admin("POST /api/maintenance/similar/purge", a.handleSimilarPurge)
	admin("POST /api/maintenance/similar/analyze/purge", a.handleSimilarAnalyzePurge)
}

func (a *App) similarConfig(ctx context.Context) similar.Config {
	cfg, err := a.config.Load(ctx)
	if err != nil {
		return similar.Load(nil)
	}
	adv, _ := cfg["advanced"].(map[string]any)
	stored, _ := adv["similarClips"].(map[string]any)
	return similar.Load(stored)
}

func (a *App) handleSimilarScan(w http.ResponseWriter, r *http.Request) {
	if !a.startSimilar("scan", "similar_progress", "similar_done", "similar_last_scan", "pending_job_similarScan", func(ctx context.Context, progress func(map[string]any)) (any, error) {
		return similar.Scan(ctx, a.db.Writer, a.downloadsDir, a.similarConfig(ctx), progress)
	}) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "similar scan is already running", "code": "ALREADY_RUNNING"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"started": true})
}

func (a *App) handleSimilarScanStop(w http.ResponseWriter, _ *http.Request) {
	a.stopSimilar("scan")
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleSimilarAnalyze(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CheckPartialClips bool `json:"checkPartialClips"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body)
	}
	partial := body.CheckPartialClips
	if !a.startSimilar("analyze", "similar_analyze_progress", "similar_analyze_done", "similar_last_analyze", "pending_job_similarAnalyze", func(ctx context.Context, progress func(map[string]any)) (any, error) {
		return similar.Analyze(ctx, a.db.Writer, a.similarConfig(ctx), partial, progress)
	}) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "similar analyze is already running", "code": "ALREADY_RUNNING"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"started": true})
}

func (a *App) handleSimilarAnalyzeStop(w http.ResponseWriter, _ *http.Request) {
	a.stopSimilar("analyze")
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleSimilarStatus(w http.ResponseWriter, _ *http.Request) {
	a.similarJobs.mu.Lock()
	scan := similarSnapshot(&a.similarJobs.scan)
	analyze := similarSnapshot(&a.similarJobs.analyze)
	a.similarJobs.mu.Unlock()
	scan["analyze"] = analyze
	writeJSON(w, http.StatusOK, scan)
}

// similarSnapshot copies the slot under the jobs lock. running comes from the
// bool, so a progress map cannot report a live job as idle.
func similarSnapshot(slot *similarSlot) map[string]any {
	out, _ := cloneConfigValue(slot.status).(map[string]any)
	if out == nil {
		out = similarIdle()
	}
	out["running"] = slot.running
	if _, ok := out["progress"].(map[string]any); !ok {
		out["progress"] = map[string]any{}
	}
	return out
}

func (a *App) handleSimilarStats(w http.ResponseWriter, r *http.Request) {
	stats, err := similar.ScanStats(r.Context(), a.db.Reader)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true, "totalVideos": stats.TotalVideos, "fingerprinted": stats.Fingerprinted, "missing": stats.Missing,
		"lastScan": a.similarKV(r.Context(), "similar_last_scan"), "lastAnalyze": a.similarKV(r.Context(), "similar_last_analyze"),
	})
}

func (a *App) similarKV(ctx context.Context, key string) any {
	raw, ok, err := similar.GetKV(ctx, a.db.Reader, key)
	if err != nil || !ok || raw == "" || raw == "null" {
		return nil
	}
	var v any
	if json.Unmarshal([]byte(raw), &v) != nil {
		return nil
	}
	return v
}

func (a *App) handleSimilarGroups(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	if kind != "" && kind != "similar" && kind != "partial" && kind != "partial_review" {
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "groups": []any{}})
		return
	}
	groups, err := similar.ListGroups(r.Context(), a.db.Writer, kind)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "groups": groups})
}

func (a *App) handleSimilarDelete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if decodeBody(w, r, &body) != nil {
		return
	}
	var ids []int64
	for _, id := range body.IDs {
		if id > 0 {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		writeJSONError(w, http.StatusBadRequest, "ids array required")
		return
	}
	n, err := a.deleteRows(r, ids, nil)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.hub.Broadcast(ws.Event{Type: "bulk_delete", Flat: true, Payload: map[string]any{"count": n}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "removed": n})
}

func (a *App) handleSimilarIgnore(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AID  int64  `json:"aId"`
		BID  int64  `json:"bId"`
		Kind string `json:"kind"`
		Note string `json:"note"`
	}
	if decodeBody(w, r, &body) != nil {
		return
	}
	if body.Kind == "" {
		body.Kind = "similar"
	}
	id, err := similar.AddIgnore(r.Context(), a.db.Writer, body.AID, body.BID, body.Kind, body.Note)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": id})
}

func (a *App) handleSimilarIgnoreList(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	rows, err := similar.ListIgnores(r.Context(), a.db.Reader, kind)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "ignores": rows})
}

func (a *App) handleSimilarIgnoreDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid id")
		return
	}
	ok, err := similar.DeleteIgnore(r.Context(), a.db.Writer, id)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		writeJSONError(w, http.StatusNotFound, "ignore not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleSimilarPurge(w http.ResponseWriter, r *http.Request) {
	if a.similarBusy() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "A similar Scan or Analyze is already running. Cancel it before purging records.", "code": "ALREADY_RUNNING"})
		return
	}
	counts, err := similar.PurgeRecords(r.Context(), a.db.Writer)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	raws, _ := similar.UnlinkLeftoverRaws(filepath.Join(a.dataDir, "seekbar"))
	a.hub.Broadcast(ws.Event{Type: "similar_purged", Flat: true, Payload: map[string]any{"ts": time.Now().UnixMilli()}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "leftoverRaws": raws, "fingerprints": counts["fingerprints"], "groups": counts["groups"], "partialScans": counts["partialScans"]})
}

func (a *App) handleSimilarAnalyzePurge(w http.ResponseWriter, r *http.Request) {
	if a.similarBusy() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "A similar Scan or Analyze is already running. Cancel it before purging Analyze records.", "code": "ALREADY_RUNNING"})
		return
	}
	counts, err := similar.PurgeAnalyze(r.Context(), a.db.Writer)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.hub.Broadcast(ws.Event{Type: "similar_purged", Flat: true, Payload: map[string]any{"ts": time.Now().UnixMilli(), "scope": "analyze"}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "groups": counts["groups"], "videoScans": counts["videoScans"], "partialScans": counts["partialScans"]})
}

func (a *App) similarBusy() bool {
	a.similarJobs.mu.Lock()
	defer a.similarJobs.mu.Unlock()
	return a.similarJobs.scan.running || a.similarJobs.analyze.running
}

func (a *App) slot(name string) *similarSlot {
	if name == "analyze" {
		return &a.similarJobs.analyze
	}
	return &a.similarJobs.scan
}

func (a *App) startSimilar(name, progressEvent, doneEvent, lastKey, pendingKey string, run func(context.Context, func(map[string]any)) (any, error)) bool {
	a.similarJobs.mu.Lock()
	slot := a.slot(name)
	if slot.running {
		a.similarJobs.mu.Unlock()
		return false
	}
	ctx, cancel := context.WithCancel(a.ctx)
	slot.running = true
	slot.cancel = cancel
	slot.status = similarIdle()
	slot.status["running"] = true
	slot.status["stage"] = "start"
	slot.status["startedAt"] = time.Now().UnixMilli()
	a.similarJobs.mu.Unlock()
	a.logSimilar("info", "%s starting", name)
	_ = similar.PutKV(a.ctx, a.db.Writer, pendingKey, similar.MarshalResult(map[string]any{"startedAt": time.Now().UnixMilli()}))
	go func() {
		progress := func(p map[string]any) {
			a.similarJobs.mu.Lock()
			var event map[string]any
			if slot.running {
				// Copy before return. The caller may reuse or clear p, and the
				// hub marshals the queued event later.
				incoming, _ := cloneConfigValue(p).(map[string]any)
				if incoming == nil {
					incoming = map[string]any{}
				}
				delete(incoming, "running")
				merged := map[string]any{}
				if prev, ok := slot.status["progress"].(map[string]any); ok {
					for k, v := range prev {
						if k != "running" {
							merged[k] = v
						}
					}
				}
				for k, v := range incoming {
					merged[k] = v
				}
				slot.status["progress"] = merged
				slot.status["running"] = true
				if stage, ok := merged["stage"].(string); ok && stage != "" {
					slot.status["stage"] = stage
				}
				event = similarSnapshot(slot)
				for k, v := range merged {
					if k == "running" || k == "progress" || k == "analyze" {
						continue
					}
					event[k] = v
				}
				event["running"] = true
			}
			a.similarJobs.mu.Unlock()
			if event != nil {
				a.hub.Broadcast(ws.Event{Type: progressEvent, Flat: true, Payload: event})
			}
		}
		result, err := run(ctx, progress)
		finished := time.Now().UnixMilli()
		a.similarJobs.mu.Lock()
		slot.running = false
		slot.cancel = nil
		slot.status["running"] = false
		slot.status["finishedAt"] = finished
		if err != nil && !errors.Is(err, context.Canceled) {
			slot.status["error"] = err.Error()
			slot.status["stage"] = "error"
		} else {
			slot.status["stage"] = "done"
			slot.status["result"] = result
			slot.status["error"] = nil
		}
		a.similarJobs.mu.Unlock()
		_ = similar.PutKV(a.ctx, a.db.Writer, pendingKey, "null")
		if err == nil || errors.Is(err, context.Canceled) {
			raw := similar.MarshalResult(result)
			var merged map[string]any
			_ = json.Unmarshal([]byte(raw), &merged)
			if merged == nil {
				merged = map[string]any{}
			}
			merged["finishedAt"] = finished
			_ = similar.PutKV(a.ctx, a.db.Writer, lastKey, similar.MarshalResult(merged))
		}
		payload := map[string]any{"finishedAt": finished, "error": nil}
		if err != nil && !errors.Is(err, context.Canceled) {
			payload["error"] = err.Error()
		}
		if result != nil {
			encoded, _ := json.Marshal(result)
			_ = json.Unmarshal(encoded, &payload)
			payload["finishedAt"] = finished
		}
		a.logSimilarResult(name, result, err)
		a.hub.Broadcast(ws.Event{Type: doneEvent, Flat: true, Payload: payload})
	}()
	return true
}

func (a *App) stopSimilar(name string) {
	a.similarJobs.mu.Lock()
	slot := a.slot(name)
	cancel := slot.cancel
	a.similarJobs.mu.Unlock()
	if cancel != nil {
		a.logSimilar("info", "%s stopping", name)
		cancel()
	}
}

// logSimilar records one Similar clips line. Stdout keeps the [similar]
// prefix used by the other maintenance helpers. The same line is broadcast
// on the admin log stream so the Logs page can filter source "similar".
func (a *App) logSimilar(level, format string, args ...any) {
	if level != "info" && level != "warn" && level != "error" {
		level = "info"
	}
	msg := fmt.Sprintf(format, args...)
	if a.output != nil {
		fmt.Fprintf(a.output, "[similar] %s\n", msg)
	}
	if a.hub == nil {
		return
	}
	a.hub.Broadcast(ws.Event{
		Type:  "log",
		Flat:  true,
		Roles: []string{"admin"},
		Payload: map[string]any{
			"source": "similar",
			"level":  level,
			"msg":    msg,
			"ts":     time.Now().UnixMilli(),
		},
	})
}

func (a *App) logSimilarResult(name string, result any, err error) {
	switch {
	case err != nil && !errors.Is(err, context.Canceled):
		a.logSimilar("error", "%s failed: %v", name, err)
	case errors.Is(err, context.Canceled) || similarRunCancelled(result):
		a.logSimilar("info", "%s cancelled", name)
	default:
		a.logSimilar("info", "%s finished: %s", name, similarResultSummary(result))
	}
}

func similarRunCancelled(result any) bool {
	switch r := result.(type) {
	case similar.ScanResult:
		return r.Cancelled
	case similar.AnalyzeResult:
		return r.Cancelled
	default:
		return false
	}
}

func similarResultSummary(result any) string {
	switch r := result.(type) {
	case similar.ScanResult:
		return fmt.Sprintf("processed=%d generated=%d skipped=%d errored=%d", r.Processed, r.Generated, r.Skipped, r.Errored)
	case similar.AnalyzeResult:
		return fmt.Sprintf("similarGroups=%d comparedPairs=%d skipped=%d partialGroups=%d partialReviewGroups=%d", r.SimilarGroups, r.ComparedPairs, r.Skipped, r.PartialGroups, r.PartialReviewGroups)
	default:
		return "ok"
	}
}

func (a *App) enqueueFingerprint(id int64) {
	if id <= 0 || a.similarJobs == nil {
		return
	}
	a.similarJobs.mu.Lock()
	if !a.similarJobs.fpStarted {
		a.similarJobs.fpStarted = true
		go a.drainFingerprints()
	}
	select {
	case a.similarJobs.fp <- id:
	default:
	}
	a.similarJobs.mu.Unlock()
}

func (a *App) drainFingerprints() {
	for {
		select {
		case <-a.ctx.Done():
			return
		case id := <-a.similarJobs.fp:
			a.fingerprintOne(a.ctx, id)
		}
	}
}

func (a *App) fingerprintOne(ctx context.Context, id int64) {
	var path, kind string
	var hash sql.NullString
	err := a.db.Reader.QueryRowContext(ctx, `SELECT COALESCE(file_path,''), COALESCE(file_type,''), file_hash FROM downloads WHERE id=?`, id).Scan(&path, &kind, &hash)
	if err != nil || kind != "video" || path == "" {
		return
	}
	cfg := a.similarConfig(ctx)
	abs := similarMediaPath(a.downloadsDir, path)
	if abs == "" {
		return
	}
	duration, frames, err := similar.GenerateFingerprint(ctx, abs, cfg)
	if err != nil {
		if ctx.Err() == nil && !errors.Is(err, context.Canceled) {
			a.logSimilar("warn", "fingerprint failed for download %d: %v", id, err)
		}
		return
	}
	if len(frames) == 0 {
		a.logSimilar("warn", "fingerprint produced no frames for download %d", id)
		return
	}
	fileHash := ""
	if hash.Valid {
		fileHash = hash.String
	}
	hexes := make([]string, len(frames))
	for i, f := range frames {
		hexes[i] = f.Phash
	}
	if err = similar.UpsertFingerprint(ctx, a.db.Writer, id, duration, similar.XORAggregate(hexes), len(frames), fileHash); err != nil {
		a.logSimilar("warn", "fingerprint save failed for download %d: %v", id, err)
		return
	}
	_ = similar.ReplaceFrames(ctx, a.db.Writer, id, frames)
}

func similarMediaPath(root, stored string) string {
	name, err := mediaName(stored)
	if err != nil {
		return ""
	}
	if strings.HasPrefix(name, "_clusterref/") {
		return ""
	}
	return filepath.Join(root, name)
}
