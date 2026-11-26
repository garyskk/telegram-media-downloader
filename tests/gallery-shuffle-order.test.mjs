import assert from 'node:assert/strict';
import test from 'node:test';

import { shuffleIds, takeBatch } from '../core-service/internal/webassets/public/js/gallery-shuffle-order.js';

test('takeBatch pages through a deck without repeating ids', () => {
    const keys = [1, 2, 3, 4, 5];
    const first = takeBatch(keys, 0, 2);
    assert.deepEqual(first.batch, [1, 2]);
    assert.equal(first.cursor, 2);
    assert.equal(first.hasMore, true);

    const second = takeBatch(keys, first.cursor, 2);
    assert.deepEqual(second.batch, [3, 4]);
    assert.equal(second.hasMore, true);

    const last = takeBatch(keys, second.cursor, 2);
    assert.deepEqual(last.batch, [5]);
    assert.equal(last.cursor, 5);
    assert.equal(last.hasMore, false);

    const seen = [...first.batch, ...second.batch, ...last.batch];
    assert.deepEqual(seen, keys);
});

test('a shuffled deck paged in batches is a partition of the original ids', () => {
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    const deck = shuffleIds(ids, () => 0.5);
    assert.deepEqual([...deck].sort((a, b) => a - b), ids);
    assert.notDeepEqual(deck, ids);

    const seen = [];
    let cursor = 0;
    let hasMore = true;
    while (hasMore) {
        const page = takeBatch(deck, cursor, 10);
        for (const id of page.batch) {
            assert.equal(seen.includes(id), false);
            seen.push(id);
        }
        cursor = page.cursor;
        hasMore = page.hasMore;
    }
    assert.deepEqual(seen, deck);
});

test('shuffleIds does not mutate its input', () => {
    const src = [1, 2, 3, 4];
    shuffleIds(src, () => 0);
    assert.deepEqual(src, [1, 2, 3, 4]);
});
