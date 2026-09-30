# Backup module: port of remaining `enhancement` fixes to `enhancement-v2.32.1`

Follow-up to `CHANGES-716a55e1-to-enhancement.md` §6 (Backup). That review compared the old
`enhancement` branch's backup work against the current `enhancement-v2.32.1` base and found
upstream commit `acbff01` had already carried most of it forward, except for five gaps. This
records those five gaps and how each was closed.

Files touched: `src/core/backup/manager.js`, `src/web/public/js/maintenance-backup.js`,
`src/web/public/index.html`, `tests/backup.manager.test.js`.

---

## 1. Cron only makes sense for snapshot mode

`mirror`/`manual` destinations don't run on a schedule, but the API/UI would still persist
whatever the (hidden) cron field last held.

- `_validateInput` (add): `cron` is forced to `null` unless `mode === 'snapshot'`.
- `updateDestination` (edit): switching a destination's mode away from `snapshot` now clears
  `cron` on the same update, instead of leaving a stale value in place.

## 2. Manual-mode destinations never got retention

`_applySnapshotRetention` (staging-file cleanup + remote prune to `retain_count` + counter
reconciliation) only ran for `mode === 'snapshot'`. Manual archives accumulated on the remote
forever.

- Both call sites in `Worker._runOne` now gate on `dest.mode === 'snapshot' || dest.mode === 'manual'`.
- `_applySnapshotRetention` no longer assumes a job with a local staging file — the unlink step
  is skipped when `job.snapshot_path` is falsy (needed for the boot-time pass below).

## 3. Retention backlog wasn't reconciled at boot

Lowering `retain_count`, or restarts after a version that didn't have retention, only got
trimmed on the *next* snapshot upload.

- New `_reconcileRetentionBacklog(dest)`: decrypts the destination's config, spins up its
  provider, and calls `_applySnapshotRetention` with no specific job — same list/prune/counter
  logic, just not tied to an upload.
- Wired into `init()`'s boot loop for every enabled `snapshot`/`manual` destination.

## 4. Mirror mode never cleaned up remote-side orphans

Deleting a download's DB row left its previously-mirrored remote copy behind forever — mirror
only ever added files, never removed them.

- New `_reconcileMirrorRemote(dest)`: builds the live set from
  `SELECT file_path FROM downloads WHERE file_path IS NOT NULL` (this codebase hard-deletes
  rows — no soft-delete column — so every remaining row is inherently live), lists the remote
  root, skips anything under `snapshots/` (a snapshot-mode destination may share the same
  root/bucket), and deletes whatever isn't in the live set.
- Called from `runBackup()`'s mirror branch after the catch-up enqueue; best-effort (a failure
  here doesn't fail the catch-up walk that already queued uploads). Return value now includes
  `reconciled: { listed, deleted }`.

## 5. Frontend cron leakage + missing coverage guidance

- Destination card showed the cron badge for any mode with a stored `cron`, including stale
  values left over from before fix #1. Now gated on `dest.mode === 'snapshot'`.
- The add/edit wizard's `collectAndValidate()` always submitted `#bk-cron`'s value (default
  `0 3 * * *`), even when the cron row was hidden for mirror/manual. Now only submits it when
  `mode === 'snapshot'`.
- Added a short info banner above the destinations list (`maintenance.backup.coverage_tip`)
  explaining that mirror only covers files downloaded after it's enabled, and recommending a
  paired snapshot destination for DB/config coverage and to catch anything mirror missed.

---

## Tests (`tests/backup.manager.test.js`)

- `'leaves manual destinations alone'` → rewritten as `'applies retention to manual
  destinations too'`, asserting pruning to `retain_count` and staging-file cleanup now happen
  for `manual` mode (this is an intentional behavior change, not a regression).
- Added `'Run now deletes orphaned remote files no longer backed by a download row'`: mirrors
  two files, deletes one download row, asserts the next `runBackup` removes only that file's
  remote copy and leaves a `snapshots/` sibling untouched.
- Added `describe('cron only applies to snapshot mode')`:
  - a new `mirror` destination never persists a submitted `cron`;
  - updating an existing `snapshot` destination to `mirror` clears its stored `cron`.

10/10 tests pass in `tests/backup.manager.test.js` (15/15 including `tests/backup.queue.test.js`).
