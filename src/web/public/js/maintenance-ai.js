/* Maintenance → AI page module.
 *
 * Faces-only build. The Python face-clustering sidecar (insightface
 * buffalo_l, 512-dim embeddings) is the only AI surface here today;
 * Search + Auto-tag were removed in v2.14. NSFW classification lives
 * on its own Maintenance → NSFW tab.
 *
 * Init contract: `init()` is called every time the SPA navigates to
 * `#/maintenance/ai`. It must be idempotent — repeated calls re-bind
 * listeners but don't double-fire requests.
 */

import { api } from './api.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { showToast, escapeHtml, formatBytes } from './utils.js';
import { ws } from './ws.js';
import { confirmSheet, promptSheet, openSheet } from './sheet.js';
import { openMediaViewerForReview } from './viewer.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Builds the `#ai-progress-status` text during the video phase — shared by
 * the WS live-update handler (`_onScanProgress`) and the periodic
 * full-state render, so both surfaces render the exact same string for
 * `state.currentVideo` (video scan progress reporting; see
 * `scan-runner.js`). Falls back to the plain "Scanning…" text when
 * `currentVideo` is absent — the photo phase, between videos, or a
 * sidecar too old to report decode progress.
 */
function _formatScanStatusText(currentVideo) {
    if (!currentVideo || typeof currentVideo !== 'object') {
        return i18nT('maintenance.ai.scanning', 'Scanning…');
    }
    const name = currentVideo.name || '';
    const pct = Number.isFinite(currentVideo.pct) ? currentVideo.pct : null;
    const decoded = Number.isFinite(currentVideo.framesDecoded) ? currentVideo.framesDecoded : null;
    const total = Number.isFinite(currentVideo.totalFrames) ? currentVideo.totalFrames : null;
    if (pct != null && decoded != null && total != null) {
        return i18nTf(
            'maintenance.ai.scanning_video',
            { name, pct, decoded: decoded.toLocaleString(), total: total.toLocaleString() },
            `Video: ${name} — ${pct}% decoded (${decoded.toLocaleString()}/${total.toLocaleString()} frames)`,
        );
    }
    // Sidecar hasn't reported decode-position fields yet (first tick) or is
    // too old to know about job_id at all — still name the file so the
    // operator doesn't wonder if the scan is stuck.
    return i18nTf('maintenance.ai.scanning_video_unknown', { name }, `Video: ${name}`);
}

const _CHIP_STYLES = {
    'tg-blue': ['border-tg-blue', 'bg-tg-blue/10', 'text-tg-blue'],
    'amber-500': ['border-amber-500', 'bg-amber-500/10', 'text-amber-500'],
};
function _applyFilterChipStyle(btn, active, color) {
    btn.dataset.active = active ? 'true' : 'false';
    const on = _CHIP_STYLES[color] || [];
    if (active) {
        btn.classList.remove('border-tg-border/40', 'text-tg-textSecondary');
        btn.classList.add(...on);
    } else {
        btn.classList.remove(...on);
        btn.classList.add('border-tg-border/40', 'text-tg-textSecondary');
    }
}

// Module state.
let _initOnce = false;
let _lastStatus = null;
let _selectedPerson = null;
let _selectedPersonName = '';
let _peopleCache = []; // full people list (un-filtered) for client-side search
let _photoGridClickHandler = null;
const _peopleFilter = {
    query: '',
    unlabeledOnly: false,
    videosOnly: false,
    hideLowQuality: false,
    sortBy: 'face_count',
};

// Scan phase tracking — distinguishes Phase A (per-image detect) from
// Phase B (DBSCAN clustering, runs after A completes, typically seconds).
let _scanPhase = 'A'; // 'A' | 'B'

// Split mode — set when the user clicks "Split" on a cluster. While active
// the photo grid swaps its click handler from viewer-open to face-select.
// Selection is keyed by download ID (always available) rather than face_id
// (which may be absent on some API paths). Face IDs are collected from the
// tiles' data-face-id at commit time.
let _splitModeActive = false;
const _splitSelectedDlIds = new Set();

// Face review — additive, opt-in detail view (one tile per detected face,
// cropped) toggled on top of the existing photo grid via "Review faces".
// It never replaces the default photo-grid flow; closing it just hides
// this panel and the photo grid remains as it was.
let _faceReviewActive = false;
let _faceReviewOffset = 0;
let _faceReviewTotal = 0;
let _faceReviewToken = 0;
let _faceReviewGridClickHandler = null;
const _FACE_REVIEW_PAGE_SIZE = 100;

// Unclassified faces review — opened from the Unclassified KPI tile.
let _unclassifiedReviewActive = false;
let _unclassifiedOffset = 0;
let _unclassifiedTotal = 0;
let _unclassifiedToken = 0;
const _unclassifiedSelectedIds = new Set(); // multi-select face ids
let _unclassifiedFocusFaceId = null; // last toggled — drives suggestions
let _unclassifiedSuggestions = [];
let _unclassifiedGridClickHandler = null;
const _UNCLASSIFIED_PAGE_SIZE = 100;

// Running render token — incremented on every _renderPeopleGrid call so
// stale async chunks abort when a newer render starts (e.g. typing in
// the search box while the previous chunk render is still in flight).
let _peopleRenderToken = 0;

export async function init() {
    if (!_initOnce) {
        _bindOnce();
        _initOnce = true;
    }
    _setActionButtonsEnabled(false);
    await refreshStatus();
    _refreshDoctor().catch(() => {});
    _loadPeople().catch(() => {});
}

// Public refresher — exported so the SPA shell can poke us after a
// settings save lands somewhere else (Settings → Advanced → AI).
export async function refreshStatus() {
    try {
        const r = await api.get('/api/ai/status');
        if (!r.success) return;
        _lastStatus = r;
        _renderStatus(r);
    } catch (e) {
        console.warn('ai/status:', e);
    }
}

// ---- Wire-once listeners --------------------------------------------------

function _bindOnce() {
    // Header action buttons. All three follow the maintenance/thumbs
    // pattern: a primary `Scan now`, an always-rendered `Cancel`
    // (disabled while idle), and a secondary destructive `Reindex from
    // scratch`. The legacy `#ai-master-badge` + `#ai-recluster-btn`
    // hosts live as hidden no-op spans so old bookmarks / extensions
    // don't crash on missing nodes.
    $('#ai-scan-btn')?.addEventListener('click', () => _startScan('faces'));
    $('#ai-cancel-btn')?.addEventListener('click', () => _cancelScan('faces'));
    $('#ai-reindex-btn')?.addEventListener('click', _reindexFromScratch);
    $('#ai-recluster-btn')?.addEventListener('click', _recluster);
    $('#ai-rebuild-btn')?.addEventListener('click', _rebuildAllClusters);
    $('#ai-restart-sidecar-btn')?.addEventListener('click', _restartSidecar);
    $('#ai-detect-test-btn')?.addEventListener('click', _runDetectTest);

    // Sensitivity preset buttons — one-click apply ε + minPoints, then
    // immediately re-cluster so the operator sees results in seconds.
    document.querySelectorAll('.ai-preset-btn').forEach((btn) => {
        btn.addEventListener('click', () => _applyPreset(btn.dataset.preset));
    });

    // Master + auto toggles — both live as labelled rows in the Face
    // clustering settings section. Click-anywhere on the toggle flips
    // the underlying config flag and immediately re-renders so the
    // visual state matches the API result.
    $('#ai-master-toggle')?.addEventListener('click', _onMasterToggle);
    $('#ai-master-toggle')?.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            _onMasterToggle();
        }
    });
    $('#ai-auto-toggle')?.addEventListener('click', _onAutoToggle);
    $('#ai-auto-toggle')?.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            _onAutoToggle();
        }
    });
    $('#ai-scan-videos-toggle')?.addEventListener('click', _onScanVideosToggle);
    $('#ai-scan-videos-toggle')?.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            _onScanVideosToggle();
        }
    });
    $('#ai-faces-video-scan-limit')?.addEventListener('change', async (e) => {
        const raw = Number(e.target.value);
        const limit = Number.isFinite(raw) ? Math.max(0, Math.min(10000, raw | 0)) : 0;
        if (String(e.target.value) !== String(limit)) e.target.value = String(limit);
        await _saveSetting('videoScanLimit', limit);
    });
    $('#ai-faces-video-nice')?.addEventListener('change', async (e) => {
        const raw = Number(e.target.value);
        const nice = Number.isFinite(raw) ? Math.max(0, Math.min(19, raw | 0)) : 0;
        if (String(e.target.value) !== String(nice)) e.target.value = String(nice);
        await _saveSetting('videoNice', nice);
    });

    // Settings inputs — model / threshold / minPoints / provider.
    // `change` (not `input`) so dragging the slider doesn't spam saves.
    $('#ai-faces-model')?.addEventListener('change', async (e) => {
        const model = String(e.target.value || 'buffalo_l');
        const statusEl = $('#ai-faces-model-status');
        if (statusEl) statusEl.textContent = `Preloading ${model}…`;
        try {
            await api.post(`/api/ai/preload-model/${model}`);
            for (let i = 0; i < 60; i++) {
                const s = await api.get(`/api/ai/preload-model/${model}/status`);
                if (s?.status === 'ready') break;
                if (s?.status?.startsWith('error')) {
                    throw new Error(s.status);
                }
                await new Promise((r) => setTimeout(r, 2000));
                if (statusEl) statusEl.textContent = `Downloading ${model}…`;
            }
        } catch (err) {
            if (statusEl) statusEl.textContent = `Preload failed: ${err.message}`;
        }
        if (statusEl) statusEl.textContent = `Switching to ${model}…`;
        await _saveSetting('facesDetectorModel', model, { restartSidecar: true });
        if (statusEl) statusEl.textContent = 'Sidecar restarting with new model…';
    });
    const epsInp = $('#ai-faces-epsilon');
    const epsOut = $('#ai-faces-epsilon-out');
    if (epsInp) {
        // Live readout: update the <output> as the slider moves so the
        // operator can see the value before letting go.
        epsInp.addEventListener('input', () => {
            if (epsOut) epsOut.textContent = Number(epsInp.value).toFixed(2);
        });
        epsInp.addEventListener('change', () => _saveSetting('facesEpsilon', Number(epsInp.value)));
    }
    $('#ai-faces-min-points')?.addEventListener('change', (e) =>
        _saveSetting('facesMinPoints', Number(e.target.value || 3)),
    );

    // Hardware-acceleration sub-card — same UX as the thumbs page.
    $('#ai-faces-provider-probe-btn')?.addEventListener('click', _runFacesProviderProbe);
    $('#ai-faces-provider')?.addEventListener('change', _onFacesProviderChange);

    // Doctor refresh
    $('#ai-doctor-refresh-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _refreshDoctor().catch(() => {});
    });

    // People — search + filter chip + refresh.
    $('#ai-people-search')?.addEventListener('input', (e) => {
        _peopleFilter.query = String(e.target.value || '').toLowerCase();
        _renderPeopleGrid().catch(() => {});
    });
    $('#ai-people-unlabeled')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        _peopleFilter.unlabeledOnly = !_peopleFilter.unlabeledOnly;
        _applyFilterChipStyle(btn, _peopleFilter.unlabeledOnly, 'tg-blue');
        _renderPeopleGrid().catch(() => {});
    });
    $('#ai-people-videos-only')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        _peopleFilter.videosOnly = !_peopleFilter.videosOnly;
        _applyFilterChipStyle(btn, _peopleFilter.videosOnly, 'amber-500');
        _renderPeopleGrid().catch(() => {});
    });
    $('#ai-people-hide-lq')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        _peopleFilter.hideLowQuality = !_peopleFilter.hideLowQuality;
        _applyFilterChipStyle(btn, _peopleFilter.hideLowQuality, 'red-500');
        _renderPeopleGrid().catch(() => {});
    });
    $('#ai-people-sort-group')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.ai-sort-btn');
        if (!btn) return;
        const sortBy = btn.dataset.sort;
        if (!sortBy || sortBy === _peopleFilter.sortBy) return;
        _peopleFilter.sortBy = sortBy;
        for (const b of document.querySelectorAll('#ai-people-sort-group .ai-sort-btn')) {
            if (b.dataset.sort === sortBy) {
                b.classList.remove('text-tg-textSecondary');
                b.classList.add('bg-tg-blue/10', 'text-tg-blue');
            } else {
                b.classList.remove('bg-tg-blue/10', 'text-tg-blue');
                b.classList.add('text-tg-textSecondary');
            }
        }
        _renderPeopleGrid().catch(() => {});
    });
    $('#ai-people-refresh-btn')?.addEventListener('click', () => _loadPeople());

    // Person action buttons.
    $('#ai-person-rename-btn')?.addEventListener('click', _renameSelectedPerson);
    $('#ai-person-merge-btn')?.addEventListener('click', _mergeSelectedPerson);
    $('#ai-person-split-btn')?.addEventListener('click', _splitSelectedPerson);
    $('#ai-person-exclude-btn')?.addEventListener('click', _excludeSelectedPerson);
    $('#ai-person-delete-btn')?.addEventListener('click', _deleteSelectedPerson);
    $('#ai-split-cancel-btn')?.addEventListener('click', _exitSplitMode);
    $('#ai-split-commit-btn')?.addEventListener('click', _commitSplit);
    $('#ai-person-review-faces-btn')?.addEventListener('click', _toggleFaceReview);
    $('#ai-face-review-close-btn')?.addEventListener('click', _closeFaceReview);
    $('#ai-unclassified-close-btn')?.addEventListener('click', _closeUnclassifiedReview);
    $('#ai-unclassified-sel-clear-btn')?.addEventListener('click', () => {
        _unclassifiedSelectedIds.clear();
        _unclassifiedFocusFaceId = null;
        _syncUnclassifiedSelectionUi();
    });
    $('#ai-unclassified-sel-assign-btn')?.addEventListener('click', () => {
        const ids = [..._unclassifiedSelectedIds];
        if (!ids.length) return;
        _assignUnclassifiedFaces(ids);
    });
    $('#ai-unclassified-sel-new-btn')?.addEventListener('click', () => {
        const ids = [..._unclassifiedSelectedIds];
        if (!ids.length) return;
        _newPersonFromUnclassifiedFaces(ids);
    });
    $('#ai-unclassified-sel-remove-btn')?.addEventListener('click', () => {
        const ids = [..._unclassifiedSelectedIds];
        if (!ids.length) return;
        _removeUnclassifiedFaces(ids);
    });
    const noiseTile = $('#ai-stat-noise-tile');
    noiseTile?.addEventListener('click', () => {
        const n = Number(_lastStatus?.counts?.noiseFaces ?? 0);
        if (n > 0) _openUnclassifiedReview();
    });
    noiseTile?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const n = Number(_lastStatus?.counts?.noiseFaces ?? 0);
            if (n > 0) _openUnclassifiedReview();
        }
    });
    $('#ai-people-excluded-toggle')?.addEventListener('click', () => {
        const body = $('#ai-people-excluded-body');
        const chevron = $('#ai-people-excluded-chevron');
        const toggle = $('#ai-people-excluded-toggle');
        if (!body) return;
        const open = body.classList.toggle('hidden') === false;
        toggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (chevron) chevron.style.transform = open ? 'rotate(180deg)' : '';
    });
    $('#ai-people-excluded-list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-restore-excluded]');
        if (!btn) return;
        const id = Number(btn.getAttribute('data-restore-excluded'));
        if (!Number.isFinite(id)) return;
        _restoreExcludedPerson(id);
    });

    // WebSocket — only the people / scan events survive in the faces-only
    // build. ai_index_* / ai_tags_* were removed with the Search + Tags
    // pipelines. ai_faces_status surfaces sidecar lifecycle changes so the
    // header badge updates without a polling loop.
    // ai_people_phase_b fires when Phase A (detection) is complete and Phase B
    // (DBSCAN clustering) starts — the payload carries { faceCount } so the
    // UI can switch to "Clustering N faces..." without a polling round-trip.
    ws.on('ai_people_progress', (m) => _onScanProgress('faces', m));
    ws.on('ai_people_done', (m) => _onScanDone('faces', m));
    ws.on('ai_people_phase_b', (m) => _onScanPhaseB(m));
    ws.on('ai_faces_status', () => refreshStatus());
    ws.on('quality_backfill_progress', () => refreshStatus());
    ws.on('quality_backfill_done', () => {
        refreshStatus();
        _loadPeople().catch(() => {});
    });
    $('#ai-quality-backfill-btn')?.addEventListener('click', async () => {
        try {
            await api.post('/api/ai/backfill-quality');
        } catch {}
        refreshStatus();
    });
    // Auto-installer feedback. Streams stdout from `python -m
    // tgdl_faces.install` line-by-line so the operator sees pip progress
    // (downloading wheels, resolving deps, etc.) without leaving the
    // page. `ai_faces_install_done` flips the spinner off + reveals the
    // result toast.
    $('#ai-install-btn')?.addEventListener('click', _runInstaller);
    ws.on('ai_faces_install_progress', _onInstallProgress);
    ws.on('ai_faces_install_done', _onInstallDone);

    // Overflow menu → "Manage GPU support". Reveals the install card
    // even when the sidecar is healthy (so operators can switch EP),
    // closes the <details> menu, scrolls the card into view.
    $('#ai-open-install-btn')?.addEventListener('click', () => {
        const card = document.getElementById('ai-install-card');
        if (card) {
            card.classList.remove('hidden');
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        const menu = document.getElementById('ai-more-menu');
        if (menu instanceof HTMLDetailsElement) menu.open = false;
    });
}

async function _runInstaller() {
    const btn = $('#ai-install-btn');
    const sel = $('#ai-install-force');
    const force = String(sel?.value || '').trim() || undefined;
    const wrap = $('#ai-install-progress');
    const log = $('#ai-install-log');
    const status = $('#ai-install-status');
    if (log) log.textContent = '';
    if (wrap) wrap.classList.remove('hidden');
    if (status) status.textContent = i18nT('maintenance.ai.install.running', 'Installing…');
    if (btn) {
        btn.disabled = true;
        btn.dataset.busy = '1';
    }
    try {
        const r = await api.post('/api/ai/faces/install-deps', force ? { force } : {});
        if (!r.started && r.error) throw new Error(r.error);
    } catch (e) {
        if (status) status.textContent = i18nT('common.error', 'Error');
        if (log) log.textContent += `\n${e?.message || e}\n`;
        if (btn) {
            btn.disabled = false;
            delete btn.dataset.busy;
        }
        showToast(
            `${i18nT('maintenance.ai.install.failed', 'Install failed')}: ${e?.message || e}`,
            'error',
        );
    }
}

