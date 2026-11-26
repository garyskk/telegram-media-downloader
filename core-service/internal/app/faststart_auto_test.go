package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
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
	if err = a.db.Reader.QueryRow(`SELECT file_size FROM downloads WHERE id=1`).Scan(&size); err != nil || size != 1 {
		t.Fatalf("file_size must stay at the original value, got %d err=%v", size, err)
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

func videoDocMessage(id int, channel, doc int64, size int) *tg.Message {
	return &tg.Message{ID: id, PeerID: &tg.PeerChannel{ChannelID: channel}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: doc, Size: int64(size), DCID: 2, Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeFilename{FileName: "clip.mp4"}}}}}
}

// reingestAfterFaststart downloads one video, lets the automatic faststart
// rewrite run (when enabled), then ingests the same Telegram
// media for a message in another chat. It returns the number of distinct files
// and the per-row paths.
func reingestAfterFaststart(t *testing.T, enabled bool) (files int, paths []string, rewritten bool) {
	t.Helper()
	dir := t.TempDir()
	src := append(autoMP4("mdat"), bytes.Repeat([]byte{1}, 176)...)
	good := append(autoMP4("moov"), bytes.Repeat([]byte{1}, 160)...)
	script := "#!/bin/sh\ncp \"$0.out\" \"$(eval echo \\${$#})\"\n"
	if enabled {
		t.Setenv("FASTSTART_AUTO", "1")
	} else {
		t.Setenv("FASTSTART_AUTO", "")
	}
	ffmpeg := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(ffmpeg, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ffmpeg+".out", good, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FFMPEG_PATH", ffmpeg)
	a, err := newConfiguredTestApp(t.Context(), Config{DataDir: dir, Output: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	transport := mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		_, err := w.Write(src)
		return err
	})
	ctx := context.Background()
	if _, err = a.ingestTelegram(ctx, videoDocMessage(1, 123, 77, len(src)), "", "Source", "acct1", transport); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for enabled {
		if stats, _ := a.faststartAutoView(); stats.Total == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("faststart auto never finished")
		}
		time.Sleep(10 * time.Millisecond)
	}
	var rel string
	var size int64
	if err = a.db.Reader.QueryRow(`SELECT file_path, file_size FROM downloads WHERE message_id=1`).Scan(&rel, &size); err != nil {
		t.Fatal(err)
	}
	if size != int64(len(src)) {
		t.Fatalf("file_size=%d, want Telegram's original %d", size, len(src))
	}
	if st, serr := os.Stat(filepath.Join(dir, "downloads", rel)); serr == nil {
		rewritten = st.Size() == int64(len(good))
	}
	if _, err = a.ingestTelegram(ctx, videoDocMessage(2, 456, 77, len(src)), "", "Other", "acct1", transport); err != nil {
		t.Fatal(err)
	}
	rows, err := a.db.Reader.Query(`SELECT COALESCE(file_path,'') FROM downloads ORDER BY message_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := map[string]bool{}
	for rows.Next() {
		var p string
		if err = rows.Scan(&p); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, p)
		seen[p] = true
	}
	return len(seen), paths, rewritten
}

// Automatic faststart is off by default so that duplicate reuse behaves as on
// plain v3.5.3: the same media arriving for a second message is one file.
func TestFaststartAutoDefaultOffKeepsReuse(t *testing.T) {
	files, paths, rewritten := reingestAfterFaststart(t, false)
	if rewritten {
		t.Fatal("default run must not rewrite the file")
	}
	if files != 1 {
		t.Fatalf("expected the second message to reuse the first file, got %d files %q", files, paths)
	}
}

// With FASTSTART_AUTO enabled the rewrite changes the file size on disk, so
// library.reuse skips the file and a second copy is saved. This is documented
// in .env.example, docs/CONFIGURATION.md and CHANGELOG.md.
func TestFaststartAutoEnabledRewritesAndSkipsReuse(t *testing.T) {
	files, paths, rewritten := reingestAfterFaststart(t, true)
	if !rewritten {
		t.Fatal("faststart rewrite did not run")
	}
	if files != 2 {
		t.Fatalf("expected a second copy after a rewrite, got %d files %q", files, paths)
	}
}
