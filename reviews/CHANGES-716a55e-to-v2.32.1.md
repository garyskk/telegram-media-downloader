# Changes from `716a55e` to v2.32.1

Range: `716a55e1ccf5059098619dfd778364cda7c09374` (`chore(deps-dev): bump the development group with 2 updates (#56)`, 2026-06-14, package **2.24.5**) through `96088b8` (tip of `main`, package **2.32.1**).

That commit is an ancestor of `main`, so this is the full tree difference. 55 commits, 454 files, 158,052 insertions, 9,029 deletions. Patch file: `716a55e-to-v2.32.1.patch`.

Service worker cache key at the tip is `v2321`.

---

## 1. tgdl-core

New Go process `core-service/` (`module` path `github.com/botnick/telegram-media-downloader/core-service`, `go 1.22`, CGO off). Node starts it on `127.0.0.1` with a per-start token (`src/core/gocore/`). The Docker image compiles it to `/app/bin/tgdl-core`. Bare metal downloads the pinned release and checks `SHA256SUMS`, or builds it when Go is installed (`npm run install:core`, `postinstall`). `TGDL_CORE_SKIP_INSTALL=1` skips the download. `TGDL_CORE_BIN` forces a path. `TGDL_CORE_ALLOW_ROOTS` adds folders it may read. `TGDL_CORE_RELEASE_URL` is a download mirror.

### Phase 1 (shadow hashing)

- First job is SHA-256 for download-time dedup, the duplicate scan, and the NSFW hash blocklist.
- Shipped in shadow: Node’s hash is the one stored. About 1 in 20 files up to 256 MB is hashed again by Go and compared.
- Paths outside the download roots stay on Node.
- Missing binary, unsupported platform, crash, or timeout keeps the Node worker pool.

### Phase 2 (required)

- Hashing, Verify files, the boot and hourly integrity sweep, Re-index from disk, the empty-library disk-usage figure, and face clustering (DBSCAN) run only in Go.
- Removed: `src/core/hash-worker.js`, the Node `fs.stat` sweep, the folder walks, and the DBSCAN worker.
- `TGDL_GO_CORE`, `TGDL_GO_FEATURES`, `config.advanced.goCore`, and `HASH_WORKER_DISABLE` are ignored. A saved `advanced.goCore` block is dropped on the next settings save.
- If the binary cannot run, the app still starts. Verify files, Re-index, Find duplicates, and Re-cluster answer `503 TGDL_CORE_UNAVAILABLE`. A finished download is stored without a hash. The integrity sweep removes nothing.
- `GET /api/system/health` → `goCore` loses `mode` / `modeSource` and the shadow counters. It gains `problem`, `platform`, and `features.<hash|stat|walk|dbscan>.available`.
- `/metrics`: `tgdl_gocore_parity_*` is gone. `tgdl_gocore_calls_total` also counts `stat`, `walk`, and `dbscan`.
- `scripts/bench-gocore.js` compares the old Node paths with Go (wall time and event-loop delay).
- Release builds add `linux-arm` (ARMv7) and `mac-x64`. Tags are `core-vX.Y.Z` and are not marked Latest.
- A dashboard banner shows the same text as `goCore.problem` when the binary is missing, failed to download, is the wrong platform, or keeps crashing.

Face clustering uses every core. Folder walks are the recursive `fs.readdir` + `fs.stat` the integrity job used, streamed. `fs.stat` batches are up to 1000 paths. Error codes match what Verify files used before it deletes a row (tested against the removed Node code and against Node’s own `fs` on the machine the tests run on).

---

## 2. Front server (media bytes)

From 2.31.0, `tgdl-core` binds `PORT`. It serves media itself and proxies everything else to Node on loopback. From 2.32.0 (0.4.0) it also answers the cases it used to hand back:

- `412` for `If-Match` / `If-Unmodified-Since` (those used to be 500).
- `416` with `Content-Range: bytes */<size>`, no content type, validators, or long cache lifetime.
- Ranges, symlinks inside the allowed roots, a missing file (`404`), and a session inside its renewal window.
- A dotfile or a directory under `/files` is `404 File not found`.

Go never writes the database. It tells Node afterwards: extend a session, or prune and broadcast a missing file. A media response in the renewal window carries no `Set-Cookie`; the next dashboard request renews the cookie. Inline HEIC stays a Node sharp transform that Go proxies.

Removed from Node: the local `/files` branch, `/photos` serving, the thumbnail cache-hit fast path, and the `X-Tgdl-Accel` hand-back.

The allow path only answers when it is sure. A cookie or file token inside a 5 s / 2 s expiry margin, a query Go cannot reproduce the way Express would, or a trust-proxy value it cannot compile is proxied to Node. `rawtarget.go` rewrites a stray `%` in the request line so Go’s parser does not answer a bare 400 for a target Node used to handle. The original target travels in a header whose name has a per-process random suffix.

File tokens are `<exp>.<base64url HMAC>`. The role (`admin` or `guest`) is part of the HMAC. Tokens minted before role binding (`filetoken|<exp>`, v2.24.5 and older) still verify as guest until they expire.

---

## 3. Integrity, deletes, duplicates, and disk quota

### Integrity sweep

- An unreadable downloads folder skips the sweep. Only `ENOENT` / `ENOTDIR` count as missing.
- An automatic run refuses to prune when more than half the library looks missing. Maintenance → Verify files still prunes on demand.
- Federated-dedup paths (`_clusterref/…`) and a custom `download.path` outside `data/downloads` are kept.
- Pruning yields between chunks. One transaction used to block the server long enough to fail the Docker healthcheck at large libraries.
- A gallery 404 does not drop the download when the file’s whole folder is missing.

### Shared files

- Download-time dedup can store two rows against one path. The file is unlinked only when no remaining download uses it.
- That check is on gallery delete, Duplicates, NSFW review, group delete, the disk rotator, Rescue, and cluster conflict / peer delete.
- `DELETE /api/file` removes the row for that path (or that id, when the SPA sends one). It no longer deletes every row with the same file name.
- With an id, only that download is removed, and the file stays while another download still uses it. Bulk delete sends every selected tile id that shows the same file.

### Duplicates page

- The status payload includes the found sets and stops reporting `running: true` after the scan finishes.
- The finder lists one entry per physical copy and does not report downloads that already share one file.
- After a restart the list is rebuilt from stored hashes instead of staying empty until a full re-scan.

### Disk quota

- The downloader’s usage counter only ever increased, so a library that had downloaded `maxTotalSize` over its lifetime stayed over quota after deletes. The check now also reads the catalogue total (about once a minute) and pulls the counter down. A file shared by several downloads still counts once.

