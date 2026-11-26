package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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
