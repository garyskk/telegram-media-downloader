/**
 * Maintenance → Similar clips.
 *
 * Scan (scene+PDQ fingerprints) then Analyze (similar whole-videos,
 * optional partial clips). Groups are keep/remove/review from the
 * server — delete selected extras, ignore false-positive pairs, or
 * Purge records to wipe hashes without touching hover sprites.
 */

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml, formatBytes } from './utils.js';
import { confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { loadAdvanced, setupAutoSave } from './settings.js';
import { openMediaViewerForReview } from './viewer.js';

const $ = (id) => document.getElementById(id);
const PARTIAL_LS = 'tgdl.similar.checkPartialClips';

let _wsWired = false;
let _pageWired = false;
let _groups = [];
let _ignores = new Set();
let _kindFilter = '';
let _scanRunning = false;
let _analyzeRunning = false;

function _formatRelative(unixMs) {
    const t = Number(unixMs) || 0;
    if (!t) return '';
    const diff = Math.max(0, Date.now() - t);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return i18nT('maintenance.similar.stats.just_now', 'just now');
    const min = Math.floor(sec / 60);
    if (min < 60)
        return i18nTf('maintenance.similar.stats.minutes_ago', { n: min }, `${min} min ago`);
    const hr = Math.floor(min / 60);
    if (hr < 24) return i18nTf('maintenance.similar.stats.hours_ago', { n: hr }, `${hr} h ago`);
    const days = Math.floor(hr / 24);
    return i18nTf('maintenance.similar.stats.days_ago', { n: days }, `${days} d ago`);
}

function _pairKey(a, b) {
    const x = Number(a);
    const y = Number(b);
    return x < y ? `${x}:${y}` : `${y}:${x}`;
}

function _groupPairKey(g) {
    const ids = (g.members || []).map((m) => Number(m.download_id)).filter((n) => n > 0);
    if (ids.length < 2) return '';
    return _pairKey(ids[0], ids[1]);
}

function _kindLabel(kind) {
    if (kind === 'partial') return i18nT('maintenance.similar.kind.partial', 'Partial');
    if (kind === 'partial_review') return i18nT('maintenance.similar.kind.partial_review', 'Review');
    return i18nT('maintenance.similar.kind.similar', 'Similar');
}

function _roleLabel(role) {
    if (role === 'remove') return i18nT('maintenance.similar.role.remove', 'remove');
    if (role === 'review') return i18nT('maintenance.similar.role.review', 'review');
    return i18nT('maintenance.similar.role.keep', 'keep');
}

function _setBusyButtons() {
    const busy = _scanRunning || _analyzeRunning;
    const scanBtn = $('sim-scan-btn');
    const scanStop = $('sim-scan-stop-btn');
    const anBtn = $('sim-analyze-btn');
    const anStop = $('sim-analyze-stop-btn');
    const purgeBtn = $('sim-purge-btn');
    const purgeAnalyzeBtn = $('sim-purge-analyze-btn');
    if (scanBtn) scanBtn.disabled = busy;
    if (anBtn) anBtn.disabled = busy;
    if (purgeBtn) purgeBtn.disabled = busy;
    if (purgeAnalyzeBtn) purgeAnalyzeBtn.disabled = busy;
    if (scanStop) {
        scanStop.classList.toggle('hidden', !_scanRunning);
        scanStop.disabled = !_scanRunning;
    }
    if (anStop) {
        anStop.classList.toggle('hidden', !_analyzeRunning);
        anStop.disabled = !_analyzeRunning;
    }
}

function _setProgress(prefix, running, p = {}) {
    const wrap = $(`${prefix}-progress`);
    const bar = $(`${prefix}-progress-bar`);
    const stage = $(`${prefix}-progress-stage`);
    const pctEl = $(`${prefix}-progress-pct`);
    if (!wrap) return;
    wrap.classList.toggle('hidden', !running);
    const processed = Number(p.processed) || 0;
    const total = Number(p.total) || 0;
    const skipped = Number(p.skipped) || 0;
    const pct =
        total > 0
            ? Math.min(100, Math.round((processed / total) * 100))
            : skipped > 0
              ? 100
              : running
                ? 5
                : 0;
    if (bar) bar.style.width = `${pct}%`;
    if (stage) {
        const stageKey = String(p.stage || '').toLowerCase();
        const label =
            stageKey === 'starting' || stageKey === 'load'
                ? i18nT('maintenance.similar.progress.checking', 'Checking…')
                : stageKey === 'matching'
                  ? i18nT('maintenance.similar.progress.matching', 'Matching')
                  : stageKey === 'partial'
                    ? i18nT('maintenance.similar.progress.partial', 'Partial')
                    : stageKey === 'persist'
                      ? i18nT('maintenance.similar.progress.saving', 'Saving')
                      : p.stage
                        ? String(p.stage)
                        : prefix === 'sim-scan'
                          ? i18nT('maintenance.similar.progress.scanning', 'Scanning…')
                          : i18nT('maintenance.similar.progress.analyzing', 'Analyzing…');
        if (total > 0) {
            stage.textContent = `${label} · ${processed.toLocaleString()} / ${total.toLocaleString()}`;
        } else if (skipped > 0) {
            stage.textContent = i18nTf(
                'maintenance.similar.progress.up_to_date',
                { n: skipped },
                `Up to date · ${skipped.toLocaleString()} already matched`,
            );
        } else {
            stage.textContent = label;
        }
    }
    if (pctEl) {
        const extra = [];
        if (p.generated != null) extra.push(`${p.generated} gen`);
        if (skipped > 0 && total > 0) extra.push(`${skipped} skip`);
        if (p.comparedPairs != null) extra.push(`${p.comparedPairs} pairs`);
        if (p.groups != null) extra.push(`${p.groups} groups`);
        pctEl.textContent = extra.length ? `${pct}% · ${extra.join(' · ')}` : `${pct}%`;
    }
}

async function _refreshStats() {
    try {
        const s = await api.get('/api/maintenance/similar/stats');
        if (!s || typeof s !== 'object') return;
        const setNum = (id, n) => {
            const el = $(id);
            if (el) el.textContent = (Number(n) || 0).toLocaleString();
        };
        setNum('sim-stat-total', s.totalVideos);
        setNum('sim-stat-fp', s.fingerprinted);
        const miss = $('sim-stat-missing');
        if (miss) {
            miss.textContent = (s.missing || 0).toLocaleString();
            miss.classList.toggle('text-tg-orange', (s.missing || 0) > 0);
            miss.classList.toggle('text-tg-green', (s.missing || 0) === 0 && (s.fingerprinted || 0) > 0);
        }
        const lastEl = $('sim-stat-last');
        const last = s.lastScan;
        if (lastEl) {
            if (last?.finishedAt) {
                lastEl.textContent = _formatRelative(last.finishedAt);
                lastEl.title = new Date(last.finishedAt).toLocaleString();
            } else {
                lastEl.textContent = i18nT('maintenance.similar.stats.never', 'Never');
                lastEl.title = '';
            }
        }
        const summary = $('sim-stat-summary');
        if (summary) {
            const bits = [];
            if (last?.finishedAt) {
                bits.push(
                    i18nTf(
                        'maintenance.similar.stats.last_scan_result',
                        {
                            generated: last.generated || 0,
                            skipped: last.skipped || 0,
                            errored: last.errored || 0,
                        },
                        `Last scan: ${last.generated || 0} generated · ${last.skipped || 0} skipped · ${last.errored || 0} errors`,
                    ),
                );
            }
            const an = s.lastAnalyze;
            if (an?.finishedAt) {
                bits.push(
                    i18nTf(
                        'maintenance.similar.stats.last_analyze_result',
                        {
                            similar: an.similarGroups || 0,
                            partial: an.partialGroups || 0,
                            review: an.partialReviewGroups || 0,
                        },
                        `Last analyze: ${an.similarGroups || 0} similar · ${an.partialGroups || 0} partial · ${an.partialReviewGroups || 0} review`,
                    ),
                );
            }
            summary.textContent = bits.join('  ·  ');
            summary.classList.toggle('hidden', !bits.length);
        }
    } catch {
        /* informational */
    }
}

async function _refreshGroups() {
    try {
        const q = _kindFilter ? `?kind=${encodeURIComponent(_kindFilter)}` : '';
        const r = await api.get(`/api/maintenance/similar/groups${q}`);
        _groups = Array.isArray(r?.groups) ? r.groups : [];
    } catch (e) {
        showToast(e?.message || 'Failed to load groups', 'error');
        _groups = [];
    }
    try {
        const ir = await api.get('/api/maintenance/similar/ignore');
        _ignores = new Set(
            (ir?.ignores || []).map((row) => _pairKey(row.a_id, row.b_id)),
        );
    } catch {
        _ignores = new Set();
    }
    _renderGroups();
}

function _visibleGroups() {
    return _groups.filter((g) => !_ignores.has(_groupPairKey(g)));
}

function _memberToViewerFile(m) {
    const fileType = String(m.file_type || 'video');
    const filePath = String(m.file_path || '').replace(/\\/g, '/');
    const type =
        fileType === 'photo' || fileType === 'image' || fileType === 'sticker'
            ? 'images'
            : fileType === 'video'
              ? 'videos'
              : fileType === 'audio'
                ? 'audio'
                : 'files';
    return {
        id: Number(m.download_id) || 0,
        name: m.file_name || '',
        path: filePath,
        fullPath: filePath,
        type,
        file_type: fileType,
        size: Number(m.file_size) || 0,
        sizeFormatted: formatBytes(Number(m.file_size) || 0),
        modified: null,
        peer_id: 'self',
    };
}

function _openMemberInPlayer(el) {
    const groupId = Number(el.dataset.groupId);
    const downloadId = Number(el.dataset.downloadId);
    const group = _groups.find((g) => Number(g.id) === groupId);
    if (!group) return;
    const files = (group.members || []).map(_memberToViewerFile).filter((f) => f.fullPath);
    if (!files.length) return;
    const idx = files.findIndex((f) => f.id === downloadId);
    openMediaViewerForReview(files, Math.max(0, idx));
}

function _renderRow(m, groupId) {
    const id = Number(m.download_id);
    const thumbUrl = `/api/thumbs/${encodeURIComponent(id)}?w=320`;
    const sizeStr = m.file_size ? formatBytes(m.file_size) : '';
    const dur =
        m.duration_sec != null
            ? `${Math.round(Number(m.duration_sec))}s`
            : '';
    const deletable = m.role === 'remove' || m.role === 'review';
    const accent = deletable ? 'border-l-red-400/60' : 'border-l-tg-green/60';
    const roleCls =
        m.role === 'keep'
            ? 'bg-tg-green/15 text-tg-green'
            : m.role === 'review'
              ? 'bg-yellow-500/15 text-yellow-300'
              : 'bg-red-500/15 text-red-300';
    const openAttrs = `data-open-player data-group-id="${groupId}" data-download-id="${id}"`;
    return `
        <div class="sim-row group flex items-center gap-3 p-2 rounded-lg hover:bg-tg-hover/40 border-l-2 ${accent} transition-colors" data-file-row="${id}">
            ${
                deletable
                    ? `<input type="checkbox" class="sim-del shrink-0 cursor-pointer" data-id="${id}" checked>`
                    : `<span class="w-4 shrink-0"></span>`
            }
            <img loading="lazy" decoding="async" ${openAttrs}
                 class="w-14 h-14 object-cover rounded-md bg-tg-bg/40 shrink-0 ring-1 ring-tg-border/40 cursor-pointer"
                 src="${escapeHtml(thumbUrl)}" alt=""
                 onerror="this.style.display='none'">
            <div class="min-w-0 flex-1">
                <button type="button" ${openAttrs}
                        class="block w-full text-left text-sm text-tg-text truncate font-medium hover:text-tg-blue cursor-pointer">
                    ${escapeHtml(m.file_name || '(unnamed)')}
                </button>
                <div class="text-[11px] text-tg-textSecondary truncate flex items-center gap-1.5 flex-wrap">
                    <span class="inline-flex items-center gap-1 px-1.5 py-0 rounded ${roleCls}">${escapeHtml(_roleLabel(m.role))}</span>
                    ${sizeStr ? `<span class="tabular-nums">${escapeHtml(sizeStr)}</span>` : ''}
                    ${dur ? `<span class="tabular-nums">${escapeHtml(dur)}</span>` : ''}
                </div>
                ${m.reason ? `<div class="text-[10px] text-tg-textSecondary/80 truncate mt-0.5">${escapeHtml(m.reason)}</div>` : ''}
            </div>
        </div>`;
}

function _renderGroup(g) {
    const kindCls =
        g.kind === 'partial'
            ? 'bg-violet-500/15 text-violet-300'
            : g.kind === 'partial_review'
              ? 'bg-yellow-500/15 text-yellow-300'
              : 'bg-tg-blue/15 text-tg-blue';
    const conf =
        g.confidence != null ? `${Math.round(Number(g.confidence) * 100)}%` : '';
    const offset =
        g.offset_sec != null && Number(g.offset_sec) > 0
            ? `@ ${Number(g.offset_sec).toFixed(1)}s`
            : '';
    const keep = (g.members || []).find((m) => m.role === 'keep');
    const other = (g.members || []).find((m) => m.role !== 'keep');
    return `
        <div class="bg-tg-panel rounded-xl p-3 mb-2 border border-tg-border/30" data-group="${g.id}">
            <div class="flex items-center gap-2 mb-2 flex-wrap">
                <span class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full ${kindCls} font-medium">
                    ${escapeHtml(_kindLabel(g.kind))}
                </span>
                ${conf ? `<span class="text-[11px] text-tg-textSecondary tabular-nums">${escapeHtml(conf)}</span>` : ''}
                ${offset ? `<span class="text-[11px] text-tg-textSecondary tabular-nums">${escapeHtml(offset)}</span>` : ''}
                <button type="button" class="ml-auto text-[11px] px-2 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue inline-flex items-center gap-1"
                        data-ignore="${g.id}"
                        data-a="${keep?.download_id || ''}"
                        data-b="${other?.download_id || ''}"
                        data-kind="${escapeHtml(g.kind || 'similar')}">
                    <i class="ri-eye-off-line"></i>${escapeHtml(i18nT('maintenance.similar.ignore', 'Ignore pair'))}
                </button>
            </div>
            <div class="space-y-1">
                ${(g.members || []).map((m) => _renderRow(m, g.id)).join('')}
            </div>
        </div>`;
}

function _renderGroups() {
    const list = $('sim-list');
    const empty = $('sim-empty');
    const totals = $('sim-totals');
    const visible = _visibleGroups();
    if (empty) empty.classList.toggle('hidden', visible.length > 0);
    if (list) list.innerHTML = visible.map(_renderGroup).join('');
    if (totals) {
        totals.textContent = visible.length
            ? i18nTf(
                  'maintenance.similar.totals',
                  { n: visible.length },
                  `${visible.length} group(s)`,
              )
            : '';
    }
    _refreshSummary();
}

function _refreshSummary() {
    const root = $('page-maintenance-similar');
    const el = $('sim-summary');
    if (!root || !el) return;
    const n = root.querySelectorAll('.sim-del:checked').length;
    el.textContent = n
        ? i18nTf('maintenance.similar.selected', { n }, `${n} selected`)
        : '';
}

function _wantPartial() {
    return $('sim-partial-check')?.checked === true;
}

function _persistPartialFlag() {
    try {
        localStorage.setItem(PARTIAL_LS, _wantPartial() ? '1' : '0');
    } catch {}
}

function _restorePartialFlag() {
    const el = $('sim-partial-check');
    if (!el) return;
    try {
        const stored = localStorage.getItem(PARTIAL_LS);
        el.checked = stored !== '0';
    } catch {
        el.checked = true;
    }
}

async function _startScan() {
    try {
        const r = await api.post('/api/maintenance/similar/scan', {});
        if (r?.started || r?.code === 'ALREADY_RUNNING') {
            _scanRunning = true;
            _setBusyButtons();
            _setProgress('sim-scan', true, r?.snapshot?.progress || {});
            showToast(i18nT('maintenance.similar.scan_started', 'Scan started'));
        }
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            _scanRunning = true;
            _setBusyButtons();
            _setProgress('sim-scan', true, e.data?.snapshot?.progress || {});
            showToast(i18nT('maintenance.similar.already_running', 'Already running'));
            return;
        }
        showToast(e?.message || 'Scan failed', 'error');
    }
}

