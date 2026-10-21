// Pure shuffle paging. The deck is shuffled once; each page takes the next
// slice, so a later page never repeats an earlier one.

export function shuffleIds(list, random = Math.random) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
}

// takeBatch returns the next `limit` keys starting at `cursor`. hasMore is
// false once the cursor reaches the end of the deck.
export function takeBatch(keys, cursor, limit) {
    const start = Math.max(0, cursor | 0);
    const size = Math.max(0, limit | 0);
    const end = Math.min(keys.length, start + size);
    return {
        batch: keys.slice(start, end),
        cursor: end,
        hasMore: end < keys.length,
    };
}