---

## 4. Security

- NSFW path mode is default-deny. With `TGDL_NSFW_ALLOW_ROOTS` unset, a path is 403 and the app falls back to uploading bytes. Decoder errors are logged, not returned. The sidecar listens on `0.0.0.0`.
- `queue_backlog` stored serialised jobs that included the gramJS client (API hash and auth key). The spillover is removed. On boot the table is dropped with `secure_delete` so the pages are zeroed. The history walker already bounds the queue.
- File tokens carry the minting session’s role. `GET /api/files/token` stays on the guest allowlist. `/files/?peer=` uses the role in the HMAC, so a guest token is not treated as admin.
- Guest WebSocket clients get the guest statistics payload, the same split as `GET /api/stats`.
- `GET /api/config` returns `apiTokenSet`, `web.shareSecretSet`, `web.guestPasswordHashSet`, and `proxy.passwordSet` instead of the secrets. A save that omits them keeps the stored values. `/api/maintenance/config/raw` redacts the same fields, including `advanced.seekbar.apiToken` and `advanced.ai.faces.sidecarToken`.
- `GET /api/update/status`, `/api/auto-update/status`, and `/api/update/history` require a session. Job status and history are admin-only. Guests keep the capability probe the status bar reads. `POST /api/update` already required an admin (2.29.1).
- `DELETE /api/purge/all` requires `{"confirm":"DELETE ALL"}`. Anything else is `400 {code:"CONFIRM_REQUIRED"}` and touches nothing.
- Re-authentication requires the admin password. Saving a group no longer broadcasts secrets to every dashboard, guests included. The API rate limit applies from boot.
- Sidecar URL probes parse the URL, reject embedded credentials and inputs over 2048 characters, and trim trailing slashes without a quadratic regex.
- `LIKE` patterns escape `\`, not only `%` and `_`, so a folder rename cannot rewrite another folder’s `file_path` rows.
- seekbar-service 0.4.0: with `SEEKBAR_API_TOKEN` set, `/sprite/{id}` and `/meta/{id}` need the token (`SEEKBAR_PUBLIC_MEDIA=true` leaves them open). `SEEKBAR_ALLOW_ROOTS` limits path mode; a path outside is “source not found” and the app uploads. Both sidecars warn when they listen beyond localhost without a token.
- Faces token is sent as `X-API-Token`, not `Authorization: Bearer`, so it does not clash with a reverse proxy’s own auth.
- `telegram-notify.yml` runs with an empty `GITHUB_TOKEN` permission set.
- Legacy cluster token (section 5) no longer authenticates an unknown peer id.

---

## 5. Cluster

- `verifyRequest` still tries the per-pair secret first, then the legacy global token. With `pairedOnly` (the server’s peer gate), the legacy token is added only when `X-Peer-Id` already has a peers row. The handshake route still passes its token as `expectedToken`.
- Pairing codes are signed with a key derived from the code alone. The receiver checks that against codes it issued, and still accepts the old token-derived key from a peer that holds the same token. Two installs with different cluster tokens can pair with a code. Both peers need this version. An older peer still refuses codes, and the dashboard says so. Token pairing is unchanged.
- `POST /api/cluster/sign-url` stored expiry in milliseconds and signed it in seconds, so every direct-stream URL was `401 bad_sig`. It now stores seconds and returns `exp`. An older peer that omits `exp` is streamed through the proxy instead of a URL that cannot verify.
- A thumbnail request used to answer a JSON description labelled `image/webp`. It sends the WebP. An older peer’s thumbnail shows the placeholder.
- Catalog sync, `/ws/cluster`, LAN discovery, and the failover watcher start at boot when a peer is paired, after a pairing, and when a paired peer connects. An install with no paired peer starts none of them. A failed dial is not “seen” (that blocked failover) and does not schedule two reconnects.
- The relay builds `{ type: 'monitor_event', ... }` explicitly. Engine events on the dashboard socket stay under their own type (`download_start`, `download_progress`, and the rest) with data in `payload`.

---

## 6. External sidecars

NSFW, seekbar, and faces can run on another machine: URL, optional API token, optional path map (`app path=sidecar path`). Test reports reachability, version, whether the token is accepted, and how files will be sent. Env wins over the dashboard and applies without a restart.

| Sidecar | URL | Token | Path map |
|---|---|---|---|
| NSFW | `TGDL_NSFW_SIDECAR_URL` | `TGDL_NSFW_API_TOKEN` | `TGDL_NSFW_PATH_MAP` |
| Seekbar | `SEEKBAR_SIDECAR_URL` | `SEEKBAR_API_TOKEN` | `SEEKBAR_PATH_MAP` |
| Faces | existing faces URL | `TGDL_FACES_SIDECAR_TOKEN` / `TGDL_FACES_API_TOKEN` on the sidecar | `TGDL_FACES_PATH_MAP` |

- When the sidecar cannot read the file, NSFW images upload from memory (over 1.5 MB, downscaled to 1024 px first). A video no longer switches every later photo to base64 for the rest of the session. A photo the sidecar allowed but could not find is sent, not stored with an empty score.
- Seekbar videos upload in 32 MB chunks. The sprite is downloaded back into the app’s `data/seekbar`. A remote path is not stored as the sprite path. A sidecar that is down at startup is re-checked every 30 s.
- Faces requests stay inside about a 40 MB body. A large photo is sent as a 4096 px copy and face boxes are scaled back. Video frames are grouped by size. Raw `/detect/upload` on faces-service 0.5.1; older sidecars still get base64.
- `https://` and path-prefixed URLs work for health probes. A dropped connection behind a path prefix retries the prefixed health URL.
- nsfw-service 1.2.0 and seekbar-service 0.4.0 go with this. Older sidecars keep working: NSFW 1.1.0 gets base64 and no token; seekbar 0.3.3 is used when it can read the path, and the app’s ffmpeg does the rest.
- Compose `FACES_SERVICE_URL=http://tgdl-faces:8011` no longer points a stock install at a container that is not running. If that host does not resolve, the app auto-spawns the sidecar inside its own container and re-checks when a scan starts. A custom URL is unchanged.
- Auto-spawn starts only when AI and face clustering are both on. It keeps one core free and runs at `TGDL_FACES_SIDECAR_NICE` (default 10). It relaunches immediately if it exits.

---

## 7. Faces

