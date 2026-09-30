# Gallery and player: port of remaining `enhancement` fixes to `enhancement-v2.32.1`

Follow-up to `CHANGES-716a55e1-to-enhancement.md` §4 (Gallery and player, lines 144–182). That review compared the old `enhancement` branch's gallery and player work against the current `enhancement-v2.32.1` base. Upstream v2.32.1 already has the buffering spinner, the long-video seekbar budget, and the faststart data-track retry. This records the three pieces that were still missing — an unpinned-only filter, one shuffle session over the filtered set, and a docked video player — and how each is closed without bringing `downloads.user_deleted` back.

Files touched: `src/core/db.js`, `src/web/server.js`, `src/web/public/index.html`, `src/web/public/js/app.js`, `src/web/public/js/gallery-toolbar.js`, `src/web/public/js/viewer.js`, `src/web/public/css/main.css`, `src/web/public/css/tailwind.css`, `src/web/public/locales/en.json`, `src/web/public/locales/th.json`, `tests/db.test.js`, `tests/db-federated-gallery.test.js`, `tests/db-search.test.js`, `tests/db-shuffle-ids.test.js`, `tests/viewer-shuffle.test.js`, `tests/contract/downloads.contract.test.js`, `tests/contract/__snapshots__/downloads.snap.json`, `tests/contract/inventory.json`.

`CHANGELOG.md` is intentionally not touched.

---

## Already on v2.32.1 — not ported

- **Buffering spinner.** The player ignores `stalled`. A sticky `waiting` event, plus seeking that is still in progress while the video is playing, shows the spinner after 200 ms. That logic in `src/web/public/js/viewer.js` is left as it is.
- **Long-video sprites.** `spriteBudgetMs` stays `clamp(5 min, 1× realtime, 60 min)`, with the sidecar poll, retryable timeouts, 120 s thumbs, and `SEEKBAR_BIN` ahead of `seekbar-service/bin/seekbar-server`.
- **Faststart.** The `-map -0:d` retry on “Could not find tag for codec” is already on this branch.
- **`user_deleted` sweep skip.** Not ported. Hard delete already removes the row, so there is no soft-deleted row for a sweep to skip. `purgeSeekbarForDownload` still skips `deleteSeekbarSprite` when the row was prefetched; `seekbar_sprites.download_id` is `ON DELETE CASCADE`, so the sprite row goes with the download.

---

## Unpinned

`pinned=0` is accepted beside every pinned-only clause. `pinned=1` still wins if both are sent.

Local rows match `pinned = 0`. Federated peer rows are already `0 AS pinned`, so they stay in an unpinned filter and stay excluded from pinned-only (`0 = 1`).

- `getAllDownloads`, `getDownloads`, `_searchNarrowing` (local search), `getAllDownloadsFederated`, `getDownloadsForGroupFederated`, and `searchDownloadsFederated` in `src/core/db.js`.
- `GET /api/downloads/all`, `GET /api/downloads/:groupId`, and `GET /api/downloads/search` parse `unpinnedOnly` only when pinned-only is not set (`pinned` is `0` or `false`).

The old cycling pin chip is not ported. The fourth state is an Order radio in the Sort & filter sheet (`src/web/public/js/gallery-toolbar.js`): “Only unpinned”.

`state.pinnedFilter` stays `false` for newest and pinned-first (those still differ by `localStorage['tgdl-pinned-first']`), `true` for pinned-only, and the string `'unpinned'` for the new mode. `getPinnedMode()` checks `'unpinned'` before the boolean. Selecting unpinned does not write `tgdl-pinned-first`. `pinnedQs()` returns `&pinned=0`.

Two readers in `src/web/public/js/app.js` use `getPinnedMode()` instead of treating the flag as a boolean: `_galleryViewKey()`, so returning to Library refetches when unpinned is not the previous mode, and the empty-state label. Clear filters calls `setPinnedMode('all')`.

Copy: `gallery.filter.pinned_unpinned` (“Only unpinned”) and `gallery.filter.state_unpinned` (“Unpinned only”) in `en.json` and `th.json`.

---

## Shuffle

One session in `src/web/public/js/viewer.js`, shared by the gallery chip and the player button. Fisher–Yates, a hydrate window of 40, `toggleShuffle`, `loadMoreShuffle`, `removeShuffleFile`, and `clearShuffleSilent`. Nothing reads `user_deleted`. The group filter is `state.currentGroupId`, not the display name.