async function _stopScan() {
    try {
        await api.post('/api/maintenance/similar/scan/stop', {});
        showToast(i18nT('maintenance.similar.cancelling', 'Cancelling…'));
    } catch (e) {
        showToast(e?.message || 'Stop failed', 'error');
    }
}

function _analyzeProgressFrom(snapshot, extra = {}) {
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const nested = snap.progress && typeof snap.progress === 'object' ? snap.progress : {};
    return { stage: snap.stage || 'starting', ...nested, ...extra };
}

async function _startAnalyze() {
    try {
        const r = await api.post('/api/maintenance/similar/analyze', {
            checkPartialClips: _wantPartial(),
        });
        if (r?.started || r?.code === 'ALREADY_RUNNING') {
            _analyzeRunning = true;
            _setBusyButtons();
            _setProgress('sim-analyze', true, _analyzeProgressFrom(r?.snapshot));
            showToast(i18nT('maintenance.similar.analyze_started', 'Checking for new videos…'));
        }
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            _analyzeRunning = true;
            _setBusyButtons();
            _setProgress(
                'sim-analyze',
                true,
                _analyzeProgressFrom(e.data?.snapshot?.analyze || e.data?.snapshot),
            );
            showToast(i18nT('maintenance.similar.already_running', 'Already running'));
            return;
        }
        showToast(e?.message || 'Analyze failed', 'error');
    }
}