function _onInstallProgress(m) {
    const wrap = $('#ai-install-progress');
    const log = $('#ai-install-log');
    if (wrap) wrap.classList.remove('hidden');
    if (log && m && typeof m.line === 'string') {
        log.textContent += m.line + '\n';
        log.scrollTop = log.scrollHeight;
    }
}

function _onInstallDone(m) {
    const btn = $('#ai-install-btn');
    const status = $('#ai-install-status');
    if (btn) {
        btn.disabled = false;
        delete btn.dataset.busy;
    }
    if (m?.ok) {
        if (status)
            status.textContent = i18nT(
                'maintenance.ai.install.done',
                'Install complete — restarting sidecar…',
            );
        showToast(
            i18nT('maintenance.ai.install.done', 'Install complete — restarting sidecar…'),
            'success',
        );
        // Server kicks startSidecar() automatically; refresh status so
        // the badge flips to healthy as soon as the probe lands.
        setTimeout(() => refreshStatus().catch(() => {}), 1500);
    } else {
        const reason = m?.reason || i18nT('common.error', 'Error');
        if (status) status.textContent = reason;
        showToast(
            `${i18nT('maintenance.ai.install.failed', 'Install failed')}: ${reason}`,
            'error',
        );
    }
}

/**
 * Save a single config key + its nested `faces.*` alias (per Track I's
 * dual-write rule so `_mergeAi` doesn't quietly revert the value). For
 * keys not in the alias map this just writes the flat path.
 * `restartSidecar=true` (used for `facesDetectorModel`) also fire-and-
 * forgets a `/api/ai/faces/restart` so the new model loads next /detect.
 */
