package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func TestSimilarScanProgressStaysRunningAcrossReload(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	client := a.hub.Add("admin")
	defer a.hub.Remove(client)

	release := make(chan struct{})
	started := make(chan struct{})
	ok := a.startSimilar("scan", "similar_progress", "similar_done", "similar_last_scan", "pending_job_similarScan", func(ctx context.Context, progress func(map[string]any)) (any, error) {
		p := map[string]any{"stage": "progress", "processed": 2, "total": 8, "generated": 1, "skipped": 1, "errored": 0}
		progress(p)
		// The page reloads while ffmpeg is still inside this run. A caller
		// that reuses the map, and an empty follow-up tick, must not make
		// the next status read or websocket frame look idle.
		for k := range p {
			delete(p, k)
		}
		p["running"] = false
		p["stage"] = "idle"
		progress(map[string]any{})
		close(started)
		select {
		case <-release:
		case <-ctx.Done():
		}
		return map[string]any{"generated": 1, "processed": 2, "skipped": 1}, nil
	})
	if !ok {
		t.Fatal("scan did not start")
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("progress callback did not run")
	}

	first := readSimilarEvent(t, client.Events())
	second := readSimilarEvent(t, client.Events())
	for i, msg := range []map[string]any{first, second} {
		if msg["type"] != "similar_progress" || msg["running"] != true {
			t.Fatalf("event %d = %#v", i, msg)
		}
		if asInt(msg["processed"]) != 2 || asInt(msg["total"]) != 8 {
			t.Fatalf("event %d counters = %#v", i, msg)
		}
	}

	status := getSimilarStatus(t, a)
	if status["running"] != true {
		t.Fatalf("status running = %#v", status["running"])
	}
	prog, _ := status["progress"].(map[string]any)
	if asInt(prog["processed"]) != 2 || asInt(prog["total"]) != 8 || prog["stage"] != "progress" {
		t.Fatalf("status progress = %#v", prog)
	}
	again := getSimilarStatus(t, a)
	if again["running"] != true {
		t.Fatalf("second status running = %#v", again["running"])
	}

	close(release)
	deadline := time.After(5 * time.Second)
	for {
		msg := readSimilarEvent(t, client.Events())
		if msg["type"] == "similar_done" {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("expected similar_done, got %#v", msg)
		default:
		}
	}
	done := getSimilarStatus(t, a)
	if done["running"] != false {
		t.Fatalf("finished running = %#v", done["running"])
	}
}

func getSimilarStatus(t *testing.T, a *App) map[string]any {
	t.Helper()
	w := httptest.NewRecorder()
	a.handleSimilarStatus(w, httptest.NewRequest(http.MethodGet, "/api/maintenance/similar/status", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func readSimilarEvent(t *testing.T, ch <-chan ws.Event) map[string]any {
	t.Helper()
	select {
	case ev := <-ch:
		raw, err := json.Marshal(ev)
		if err != nil {
			t.Fatal(err)
		}
		var msg map[string]any
		if err = json.Unmarshal(raw, &msg); err != nil {
			t.Fatal(err)
		}
		return msg
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for similar event")
	}
	return nil
}

func asInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	default:
		return -1
	}
}
