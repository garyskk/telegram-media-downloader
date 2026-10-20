package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/similar"
	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
)

func TestOperatorDeleteWritesTombstoneAndMissingFileDoesNot(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err = os.MkdirAll(filepath.Join(a.downloadsDir, "gallery"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(a.downloadsDir, "gallery", "keep.jpg"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,file_path,file_type) VALUES('g',9,'gallery/keep.jpg','photo'),('g',10,'gallery/keep.jpg','photo'),('g',11,'missing/gone.mp4','video')`); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(a.downloadsDir, "missing"), 0700); err != nil {
		t.Fatal(err)
	}
	n, err := a.deleteRows(httptest.NewRequest(http.MethodDelete, "/", nil), []int64{1}, nil)
	if err != nil || n != 1 {
		t.Fatalf("delete %d %v", n, err)
	}
	var tomb int
	if err = a.db.Reader.QueryRow(`SELECT COUNT(*) FROM download_tombstones WHERE group_id='g' AND message_id=9`).Scan(&tomb); err != nil || tomb != 1 {
		t.Fatalf("tombstone %d %v", tomb, err)
	}
	if _, err = os.Stat(filepath.Join(a.downloadsDir, "gallery", "keep.jpg")); err != nil {
		t.Fatalf("shared file removed: %v", err)
	}
	a.autoPruneMissingFile(httptest.NewRequest(http.MethodGet, "/", nil), "missing/gone.mp4")
	if err = a.db.Reader.QueryRow(`SELECT COUNT(*) FROM download_tombstones WHERE message_id=11`).Scan(&tomb); err != nil || tomb != 0 {
		t.Fatalf("auto-prune tombstoned a missing file: %d %v", tomb, err)
	}
	if err = a.db.Reader.QueryRow(`SELECT COUNT(*) FROM downloads WHERE message_id=11`).Scan(&tomb); err != nil || tomb != 0 {
		t.Fatalf("missing row remains %d %v", tomb, err)
	}
	minID, maxID, err := store.MessageBounds(context.Background(), a.db.Reader, "g")
	if err != nil || minID != 9 || maxID != 10 {
		t.Fatalf("bounds %d %d %v", minID, maxID, err)
	}
}

func TestSimilarIgnoreGroupsAndPurge(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err = a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,file_path,file_type,file_size,file_hash,file_name) VALUES
		('g',1,'a.mp4','video',100,'aaa','a.mp4'),('g',2,'b.mp4','video',80,'bbb','b.mp4')`); err != nil {
		t.Fatal(err)
	}
	frames := []similar.Frame{{0, "aaaa"}, {1, "bbbb"}, {2, "cccc"}, {3, "dddd"}}
	for _, id := range []int64{1, 2} {
		if err = similar.UpsertFingerprint(context.Background(), a.db.Writer, id, 12, "abcd", len(frames), ""); err != nil {
			t.Fatal(err)
		}
		if err = similar.ReplaceFrames(context.Background(), a.db.Writer, id, frames); err != nil {
			t.Fatal(err)
		}
	}
	result, err := similar.Analyze(context.Background(), a.db.Writer, similar.Defaults(), false, nil)
	if err != nil || result.SimilarGroups != 1 {
		t.Fatalf("analyze %+v %v", result, err)
	}
	w := httptest.NewRecorder()
	a.handleSimilarGroups(w, httptest.NewRequest(http.MethodGet, "/api/maintenance/similar/groups?kind=similar", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"keep"`) {
		t.Fatalf("groups %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	a.handleSimilarIgnore(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"aId":1,"bId":2,"kind":"similar"}`)))
	if w.Code != 200 {
		t.Fatalf("ignore %d %s", w.Code, w.Body.String())
	}
	a.similarJobs.scan.running = true
	w = httptest.NewRecorder()
	a.handleSimilarPurge(w, httptest.NewRequest(http.MethodPost, "/", nil))
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "ALREADY_RUNNING") {
		t.Fatalf("purge %d %s", w.Code, w.Body.String())
	}
	a.similarJobs.scan.running = false
	w = httptest.NewRecorder()
	a.handleSimilarPurge(w, httptest.NewRequest(http.MethodPost, "/", nil))
	if w.Code != 200 {
		t.Fatalf("purge %d %s", w.Code, w.Body.String())
	}
	var ignores int
	if err = a.db.Reader.QueryRow(`SELECT COUNT(*) FROM similar_ignores`).Scan(&ignores); err != nil || ignores != 1 {
		t.Fatalf("ignores wiped %d %v", ignores, err)
	}
	var fps int
	if err = a.db.Reader.QueryRow(`SELECT COUNT(*) FROM video_fingerprints`).Scan(&fps); err != nil || fps != 0 {
		t.Fatalf("fingerprints remain %d %v", fps, err)
	}
}

