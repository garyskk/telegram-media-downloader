package similar

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"
)

const eligibleSQL = `d.file_type='video' AND d.file_path IS NOT NULL AND d.file_path NOT LIKE '_clusterref/%'`

const needsFingerprintSQL = `(vf.download_id IS NULL OR vf.algo != 'pdq-scene-v1' OR (d.file_hash IS NOT NULL AND (vf.file_hash IS NULL OR vf.file_hash != d.file_hash)))`

type execer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// PruneIncompleteGroups drops groups left with fewer than two live members.
func PruneIncompleteGroups(ctx context.Context, db execer) error {
	rows, err := db.QueryContext(ctx, `SELECT g.id FROM similar_groups g
		LEFT JOIN similar_group_members m ON m.group_id=g.id
		LEFT JOIN downloads d ON d.id=m.download_id
		GROUP BY g.id HAVING COUNT(d.id) < 2`)
	if err != nil {
		return err
	}
	var ids []any
	for rows.Next() {
		var id int64
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if len(ids) == 0 {
		return nil
	}
	marks := strings.Repeat("?,", len(ids))
	_, err = db.ExecContext(ctx, `DELETE FROM similar_groups WHERE id IN (`+marks[:len(marks)-1]+`)`, ids...)
	return err
}

type Stats struct {
	TotalVideos   int
	Fingerprinted int
	Missing       int
}

func ScanStats(ctx context.Context, db execer) (Stats, error) {
	var s Stats
	err := db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM downloads d WHERE `+eligibleSQL+`),
		(SELECT COUNT(*) FROM video_fingerprints vf JOIN downloads d ON d.id=vf.download_id WHERE `+eligibleSQL+`),
		(SELECT COUNT(*) FROM downloads d LEFT JOIN video_fingerprints vf ON vf.download_id=d.id WHERE `+eligibleSQL+` AND `+needsFingerprintSQL+`)`).Scan(&s.TotalVideos, &s.Fingerprinted, &s.Missing)
	return s, err
}

type ScanRow struct {
	ID       int64
	Path     string
	FileType string
	Name     string
	FileHash sql.NullString
}

func PageScan(ctx context.Context, db execer, before int64, limit int) ([]ScanRow, error) {
	if before <= 0 {
		before = 1<<62 - 1
	}
	if limit < 1 {
		limit = 100
	}
	rows, err := db.QueryContext(ctx, `SELECT d.id, d.file_path, d.file_type, COALESCE(d.file_name,''), d.file_hash
		FROM downloads d LEFT JOIN video_fingerprints vf ON vf.download_id=d.id
		WHERE `+eligibleSQL+` AND `+needsFingerprintSQL+` AND d.id < ?
		ORDER BY d.id DESC LIMIT ?`, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ScanRow
	for rows.Next() {
		var row ScanRow
		if err = rows.Scan(&row.ID, &row.Path, &row.FileType, &row.Name, &row.FileHash); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func UpsertFingerprint(ctx context.Context, db execer, id int64, duration float64, aggregate string, frames int, fileHash string) error {
	var hash any
	if fileHash != "" {
		hash = fileHash
	}
	_, err := db.ExecContext(ctx, `INSERT INTO video_fingerprints(download_id,duration_sec,aggregate_hash,frame_count,algo,indexed_at,file_hash)
		VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(download_id) DO UPDATE SET duration_sec=excluded.duration_sec, aggregate_hash=excluded.aggregate_hash,
		frame_count=excluded.frame_count, algo=excluded.algo, indexed_at=excluded.indexed_at, file_hash=excluded.file_hash`,
		id, duration, aggregate, frames, Algo, time.Now().UnixMilli(), hash)
	return err
}

func ReplaceFrames(ctx context.Context, db *sql.DB, id int64, frames []Frame) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `DELETE FROM video_frame_hashes WHERE download_id=?`, id); err != nil {
		return err
	}
	for _, f := range frames {
		if _, err = tx.ExecContext(ctx, `INSERT INTO video_frame_hashes(download_id,t_sec,phash) VALUES(?,?,?)`, id, f.TSec, f.Phash); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func ListAnalyzeVideos(ctx context.Context, db execer) ([]Video, error) {
	rows, err := db.QueryContext(ctx, `SELECT vf.download_id, vf.duration_sec, COALESCE(vf.aggregate_hash,''), vf.frame_count,
		COALESCE(d.file_hash,''), COALESCE(d.file_size,0), COALESCE(d.file_name,'')
		FROM video_fingerprints vf JOIN downloads d ON d.id=vf.download_id
		WHERE d.file_type='video' AND d.file_path IS NOT NULL AND d.file_path NOT LIKE '_clusterref/%'
		AND vf.frame_count>0 AND vf.duration_sec IS NOT NULL ORDER BY vf.download_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Video
	for rows.Next() {
		var v Video
		var dur sql.NullFloat64
		if err = rows.Scan(&v.ID, &dur, &v.AggregateHash, &v.FrameCount, &v.FileHash, &v.FileSize, &v.FileName); err != nil {
			return nil, err
		}
		if dur.Valid {
			v.DurationSec = dur.Float64
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func FramesFor(ctx context.Context, db execer, ids []int64) (map[int64][]Frame, error) {
	out := map[int64][]Frame{}
	if len(ids) == 0 {
		return out, nil
	}
	for off := 0; off < len(ids); off += 16 {
		end := off + 16
		if end > len(ids) {
			end = len(ids)
		}
		slice := ids[off:end]
		args := make([]any, len(slice))
		marks := make([]string, len(slice))
		for i, id := range slice {
			args[i] = id
			marks[i] = "?"
		}
		rows, err := db.QueryContext(ctx, `SELECT download_id, t_sec, phash FROM video_frame_hashes WHERE download_id IN (`+strings.Join(marks, ",")+`) ORDER BY download_id, t_sec`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int64
			var f Frame
			if err = rows.Scan(&id, &f.TSec, &f.Phash); err != nil {
				rows.Close()
				return nil, err
			}
			out[id] = append(out[id], f)
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return out, nil
}

type scanCursor struct {
	DownloadID int64
	FileHash   sql.NullString
	FrameCount int
	Algo       string
	ConfigKey  string
}

func ListVideoScans(ctx context.Context, db execer) ([]scanCursor, error) {
	rows, err := db.QueryContext(ctx, `SELECT download_id, file_hash, frame_count, algo, config_key FROM similar_video_scans ORDER BY download_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []scanCursor
	for rows.Next() {
		var s scanCursor
		if err = rows.Scan(&s.DownloadID, &s.FileHash, &s.FrameCount, &s.Algo, &s.ConfigKey); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func UpsertVideoScan(ctx context.Context, db execer, v Video, frames int, configKey string) error {
	var hash any
	if v.FileHash != "" {
		hash = v.FileHash
	}
	_, err := db.ExecContext(ctx, `INSERT INTO similar_video_scans(download_id,file_hash,frame_count,algo,config_key,scanned_at)
		VALUES(?,?,?,?,?,?) ON CONFLICT(download_id) DO UPDATE SET file_hash=excluded.file_hash, frame_count=excluded.frame_count,
		algo=excluded.algo, config_key=excluded.config_key, scanned_at=excluded.scanned_at`,
		v.ID, hash, frames, Algo, configKey, time.Now().UnixMilli())
	return err
}

func InsertGroup(ctx context.Context, db *sql.DB, g Group) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var offset any
	if g.HasOffset {
		offset = g.OffsetSec
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO similar_groups(kind,confidence,offset_sec,created_at) VALUES(?,?,?,?)`, g.Kind, g.Confidence, offset, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return err
	}
	for _, m := range g.Members {
		if _, err = tx.ExecContext(ctx, `INSERT INTO similar_group_members(group_id,download_id,role,reason) VALUES(?,?,?,?)`, id, m.DownloadID, m.Role, m.Reason); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func DeleteGroupsForDownload(ctx context.Context, db *sql.DB, id int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `DELETE FROM similar_group_members WHERE download_id=?`, id); err != nil {
		return err
	}
	if err = PruneIncompleteGroups(ctx, tx); err != nil {
		return err
	}
	return tx.Commit()
}

func DeleteGroupsByKind(ctx context.Context, db execer, kind string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM similar_groups WHERE kind=?`, kind)
	return err
}

func ClearVideoScans(ctx context.Context, db execer) error {
	_, err := db.ExecContext(ctx, `DELETE FROM similar_video_scans`)
	return err
}

type partialScan struct {
	DownloadID int64
	FrameCount int
}

func ListPartialScans(ctx context.Context, db execer) ([]partialScan, error) {
	rows, err := db.QueryContext(ctx, `SELECT download_id, frame_count FROM similar_partial_scans ORDER BY download_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []partialScan
	for rows.Next() {
		var s partialScan
		if err = rows.Scan(&s.DownloadID, &s.FrameCount); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func UpsertPartialScan(ctx context.Context, db execer, id int64, frames int) error {
	_, err := db.ExecContext(ctx, `INSERT INTO similar_partial_scans(download_id,frame_count,scanned_at) VALUES(?,?,?)
		ON CONFLICT(download_id) DO UPDATE SET frame_count=excluded.frame_count, scanned_at=excluded.scanned_at`, id, frames, time.Now().UnixMilli())
	return err
}

func IgnoreIDs(ctx context.Context, db execer, kind string) (map[string]bool, error) {
	out := map[string]bool{}
	q := `SELECT a_id, b_id FROM similar_ignores`
	var args []any
	if kind != "" {
		q += ` WHERE kind=?`
		args = append(args, kind)
	}
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a, b int64
		if err = rows.Scan(&a, &b); err != nil {
			return nil, err
		}
		out[PairKey(a, b)] = true
	}
	return out, rows.Err()
}

func ListGroups(ctx context.Context, db execer, kind string) ([]map[string]any, error) {
	if err := PruneIncompleteGroups(ctx, db); err != nil {
		return nil, err
	}
	q := `SELECT id, kind, confidence, offset_sec, created_at FROM similar_groups`
	var args []any
	if kind != "" {
		q += ` WHERE kind=?`
		args = append(args, kind)
	}
	q += ` ORDER BY id DESC`
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var groups []map[string]any
	var ids []int64
	for rows.Next() {
		var id, created int64
		var kindName string
		var conf, offset sql.NullFloat64
		if err = rows.Scan(&id, &kindName, &conf, &offset, &created); err != nil {
			return nil, err
		}
		item := map[string]any{"id": id, "kind": kindName, "created_at": created, "confidence": nil, "offset_sec": nil}
		if conf.Valid {
			item["confidence"] = conf.Float64
		}
		if offset.Valid {
			item["offset_sec"] = offset.Float64
		}
		groups = append(groups, item)
		ids = append(ids, id)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(groups) == 0 {
		return []map[string]any{}, nil
	}
	members := map[int64][]map[string]any{}
	mrows, err := db.QueryContext(ctx, `SELECT m.group_id, m.download_id, m.role, m.reason, d.file_name, d.file_size, d.file_path, d.file_hash, d.file_type, vf.duration_sec, CAST(d.created_at AS TEXT), d.pinned
		FROM similar_group_members m JOIN downloads d ON d.id=m.download_id
		LEFT JOIN video_fingerprints vf ON vf.download_id=d.id
		ORDER BY m.group_id, CASE m.role WHEN 'keep' THEN 0 WHEN 'remove' THEN 1 ELSE 2 END, m.download_id`)
	if err != nil {
		return nil, err
	}
	defer mrows.Close()
	for mrows.Next() {
		var gid, did int64
		var role string
		var reason, name, path, hash, kindName sql.NullString
		var size, pinned sql.NullInt64
		var dur sql.NullFloat64
		var created sql.NullString
		if err = mrows.Scan(&gid, &did, &role, &reason, &name, &size, &path, &hash, &kindName, &dur, &created, &pinned); err != nil {
			return nil, err
		}
		row := map[string]any{"group_id": gid, "download_id": did, "role": role, "reason": nullString(reason), "file_name": nullString(name), "file_size": nullInt(size), "file_path": nullString(path), "file_hash": nullString(hash), "file_type": nullString(kindName), "duration_sec": nullFloat(dur), "created_at": nullString(created), "pinned": pinned.Valid && pinned.Int64 != 0}
		members[gid] = append(members[gid], row)
	}
	if err = mrows.Err(); err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(groups))
	for i, g := range groups {
		list := members[ids[i]]
		if len(list) < 2 {
			continue
		}
		g["members"] = list
		out = append(out, g)
	}
	return out, nil
}

func AddIgnore(ctx context.Context, db execer, a, b int64, kind, note string) (int64, error) {
	if kind != "similar" && kind != "partial" && kind != "partial_review" {
		return 0, errors.New("invalid similar ignore kind: " + kind)
	}
	if a <= 0 || b <= 0 || a == b {
		return 0, errors.New("similar ignore pair requires two distinct download ids")
	}
	if a > b {
		a, b = b, a
	}
	var noteVal any
	if note != "" {
		noteVal = note
	}
	res, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO similar_ignores(a_id,b_id,kind,ignored_at,note) VALUES(?,?,?,?,?)`, a, b, kind, time.Now().UnixMilli(), noteVal)
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return res.LastInsertId()
	}
	var id int64
	err = db.QueryRowContext(ctx, `SELECT id FROM similar_ignores WHERE kind=? AND a_id=? AND b_id=?`, kind, a, b).Scan(&id)
	return id, err
}

func ListIgnores(ctx context.Context, db execer, kind string) ([]map[string]any, error) {
	q := `SELECT id, a_id, b_id, kind, ignored_at, note FROM similar_ignores`
	var args []any
	if kind != "" {
		q += ` WHERE kind=?`
		args = append(args, kind)
	}
	q += ` ORDER BY id DESC`
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, a, b, at int64
		var kindName string
		var note sql.NullString
		if err = rows.Scan(&id, &a, &b, &kindName, &at, &note); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "a_id": a, "b_id": b, "kind": kindName, "ignored_at": at, "note": nullString(note)})
	}
	return out, rows.Err()
}

func DeleteIgnore(ctx context.Context, db execer, id int64) (bool, error) {
	res, err := db.ExecContext(ctx, `DELETE FROM similar_ignores WHERE id=?`, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func PurgeRecords(ctx context.Context, db *sql.DB) (map[string]int, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	counts := map[string]int{}
	for _, item := range []struct{ key, table string }{{"fingerprints", "video_fingerprints"}, {"groups", "similar_groups"}, {"partialScans", "similar_partial_scans"}} {
		var n int
		if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+item.table).Scan(&n); err != nil {
			return nil, err
		}
		counts[item.key] = n
	}
	for _, table := range []string{"video_frame_hashes", "video_fingerprints", "similar_groups", "similar_partial_scans", "similar_video_scans"} {
		if _, err = tx.ExecContext(ctx, `DELETE FROM `+table); err != nil {
			return nil, err
		}
	}
	if err = clearKV(ctx, tx, "similar_last_scan", "similar_last_analyze", "pending_job_similarScan", "pending_job_similarAnalyze"); err != nil {
		return nil, err
	}
	return counts, tx.Commit()
}

func PurgeAnalyze(ctx context.Context, db *sql.DB) (map[string]int, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	counts := map[string]int{}
	for _, item := range []struct{ key, table string }{{"groups", "similar_groups"}, {"videoScans", "similar_video_scans"}, {"partialScans", "similar_partial_scans"}} {
		var n int
		if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+item.table).Scan(&n); err != nil {
			return nil, err
		}
		counts[item.key] = n
	}
	for _, table := range []string{"similar_groups", "similar_partial_scans", "similar_video_scans"} {
		if _, err = tx.ExecContext(ctx, `DELETE FROM `+table); err != nil {
			return nil, err
		}
	}
	if err = clearKV(ctx, tx, "similar_last_analyze", "pending_job_similarAnalyze"); err != nil {
		return nil, err
	}
	return counts, tx.Commit()
}

func clearKV(ctx context.Context, tx *sql.Tx, keys ...string) error {
	now := time.Now().UnixMilli()
	for _, key := range keys {
		if _, err := tx.ExecContext(ctx, `INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, key, "null", now); err != nil {
			return err
		}
	}
	return nil
}

func PutKV(ctx context.Context, db execer, key string, value string) error {
	_, err := db.ExecContext(ctx, `INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, key, value, time.Now().UnixMilli())
	return err
}

func GetKV(ctx context.Context, db execer, key string) (string, bool, error) {
	var value string
	err := db.QueryRowContext(ctx, `SELECT value FROM kv WHERE key=?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return value, err == nil, err
}

func PairKeyFromMembers(members []map[string]any) string {
	if len(members) < 2 {
		return ""
	}
	a, _ := members[0]["download_id"].(int64)
	b, _ := members[1]["download_id"].(int64)
	if a == 0 {
		a = int64From(members[0]["download_id"])
		b = int64From(members[1]["download_id"])
	}
	if a <= 0 || b <= 0 {
		return ""
	}
	return PairKey(a, b)
}

func int64From(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	case string:
		i, _ := strconv.ParseInt(n, 10, 64)
		return i
	default:
		return 0
	}
}

func nullString(v sql.NullString) any {
	if !v.Valid {
		return nil
	}
	return v.String
}
func nullInt(v sql.NullInt64) any {
	if !v.Valid {
		return nil
	}
	return v.Int64
}
func nullFloat(v sql.NullFloat64) any {
	if !v.Valid {
		return nil
	}
	return v.Float64
}