- faces-service 0.5.0 is the bundled sidecar. Embeddings stay compatible with existing People groups. CPU inference threads follow the container limit, idle spinning is off, unused models are not loaded, and faces below the keep threshold are dropped before the embedding models. EXIF orientation is applied once.
- A scan stamps “no faces” only after the sidecar answered for that file. Connection errors, timeouts, 5xx, and “model still loading” leave the row unscanned. While the sidecar is down the scan waits (`TGDL_FACES_SIDECAR_WAIT_MS`, default 5 min), then stops and resumes later. A file that keeps crashing the sidecar is retried, then skipped for that run.
- New downloads made while the sidecar is down are left for the next scan.
- Videos longer than the old 300 s Node fetch cap use an undici client whose timeouts sit above the scan deadline.
- Split-disk installs (`TGDL_DOWNLOADS_DIR`) resolve against the configured downloads directory.
- `cpuThrottleRatio: 0` is honoured. `TGDL_FACES_CPU_THROTTLE_RATIO` is read.
- Split accepts `newLabel` and `label`.
- Face crops are cached under `thumbs/face-crops/`, at most `TGDL_FACE_CROP_CONCURRENCY` (default 4) at a time. The People grid loads 4 at a time. Video faces crop from the stored frame time. Avatar URLs carry a version so a merge, split, or reassign is not stuck on a cached cover.
- People sort is server-side: `GET /api/ai/people?sort=&dir=` (`face_count`, quality, name). Unnamed people sort first ascending and last descending. The first 2,000 clusters are no longer the whole sort.
- DBSCAN moved off the event loop (section 1). The expansion queue adds each face once.
- The next scan batch does not walk every already-scanned row. `/api/ai/status` no longer full-scans the table on every refresh.
- Sidecar unpack on Windows runs tar inside the target folder. The fallback extractor parses the stream in order.
- `faces-openvino` profile is removed (the image was never published). `faces-cuda` images are published by the release workflow.

---

## 8. NSFW

- Local inference and image decode run in a worker thread (`src/core/nsfw-worker.js`). onnxruntime-node on the main thread blocked HTTP long enough for autoheal to restart the container.
- Photos are resized by sharp to the model input before inference and classified in batches. Video sprites are decoded once. Inference threads default to half the CPU count, max 8 (`TGDL_NSFW_THREADS`).
- The model is released after 5 minutes idle.
- `advanced.nsfw.dtype` is applied. Scans used to ignore it and always load `q8`.
- `scripts/pre-download-models.js` exists (it was referenced since v2.15 and missing). The Docker build does not run it: `/app/data` is hidden by the bind mount. Seed with `docker compose exec -u node telegram-downloader npm run pre-download-models`.
- The hash-blocklist check hashes through the same path as the downloader (Go, once phase 2 is on).

---

## 9. Backend performance and HTTP

- `compression` is a real dependency. Raw file routes (`/files/`, `/share/`, `/photos/`, the cluster file bridge), Range requests, and media types are not compressed. `COMPRESSION_LEVEL=0` turns it off.
- WebSocket `download_progress`, `history_progress`, `queue_length`, and `queue_changed` coalesce in 500 ms windows. A client more than 1 MiB behind skips progress frames. If it would miss a state change it is disconnected and the dashboard re-syncs. A 30 s ping drops sockets that miss a pong. Held frames go out before the messages that depend on them.
- The Engine card and the status bar render from `monitor_status_push` (every 3 s) and a debounced `stats_update` instead of refetching on every event.
- Hidden pages do not rebuild. The Queue page updates the badge until it is visible. Finished and failed jobs in memory are capped at the newest 500. The Logs view appends only while visible. The Cluster peer poll stops when you leave the page.
- `UV_THREADPOOL_SIZE=16` in the image, `runner.js`, `runner.sh`, and the PM2 file. Default image-thumb concurrency is 4 (`THUMBS_IMG_CONCURRENCY`). `express.static` does not `stat` `/api/*` and `/files/*`.
- Thumbnail responses use `private, max-age=3600, stale-while-revalidate=2592000`.
- “No photo” avatar lookups are remembered for 1 hour. A chat every connected account reports as not found is remembered for 10 minutes. FLOOD_WAIT, timeouts, and connection errors are not cached. Refresh photos, group-name refresh, and saving a group ask Telegram again.
- `/api/groups` and `/api/downloads` return a stale name cache immediately and refresh in the background, accounts in parallel. First boot waits at most 2 seconds. The per-group aggregate is cached for 15 seconds and dropped on the same events as the footer stats.
- Gallery bulk delete resolves paths through `idx_file_path` and prefers tile ids.
- Module preloads are bare URLs so the server stamps them. `settings.js` and `backfill.js` load on first visit. The first route renders once auth and groups are known.
- The monitor status pulse animates `transform` / `opacity` and respects `prefers-reduced-motion`.
- Malformed JSON is `400 {"error":"Malformed JSON body"}`. A body over 2 MB is `413`. An unsupported charset or encoding is `415`. A bare `null` or string is treated as malformed.
- A Range the file cannot satisfy is `416` on `/files/*`, `/share/*`, the cluster file bridge, and the other file streams. `/share` does not count it as an access.
- `advanced.share.rateLimitMax` and `rateLimitWindowMs` apply to `/share/*` from startup and after a save, and are re-read every 30 seconds.

---

## 10. Dashboard

### Layout (2.28.0)

- Four places on the desktop sidebar and the phone bottom nav: Library, Chats, Queue, Settings.
- Backfill is a tab of Chats. Maintenance is Tools under Settings, in four groups: Library health, Safety & AI, Backup & sync, System. Old hashes still work (`#/backfill`, `#/maintenance`, `#/maintenance/<tool>`).
- Settings has a side table of contents on wide screens. Phones keep the search box and chips. The scroll offset follows the real bar height.
- `maintenance-hub.js` is deleted. Tools cards show status, a run / stop button, and Open.

### Gallery and queue (2.27.0)

- Search above the type tabs matches file name or chat name (FTS prefix, then substring). `/` focuses the page search. `Esc` clears it. `GET /api/downloads/search` accepts `type`, `pinned`, `pinnedFirst`, and `order=newest`.
- One Sort & filter sheet: type, order (newest / pinned first / pinned only), layout (grid / compact / list). The saved “pinned first” preference is the default.
- Queue opens on Active (downloading, queued, paused). The old Active chip is Downloading. `#/queue/<filter>` still works. Pause all, Cancel queued, and the speed limit live in the toolbar menu on narrow windows.
- Press-and-hold selects a tile. Select all covers loaded files of the view, then “Select all N” up to 5,000. The selection bar is one place for ZIP, Pin, and Delete.
- Pull-to-refresh uses touch events. The gallery window keeps about 400 tiles on phones; scrolled-away rows become a spacer of the measured height. Time-section headers stay on row boundaries.
- Returning to Library keeps the grid, filter, and scroll when the chat, type, pinned mode, and cluster scope did not change.
- `100dvh` / `dvh` with a `vh` fallback, `viewport-fit=cover`, and safe-area padding. `theme-color` follows the app theme.
- Viewer: pinch and double-tap zoom, wheel zoom toward the cursor, pin from the action bar, swipe and drag-to-close on the media panes. Buffering follows `waiting`, not `stalled`, with a 200 ms delay mid-playback. The empty preview strip is gone. Delete removes by identity and advances. Android Back, browser Back, and the iOS edge swipe close the top overlay first.