async function _stopAnalyze() {
    try {
        await api.post('/api/maintenance/similar/analyze/stop', {});
        showToast(i18nT('maintenance.similar.cancelling', 'Cancelling…'));
    } catch (e) {
        showToast(e?.message || 'Stop failed', 'error');
    }
}

async function _deleteSelected() {
    const root = $('page-maintenance-similar');
    if (!root) return;
    const ids = [...root.querySelectorAll('.sim-del:checked')].map((el) => Number(el.dataset.id));
    if (!ids.length) {
        showToast(i18nT('maintenance.similar.nothing', 'Nothing selected'), 'info');
        return;
    }
    const ok = await confirmSheet({
        title: i18nT('maintenance.similar.confirm_title', 'Delete selected videos?'),
        message: i18nTf(
            'maintenance.similar.confirm_body',
            { n: ids.length },
            `Permanently delete ${ids.length} file(s) from disk and database?`,
        ),
        confirmLabel: i18nT('maintenance.similar.confirm_btn', 'Delete'),
        danger: true,
    });
    if (!ok) return;
    try {
        const r = await api.post('/api/maintenance/similar/delete', { ids });
        showToast(
            i18nTf(
                'maintenance.similar.deleted',
                { n: r?.removed || ids.length },
                `Deleted ${r?.removed || ids.length} file(s)`,
            ),
            'success',
        );
        await Promise.all([_refreshGroups(), _refreshStats()]);
    } catch (e) {
        showToast(e?.message || 'Delete failed', 'error');
    }
}

