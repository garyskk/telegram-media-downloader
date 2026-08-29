// Face-crop thumbnail loader — unclassified / face-review grids used to set
// src on every tile at once (page of 100), which stampeded ffmpeg/sharp
// and timed out. The queue keeps only a small number in flight.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    FACE_CROP_LOAD_CONCURRENCY,
    createCropLoadQueue,
} from '../../src/web/public/js/face-crop-queue.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function fakeImg(id, { connected = true, dataSrc = `/api/ai/faces/${id}/crop?w=160` } = {}) {
    const listeners = { load: [], error: [] };
    const attrs = {};
    if (dataSrc) attrs['data-src'] = dataSrc;
    return {
        id,
        isConnected: connected,
        getAttribute(name) {
            return Object.hasOwn(attrs, name) ? attrs[name] : null;
        },
        setAttribute(name, val) {
            attrs[name] = val;
        },
        removeAttribute(name) {
            delete attrs[name];
        },
        addEventListener(ev, fn) {
            (listeners[ev] || (listeners[ev] = [])).push(fn);
        },
        fire(ev) {
            for (const fn of listeners[ev] || []) fn();
        },
    };
}

describe('createCropLoadQueue', () => {
    it('defaults to a small batch (4 concurrent), not the whole page', () => {
        expect(FACE_CROP_LOAD_CONCURRENCY).toBe(4);
        const q = createCropLoadQueue();
        expect(q.stats().concurrency).toBe(4);
    });

    it('starts at most `concurrency` images and queues the rest', () => {
        const q = createCropLoadQueue({ concurrency: 2 });
        const imgs = [1, 2, 3, 4, 5].map((id) => fakeImg(id));
        for (const img of imgs) q.enqueue(img);

        expect(q.stats()).toEqual({ active: 2, pending: 3, concurrency: 2 });
        expect(imgs[0].getAttribute('src')).toBe('/api/ai/faces/1/crop?w=160');
        expect(imgs[1].getAttribute('src')).toBe('/api/ai/faces/2/crop?w=160');
        expect(imgs[2].getAttribute('src')).toBeNull();
        expect(imgs[0].getAttribute('data-src')).toBeNull();
    });

    it('starts the next pending image when one load finishes', () => {
        const q = createCropLoadQueue({ concurrency: 2 });
        const imgs = [1, 2, 3].map((id) => fakeImg(id));
        for (const img of imgs) q.enqueue(img);

        imgs[0].fire('load');
        expect(imgs[2].getAttribute('src')).toBe('/api/ai/faces/3/crop?w=160');
        expect(q.stats().active).toBe(2);
        expect(q.stats().pending).toBe(0);
    });

    it('frees a slot on error as well as load', () => {
        const q = createCropLoadQueue({ concurrency: 1 });
        const a = fakeImg(1);
        const b = fakeImg(2);
        q.enqueue(a);
        q.enqueue(b);
        expect(b.getAttribute('src')).toBeNull();

        a.fire('error');
        expect(b.getAttribute('src')).toBe('/api/ai/faces/2/crop?w=160');
        expect(q.stats().pending).toBe(0);
    });

    it('skips disconnected images so a closed panel does not keep loading', () => {
        const q = createCropLoadQueue({ concurrency: 1 });
        const live = fakeImg(1);
        const gone = fakeImg(2, { connected: false });
        const next = fakeImg(3);
        q.enqueue(live);
        q.enqueue(gone);
        q.enqueue(next);

        live.fire('load');
        expect(gone.getAttribute('src')).toBeNull();
        expect(next.getAttribute('src')).toBe('/api/ai/faces/3/crop?w=160');
    });

    it('clear() drops pending work without starting it', () => {
        const q = createCropLoadQueue({ concurrency: 1 });
        const a = fakeImg(1);
        const b = fakeImg(2);
        q.enqueue(a);
        q.enqueue(b);
        q.clear();
        a.fire('load');
        expect(b.getAttribute('src')).toBeNull();
        expect(q.stats()).toEqual({ active: 0, pending: 0, concurrency: 1 });
    });

    it('does not occupy a slot when the img has no data-src', () => {
        const q = createCropLoadQueue({ concurrency: 1 });
        const empty = fakeImg(1, { dataSrc: null });
        const real = fakeImg(2);
        q.enqueue(empty);
        q.enqueue(real);
        expect(empty.getAttribute('src')).toBeNull();
        expect(real.getAttribute('src')).toBe('/api/ai/faces/2/crop?w=160');
        expect(q.stats().active).toBe(1);
    });

    it('reclaims in-flight slots when tiles are removed from the DOM', () => {
        const q = createCropLoadQueue({ concurrency: 2 });
        const a = fakeImg(1);
        const b = fakeImg(2);
        q.enqueue(a);
        q.enqueue(b);
        expect(q.stats().active).toBe(2);
        a.isConnected = false;
        b.isConnected = false;
        const c = fakeImg(3);
        q.enqueue(c);
        expect(c.getAttribute('src')).toBe('/api/ai/faces/3/crop?w=160');
        expect(q.stats().active).toBe(1);
        a.fire('load');
        expect(q.stats().active).toBe(1);
    });

    it('clear() frees in-flight slots so a reload is not blocked', () => {
        const q = createCropLoadQueue({ concurrency: 2 });
        const a = fakeImg(1);
        const b = fakeImg(2);
        q.enqueue(a);
        q.enqueue(b);
        q.clear();
        expect(q.stats()).toEqual({ active: 0, pending: 0, concurrency: 2 });
        const c = fakeImg(3);
        q.enqueue(c);
        expect(c.getAttribute('src')).toBe('/api/ai/faces/3/crop?w=160');
        a.fire('load');
        expect(q.stats().active).toBe(1);
    });
});

describe('unclassified / face-review crop wiring', () => {
    const aiSrc = readFileSync(
        join(HERE, '..', '..', 'src/web/public/js/maintenance-ai.js'),
        'utf8',
    );
    const serverSrc = readFileSync(join(HERE, '..', '..', 'src/web/server.js'), 'utf8');

    it('fetches unclassified faces in small pages, not 100 at once', () => {
        expect(aiSrc).toMatch(/const _UNCLASSIFIED_PAGE_SIZE = 24/);
        expect(aiSrc).toMatch(/const _FACE_REVIEW_PAGE_SIZE = 24/);
    });

    it('unclassified and face-review tiles defer crop src to the queue', () => {
        expect(aiSrc).toMatch(/createCropLoadQueue/);
        expect(
            (aiSrc.match(/data-src="\/api\/ai\/faces\/\$\{faceId\}\/crop\?w=160"/g) || []).length,
        ).toBe(2);
        expect(aiSrc).not.toMatch(/<img src="\/api\/ai\/faces\/\$\{faceId\}\/crop\?w=160"/);
    });

    it('server caps concurrent face-crop generation', () => {
        expect(serverSrc).toMatch(/TGDL_FACE_CROP_CONCURRENCY\) \|\| 4/);
        expect(serverSrc).toMatch(/_generateFaceCropLimited/);
    });
});