### Chat details, Add sheet, palette (2.28.0)

- A chat’s settings are `#/groups/<id>`, not a dialog. Changes save on their own. The Chats list does not reload. A chat that is not in the list yet can be opened; the first change adds it.
- Chats list rows have a Monitor switch and Backfill. Coming back keeps search and scroll.
- Add sheet: a name, `@username`, or `t.me` link (public, private, invite, message). Monitor on adds the chat with photos and videos. Paste several links, Stories, Add account, and Browse chats are under More.
- `#/account/add` is a wizard over the page: phone, code, 2FA if needed, then chats to monitor. A wrong code, phone, or password returns once. Cancel stops the sign-in on the server. `add-account.html` still works and tells the running engine about the new account.
- Ctrl/⌘+K searches pages, tools, settings, chats, and actions. `/` still focuses the page’s own search.
- Backfill from a chat is one sheet: how far back, Start, live progress, Stop. A backfill already running for that chat is followed instead of rejected. “All history” still confirms. Limited backfills do not ask twice.
- `#/viewer/<chat>` is the chat gallery address. `#/viewer` stays All Media. Reload no longer drops you on All Media.
- `POST /api/downloads/pin` pins or unpins up to 5,000 ids in one request (`{ids, pinned}`, admin). The SPA sends batches of 1,000.
- Release notes (version in the status bar) are one card per version. The viewer revalidates `CHANGELOG.md` on every open so a freshly updated dashboard does not keep an hour-old copy. Maintainer-only lines (empty Unreleased heading, service-worker versions) are hidden.

### Content-Security-Policy

- Settings → Dashboard security edits `web.csp`: enable, report-only, and the source list per directive. Applied on the next request. Installs without a saved policy keep the previous header.
- Changing `frame-ancestors` drops `X-Frame-Options`.
- `TGDL_CSP=off` disables the header regardless of the saved policy.

Tailwind is a committed stylesheet (`npm run build:css`, `src/web/public/css/tailwind.css`). The Play CDN is gone. `tests/tailwind-css.test.js` fails CI when the committed CSS is stale.

---

## 11. Chats that cannot be reached

A chat no account can open is paused. Monitoring stays the operator’s setting and resumes when the chat is reachable again. Older `enabled:false` / `suspended` rows keep their setting, show the same badge, and lose those flags once they are reachable. Unresolved `unknown:` recovery entries are still auto-disabled.

States: Not a member, Banned, Private, Deleted, Restricted, Moved. Stored in `chat_access` (section 15) with Telegram’s code, first seen, last check, next check, and which accounts were asked. A flood wait or timeout at startup does not pause a healthy chat. Only a definite Telegram answer does.

Polling, live updates, the download queue, backfill, avatar and name lookups, Stories, and auto-forward skip a paused chat with a local check. Recheck is at most one chat a minute: after 1 hour, 6 hours, then daily. A dialogs refresh or a live message flips it back immediately. Adding an account rechecks them, one a minute.

UI: the same badge on the Chats list, sidebar, Add sheet, chat page, and Recovery. The chat page banner has Check again, Follow the new group (moved), Switch account, Stop monitoring, and Remove from list (the list entry only; files stay). Chats → Needs attention is `#/groups?tab=attention`. `POST /api/history` answers `409 CHAT_UNREACHABLE`. WebSocket: `chat_access_changed`.

Startup no longer asks Telegram about each chat twice, and the sidebar refresh does not re-resolve every chat because one name cannot resolve. The status bar keeps the last chat count when a stats push has no chat field.

---

## 12. Telegram sessions and downloads

- `data/session.enc` is connected only when `data/sessions/` has no account. A legacy connection is closed once accounts are loaded. Connecting both used one auth key on two sessions (`AUTH_KEY_DUPLICATED`).
- Adding an account from the dashboard does not retry a wrong code until `FLOOD_WAIT`. Cancelling the code step stops the server-side sign-in.
- gramJS’s in-memory peer set keeps one entry per peer. Discarded clients are `destroy()`’d, not only `disconnect()`’d.
- `LOCATION_INVALID` refetches the message and retries with the fresh media. If the message or media is gone, the job fails once with “Media no longer available on Telegram” instead of five retries of the stale location.
- The pause between history chunks is floored at zero. gramJS was passing a negative delay (`TimeoutNegativeWarning`).
- The update check reads up to 100 recent releases and picks the newest `vX.Y.Z`. Sidecar tags (`faces-v`, `nsfw-v`, `seekbar-v`, `core-v`) are not Latest, so they do not hide the app release.
- Failed backfill jobs leave memory after the same 5-minute grace as finished and cancelled jobs. They stay in the persisted history.

---

## 13. Backup, seekbar, and faststart

### Backup

- Mirror Run now walks the library in batches of 500 and yields, so it does not hold a SQLite cursor open while enqueueing on the same connection.
- A missing local file fails that one job. It does not retry five times and does not flag the destination. A successful Run now clears a stale error.
- Snapshot retention runs after the upload, only on `snapshots/snapshot-YYYYMMDD-HHMMSS.tar.gz`, logs listed / kept / pruned, and resets the destination’s file and size counts. The local staging copy is deleted once uploaded, not while another destination still has it queued. Leftover staging archives from older versions are not deleted.
- A cron minute matches once. Two ticks inside the same minute used to upload two archives.
- Editing a destination keeps secrets left blank. The form prefills the non-secret fields.

### Seekbar

- Long videos are submitted and polled. The budget is the video length, clamped between 5 and 60 minutes. Once the sidecar accepts the job, no local ffmpeg is started. A timeout or a forgotten job (sidecar restart) is retried by the next scan, not marked failed. Existing failed marks are cleared once on upgrade.
- JPEG sprites and a deleted sprite whose JSON is still present are fixed in seekbar-service 0.4.0. The app also avoids recording “done” when the sprite was not written (0.3.3).
- The dashboard URL and token are read. `SEEKBAR_SIDECAR_URL` is no longer the only source.

### Faststart

- A remux that fails with “Could not find tag for codec” retries once without data tracks (`-map -0:d`). Audio, video, and subtitles stay. Apple `mebx` timed metadata is dropped. A file that still fails three times is skipped until it changes. A failed rewrite does not leave a `.faststart.tmp`.

