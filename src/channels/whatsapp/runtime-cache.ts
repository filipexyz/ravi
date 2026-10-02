/**
 * Bounded, clock-driven TTL cache used by `WhatsAppRuntime`.
 *
 * The ported plugin expired its per-instance caches with one `setTimeout` per entry. The
 * runtime instead stamps each entry with an expiry from the injected clock and
 * drops it lazily, so tests control time and no timers outlive the runtime.
 * Insertion order doubles as LRU order: `set` re-inserts, and the oldest entry
 * is evicted once `maxEntries` is exceeded.
 */

export interface TtlCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now: () => number;
}

export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(private readonly options: TtlCacheOptions) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.options.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.options.now() + this.options.ttlMs });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Live entry count (expired entries are pruned first). */
  get size(): number {
    const now = this.options.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    return this.entries.size;
  }
}
