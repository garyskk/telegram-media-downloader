package app

import (
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDownloadAutoOptimisesVideo(t *testing.T) {
	dir := t.TempDir()
	ffmpeg := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(ffmpeg, []byte("#!/bin/sh\nout=\"\"\nfor arg; do out=\"$arg\"; done\ncp \"$5\" \"$out\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FFMPEG_PATH", ffmpeg)
	a, err := newConfiguredTestApp(t.Context(), Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	downloads := filepath.Join(dir, "downloads")
	if err = os.MkdirAll(downloads, 0o755); err != nil {
		t.Fatal(err)
	}
	pending := filepath.Join(downloads, "clip.mp4")
	ready := filepath.Join(downloads, "ready.mp4")
	if err = os.WriteFile(pending, autoMP4("mdat"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(ready, autoMP4("moov"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`INSERT INTO downloads(id,group_id,message_id,file_path,file_type,file_size) VALUES(1,'g',1,'clip.mp4','video',1),(2,'g',2,'ready.mp4','video',1),(3,'g',3,'photo.jpg','photo',1)`); err != nil {
		t.Fatal(err)
	}
	a.enqueueFaststart(1, true)
	a.enqueueFaststart(2, true)
	a.enqueueFaststart(3, true)
	deadline := time.Now().Add(5 * time.Second)
	var body map[string]any
	for {
		rec := httptest.NewRecorder()
		a.handleFaststartAutoStats(rec, httptest.NewRequest(http.MethodGet, "/api/maintenance/faststart/auto-stats", nil))
		if err = json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body["total"] == float64(3) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("auto stats never finished: %#v", body)
		}
		time.Sleep(15 * time.Millisecond)
	}
	if body["optimized"] != float64(1) || body["already"] != float64(1) || body["skipped"] != float64(1) || body["ffmpegAvailable"] != true {
		t.Fatalf("stats=%#v", body)
	}
	var size int64
	if err = a.db.Reader.QueryRow(`SELECT file_size FROM downloads WHERE id=1`).Scan(&size); err != nil || size != int64(len(autoMP4("mdat"))) {
		t.Fatalf("rewritten size=%d err=%v", size, err)
	}
}

func autoMP4(atom string) []byte {
	b := make([]byte, 24)
	binary.BigEndian.PutUint32(b[:4], 16)
	copy(b[4:8], "ftyp")
	binary.BigEndian.PutUint32(b[16:20], 8)
	copy(b[20:24], atom)
	return b
}