async function _ignorePair(btn) {
    const aId = Number(btn.dataset.a);
    const bId = Number(btn.dataset.b);
    const kind = String(btn.dataset.kind || 'similar');
    if (!aId || !bId) return;
    try {
        await api.post('/api/maintenance/similar/ignore', { aId, bId, kind });
        _ignores.add(_pairKey(aId, bId));
        _renderGroups();
        showToast(i18nT('maintenance.similar.ignored', 'Pair ignored'), 'success');
    } catch (e) {
        showToast(e?.message || 'Ignore failed', 'error');
    }
}

async function _purgeRecords() {
    $('sim-more-menu')?.removeAttribute('open');
    const ok = await confirmSheet({
        title: i18nT('maintenance.similar.purge_confirm_title', 'Purge similar records?'),
        message: i18nT(
            'maintenance.similar.purge_confirm_body',
            'This wipes every fingerprint, every similar/partial group, and partial-resume cursors. Hover sprites are not touched. Ignored pairs are kept. Next Scan regenerates hashes.',
        ),
        confirmLabel: i18nT('maintenance.similar.purge_confirm_btn', 'Purge records'),
        danger: true,
    });
    if (!ok) return;
    try {
        const r = await api.post('/api/maintenance/similar/purge', {});
        if (!r?.success) throw new Error(r?.error || 'purge failed');
        showToast(
            i18nT(
                'maintenance.similar.purged',
                'Records purged — run Scan to regenerate fingerprints',
            ),
            'success',
        );
        await Promise.all([_refreshGroups(), _refreshStats()]);
    } catch (e) {
        if (e?.status === 409 || e?.data?.code === 'ALREADY_RUNNING') {
            showToast(
                i18nT(
                    'maintenance.similar.purge_busy',
                    'Scan or Analyze is running. Cancel it first.',
                ),
                'error',
            );
            return;
        }
        const msg = e?.data?.error || e?.message || 'unknown';
        showToast(`${i18nT('maintenance.similar.purge_failed', 'Purge failed')}: ${msg}`, 'error');
    }
}