### Other

- Dropbox backups stream large files instead of holding up to 150 MB in memory. S3 and SFTP clients load only when such a destination is used.
- The libvips operation cache is off. The image sets `MALLOC_ARENA_MAX=2`.
- Idle hash workers are released after a minute (while the Node pool still existed; phase 2 removes that pool).

---

## 14. Updates (watchtower)

- The `watchtower` service is in the default `docker-compose.yml` (it already was in the Synology file). No profile. HTTP-API-only, no periodic polling unless `WATCHTOWER_HTTP_API_PERIODIC_POLLS=true`, no published ports, label-scoped (`com.centurylinklabs.watchtower.enable=true`).
- Image is `nickfedor/watchtower:1.22`. `containrrr/watchtower:1.7.1` fails on Docker Engine 29+ (`client version 1.25 is too old`). The fork negotiates the API version. The endpoint is `WATCHTOWER_HTTP_API_ENDPOINTS=update`.
- The app creates `data/watchtower/` at boot whenever `WATCHTOWER_URL` is set, including when the token comes from the environment (Synology refuses a bind mount whose source folder is missing). If `WATCHTOWER_HTTP_API_TOKEN` is empty, it writes `data/watchtower/api-token` once (`flag: 'wx'`, mode `0644`, 32 random bytes). The sidecar bind-mounts only that directory, read-only, and starts after the app is healthy. An env token overrides the file.
- The dashboard does not mount the Docker socket. The socket mount on watchtower is `:ro` (the inode). The Docker API over that socket can still create and stop containers; that is the update path.
- The pre-flight ping uses `GET /` (or any reply). `HEAD /v1/update` started a real pull and blew the 5 s timeout, so the button reported failure while the update continued. A trigger still pulling after 15 s counts as started.

---

## 15. Database

New or altered in `data/db.sqlite`:

| Object | Change |
|---|---|
| `chat_access` | One row per chat the app cannot open. `chat_id` primary key, `state`, `code`, `detail`, `migrated_to`, `first_seen_at`, `checked_at`, `next_check_at`, `checks`, `accounts`, `updated_at`. |
| `idx_file_path` | `downloads(file_path)`. Bulk delete, 404 prune, backup lookups. |
| `idx_group_name_size` | `downloads(group_id, group_name, file_size)`. Sidebar aggregate. |
| `idx_gallery_type_pinned_date` | `downloads(file_type, pinned DESC, created_at DESC, id DESC)`. |
| `idx_gallery_group_pinned_date` | `downloads(group_id, pinned DESC, created_at DESC, id DESC)`. |
| `queue_backlog` | Dropped. `secure_delete` is on for the drop, then off. |

Libraries over 50k rows build the four indexes in the background, starting 90 s after listen, one at a time, 45 s apart. A build killed mid-way is not retried automatically. The log names it. `npm run build-indexes` (or `node scripts/build-indexes.js`) builds it while the dashboard is stopped. Smaller and new libraries build them at startup.

---

## 16. HTTP API added or changed

### Chats

| Method | Path | Change |
|---|---|---|
| `GET` | `/api/chats/lookup?q=` | New. `@username`, `t.me` / `tg://`, invite, or message link. |
| `GET` | `/api/chats/access` | New. Access rows. |
| `POST` | `/api/chats/access/recheck` | New. One chat now, or all in the background. Admin. |
| `GET` | `/api/chats/access/recheck/status` | New. |
| `POST` | `/api/chats/access/stop` | New. Admin. |
| `POST` | `/api/chats/access/remove` | New. List entry only. Admin. |
| `POST` | `/api/chats/:id/follow-migration` | New. Admin. |
| `GET` | `/api/groups`, `/api/dialogs`, `/api/chats/lookup` | Rows include `access`. |
| `POST` | `/api/history` | `409 CHAT_UNREACHABLE` when the chat is paused. |

### Downloads and files

| Method | Path | Change |
|---|---|---|
| `GET` | `/api/downloads/search` | Optional `type`, `pinned`, `pinnedFirst`, `order=newest`. Returns `pinned` and `extension`. |
| `POST` | `/api/downloads/pin` | New. `{ids, pinned}`, admin, at most 5000 ids. |
| `DELETE` | `/api/file` | Deletes that path or that id. Does not unlink a file another row still uses. |
| `GET` | `/files/*`, `/photos`, thumbnail cache hits | Served by `tgdl-core`. Node no longer serves them. |
| file streams | | Unsatisfiable Range is `416`. |

### Auth, config, updates, purge

| Method | Path | Change |
|---|---|---|
| `GET` | `/api/config` | Secrets replaced by `*Set` booleans. |
| `GET` | `/api/update/status`, `/api/auto-update/status`, `/api/update/history` | Session required. Job status and history are admin-only. |
| `POST` | `/api/update` | Admin (2.29.1). |
| `DELETE` | `/api/purge/all` | Body must be `{"confirm":"DELETE ALL"}`. |
| `GET` | `/api/system/health` | `goCore` shape in section 1. |

### Cluster

| Method | Path | Change |
|---|---|---|
| `POST` | `/api/cluster/handshake` | Pairing-code signatures use the code-derived key. |
| `POST` | `/api/cluster/sign-url` | Expiry stored in seconds. Response includes `exp`. |
| peer file and thumbnail routes | | Thumbnail bytes, not a JSON description. Legacy token only for a paired peer id. |

### WebSocket

- `chat_access_changed`.
- Progress events coalesced (section 9). Shapes of the events themselves are unchanged.
- Guest connections receive the guest stats payload.

---

## 17. Configuration and environment

