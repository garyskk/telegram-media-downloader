# Makefile for tgdl-faces — cross-platform build targets.
#
# Binary targets:
#   make build-linux-x64     Build PyInstaller binary (Linux x86_64)
#   make build-linux-arm64   Build PyInstaller binary (Linux aarch64)
#   make build-win-x64       Build PyInstaller binary (Windows x86_64) — run in PowerShell
#
# Docker targets:
#   make docker-cpu          Build linux/amd64 CPU image (Dockerfile)
#   make docker-cuda         Build linux/amd64 CUDA image (Dockerfile.cuda)
#   make docker-arm64        Build linux/arm64 image (Dockerfile.arm64, needs buildx)
#
# Dev targets:
#   make install             uv sync (CPU variant)
#   make install-gpu         uv sync --extra gpu
#   make install-directml    uv sync --extra directml
#   make test                Run the test suite (pytest)
#   make check               Run biome-style linting via ruff (if installed)

.PHONY: install install-gpu install-directml install-openvino \
        build-linux-x64 build-linux-arm64 build-win-x64 \
        docker-cpu docker-cuda docker-arm64 \
        test check

# ── Installation ─────────────────────────────────────────────────────────────

install:
	uv sync

install-gpu:
	uv sync --extra gpu

install-directml:
	uv sync --extra directml

install-openvino:
	uv sync --extra openvino

# ── PyInstaller binaries ──────────────────────────────────────────────────────

build-linux-x64:
	bash build-pyinstaller.sh --variant auto

build-linux-arm64:
	bash build-pyinstaller.sh --variant cpu

build-win-x64:
	@echo "Run from a PowerShell terminal:"
	@echo "  cd faces-service"
	@echo "  .\\build-pyinstaller.ps1 -Variant cpu"
	@echo "  .\\build-pyinstaller.ps1 -Variant dml     # DirectML GPU"
	@echo "  .\\build-pyinstaller.ps1 -Variant cuda    # NVIDIA CUDA"

# ── Docker images ─────────────────────────────────────────────────────────────

docker-cpu:
	./build.sh

docker-cuda:
	docker build -f Dockerfile.cuda -t tgdl-faces:cuda .

docker-arm64:
	docker buildx build --platform linux/arm64 \
		-f Dockerfile.arm64 -t tgdl-faces:arm64 .

# ── Tests ─────────────────────────────────────────────────────────────────────

test:
	uv run pytest tests/

check:
	@command -v ruff >/dev/null 2>&1 && ruff check tgdl_faces/ tests/ || \
	    echo "ruff not installed — skipping lint (uv add --group dev ruff)"
