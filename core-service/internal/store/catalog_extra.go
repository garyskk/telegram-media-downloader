package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

const extraCatalogSQL = `
CREATE TABLE IF NOT EXISTS download_tombstones (
    group_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, message_id)
);

CREATE TABLE IF NOT EXISTS video_fingerprints (
    download_id INTEGER PRIMARY KEY,
    duration_sec REAL,
    aggregate_hash TEXT,
    frame_count INTEGER NOT NULL DEFAULT 0,
    algo TEXT NOT NULL DEFAULT 'pdq-scene-v1',
    indexed_at INTEGER NOT NULL,
    file_hash TEXT,
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS video_fingerprints_file_hash_idx ON video_fingerprints(file_hash);
CREATE INDEX IF NOT EXISTS video_fingerprints_aggregate_hash_idx ON video_fingerprints(aggregate_hash);

CREATE TABLE IF NOT EXISTS video_frame_hashes (
    download_id INTEGER NOT NULL,
    t_sec REAL NOT NULL,
    phash TEXT NOT NULL,
    PRIMARY KEY (download_id, t_sec),
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS video_frame_hashes_download_id_idx ON video_frame_hashes(download_id);

CREATE TABLE IF NOT EXISTS similar_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('similar', 'partial', 'partial_review')),
    confidence REAL,
    offset_sec REAL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS similar_group_members (
    group_id INTEGER NOT NULL,
    download_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('keep', 'remove', 'review')),
    reason TEXT,
    PRIMARY KEY (group_id, download_id),
    FOREIGN KEY (group_id) REFERENCES similar_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS similar_group_members_download_id_idx ON similar_group_members(download_id);

CREATE TABLE IF NOT EXISTS similar_ignores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    a_id INTEGER NOT NULL,
    b_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('similar', 'partial', 'partial_review')),
    ignored_at INTEGER NOT NULL,
    note TEXT,
    UNIQUE (kind, a_id, b_id),
    CHECK (a_id < b_id),
    FOREIGN KEY (a_id) REFERENCES downloads(id) ON DELETE CASCADE,
    FOREIGN KEY (b_id) REFERENCES downloads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS similar_partial_scans (
    download_id INTEGER PRIMARY KEY,
    frame_count INTEGER NOT NULL,
    scanned_at INTEGER NOT NULL,
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS similar_video_scans (
    download_id INTEGER PRIMARY KEY,
    file_hash TEXT,
    frame_count INTEGER NOT NULL,
    algo TEXT NOT NULL,
    config_key TEXT NOT NULL,
    scanned_at INTEGER NOT NULL,
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
);
`

func migrateCatalogExtras(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, extraCatalogSQL); err != nil {
		return fmt.Errorf("similar clips schema: %w", err)
	}
	if err := retireUserDeleted(ctx, db); err != nil {
		return err
	}
	return retireEnhancementFaceSchema(ctx, db)
}

func columnExists(ctx context.Context, db *sql.DB, table, column string) (bool, error) {
	rows, err := db.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func dropIndexesMentioning(ctx context.Context, db *sql.DB, table, needle string) error {
	rows, err := db.QueryContext(ctx, `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql LIKE ?`, table, "%"+needle+"%")
	if err != nil {
		return err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		var sqlText sql.NullString
		if err = rows.Scan(&name, &sqlText); err != nil {
			return err
		}
		if sqlText.Valid {
			names = append(names, name)
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for _, name := range names {
		if _, err = db.ExecContext(ctx, `DROP INDEX IF EXISTS "`+strings.ReplaceAll(name, `"`, `""`)+`"`); err != nil {
			return err
		}
	}
	return nil
}

// retireUserDeleted copies downloads.user_deleted = 1 into tombstones, deletes
// those rows, and drops the column. A second boot finds no column.
func retireUserDeleted(ctx context.Context, db *sql.DB) error {
	has, err := columnExists(ctx, db, "downloads", "user_deleted")
	if err != nil || !has {
		return err
	}
	if err = dropIndexesMentioning(ctx, db, "downloads", "user_deleted"); err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	for {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO download_tombstones(group_id, message_id, created_at)
			SELECT group_id, message_id, ? FROM downloads WHERE user_deleted=1 AND group_id IS NOT NULL AND message_id IS NOT NULL LIMIT 500`, now)
		if err != nil {
			tx.Rollback()
			return err
		}
		copied, _ := res.RowsAffected()
		res, err = tx.ExecContext(ctx, `DELETE FROM downloads WHERE id IN (SELECT id FROM downloads WHERE user_deleted=1 LIMIT 500)`)
		if err != nil {
			tx.Rollback()
			return err
		}
		removed, _ := res.RowsAffected()
		if err = tx.Commit(); err != nil {
			return err
		}
		_ = copied
		if removed < 500 {
			break
		}
	}
	if _, err = db.ExecContext(ctx, `ALTER TABLE downloads DROP COLUMN user_deleted`); err != nil {
		return fmt.Errorf("drop downloads.user_deleted: %w", err)
	}
	return nil
}

// retireEnhancementFaceSchema drops people.cover_face_id and excluded_people
// when an older enhancement database still has them. People rows stay.
func retireEnhancementFaceSchema(ctx context.Context, db *sql.DB) error {
	var people int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='people'`).Scan(&people); err != nil {
		return err
	}
	if people > 0 {
		has, err := columnExists(ctx, db, "people", "cover_face_id")
		if err != nil {
			return err
		}
		if has {
			if err = dropIndexesMentioning(ctx, db, "people", "cover_face_id"); err != nil {
				return err
			}
			if _, err = db.ExecContext(ctx, `ALTER TABLE people DROP COLUMN cover_face_id`); err != nil {
				return fmt.Errorf("drop people.cover_face_id: %w", err)
			}
		}
	}
	if _, err := db.ExecContext(ctx, `DROP TABLE IF EXISTS excluded_people`); err != nil {
		return err
	}
	return nil
}

// RememberDeletedDownloads records group/message pairs that an operator delete
// is about to remove, so catch-up and pull-older do not fetch them again.
func RememberDeletedDownloads(ctx context.Context, tx *sql.Tx, where string, args ...any) error {
	query := `INSERT OR IGNORE INTO download_tombstones(group_id, message_id, created_at)
		SELECT CAST(group_id AS TEXT), message_id, ? FROM downloads
		WHERE group_id IS NOT NULL AND message_id IS NOT NULL AND (` + where + `)`
	_, err := tx.ExecContext(ctx, query, append([]any{time.Now().UnixMilli()}, args...)...)
	return err
}

// Tombstoned reports an operator delete of this Telegram message.
func Tombstoned(ctx context.Context, db interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, groupID string, messageID int64) (bool, error) {
	var n int
	err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM download_tombstones WHERE group_id=? AND message_id=?)`, groupID, messageID).Scan(&n)
	return n == 1, err
}

// MessageBounds is the oldest and newest known message id for a group,
// including operator-deleted messages. Stories stay outside the range.
func MessageBounds(ctx context.Context, db interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, groupID string) (minID, maxID int64, err error) {
	err = db.QueryRowContext(ctx, `SELECT COALESCE(MIN(message_id),0), COALESCE(MAX(message_id),0) FROM (
		SELECT message_id FROM downloads WHERE group_id=? AND message_id BETWEEN 1 AND 2147483647 AND file_type IS NOT 'stories'
		UNION
		SELECT message_id FROM download_tombstones WHERE group_id=? AND message_id BETWEEN 1 AND 2147483647
	)`, groupID, groupID).Scan(&minID, &maxID)
	return minID, maxID, err
}
