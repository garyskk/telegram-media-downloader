// Pure-logic test for the video buffering-spinner gate in viewer.js.
// Mirrors tests/viewer-classifier.test.js: carve the helper out of the
// source so we don't need jsdom for the rest of the SPA module.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = join(HERE, '..', 'src/web/public/js/viewer.js');

let shouldShowVideoSpinner;

beforeAll(async () => {
    const src = readFileSync(VIEWER_PATH, 'utf8');
    const match = src.match(/function shouldShowVideoSpinner\([\s\S]*?\n\}/);
    if (!match) throw new Error('Could not locate shouldShowVideoSpinner in viewer.js');
    const wrapped = `${match[0]}\nexport { shouldShowVideoSpinner };`;
    const dataUrl = `data:text/javascript;base64,${Buffer.from(wrapped).toString('base64')}`;
    const mod = await import(dataUrl);
    shouldShowVideoSpinner = mod.shouldShowVideoSpinner;
});

// HTMLMediaElement readyState constants
const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
const HAVE_ENOUGH_DATA = 4;

const playing = (over = {}) => ({
    readyState: HAVE_ENOUGH_DATA,
    paused: false,
    seeking: false,
    waiting: false,
    ...over,
});

describe('shouldShowVideoSpinner', () => {
    it('shows during cold start before any decoded frame', () => {
        expect(shouldShowVideoSpinner({ readyState: HAVE_NOTHING, paused: true, seeking: false })).toBe(
            true,
        );
        expect(shouldShowVideoSpinner({ readyState: HAVE_METADATA, paused: true, seeking: false })).toBe(
            true,
        );
    });

    it('hides when paused with a current frame (center-play UX)', () => {
        expect(
            shouldShowVideoSpinner({ readyState: HAVE_CURRENT_DATA, paused: true, seeking: false }),
        ).toBe(false);
        expect(
            shouldShowVideoSpinner({ readyState: HAVE_ENOUGH_DATA, paused: true, seeking: false }),
        ).toBe(false);
        // `waiting` while paused still yields to the centre-play button.
        expect(shouldShowVideoSpinner(playing({ paused: true, waiting: true }))).toBe(false);
    });

    it('hides while playing smoothly with buffered future data', () => {
        // Progressive download often pauses the network fetch after the
        // buffer fills — that fires `stalled`, but readyState stays high
        // and `waiting` does not fire. Spinner must stay off.
        expect(
            shouldShowVideoSpinner({ readyState: HAVE_FUTURE_DATA, paused: false, seeking: false }),
        ).toBe(false);
        expect(
            shouldShowVideoSpinner({ readyState: HAVE_ENOUGH_DATA, paused: false, seeking: false }),
        ).toBe(false);
        expect(shouldShowVideoSpinner(playing())).toBe(false);
    });

    it('shows when playback is starved for the next frame', () => {
        expect(
            shouldShowVideoSpinner({ readyState: HAVE_CURRENT_DATA, paused: false, seeking: false }),
        ).toBe(true);
        expect(shouldShowVideoSpinner({ readyState: HAVE_METADATA, paused: false, seeking: false })).toBe(
            true,
        );
    });

    it('shows on waiting even when readyState stays HAVE_ENOUGH_DATA', () => {
        // Chrome (and others) leave readyState at 4 while firing `waiting`.
        // There is no HTMLMediaElement.waiting property — the event is
        // the only signal. readyState-only gating hid the spinner for
        // every mid-playback stall after the initial load.
        expect(shouldShowVideoSpinner(playing({ waiting: true }))).toBe(true);
        expect(shouldShowVideoSpinner(playing({ readyState: HAVE_FUTURE_DATA, waiting: true }))).toBe(
            true,
        );
    });

    it('shows while seeking during playback regardless of readyState', () => {
        expect(shouldShowVideoSpinner(playing({ seeking: true }))).toBe(true);
        expect(
            shouldShowVideoSpinner(playing({ readyState: HAVE_CURRENT_DATA, seeking: true })),
        ).toBe(true);
    });

    it('hides while paused-scrubbing so the sprite preview stays unobstructed', () => {
        expect(shouldShowVideoSpinner(playing({ paused: true, seeking: true }))).toBe(false);
        expect(
            shouldShowVideoSpinner({
                readyState: HAVE_CURRENT_DATA,
                paused: true,
                seeking: true,
                waiting: false,
            }),
        ).toBe(false);
    });
});
