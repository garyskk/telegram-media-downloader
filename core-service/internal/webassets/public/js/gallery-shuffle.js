// One shuffle session shared by the gallery chip and the player.
// The deck is the full filtered id list, shuffled once. The grid shows one
// batch at a time; the next page takes the next batch and never repeats an
// earlier one. The player walks that same grid order.

import { state } from './store.js';
import { api } from './api.js';
import { showToast } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { pinnedQs } from './gallery-toolbar.js';
import { shuffleIds, takeBatch } from './gallery-shuffle-order.js';

const session = {
    active: false,
    busy: false,
    generation: 0,
    keys: [],
    cursor: 0,
    backup: null,
};

const hooks = {
    batchSize: () => 100,
    paint: () => {},
    followPlayer: () => {},
    subtitle: () => {},
    galleryTotal: () => null,
};

function scopeQs() {
    const s = state.galleryScope;
    if (!s || s === 'local') return '';
    if (s === 'all') return '&include=peers';
    return `&include=peers&peerId=${encodeURIComponent(s)}`;
}

function shuffleQs() {
    const type = state.currentFilter && state.currentFilter !== 'all' ? state.currentFilter : 'all';
    let qs = `type=${encodeURIComponent(type)}${pinnedQs()}${scopeQs()}`;
    if (state.currentGroupId) qs += `&groupId=${encodeURIComponent(state.currentGroupId)}`;
    if (state.searchQuery) qs += `&q=${encodeURIComponent(state.searchQuery)}`;
    return qs;
}

function keyOf(raw) {
    if (raw && typeof raw === 'object') return `${raw.peer_id || 'self'}:${raw.id}`;
    return `self:${raw}`;
}

function batchSize() {
    const n = Number(hooks.batchSize()) || 100;
    return Math.max(1, Math.min(100, n));
}

function syncChrome() {
    for (const id of ['gallery-shuffle-btn', 'modal-shuffle-btn']) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        btn.classList.toggle('bg-tg-blue/80', session.active);
        btn.classList.toggle('text-white', session.active);
        btn.setAttribute('aria-pressed', session.active ? 'true' : 'false');
    }
}

function scrollGalleryTop() {
    const el = document.getElementById('content-area');
    if (el) el.scrollTop = 0;
}

// Files come back in request order. A missing id is dropped; the rest keep
// the deck order.
function orderedFiles(keys, returned) {
    const byKey = new Map();
    for (const file of returned || []) {
        byKey.set(`${file.peer_id || 'self'}:${file.id}`, file);
    }
    const files = [];
    for (const key of keys) {
        const file = byKey.get(keyOf(key));
        if (file) files.push(file);
    }
    return files;
}

// Next slice of the deck. Null means this session was cancelled mid-fetch.
async function nextFiles(limit, gen) {
    let guard = 0;
    while (session.cursor < session.keys.length && guard < 5) {
        guard++;
        const page = takeBatch(session.keys, session.cursor, limit);
        session.cursor = page.cursor;
        if (!page.batch.length) return [];
        const res = await api.post('/api/downloads/by-ids', { ids: page.batch });
        if (gen !== session.generation) return null;
        const files = orderedFiles(page.batch, res?.files);
        if (files.length) return files;
    }
    return [];
}

function clearSession() {
    session.active = false;
    session.keys = [];
    session.cursor = 0;
    session.backup = null;
}

export function isShuffleActive() {
    return session.active;
}

export function shuffleBusy() {
    return session.busy;
}

export function shuffleHasMore() {
    return session.active && session.cursor < session.keys.length;
}

// True when auto-advance may wrap: shuffle is off, or the deck is fully loaded.
export function shuffleComplete() {
    return !session.active || !shuffleHasMore();
}

export function shuffleTotal() {
    return session.active ? session.keys.length : 0;
}