func TestSimilarGroupMembersExposeDateAndPin(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err = a.db.Writer.Exec(`INSERT INTO downloads(id,group_id,message_id,file_path,file_type,file_size,file_name,pinned,created_at) VALUES
		(1,'g',1,'a.mp4','video',100,'a.mp4',1,'2024-05-06 07:08:09'),
		(2,'g',2,'b.mp4','video',80,'b.mp4',0,'2024-05-07 08:09:10')`); err != nil {
		t.Fatal(err)
	}
	err = similar.InsertGroup(context.Background(), a.db.Writer, similar.Group{
		Kind: "similar", Confidence: 0.9,
		Members: []similar.Member{{DownloadID: 1, Role: "keep"}, {DownloadID: 2, Role: "remove"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	a.handleSimilarGroups(w, httptest.NewRequest(http.MethodGet, "/api/maintenance/similar/groups?kind=similar", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("groups %d %s", w.Code, w.Body.String())
	}
	var body struct {
		Groups []struct {
			Members []struct {
				DownloadID int64  `json:"download_id"`
				CreatedAt  string `json:"created_at"`
				Pinned     bool   `json:"pinned"`
			} `json:"members"`
		} `json:"groups"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Groups) != 1 || len(body.Groups[0].Members) != 2 {
		t.Fatalf("groups %#v", body.Groups)
	}
	got := map[int64]struct {
		created string
		pinned  bool
	}{}
	for _, m := range body.Groups[0].Members {
		got[m.DownloadID] = struct {
			created string
			pinned  bool
		}{m.CreatedAt, m.Pinned}
	}
	if got[1].created != "2024-05-06 07:08:09" || !got[1].pinned {
		t.Fatalf("pinned member %#v", got[1])
	}
	if got[2].created != "2024-05-07 08:09:10" || got[2].pinned {
		t.Fatalf("unpinned member %#v", got[2])
	}
}

func TestGalleryUnpinnedIDsAndByIDs(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err = a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,file_name,file_path,file_type,pinned) VALUES
		('g',1,'pin.jpg','pin.jpg','photo',1),('g',2,'free.jpg','free.jpg','photo',0)`); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	a.handleAPIDownloadsAll(w, httptest.NewRequest(http.MethodGet, "/api/downloads/all?pinned=0", nil))
	if w.Code != 200 || strings.Contains(w.Body.String(), "pin.jpg") || !strings.Contains(w.Body.String(), "free.jpg") {
		t.Fatalf("unpinned %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	a.handleAPIDownloadIDs(w, httptest.NewRequest(http.MethodGet, "/api/downloads/ids?pinned=0", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"ids":[2]`) {
		t.Fatalf("ids %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/downloads/by-ids", strings.NewReader(`{"ids":[2,1,99]}`))
	a.handleAPIDownloadsByIDs(w, req)
	body := w.Body.String()
	free, pin := strings.Index(body, "free.jpg"), strings.Index(body, "pin.jpg")
	if w.Code != 200 || free < 0 || pin < 0 || free > pin || strings.Contains(body, `"id":99`) {
		t.Fatalf("by-ids %d %s", w.Code, body)
	}
	ids := make([]int64, 101)
	raw := `{"ids":[`
	for i := range ids {
		if i > 0 {
			raw += ","
		}
		raw += "1"
	}
	raw += `]}`
	w = httptest.NewRecorder()
	a.handleAPIDownloadsByIDs(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(raw)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("cap %d %s", w.Code, w.Body.String())
	}
}
