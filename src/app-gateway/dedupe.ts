/**
 * Seen-`requestId` set for the Pages app gateway executor.
 *
 * In memory per runner process. Each id is kept for at least 120 s; the set
 * holds at most 10000 ids. When it is full, new invokes are refused
 * (`app_gateway_rate_limited`) instead of evicting unexpired ids, so a replay
 * can never slip in by flooding the set.
 */

import { REQUEST_ID_MAX_ENTRIES, REQUEST_ID_RETENTION_MS } from "./constants.js";

export type RequestIdAdmission = "admitted" | "replayed" | "full";

export class RequestIdDedupe {
  private readonly seen = new Map<string, number>();
  private readonly retentionMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { retentionMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.retentionMs = options.retentionMs ?? REQUEST_ID_RETENTION_MS;
    this.maxEntries = options.maxEntries ?? REQUEST_ID_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  admit(requestId: string): RequestIdAdmission {
    const now = this.now();
    this.prune(now);
    if (this.seen.has(requestId)) return "replayed";
    if (this.seen.size >= this.maxEntries) return "full";
    this.seen.set(requestId, now);
    return "admitted";
  }

  get size(): number {
    return this.seen.size;
  }

  /** Insertion order is time order, so expired ids are always at the front. */
  private prune(now: number): void {
    for (const [requestId, seenAt] of this.seen) {
      if (now - seenAt < this.retentionMs) return;
      this.seen.delete(requestId);
    }
  }
}