| Key / variable | Default | Role |
|---|---|---|
| `TGDL_CORE_BIN` | discovered | Use this `tgdl-core` and nothing else. |
| `TGDL_CORE_ALLOW_ROOTS` | | Extra folders the core may read. |
| `TGDL_CORE_RELEASE_URL` | GitHub release | Download mirror. |
| `TGDL_CORE_SKIP_INSTALL` | | Skip the npm postinstall download. Set in the Docker deps stage. |
| `TGDL_GO_CORE`, `TGDL_GO_FEATURES`, `HASH_WORKER_DISABLE` | | Ignored since 2.30.0. |
| `TGDL_CSP` | | `off` disables CSP regardless of `web.csp`. |
| `web.csp` | previous header | Saved CSP. |
| `TRUST_PROXY` | `loopback` | Compose sets `1`. |
| `WATCHTOWER_HTTP_API_TOKEN` | file `data/watchtower/api-token` | Overrides the generated token. |
| `WATCHTOWER_HTTP_API_PERIODIC_POLLS` | `false` | |
| `WATCHTOWER_URL` | `http://watchtower:8080` | Empty skips token setup. |
| `TGDL_NSFW_ALLOW_ROOTS` | unset = deny | Path mode allow-list. |
| `TGDL_NSFW_THREADS` | half the CPUs, max 8 | |
| `TGDL_NSFW_SIDECAR_URL`, `TGDL_NSFW_API_TOKEN`, `TGDL_NSFW_PATH_MAP` | | External NSFW. Env wins. |
| `SEEKBAR_SIDECAR_URL`, `SEEKBAR_API_TOKEN`, `SEEKBAR_PATH_MAP`, `SEEKBAR_ALLOW_ROOTS`, `SEEKBAR_PUBLIC_MEDIA` | | External seekbar. |
| `TGDL_FACES_PATH_MAP`, `TGDL_FACES_SIDECAR_TOKEN`, `TGDL_FACES_API_TOKEN` | | External faces. |
| `TGDL_FACES_SIDECAR_WAIT_MS` | `300000` | How long a scan waits for the sidecar. |
| `TGDL_FACES_SIDECAR_NICE` | `10` | `0` disables. |
| `TGDL_FACES_CPU_THROTTLE_RATIO` | | Read. `0` is kept. |
| `TGDL_FACE_CROP_CONCURRENCY` | `4` | |
| `THUMBS_IMG_CONCURRENCY` | `4` | |
| `COMPRESSION_LEVEL` | | `0` disables compression. |
| `UV_THREADPOOL_SIZE` | `16` in Docker / runners | Read by libuv at process start. |
| `MALLOC_ARENA_MAX` | `2` in the image | |
| `advanced.share.rateLimitMax`, `rateLimitWindowMs` | 60 per minute | Now applied to `/share/*`. |

`package.json` moves from 2.24.5 to 2.32.1. Dependencies: `@huggingface/transformers` ^4.3.0, `better-sqlite3` ^12.11.1, `helmet` ^8.3.0, `sharp` ^0.35.5, `compression` ^1.8.2, `undici` ^7.30.0, `ws` ^8.21.1, AWS SDK ^3.1097.0, `dropbox` ^10.38.0. Dev: Biome ^2.5.6, lefthook ^2.1.10, Tailwind ^3.4.19. Node image `24.18.0`. New scripts: `build-indexes`, `build:core`, `install:core`, `build:css`, `test:contract`, `test:contract:update`, `contract:inventory`, `contract:schema`. `postinstall` runs `install-core.js` and ignores a thrown error.

---

## 18. Docker, packaging, and CI

- Dockerfile gains a `gocore` stage (`golang:1.25-bookworm`, `CGO_ENABLED=0`, `--platform=$BUILDPLATFORM`) and copies `/app/bin/tgdl-core`. A `gocore-bin` scratch target exists for CI. Deps and runtime use `node:24.18.0-bookworm-slim`. `npm ci` sets `TGDL_CORE_SKIP_INSTALL=1`.
- `.dockerignore` ignores `core-service/bin` and `core-service/dist`.
- Entrypoint, as root before `gosu` drops to `node`: `chmod a+r` on `/etc/hosts`, `/etc/resolv.conf`, and `/etc/hostname`. Mode `0640` on those files caused `EAI_AGAIN` for the `node` user.
- `docker-compose.yml` drops the `auto-update` profile and the `faces-openvino` profile, and adds the idle watchtower service (section 14). Synology compose creates the same watchtower wiring.
- Workflows: `release-core-service.yml` and `release-nsfw-service.yml` added. Faces and seekbar release workflows publish GHCR images and do not mark those releases Latest. `telegram-notify.yml` permissions tightened. `release-drafter.yml` deleted. `ci.yml` and `docker.yml` cover the Go build and the contract suite.
- NSFW CPU image is slimmer. faces-service 0.5.0 and seekbar 0.4.0 Dockerfiles updated.
- `CODEOWNERS`, `CODE_OF_CONDUCT.md`, and `.gitattributes` added.

---

## 19. Localization and docs

- `en.json` and `th.json`: four-place nav, chat details, Add sheet, account wizard, palette, gallery search, sort and filter, Tools, chat-access badges, CSP, sidecar fields, release notes.
- New docs: `docs/GO-CORE.md`, `docs/GO-MIGRATION.md`, `docs/README.md`, `docs/llms.txt`, root `llms.txt`, `core-service/README.md`, `faces-service/CHANGELOG.md`, `nsfw-service/CHANGELOG.md`.
- GitHub Pages site under `docs/`: `_config.yml`, `index.html`, FAQ data, favicon, Open Graph image, screenshots of the v2.28 layout.
- Updated: `CHANGELOG.md` (Unreleased through 2.32.1), `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/AI.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOY.md`, `docs/CLUSTER.md`, `docs/BACKUP.md`, `docs/TROUBLESHOOTING.md`, `docs/AUDIT.md`, `.env.example`. Stale `faces-openvino`, `TGDL_GO_CORE`, and `TGDL_GO_FEATURES` flags are removed from the guides.
- 2.31.0’s Changed section in `CHANGELOG.md` repeats the Install-update and README bullets.

---

## 20. Tests added or expanded

`npm run test:contract` runs `tests/contract/` (its own Vitest config): a sandbox server, seeded SQLite, and snapshots per area (accounts, AI, auth, backup, chats, cluster, config, dedup, delete, downloads, files, groups, maintenance, monitor, NSFW, purge, queue, recovery, security, seekbar, share, static, system, telegram actions, thumbs, updates, WebSocket). `npm run test:contract:update` refreshes snapshots. Inventory lookup escapes every regex metacharacter in the identifier.

Go parity and front tests: `tests/gocore-*.test.js`, `tests/front-*.test.js`, `tests/helpers/gocore-*.js`, `tests/helpers/front-*.js`, `tests/fixtures/front-parity.json`, `tests/fixtures/gocore/`. Core unit tests live under `core-service/`.

Other new Node tests include chat access, cluster pairing, contract-finding regressions, CSP, security gates, security headers, HTTP compression and errors, NSFW client, sidecar remote, seekbar external and generator, shared-file sweepers, dedup delete, pin batch, gallery select, SWR cache, WebSocket broadcaster, legacy session guard, telegram session, tailwind CSS, docker entrypoint, downloader quota, faststart, and the faces external / spawn / scan-runner resilience tests. `tests/hash-worker.test.js` is deleted with the worker.