// A chronological gallery reload owns state.files. Drop the session without
// putting the pre-shuffle list back.
export function abandonShuffle() {
    if (!session.active && !session.busy) return;
    session.generation++;
    session.busy = false;
    clearSession();
    syncChrome();
}

function applyBackup() {
    const backup = session.backup;
    clearSession();
    if (!backup) return null;
    state.files = backup.files;
    state.page = backup.page;
    state.hasMore = backup.hasMore;
    state.currentFileIndex = backup.index;
    return backup;
}

function disableShuffle() {
    const previous = state.files[state.currentFileIndex] || null;
    session.generation++;
    const backup = applyBackup();
    syncChrome();
    scrollGalleryTop();
    hooks.paint({});
    if (backup) hooks.subtitle(backup.total);
    hooks.followPlayer(previous);
    showToast(i18nT('toast.viewer_shuffle_off', 'Shuffle off'), 'info');
}

export async function loadShuffleBatch() {
    if (!session.active || session.busy || !shuffleHasMore()) return 0;
    session.busy = true;
    const gen = session.generation;
    const from = state.files.length;
    try {
        const files = await nextFiles(batchSize(), gen);
        if (files == null || gen !== session.generation || !session.active) return 0;
        if (!files.length) {
            state.hasMore = false;
            return 0;
        }
        state.files = state.files.concat(files);
        state.hasMore = shuffleHasMore();
        hooks.paint({ append: true, fromIndex: from });
        hooks.followPlayer(null);
        return files.length;
    } catch (e) {
        console.error('shuffle', e);
        return 0;
    } finally {
        if (gen === session.generation) session.busy = false;
    }
}

export async function toggleShuffle() {
    if (session.busy) return;
    if (session.active) {
        disableShuffle();
        return;
    }
    session.busy = true;
    const gen = session.generation;
    try {
        const res = await api.get(`/api/downloads/ids?${shuffleQs()}`);
        if (gen !== session.generation) return;
        const raw = res?.ids || [];
        if (!raw.length) {
            showToast(i18nT('toast.viewer_shuffle_empty', 'No files to shuffle'), 'info');
            return;
        }
        const previous = state.files[state.currentFileIndex] || null;
        session.backup = {
            files: state.files.slice(),
            page: state.page,
            hasMore: state.hasMore,
            index: state.currentFileIndex || 0,
            total: hooks.galleryTotal(),
        };
        session.keys = shuffleIds(raw);
        session.cursor = 0;
        session.active = true;
        const files = await nextFiles(batchSize(), gen);
        if (files == null || gen !== session.generation) return;
        if (!files.length) {
            clearSession();
            syncChrome();
            showToast(i18nT('toast.viewer_shuffle_empty', 'No files to shuffle'), 'info');
            return;
        }
        state.files = files;
        state.page = 1;
        state.currentFileIndex = 0;
        state.hasMore = shuffleHasMore();
        syncChrome();
        scrollGalleryTop();
        hooks.paint({});
        hooks.followPlayer(previous);
        showToast(
            i18nTf('toast.viewer_shuffle_on', { count: session.keys.length }, `Shuffle on · ${session.keys.length} files`),
            'info',
        );
    } catch (e) {
        console.error('shuffle', e);
        if (gen === session.generation) {
            const backup = applyBackup();
            syncChrome();
            if (backup) {
                hooks.paint({});
                hooks.subtitle(backup.total);
            }
            showToast(i18nT('toast.viewer_shuffle_error', 'Could not start shuffle'), 'error');
        }
    } finally {
        if (gen === session.generation) session.busy = false;
    }
}

let wired = false;

export function initGalleryShuffle(nextHooks = {}) {
    Object.assign(hooks, nextHooks);
    if (wired) return;
    wired = true;
    for (const id of ['gallery-shuffle-btn', 'modal-shuffle-btn']) {
        document.getElementById(id)?.addEventListener('click', () => {
            toggleShuffle();
        });
    }
}
