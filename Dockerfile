# syntax=docker/dockerfile:1.7
#
# Multi-stage build:
#   - "deps" installs prod dependencies only (npm ci --omit=dev) so the runtime
#     image stays small.
#   - "seekbar" compiles the Go sidecar (static binary) so `docker compose build`
#     ships it at /app/seekbar-service/bin/seekbar-server. Node auto-spawns
#     that path when SEEKBAR_SIDECAR_URL is unset — no GitHub download and
#     no extra compose service.
#   - "runtime" copies node_modules from "deps", the sidecar binary, and the
#     source; runs as the non-root `node` user; exposes 3000; healthchecks
#     /api/auth_check.
#
# Pin a specific patch version. Floating tags drift; this image is reproducible.

FROM node:24.16.0-bookworm-slim AS deps
WORKDIR /app
# `websocket` (gramJS/telegram) depends on `bufferutil`, which compiles via
# node-gyp when no prebuilt binary exists (common on linux/arm64 + Node 24).
# Install build tooling in this stage only — the runtime image stays slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Compile the seekbar sidecar for the image's target arch (BuildKit sets
# TARGETOS/TARGETARCH). CGO off → static binary; ffmpeg stays in runtime.
FROM --platform=$BUILDPLATFORM golang:1.22-bookworm AS seekbar
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY seekbar-service/go.mod seekbar-service/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY seekbar-service/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH:-$(go env GOARCH)} \
        go build -trimpath -ldflags '-s -w' -o /out/seekbar-server ./cmd/server

FROM node:24.16.0-bookworm-slim AS runtime

# Build identity — passed in by CI (`docker build --build-arg GIT_SHA=…
# --build-arg BUILT_AT=…`) and surfaced via `/api/version` so the
# status-bar chip always reflects what's actually deployed.
ARG GIT_SHA=dev
ARG BUILT_AT=
ENV NODE_ENV=production \
    PORT=3000 \
    GIT_SHA=${GIT_SHA} \
    BUILT_AT=${BUILT_AT} \
    SEEKBAR_BIN=/app/seekbar-service/bin/seekbar-server

# tini    — proper PID 1 (signal handling + zombie reaping). Debian ships
#           the binary at /usr/bin/tini.
# gosu    — drop from root → node after the entrypoint fixes /app/data perms
#           (su-exec equivalent on Debian; same `gosu user "$@"` syntax).
# ffmpeg  — used by src/core/thumbs.js for video first-frame thumbnails
#           and audio cover-art extraction. ~30 MB — tiny next to libvips
#           and node_modules.
# intel-media-va-driver / i965-va-driver — VA-API userland drivers needed
#           for `-hwaccel vaapi` (Intel iGPU + AMD via the same libva ABI).
#           Without these the ffmpeg path in thumbs.js falls back to CPU
#           decode even when the host exposes /dev/dri. iHD is Gen8+ and
#           the Quick Sync runtime; i965 covers Gen4-Gen7 hardware.
# vainfo  — `vainfo` from libva-utils. Not used by the app itself, but
#           lets operators `docker exec <ctr> vainfo` to confirm the
#           driver actually loaded inside the container without having
#           to bake their own debug image.
#
# Base is bookworm-slim (glibc) rather than alpine (musl) because
# `onnxruntime-node` (pulled in by @huggingface/transformers for the NSFW
# classifier) ships glibc-only prebuilt .so files; loading them on musl
# crashes the whole process at boot with "ld-linux-x86-64.so.2: No such
# file or directory". libstdc++ is part of the base image, no install needed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini gosu ffmpeg procps \
        # intel-media-va-driver i965-va-driver vainfo \
        vainfo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY scripts ./scripts
COPY runner.js config.example.json package.json LICENSE README.md SECURITY.md CHANGELOG.md ./
COPY --from=seekbar /out/seekbar-server /app/seekbar-service/bin/seekbar-server

# Persistent state (sessions, config, downloads) — mount this as a volume.
# `chmod a+rX` guarantees files end up readable + dirs traversable even when
# BuildKit lays down mode 0 (seen on Windows hosts and some gha-cache hits),
# which previously surfaced as `Cannot find module '/app/src/web/server.js'`.
RUN mkdir -p /app/data /app/data/downloads /app/data/logs /app/data/sessions /app/data/backups /app/data/models \
    && chmod -R a+rX /app \
    && chmod +x /app/scripts/docker-entrypoint.sh \
    && chmod +x /app/seekbar-service/bin/seekbar-server \
    && chown -R node:node /app

# Pre-warm the AI model cache at build time so a first scan completes in
# milliseconds instead of waiting on a cold ~150 MB download. Allowed to
# fail with `|| true` for offline / firewalled CI machines — first run
# falls back to lazy download. Skips silently when @huggingface/transformers
# isn't installed (minimal builds without the optional dep).
RUN node scripts/pre-download-models.js || true

# We deliberately run the entrypoint as root so it can chown the bind-mounted
# /app/data volume on first boot — gosu drops to `node` before exec'ing
# CMD, so the actual app process is still non-root.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node scripts/healthcheck.js || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
CMD ["node", "src/web/server.js"]