async function _saveSetting(cfgKey, value, { restartSidecar = false } = {}) {
    // Map UI control cfgKey → canonical save path. The slider/number controls
    // read from legacy flat keys (`cfg.facesEpsilon`, `cfg.facesMinPoints`),
    // but the new nested `advanced.ai.faces.*` block is the canonical home —
    // `_mergeAi` precedence is `faces.* > flat`, so a flat-key save gets
    // silently overridden on the next load. Save into BOTH paths so the
    // nested block actually changes.
    const saveAliases = {
        facesEpsilon: ['facesEpsilon', 'epsilon'],
        facesMinPoints: ['facesMinPoints', 'minPoints'],
        facesDetectorModel: ['facesDetectorModel', 'detectorModel'],
    };
    try {
        const body = { advanced: { ai: {} } };
        const alias = saveAliases[cfgKey];
        if (alias) {
            body.advanced.ai[alias[0]] = value;
            body.advanced.ai.faces = { [alias[1]]: value };
        } else if (cfgKey === 'videoScanLimit') {
            body.advanced.ai.faces = { videoScanLimit: value };
        } else if (cfgKey === 'videoNice') {
            body.advanced.ai.faces = { videoNice: value };
        } else {
            body.advanced.ai[cfgKey] = value;
        }
        const r = await api.post('/api/config', body);
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        if (restartSidecar) {
            try {
                await api.post('/api/ai/faces/restart', {});
            } catch (e) {
                console.warn('faces/restart on setting change:', e);
            }
        }
    } catch (e) {
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

async function _onAutoToggle() {
    const el = $('#ai-auto-toggle');
    if (!el) return;
    const cur = el.classList.contains('active');
    const next = !cur;
    // Optimistic flip so the click feels instant.
    el.classList.toggle('active', next);
    el.setAttribute('aria-checked', String(next));
    try {
        const r = await api.post('/api/config', {
            advanced: { ai: { faceClustering: next } },
        });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        await refreshStatus();
    } catch (e) {
        // Roll back optimistic flip.
        el.classList.toggle('active', cur);
        el.setAttribute('aria-checked', String(cur));
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

async function _onScanVideosToggle() {
    const el = $('#ai-scan-videos-toggle');
    if (!el) return;
    const cur = el.classList.contains('active');
    const next = !cur;
    el.classList.toggle('active', next);
    el.setAttribute('aria-checked', String(next));
    try {
        const r = await api.post('/api/config', {
            advanced: { ai: { faces: { scanVideos: next } } },
        });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        await refreshStatus();
    } catch (e) {
        el.classList.toggle('active', cur);
        el.setAttribute('aria-checked', String(cur));
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

// ---- Status / settings ----------------------------------------------------

function _renderStatus(status) {
    if (!status) return;
    const cfg = status.config || {};
    const counts = status.counts || {};
    const scans = status.scans || {};
    const models = status.models || {};

    // Sidecar status pill — always rendered now (the prior hide-on-
    // empty path silently dropped the chip during partial rollouts).
    _renderSidecarBadge(status);

    // Progress + scan buttons. Cancel is always rendered and just
    // toggles its disabled state; the thumbs page uses the same
    // contract so the controls feel consistent across the app.
    const facesScan = scans?.faces || {};
    const running = !!facesScan.running;
    const scanBtn = $('#ai-scan-btn');
    const cancelBtn = $('#ai-cancel-btn');
    if (scanBtn) scanBtn.disabled = running;
    if (cancelBtn) cancelBtn.disabled = !running;
    const prog = $('#ai-progress');
    if (prog) prog.classList.toggle('hidden', !running);
    if (running) {
        const scanned = Number(facesScan.scanned) || 0;
        const total = Number(facesScan.total) || 0;
        const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
        const bar = $('#ai-progress-bar');
        const pctEl = $('#ai-progress-pct');
        const statusEl = $('#ai-progress-status');
        if (bar) bar.style.width = `${pct}%`;
        if (pctEl)
            pctEl.textContent = total
                ? `${scanned.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`
                : `${scanned.toLocaleString()} processed`;
        if (statusEl) statusEl.textContent = _formatScanStatusText(facesScan.currentVideo);
    }

    // KPI tiles. peopleCount is the canonical "how many clusters"
    // metric; withFaces (distinct downloads that have at least one
    // face) gives a different shape and was confusing operators.
    const indexedEl = $('#ai-stat-indexed');
    if (indexedEl) {
        const indexed = Number(counts.indexed) || 0;
        const total = Number(counts.totalEligible) || 0;
        indexedEl.textContent = `${indexed.toLocaleString()} / ${total.toLocaleString()}`;
    }
    const peopleEl = $('#ai-stat-people');
    if (peopleEl) peopleEl.textContent = String(counts.peopleCount ?? counts.withFaces ?? 0);
    const lastEl = $('#ai-stat-last');
    if (lastEl) {
        const finishedAt = Number(scans?.faces?.finishedAt) || 0;
        lastEl.textContent =
            finishedAt > 0 ? new Date(finishedAt).toLocaleString() : i18nT('common.never', 'Never');
    }
    // Noise / unclassified faces count — DBSCAN marks faces that don't fit
    // any cluster as noise points. Excluded identities are omitted from
    // this counter (they stay person_id NULL by design).
    const noiseEl = $('#ai-stat-noise');
    const noiseTile = $('#ai-stat-noise-tile');
    if (noiseEl) {
        const noise = Number(counts.noiseFaces ?? counts.unclassified ?? 0);
        noiseEl.textContent = noise.toLocaleString();
        if (noiseTile) {
            const clickable = noise > 0;
            noiseTile.classList.toggle('opacity-60', !clickable);
            noiseTile.style.cursor = clickable ? 'pointer' : 'default';
            noiseTile.setAttribute('aria-disabled', clickable ? 'false' : 'true');
            noiseTile.tabIndex = clickable ? 0 : -1;
        }
    }

    // Quality backfill — show only when faces lack quality scores
    const backfillBtn = $('#ai-quality-backfill-btn');
    if (backfillBtn) {
        const pending = Number(status.qualityBackfillPending) || 0;
        const tracker = status.trackers?.qualityBackfill || {};
        const running = !!tracker.running;
        const done = !running && tracker.result != null;
        const show = (pending > 0 && !done) || running;
        backfillBtn.classList.toggle('hidden', !show);
        backfillBtn.disabled = running;
        const label = backfillBtn.querySelector('span');
        if (label) {
            if (running) {
                const p = tracker.progress || {};
                const pct = p.total > 0 ? Math.round((p.processed / p.total) * 100) : 0;
                label.textContent = `Scoring… ${pct}% (${(p.updated || 0).toLocaleString()} updated)`;
            } else if (pending > 0) {
                label.textContent = `Score ${pending.toLocaleString()} faces`;
            }
        }
    }

    // Quality legend — show when some faces have quality scores
    const legend = $('#ai-quality-legend');
    if (legend) {
        const pending = Number(status.qualityBackfillPending) || 0;
        const totalFaces = Number(counts.totalFaces ?? 0);
        const hasQuality = totalFaces > 0 && pending < totalFaces;
        legend.classList.toggle('hidden', !hasQuality);
    }

    // Toggles. Click handlers in `_bindOnce` flip the underlying flag
    // optimistically; this is the "render from server truth" pass that
    // runs on init + after every save round-trip.
    const masterToggle = $('#ai-master-toggle');
    if (masterToggle) {
        const on = !!cfg.enabled;
        masterToggle.classList.toggle('active', on);
        masterToggle.setAttribute('aria-checked', String(on));
    }
    const autoToggle = $('#ai-auto-toggle');
    if (autoToggle) {
        const on = cfg.faceClustering !== false;
        autoToggle.classList.toggle('active', on);
        autoToggle.setAttribute('aria-checked', String(on));
    }
    const scanVideosToggle = $('#ai-scan-videos-toggle');
    if (scanVideosToggle) {
        const on = cfg.faces?.scanVideos === true;
        scanVideosToggle.classList.toggle('active', on);
        scanVideosToggle.setAttribute('aria-checked', String(on));
    }
    const videoScanLimitInp = $('#ai-faces-video-scan-limit');
    if (videoScanLimitInp) {
        const cur = Number.isFinite(cfg.faces?.videoScanLimit) ? cfg.faces.videoScanLimit : 0;
        if (Number(videoScanLimitInp.value) !== cur) videoScanLimitInp.value = String(cur);
    }
    const videoNiceInp = $('#ai-faces-video-nice');
    if (videoNiceInp) {
        const cur = Number.isFinite(cfg.faces?.videoNice) ? cfg.faces.videoNice : 0;
        if (Number(videoNiceInp.value) !== cur) videoNiceInp.value = String(cur);
    }

    // Model line — id + dim + provider, served by /api/ai/status.
    const facesModel = models.faces || {};
    const modelId =
        facesModel.id || (facesModel.bundled ? 'insightface buffalo_l (Python sidecar)' : '—');
    const dim = facesModel.dim || (facesModel.bundled ? 512 : null);
    const provider = _resolveProvider(facesModel);
    const modelLine = [modelId, dim ? `${dim}-dim` : null, provider || null]
        .filter(Boolean)
        .join(' · ');
    const modelLineEl = $('#ai-model-line');
    if (modelLineEl) {
        modelLineEl.textContent = modelLine;
        modelLineEl.title = modelId;
    }

    // Settings inputs — sync values from config so F5 doesn't appear
    // to revert local changes. The `value =` write fires before any
    // change listener, so this is safe even when the slider is in the
    // operator's focus.
    const modelSel = $('#ai-faces-model');
    if (modelSel) {
        const cur = String(cfg.facesDetectorModel || cfg.faces?.detectorModel || 'buffalo_l');
        if (modelSel.value !== cur) modelSel.value = cur;
    }
    const epsInp = $('#ai-faces-epsilon');
    const epsOut = $('#ai-faces-epsilon-out');
    if (epsInp) {
        const cur = Number.isFinite(cfg.facesEpsilon) ? Number(cfg.facesEpsilon) : 1.05;
        if (Number(epsInp.value) !== cur) epsInp.value = String(cur);
        if (epsOut) epsOut.textContent = Number(cur).toFixed(2);
    }
    const minInp = $('#ai-faces-min-points');
    if (minInp) {
        const cur = Number.isFinite(cfg.facesMinPoints) ? Number(cfg.facesMinPoints) : 2;
        if (Number(minInp.value) !== cur) minInp.value = String(cur);
    }
    // Highlight whichever preset matches the live ε + minPoints combo so
    // the operator can see at a glance which mode is active.
    _highlightPreset(
        Number.isFinite(cfg.facesEpsilon) ? cfg.facesEpsilon : 1.05,
        Number.isFinite(cfg.facesMinPoints) ? cfg.facesMinPoints : 2,
    );
    const provSel = $('#ai-faces-provider');
    if (provSel) {
        const cur = String(cfg.faces?.providers || 'auto').toLowerCase();
        if (provSel.value !== cur) provSel.value = cur;
    }

    const sidecarUrlEl = $('#ai-faces-sidecar-url');
    if (sidecarUrlEl) {
        const cur = String(cfg.faces?.sidecarUrl || '');
        if (sidecarUrlEl.value !== cur) sidecarUrlEl.value = cur;
    }
    _syncFacesModeToggle();
}

function _renderSidecarBadge(status) {
    const badge = $('#ai-sidecar-badge');
    const text = $('#ai-sidecar-badge-text');
    if (!badge || !text) return;
    // The pill is always rendered now — operators want to see the
    // sidecar's state at a glance regardless of payload shape.
    badge.classList.remove('hidden');
    const faces = (status?.models && status.models.faces) || {};
    const state = String(faces.state || (faces.loaded ? 'healthy' : 'unknown')).toLowerCase();
    const provider = _resolveProvider(faces);
    let label;
    let cls = 'text-tg-textSecondary';
    let healthy = false;
    if (state === 'healthy' || state === 'ready' || faces.loaded === true) {
        const providerTag = provider || 'CPU';
        const modelTag = faces.id
            ? String(faces.id)
                  .replace(/insightface\s*/i, '')
                  .trim()
            : '';
        const ver = faces.version ? `v${faces.version}` : '';
        const mode = String(faces.mode || status?.trackers?.faces?.mode || '').toLowerCase();
        const modeTag =
            mode === 'external'
                ? '🌐 External'
                : mode === 'docker'
                  ? '🐳 Docker'
                  : mode === 'override'
                    ? '⚙ Override'
                    : mode === 'local'
                      ? '💻 Local'
                      : '';
        const parts = [modeTag, providerTag, modelTag, ver].filter(Boolean).join(' · ');
        label = i18nTf(
            'maintenance.ai.sidecar.healthy',
            { provider: parts },
            `Sidecar: ready (${parts})`,
        );
        cls = 'text-green-300';
        healthy = true;
    } else if (state === 'downloading' || state === 'pulling') {
        const pct = Number.isFinite(faces.downloadPct) ? Math.round(faces.downloadPct) : 0;
        label = i18nTf(
            'maintenance.ai.sidecar.downloading',
            { pct },
            `Sidecar: downloading… (${pct}%)`,
        );
        cls = 'text-yellow-300';
    } else if (state === 'starting' || state === 'loading') {
        label = i18nT('maintenance.ai.sidecar.starting', 'Sidecar: starting…');
        cls = 'text-yellow-300';
    } else if (state === 'disabled' || state === 'idle') {
        label = i18nT('maintenance.ai.sidecar.idle', 'Sidecar: idle');
        cls = 'text-tg-textSecondary';
    } else {
        label = i18nT('maintenance.ai.sidecar.down', 'Sidecar offline — start the faces service');
        cls = 'text-red-300';
    }
    text.textContent = label;
    badge.classList.remove(
        'text-green-300',
        'text-yellow-300',
        'text-red-300',
        'text-tg-textSecondary',
    );
    badge.classList.add(cls);

    // Dot indicator — swap the icon class to reflect the health colour.
    const dotIcon = badge.querySelector('.ai-sidecar-dot');
    if (dotIcon) {
        dotIcon.classList.remove(
            'text-green-400',
            'text-yellow-400',
            'text-red-400',
            'text-tg-textSecondary',
        );
        if (cls === 'text-green-300') dotIcon.classList.add('text-green-400');
        else if (cls === 'text-yellow-300') dotIcon.classList.add('text-yellow-400');
        else if (cls === 'text-red-300') dotIcon.classList.add('text-red-400');
        else dotIcon.classList.add('text-tg-textSecondary');
    }

    // Auto-surface the Install card when the sidecar isn't healthy and
    // we're not mid-installation already. Hide it once it's up so the
    // page reads as "everything's working" with no extra panels. The
    // operator can still trigger /api/ai/faces/install-deps from the
    // Re-cluster era (re-installing manually) by reopening the page
    // when offline — the card reappears on the next status flip.
    const installCard = $('#ai-install-card');
    if (installCard) {
        const installBusy = $('#ai-install-btn')?.dataset?.busy === '1';
        const showInstall = !healthy && !installBusy;
        installCard.classList.toggle('hidden', !showInstall);
    }
}

// Map onnxruntime's full provider name to the friendly tag we show in
// the UI. Without this, "DmlExecutionProvider" → "Dml" reads as a typo;
// "CUDAExecutionProvider" → "CUDA" is fine but it's worth normalising
// the whole table so the chip text stays consistent regardless of EP.
const _PROVIDER_LABEL = {
    DmlExecutionProvider: 'DirectML',
    CUDAExecutionProvider: 'CUDA',
    CoreMLExecutionProvider: 'CoreML',
    OpenVINOExecutionProvider: 'OpenVINO',
    TensorrtExecutionProvider: 'TensorRT',
    AzureExecutionProvider: 'Azure',
    CPUExecutionProvider: 'CPU',
};

function _resolveProvider(faces) {
    // The Python sidecar reports `providers: ["DmlExecutionProvider", ...]`.
    // Display the friendly tag (DirectML / CUDA / CoreML / CPU) — the
    // ExecutionProvider suffix is noise in a one-line badge.
    const list = Array.isArray(faces.providers)
        ? faces.providers
        : faces.provider
          ? [faces.provider]
          : [];
    if (!list.length) return '';
    const first = String(list[0] || '');
    return _PROVIDER_LABEL[first] || first.replace(/ExecutionProvider$/i, '').trim();
}

async function _onMasterToggle() {
    const el = $('#ai-master-toggle');
    if (!el) return;
    const cur = el.classList.contains('active');
    const next = !cur;
    // Optimistic flip — feels instant; rolled back below on save failure.
    el.classList.toggle('active', next);
    el.setAttribute('aria-checked', String(next));
    try {
        const r = await api.post('/api/config', { advanced: { ai: { enabled: next } } });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        await refreshStatus();
    } catch (e) {
        el.classList.toggle('active', cur);
        el.setAttribute('aria-checked', String(cur));
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

// ---- Hardware provider probe ----------------------------------------------

// Dropdown short-key ↔ onnxruntime full provider name. Kept in sync with
// `faces-service/tgdl_faces/insight.py:_PROVIDER_ALIASES` so the UI and
// the sidecar agree on which probe entry maps to which dropdown option.
const _ONNX_PROVIDER_MAP = {
    cuda: 'CUDAExecutionProvider',
    coreml: 'CoreMLExecutionProvider',
    directml: 'DmlExecutionProvider',
    openvino: 'OpenVINOExecutionProvider',
    cpu: 'CPUExecutionProvider',
};

function _providerShortKey(fullName) {
    for (const [k, v] of Object.entries(_ONNX_PROVIDER_MAP)) {
        if (v === fullName) return k;
    }
    return null;
}

/**
 * Apply probe results to the provider dropdown:
 *   - disable + line-through every option whose underlying onnxruntime
 *     provider didn't verify (so the operator can't pick a broken one)
 *   - auto-select the recommended provider when the operator was on
 *     'auto', so the active choice matches the chip list at a glance
 *   - keep 'auto' always enabled (the sidecar resolves it at runtime)
 */
function _applyProbeToProviderSelect(probe) {
    const sel = $('#ai-faces-provider');
    if (!sel) return;
    const details = Array.isArray(probe?.details) ? probe.details : [];
    const detailsByShort = new Map();
    for (const d of details) {
        const shortKey = _providerShortKey(d.name);
        if (shortKey) detailsByShort.set(shortKey, d);
    }
    const recommendedShort = _providerShortKey(probe?.recommended);

    for (const opt of sel.options) {
        const v = String(opt.value || '').toLowerCase();
        if (v === 'auto') {
            opt.disabled = false;
            const recLabel = recommendedShort
                ? ` — ${i18nT('maintenance.ai.faces.providers.auto_picks', 'picks')} ${(_ONNX_PROVIDER_MAP[recommendedShort] || recommendedShort).replace('ExecutionProvider', '')}`
                : '';
            const base = i18nT('maintenance.ai.faces.providers.auto', 'Auto (best available)');
            opt.textContent = base + recLabel;
            continue;
        }
        const d = detailsByShort.get(v);
        const labelKey = `maintenance.ai.faces.providers.${v}`;
        const defaultLabel = opt.dataset._baseLabel || opt.textContent;
        if (!opt.dataset._baseLabel) opt.dataset._baseLabel = defaultLabel;
        const baseLabel = i18nT(labelKey, defaultLabel);
        if (!d) {
            opt.disabled = true;
            opt.textContent = `${baseLabel} — ${i18nT('maintenance.ai.faces.providers.unsupported', 'not available on this host')}`;
            continue;
        }
        if (d.verified) {
            opt.disabled = false;
            const star = v === recommendedShort ? '★ ' : '✓ ';
            opt.textContent = `${star}${baseLabel}`;
            opt.title = '';
        } else {
            opt.disabled = true;
            const hint = d.error
                ? i18nT('maintenance.ai.faces.providers.unavailable', 'unavailable')
                : i18nT(
                      'maintenance.ai.faces.providers.driver_missing',
                      'driver / libraries missing',
                  );
            opt.textContent = `✗ ${baseLabel} — ${hint}`;
            opt.title = d.error || '';
        }
    }

    // If the operator was on 'auto', leave 'auto' selected — the sidecar
    // will pick `recommendedShort` itself. If they had a specific choice
    // that is now disabled, fall back to 'auto' so saves don't fail.
    const cur = String(sel.value || 'auto').toLowerCase();
    const curOpt = Array.from(sel.options).find((o) => String(o.value).toLowerCase() === cur);
    if (curOpt?.disabled) {
        sel.value = 'auto';
        // Persist the safe default so the next save round-trip matches.
        _onFacesProviderChange({ target: { value: 'auto' } });
    }
}

async function _runFacesProviderProbe() {
    const resultEl = $('#ai-faces-provider-probe-result');
    const btn = $('#ai-faces-provider-probe-btn');
    if (!resultEl) return;
    resultEl.textContent = i18nT('maintenance.ai.faces.providers.probing', 'Probing…');
    if (btn) btn.disabled = true;
    try {
        const r = await api.get('/api/ai/faces/provider-probe');
        const details = Array.isArray(r?.details) ? r.details : [];
        const available = Array.isArray(r?.available) ? r.available : [];
        if (!available.length) {
            resultEl.innerHTML = `<span class="text-yellow-300">${escapeHtml(
                i18nT(
                    'maintenance.ai.faces.providers.none',
                    'No working provider — falling back to CPU',
                ),
            )}</span>`;
            _applyProbeToProviderSelect(r);
            return;
        }
        // Render every candidate so the operator sees the full picture
        // (e.g. CUDA listed but unverified = driver missing; CPU
        // verified = always usable as a fallback). Verified chips get
        // the tg-blue accent; unverified ones are dimmed + struck.
        const chips = details
            .map((p) => {
                const okCls = p.verified
                    ? 'bg-tg-blue/20 text-tg-blue'
                    : 'bg-tg-bg/30 text-tg-textSecondary line-through';
                const icon = p.verified ? 'ri-check-line' : 'ri-close-line';
                return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md ${okCls} text-[10px] font-medium" title="${escapeHtml(
                    p.error || '',
                )}"><i class="${icon}"></i>${escapeHtml(p.name)}</span>`;
            })
            .join(' ');
        const rec = r?.recommended
            ? `<div class="mt-1.5 text-[11px]"><span class="opacity-70">${escapeHtml(
                  i18nT('maintenance.ai.faces.providers.recommended', 'Recommended:'),
              )}</span> <span class="text-tg-blue font-medium">${escapeHtml(r.recommended)}</span></div>`
            : '';
        resultEl.innerHTML = chips + rec;
        _applyProbeToProviderSelect(r);
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        resultEl.innerHTML = `<span class="text-red-300">${escapeHtml(
            i18nT('maintenance.ai.faces.providers.probe_failed', 'Probe failed:'),
        )} ${escapeHtml(msg)}</span>`;
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function _onFacesProviderChange(e) {
    const v = String(e.target?.value || 'auto').toLowerCase();
    try {
        // The nested faces.providers key is the canonical home (Track I);
        // POST /api/config deep-merges so we don't overwrite siblings.
        const r = await api.post('/api/config', {
            advanced: { ai: { faces: { providers: v } } },
        });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        // Trigger a sidecar relaunch so the new provider takes effect on
        // the next scan. Best-effort — failures are surfaced as toasts
        // but the saved value still wins on the next process boot.
        try {
            await api.post('/api/ai/faces/restart', {});
        } catch (relaunchErr) {
            // Older builds may not expose the restart endpoint yet; the
            // saved value still applies on next process boot.
            console.warn('faces/restart:', relaunchErr);
        }
    } catch (err) {
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${err?.data?.error || err?.message || 'unknown'}`,
            'error',
        );
    }
}

// ---- Sensitivity presets --------------------------------------------------
//
// Three opinionated combinations of ε + minPoints. Calibrated on real
// 900+ photo data (see scripts/calibrate-faces-eps.js). One click saves
// both values + immediately re-clusters so the operator sees new people
// within seconds instead of waiting for a full re-scan.

const _PRESETS = {
    precise: { epsilon: 0.9, minPoints: 3 },
    balanced: { epsilon: 1.05, minPoints: 2 },
    sensitive: { epsilon: 1.2, minPoints: 2 },
};

function _highlightPreset(eps, min) {
    document.querySelectorAll('.ai-preset-btn').forEach((btn) => {
        const p = _PRESETS[btn.dataset.preset];
        const active = p && Math.abs(p.epsilon - eps) < 0.005 && p.minPoints === min;
        btn.classList.toggle('border-tg-blue', active);
        btn.classList.toggle('bg-tg-blue/10', active);
    });
}

async function _applyPreset(name) {
    const p = _PRESETS[name];
    if (!p) return;
    // Update slider + number box immediately so the page feels responsive.
    const epsInp = $('#ai-faces-epsilon');
    const epsOut = $('#ai-faces-epsilon-out');
    const minInp = $('#ai-faces-min-points');
    if (epsInp) epsInp.value = String(p.epsilon);
    if (epsOut) epsOut.textContent = p.epsilon.toFixed(2);
    if (minInp) minInp.value = String(p.minPoints);
    _highlightPreset(p.epsilon, p.minPoints);
    // Persist both values in one save, then re-cluster.
    try {
        const body = {
            advanced: {
                ai: {
                    facesEpsilon: p.epsilon,
                    facesMinPoints: p.minPoints,
                    faces: { epsilon: p.epsilon, minPoints: p.minPoints },
                },
            },
        };
        const r = await api.post('/api/config', body);
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(
            i18nT(
                'maintenance.ai.preset_applied',
                `Preset "${name}" applied — rebuilding clusters…`,
            ),
            'success',
        );
        // ε changes need a full rebuild; incremental recluster won't reshape
        // existing people.
        const rb = await api.post('/api/ai/faces/rebuild', {});
        if (!rb.success) throw new Error(rb.error || 'rebuild failed');
        await refreshStatus();
        await _loadPeople();
    } catch (e) {
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

window._facesModeToggle = (mode) => _onFacesModeToggle(mode);
window._facesSidecarTest = () => _onFacesSidecarTestClick();
window._facesSidecarApply = () => _onFacesSidecarApply();
window._facesSidecarUrlInput = () => {
    const resultEl = $('#ai-faces-sidecar-test-result');
    if (resultEl) resultEl.textContent = '';
    const applyBtn = $('#ai-faces-sidecar-apply-btn');
    if (applyBtn) applyBtn.disabled = true;
};

function _onFacesModeToggle(mode) {
    const panel = $('#ai-faces-external-panel');
    for (const b of document.querySelectorAll('#ai-faces-mode-toggle .ai-mode-btn')) {
        b.classList.toggle('active', b.dataset.mode === mode);
    }
    if (mode === 'local') {
        if (panel) panel.classList.add('hidden');
        _switchFacesToLocal();
    } else {
        if (panel) panel.classList.remove('hidden');
    }
}

async function _switchFacesToLocal() {
    try {
        await api.post('/api/config', {
            advanced: { ai: { faces: { sidecarUrl: '' } } },
        });
        await api.post('/api/ai/faces/restart', {});
        const el = $('#ai-faces-sidecar-url');
        if (el) el.value = '';
        const resultEl = $('#ai-faces-sidecar-test-result');
        if (resultEl) resultEl.textContent = '';
        const applyBtn = $('#ai-faces-sidecar-apply-btn');
        if (applyBtn) applyBtn.disabled = true;
        showToast(
            i18nT('maintenance.ai.sidecar_url_cleared', 'Switched to local sidecar'),
            'success',
        );
        await refreshStatus();
    } catch (e) {
        showToast(`Switch failed: ${e?.data?.error || e?.message || 'unknown'}`, 'error');
    }
}

async function _onFacesSidecarTestClick() {
    const el = $('#ai-faces-sidecar-url');
    const resultEl = $('#ai-faces-sidecar-test-result');
    const applyBtn = $('#ai-faces-sidecar-apply-btn');
    const url = String(el?.value || '').trim();
    if (!url) {
        if (resultEl) {
            resultEl.textContent = i18nT('maintenance.ai.sidecar_test_empty', 'Enter a URL first');
            resultEl.className = 'text-[11px] mt-1.5 block text-yellow-400';
        }
        if (applyBtn) applyBtn.disabled = true;
        return;
    }
    if (resultEl) {
        resultEl.textContent = i18nT('maintenance.ai.sidecar_testing', 'Testing…');
        resultEl.className = 'text-[11px] mt-1.5 block text-tg-textSecondary';
    }
    if (applyBtn) applyBtn.disabled = true;
    try {
        const r = await api.post('/api/ai/faces/health-test', { url });
        if (resultEl) {
            if (r.ok) {
                const parts = [r.model, r.version ? `v${r.version}` : null]
                    .filter(Boolean)
                    .join(' · ');
                resultEl.textContent = `✓ ${parts || 'Connected'}`;
                resultEl.className = 'text-[11px] mt-1.5 block text-green-400';
                if (applyBtn) applyBtn.disabled = false;
            } else {
                resultEl.textContent = `✗ ${r.error || 'unreachable'}`;
                resultEl.className = 'text-[11px] mt-1.5 block text-red-400';
            }
        }
    } catch (e) {
        if (resultEl) {
            resultEl.textContent = `✗ ${e?.message || 'error'}`;
            resultEl.className = 'text-[11px] mt-1.5 block text-red-400';
        }
    }
}

async function _onFacesSidecarApply() {
    const el = $('#ai-faces-sidecar-url');
    const url = String(el?.value || '').trim();
    if (!url) return;
    try {
        await api.post('/api/config', {
            advanced: { ai: { faces: { sidecarUrl: url } } },
        });
        await api.post('/api/ai/faces/restart', {});
        showToast(
            i18nT('maintenance.ai.sidecar_url_saved', 'Switched to external sidecar'),
            'success',
        );
        await refreshStatus();
    } catch (e) {
        showToast(`Save failed: ${e?.data?.error || e?.message || 'unknown'}`, 'error');
    }
}

function _syncFacesModeToggle() {
    const urlEl = $('#ai-faces-sidecar-url');
    const hasUrl = String(urlEl?.value || '').trim().length > 0;
    const mode = hasUrl ? 'external' : 'local';
    for (const b of document.querySelectorAll('#ai-faces-mode-toggle .ai-mode-btn')) {
        b.classList.toggle('active', b.dataset.mode === mode);
    }
    const panel = $('#ai-faces-external-panel');
    if (panel) panel.classList.toggle('hidden', !hasUrl);
}

async function _restartSidecar() {
    try {
        await api.post('/api/ai/faces/restart', {});
        showToast(i18nT('maintenance.ai.restart_sidecar', 'Restart sidecar') + '…', 'success');
        await refreshStatus();
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        showToast(`Restart failed: ${msg}`, 'error');
    }
}

async function _recluster() {
    // Incremental Phase B — attach unassigned faces; keep merges/labels.
    try {
        const r = await api.post('/api/ai/faces/recluster', {});
        if (!r.success) throw new Error(r.error || 'recluster failed');
        showToast(
            i18nT('maintenance.ai.recluster_kicked', 'Assigning unassigned faces…'),
            'success',
        );
        await refreshStatus();
        await _loadPeople();
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        showToast(
            `${i18nT('maintenance.ai.recluster_failed', 'Re-cluster failed')}: ${msg}`,
            'error',
        );
    }
}

async function _rebuildAllClusters() {
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.rebuild_confirm_title', 'Rebuild all clusters?'),
        body: i18nT(
            'maintenance.ai.rebuild_confirm_body',
            'This wipes every Person cluster and the exclusion list, then re-runs DBSCAN on all face embeddings. Manual merges and exclusions will be lost. Labels are preserved when centroids still match. Use after changing ε.',
        ),
        confirmLabel: i18nT('maintenance.ai.rebuild_confirm_action', 'Rebuild'),
        cancelLabel: i18nT('common.cancel', 'Cancel'),
        danger: true,
    });
    if (!ok) return;
    try {
        const r = await api.post('/api/ai/faces/rebuild', {});
        if (!r.success) throw new Error(r.error || 'rebuild failed');
        showToast(
            i18nT('maintenance.ai.rebuild_kicked', 'Rebuilding all clusters…'),
            'success',
        );
        await refreshStatus();
        await _loadPeople();
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        showToast(
            `${i18nT('maintenance.ai.rebuild_failed', 'Rebuild failed')}: ${msg}`,
            'error',
        );
    }
}

async function _reindexFromScratch() {
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.reindex_confirm_title', 'Reindex from scratch?'),
        body: i18nT(
            'maintenance.ai.reindex_confirm_body',
            'This wipes EVERY face detection and EVERY person cluster, then re-scans every photo. Existing labels survive only if matching faces are detected again.',
        ),
        confirmLabel: i18nT('maintenance.ai.reindex_confirm_action', 'Reindex'),
        cancelLabel: i18nT('common.cancel', 'Cancel'),
        danger: true,
    });
    if (!ok) return;
    try {
        const r = await api.post('/api/ai/faces/reindex', {});
        if (!r.success) throw new Error(r.error || 'reindex failed');
        showToast(
            i18nT(
                'maintenance.ai.reindex_kicked',
                'Reindex started — every photo will be re-detected.',
            ),
            'success',
        );
        // Wipe local people cache + status to reflect the clean slate; the
        // scan progress events will refresh both as the run rebuilds them.
        _peopleCache = [];
        _selectedPerson = null;
        _selectedPersonName = '';
        $('#ai-people-photos')?.classList.add('hidden');
        _renderPeopleGrid().catch(() => {});
        await refreshStatus();
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        showToast(`${i18nT('maintenance.ai.reindex_failed', 'Reindex failed')}: ${msg}`, 'error');
    }
}

// ---- Detect-test (single-photo diagnostic) --------------------------------

async function _runDetectTest() {
    const idInput = $('#ai-detect-test-id');
    const resultEl = $('#ai-detect-test-result');
    const btn = $('#ai-detect-test-btn');
    const id = parseInt(idInput?.value, 10);
    if (!id || id < 1) {
        showToast(i18nT('maintenance.ai.detect_test_need_id', 'Enter a Download ID first'), 'info');
        return;
    }
    if (btn) btn.disabled = true;
    if (resultEl) {
        resultEl.textContent = '…';
        resultEl.classList.remove('hidden');
    }
    try {
        const r = await api.post('/api/ai/detect-test', { downloadId: id });
        if (!r.success) throw new Error(r.error || 'detect-test failed');
        const lines = [];
        lines.push(`File:    ${r.filePath || '—'}`);
        lines.push(`Abs:     ${r.absPath || '(not found on disk)'}`);
        lines.push(`Type:    ${r.fileType || '—'}`);
        if (r.error) {
            lines.push(`Error:   ${r.error}`);
        } else if (r.rawCount === null) {
            lines.push('Result:  sidecar returned null (unreachable or hard error)');
        } else if (r.rawCount === 0) {
            lines.push('Result:  0 faces detected after quality filter');
        } else {
            lines.push(`Result:  ${r.rawCount} face(s) detected`);
            for (const f of r.raw || []) {
                lines.push(
                    `  • box=${f.w}×${f.h}px, score=${f.score?.toFixed(3)}, emb=${f.embeddingDim}d`,
                );
            }
        }
        if (r.warnings?.length) {
            lines.push('');
            lines.push('Warnings:');
            for (const w of r.warnings) lines.push(`  ${w}`);
        }
        if (resultEl) resultEl.textContent = lines.join('\n');
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        if (resultEl) resultEl.textContent = `Error: ${msg}`;
        showToast(`${i18nT('common.error', 'Error')}: ${msg}`, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ---- Scan controls --------------------------------------------------------

async function _startScan(feature) {
    // Auto-enable the AI subsystem if the operator hits Scan with the
    // master toggle off — there's no real cost (faces clustering is
    // already gated by its own per-capability toggle) and operators
    // shouldn't have to find two switches to start a scan. The master
    // toggle remains visible so it can be turned off explicitly to
    // pause auto-index on new downloads.
    if (!_lastStatus?.config?.enabled) {
        try {
            await api.post('/api/config', {
                advanced: { ai: { enabled: true } },
            });
            await refreshStatus();
        } catch (e) {
            showToast(
                `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
                'error',
            );
            return;
        }
    }
    try {
        const r = await api.post('/api/ai/scan/start', { feature });
        if (r.error) {
            showToast(r.error, 'error');
            return;
        }
        showToast(i18nT('maintenance.ai.scan_started', 'Scan started'), 'success');
    } catch (e) {
        showToast(`${i18nT('common.error', 'Error')}: ${e.message}`, 'error');
    }
}

async function _cancelScan(feature) {
    try {
        await api.post('/api/ai/scan/cancel', { feature });
        showToast(i18nT('maintenance.ai.scan_cancelled', 'Scan cancelled'), 'info');
    } catch (e) {
        showToast(`${i18nT('common.error', 'Error')}: ${e.message}`, 'error');
    }
}

function _onScanProgress(feature, msg) {
    // Faces is the only feature today — `feature` arg kept for future
    // OCR / object detection drops that reuse this WS handler.
    if (feature !== 'faces') return;
    const running = !!msg.running;
    const scanned = Number(msg.scanned) || 0;
    const total = Number(msg.total) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;

    // Phase B transition: scan-runner emits running=true + phase='B' when
    // detection is complete and DBSCAN is about to start. Hand off to the
    // Phase B handler and skip the Phase A progress-bar update.
    if (running && msg.phase === 'B') {
        _onScanPhaseB({ faceCount: msg.faceCount });
        const scanBtn = $('#ai-scan-btn');
        const cancelBtn = $('#ai-cancel-btn');
        if (scanBtn) scanBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = false;
        return;
    }

    const scanBtn = $('#ai-scan-btn');
    const cancelBtn = $('#ai-cancel-btn');
    const progressWrap = $('#ai-progress');
    const progressBar = $('#ai-progress-bar');
    const progressPct = $('#ai-progress-pct');
    const progressStatus = $('#ai-progress-status');
    const phaseTag = $('#ai-progress-phase');

    // If progress is arriving we're in Phase A — Phase B has its own event.
    if (running) _scanPhase = 'A';

    if (scanBtn) scanBtn.disabled = running;
    if (cancelBtn) cancelBtn.disabled = !running;
    if (progressWrap) progressWrap.classList.toggle('hidden', !running);
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressPct) {
        progressPct.textContent = running
            ? total
                ? `${scanned.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`
                : `${scanned.toLocaleString()} processed`
            : '';
    }
    if (progressStatus && running) {
        progressStatus.textContent = _formatScanStatusText(msg.currentVideo);
    }
    // Phase tag — shows "Phase 1: detection" during A; hidden when idle.
    if (phaseTag) {
        phaseTag.textContent = running
            ? i18nT('maintenance.ai.scan_phase_a', 'Phase 1: face detection')
            : '';
        phaseTag.classList.toggle('hidden', !running);
    }
    // Update "Indexed photos" KPI tile in realtime during Phase A so the
    // operator sees progress without waiting for the full scan to finish.
    if (running && scanned > 0) {
        const indexedEl = $('#ai-stat-indexed');
        if (indexedEl) {
            indexedEl.textContent =
                total > 0
                    ? `${scanned.toLocaleString()} / ${total.toLocaleString()}`
                    : scanned.toLocaleString();
        }
    }
}

/**
 * Phase B starts once every photo has been detected. The payload carries
 * { faceCount } — the total number of face embeddings about to be clustered.
 * We swap the progress bar to indeterminate (pulse animation) and show a
 * "Clustering N faces…" label. The bar stays full-width so the operator
 * sees "almost done" at a glance.
 */
function _onScanPhaseB(msg) {
    _scanPhase = 'B';
    const progressWrap = $('#ai-progress');
    const progressBar = $('#ai-progress-bar');
    const progressPct = $('#ai-progress-pct');
    const progressStatus = $('#ai-progress-status');
    const phaseTag = $('#ai-progress-phase');

    if (progressWrap) progressWrap.classList.remove('hidden');
    // Full-width bar with shimmer class to signal "indeterminate but close".
    if (progressBar) {
        progressBar.style.width = '100%';
        progressBar.classList.add('ai-progress-clustering');
    }
    const faceCount = Number(msg?.faceCount) || 0;
    if (progressPct) progressPct.textContent = '';
    if (progressStatus) {
        progressStatus.textContent =
            faceCount > 0
                ? i18nTf(
                      'maintenance.ai.scan_phase_b_faces',
                      { n: faceCount.toLocaleString() },
                      `Clustering ${faceCount.toLocaleString()} faces…`,
                  )
                : i18nT('maintenance.ai.scan_phase_b', 'Clustering faces…');
    }
    if (phaseTag) {
        phaseTag.textContent = i18nT(
            'maintenance.ai.scan_phase_b_tag',
            'Phase 2: DBSCAN clustering',
        );
        phaseTag.classList.remove('hidden');
    }
}

function _onScanDone(feature, msg) {
    // Reset phase state + remove shimmer from the bar.
    _scanPhase = 'A';
    const progressBar = $('#ai-progress-bar');
    if (progressBar) progressBar.classList.remove('ai-progress-clustering');
    const phaseTag = $('#ai-progress-phase');
    if (phaseTag) phaseTag.classList.add('hidden');

    _onScanProgress(feature, { ...msg, running: false });
    if (msg?.error) {
        showToast(`${feature}: ${msg.error}`, 'error');
    } else {
        // Show "Found Y people in Z faces" summary on successful completion.
        const people = Number(msg?.peopleCount ?? msg?.people) || 0;
        const faces = Number(msg?.faceCount ?? msg?.faces) || 0;
        if (people > 0 || faces > 0) {
            const summary = i18nTf(
                'maintenance.ai.scan_done_summary',
                { people: people.toLocaleString(), faces: faces.toLocaleString() },
                `Found ${people.toLocaleString()} people in ${faces.toLocaleString()} faces`,
            );
            showToast(summary, 'success');
        } else {
            showToast(i18nT('maintenance.ai.scan_done', 'Scan complete'), 'success');
        }
    }
    refreshStatus();
    if (feature === 'faces') _loadPeople();
}

// ---- People (face clusters) ----------------------------------------------

async function _loadPeople() {
    try {
        const r = await api.get('/api/ai/people?limit=2000');
        if (!r.success) return;
        _peopleCache = Array.isArray(r.people) ? r.people : [];
        await _renderPeopleGrid();
        await _loadExcludedPeople();
    } catch (e) {
        console.warn('ai/people:', e);
    }
}

async function _loadExcludedPeople() {
    const wrap = $('#ai-people-excluded');
    const list = $('#ai-people-excluded-list');
    const countEl = $('#ai-people-excluded-count');
    if (!wrap || !list) return;
    try {
        const r = await api.get('/api/ai/people/excluded?limit=500');
        if (!r.success) return;
        const rows = Array.isArray(r.excluded) ? r.excluded : [];
        if (!rows.length) {
            wrap.classList.add('hidden');
            list.innerHTML = '';
            if (countEl) countEl.textContent = '';
            return;
        }
        wrap.classList.remove('hidden');
        if (countEl) countEl.textContent = `(${rows.length})`;
        const unnamed = i18nT('maintenance.ai.excluded.unnamed', 'Excluded person');
        const restoreLabel = i18nT('maintenance.ai.excluded.restore', 'Restore');
        list.innerHTML = rows
            .map((row) => {
                const name = escapeHtml(row.label || unnamed);
                const id = Number(row.id);
                const faceId = Number(row.cover_face_id);
                const faceHtml =
                    Number.isFinite(faceId) && faceId > 0
                        ? `<img src="/api/ai/faces/${faceId}/crop?w=64" alt="${name}" loading="lazy"
                            class="w-full h-full object-cover"
                            onerror="this.onerror=null;this.replaceWith(Object.assign(document.createElement('i'),{className:'ri-user-line text-sm text-tg-textSecondary/40'}))">`
                        : `<i class="ri-user-line text-sm text-tg-textSecondary/40"></i>`;
                return `<li class="flex items-center justify-between gap-2 py-1.5 px-1 rounded-lg hover:bg-white/[0.03]">
                    <span class="inline-flex items-center gap-2.5 min-w-0">
                        <span class="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 bg-tg-bg/60 ring-1 ring-tg-border/30 flex items-center justify-center">${faceHtml}</span>
                        <span class="text-xs text-tg-text truncate min-w-0">${name}</span>
                    </span>
                    <button type="button" data-restore-excluded="${id}"
                        class="tg-btn-secondary text-[10px] h-6 px-2 flex-shrink-0">${escapeHtml(restoreLabel)}</button>
                </li>`;
            })
            .join('');
    } catch (e) {
        console.warn('ai/people/excluded:', e);
    }
}

async function _renderPeopleGrid() {
    const grid = $('#ai-people-grid');
    const empty = $('#ai-people-empty');
    const emptyHelp = $('#ai-people-empty-help');
    const epsilonWarn = $('#ai-epsilon-warning');
    const count = $('#ai-people-count');
    if (!grid) return;

    // Apply filters client-side. The list is bounded at 2000 by the
    // API request limit; a >2000-cluster library would need server-side
    // pagination.
    const q = _peopleFilter.query;
    const unlabeled = _peopleFilter.unlabeledOnly;
    const videosOnly = _peopleFilter.videosOnly;
    const hideLQ = _peopleFilter.hideLowQuality;
    const sortBy = _peopleFilter.sortBy || 'face_count';
    const filtered = _peopleCache.filter((p) => {
        if (unlabeled && p.label) return false;
        if (videosOnly && !(Number(p.video_face_count) > 0)) return false;
        if (hideLQ && (Number(p.avg_quality) || 0) < 0.3 && (Number(p.avg_quality) || 0) > 0)
            return false;
        if (q) {
            const hay = `${p.label || ''} ${p.id}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });
    if (sortBy === 'avg_quality') {
        filtered.sort((a, b) => (Number(b.avg_quality) || 0) - (Number(a.avg_quality) || 0));
    } else if (sortBy === 'name') {
        filtered.sort((a, b) => (a.label || `zzz${a.id}`).localeCompare(b.label || `zzz${b.id}`));
    }

    const countText = $('#ai-people-count-text') || count;
    if (countText) {
        countText.textContent = filtered.length
            ? `(${filtered.length}${
                  filtered.length !== _peopleCache.length ? `/${_peopleCache.length}` : ''
              })`
            : '';
    }
    const qualityHint = $('#ai-quality-hint');
    if (qualityHint) {
        const hasQ = _peopleCache.some((p) => Number(p.avg_quality) > 0);
        qualityHint.classList.toggle('hidden', !hasQ);
    }

    const testForm = $('#ai-detect-test-form');
    if (!filtered.length) {
        grid.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        // Help message: "no faces detected" — only shown when the full
        // (unfiltered) cache is also empty, i.e. not just a filter miss.
        let showTestForm = false;
        if (emptyHelp) {
            if (_peopleCache.length === 0) {
                // Determine whether the sidecar is reachable to give context.
                const faces = _lastStatus?.models?.faces || {};
                const counts = _lastStatus?.counts || {};
                const sidecarUp =
                    faces.loaded === true || faces.state === 'healthy' || faces.state === 'ready';
                const lastScan = _lastStatus?.scans?.faces?.finishedAt || 0;
                const scannedPhotos = Number(counts.indexed) || 0;
                if (!sidecarUp) {
                    emptyHelp.textContent = i18nT(
                        'maintenance.ai.people_empty_sidecar_down',
                        'No faces detected — ensure the faces sidecar is running and photos exist.',
                    );
                } else if (lastScan > 0 && scannedPhotos > 0) {
                    // Scan ran + photos indexed but 0 clusters. Most likely
                    // cause: epsilon too tight or minPoints too high. Suggest
                    // the Sensitive preset as the one-click fix.
                    const noiseFaces = Number(
                        _lastStatus?.counts?.noiseFaces ?? _lastStatus?.counts?.unclassified ?? 0,
                    );
                    if (noiseFaces > 0) {
                        emptyHelp.innerHTML = i18nT(
                            'maintenance.ai.people_empty_noise',
                            `Faces were detected but none clustered into people (${noiseFaces.toLocaleString()} unclassified). Try <strong>Sensitive</strong> preset above, then Re-cluster.`,
                        ).replace('{noise}', noiseFaces.toLocaleString());
                    } else {
                        emptyHelp.textContent = i18nT(
                            'maintenance.ai.people_empty_scan_ran',
                            'Scan complete — no faces were detected. Try the Sensitive preset or use the test tool to check a specific photo.',
                        );
                    }
                    showTestForm = true;
                } else {
                    emptyHelp.textContent = i18nT(
                        'maintenance.ai.people_empty_no_faces',
                        'No faces detected — run a scan above to index your photos.',
                    );
                }
                emptyHelp.classList.remove('hidden');
            } else {
                emptyHelp.classList.add('hidden');
            }
        }
        if (testForm) testForm.classList.toggle('hidden', !showTestForm);
        return;
    }
    if (empty) empty.classList.add('hidden');
    if (emptyHelp) emptyHelp.classList.add('hidden');
    if (testForm) testForm.classList.add('hidden');

    // Epsilon warning — surface when a single cluster contains an unusually
    // large share of all faces (>25%), which is the canonical symptom of
    // the epsilon being too high and merging everyone together.
    if (epsilonWarn) {
        const totalFaces = _peopleCache.reduce((s, p) => s + (Number(p.face_count) || 0), 0);
        const maxCluster = Math.max(..._peopleCache.map((p) => Number(p.face_count) || 0));
        const dominance = totalFaces > 0 ? maxCluster / totalFaces : 0;
        // Also warn when fewer than expected clusters exist — a common sign
        // of over-merging is having 1–3 clusters for a large library.
        const megaMerge = dominance > 0.25 && totalFaces > 20;
        epsilonWarn.classList.toggle('hidden', !megaMerge);
    }

    const INITIAL_RENDER = 60;
    const LOAD_MORE_SIZE = 80;
    const token = ++_peopleRenderToken;

    const attachCard = (b) => {
        b.addEventListener('click', () => {
            if (_splitModeActive) _exitSplitMode();
            grid.querySelectorAll('.ai-person-card').forEach((el) =>
                el.classList.remove('ring-2', 'ring-tg-blue/50', 'bg-tg-blue/10'),
            );
            b.classList.add('ring-2', 'ring-tg-blue/50', 'bg-tg-blue/10');
            _selectedPerson = Number(b.dataset.person);
            _selectedPersonName = b.dataset.name || '';
            _showPersonPhotos();
        });
        b.addEventListener('dblclick', (e) => {
            if (e.target.closest('.ai-person-name')) {
                e.preventDefault();
                e.stopPropagation();
                _selectedPerson = Number(b.dataset.person);
                _selectedPersonName = b.dataset.name || '';
                _renameSelectedPerson();
            }
        });
    };

    const renderChunk = (start, count) => {
        const end = Math.min(start + count, filtered.length);
        const frag = document.createDocumentFragment();
        for (let j = start; j < end; j++) {
            const div = document.createElement('div');
            div.innerHTML = _personTile(filtered[j]);
            const card = div.firstElementChild;
            attachCard(card);
            frag.appendChild(card);
        }
        grid.appendChild(frag);
        if (_selectedPerson) {
            const sel = grid.querySelector(`[data-person="${_selectedPerson}"]`);
            if (sel) sel.classList.add('ring-2', 'ring-tg-blue/50', 'bg-tg-blue/10');
        }
        return end;
    };

    grid.innerHTML = '';
    let rendered = renderChunk(0, INITIAL_RENDER);

    // "Load more" button for progressive loading
    const existing = grid.parentElement?.querySelector('.ai-load-more-btn');
    if (existing) existing.remove();

    if (rendered < filtered.length) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className =
            'ai-load-more-btn w-full py-2.5 mt-2 rounded-xl text-xs font-medium text-tg-textSecondary border border-tg-border/30 hover:border-tg-blue/50 hover:text-tg-blue hover:bg-tg-blue/5 transition-all';
        const updateLabel = () => {
            const remaining = filtered.length - rendered;
            btn.textContent = `Show more (${remaining.toLocaleString()} remaining)`;
        };
        updateLabel();
        btn.addEventListener('click', () => {
            if (token !== _peopleRenderToken) return;
            rendered = renderChunk(rendered, LOAD_MORE_SIZE);
            if (rendered >= filtered.length) {
                btn.remove();
            } else {
                updateLabel();
            }
        });
        grid.after(btn);
    }
}

function _personTile(p) {
    const isUnclassified = p.id === -1 || p.noise === true;
    const name = isUnclassified
        ? i18nT('maintenance.ai.person_unclassified', 'Unclassified')
        : p.label || `Person #${p.id}`;
    const faceCount = Number(p.face_count) || 0;
    const safeName = escapeHtml(name);

    const bust = _personAvatarBust(p);
    const faceUrl =
        !isUnclassified && p.id > 0 ? `/api/ai/person/${p.id}/face?w=128&v=${bust}` : '';
    const fallbackUrl = p.cover_download_id ? `/api/thumbs/${p.cover_download_id}?w=128` : '';

    let imgHtml;
    if (faceUrl) {
        const fb = fallbackUrl
            ? `this.onerror=null;this.src='${escapeHtml(fallbackUrl)}'`
            : "this.onerror=null;this.replaceWith(Object.assign(document.createElement('i'),{className:'ri-user-line text-2xl text-tg-textSecondary/40'}))";
        imgHtml = `<img src="${escapeHtml(faceUrl)}" alt="${safeName}" loading="lazy" class="w-full h-full object-cover" onerror="${fb}">`;
    } else if (fallbackUrl) {
        imgHtml = `<img src="${fallbackUrl}" alt="${safeName}" loading="lazy" class="w-full h-full object-cover">`;
    } else {
        imgHtml = `<i class="ri-user-line text-2xl text-tg-textSecondary/40"></i>`;
    }

    const videoFaceCount = Number(p.video_face_count) || 0;
    const avgQ = Number(p.avg_quality) || 0;

    // Single combined info badge — bottom-right pill with all metadata
    const parts = [];
    if (faceCount > 0) parts.push(`${faceCount}`);
    if (videoFaceCount > 0) parts.push(`<i class="ri-film-line" style="font-size:8px"></i>`);
    if (avgQ > 0) {
        const qLabel = avgQ >= 0.7 ? 'HQ' : avgQ >= 0.4 ? 'MQ' : 'LQ';
        parts.push(qLabel);
    }
    const infoBadge = parts.length
        ? `<span class="absolute -bottom-1 left-1/2 -translate-x-1/2 h-[16px] px-1.5 rounded-full bg-black/70 text-white text-[8px] font-medium flex items-center justify-center gap-1 leading-none backdrop-blur-sm whitespace-nowrap">${parts.join('<span class="opacity-40">·</span>')}</span>`
        : '';

    const qTip = avgQ > 0 ? ` · Quality: ${(avgQ * 100).toFixed(0)}%` : '';

    return `<button type="button" data-person="${p.id}" data-name="${safeName}"
        title="${safeName} · ${faceCount} ${escapeHtml(i18nT('maintenance.ai.faces_short', 'faces'))}${videoFaceCount > 0 ? ` (${videoFaceCount} from video)` : ''}${qTip}"
        class="ai-person-card flex flex-col items-center gap-1 p-1 rounded-xl hover:bg-tg-blue/5 active:scale-95 transition-all group text-center select-none">
        <div class="relative w-full">
            <div class="w-full aspect-square rounded-full overflow-hidden ring-2 ring-tg-border/30 group-hover:ring-tg-blue/60 transition-all flex items-center justify-center bg-tg-bg/40">
                ${imgHtml}
            </div>
            ${infoBadge}
        </div>
        <div class="w-full min-w-0 px-0.5">
            <div class="ai-person-name text-[9.5px] font-medium text-tg-text leading-tight truncate">${safeName}</div>
        </div>
    </button>`;
}

async function _showPersonPhotos() {
    if (!_selectedPerson) return;
    // A fresh person was selected — collapse any open face-review panel from
    // the previously selected person so it doesn't show stale faces.
    if (_faceReviewActive) _closeFaceReview();
    const photosPanel = $('#ai-people-photos');
    if (photosPanel) photosPanel.classList.remove('hidden');
    const nameEl = $('#ai-people-photos-name');
    if (nameEl) nameEl.textContent = _selectedPersonName;

    // Populate detail avatar immediately from the face crop endpoint.
    const detailAvatar = $('#ai-person-detail-avatar');
    if (detailAvatar) {
        if (_selectedPerson > 0) {
            const cached = _peopleCache.find((p) => p.id === _selectedPerson);
            const bust = _personAvatarBust(cached);
            detailAvatar.innerHTML = `<img src="/api/ai/person/${_selectedPerson}/face?w=80&v=${bust}" alt="${escapeHtml(_selectedPersonName)}" loading="lazy" class="w-full h-full object-cover" onerror="this.onerror=null;this.replaceWith(Object.assign(document.createElement('i'),{className:'ri-user-line text-lg text-tg-textSecondary/40'}))">`;
        } else {
            detailAvatar.innerHTML = `<i class="ri-user-line text-lg text-tg-textSecondary/40"></i>`;
        }
    }

    const grid = $('#ai-people-photos-grid');
    if (!grid) return;
    grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('common.loading', 'Loading…'))}</div>`;

    // Scroll the panel into view on mobile so the operator doesn't miss it.
    photosPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
        const r = await api.get(`/api/ai/people/${_selectedPerson}/photos?limit=120`);
        if (!r?.success) throw new Error(r?.error || 'load failed');
        let files = r.files || [];
        if (!files.length) {
            grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('maintenance.ai.no_photos', 'No photos in this cluster.'))}</div>`;
            const photoCount = $('#ai-person-photo-count');
            if (photoCount) photoCount.textContent = '';
            return;
        }
        const photoCount = $('#ai-person-photo-count');
        if (photoCount) {
            photoCount.textContent = `${files.length.toLocaleString()} ${i18nT('maintenance.ai.faces_short', 'appearances')}`;
        }
        grid.innerHTML = files.map(_photoTile).join('');
        if (_photoGridClickHandler) grid.removeEventListener('click', _photoGridClickHandler);
        if (_splitModeActive) {
            // Grid was refreshed while split mode is active — reinstall the
            // split click handler so the new tiles are selectable.
            _enterSplitMode();
        } else {
            _photoGridClickHandler = (e) => {
                const tile = e.target.closest('[data-meta]');
                if (!tile) return;
                const allTiles = Array.from(grid.querySelectorAll('[data-meta]'));
                const viewerFiles = allTiles.map(_personPhotoToViewerFile).filter(Boolean);
                const idx = allTiles.indexOf(tile);
                if (viewerFiles.length) {
                    openMediaViewerForReview(viewerFiles, Math.max(0, idx));
                }
            };
            grid.addEventListener('click', _photoGridClickHandler);
        }
    } catch (e) {
        grid.innerHTML = `<div class="col-span-full text-center text-xs text-red-300 py-8">${escapeHtml(e.message)}</div>`;
    }
}

function _personPhotoToViewerFile(tile) {
    try {
        const meta = JSON.parse(decodeURIComponent(tile.dataset.meta || '%7B%7D'));
        const filePath = String(meta.file_path || '').replace(/\\/g, '/');
        const fileType = String(meta.file_type || '');
        const type =
            fileType === 'photo' || fileType === 'image' || fileType === 'sticker'
                ? 'images'
                : fileType === 'video'
                  ? 'videos'
                  : fileType === 'audio'
                    ? 'audio'
                    : 'files';
        const size = Number(meta.file_size) || 0;
        return {
            id: Number(meta.id) || 0,
            name: meta.file_name || '',
            path: filePath,
            fullPath: filePath,
            type,
            file_type: fileType,
            size,
            sizeFormatted: size ? formatBytes(size) : '',
            groupId: meta.group_id || null,
            groupName: meta.group_name || '',
            pinned: !!meta.pinned,
            modified: null,
        };
    } catch {
        return null;
    }
}

function _photoTile(row) {
    const id = row.download_id || row.id;
    const faceId = row.face_id || '';
    const name = escapeHtml(row.file_name || `#${id}`);

    const meta = encodeURIComponent(
        JSON.stringify({
            id,
            file_name: row.file_name || '',
            file_type: row.file_type || '',
            file_path: String(row.file_path || '').replace(/\\/g, '/'),
            file_size: Number(row.file_size) || 0,
            group_id: row.group_id || null,
            group_name: row.group_name || '',
            pinned: !!row.pinned,
        }),
    );

    return `
        <button type="button" class="block group relative rounded-xl overflow-hidden cursor-pointer shadow-sm hover:shadow-lg transition-all duration-200" title="${name}" data-dl-id="${id}" data-face-id="${faceId}" data-meta="${meta}">
            <img src="/api/thumbs/${id}?w=320" alt="${name}" loading="lazy"
                class="aspect-square w-full object-cover bg-tg-bg/40 transition-transform duration-300 group-hover:scale-105">
            <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-end p-1.5">
                <span class="text-white text-[10px] leading-tight line-clamp-2 font-medium drop-shadow">${name}</span>
            </div>
            <!-- Split-mode selection overlay — hidden until split mode is active -->
            <div class="split-overlay absolute inset-0 hidden pointer-events-none">
                <div class="absolute inset-0 ring-2 ring-inset ring-tg-blue/60 rounded-xl transition-all"></div>
                <div class="absolute top-1 right-1 w-5 h-5 rounded-full bg-tg-blue flex items-center justify-center shadow">
                    <i class="ri-check-line text-white text-[11px]"></i>
                </div>
            </div>
        </button>
    `;
}

// ---- Face review (additive) -----------------------------------------------
//
// Opt-in detail view, toggled via the "Review faces" button on a selected
// cluster. Shows one tile PER DETECTED FACE (cropped to its bbox, from
// GET /api/ai/faces/:id/crop) instead of one tile per source photo, so an
// operator can visually confirm/reject every face the algorithm attributed
// to this cluster — including multiple faces from the same group photo,
// which the default photo grid collapses to a single tile.
//
// This never replaces or mutates the existing photo-grid flow: closing the
// panel (or never opening it) leaves `_showPersonPhotos()` / `_photoTile()`
// completely untouched.

function _qualityBadgeLabel(score) {
    const q = Number(score) || 0;
    if (q <= 0) return '';
    return q >= 0.7 ? 'HQ' : q >= 0.4 ? 'MQ' : 'LQ';
}

function _toggleFaceReview() {
    if (_faceReviewActive) {
        _closeFaceReview();
    } else {
        _openFaceReview();
    }
}

function _openFaceReview() {
    if (!_selectedPerson) return;
    if (_splitModeActive) _exitSplitMode();
    _faceReviewActive = true;

    const btn = $('#ai-person-review-faces-btn');
    if (btn) btn.classList.add('ring-2', 'ring-tg-blue/50', 'bg-tg-blue/10');

    $('#ai-people-photos-grid')?.classList.add('hidden');
    $('#ai-split-hint')?.classList.add('hidden');
    const panel = $('#ai-face-review');
    if (panel) {
        panel.classList.remove('hidden');
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    _faceReviewOffset = 0;
    _loadFaceReview({ append: false });
}

function _closeFaceReview() {
    _faceReviewActive = false;
    const btn = $('#ai-person-review-faces-btn');
    if (btn) btn.classList.remove('ring-2', 'ring-tg-blue/50', 'bg-tg-blue/10');
    $('#ai-face-review')?.classList.add('hidden');
    $('#ai-people-photos-grid')?.classList.remove('hidden');
}

async function _loadFaceReview({ append = false } = {}) {
    if (!_selectedPerson) return;
    const grid = $('#ai-face-review-grid');
    const countEl = $('#ai-face-review-count');
    if (!grid) return;
    const token = ++_faceReviewToken;

    if (!append) {
        grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('common.loading', 'Loading…'))}</div>`;
        if (countEl) countEl.textContent = '';
    }

    try {
        const r = await api.get(
            `/api/ai/people/${_selectedPerson}/faces?limit=${_FACE_REVIEW_PAGE_SIZE}&offset=${_faceReviewOffset}`,
        );
        if (token !== _faceReviewToken) return; // superseded by a newer load
        if (!r?.success) throw new Error(r?.error || 'load failed');
        const faces = r.faces || [];
        _faceReviewTotal = Number(r.total) || 0;

        if (!append && !faces.length) {
            grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('maintenance.ai.no_faces', 'No faces in this cluster.'))}</div>`;
            if (countEl) countEl.textContent = '';
            return;
        }

        if (!append) grid.innerHTML = '';
        grid.insertAdjacentHTML('beforeend', faces.map(_faceReviewTile).join(''));
        _faceReviewOffset += faces.length;

        if (countEl) {
            countEl.textContent = i18nTf(
                'maintenance.ai.face_review_count',
                { n: _faceReviewTotal },
                `${_faceReviewTotal.toLocaleString()} detected faces`,
            );
        }

        _wireFaceReviewGrid();
        _renderFaceReviewLoadMore();
    } catch (e) {
        if (token !== _faceReviewToken) return;
        grid.innerHTML = `<div class="col-span-full text-center text-xs text-red-300 py-8">${escapeHtml(e.message)}</div>`;
    }
}

function _renderFaceReviewLoadMore() {
    const grid = $('#ai-face-review-grid');
    const panel = $('#ai-face-review');
    if (!grid || !panel) return;
    const existing = panel.querySelector('.ai-face-review-load-more-btn');
    if (existing) existing.remove();
    if (_faceReviewOffset >= _faceReviewTotal) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
        'ai-face-review-load-more-btn w-full py-2.5 mx-1.5 mb-1.5 rounded-xl text-xs font-medium text-tg-textSecondary border border-tg-border/30 hover:border-tg-blue/50 hover:text-tg-blue hover:bg-tg-blue/5 transition-all';
    btn.textContent = i18nTf(
        'maintenance.ai.face_review_load_more',
        { n: (_faceReviewTotal - _faceReviewOffset).toLocaleString() },
        `Show more (${(_faceReviewTotal - _faceReviewOffset).toLocaleString()} remaining)`,
    );
    btn.addEventListener('click', () => _loadFaceReview({ append: true }));
    grid.after(btn);
}

function _faceReviewTile(row) {
    const faceId = row.face_id;
    const dlId = row.download_id;
    const name = escapeHtml(row.file_name || `#${dlId}`);
    const qLabel = _qualityBadgeLabel(row.quality_score);
    const qBadge = qLabel
        ? `<span class="absolute top-1 left-1 h-[15px] px-1.5 rounded-full bg-black/70 text-white text-[8px] font-medium flex items-center justify-center leading-none backdrop-blur-sm">${qLabel}</span>`
        : '';
    const cached = _peopleCache.find((p) => p.id === _selectedPerson);
    const isCover = Number(cached?.cover_face_id) === Number(faceId);
    const coverBadge = isCover
        ? `<span class="absolute bottom-1 left-1 h-[15px] px-1.5 rounded-full bg-tg-blue/90 text-white text-[8px] font-medium flex items-center gap-0.5 leading-none backdrop-blur-sm"><i class="ri-image-line text-[9px]"></i>${escapeHtml(i18nT('maintenance.ai.face_review_cover_badge', 'Cover'))}</span>`
        : '';
    const coverRing = isCover ? ' ring-2 ring-tg-blue ring-offset-1 ring-offset-tg-bg' : '';

    const meta = encodeURIComponent(
        JSON.stringify({
            id: dlId,
            file_name: row.file_name || '',
            file_type: row.file_type || '',
            file_path: String(row.file_path || '').replace(/\\/g, '/'),
            file_size: Number(row.file_size) || 0,
            group_id: row.group_id || null,
            group_name: row.group_name || '',
            pinned: !!row.pinned,
        }),
    );

    return `
        <div class="ai-face-review-tile group relative rounded-xl overflow-hidden shadow-sm hover:shadow-lg transition-all duration-200 bg-tg-bg/40${coverRing}" data-face-id="${faceId}" data-dl-id="${dlId}" data-meta="${meta}">
            <button type="button" class="ai-face-review-open block w-full cursor-pointer" title="${escapeHtml(i18nT('maintenance.ai.face_review_open_source', 'Open source photo'))} — ${name}">
                <img src="/api/ai/faces/${faceId}/crop?w=160" alt="${name}" loading="lazy"
                    class="aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-105">
            </button>
            ${qBadge}
            ${coverBadge}
            <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none flex items-end p-1.5">
                <span class="text-white text-[10px] leading-tight line-clamp-1 font-medium drop-shadow">${name}</span>
            </div>
            <!-- Hover actions — kept visually distinct from the click-to-open image
                 so operators don't accidentally reassign while browsing. -->
            <div class="absolute top-1 right-1 flex flex-col gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-200">
                <button type="button" class="ai-face-review-set-cover w-5 h-5 rounded-full bg-black/70 hover:bg-tg-blue flex items-center justify-center shadow"
                    title="${escapeHtml(i18nT('maintenance.ai.face_review_set_cover', 'Set as thumbnail'))}">
                    <i class="ri-image-line text-white text-[10px]"></i>
                </button>
                <button type="button" class="ai-face-review-reassign w-5 h-5 rounded-full bg-black/70 hover:bg-tg-blue flex items-center justify-center shadow"
                    title="${escapeHtml(i18nT('maintenance.ai.face_review_reassign', 'Move to another person…'))}">
                    <i class="ri-arrow-left-right-line text-white text-[10px]"></i>
                </button>
                <button type="button" class="ai-face-review-unassign w-5 h-5 rounded-full bg-black/70 hover:bg-red-500 flex items-center justify-center shadow"
                    title="${escapeHtml(i18nT('maintenance.ai.face_review_not_match', 'Not this person — unassign'))}">
                    <i class="ri-close-line text-white text-[10px]"></i>
                </button>
            </div>
        </div>
    `;
}

function _personAvatarBust(p) {
    if (!p) return String(Date.now());
    const cover = Number(p.cover_face_id);
    if (Number.isFinite(cover) && cover > 0) return String(cover);
    const updated = Number(p.updated_at);
    if (Number.isFinite(updated) && updated > 0) return String(updated);
    return '0';
}

function _wireFaceReviewGrid() {
    const grid = $('#ai-face-review-grid');
    if (!grid) return;
    if (_faceReviewGridClickHandler) grid.removeEventListener('click', _faceReviewGridClickHandler);

    _faceReviewGridClickHandler = (e) => {
        const setCoverBtn = e.target.closest('.ai-face-review-set-cover');
        const reassignBtn = e.target.closest('.ai-face-review-reassign');
        const unassignBtn = e.target.closest('.ai-face-review-unassign');
        const openBtn = e.target.closest('.ai-face-review-open');
        const tile = e.target.closest('.ai-face-review-tile');
        if (!tile) return;
        const faceId = Number(tile.dataset.faceId);

        if (setCoverBtn) {
            e.preventDefault();
            e.stopPropagation();
            _setCoverFaceFromReview(faceId);
            return;
        }
        if (reassignBtn) {
            e.preventDefault();
            e.stopPropagation();
            _reassignFaceFromReview(faceId, tile);
            return;
        }
        if (unassignBtn) {
            e.preventDefault();
            e.stopPropagation();
            _unassignFaceFromReview(faceId, tile);
            return;
        }
        if (openBtn) {
            const allTiles = Array.from(grid.querySelectorAll('.ai-face-review-tile'));
            const viewerFiles = allTiles.map(_personPhotoToViewerFile).filter(Boolean);
            const idx = allTiles.indexOf(tile);
            if (idx >= 0 && viewerFiles[idx]) {
                // Tag the target file so the viewer's face overlay can visually
                // emphasize the specific face this tile represented.
                viewerFiles[idx].highlightFaceId = faceId;
            }
            if (viewerFiles.length) openMediaViewerForReview(viewerFiles, Math.max(0, idx));
        }
    };
    grid.addEventListener('click', _faceReviewGridClickHandler);
}

// Reuses the exact same visual person-picker as _mergeSelectedPerson, but
// targets a single face via the existing POST /api/ai/faces/:id/reassign
// endpoint instead of merging whole clusters.
async function _reassignFaceFromReview(faceId, tileEl) {
    if (!faceId) return;
    const candidates = _peopleCache.filter((p) => p.id !== _selectedPerson && p.id !== -1);
    if (!candidates.length) {
        showToast(
            i18nT('maintenance.ai.merge_no_other', 'No other clusters to merge with.'),
            'info',
        );
        return;
    }

    const makeCard = (p) => {
        const name = escapeHtml(p.label || `Person #${p.id}`);
        const faceUrl =
            p.id > 0 ? `/api/ai/person/${p.id}/face?w=64&v=${_personAvatarBust(p)}` : '';
        const imgHtml = faceUrl
            ? `<img src="${faceUrl}" class="w-full h-full object-cover" loading="lazy" onerror="this.onerror=null;this.parentElement.innerHTML='<i class=\\'ri-user-line text-base text-tg-textSecondary/40\\'></i>'">`
            : `<i class="ri-user-line text-base text-tg-textSecondary/40"></i>`;
        return `<button type="button" data-pid="${p.id}"
            class="ai-face-reassign-card flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-xl hover:bg-tg-blue/10 active:bg-tg-blue/20 transition-colors">
            <div class="w-10 h-10 rounded-full overflow-hidden ring-1 ring-tg-border/30 flex-shrink-0 bg-tg-bg/40 flex items-center justify-center">
                ${imgHtml}
            </div>
            <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-tg-text truncate">${name}</div>
                <div class="text-[11px] text-tg-textSecondary">${p.face_count} ${escapeHtml(i18nT('maintenance.ai.faces_short', 'faces'))}</div>
            </div>
            <i class="ri-arrow-right-s-line text-tg-textSecondary/50 flex-shrink-0"></i>
        </button>`;
    };

    const pickerContent = `
        <div class="px-1 mb-3">
            <input type="search" id="ai-face-reassign-search" placeholder="${escapeHtml(i18nT('common.search', 'Search…'))}"
                class="tg-input w-full text-sm" autocomplete="off">
        </div>
        <div id="ai-face-reassign-list" class="flex flex-col gap-0.5 max-h-64 overflow-y-auto"></div>
        <p id="ai-face-reassign-empty" class="hidden text-center text-xs text-tg-textSecondary py-4">${escapeHtml(i18nT('common.no_results', 'No matches'))}</p>`;

    const targetId = await new Promise((resolve) => {
        const entry = openSheet({
            title: i18nT('maintenance.ai.face_review_reassign', 'Move to another person…'),
            content: pickerContent,
            size: 'md',
            onClose: () => resolve(null),
        });

        const listEl = entry.body.querySelector('#ai-face-reassign-list');
        const emptyEl = entry.body.querySelector('#ai-face-reassign-empty');
        const searchEl = entry.body.querySelector('#ai-face-reassign-search');

        const renderList = (list) => {
            if (!listEl) return;
            listEl.innerHTML = list.slice(0, 80).map(makeCard).join('');
            const empty = list.length === 0;
            if (emptyEl) emptyEl.classList.toggle('hidden', !empty);
            listEl.querySelectorAll('.ai-face-reassign-card').forEach((cbtn) => {
                cbtn.addEventListener('click', () => {
                    entry.close();
                    resolve(Number(cbtn.dataset.pid));
                });
            });
        };

        renderList(candidates);

        if (searchEl) {
            searchEl.addEventListener('input', (e) => {
                const q = String(e.target.value || '')
                    .toLowerCase()
                    .trim();
                renderList(
                    q
                        ? candidates.filter((p) =>
                              (p.label || `Person #${p.id}`).toLowerCase().includes(q),
                          )
                        : candidates,
                );
            });
            setTimeout(() => searchEl.focus(), 60);
        }
    });

    if (!targetId) return;

    try {
        const res = await api.post(`/api/ai/faces/${faceId}/reassign`, { personId: targetId });
        if (!res.success) throw new Error(res.error || 'reassign failed');
        showToast(i18nT('maintenance.ai.face_review_reassigned', 'Face moved'), 'success');
        _removeFaceReviewTile(tileEl);
        _loadPeople();
        await refreshStatus();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// Quick "not a match" action — unassigns the face (person_id = null) via
// the same reassign endpoint. No new mutation API needed: unassigning is
// just a reassign to `null`, already supported server-side.
async function _unassignFaceFromReview(faceId, tileEl) {
    if (!faceId) return;
    try {
        const res = await api.post(`/api/ai/faces/${faceId}/reassign`, { personId: null });
        if (!res.success) throw new Error(res.error || 'unassign failed');
        showToast(i18nT('maintenance.ai.face_review_unassigned', 'Face unassigned'), 'success');
        _removeFaceReviewTile(tileEl);
        _loadPeople();
        await refreshStatus();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function _setCoverFaceFromReview(faceId) {
    if (!faceId || !_selectedPerson) return;
    try {
        const res = await api.post(`/api/ai/people/${_selectedPerson}/cover`, { faceId });
        if (!res.success) throw new Error(res.error || 'set cover failed');
        const coverFaceId = Number(res.coverFaceId) || faceId;
        const cached = _peopleCache.find((p) => p.id === _selectedPerson);
        if (cached) {
            cached.cover_face_id = coverFaceId;
            cached.updated_at = Date.now();
        }
        showToast(
            i18nT('maintenance.ai.face_review_cover_set', 'Thumbnail updated'),
            'success',
        );
        await _renderPeopleGrid();
        // Refresh detail avatar + cover badges in the open review grid.
        const detailAvatar = $('#ai-person-detail-avatar');
        if (detailAvatar) {
            const bust = _personAvatarBust(cached);
            detailAvatar.innerHTML = `<img src="/api/ai/person/${_selectedPerson}/face?w=80&v=${bust}" alt="${escapeHtml(_selectedPersonName)}" loading="lazy" class="w-full h-full object-cover" onerror="this.onerror=null;this.replaceWith(Object.assign(document.createElement('i'),{className:'ri-user-line text-lg text-tg-textSecondary/40'}))">`;
        }
        if (_faceReviewActive) {
            _faceReviewOffset = 0;
            const grid = $('#ai-face-review-grid');
            if (grid) grid.innerHTML = '';
            await _loadFaceReview({ append: false });
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function _removeFaceReviewTile(tileEl) {
    tileEl?.remove();
    _faceReviewTotal = Math.max(0, _faceReviewTotal - 1);
    _faceReviewOffset = Math.max(0, _faceReviewOffset - 1);
    const countEl = $('#ai-face-review-count');
    if (countEl) {
        countEl.textContent = i18nTf(
            'maintenance.ai.face_review_count',
            { n: _faceReviewTotal },
            `${_faceReviewTotal.toLocaleString()} detected faces`,
        );
    }
    _renderFaceReviewLoadMore();
    const grid = $('#ai-face-review-grid');
    if (grid && !grid.querySelector('.ai-face-review-tile')) {
        grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('maintenance.ai.no_faces', 'No faces in this cluster.'))}</div>`;
    }
}

// ---- Unclassified faces review -------------------------------------------

function _openUnclassifiedReview() {
    if (_faceReviewActive) _closeFaceReview();
    if (_splitModeActive) _exitSplitMode();
    _unclassifiedReviewActive = true;
    _unclassifiedSelectedIds.clear();
    _unclassifiedFocusFaceId = null;
    _unclassifiedSuggestions = [];
    _unclassifiedOffset = 0;
    const panel = $('#ai-unclassified-review');
    if (panel) {
        panel.classList.remove('hidden');
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    _hideUnclassifiedSuggestions();
    _syncUnclassifiedSelectionUi();
    _loadUnclassifiedReview({ append: false });
}

function _closeUnclassifiedReview() {
    _unclassifiedReviewActive = false;
    _unclassifiedSelectedIds.clear();
    _unclassifiedFocusFaceId = null;
    _unclassifiedSuggestions = [];
    $('#ai-unclassified-review')?.classList.add('hidden');
    _hideUnclassifiedSuggestions();
    _syncUnclassifiedSelectionUi();
    const grid = $('#ai-unclassified-grid');
    if (grid) grid.innerHTML = '';
}

async function _loadUnclassifiedReview({ append = false } = {}) {
    if (!_unclassifiedReviewActive) return;
    const grid = $('#ai-unclassified-grid');
    const countEl = $('#ai-unclassified-count');
    if (!grid) return;
    const token = ++_unclassifiedToken;

    if (!append) {
        grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('common.loading', 'Loading…'))}</div>`;
        if (countEl) countEl.textContent = '';
    }

    try {
        const r = await api.get(
            `/api/ai/faces/unclassified?limit=${_UNCLASSIFIED_PAGE_SIZE}&offset=${_unclassifiedOffset}`,
        );
        if (token !== _unclassifiedToken) return;
        if (!r?.success) throw new Error(r?.error || 'load failed');
        const faces = r.faces || [];
        _unclassifiedTotal = Number(r.total) || 0;

        if (!append && !faces.length) {
            grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('maintenance.ai.unclassified.empty', 'No unclassified faces.'))}</div>`;
            if (countEl) {
                countEl.textContent = _unclassifiedTotal
                    ? i18nTf(
                          'maintenance.ai.unclassified.count',
                          { n: _unclassifiedTotal },
                          `${_unclassifiedTotal.toLocaleString()} unclassified`,
                      )
                    : '';
            }
            // No rows returned for this offset — don't claim phantom "remaining".
            _unclassifiedOffset = _unclassifiedTotal;
            _renderUnclassifiedLoadMore();
            _syncUnclassifiedSelectionUi();
            return;
        }

        const html = faces.map(_unclassifiedTile).join('');
        if (append) {
            grid.insertAdjacentHTML('beforeend', html);
        } else {
            grid.innerHTML = html;
        }
        _unclassifiedOffset += faces.length;
        if (countEl) {
            countEl.textContent = i18nTf(
                'maintenance.ai.unclassified.count',
                { n: _unclassifiedTotal },
                `${_unclassifiedTotal.toLocaleString()} unclassified`,
            );
        }
        _wireUnclassifiedGrid();
        _renderUnclassifiedLoadMore();
        _syncUnclassifiedSelectionUi();
    } catch (e) {
        if (token !== _unclassifiedToken) return;
        if (!append) {
            grid.innerHTML = `<div class="col-span-full text-center text-xs text-red-300 py-8">${escapeHtml(e.message)}</div>`;
        }
    }
}

function _renderUnclassifiedLoadMore() {
    const grid = $('#ai-unclassified-grid');
    const panel = $('#ai-unclassified-review');
    if (!grid || !panel) return;
    const existing = panel.querySelector('.ai-unclassified-load-more-btn');
    if (existing) existing.remove();
    if (_unclassifiedOffset >= _unclassifiedTotal) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
        'ai-unclassified-load-more-btn w-full py-2.5 mx-1.5 mb-1.5 rounded-xl text-xs font-medium text-tg-textSecondary border border-tg-border/30 hover:border-tg-blue/50 hover:text-tg-blue hover:bg-tg-blue/5 transition-all';
    btn.textContent = i18nTf(
        'maintenance.ai.face_review_load_more',
        { n: (_unclassifiedTotal - _unclassifiedOffset).toLocaleString() },
        `Show more (${(_unclassifiedTotal - _unclassifiedOffset).toLocaleString()} remaining)`,
    );
    btn.addEventListener('click', () => _loadUnclassifiedReview({ append: true }));
    grid.after(btn);
}

function _unclassifiedTile(row) {
    const faceId = row.face_id;
    const dlId = row.download_id;
    const name = escapeHtml(row.file_name || `#${dlId}`);
    const selected = _unclassifiedSelectedIds.has(Number(faceId));
    const qLabel = _qualityBadgeLabel(row.quality_score);
    const qBadge = qLabel
        ? `<span class="absolute top-1 left-1 h-[15px] px-1.5 rounded-full bg-black/70 text-white text-[8px] font-medium flex items-center justify-center leading-none backdrop-blur-sm">${qLabel}</span>`
        : '';
    const selBadge = selected
        ? `<span class="ai-unclassified-sel-badge absolute bottom-1 left-1 w-5 h-5 rounded-full bg-tg-blue text-white flex items-center justify-center shadow"><i class="ri-check-line text-[11px]"></i></span>`
        : '';
    const selRing = selected ? ' ring-2 ring-tg-blue ring-offset-1 ring-offset-tg-bg' : '';
    const meta = encodeURIComponent(
        JSON.stringify({
            id: dlId,
            file_name: row.file_name || '',
            file_type: row.file_type || '',
            file_path: String(row.file_path || '').replace(/\\/g, '/'),
            file_size: Number(row.file_size) || 0,
            group_id: row.group_id || null,
            group_name: row.group_name || '',
            pinned: !!row.pinned,
        }),
    );
    return `
        <div class="ai-unclassified-tile group relative rounded-xl overflow-hidden shadow-sm hover:shadow-lg transition-all duration-200 bg-tg-bg/40${selRing}" data-face-id="${faceId}" data-dl-id="${dlId}" data-meta="${meta}">
            <button type="button" class="ai-unclassified-select block w-full cursor-pointer" title="${escapeHtml(i18nT('maintenance.ai.unclassified.select', 'Tap to select'))} — ${name}">
                <img src="/api/ai/faces/${faceId}/crop?w=160" alt="${name}" loading="lazy"
                    class="aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-105">
            </button>
            ${qBadge}
            ${selBadge}
            <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none flex items-end p-1.5">
                <span class="text-white text-[10px] leading-tight line-clamp-1 font-medium drop-shadow">${name}</span>
            </div>
            <div class="absolute top-1 right-1 flex flex-col gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-200">
                <button type="button" class="ai-unclassified-open w-5 h-5 rounded-full bg-black/70 hover:bg-tg-blue flex items-center justify-center shadow"
                    title="${escapeHtml(i18nT('maintenance.ai.face_review_open_source', 'Open source photo'))}">
                    <i class="ri-external-link-line text-white text-[10px]"></i>
                </button>
                <button type="button" class="ai-unclassified-assign w-5 h-5 rounded-full bg-black/70 hover:bg-tg-blue flex items-center justify-center shadow"
                    title="${escapeHtml(i18nT('maintenance.ai.unclassified.assign', 'Assign to person…'))}">
                    <i class="ri-user-shared-line text-white text-[10px]"></i>
                </button>
                <button type="button" class="ai-unclassified-new w-5 h-5 rounded-full bg-black/70 hover:bg-emerald-500 flex items-center justify-center shadow"
                    title="${escapeHtml(i18nT('maintenance.ai.unclassified.new_person', 'Create new person'))}">
                    <i class="ri-user-add-line text-white text-[10px]"></i>
                </button>
                <button type="button" class="ai-unclassified-remove w-5 h-5 rounded-full bg-black/70 hover:bg-red-500 flex items-center justify-center shadow"
                    title="${escapeHtml(i18nT('maintenance.ai.unclassified.remove', 'Remove face'))}">
                    <i class="ri-delete-bin-line text-white text-[10px]"></i>
                </button>
            </div>
        </div>
    `;
}

function _wireUnclassifiedGrid() {
    const grid = $('#ai-unclassified-grid');
    if (!grid) return;
    if (_unclassifiedGridClickHandler) grid.removeEventListener('click', _unclassifiedGridClickHandler);

    _unclassifiedGridClickHandler = (e) => {
        const assignBtn = e.target.closest('.ai-unclassified-assign');
        const newBtn = e.target.closest('.ai-unclassified-new');
        const removeBtn = e.target.closest('.ai-unclassified-remove');
        const openBtn = e.target.closest('.ai-unclassified-open');
        const selectBtn = e.target.closest('.ai-unclassified-select');
        const tile = e.target.closest('.ai-unclassified-tile');
        if (!tile) return;
        const faceId = Number(tile.dataset.faceId);

        if (assignBtn) {
            e.preventDefault();
            e.stopPropagation();
            _assignUnclassifiedFaces([faceId]);
            return;
        }
        if (newBtn) {
            e.preventDefault();
            e.stopPropagation();
            _newPersonFromUnclassifiedFaces([faceId]);
            return;
        }
        if (removeBtn) {
            e.preventDefault();
            e.stopPropagation();
            _removeUnclassifiedFaces([faceId]);
            return;
        }
        if (openBtn) {
            e.preventDefault();
            e.stopPropagation();
            const allTiles = Array.from(grid.querySelectorAll('.ai-unclassified-tile'));
            const viewerFiles = allTiles.map(_personPhotoToViewerFile).filter(Boolean);
            const idx = allTiles.indexOf(tile);
            if (idx >= 0 && viewerFiles[idx]) {
                viewerFiles[idx].highlightFaceId = faceId;
            }
            if (viewerFiles.length) openMediaViewerForReview(viewerFiles, Math.max(0, idx));
            return;
        }
        if (selectBtn) {
            e.preventDefault();
            _toggleUnclassifiedSelection(faceId);
        }
    };
    grid.addEventListener('click', _unclassifiedGridClickHandler);
}

function _toggleUnclassifiedSelection(faceId) {
    const id = Number(faceId);
    if (!Number.isFinite(id) || id <= 0) return;
    if (_unclassifiedSelectedIds.has(id)) {
        _unclassifiedSelectedIds.delete(id);
        _unclassifiedFocusFaceId =
            _unclassifiedSelectedIds.size > 0
                ? [..._unclassifiedSelectedIds].at(-1)
                : null;
    } else {
        _unclassifiedSelectedIds.add(id);
        _unclassifiedFocusFaceId = id;
    }
    _syncUnclassifiedSelectionUi();
}

function _syncUnclassifiedSelectionUi() {
    const grid = $('#ai-unclassified-grid');
    grid?.querySelectorAll('.ai-unclassified-tile').forEach((t) => {
        const id = Number(t.dataset.faceId);
        const on = _unclassifiedSelectedIds.has(id);
        t.classList.toggle('ring-2', on);
        t.classList.toggle('ring-tg-blue', on);
        t.classList.toggle('ring-offset-1', on);
        t.classList.toggle('ring-offset-tg-bg', on);
        let badge = t.querySelector('.ai-unclassified-sel-badge');
        if (on) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className =
                    'ai-unclassified-sel-badge absolute bottom-1 left-1 w-5 h-5 rounded-full bg-tg-blue text-white flex items-center justify-center shadow';
                badge.innerHTML = '<i class="ri-check-line text-[11px]"></i>';
                t.appendChild(badge);
            }
        } else if (badge) {
            badge.remove();
        }
    });

    const bar = $('#ai-unclassified-sel-bar');
    const countEl = $('#ai-unclassified-sel-count');
    const n = _unclassifiedSelectedIds.size;
    if (bar) {
        bar.classList.remove('hidden');
        bar.classList.add('flex');
    }
    if (countEl) {
        countEl.textContent =
            n === 0
                ? i18nT('maintenance.ai.unclassified.sel_hint', 'Tap faces to select')
                : i18nTf('maintenance.ai.unclassified.sel_n', { n }, `${n} selected`);
    }
    const disabled = n === 0;
    $('#ai-unclassified-sel-assign-btn')?.toggleAttribute('disabled', disabled);
    $('#ai-unclassified-sel-new-btn')?.toggleAttribute('disabled', disabled);
    $('#ai-unclassified-sel-remove-btn')?.toggleAttribute('disabled', disabled);

    if (_unclassifiedFocusFaceId && _unclassifiedSelectedIds.has(_unclassifiedFocusFaceId)) {
        _loadUnclassifiedSuggestions(_unclassifiedFocusFaceId);
    } else {
        _unclassifiedSuggestions = [];
        _hideUnclassifiedSuggestions();
    }
}

function _hideUnclassifiedSuggestions() {
    $('#ai-unclassified-suggestions')?.classList.add('hidden');
    const list = $('#ai-unclassified-suggestions-list');
    if (list) list.innerHTML = '';
    $('#ai-unclassified-suggestions-empty')?.classList.add('hidden');
}

async function _loadUnclassifiedSuggestions(faceId) {
    const wrap = $('#ai-unclassified-suggestions');
    const list = $('#ai-unclassified-suggestions-list');
    const empty = $('#ai-unclassified-suggestions-empty');
    if (!wrap || !list) return;
    wrap.classList.remove('hidden');
    list.innerHTML = `<span class="text-[11px] text-tg-textSecondary">${escapeHtml(i18nT('common.loading', 'Loading…'))}</span>`;
    empty?.classList.add('hidden');
    const focusId = faceId;
    try {
        const r = await api.get(`/api/ai/faces/${faceId}/suggestions?limit=5`);
        if (_unclassifiedFocusFaceId !== focusId) return;
        if (!r?.success) throw new Error(r?.error || 'suggest failed');
        _unclassifiedSuggestions = Array.isArray(r.suggestions) ? r.suggestions : [];
        if (!_unclassifiedSuggestions.length) {
            list.innerHTML = '';
            empty?.classList.remove('hidden');
            return;
        }
        empty?.classList.add('hidden');
        const multiHint =
            _unclassifiedSelectedIds.size > 1
                ? `<p class="w-full text-[10px] text-tg-textSecondary mb-1">${escapeHtml(i18nTf('maintenance.ai.unclassified.suggest_applies_n', { n: _unclassifiedSelectedIds.size }, `Applies to all ${_unclassifiedSelectedIds.size} selected`))}</p>`
                : '';
        list.innerHTML =
            multiHint +
            _unclassifiedSuggestions
                .map((s) => {
                    const name = escapeHtml(s.label || `Person #${s.id}`);
                    const dist = Number(s.distance);
                    const distLabel = Number.isFinite(dist) ? dist.toFixed(2) : '';
                    const sameClip = !!s.sameClip;
                    const clipBadge = sameClip
                        ? `<span class="text-[9px] uppercase tracking-wide text-emerald-300/90 font-medium">${escapeHtml(i18nT('maintenance.ai.unclassified.same_clip', 'Same clip'))}</span>`
                        : '';
                    const bust = _personAvatarBust(_peopleCache.find((p) => p.id === s.id));
                    return `<button type="button" data-suggest-pid="${s.id}"
                    class="ai-unclassified-suggest-chip inline-flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-full ${sameClip ? 'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30' : 'bg-tg-blue/10 hover:bg-tg-blue/20 border border-tg-blue/30'} text-[11px] text-tg-text transition-colors">
                    <span class="w-6 h-6 rounded-full overflow-hidden bg-tg-bg/40 flex-shrink-0">
                        <img src="/api/ai/person/${s.id}/face?w=48&v=${bust}" alt="" class="w-full h-full object-cover" loading="lazy"
                            onerror="this.onerror=null;this.parentElement.innerHTML='<i class=\\'ri-user-line text-[10px] text-tg-textSecondary/40 flex items-center justify-center w-full h-full\\'></i>'">
                    </span>
                    <span class="flex flex-col items-start min-w-0 leading-tight">
                        ${clipBadge}
                        <span class="font-medium truncate max-w-[7rem]">${name}</span>
                    </span>
                    ${distLabel ? `<span class="text-tg-textSecondary tabular-nums">${distLabel}</span>` : ''}
                </button>`;
                })
                .join('');
        list.querySelectorAll('.ai-unclassified-suggest-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                const pid = Number(btn.dataset.suggestPid);
                if (!Number.isFinite(pid) || pid <= 0) return;
                const ids =
                    _unclassifiedSelectedIds.size > 0
                        ? [..._unclassifiedSelectedIds]
                        : [focusId];
                _assignUnclassifiedFacesTo(ids, pid);
            });
        });
    } catch (e) {
        if (_unclassifiedFocusFaceId !== focusId) return;
        list.innerHTML = `<span class="text-[11px] text-red-300">${escapeHtml(e.message)}</span>`;
    }
}

async function _assignUnclassifiedFaces(faceIds) {
    const ids = (Array.isArray(faceIds) ? faceIds : [])
        .map(Number)
        .filter((id) => Number.isFinite(id) && id > 0);
    if (!ids.length) return;
    const focusId =
        _unclassifiedFocusFaceId && ids.includes(_unclassifiedFocusFaceId)
            ? _unclassifiedFocusFaceId
            : ids[0];
    let suggestions = _unclassifiedSuggestions;
    if (_unclassifiedFocusFaceId !== focusId || !suggestions.length) {
        try {
            const r = await api.get(`/api/ai/faces/${focusId}/suggestions?limit=5`);
            suggestions = r?.success && Array.isArray(r.suggestions) ? r.suggestions : [];
        } catch {
            suggestions = [];
        }
    }
    const suggestIds = new Set(suggestions.map((s) => Number(s.id)));
    const candidates = _peopleCache.filter((p) => p.id > 0 && p.id !== -1);
    if (!candidates.length && !suggestions.length) {
        showToast(
            i18nT('maintenance.ai.merge_no_other', 'No other clusters to merge with.'),
            'info',
        );
        return;
    }

    const makeCard = (p, { suggested = false, sameClip = false, distance = null } = {}) => {
        const name = escapeHtml(p.label || `Person #${p.id}`);
        const faceUrl = p.id > 0 ? `/api/ai/person/${p.id}/face?w=64&v=${_personAvatarBust(p)}` : '';
        const imgHtml = faceUrl
            ? `<img src="${faceUrl}" class="w-full h-full object-cover" loading="lazy" onerror="this.onerror=null;this.parentElement.innerHTML='<i class=\\'ri-user-line text-base text-tg-textSecondary/40\\'></i>'">`
            : `<i class="ri-user-line text-base text-tg-textSecondary/40"></i>`;
        const distLabel =
            distance != null && Number.isFinite(Number(distance))
                ? `<span class="text-[10px] text-tg-textSecondary tabular-nums ml-1">${Number(distance).toFixed(2)}</span>`
                : '';
        const badge = sameClip
            ? `<span class="text-[9px] uppercase tracking-wide text-emerald-300 font-medium">${escapeHtml(i18nT('maintenance.ai.unclassified.same_clip', 'Same clip'))}</span>`
            : suggested
              ? `<span class="text-[9px] uppercase tracking-wide text-tg-blue font-medium">${escapeHtml(i18nT('maintenance.ai.unclassified.suggested', 'Suggested'))}</span>`
              : '';
        return `<button type="button" data-pid="${p.id}"
            class="ai-face-reassign-card flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-xl hover:bg-tg-blue/10 active:bg-tg-blue/20 transition-colors">
            <div class="w-10 h-10 rounded-full overflow-hidden ring-1 ring-tg-border/30 flex-shrink-0 bg-tg-bg/40 flex items-center justify-center">
                ${imgHtml}
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5">${badge}<div class="text-sm font-medium text-tg-text truncate">${name}</div>${distLabel}</div>
                <div class="text-[11px] text-tg-textSecondary">${p.face_count ?? p.faceCount ?? 0} ${escapeHtml(i18nT('maintenance.ai.faces_short', 'faces'))}</div>
            </div>
            <i class="ri-arrow-right-s-line text-tg-textSecondary/50 flex-shrink-0"></i>
        </button>`;
    };

    const suggestedPeople = suggestions
        .map((s) => {
            const cached = candidates.find((p) => p.id === s.id) || {
                id: s.id,
                label: s.label,
                face_count: s.faceCount,
            };
            return { p: cached, distance: s.distance, sameClip: !!s.sameClip };
        })
        .filter((x) => x.p);
    const rest = candidates.filter((p) => !suggestIds.has(p.id));

    const pickerContent = `
        <div class="px-1 mb-3">
            <input type="search" id="ai-unclassified-assign-search" placeholder="${escapeHtml(i18nT('common.search', 'Search…'))}"
                class="tg-input w-full text-sm" autocomplete="off">
        </div>
        <div id="ai-unclassified-assign-list" class="flex flex-col gap-0.5 max-h-64 overflow-y-auto"></div>
        <p id="ai-unclassified-assign-empty" class="hidden text-center text-xs text-tg-textSecondary py-4">${escapeHtml(i18nT('common.no_results', 'No matches'))}</p>`;

    const targetId = await new Promise((resolve) => {
        const entry = openSheet({
            title:
                ids.length > 1
                    ? i18nTf(
                          'maintenance.ai.unclassified.assign_n',
                          { n: ids.length },
                          `Assign ${ids.length} faces…`,
                      )
                    : i18nT('maintenance.ai.unclassified.assign', 'Assign to person…'),
            content: pickerContent,
            size: 'md',
            onClose: () => resolve(null),
        });
        const listEl = entry.body.querySelector('#ai-unclassified-assign-list');
        const emptyEl = entry.body.querySelector('#ai-unclassified-assign-empty');
        const searchEl = entry.body.querySelector('#ai-unclassified-assign-search');

        const renderList = (q) => {
            if (!listEl) return;
            const query = String(q || '')
                .trim()
                .toLowerCase();
            const match = (p) => {
                if (!query) return true;
                return `${p.label || ''} ${p.id}`.toLowerCase().includes(query);
            };
            const sug = suggestedPeople.filter((x) => match(x.p));
            const others = rest.filter(match);
            const parts = [];
            if (sug.length) {
                parts.push(
                    ...sug
                        .slice(0, 20)
                        .map((x) =>
                            makeCard(x.p, {
                                suggested: true,
                                sameClip: x.sameClip,
                                distance: x.distance,
                            }),
                        ),
                );
            }
            parts.push(...others.slice(0, 80).map((p) => makeCard(p)));
            listEl.innerHTML = parts.join('');
            const empty = parts.length === 0;
            if (emptyEl) emptyEl.classList.toggle('hidden', !empty);
            listEl.querySelectorAll('.ai-face-reassign-card').forEach((cbtn) => {
                cbtn.addEventListener('click', () => {
                    entry.close();
                    resolve(Number(cbtn.dataset.pid));
                });
            });
        };
        renderList('');
        searchEl?.addEventListener('input', () => renderList(searchEl.value));
        searchEl?.focus();
    });

    if (!targetId) return;
    await _assignUnclassifiedFacesTo(ids, targetId);
}

async function _assignUnclassifiedFacesTo(faceIds, personId) {
    const ids = (Array.isArray(faceIds) ? faceIds : [faceIds])
        .map(Number)
        .filter((id) => Number.isFinite(id) && id > 0);
    if (!ids.length || !personId) return;
    try {
        let ok = 0;
        for (const faceId of ids) {
            const res = await api.post(`/api/ai/faces/${faceId}/reassign`, { personId });
            if (!res?.success) throw new Error(res?.error || 'reassign failed');
            ok += 1;
            _removeUnclassifiedTilesByIds([faceId]);
        }
        showToast(
            ok > 1
                ? i18nTf('maintenance.ai.unclassified.assigned_n', { n: ok }, `${ok} faces moved`)
                : i18nT('maintenance.ai.face_review_reassigned', 'Face moved'),
            'success',
        );
        await refreshStatus();
        await _loadPeople();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function _newPersonFromUnclassifiedFaces(faceIds) {
    const ids = (Array.isArray(faceIds) ? faceIds : [faceIds])
        .map(Number)
        .filter((id) => Number.isFinite(id) && id > 0);
    if (!ids.length) return;
    const label = await promptSheet({
        title:
            ids.length > 1
                ? i18nTf(
                      'maintenance.ai.unclassified.new_person_n',
                      { n: ids.length },
                      `New person from ${ids.length} faces`,
                  )
                : i18nT('maintenance.ai.unclassified.new_person', 'Create new person'),
        message: i18nT(
            'maintenance.ai.unclassified.new_person_prompt',
            'Optional name for the new person:',
        ),
        defaultValue: '',
        confirmLabel: i18nT('common.save', 'Save'),
    });
    if (label == null) return;
    try {
        const body = {};
        if (String(label).trim()) body.label = String(label).trim();
        const res = await api.post(`/api/ai/faces/${ids[0]}/new-person`, body);
        if (!res?.success || !res.personId) throw new Error(res?.error || 'create failed');
        const personId = res.personId;
        for (let i = 1; i < ids.length; i++) {
            const r = await api.post(`/api/ai/faces/${ids[i]}/reassign`, { personId });
            if (!r?.success) throw new Error(r?.error || 'reassign failed');
        }
        _removeUnclassifiedTilesByIds(ids);
        showToast(
            i18nT('maintenance.ai.unclassified.created', 'New person created'),
            'success',
        );
        await refreshStatus();
        await _loadPeople();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function _removeUnclassifiedFaces(faceIds) {
    const ids = (Array.isArray(faceIds) ? faceIds : [faceIds])
        .map(Number)
        .filter((id) => Number.isFinite(id) && id > 0);
    if (!ids.length) return;
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.unclassified.remove', 'Remove face'),
        message:
            ids.length > 1
                ? i18nTf(
                      'maintenance.ai.unclassified.remove_confirm_n',
                      { n: ids.length },
                      `Permanently delete ${ids.length} face detections? They will not come back on re-cluster (unless you re-scan those photos).`,
                  )
                : i18nT(
                      'maintenance.ai.unclassified.remove_confirm',
                      'Permanently delete this face detection? It will not come back on re-cluster (unless you re-scan the photo).',
                  ),
        confirmLabel: i18nT('common.delete', 'Delete'),
        danger: true,
    });
    if (!ok) return;
    try {
        for (const faceId of ids) {
            const res = await api.delete(`/api/ai/faces/${faceId}`);
            if (!res?.success) throw new Error(res?.error || 'delete failed');
        }
        _removeUnclassifiedTilesByIds(ids);
        showToast(
            ids.length > 1
                ? i18nTf(
                      'maintenance.ai.unclassified.removed_n',
                      { n: ids.length },
                      `${ids.length} faces removed`,
                  )
                : i18nT('maintenance.ai.unclassified.removed', 'Face removed'),
            'success',
        );
        await refreshStatus();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function _removeUnclassifiedTilesByIds(faceIds) {
    const ids = new Set(
        (Array.isArray(faceIds) ? faceIds : [faceIds])
            .map(Number)
            .filter((id) => Number.isFinite(id) && id > 0),
    );
    const grid = $('#ai-unclassified-grid');
    for (const id of ids) {
        grid?.querySelector(`.ai-unclassified-tile[data-face-id="${id}"]`)?.remove();
        _unclassifiedSelectedIds.delete(id);
        _unclassifiedTotal = Math.max(0, _unclassifiedTotal - 1);
        _unclassifiedOffset = Math.max(0, _unclassifiedOffset - 1);
    }
    if (_unclassifiedFocusFaceId && ids.has(_unclassifiedFocusFaceId)) {
        _unclassifiedFocusFaceId =
            _unclassifiedSelectedIds.size > 0
                ? [..._unclassifiedSelectedIds].at(-1)
                : null;
    }
    const countEl = $('#ai-unclassified-count');
    if (countEl) {
        countEl.textContent = i18nTf(
            'maintenance.ai.unclassified.count',
            { n: _unclassifiedTotal },
            `${_unclassifiedTotal.toLocaleString()} unclassified`,
        );
    }
    _renderUnclassifiedLoadMore();
    _syncUnclassifiedSelectionUi();
    if (grid && !grid.querySelector('.ai-unclassified-tile')) {
        if (_unclassifiedTotal > 0) {
            // Cleared the current page but more remain — reload from the start.
            _unclassifiedOffset = 0;
            _loadUnclassifiedReview({ append: false });
        } else {
            grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('maintenance.ai.unclassified.empty', 'No unclassified faces.'))}</div>`;
        }
    }
}

async function _renameSelectedPerson() {
    if (!_selectedPerson) return;
    const label = await promptSheet({
        title: i18nT('maintenance.ai.person_rename', 'Rename'),
        message: i18nT('maintenance.ai.rename_prompt', 'Name this person:'),
        defaultValue: _selectedPersonName || '',
        confirmLabel: i18nT('common.save', 'Save'),
    });
    if (label == null) return;
    try {
        const r = await api.patch(`/api/ai/people/${_selectedPerson}`, { label });
        if (!r.success) throw new Error(r.error || 'rename failed');
        _selectedPersonName = label;
        showToast(i18nT('common.saved', 'Saved'), 'success');
        const nameEl = $('#ai-people-photos-name');
        if (nameEl) nameEl.textContent = label;
        _loadPeople();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function _mergeSelectedPerson() {
    if (!_selectedPerson) return;
    const candidates = _peopleCache.filter((p) => p.id !== _selectedPerson && p.id !== -1);
    if (!candidates.length) {
        showToast(
            i18nT('maintenance.ai.merge_no_other', 'No other clusters to merge with.'),
            'info',
        );
        return;
    }

    // Visual person-picker with search — build lazily so 1000+ candidates
    // don't cause a multi-second innerHTML freeze on open.
    const makeMergeCard = (p) => {
        const name = escapeHtml(p.label || `Person #${p.id}`);
        const faceUrl =
            p.id > 0 ? `/api/ai/person/${p.id}/face?w=64&v=${_personAvatarBust(p)}` : '';
        const imgHtml = faceUrl
            ? `<img src="${faceUrl}" class="w-full h-full object-cover" loading="lazy" onerror="this.onerror=null;this.parentElement.innerHTML='<i class=\\'ri-user-line text-base text-tg-textSecondary/40\\'></i>'">`
            : `<i class="ri-user-line text-base text-tg-textSecondary/40"></i>`;
        return `<button type="button" data-pid="${p.id}"
            class="ai-merge-card flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-xl hover:bg-tg-blue/10 active:bg-tg-blue/20 transition-colors">
            <div class="w-10 h-10 rounded-full overflow-hidden ring-1 ring-tg-border/30 flex-shrink-0 bg-tg-bg/40 flex items-center justify-center">
                ${imgHtml}
            </div>
            <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-tg-text truncate">${name}</div>
                <div class="text-[11px] text-tg-textSecondary">${p.face_count} ${escapeHtml(i18nT('maintenance.ai.faces_short', 'faces'))}</div>
            </div>
            <i class="ri-arrow-right-s-line text-tg-textSecondary/50 flex-shrink-0"></i>
        </button>`;
    };

    const pickerContent = `
        <div class="px-1 mb-3">
            <input type="search" id="ai-merge-search" placeholder="${escapeHtml(i18nT('common.search', 'Search…'))}"
                class="tg-input w-full text-sm" autocomplete="off">
        </div>
        <div id="ai-merge-list" class="flex flex-col gap-0.5 max-h-64 overflow-y-auto"></div>
        <p id="ai-merge-empty" class="hidden text-center text-xs text-tg-textSecondary py-4">${escapeHtml(i18nT('common.no_results', 'No matches'))}</p>`;

    const targetId = await new Promise((resolve) => {
        const entry = openSheet({
            title: i18nT('maintenance.ai.person_merge', 'Merge into…'),
            content: pickerContent,
            size: 'md',
            onClose: () => resolve(null),
        });

        const listEl = entry.body.querySelector('#ai-merge-list');
        const emptyEl = entry.body.querySelector('#ai-merge-empty');
        const searchEl = entry.body.querySelector('#ai-merge-search');

        const renderList = (list) => {
            if (!listEl) return;
            // Cap at 80 visible rows — search narrows results quickly.
            listEl.innerHTML = list.slice(0, 80).map(makeMergeCard).join('');
            const empty = list.length === 0;
            if (emptyEl) emptyEl.classList.toggle('hidden', !empty);
            listEl.querySelectorAll('.ai-merge-card').forEach((btn) => {
                btn.addEventListener('click', () => {
                    entry.close();
                    resolve(Number(btn.dataset.pid));
                });
            });
        };

        renderList(candidates);

        if (searchEl) {
            searchEl.addEventListener('input', (e) => {
                const q = String(e.target.value || '')
                    .toLowerCase()
                    .trim();
                renderList(
                    q
                        ? candidates.filter((p) =>
                              (p.label || `Person #${p.id}`).toLowerCase().includes(q),
                          )
                        : candidates,
                );
            });
            setTimeout(() => searchEl.focus(), 60);
        }
    });

    if (!targetId) return;
    const target = candidates.find((p) => p.id === targetId);
    const targetName = target ? target.label || `Person #${target.id}` : `#${targetId}`;

    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.person_merge', 'Merge'),
        message: i18nTf(
            'maintenance.ai.merge_confirm_named',
            { target: targetName },
            `All faces from this cluster will move into "${targetName}". This cluster will be deleted. Cannot be undone.`,
        ),
        confirmLabel: i18nT('maintenance.ai.person_merge', 'Merge'),
        cancelLabel: i18nT('common.cancel', 'Cancel'),
        danger: true,
    });
    if (!ok) return;

    try {
        const res = await api.post(`/api/ai/people/${targetId}/merge`, {
            otherId: _selectedPerson,
        });
        if (!res.success) throw new Error(res.error || 'merge failed');
        showToast(
            `${i18nT('maintenance.ai.merge_done', 'Merged')} — ${res.moved || 0} ${i18nT('maintenance.ai.faces_short', 'faces')}`,
            'success',
        );
        _selectedPerson = null;
        _selectedPersonName = '';
        $('#ai-people-photos')?.classList.add('hidden');
        _loadPeople();
        await refreshStatus();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function _splitSelectedPerson() {
    if (!_selectedPerson) return;
    // Split mode operates on the photo grid — collapse face review first
    // so the operator isn't looking at one grid while selecting in another.
    if (_faceReviewActive) _closeFaceReview();
    _enterSplitMode();
}

async function _deleteSelectedPerson() {
    if (!_selectedPerson) return;
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.person_delete', 'Delete'),
        message: i18nT(
            'maintenance.ai.delete_confirm',
            'Delete this cluster? Faces will become unassigned. The cluster may reappear after the next recluster.',
        ),
        destructive: true,
        confirmText: i18nT('maintenance.ai.person_delete', 'Delete'),
    });
    if (!ok) return;
    try {
        const r = await api.delete(`/api/ai/people/${_selectedPerson}`);
        if (!r.success) throw new Error(r.error || 'delete failed');
        showToast(i18nT('common.deleted', 'Deleted'), 'success');
        _selectedPerson = null;
        _selectedPersonName = '';
        $('#ai-people-photos')?.classList.add('hidden');
        _loadPeople();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function _excludeSelectedPerson() {
    if (!_selectedPerson) return;
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.person_exclude', 'Exclude'),
        message: i18nT(
            'maintenance.ai.exclude_confirm',
            'Exclude this identity permanently? It will not reappear as a Person after recluster. Faces stay in the database unassigned.',
        ),
        destructive: true,
        confirmText: i18nT('maintenance.ai.person_exclude', 'Exclude'),
    });
    if (!ok) return;
    try {
        const r = await api.post(`/api/ai/people/${_selectedPerson}/exclude`);
        if (!r.success) throw new Error(r.error || 'exclude failed');
        showToast(i18nT('maintenance.ai.exclude_done', 'Excluded'), 'success');
        _selectedPerson = null;
        _selectedPersonName = '';
        $('#ai-people-photos')?.classList.add('hidden');
        _loadPeople();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function _restoreExcludedPerson(excludedId) {
    try {
        const r = await api.delete(`/api/ai/people/excluded/${excludedId}`);
        if (!r.success) throw new Error(r.error || 'restore failed');
        showToast(
            i18nT(
                'maintenance.ai.excluded.restored',
                'Restored — run Re-cluster to recreate',
            ),
            'success',
        );
        await _loadExcludedPeople();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ---- Split mode -----------------------------------------------------------
//
// When split mode is active, the photo grid's click handler switches from
// "open viewer" to "toggle face selection". The split action bar at the
// bottom of the panel shows how many faces are selected and lets the
// operator commit (peel into a new cluster) or cancel.

function _enterSplitMode() {
    _splitModeActive = true;
    _splitSelectedDlIds.clear();

    const hint = $('#ai-split-hint');
    if (hint) {
        hint.classList.remove('hidden');
        hint.classList.add('flex');
    }
    const bar = $('#ai-split-bar');
    if (bar) {
        bar.classList.remove('hidden');
        bar.classList.add('flex');
    }
    const countEl = $('#ai-split-count');
    if (countEl)
        countEl.textContent = i18nT('maintenance.ai.split_select_hint', 'Tap photos to select');
    const commitBtn = $('#ai-split-commit-btn');
    if (commitBtn) commitBtn.disabled = true;

    const grid = $('#ai-people-photos-grid');
    if (!grid) return;
    grid.classList.add('split-mode');
    // Show the clustered face crop (not the full photo) so the operator
    // sees which identity each tile represents before peeling it out.
    grid.querySelectorAll('[data-dl-id]').forEach((tile) => {
        const faceId = Number(tile.dataset.faceId);
        const img = tile.querySelector('img');
        if (!img || !(faceId > 0)) return;
        if (!img.dataset.fullThumbSrc) img.dataset.fullThumbSrc = img.getAttribute('src') || '';
        img.src = `/api/ai/faces/${faceId}/crop?w=160`;
    });

    if (_photoGridClickHandler) grid.removeEventListener('click', _photoGridClickHandler);
    _photoGridClickHandler = (e) => {
        // Use data-dl-id (download ID — always populated) as the selection key.
        // At commit the server expands to every face of this person on those downloads.
        const tile = e.target.closest('[data-dl-id]');
        if (!tile) return;
        const dlId = Number(tile.dataset.dlId);
        if (!dlId) return;

        const overlay = tile.querySelector('.split-overlay');
        if (_splitSelectedDlIds.has(dlId)) {
            _splitSelectedDlIds.delete(dlId);
            overlay?.classList.add('hidden');
        } else {
            _splitSelectedDlIds.add(dlId);
            overlay?.classList.remove('hidden');
        }

        const n = _splitSelectedDlIds.size;
        const countEl2 = $('#ai-split-count');
        if (countEl2) {
            countEl2.textContent =
                n === 0
                    ? i18nT('maintenance.ai.split_select_hint', 'Tap photos to select')
                    : i18nTf('maintenance.ai.split_n_selected', { n }, `${n} selected`);
        }
        const commitBtn2 = $('#ai-split-commit-btn');
        if (commitBtn2) commitBtn2.disabled = n < 1;
    };
    grid.addEventListener('click', _photoGridClickHandler);
}

function _exitSplitMode() {
    _splitModeActive = false;
    _splitSelectedDlIds.clear();

    const hint = $('#ai-split-hint');
    if (hint) {
        hint.classList.add('hidden');
        hint.classList.remove('flex');
    }
    const bar = $('#ai-split-bar');
    if (bar) {
        bar.classList.add('hidden');
        bar.classList.remove('flex');
    }

    const grid = $('#ai-people-photos-grid');
    if (!grid) return;
    grid.classList.remove('split-mode');
    grid.querySelectorAll('.split-overlay').forEach((ov) => ov.classList.add('hidden'));
    grid.querySelectorAll('[data-dl-id]').forEach((tile) => {
        tile.classList.remove('ring-2', 'ring-tg-blue/60');
        const img = tile.querySelector('img');
        if (img?.dataset?.fullThumbSrc) {
            img.src = img.dataset.fullThumbSrc;
            delete img.dataset.fullThumbSrc;
        }
    });

    // Restore the viewer click handler.
    if (_photoGridClickHandler) grid.removeEventListener('click', _photoGridClickHandler);
    _photoGridClickHandler = (e) => {
        const tile = e.target.closest('[data-meta]');
        if (!tile) return;
        const allTiles = Array.from(grid.querySelectorAll('[data-meta]'));
        const viewerFiles = allTiles.map(_personPhotoToViewerFile).filter(Boolean);
        const idx = allTiles.indexOf(tile);
        if (viewerFiles.length) openMediaViewerForReview(viewerFiles, Math.max(0, idx));
    };
    grid.addEventListener('click', _photoGridClickHandler);
}

async function _commitSplit() {
    if (!_splitSelectedDlIds.size || !_selectedPerson) return;

    // Photo-grid selection is by download id. The server expands each
    // download to every face of this person on that photo so sibling
    // detections are not left on the source cluster.
    const downloadIds = [..._splitSelectedDlIds];

    const newLabel = await promptSheet({
        title: i18nT('maintenance.ai.person_split', 'Split'),
        message: i18nT(
            'maintenance.ai.split_label_prompt',
            'Label for the new cluster (optional):',
        ),
        confirmLabel: i18nT('maintenance.ai.person_split', 'Split'),
        cancelLabel: i18nT('common.cancel', 'Cancel'),
    });
    if (newLabel === null) return; // cancelled

    try {
        const res = await api.post(`/api/ai/people/${_selectedPerson}/split`, {
            downloadIds,
            label: newLabel || undefined,
        });
        if (!res.success) throw new Error(res.error || 'split failed');
        const moved = Number(res.moved) || downloadIds.length;
        showToast(
            `${i18nT('maintenance.ai.split_done', 'Split complete')} — ${moved} ${i18nT('maintenance.ai.faces_short', 'faces')}`,
            'success',
        );
        _exitSplitMode();
        _loadPeople();
        await refreshStatus();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ---- Doctor (system-health card) -----------------------------------------

async function _refreshDoctor() {
    const el = $('#ai-doctor-list');
    const sumEl = $('#ai-doctor-summary');
    if (!el) return;
    el.innerHTML = `<div class="text-tg-textSecondary text-xs py-2">${escapeHtml(i18nT('common.loading', 'Loading…'))}</div>`;
    if (sumEl) sumEl.textContent = `· ${i18nT('common.loading', 'Loading…')}`;
    try {
        const r = await api.get('/api/ai/doctor');
        if (!r.success) throw new Error(r.error || 'doctor failed');
        const checks = Array.isArray(r.checks) ? r.checks : [];
        const fails = checks.filter((c) => c.status === 'fail').length;
        const warns = checks.filter((c) => c.status === 'warn').length;
        if (sumEl) {
            let text;
            if (fails) {
                text = `· ${fails} ${i18nT('maintenance.ai.doctor_failing', 'failing')}`;
                sumEl.className = 'text-[10.5px] text-red-300';
            } else if (warns) {
                text = `· ${warns} ${i18nT('maintenance.ai.doctor_warning', 'warning')}`;
                sumEl.className = 'text-[10.5px] text-yellow-300';
            } else {
                text = `· ${i18nT('maintenance.ai.doctor_all_ok', 'all checks ok')}`;
                sumEl.className = 'text-[10.5px] text-green-300';
            }
            sumEl.textContent = text;
        }
        _setActionButtonsEnabled(fails === 0);
        const iconFor = (s) => (s === 'ok' ? '✓' : s === 'warn' ? '⚠' : s === 'fail' ? '✗' : 'ℹ');
        el.innerHTML = checks
            .map(
                (c) => `
            <div class="ai-doctor-row" title="${escapeHtml(c.detail || '')}">
                <span class="ai-doctor-icon ai-doctor-${escapeHtml(c.status || 'info')}">${iconFor(c.status)}</span>
                <span class="ai-doctor-label">${escapeHtml(c.label || c.id || '')}</span>
                <span class="ai-doctor-detail">${escapeHtml(c.detail || '')}</span>
            </div>`,
            )
            .join('');
    } catch (e) {
        el.innerHTML = `<div class="text-red-300 text-xs py-2">${escapeHtml(e.message)}</div>`;
        if (sumEl) {
            sumEl.className = 'text-[10.5px] text-red-300';
            sumEl.textContent = `· ${i18nT('common.error', 'Error')}`;
        }
        _setActionButtonsEnabled(false);
    }
}

function _setActionButtonsEnabled(enabled) {
    const ids = ['ai-scan-btn', 'ai-reindex-btn', 'ai-recluster-btn', 'ai-rebuild-btn'];
    for (const id of ids) {
        const btn = $(`#${id}`) || document.getElementById(id);
        if (!btn) continue;
        btn.disabled = !enabled;
        if (enabled) {
            btn.classList.remove('opacity-40', 'pointer-events-none');
            btn.removeAttribute('title');
        } else {
            btn.classList.add('opacity-40', 'pointer-events-none');
            btn.title = i18nT(
                'maintenance.ai.doctor_must_pass',
                'Fix health checks before scanning',
            );
        }
    }
}
