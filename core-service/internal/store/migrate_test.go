package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestRunMigrationsIsIdempotentAndPreservesSeedSchema(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	first, err := RunMigrations(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	second, err := RunMigrations(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if first == 0 || second != first {
		t.Fatalf("schema versions = %d then %d", first, second)
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='downloads'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("downloads table count = %d", n)
	}
}

func TestStoryKeyMigrationPreservesRowsAndRejectsCollision(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		t.Run(map[bool]string{false: "preserve", true: "collision"}[conflict], func(t *testing.T) {
			ctx := context.Background()
			db, err := Open(ctx, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer db.Reader.Close()
			defer db.Writer.Close()
			if _, err = db.Writer.Exec(`INSERT INTO downloads(id,group_id,message_id,file_type,file_path,file_hash,pinned) VALUES(10,'42',7,'stories','kept.mp4','sha',1),(11,'42',8,'video','message.mp4','other',0)`); err != nil {
				t.Fatal(err)
			}
			if conflict {
				if _, err = db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,file_type) VALUES('42',4294967303,'document')`); err != nil {
					t.Fatal(err)
				}
			}
			for range 2 {
				_, err = RunMigrations(ctx, db.Writer)
				if (err != nil) != conflict {
					t.Fatalf("conflict=%v %v", conflict, err)
				}
			}
			var id int64
			var path, hash string
			var pinned int
			if err = db.Reader.QueryRow(`SELECT message_id,file_path,file_hash,pinned FROM downloads WHERE id=10`).Scan(&id, &path, &hash, &pinned); err != nil {
				t.Fatal(err)
			}
			want := int64(4294967303)
			if conflict {
				want = 7
			}
			if id != want || path != "kept.mp4" || hash != "sha" || pinned != 1 {
				t.Fatalf("changed metadata %d %s %s %d", id, path, hash, pinned)
			}
			if err = db.Reader.QueryRow(`SELECT message_id FROM downloads WHERE id=11`).Scan(&id); err != nil || id != 8 {
				t.Fatalf("message moved %d %v", id, err)
			}
		})
	}
}

func TestRetireUserDeletedAndEnhancementFaceSchema(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Writer.Close()
	defer db.Reader.Close()
	raw := db.Writer
	if _, err = raw.Exec(`
		ALTER TABLE downloads ADD COLUMN user_deleted INTEGER DEFAULT 0;
		INSERT INTO downloads(group_id, message_id, user_deleted) VALUES ('g',5,1),('g',6,0);
		ALTER TABLE people ADD COLUMN cover_face_id INTEGER;
		INSERT INTO people(label, embedding_centroid, created_at, updated_at, cover_face_id) VALUES ('Ada', x'00', 1, 1, 9);
		CREATE TABLE excluded_people (person_id INTEGER PRIMARY KEY);
		INSERT INTO excluded_people(person_id) VALUES (1);
	`); err != nil {
		t.Fatal(err)
	}
	if err = retireUserDeleted(ctx, raw); err != nil {
		t.Fatal(err)
	}
	if err = retireEnhancementFaceSchema(ctx, raw); err != nil {
		t.Fatal(err)
	}
	if _, err = RunMigrations(ctx, raw); err != nil {
		t.Fatal(err)
	}
	var cols int
	if err = raw.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('downloads') WHERE name='user_deleted'`).Scan(&cols); err != nil || cols != 0 {
		t.Fatalf("user_deleted still present (%d, %v)", cols, err)
	}
	var left int
	if err = raw.QueryRow(`SELECT COUNT(*) FROM downloads WHERE message_id=6`).Scan(&left); err != nil || left != 1 {
		t.Fatalf("unflagged row %d %v", left, err)
	}
	if err = raw.QueryRow(`SELECT COUNT(*) FROM downloads WHERE message_id=5`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("flagged row remained %d %v", left, err)
	}
	var tomb int
	if err = raw.QueryRow(`SELECT COUNT(*) FROM download_tombstones WHERE group_id='g' AND message_id=5`).Scan(&tomb); err != nil || tomb != 1 {
		t.Fatalf("tombstone %d %v", tomb, err)
	}
	if err = raw.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('people') WHERE name='cover_face_id'`).Scan(&cols); err != nil || cols != 0 {
		t.Fatalf("cover_face_id %d %v", cols, err)
	}
	if err = raw.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='excluded_people'`).Scan(&cols); err != nil || cols != 0 {
		t.Fatalf("excluded_people %d %v", cols, err)
	}
	var peopleName string
	if err = raw.QueryRow(`SELECT label FROM people`).Scan(&peopleName); err != nil || peopleName != "Ada" {
		t.Fatalf("people row %q %v", peopleName, err)
	}
	if err = raw.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name='video_fingerprints'`).Scan(&cols); err != nil || cols != 1 {
		t.Fatalf("fingerprints table %d %v", cols, err)
	}
}

func TestOpenCreatesMissingDataDirectory(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "nested", "data")
	db, err := Open(context.Background(), dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Writer.Close()
	defer db.Reader.Close()
}

func TestEveryPooledConnectionHasRequiredSettings(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "data ? # with spaces"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Writer.Close()
	defer db.Reader.Close()
	for _, pool := range []*sql.DB{db.Writer, db.Reader} {
		pool.SetMaxIdleConns(0)
		for range 3 {
			conn, err := pool.Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			for setting, want := range map[string]int{"foreign_keys": 1, "busy_timeout": 5000, "synchronous": 1} {
				var value int
				err = conn.QueryRowContext(ctx, "PRAGMA "+setting).Scan(&value)
				if err != nil || value != want {
					conn.Close()
					t.Fatalf("%s=%d want=%d err=%v", setting, value, want, err)
				}
			}
			conn.Close()
		}
	}
}

func TestOriginMigrationPreservesExistingPendingWork(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Writer.Close()
	defer db.Reader.Close()
	if _, err = db.Writer.Exec(`DROP INDEX idx_tgdl_work_priority; ALTER TABLE tgdl_work DROP COLUMN origin;
INSERT INTO tgdl_work(account_id,group_id,group_name,message_id,version,identity,media_type,file_name,file_size,body,created_at,updated_at) VALUES('one','42','Media',1,1,'document:1','document','file',4,X'01',1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err = RunMigrations(ctx, db.Writer); err != nil {
		t.Fatal(err)
	}
	var origin, state string
	if err = db.Reader.QueryRow(`SELECT origin,status FROM tgdl_work WHERE message_id=1`).Scan(&origin, &state); err != nil || origin != "live" || state != "pending" {
		t.Fatalf("migrated=%s/%s %v", origin, state, err)
	}
}

func TestRunMigrationsAddsDurableQueuePauseState(t *testing.T) {
	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Writer.Close()
	defer db.Reader.Close()
	var paused, queueState int
	if err = db.Reader.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('tgdl_work') WHERE name='paused'`).Scan(&paused); err != nil {
		t.Fatal(err)
	}
	if err = db.Reader.QueryRow(`SELECT COUNT(*) FROM tgdl_queue_state WHERE id=1`).Scan(&queueState); err != nil {
		t.Fatal(err)
	}
	if paused != 1 || queueState != 1 {
		t.Fatalf("queue schema paused=%d state=%d", paused, queueState)
	}
}

func TestRunMigrationsPreservesQueueWhenAddingRefreshRequirement(t *testing.T) {
	db, err := Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Writer.Close()
	defer db.Reader.Close()
	if _, err := db.Writer.Exec(`ALTER TABLE tgdl_work DROP COLUMN refresh_required;
INSERT INTO tgdl_work(account_id,group_id,group_name,message_id,version,identity,media_type,file_name,file_size,body,created_at,updated_at) VALUES('one','42','Media',1,1,'document:1','document','file',4,X'01',1,1)`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := RunMigrations(context.Background(), db.Writer); err != nil {
			t.Fatal(err)
		}
	}
	var account string
	var refresh int
	if err := db.Reader.QueryRow(`SELECT account_id,refresh_required FROM tgdl_work`).Scan(&account, &refresh); err != nil {
		t.Fatal(err)
	}
	if account != "one" || refresh != 0 {
		t.Fatalf("migration changed existing work: %q %d", account, refresh)
	}
}

func TestTTLMigrationAddsQueueLaneAndRebuildsPriorityIndex(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Writer.Close()
	defer db.Reader.Close()
	if _, err = db.Writer.Exec(`DROP INDEX idx_tgdl_work_priority; ALTER TABLE tgdl_work DROP COLUMN ttl_seconds;
CREATE INDEX idx_tgdl_work_priority ON tgdl_work(status,paused,CASE origin WHEN 'history' THEN 1 ELSE 0 END,id);
INSERT INTO tgdl_work(account_id,group_id,group_name,message_id,version,identity,media_type,file_name,file_size,body,created_at,updated_at) VALUES('one','42','Media',1,1,'document:1','document','file',4,X'01',1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err = RunMigrations(ctx, db.Writer); err != nil {
		t.Fatal(err)
	}
	var ttl int
	var index string
	if err = db.Reader.QueryRow(`SELECT ttl_seconds FROM tgdl_work WHERE message_id=1`).Scan(&ttl); err != nil || ttl != 0 {
		t.Fatalf("ttl=%d %v", ttl, err)
	}
	if err = db.Reader.QueryRow(`SELECT sql FROM sqlite_master WHERE name='idx_tgdl_work_priority'`).Scan(&index); err != nil || !strings.Contains(index, "ttl_seconds>0") {
		t.Fatalf("index=%s %v", index, err)
	}
	if _, err = RunMigrations(ctx, db.Writer); err != nil {
		t.Fatal(err)
	}
}