Expanded: `tests/db.test.js`, `tests/integrity.test.js`, `tests/share.test.js`, `tests/updater.test.js`, `tests/cluster.hmac.test.js`, `tests/cluster.e2e.test.js`, `tests/config-manager.test.js`, `tests/ai/faces-client.test.js`, `tests/ai/scan-runner-video.test.js`, `faces-service/tests/test_video.py`.

---

## 21. Files touched

### Added

Application and services:

- `core-service/` (cmd, internal `api`, `config`, `dbscan`, `front`, `fsx`, `hash`, `parent`, `version`, `go.mod`, `go.sum`, `README.md`)
- `src/core/gocore/` (`client.js`, `front.js`, `fs.js`, `hash.js`, `spawn.js`)
- `src/core/chat-access.js`, `src/core/nsfw-worker.js`, `src/core/sidecar-remote.js`, `src/core/telegram-session.js`, `src/core/ai/dbscan.js`, `src/core/ai/face-crops.js`
- `src/web/lib/` (`entity-lookup.js`, `front-bridge.js`, `http-compression.js`, `http-errors.js`, `security-headers.js`, `swr-cache.js`, `ws-broadcaster.js`)
- `src/web/public/js/` (`account-wizard.js`, `add-sheet.js`, `chat-access.js`, `chat-details.js`, `command-palette.js`, `core-banner.js`, `gallery-toolbar.js`, `nav.js`, `overlay-history.js`, `settings-search.js`, `sidecar-ui.js`, `tools-catalog.js`, `tools-hub.js`)
- `src/web/public/css/tailwind.css`
- `scripts/build-core.js`, `scripts/install-core.js`, `scripts/build-indexes.js`, `scripts/pre-download-models.js`, `scripts/bench-gocore.js`, `scripts/bench-front.js`, `scripts/front-parity.js`, `scripts/gen-front-conformance.js`, `scripts/gen-front-mime.js`, `scripts/tailwind.config.cjs`, `scripts/tailwind.input.css`, `scripts/contract-*.mjs`, `scripts/bench/burn-hook.mjs`
- `.github/workflows/release-core-service.yml`, `.github/workflows/release-nsfw-service.yml`, `.github/CODEOWNERS`
- `docs/GO-CORE.md`, `docs/GO-MIGRATION.md`, `docs/README.md`, `docs/llms.txt`, `llms.txt`, `docs/_config.yml`, `docs/index.html`, `docs/_data/faq.yml`, `docs/_includes/head_custom.html`, `docs/assets/`, `docs/screenshots/`
- `CODE_OF_CONDUCT.md`, `.gitattributes`
- `faces-service/CHANGELOG.md`, `faces-service/tests/test_perf_paths.py`, `faces-service/tests/test_upload.py`
- `nsfw-service/CHANGELOG.md`, `nsfw-service/tests/test_main.py`
- `seekbar-service/internal/api/server_test.go`, `seekbar-service/internal/worker/pool_test.go`

`tests/contract/` (harness, inventory, fixtures, per-area contract tests, snapshots) and the other new test files in section 20.

### Deleted

- `.github/release-drafter.yml`
- `src/core/hash-worker.js`
- `src/web/public/js/maintenance-hub.js`
- `tests/hash-worker.test.js`

### Modified (every remaining path in the diff)

`.dockerignore`, `.env.example`, `.github/workflows/ci.yml`, `.github/workflows/docker.yml`, `.github/workflows/release-faces-service.yml`, `.github/workflows/release-seekbar-service.yml`, `.github/workflows/telegram-notify.yml`, `.gitignore`, `CHANGELOG.md`, `CONTRIBUTING.md`, `Dockerfile`, `README.md`, `SECURITY.md`, `biome.json`, `docker-compose.synology.yml`, `docker-compose.yml`, `docs/AI.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/AUDIT.md`, `docs/BACKUP.md`, `docs/CLUSTER.md`, `docs/DEPLOY.md`, `docs/MIGRATION-v2.9-to-v2.10.md`, `docs/TROUBLESHOOTING.md`, `ecosystem.config.cjs`, `faces-service/Dockerfile`, `faces-service/Dockerfile.arm64`, `faces-service/Dockerfile.cuda`, `faces-service/README.md`, `faces-service/pyproject.toml`, `faces-service/tests/test_video.py`, `faces-service/tgdl_faces/__init__.py`, `faces-service/tgdl_faces/app.py`, `faces-service/tgdl_faces/insight.py`, `faces-service/tgdl_faces/io.py`, `lefthook.yml`, `nsfw-service/Dockerfile`, `nsfw-service/Dockerfile.gpu`, `nsfw-service/main.py`, `package-lock.json`, `package.json`, `runner.js`, `runner.sh`, `scripts/docker-entrypoint.sh`, `seekbar-service/Dockerfile`, `seekbar-service/Makefile`, `seekbar-service/README.md`, `seekbar-service/cmd/server/main.go`, `seekbar-service/internal/api/server.go`, `seekbar-service/internal/config/config.go`, `seekbar-service/internal/ffmpeg/sprite.go`, `seekbar-service/internal/worker/pool.go`, `src/config/manager.js`, `src/core/accounts.js`, `src/core/ai/faces-client.js`, `src/core/ai/faces-config.js`, `src/core/ai/faces-spawn.js`, `src/core/ai/faces.js`, `src/core/ai/index.js`, `src/core/ai/scan-runner.js`, `src/core/backup/index.js`, `src/core/backup/manager.js`, `src/core/backup/providers/dropbox.js`, `src/core/backup/providers/s3.js`, `src/core/backup/providers/sftp.js`, `src/core/checksum.js`, `src/core/cluster/handshake.js`, `src/core/cluster/hmac.js`, `src/core/cluster/identity.js`, `src/core/cluster/proxy.js`, `src/core/cluster/sweep.js`, `src/core/cluster/ws-channel.js`, `src/core/db.js`, `src/core/dedup.js`, `src/core/disk-rotator.js`, `src/core/downloader.js`, `src/core/faststart.js`, `src/core/forwarder.js`, `src/core/history.js`, `src/core/integrity.js`, `src/core/job-tracker.js`, `src/core/metrics.js`, `src/core/monitor.js`, `src/core/nsfw-client.js`, `src/core/nsfw.js`, `src/core/rescue.js`, `src/core/seekbar/client.js`, `src/core/seekbar/generator.js`, `src/core/seekbar/scan-runner.js`, `src/core/seekbar/spawn.js`, `src/core/share.js`, `src/core/state-migration.js`, `src/core/thumbs.js`, `src/core/updater.js`, `src/core/url-resolver.js`, `src/web/public/add-account.html`, `src/web/public/css/main.css`, `src/web/public/index.html`, `src/web/public/js/app.js`, `src/web/public/js/backfill.js`, `src/web/public/js/changelog-viewer.js`, `src/web/public/js/components.js`, `src/web/public/js/engine.js`, `src/web/public/js/gallery-select.js`, `src/web/public/js/gallery-virtual.js`, `src/web/public/js/gestures.js`, `src/web/public/js/header-mobile.js`, `src/web/public/js/maintenance-ai.js`, `src/web/public/js/maintenance-backup.js`, `src/web/public/js/maintenance-duplicates.js`, `src/web/public/js/maintenance-logs.js`, `src/web/public/js/maintenance-nsfw.js`, `src/web/public/js/maintenance-recovery.js`, `src/web/public/js/maintenance-seekbar.js`, `src/web/public/js/maintenance-thumbs.js`, `src/web/public/js/onboarding.js`, `src/web/public/js/pwa.js`, `src/web/public/js/queue.js`, `src/web/public/js/router.js`, `src/web/public/js/settings.js`, `src/web/public/js/sheet.js`, `src/web/public/js/shortcuts.js`, `src/web/public/js/statusbar.js`, `src/web/public/js/theme.js`, `src/web/public/js/viewer.js`, `src/web/public/locales/en.json`, `src/web/public/locales/th.json`, `src/web/public/login.html`, `src/web/public/setup-needed.html`, `src/web/public/sw.js`, `src/web/server.js`, plus the expanded tests in section 20 and `vitest.config.js`.

