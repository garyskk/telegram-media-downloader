package faststart

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

func TestPlaybackReadyRejectsFragments(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	ready := write("ready.mp4", mp4Header("moov"))
	late := write("late.mp4", mp4Header("mdat"))
	frag := write("frag.mp4", fragmentedAvc1())
	if !PlaybackReady(ready) || PlaybackReady(late) || PlaybackReady(frag) {
		t.Fatalf("ready=%v late=%v frag=%v", PlaybackReady(ready), PlaybackReady(late), PlaybackReady(frag))
	}
}

func TestFaststartRewritesFragmentedMP4(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell worker fixture is POSIX-only")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "clip.mp4")
	src := fragmentedAvc1()
	if err := os.WriteFile(p, src, 0o644); err != nil {
		t.Fatal(err)
	}
	good := append(mp4Header("moov"), bytes.Repeat([]byte{0}, len(src)-len(mp4Header("moov")))...)
	ffmpeg := filepath.Join(dir, "ffmpeg")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\nout=\"\"\nfor arg; do out=\"$arg\"; done\ncp \"$0.out\" \"$out\"\n"
	if err := os.WriteFile(ffmpeg, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ffmpeg+".out", good, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FFMPEG_PATH", ffmpeg)
	roots, _ := hash.NewRoots([]string{dir})
	h := &Handler{Roots: roots}
	req := httptest.NewRequest(http.MethodPost, "/v1/faststart", bytes.NewBufferString(`{"path":"`+p+`"}`))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	var got response
	if err := json.Unmarshal(res.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != "optimized" {
		t.Fatalf("response=%+v", got)
	}
	args, err := os.ReadFile(ffmpeg + ".args")
	if err != nil {
		t.Fatal(err)
	}
	text := string(args)
	if !strings.Contains(text, "-c\ncopy\n") || !strings.Contains(text, "+faststart") {
		t.Fatalf("args:\n%s", text)
	}
	if strings.Contains(text, "-tag:v") || strings.Contains(text, "-bsf:v") {
		t.Fatalf("faststart must not retag or filter streams:\n%s", text)
	}
	if !PlaybackReady(p) {
		t.Fatal("rewritten file is still not progressive")
	}
}

func TestFaststartRejectsFragmentedOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell worker fixture is POSIX-only")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "clip.mp4")
	src := fragmentedAvc1()
	if err := os.WriteFile(p, src, 0o644); err != nil {
		t.Fatal(err)
	}
	ffmpeg := filepath.Join(dir, "ffmpeg")
	script := "#!/bin/sh\nout=\"\"\nfor arg; do out=\"$arg\"; done\ncp \"$5\" \"$out\"\n"
	if err := os.WriteFile(ffmpeg, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FFMPEG_PATH", ffmpeg)
	roots, _ := hash.NewRoots([]string{dir})
	h := &Handler{Roots: roots}
	req := httptest.NewRequest(http.MethodPost, "/v1/faststart", bytes.NewBufferString(`{"path":"`+p+`"}`))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code == http.StatusOK {
		t.Fatalf("accepted fragmented output: %s", res.Body.String())
	}
	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, src) {
		t.Fatal("original file was replaced")
	}
	if _, err := os.Stat(p + ".faststart.tmp"); !os.IsNotExist(err) {
		t.Fatal("temp file left behind")
	}
}
func fragmentedAvc1() []byte {
	entry := mp4Box("avc1", make([]byte, 78))
	body := append(make([]byte, 4), 0, 0, 0, 1)
	body = append(body, entry...)
	moov := mp4Box("moov", mp4Box("trak", mp4Box("mdia", mp4Box("minf", mp4Box("stbl", mp4Box("stsd", body))))))
	ftyp := make([]byte, 16)
	binary.BigEndian.PutUint32(ftyp[:4], 16)
	copy(ftyp[4:8], "ftyp")
	return append(append(append(ftyp, moov...), mp4Box("moof", []byte{0})...), mp4Box("mdat", []byte{0})...)
}

func mp4Box(typ string, payload []byte) []byte {
	b := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(b[:4], uint32(8+len(payload)))
	copy(b[4:8], typ)
	copy(b[8:], payload)
	return b
}
