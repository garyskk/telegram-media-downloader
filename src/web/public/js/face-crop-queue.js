/**
 * Bounded in-flight loader for expensive face-crop `<img>` tiles.
 *
 * `/api/ai/faces/:id/crop` decodes the source photo (or ffmpeg-extracts a
 * video frame) on every miss. Painting a page of tiles with `src` set
 * all at once stampedes the server and the requests time out. Keep `src`
 * off the element (`data-src` instead) and feed imgs through this queue
 * so only a small batch is generating at once.
 */

export const FACE_CROP_LOAD_CONCURRENCY = 4;

export function createCropLoadQueue({ concurrency = FACE_CROP_LOAD_CONCURRENCY } = {}) {
    const max = Math.max(1, Number(concurrency) || FACE_CROP_LOAD_CONCURRENCY);
    let active = 0;
    const pending = [];
    const inflight = new Set();

    function done(img) {
        if (!inflight.delete(img)) return;
        if (active > 0) active--;
        pump();
    }

    function reap() {
        for (const img of [...inflight]) {
            if (img.isConnected === false) done(img);
        }
    }

    function start(img) {
        const src = img.getAttribute?.('data-src');
        if (!src || img.getAttribute?.('src')) return false;
        active++;
        inflight.add(img);
        img.addEventListener('load', () => done(img), { once: true });
        img.addEventListener('error', () => done(img), { once: true });
        img.setAttribute('src', src);
        img.removeAttribute('data-src');
        return true;
    }

    function pump() {
        reap();
        while (active < max && pending.length) {
            const img = pending.shift();
            if (!img || img.isConnected === false) continue;
            start(img);
        }
    }

    return {
        enqueue(img) {
            if (!img) return;
            pending.push(img);
            pump();
        },
        clear() {
            pending.length = 0;
            for (const img of [...inflight]) {
                inflight.delete(img);
                if (active > 0) active--;
            }
        },
        stats() {
            return { active, pending: pending.length, concurrency: max };
        },
    };
}
