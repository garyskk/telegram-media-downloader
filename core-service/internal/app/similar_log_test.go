package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/similar"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

func TestLogSimilarReachesAdminLogStream(t *testing.T) {
	var buf bytes.Buffer
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Output: &buf})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	admin := a.hub.Add("admin")
	guest := a.hub.Add("guest")
	defer a.hub.Remove(admin)
	defer a.hub.Remove(guest)

	a.logSimilar("warn", "fingerprint failed for download %d: %v", int64(7), errors.New("ffmpeg: no such file"))

	if got := buf.String(); got != "[similar] fingerprint failed for download 7: ffmpeg: no such file\n" {
		t.Fatalf("stdout = %q", got)
	}
	msg := readSimilarLog(t, admin.Events())
	if msg["source"] != "similar" || msg["level"] != "warn" || msg["msg"] != "fingerprint failed for download 7: ffmpeg: no such file" {
		t.Fatalf("log = %#v", msg)
	}
	if asInt(msg["ts"]) <= 0 {
		t.Fatalf("ts = %#v", msg["ts"])
	}
	select {
	case ev := <-guest.Events():
		t.Fatalf("guest received %#v", ev.Type)
	default:
	}
}

func TestSimilarScanLogsStartFinishAndFailure(t *testing.T) {
	var buf bytes.Buffer
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), Output: &buf})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	client := a.hub.Add("admin")
	defer a.hub.Remove(client)

	if !a.startSimilar("scan", "similar_progress", "similar_done", "similar_last_scan", "pending_job_similarScan", func(context.Context, func(map[string]any)) (any, error) {
		return similar.ScanResult{Processed: 2, Generated: 1, Skipped: 1}, nil
	}) {
		t.Fatal("scan did not start")
	}
	waitSimilarLogs(t, client.Events(), []logWant{
		{"info", "scan starting"},
		{"info", "scan finished: processed=2 generated=1 skipped=1 errored=0"},
	})

	if !a.startSimilar("scan", "similar_progress", "similar_done", "similar_last_scan", "pending_job_similarScan", func(context.Context, func(map[string]any)) (any, error) {
		return nil, errors.New("db locked")
	}) {
		t.Fatal("failing scan did not start")
	}
	waitSimilarLogs(t, client.Events(), []logWant{
		{"info", "scan starting"},
		{"error", "scan failed: db locked"},
	})
	if !strings.Contains(buf.String(), "[similar] scan failed: db locked\n") {
		t.Fatalf("stdout = %q", buf.String())
	}
}

func TestSimilarAnalyzeAndCancelLogs(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	client := a.hub.Add("admin")
	defer a.hub.Remove(client)

	if !a.startSimilar("analyze", "similar_analyze_progress", "similar_analyze_done", "similar_last_analyze", "pending_job_similarAnalyze", func(context.Context, func(map[string]any)) (any, error) {
		return similar.AnalyzeResult{SimilarGroups: 3, ComparedPairs: 4, Skipped: 1, PartialGroups: 2, PartialReviewGroups: 1}, nil
	}) {
		t.Fatal("analyze did not start")
	}
	waitSimilarLogs(t, client.Events(), []logWant{
		{"info", "analyze starting"},
		{"info", "analyze finished: similarGroups=3 comparedPairs=4 skipped=1 partialGroups=2 partialReviewGroups=1"},
	})

	release := make(chan struct{})
	if !a.startSimilar("scan", "similar_progress", "similar_done", "similar_last_scan", "pending_job_similarScan", func(ctx context.Context, _ func(map[string]any)) (any, error) {
		select {
		case <-release:
		case <-ctx.Done():
		}
		return similar.ScanResult{Cancelled: true, Processed: 1}, ctx.Err()
	}) {
		t.Fatal("cancellable scan did not start")
	}
	if got := readSimilarLog(t, client.Events()); got["msg"] != "scan starting" {
		t.Fatalf("start = %#v", got)
	}
	a.stopSimilar("scan")
	close(release)
	waitSimilarLogs(t, client.Events(), []logWant{
		{"info", "scan stopping"},
		{"info", "scan cancelled"},
	})
	a.stopSimilar("scan")
	select {
	case ev := <-client.Events():
		if ev.Type == "log" {
			t.Fatalf("idle stop logged %#v", ev)
		}
	case <-time.After(50 * time.Millisecond):
	}
}

func TestFingerprintFailureLogs(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	client := a.hub.Add("admin")
	defer a.hub.Remove(client)
	if _, err = a.db.Writer.Exec(`INSERT INTO downloads(id,group_id,message_id,file_path,file_type) VALUES(9,'g',1,'missing/clip.mp4','video')`); err != nil {
		t.Fatal(err)
	}
	a.fingerprintOne(context.Background(), 9)
	msg := readSimilarLog(t, client.Events())
	if msg["level"] != "warn" || !strings.Contains(msg["msg"].(string), "fingerprint failed for download 9:") {
		t.Fatalf("log = %#v", msg)
	}
}

type logWant struct {
	level string
	msg   string
}

func waitSimilarLogs(t *testing.T, ch <-chan ws.Event, want []logWant) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	got := make([]logWant, 0, len(want))
	for len(got) < len(want) {
		select {
		case ev := <-ch:
			if ev.Type != "log" {
				continue
			}
			msg := decodeSimilarEvent(t, ev)
			got = append(got, logWant{level: stringField(msg["level"]), msg: stringField(msg["msg"])})
		case <-deadline:
			t.Fatalf("logs = %#v, want %#v", got, want)
		}
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("logs = %#v, want %#v", got, want)
		}
	}
}

func readSimilarLog(t *testing.T, ch <-chan ws.Event) map[string]any {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-ch:
			if ev.Type != "log" {
				continue
			}
			return decodeSimilarEvent(t, ev)
		case <-deadline:
			t.Fatal("timed out waiting for similar log")
		}
	}
}

func decodeSimilarEvent(t *testing.T, ev ws.Event) map[string]any {
	t.Helper()
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	var msg map[string]any
	if err = json.Unmarshal(raw, &msg); err != nil {
		t.Fatal(err)
	}
	return msg
}

func stringField(v any) string {
	s, _ := v.(string)
	return s
}
