# Safari HEVC playback: retag `hev1` to `hvc1` in the faststart remux

`2026-10-03T15-18-28_30671.mp4` (download `116775`, group `随机福利`, 1920×1080 HEVC Main, AAC, ~641 s) opened in the gallery viewer on Safari as Error 4 (`MEDIA_ERR_SRC_NOT_SUPPORTED`). The file was complete, `moov` already preceded `mdat`, and the bytes matched `downloads.file_size`. Safari still refused it because the video sample entry is `hev1` while VPS, SPS and PPS exist only inside `hvcC` (each once, `array_completeness = 0`). The samples are bare slices; the first is a single IDR of 18,867 bytes. `hev1` means those parameter sets belong in the bitstream. `hvc1` means they belong in the sample description, which is the layout this file actually has. Safari decodes the latter.

The faststart pass already stream-copies with `-movflags +faststart` and retries once with `-map -0:d` when the muxer rejects a data track. It treated “`moov` at the front” as done, so this clip was skipped and the `hev1` tag was kept. The remux now also retags that layout to `hvc1`. No re-encode.

Files touched: `src/core/faststart.js`, `tests/faststart.test.js`.

`CHANGELOG.md` is intentionally not touched.

---

## 1. Detection

`_needsHvc1Retag` walks top-level boxes by size (a multi-gigabyte `mdat` is seeked past, not read) and descends only `moov / trak / mdia / minf / stbl`. Each `stsd` under 1 MB is read and parsed.

A video sample entry is retaggable when its fourcc is `hev1` and the following `hvcC` (ISO/IEC 14496-15, `numOfArrays` at byte 22) contains NAL types 32 (VPS), 33 (SPS) and 34 (PPS). The `hvcC` child starts 78 bytes after the sample-entry header, which is the `VisualSampleEntry` layout.

An `hev1` entry whose `hvcC` has no parameter sets is left alone: those sets are in the samples, and retagging would describe a file Safari still could not decode from `hvcC`.

`avc1`, `avc3`, `avc4`, `vp08`, `vp09`, `av01`, `mp4v`, `h263`, `s263`, `encv`, `dvh1` and `dvhe` in the same file set a conflict. `-tag:v hvc1` applies to every video stream, so a mixed file is not retagged.

## 2. When the remux runs

`optimizeDownload` used to return `{ status: 'already' }` as soon as the second atom was `moov`. The give-up check now runs first (three failures on the same `size:mtimeMs` still skip the file), then the `hev1` scan.

- `moov` at the front and no retag: `already`, ffmpeg is not spawned.
- `moov` at the front and retag: stream-copy anyway.
- `mdat` / other second atom: the existing faststart remux, with `-tag:v hvc1` added only when the scan asks for it.

`_remuxInPlace` inserts `-tag:v hvc1` after the `-map` arguments and before `-movflags +faststart`. The data-track retry is unchanged: the first failure that matches `Could not find tag for codec` is repeated with `-map -0:d`, and the tag is kept on that second call. The 0.8×–1.1× size check and the atomic rename are unchanged. `downloads.file_size` is updated; `file_hash` is not.

`getStats` counts a faststart file that still needs the retag as `pending`, or as `unknown` once that exact file has been given up on. Other faststart files stay `optimized`.

## 3. The reported file

Remuxed on disk with the same ffmpeg arguments (`-c copy -map 0 -tag:v hvc1 -movflags +faststart`). Output is 61,025,400 bytes (was 61,057,512). The sample entry is `hvc1`, `hev1` is gone, `moov` is still the second atom. `downloads.file_size` for id `116775` is updated to match. `/mnt/usb1/telegram-media-downloader/...` is the same inode, so that path sees the new bytes too.

The running image does not bind-mount `src/`, so this one file is fixed on disk and later downloads stay on the old optimizer until the image is rebuilt and **Optimize videos** runs.

---

## Tests

Extended: `tests/faststart.test.js`. The fixture is an `ftyp` + `moov` (`trak/mdia/minf/stbl/stsd` + `hev1` + `hvcC`) + `mdat`, with or without the three parameter-set arrays, and with `moov` either second or after `mdat`. ffmpeg is the existing `child_process.spawn` fake.

```
npx vitest run tests/faststart.test.js tests/faststart.ffmpeg.test.js
```

- 2 files / 7 tests passed. Three new cases: a faststart `hev1` with VPS/SPS/PPS in `hvcC` is remuxed with `-tag:v hvc1`; the same file with an empty `hvcC` returns `already` and does not spawn; a late-`moov` `hev1` carries both `-tag:v hvc1` and `+faststart`.
- The real-ffmpeg case in `tests/faststart.ffmpeg.test.js` (timecode data track) still passes.
- Vitest then failed writing `node_modules/.vite/vitest/results.json` (`EACCES`). That is the results cache, after the tests had passed.

## Not done

- Image not rebuilt, so auto-optimise and the maintenance sweep on the running container do not retag yet.
- Safari was not reopened against the retagged file.
- `file_hash` for id `116775` is still the pre-remux digest, same as every other faststart rewrite.
- No mixed-codec (`hev1` + `avc1`) fixture. The conflict branch is untested.
