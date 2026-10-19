// One shuffle session shared by the gallery chip and the player.
// The full filtered library comes from GET /api/downloads/ids; tiles are
// filled in windows of 100 via POST /api/downloads/by-ids.

import { state } from './store.js';
import { api } from './api.js';
import { showToast } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { pinnedQs } from './gallery-toolbar.js';

const session = {
    active: false,
    busy: false,
    keys: [],
    cache: new Map(),
    backupFiles: null,
    backupIndex: 0,
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

function fisherYates(list) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
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

async function hydrate(keys) {
    const missing = keys.filter((k) => !session.cache.has(keyOf(k)));
    for (let i = 0; i < missing.length; i += 100) {
        const slice = missing.slice(i, i + 100);
        const res = await api.post('/api/downloads/by-ids', { ids: slice });
        for (const file of res?.files || []) {
            session.cache.set(keyOf(file.id != null ? { id: file.id, peer_id: file.peer_id } : file), file);
            session.cache.set(`${file.peer_id || 'self'}:${file.id}`, file);
        }
        if (!session.active) return;
    }
}

function materialize() {
    const files = [];
    for (const key of session.keys) {
        const file = session.cache.get(keyOf(key));
        if (!file) break;
        files.push(file);
    }
    state.files = files;
    state.hasMore = files.length < session.keys.length;
}

export function isShuffleActive() {
    return session.active;
}

export function shuffleComplete() {
    return !session.active || state.files.length >= session.keys.length;
}

async function openAt(index) {
    const { openMediaViewer } = await import('./viewer.js');
    openMediaViewer(index);
}

export async function toggleShuffle({ openPlayer = true } = {}) {
    if (session.busy) return;
    if (session.active) {
        const backup = session.backupFiles;
        const backupIndex = session.backupIndex;
        session.active = false;
        session.keys = [];
        session.cache = new Map();
        session.backupFiles = null;
        if (Array.isArray(backup)) {
            state.files = backup;
            state.currentFileIndex = Math.max(0, Math.min(backupIndex, Math.max(0, backup.length - 1)));
            state.hasMore = true;
        }
        syncChrome();
        showToast(i18nT('toast.viewer_shuffle_off', 'Shuffle off'), 'info');
        return;
    }
    session.busy = true;
    try {
        const res = await api.get(`/api/downloads/ids?${shuffleQs()}`);
        const raw = res?.ids || [];
        if (!raw.length) {
            showToast(i18nT('toast.viewer_shuffle_empty', 'No files to shuffle'), 'info');
            return;
        }
        session.backupFiles = state.files.slice();
        session.backupIndex = state.currentFileIndex || 0;
        session.keys = fisherYates(raw);
        session.cache = new Map();
        session.active = true;
        await hydrate(session.keys.slice(0, 100));
        materialize();
        if (!state.files.length) {
            session.active = false;
            state.files = session.backupFiles || [];
            session.backupFiles = null;
            showToast(i18nT('toast.viewer_shuffle_empty', 'No files to shuffle'), 'info');
            return;
        }
        syncChrome();
        showToast(
            i18nTf('toast.viewer_shuffle_on', { count: session.keys.length }, `Shuffle on · ${session.keys.length} files`),
            'info',
        );
        if (openPlayer) await openAt(0);
        if (session.keys.length > 100) {
            hydrate(session.keys).then(() => {
                if (session.active) materialize();
            });
        }
    } catch (e) {
        console.error('shuffle', e);
        session.active = false;
        if (session.backupFiles) state.files = session.backupFiles;
        session.backupFiles = null;
        syncChrome();
        showToast(i18nT('toast.viewer_shuffle_error', 'Could not start shuffle'), 'error');
    } finally {
        session.busy = false;
    }
}

export function initGalleryShuffle() {
    for (const id of ['gallery-shuffle-btn', 'modal-shuffle-btn']) {
        document.getElementById(id)?.addEventListener('click', () => {
            toggleShuffle({ openPlayer: true });
        });
    }
}
