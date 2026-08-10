// Pure shuffle-order helpers from viewer.js (no DOM).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = join(HERE, '..', 'src/web/public/js/viewer.js');

let buildShuffleOrder;
let playlistKey;

beforeAll(async () => {
    const src = readFileSync(VIEWER_PATH, 'utf8');
    const keyFn = src.match(/function _playlistKey\(entry\) \{[\s\S]*?\n\}/);
    const orderFn = src.match(/function _buildShuffleOrder\(keys, currentKey\) \{[\s\S]*?\n\}/);
    const fyFn = src.match(/function _fisherYates\(arr\) \{[\s\S]*?\n\}/);
    if (!keyFn || !orderFn || !fyFn) {
        throw new Error('Could not locate shuffle helpers in viewer.js');
    }
    const wrapped = `${fyFn[0]}\n${keyFn[0]}\n${orderFn[0]}\nexport { _buildShuffleOrder, _playlistKey };`;
    const dataUrl = `data:text/javascript;base64,${Buffer.from(wrapped).toString('base64')}`;
    const mod = await import(dataUrl);
    buildShuffleOrder = mod._buildShuffleOrder;
    playlistKey = mod._playlistKey;
});

describe('viewer shuffle helpers', () => {
    it('_playlistKey normalizes numbers and peer objects', () => {
        expect(playlistKey(42)).toBe('self:42');
        expect(playlistKey({ id: 7, peer_id: 'self' })).toBe('self:7');
        expect(playlistKey({ id: 7, peer_id: 'peer-a' })).toBe('peer-a:7');
        expect(playlistKey(null)).toBe('');
    });

    it('_buildShuffleOrder puts current first and keeps every id exactly once', () => {
        const keys = ['self:1', 'self:2', 'self:3', 'self:4', 'self:5'];
        const ordered = buildShuffleOrder(keys, 'self:3');
        expect(ordered).toHaveLength(5);
        expect(ordered[0]).toBe('self:3');
        expect(new Set(ordered).size).toBe(5);
        expect(ordered.sort()).toEqual(keys.slice().sort());
    });

    it('_buildShuffleOrder with missing current still returns a permutation', () => {
        const keys = ['self:1', 'self:2', 'self:3'];
        const ordered = buildShuffleOrder(keys, 'self:999');
        expect(ordered).toHaveLength(3);
        expect(new Set(ordered).size).toBe(3);
    });
});
