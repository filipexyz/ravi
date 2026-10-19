/**
 * Trigger debounce: collect a burst of events and fire once, `debounceMs` after
 * the last one, with every event in the burst. Nothing is dropped for being
 * close to another event (unlike cooldown); a constant stream still fires at
 * most `DEBOUNCE_MAX_WAIT_FACTOR × debounceMs` after the burst's first event.
 */

export interface DebouncedEvent {
  topic: string;
  data: unknown;
}

export interface TriggerBatch {
  /** Trigger id, or the per-session key of a named-session trigger. */
  key: string;
  triggerId: string;
  /** Oldest first; the last one is the event the trigger fires with. */
  events: DebouncedEvent[];
  /** Events dropped from the front because the burst exceeded DEBOUNCE_MAX_EVENTS. */
  omitted: number;
  firstAt: number;
}

export const DEBOUNCE_MAX_WAIT_FACTOR = 10;
export const DEBOUNCE_MAX_EVENTS = 200;

export interface DebounceClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: DebounceClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Bucket extends TriggerBatch {
  debounceMs: number;
  timer: unknown;
}

export class TriggerDebouncer {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly onFlush: (batch: TriggerBatch) => void,
    private readonly clock: DebounceClock = systemClock,
  ) {}

  /** Add an event to the burst for `key`, restarting its quiet window. */
  add(key: string, triggerId: string, debounceMs: number, event: DebouncedEvent): void {
    const now = this.clock.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { key, triggerId, events: [], omitted: 0, firstAt: now, debounceMs, timer: null };
      this.buckets.set(key, bucket);
    }
    bucket.debounceMs = debounceMs;
    bucket.events.push(event);
    if (bucket.events.length > DEBOUNCE_MAX_EVENTS) {
      bucket.events.shift();
      bucket.omitted++;
    }
    const deadline = Math.min(now + debounceMs, bucket.firstAt + debounceMs * DEBOUNCE_MAX_WAIT_FACTOR);
    this.schedule(bucket, Math.max(0, deadline - now));
  }

  /**
   * Put a batch back to fire after `delayMs` (e.g. its trigger is cooling down).
   * Events that arrived meanwhile for the same key join it, after the held ones.
   */
  requeue(batch: TriggerBatch, delayMs: number): void {
    const existing = this.buckets.get(batch.key);
    const bucket: Bucket = existing
      ? {
          ...existing,
          events: [...batch.events, ...existing.events],
          omitted: batch.omitted + existing.omitted,
          firstAt: Math.min(batch.firstAt, existing.firstAt),
        }
      : { ...batch, debounceMs: 0, timer: null };
    while (bucket.events.length > DEBOUNCE_MAX_EVENTS) {
      bucket.events.shift();
      bucket.omitted++;
    }
    if (existing) this.clock.clearTimeout(existing.timer);
    this.buckets.set(batch.key, bucket);
    this.schedule(bucket, Math.max(0, delayMs));
  }

  /** Drop every pending burst (runner stop). Returns how many events were pending. */
  clear(): number {
    let pending = 0;
    for (const bucket of this.buckets.values()) {
      this.clock.clearTimeout(bucket.timer);
      pending += bucket.events.length;
    }
    this.buckets.clear();
    return pending;
  }

  get pendingKeys(): number {
    return this.buckets.size;
  }

  private schedule(bucket: Bucket, delayMs: number): void {
    if (bucket.timer !== null) this.clock.clearTimeout(bucket.timer);
    bucket.timer = this.clock.setTimeout(() => this.flush(bucket.key), delayMs);
  }

  private flush(key: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    this.buckets.delete(key);
    const { key: k, triggerId, events, omitted, firstAt } = bucket;
    this.onFlush({ key: k, triggerId, events, omitted, firstAt });
  }
}

/**
 * `off`, `none`, `0` and `0s` disable cooldown/debounce; anything else must be
 * a positive duration (`30s`, `5m`, …) parsed by `parseDuration`.
 */
export function parseOptionalDurationMs(value: string, parseDuration: (value: string) => number): number {
  const normalized = value.trim().toLowerCase();
  if (["off", "none", "0", "0s", "0m", "0h", "0d"].includes(normalized)) return 0;
  return parseDuration(normalized);
}