---

## 22. Commits on `main` after `716a55e`

Subjects are the commit subjects.

1. `0cb5818` chore(deps): bump node (#58)
2. `b626683` chore(deps): bump the actions group across 1 directory with 4 updates (#62)
3. `b793c93` chore(deps): bump the production group across 1 directory with 7 updates (#63)
4. `d2f1f6c` fix: issue #64, Biome 2.5 lint, CodeQL alerts (#65)
5. `da0545b` fix(deps): dedupe sharp — bump @huggingface/transformers to 4.3.0 (#67)
6. `9978615` fix(security): NSFW sidecar default-deny path mode, notify workflow permissions (#66)
7. `f463b9e` perf(nsfw): run the local classifier in a worker thread (#68)
8. `a5bbed3` fix(memory): stop Telegram session/client leaks, remove credential-leaking spillover (#69)
9. `e738d87` fix(dedup): Duplicates page results, never delete files other downloads use (#70)
10. `5ffc263` feat(nsfw-service): publish releases and GHCR images, slimmer CPU image (#72)
11. `b2db41b` fix(integrity): never prune the library because the disk is unavailable (#71)
12. `a7c8dd1` fix: keep shared files in rotator/rescue/cluster deletes, guard /files 404 prune (#73)
13. `da16b19` feat(dedup): rebuild the Duplicates list from stored hashes after a restart (#74)
14. `44f4b15` feat(web): redesign the release notes viewer (#75)
15. `2cb26c6` release: v2.25.0 — data safety, security, NSFW worker, memory leaks
16. `089a227` perf(backend): compression, indexed deletes, WS coalescing, SWR caches, safe index builds (#76)
17. `acbff01` fix: backups, seekbar long videos, faststart iPhone, disk quota, job status, pinned count (#78)
18. `c7183f1` perf(web): prebuilt Tailwind, gallery windowing, mobile UX, viewer gestures (#77)
19. `4716b0b` fix(web): saving a chat's settings no longer reloads the Groups list (#80)
20. `a0f20a1` perf(faces): 20-30x faster sidecar, no event-loop stalls, resilient scans, external mode (#79)
21. `d0d80fa` chore: repo hygiene, README screenshots, update check ignores sidecar releases (#82)
22. `f608331` feat(sidecars): external NSFW / seekbar sidecars that actually work on another machine (#81)
23. `ca89c8a` chore(faces): use faces-service 0.5.0 (#83)
24. `4a11b23` feat(faces): external faces sidecar — path mapping, size-bounded requests, raw uploads, token UI (#84)
25. `da4f994` release: v2.26.0
26. `7d67eeb` feat(web): simpler dashboard — gallery search, one-step backfill, sort & filter, settings search, clearer selection and queue (#85)
27. `0c04a6b` release: v2.27.0
28. `2afcc3f` fix(telegram): never connect the legacy session next to its migrated copy (#86)
29. `dfe4df1` release: v2.27.1
30. `0bf91fe` feat(web): chat details page, Add sheet, in-app account wizard, batch pin (#88)
31. `31e81ae` feat(core): tgdl-core Go companion, phase 1 — SHA-256 hashing (shadow by default) (#87)
32. `1588677` feat(web): four-place navigation, Tools under Settings, go-anywhere palette (Ctrl+K) (#89)
33. `7179667` release: v2.28.0
34. `e47459f` docs(readme): screenshots of the v2.28 layout; fix(web): status-bar chat count no longer drops to 0 (#90)
35. `6791480` feat(chats): one standard for chats we can't reach — pause them, stop wasting quota, explain why (#91)
36. `30b9242` release: v2.29.0
37. `1744ce8` test: API contract suite for the Go migration; fix four auth/rate-limit gaps (#93)
38. `8a68cd4` release: v2.29.1
39. `37c5615` docs(readme): architecture shows nsfw-service and tgdl-core (#92)
40. `7a99995` feat(web): configurable Content-Security-Policy (#95)
41. `52872a1` feat(core)!: tgdl-core phase 2 — Go-only hashing, fs sweeps and DBSCAN; required component (#94)
42. `050ef7c` fix: close the bugs the API contract suite recorded as-is (#97)
43. `ddeecba` release: v2.30.0
44. `4481676` fix(cluster): legacy cluster token only authenticates already-paired peers (#98)
45. `ccf362f` chore(docker): default idle watchtower on maintained fork, drop faces-openvino (#99)
46. `b144480` feat(core): tgdl-core front server on PORT — media served by Go, the rest proxied to Node (#96)
47. `df31e50` fix: auto-generate the watchtower API token so the bundled sidecar needs no setup (#100)
48. `66d95b3` release: v2.31.0
49. `b7642b1` feat(core): tgdl-core 0.4.0 serves every media byte; drop Node's file serving (#101)
50. `b0107ed` release: v2.32.0
51. `afac131` test(contract): escape every regex metacharacter in the inventory identifier lookup (#103)
52. `4c4b455` docs: refresh Markdown, add llms.txt and GitHub Pages site (#102)
53. `eefe4f7` fix: update ping, LOCATION_INVALID recovery, gramJS negative pause (#104)
54. `3122e9c` release: v2.32.1
55. `96088b8` fix: release notes viewer revalidates CHANGELOG.md so new versions show after an update (#105)