async function _purgeAnalyzeRecords() {
    $('sim-more-menu')?.removeAttribute('open');
    const ok = await confirmSheet({
        title: i18nT('maintenance.similar.purge_analyze_confirm_title', 'Purge Analyze records?'),
        message: i18nT(
            'maintenance.similar.purge_analyze_confirm_body',
            'This wipes similar/partial groups and Analyze resume cursors. Fingerprints stay. Ignored pairs stay. Next Analyze rebuilds groups from existing hashes.',
        ),
        confirmLabel: i18nT('maintenance.similar.purge_analyze_confirm_btn', 'Purge Analyze'),
        danger: true,
    });
    if (!ok) return;
    try {
        const r = await api.post('/api/maintenance/similar/analyze/purge', {});
        if (!r?.success) throw new Error(r?.error || 'purge failed');
        showToast(
            i18nT(
                'maintenance.similar.purge_analyze_done',
                'Analyze records purged — run Analyze to rebuild groups',
            ),
            'success',
        );
        await Promise.all([_refreshGroups(), _refreshStats()]);
    } catch (e) {
        if (e?.status === 409 || e?.data?.code === 'ALREADY_RUNNING') {
            showToast(
                i18nT(
                    'maintenance.similar.purge_busy',
                    'Scan or Analyze is running. Cancel it first.',
                ),
                'error',
            );
            return;
        }
        const msg = e?.data?.error || e?.message || 'unknown';
        showToast(`${i18nT('maintenance.similar.purge_failed', 'Purge failed')}: ${msg}`, 'error');
    }
}

