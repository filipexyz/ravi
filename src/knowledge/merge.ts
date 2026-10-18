// Reciprocal rank fusion of the Console and local result lists (contract §10.5).

export const RRF_K = 60;

/**
 * Merges ranked lists: each item scores `1 / (k + rank)` per list it appears
 * in (rank from 1), so an item in both lists outranks single-list items of
 * the same rank. Items with the same `textHash` are one item (the first seen
 * keeps its fields). Ties keep list order. Cut to `limit`.
 */
export function mergeRrf<T extends { ref: string; textHash: string }>(
  lists: ReadonlyArray<ReadonlyArray<T>>,
  limit: number,
  k: number = RRF_K,
): T[] {
  const entries = new Map<string, { item: T; score: number; order: number }>();
  let order = 0;
  for (const list of lists) {
    const seenInList = new Set<string>();
    list.forEach((item, index) => {
      const key = item.textHash || item.ref;
      if (seenInList.has(key)) return;
      seenInList.add(key);
      const contribution = 1 / (k + index + 1);
      const existing = entries.get(key);
      if (existing) {
        existing.score += contribution;
      } else {
        entries.set(key, { item, score: contribution, order: order++ });
      }
    });
  }
  return [...entries.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.item);
}
