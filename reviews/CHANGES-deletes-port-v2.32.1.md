# Deletes: port of remaining `enhancement` fixes to `enhancement-v2.32.1`

Follow-up to `CHANGES-716a55e1-to-enhancement.md` §5 (Deletes, dedup, and disk accounting). That review compared the old `enhancement` branch's delete and dedup work against the current `enhancement-v2.32.1` base. Upstream v2.32.1 already closed the shared-path unlink, the duplicates listing, the `/files` missing-file prune, and the disk-quota counter. This records what is left, and how each piece is closed without bringing `downloads.user_deleted` back.

Files touched: `src/core/db.js`, `src/core/dedup.js`, `src/core/cluster/sweep.js`, `src/core/nsfw.js`, `src/web/server.js`, `tests/download-tombstone.test.js`.

`CHANGELOG.md` is intentionally not touched.

---

## Already on v2.32.1 — not ported

- **Shared paths.** Hash-dedup can store two rows against one file. `idsWithFileInUse` (`src/core/dedup.js`) keeps the file when another row still uses it. Gallery bulk delete, `DELETE /api/file`, dedup delete, the disk rotator, rescue, and cluster conflict resolution all use it. Enhancement's `liveIdsSharingFilePath` is the same check under the soft-delete model.
- **`/files` 404.** `pruneMissingDownload` hard-deletes every row with that `file_path` and cascades faces, embeddings, tags, seekbar rows, and backup jobs. It skips the prune when the parent folder is missing. The integrity sweep still removes stragglers, and an automatic run refuses to prune when more than half the library looks missing.
- **Duplicates listing.** `GET /api/maintenance/dedup/sets` already returns `buildDuplicateSets()` and the duplicates page already calls it.
- **Disk quota.** `getDiskUsage()` still keeps the on-disk counter, and about once a minute pulls it down to `getTotalSizeBytes()` when the catalogue sum is smaller. Enhancement's direct `SUM(file_size)` quota check is not ported: that sum counts a shared file once per row. `decrementDiskUsage` is not added back.
- **Side rows on delete.** `faces`, `image_embeddings`, `image_tags`, `seekbar_sprites`, and `backup_jobs` are `ON DELETE CASCADE`. Hard delete removes them. Enhancement deleted them by hand because the download row stayed. `purgeSoftDeletedArtifacts()` is not ported.

Cluster conflict resolution still runs `DELETE FROM downloads`. The unlink in front of it is already conditional. It does not go back to a soft-delete through `deleteDownloadsBy`.

---

## 1. Face crop of a missing source

`/api/ai/person/:id/face` and `/api/ai/faces/:id/crop` return 404 when the source file is gone and leave the download and the face row in place. The People avatar query always picks the highest-quality face, so a missing source 404s on every request until the integrity sweep, and a lower-quality face whose file is still there is never used.

- Both handlers, on `safeResolveDownload` reason `missing` only, await the existing `pruneMissingDownload(row.file_path)` before the 404.
- That is the same hard-delete as a `/files` 404, including the unmount guard. It does not write a tombstone, so a file that vanished from disk can still be fetched from Telegram.

---

## 2. Re-download guard, without `user_deleted`

`enqueue()` skips a message only when `isDownloaded()` finds a `downloads` row. Catch-up and pull-older use `MIN` / `MAX(message_id)` from that same table. A hard delete drops the id, so the message comes back when disk rotation removes the oldest rows (the next pull-older starts at the new minimum), when the newest rows are deleted (catch-up, on by default, once the gap is at least 5), or when a rescan walks that range. A hole in the middle stays a hole. A live new-message event does not replay an old message.

The column is not ported. A row left in `downloads` would need a `user_deleted = 0` filter on every gallery, search, count, quota, and faststart query. v2.32.1 already removes the row.

- New table `download_tombstones`: `group_id TEXT NOT NULL`, `message_id INTEGER NOT NULL`, `created_at INTEGER NOT NULL`, primary key `(group_id, message_id)`. Created in `initSchema`.
- `rememberDeletedDownloads(ids)` selects `group_id, message_id` and `INSERT OR IGNORE`s them inside the delete transaction, before the `DELETE`.
- Called from `deleteDownloadsBy` (gallery bulk delete, disk rotation, rescue expiry), `deleteByIds` (duplicates), cluster conflict resolution, `DELETE /api/file`, `POST /api/cluster/files/delete`, and the NSFW blocklist auto-delete (using the `group_id` / `message_id` that path already loads).
- Not called from the integrity sweep, `pruneMissingDownload`, `deleteGroupDownloads`, or `deleteAllDownloads`. A missing file can be fetched again. Wiping a group or the library can be filled again on purpose.
- `isDownloaded` is true when either `downloads` or `download_tombstones` has that pair.
- `getMessageIdRange` takes `MIN`, `MAX`, and `COUNT` over the union of both tables. `count === 0` stays "this group has never been seen", so a group whose files were all deleted does not look like a first add. Catch-up and pull-older keep using the oldest and newest known message id, including tombstones.

---

## 3. Drop a leftover `user_deleted` column

Databases created on the old `enhancement` branch have `downloads.user_deleted`. This branch never reads it. Dropping the column alone would turn `user_deleted = 1` rows into normal downloads and put those files back in the gallery.

`initSchema` checks `PRAGMA table_info(downloads)`. When the column is present:

- Drop any `downloads` index whose `sqlite_master.sql` mentions `user_deleted`. SQLite refuses `DROP COLUMN` while an index references the column.
- Copy `user_deleted = 1` rows into `download_tombstones`.
- `DELETE` those download rows. Cascades clear their faces and other side rows.
- `ALTER TABLE downloads DROP COLUMN user_deleted`.

Rows with `user_deleted` 0 or null stay. A second boot finds no column and does nothing. A crash after the delete and before the drop retries the drop; those messages are already tombstoned. Fresh databases never have the column.

---

## Tests (`tests/download-tombstone.test.js`)

Same isolated `TGDL_DATA_DIR` pattern as `tests/db.test.js`.

- `deleteDownloadsBy` removes the row, `isDownloaded` stays true, and `getMessageIdRange` still reports that message id.
- A raw delete that does not call `rememberDeletedDownloads` leaves `isDownloaded` false.
- A database with `user_deleted` added by hand: the flagged row becomes a tombstone and disappears from `downloads`; an unflagged row remains; the column is gone; running the migration again is a no-op.

4/4 tests pass in `tests/download-tombstone.test.js`. `tests/db.test.js` (20), `tests/db-similar-clips.test.js` (11), and `tests/dedup-shared-files.test.js` (7) still pass.