function _onScanProgress(m) {
    _scanRunning = true;
    _setBusyButtons();
    _setProgress('sim-scan', true, m);
}

async function _onScanDone(m) {
    _scanRunning = false;
    _setBusyButtons();
    _setProgress('sim-scan', false);
    await _refreshStats();
    if (m?.error) {
        showToast(m.error, 'error');
        return;
    }
    if (m?.cancelled) {
        showToast(i18nT('maintenance.similar.cancelled', 'Cancelled'));
        return;
    }
    showToast(
        i18nTf(
            'maintenance.similar.scan_done',
            { generated: m?.generated || 0, skipped: m?.skipped || 0 },
            `Scan finished — ${m?.generated || 0} generated, ${m?.skipped || 0} skipped`,
        ),
        'success',
    );
}

function _onAnalyzeProgress(m) {
    _analyzeRunning = true;
    _setBusyButtons();
    _setProgress('sim-analyze', true, _analyzeProgressFrom(m));
}

async function _onAnalyzeDone(m) {
    _analyzeRunning = false;
    _setBusyButtons();
    _setProgress('sim-analyze', false);
    await Promise.all([_refreshGroups(), _refreshStats()]);
    if (m?.error) {
        showToast(m.error, 'error');
        return;
    }
    if (m?.cancelled) {
        showToast(i18nT('maintenance.similar.cancelled', 'Cancelled'));
        return;
    }
    if (
        m?.upToDate ||
        (!(m?.similarGroups || 0) &&
            !(m?.partialGroups || 0) &&
            !(m?.partialReviewGroups || 0) &&
            !(m?.comparedPairs || 0))
    ) {
        showToast(
            i18nT('maintenance.similar.analyze_up_to_date', 'Analyze up to date — no new videos'),
            'success',
        );
        return;
    }
    showToast(
        i18nTf(
            'maintenance.similar.analyze_done',
            {
                similar: m?.similarGroups || 0,
                partial: m?.partialGroups || 0,
                review: m?.partialReviewGroups || 0,
            },
            `Analyze finished — ${m?.similarGroups || 0} similar, ${m?.partialGroups || 0} partial, ${m?.partialReviewGroups || 0} review`,
        ),
        'success',
    );
}

