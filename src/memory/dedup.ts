/**
 * Deterministic dedup of memory entries by identity — helper the curator can
 * invoke from the CLI before or after a write. Mirrors hermes MemoryStore
 * behaviour (`list(dict.fromkeys(entries))`) but is decoupled from the
 * atomic-write path so callers opt in explicitly.
 *
 * We NEVER dedup silently in the pipeline: the intent is that the curator
 * runs this as a consolidation step (R14 supersession-in-place). Removing
 * entries without an operator seeing the diff would violate R7 for anything
 * the curator did not itself add.
 */

const DEFAULT_SEPARATOR = "\n\n";

export interface DedupOptions {
  separator?: string;
  /**
   * When true, only trims duplicates AFTER the first occurrence (preserves
   * ordering). When false, keeps the LAST occurrence — useful when new
   * entries should win over older stale ones. Default `true`.
   */
  keepFirst?: boolean;
}

export interface DedupResult {
  content: string;
  originalCount: number;
  finalCount: number;
  removedCount: number;
}

/**
 * Deduplicate entries in `content` by identity (exact trimmed match).
 *
 * Splits on `separator`, trims each entry, drops empties, keeps the first
 * (or last) occurrence of every unique entry, and rejoins with the same
 * separator. Returns the count of removed duplicates so the caller can log
 * the consolidation for R22 telemetry.
 */
export function dedupeEntries(content: string, options: DedupOptions = {}): DedupResult {
  const separator = options.separator ?? DEFAULT_SEPARATOR;
  const keepFirst = options.keepFirst ?? true;
  const raw = content.split(separator).map((entry) => entry.trim());
  const nonEmpty = raw.filter((entry) => entry.length > 0);

  const seen = new Set<string>();
  const kept: string[] = [];
  const iterator = keepFirst ? nonEmpty : [...nonEmpty].reverse();
  for (const entry of iterator) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    kept.push(entry);
  }
  const finalEntries = keepFirst ? kept : kept.reverse();

  return {
    content: finalEntries.join(separator),
    originalCount: nonEmpty.length,
    finalCount: finalEntries.length,
    removedCount: nonEmpty.length - finalEntries.length,
  };
}
