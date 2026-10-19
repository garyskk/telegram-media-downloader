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

func TestNeedsHvc1Retag(t *testing.T) {
	dir := t.TempDir()
	ready := filepath.Join(dir, "ready.mp4")
	empty := filepath.Join(dir, "empty.mp4")
	mixed := filepath.Join(dir, "mixed.mp4")
	if err := os.WriteFile(ready, hevcFixture(true, false), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(empty, hevcFixture(false, false), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mixed, hevcFixture(true, true), 0o644); err != nil {
		t.Fatal(err)
	}
	if !NeedsHvc1Retag(ready) || NeedsHvc1Retag(empty) || NeedsHvc1Retag(mixed) {
		t.Fatalf("retag ready=%v empty=%v mixed=%v", NeedsHvc1Retag(ready), NeedsHvc1Retag(empty), NeedsHvc1Retag(mixed))
	}
}

func TestNeedsHevcExtract(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	ready := write("ready.mp4", hevcFixture(true, false))
	empty := write("empty.mp4", hevcFixture(false, false))
	missing := write("missing.mp4", hevcSample("hev1", nil, false))
	spsOnly := write("sps.mp4", hevcSample("hev1", hvccTypes(33), false))
	mixed := write("mixed.mp4", hevcFixture(false, true))
	done := write("hvc1.mp4", hevcSample("hvc1", hvccTypes(32, 33, 34), false))
	if NeedsHevcExtract(ready) || !NeedsHevcExtract(empty) || !NeedsHevcExtract(missing) || !NeedsHevcExtract(spsOnly) {
		t.Fatalf("extract ready=%v empty=%v missing=%v sps=%v", NeedsHevcExtract(ready), NeedsHevcExtract(empty), NeedsHevcExtract(missing), NeedsHevcExtract(spsOnly))
	}
	if NeedsHevcExtract(mixed) || NeedsHvc1Retag(mixed) || NeedsHevcExtract(done) || NeedsHvc1Retag(done) {
		t.Fatalf("mixed extract=%v retag=%v hvc1 extract=%v retag=%v", NeedsHevcExtract(mixed), NeedsHvc1Retag(mixed), NeedsHevcExtract(done), NeedsHvc1Retag(done))
	}
	frag := append(append([]byte{}, hevcSample("hvc1", hvccTypes(32, 33, 34), false)...), mp4Box("moof", []byte{0})...)
	fragPath := write("frag.mp4", frag)
	if !hevcExtractVerified(done) || hevcExtractVerified(empty) || hevcExtractVerified(ready) || hevcExtractVerified(fragPath) {
		t.Fatalf("verified done=%v empty=%v ready=%v frag=%v", hevcExtractVerified(done), hevcExtractVerified(empty), hevcExtractVerified(ready), hevcExtractVerified(fragPath))
	}
}

func TestFaststartHevcRemuxesWithTag(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell worker fixture is POSIX-only")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(p, hevcFixture(true, false), 0o644); err != nil {
		t.Fatal(err)
	}
	ffmpeg := filepath.Join(dir, "ffmpeg")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\nout=\"\"\nfor arg; do out=\"$arg\"; done\ncp \"$5\" \"$out\"\n"
	if err := os.WriteFile(ffmpeg, []byte(script), 0o755); err != nil {
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
	if !strings.Contains(string(args), "-tag:v\nhvc1\n") || !strings.Contains(string(args), "+faststart") {
		t.Fatalf("args:\n%s", args)
	}
	if strings.Contains(string(args), "extract_extradata") || strings.Contains(string(args), "hevc_mp4toannexb") || strings.Contains(string(args), "libx265") {
		t.Fatalf("retag path applied an extract filter:\n%s", args)
	}
}

func TestFaststartHevcExtractsInBand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell worker fixture is POSIX-only")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "clip.mp4")
	src := hevcFixture(false, false)
	if err := os.WriteFile(p, src, 0o644); err != nil {
		t.Fatal(err)
	}
	good := hevcSample("hvc1", hvccTypes(32, 33, 34), false)
	ffmpeg := filepath.Join(dir, "ffmpeg")
	script := "#!/bin/sh\nif [ \"$2\" = \"-h\" ]; then\n  printf '%s\\n' \"Bit stream filter extract_extradata\"\n  exit 0\nfi\nprintf '%s\\n' \"$@\" > \"$0.args\"\nout=\"\"\nfor arg; do out=\"$arg\"; done\ncp \"$0.out\" \"$out\"\n"
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
	for _, want := range []string{"-c\ncopy\n", "-map\n0\n", "-bsf:v\n" + hevcInBandBSF + "\n", "-tag:v\nhvc1\n", "+faststart", "-f\nmp4\n"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in args:\n%s", want, text)
		}
	}
	if strings.Contains(text, "libx265") || strings.Contains(text, "-an\n") || strings.Contains(text, "-sn\n") {
		t.Fatalf("remux dropped streams or re-encoded:\n%s", text)
	}
	gotBytes, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotBytes, good) || NeedsHevcExtract(p) {
		t.Fatal("optimized file is not the verified hvc1 output")
	}
}

func TestFaststartHevcExtractRejectsBadOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell worker fixture is POSIX-only")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "clip.mp4")
	src := hevcFixture(false, false)
	if err := os.WriteFile(p, src, 0o644); err != nil {
		t.Fatal(err)
	}
	ffmpeg := filepath.Join(dir, "ffmpeg")
	script := "#!/bin/sh\nif [ \"$2\" = \"-h\" ]; then\n  printf '%s\\n' \"Bit stream filter extract_extradata\"\n  exit 0\nfi\nout=\"\"\nfor arg; do out=\"$arg\"; done\ncp \"$5\" \"$out\"\n"
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
		t.Fatalf("accepted unverified output: %s", res.Body.String())
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

func TestFaststartHevcExtractDataTrackRetry(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell worker fixture is POSIX-only")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(p, hevcFixture(false, false), 0o644); err != nil {
		t.Fatal(err)
	}
	ffmpeg := filepath.Join(dir, "ffmpeg")
	script := "#!/bin/sh\nif [ \"$2\" = \"-h\" ]; then\n  printf '%s\\n' \"Bit stream filter extract_extradata\"\n  exit 0\nfi\n{\n  printf '%s\\n' \"$@\"\n  printf '\\n---\\n'\n} >> \"$0.args\"\ndrop=0\nfor arg; do\n  if [ \"$arg\" = \"-0:d\" ]; then drop=1; fi\ndone\nif [ \"$drop\" -eq 0 ]; then\n  echo 'Could not find tag for codec' >&2\n  exit 1\nfi\nout=\"\"\nfor arg; do out=\"$arg\"; done\ncp \"$0.out\" \"$out\"\n"
	if err := os.WriteFile(ffmpeg, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ffmpeg+".out", hevcSample("hvc1", hvccTypes(32, 33, 34), false), 0o644); err != nil {
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
	args, err := os.ReadFile(ffmpeg + ".args")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(string(args), "\n---\n")
	if len(parts) < 2 {
		t.Fatalf("expected a retry, args:\n%s", args)
	}
	for _, part := range parts[:2] {
		if !strings.Contains(part, hevcInBandBSF) || !strings.Contains(part, "-tag:v\nhvc1\n") || !strings.Contains(part, "-c\ncopy\n") {
			t.Fatalf("retry lost the extract remux:\n%s", part)
		}
	}
	if strings.Contains(parts[0], "-0:d") || !strings.Contains(parts[1], "-map\n-0:d\n") {
		t.Fatalf("data-track retry args:\n%s", args)
	}
}

func TestFaststartHevcExtractAnnexBFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell worker fixture is POSIX-only")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(p, hevcFixture(false, false), 0o644); err != nil {
		t.Fatal(err)
	}
	ffmpeg := filepath.Join(dir, "ffmpeg")
	script := "#!/bin/sh\nif [ \"$2\" = \"-h\" ]; then\n  printf '%s\\n' \"Unknown bit stream filter 'extract_extradata'.\"\n  exit 0\nfi\n{\n  printf '%s\\n' \"$@\"\n  printf '\\n---\\n'\n} >> \"$0.args\"\nout=\"\"\nfor arg; do out=\"$arg\"; done\ncp \"$0.out\" \"$out\"\n"
	if err := os.WriteFile(ffmpeg, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ffmpeg+".out", hevcSample("hvc1", hvccTypes(32, 33, 34), false), 0o644); err != nil {
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
	args, err := os.ReadFile(ffmpeg + ".args")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(string(args), "\n---\n")
	if len(parts) < 2 {
		t.Fatalf("args:\n%s", args)
	}
	if !strings.Contains(parts[0], "-bsf:v\nhevc_mp4toannexb\n") || !strings.Contains(parts[0], "-f\nmpegts\n") || strings.Contains(parts[0], "extract_extradata") {
		t.Fatalf("step1:\n%s", parts[0])
	}
	if !strings.Contains(parts[1], "-c\ncopy\n") || !strings.Contains(parts[1], "-tag:v\nhvc1\n") || !strings.Contains(parts[1], "+faststart") || strings.Contains(parts[1], "libx265") {
		t.Fatalf("step2:\n%s", parts[1])
	}
	if _, err := os.Stat(p + ".faststart.annexb.ts"); !os.IsNotExist(err) {
		t.Fatal("annexb temp left behind")
	}
}

func TestPlaybackReadyRejectsFragments(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	ready := write("hvc1.mp4", hevcSample("hvc1", hvccTypes(32, 33, 34), false))
	retag := write("hev1.mp4", hevcFixture(true, false))
	frag := write("frag.mp4", fragmentedAvc1())
	if !PlaybackReady(ready) || PlaybackReady(retag) || PlaybackReady(frag) {
		t.Fatalf("ready=%v retag=%v frag=%v", PlaybackReady(ready), PlaybackReady(retag), PlaybackReady(frag))
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
	if strings.Contains(text, "extract_extradata") || strings.Contains(text, "-tag:v\nhvc1\n") || strings.Contains(text, "libx265") {
		t.Fatalf("fragmented avc1 took the HEVC path:\n%s", text)
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

func TestAlreadyHvc1Skipped(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(p, hevcSample("hvc1", hvccTypes(32, 33, 34), false), 0o644); err != nil {
		t.Fatal(err)
	}
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
	if got.Status != "already" {
		t.Fatalf("response=%+v", got)
	}
}

func hvccTypes(types ...byte) []byte {
	hvcc := make([]byte, 23+3*len(types))
	hvcc[22] = byte(len(types))
	off := 23
	for _, nal := range types {
		hvcc[off] = nal
		off += 3
	}
	return hvcc
}

func hevcFixture(parameterSets, conflict bool) []byte {
	var hvcc []byte
	if parameterSets {
		hvcc = hvccTypes(32, 33, 34)
	} else {
		hvcc = make([]byte, 32)
	}
	return hevcSample("hev1", hvcc, conflict)
}

func hevcSample(tag string, hvcc []byte, conflict bool) []byte {
	visual := make([]byte, 78)
	var entry []byte
	if hvcc == nil {
		entry = mp4Box(tag, visual)
	} else {
		entry = mp4Box(tag, append(visual, mp4Box("hvcC", hvcc)...))
	}
	body := append(make([]byte, 4), byte(0), byte(0), byte(0), byte(1))
	body = append(body, entry...)
	if conflict {
		binary.BigEndian.PutUint32(body[4:8], 2)
		body = append(body, mp4Box("avc1", make([]byte, 78))...)
	}
	stsd := mp4Box("stsd", body)
	moov := mp4Box("moov", mp4Box("trak", mp4Box("mdia", mp4Box("minf", mp4Box("stbl", stsd)))))
	ftyp := make([]byte, 16)
	binary.BigEndian.PutUint32(ftyp[:4], 16)
	copy(ftyp[4:8], "ftyp")
	return append(append(ftyp, moov...), mp4Box("mdat", []byte{0})...)
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