async function _recoverStatus() {
    try {
        const r = await api.get('/api/maintenance/similar/status');
        _scanRunning = !!r?.running;
        _analyzeRunning = !!r?.analyze?.running;
        _setBusyButtons();
        if (_scanRunning) _setProgress('sim-scan', true, { ...(r.progress || {}), stage: r.stage });
        else _setProgress('sim-scan', false);
        if (_analyzeRunning) {
            const ap = r.analyze || {};
            _setProgress('sim-analyze', true, { ...(ap.progress || {}), stage: ap.stage });
        } else _setProgress('sim-analyze', false);
    } catch {
        /* non-fatal */
    }
}

function _setKindFilter(kind) {
    _kindFilter = kind || '';
    document.querySelectorAll('[data-sim-kind]').forEach((btn) => {
        const on = (btn.dataset.simKind || '') === _kindFilter;
        btn.dataset.active = on ? '1' : '0';
        btn.classList.toggle('bg-tg-blue/20', on);
        btn.classList.toggle('text-tg-blue', on);
        btn.classList.toggle('text-tg-textSecondary', !on);
    });
    _refreshGroups();
}

function _wirePage() {
    if (_pageWired) return;
    _pageWired = true;
    $('sim-scan-btn')?.addEventListener('click', _startScan);
    $('sim-scan-stop-btn')?.addEventListener('click', _stopScan);
    $('sim-analyze-btn')?.addEventListener('click', _startAnalyze);
    $('sim-analyze-stop-btn')?.addEventListener('click', _stopAnalyze);
    $('sim-delete-btn')?.addEventListener('click', _deleteSelected);
    $('sim-purge-btn')?.addEventListener('click', _purgeRecords);
    $('sim-purge-analyze-btn')?.addEventListener('click', _purgeAnalyzeRecords);
    $('sim-partial-check')?.addEventListener('change', _persistPartialFlag);
    document.querySelectorAll('[data-sim-kind]').forEach((btn) => {
        btn.addEventListener('click', () => _setKindFilter(btn.dataset.simKind || ''));
    });
    const list = $('sim-list');
    if (list) {
        list.addEventListener('change', (e) => {
            const t = e.target;
            if (!t?.classList?.contains('sim-del')) return;
            const row = t.closest('[data-file-row]');
            if (row) {
                row.classList.toggle('border-l-red-400/60', t.checked);
                row.classList.toggle('border-l-tg-green/60', !t.checked);
            }
            _refreshSummary();
        });
        list.addEventListener('click', (e) => {
            const openEl = e.target.closest('[data-open-player]');
            if (openEl) {
                e.preventDefault();
                e.stopPropagation();
                _openMemberInPlayer(openEl);
                return;
            }
            const btn = e.target.closest('[data-ignore]');
            if (btn) _ignorePair(btn);
        });
    }
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    ws.on('similar_progress', _onScanProgress);
    ws.on('similar_done', _onScanDone);
    ws.on('similar_analyze_progress', _onAnalyzeProgress);
    ws.on('similar_analyze_done', _onAnalyzeDone);
    ws.on('similar_purged', () => {
        Promise.all([_refreshGroups(), _refreshStats()]).catch(() => {});
    });
    ws.on('__ws_open', () => {
        _recoverStatus();
        _refreshStats();
    });
}

export async function init() {
    _wirePage();
    _wireWs();
    _restorePartialFlag();
    try {
        setupAutoSave();
    } catch (e) {
        console.warn('[similar] setupAutoSave skipped:', e?.message || e);
    }
    try {
        const cfg = await api.get('/api/config');
        loadAdvanced(cfg);
    } catch {
        /* defaults stay in the HTML */
    }
    await Promise.all([_refreshStats(), _refreshGroups(), _recoverStatus()]);
}