Playlist filters match the gallery on screen: type tab, pin mode via `pinnedQs()`, `state.currentGroupId`, federation scope, and the toolbar search query. Enabling from the grid (`#gallery-shuffle-btn`, `openPlayer: false`) shuffles the grid and does not open the player. The first grid window is `max(40, 100)`. Enabling from the player (`#modal-shuffle-btn`) keeps the current item first. Closing the player keeps the shuffled grid. Continuous play reshuffles when the list wraps. A page-1 reload (`_reloadGallery` / `_loadGalleryPage`) calls `clearShuffleSilent()` before the fetch. Review and single-file viewers set `_shuffleBlocked`.

`groupFilesByTime` is skipped while shuffled. Infinite scroll calls `loadMoreShuffle()` for the next id window and appends through the virtual gallery. `hasPendingBelow()` does not extend a chronological DOM window ahead of that hydrate. After a rematerialize, the full render uses `resetGalleryWindow()`.

Delete and the WebSocket `file_deleted` event (`dropFileFromView`, `confirmDeleteFile`) drop the id from keys, cache, and the backup playlist, then advance. An id-only event drops a local row (`peer_id === 'self'`).

Server, registered before `GET /api/downloads/:groupId`. That handler `next()`s when `groupId` is `ids`, same as `search`.

- `GET /api/downloads/ids` — the full matching id set, no page cap. Local `{ids: number[], total}` via `listDownloadIds` / `listDownloadIdsForGroup`. Search or federated results page the existing list helpers at 500 and return `{ids: [{id, peer_id}], total}`. Guests are forced to `include=local`. Same query params as `/all`, plus `q` when the gallery is searching. `GET /ids` is already guest-allowed because `/api/downloads` is a GET prefix.
- `POST /api/downloads/by-ids` — up to 100 ids, response order, the gallery tile shape already used by `/all` (`mapDownloadRowToGalleryFile`). Added to `GUEST_OTHER_ALLOW`. Guest peer keys are ignored.

DB helpers: `listDownloadIds`, `listDownloadIdsForGroup`, `getDownloadsByIds`, `getPeerDownloadsByKeys`. No `user_deleted` predicate. `unpinnedOnly` is included.

---

## Docked layout

The existing `#video-container` is edited in place. It is not replaced with the enhancement copy.

- The picture, tap layer, seek overlays, center play, spinner, and error overlay sit in `#video-stage` (`relative flex-1 min-h-0`). The speed menu stays a sibling.
- `#video-container` is `flex flex-col`. `#video-controls` is `relative shrink-0` (docked). Seekbar padding is `pt-2`.
- Phone skip/mute stay `hidden sm:flex`. The filmstrip keeps `role="group"`.
- `#preview-strip-container` is removed, and so is the empty-strip rule in `src/web/public/css/main.css`. v2.32.1 had only hidden that empty band with CSS.
- `html.theme-light .video-controls` is a solid `rgba(0, 0, 0, 0.92)` with `background-image: none`. `.video-controls.controls-collapsed` is absolute, height 0, overflow hidden, and `pointer-events: none`, so the stage grows when the controls fade.
- `_showControls` removes `controls-collapsed`. `__scheduleHide` adds it when the controls fade. The waiting-spinner logic is not rewritten.

`min-h-0` was missing from the committed Tailwind sheet. `npm run build:css` regenerated `src/web/public/css/tailwind.css`.

---

## Tests

Same isolated `TGDL_DATA_DIR` pattern as the existing db tests. Shuffle id tests use hard delete: a deleted id is absent, not flagged `user_deleted`.

- `tests/db.test.js` — `unpinnedOnly` returns only unpinned rows. 21/21 pass.
- `tests/db-federated-gallery.test.js` — `unpinnedOnly` keeps peer rows and drops the local pinned row, including `getDownloadsForGroupFederated`. 14/14 pass.
- `tests/db-search.test.js` — local unpinned ids, and a federated unpinned search that keeps the peer plus the unpinned local rows. 9/9 pass.
- `tests/db-shuffle-ids.test.js` — id lists for all, images, pinned-only, unpinned-only, and a group; `getDownloadsByIds` keeps request order and skips a missing id; a hard-deleted id is absent. 5/5 pass.
- `tests/viewer-shuffle.test.js` — the pure helpers (`_playlistKey`, `_buildShuffleOrder`, `_fisherYates`, `_dropKeyFromOrder`). 4/4 pass.
- `tests/contract/downloads.contract.test.js` — `pinned=0` and `pinned=false` on `/all`, group, and search; `GET /api/downloads/ids` (all, images, pinned, unpinned, group, search, guest `include=peers` forced to local); `POST /api/downloads/by-ids` (empty, local order, guest drops peer keys, over the 100 cap). 13/13 pass.
- `tests/contract/inventory.json` lists `GET /api/downloads/ids` and `POST /api/downloads/by-ids`.

53/53 unit tests pass across the five files above, and the downloads contract suite passes 13/13.
