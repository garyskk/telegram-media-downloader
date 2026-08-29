// Select-all on Unclassified must cover tiles already in the grid
// (loaded pages), not the remaining unloaded total.

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const AI_PATH = join(HERE, '..', '..', 'src/web/public/js/maintenance-ai.js');
const HTML_PATH = join(HERE, '..', '..', 'src/web/public/index.html');
const EN_PATH = join(HERE, '..', '..', 'src/web/public/locales/en.json');

let loadedUnclassifiedFaceIds;

beforeAll(async () => {
    const src = readFileSync(AI_PATH, 'utf8');
    const match = src.match(/function _loadedUnclassifiedFaceIds\([\s\S]*?\n\}/);
    if (!match) throw new Error('Could not locate _loadedUnclassifiedFaceIds in maintenance-ai.js');
    const wrapped = `${match[0].replace('function _loadedUnclassifiedFaceIds', 'function loadedUnclassifiedFaceIds')}\nexport { loadedUnclassifiedFaceIds };`;
    const dataUrl = `data:text/javascript;base64,${Buffer.from(wrapped).toString('base64')}`;
    const mod = await import(dataUrl);
    loadedUnclassifiedFaceIds = mod.loadedUnclassifiedFaceIds;
});

function fakeGrid(ids) {
    const tiles = ids.map((id) => ({ dataset: { faceId: String(id) } }));
    return {
        querySelectorAll(sel) {
            if (sel !== '.ai-unclassified-tile') return [];
            return tiles;
        },
    };
}

describe('_loadedUnclassifiedFaceIds', () => {
    it('returns ids from tiles currently in the grid', () => {
        expect(loadedUnclassifiedFaceIds(fakeGrid([11, 22, 33]))).toEqual([11, 22, 33]);
    });

    it('skips invalid and zero ids', () => {
        expect(loadedUnclassifiedFaceIds(fakeGrid(['x', 0, -1, 7]))).toEqual([7]);
    });

    it('returns [] when the grid is missing or empty', () => {
        expect(loadedUnclassifiedFaceIds(null)).toEqual([]);
        expect(loadedUnclassifiedFaceIds(fakeGrid([]))).toEqual([]);
    });
});

describe('unclassified select-all wiring', () => {
    const aiSrc = readFileSync(AI_PATH, 'utf8');
    const html = readFileSync(HTML_PATH, 'utf8');
    const en = JSON.parse(readFileSync(EN_PATH, 'utf8'));

    it('has a Select all control that only targets loaded tiles', () => {
        expect(html).toMatch(/id="ai-unclassified-sel-all-btn"/);
        expect(aiSrc).toMatch(/_selectAllLoadedUnclassifiedFaces/);
        expect(aiSrc).toMatch(/_loadedUnclassifiedFaceIds\(\$\('#ai-unclassified-grid'\)\)/);
        expect(aiSrc).not.toMatch(/\/api\/ai\/faces\/unclassified\?limit=200/);
    });

    it('labels Select all as loaded faces, not the full unclassified total', () => {
        expect(en['maintenance.ai.unclassified.sel_all']).toBe('Select all');
        expect(en['maintenance.ai.unclassified.sel_all_title']).toMatch(/loaded/i);
    });
});
