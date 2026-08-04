# Build tgdl-faces standalone Windows binary with PyInstaller.
#
# Usage (from faces-service/ directory):
#   .\build-pyinstaller.ps1
#   .\build-pyinstaller.ps1 -WithModel      # bundle buffalo_l weights into the exe
#   .\build-pyinstaller.ps1 -Variant cuda   # link onnxruntime-gpu (CUDA)
#   .\build-pyinstaller.ps1 -Variant dml    # link onnxruntime-directml
#
# The output binary is named tgdl-faces-win-x64.exe (or arm64 on ARM).
# Copy it to data/faces-service/bin/ inside the main project.

param(
    [switch]$WithModel,
    [ValidateSet('cpu','cuda','dml')]
    [string]$Variant = 'cpu'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Detect arch ───────────────────────────────────────────────────────────────
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$outName = "tgdl-faces-win-$arch"

Write-Host "Building $outName.exe (variant=$Variant, with-model=$WithModel)" -ForegroundColor Cyan

# ── Install deps via uv ───────────────────────────────────────────────────────
$uvArgs = @('sync', '--group', 'build')
switch ($Variant) {
    'cuda' { $uvArgs += '--extra', 'gpu' }
    'dml'  { $uvArgs += '--extra', 'directml' }
}
Push-Location $PSScriptRoot
try {
    uv @uvArgs
} finally {
    Pop-Location
}

# ── Resolve the tgdl_faces package path ──────────────────────────────────────
$pkgPath = uv run python -c "import tgdl_faces, os; print(os.path.dirname(tgdl_faces.__file__))"
if (-not $pkgPath) {
    # Not installed — add src dir to PYTHONPATH so PyInstaller finds it
    $env:PYTHONPATH = "$PSScriptRoot;$env:PYTHONPATH"
    $pkgPath = Join-Path $PSScriptRoot 'tgdl_faces'
}

# ── PyInstaller args ──────────────────────────────────────────────────────────
$args = @(
    '--onefile',
    '--name', $outName,
    '--collect-all', 'tgdl_faces',       # bundle the entire package
    '--collect-all', 'insightface',       # insightface + its data files
    '--collect-all', 'onnxruntime',       # ONNX runtime shared libs
    '--hidden-import', 'tgdl_faces',
    '--hidden-import', 'tgdl_faces.app',
    '--hidden-import', 'tgdl_faces.insight',
    '--hidden-import', 'tgdl_faces.io',
    '--hidden-import', 'uvicorn.logging',
    '--hidden-import', 'uvicorn.loops',
    '--hidden-import', 'uvicorn.loops.auto',
    '--hidden-import', 'uvicorn.protocols',
    '--hidden-import', 'uvicorn.protocols.http',
    '--hidden-import', 'uvicorn.protocols.http.auto',
    '--hidden-import', 'uvicorn.lifespan',
    '--hidden-import', 'uvicorn.lifespan.on',
    '--noconfirm',
    '--clean'
)

if ($WithModel) {
    # Try to find cached buffalo_l and bundle it
    $modelDirs = @(
        "$env:USERPROFILE\.insightface\models\buffalo_l",
        "$env:USERPROFILE\.cache\tgdl-faces\models\buffalo_l"
    )
    foreach ($d in $modelDirs) {
        if (Test-Path $d) {
            Write-Host "Bundling model from $d" -ForegroundColor Yellow
            $args += '--add-data'
            $args += "${d};buffalo_l"
            break
        }
    }
}

# Entry point
$entryPoint = Join-Path $PSScriptRoot 'tgdl_faces\__main__.py'

Write-Host "Running: uv run pyinstaller $args $entryPoint" -ForegroundColor DarkGray
uv run pyinstaller @args $entryPoint

# ── Copy to dist ──────────────────────────────────────────────────────────────
$distExe = Join-Path $PSScriptRoot "dist\$outName.exe"
if (Test-Path $distExe) {
    Write-Host ""
    Write-Host "Built: $distExe" -ForegroundColor Green
    Write-Host "Copy to:  data\faces-service\bin\$outName.exe" -ForegroundColor Green
} else {
    Write-Error "Build failed — $distExe not found"
}
