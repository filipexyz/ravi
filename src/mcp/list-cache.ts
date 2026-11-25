/**
 * The response cache of one registered server (spec mcp, Gateway: catalog
 * freshness). The SDK client keeps cacheable results (`tools/list` among them)
 * in a `ResponseCacheStore` and serves a held entry while the `ttlMs` the
 * server sent with it holds. A client lives only as long as its connection,
 * so the gateway keeps one store per row and registration instead and hands
 * it to every client of that row: a refresh within the server's `ttlMs` (an
 * attachment change, for example) is then served without a round trip.
 *
 * One store never serves two rows, even rows that point at the same server:
 * a server reports its own identity, so a shared store would let one row's
 * server answer for another's. A changed registration (URL, command,
 * protocol, credential revision) gets a new, empty store.
 *
 * The store also records when the `tools/list` entry it holds stops being
 * fresh and whether the last listing wrote it (a fetch) or only read it (a
 * hit), which the gateway stores with the catalog.
 */

import {
  type CacheEntry,
  type CacheKey,
  type CacheScope,
  InMemoryResponseCacheStore,
  type ResponseCacheStore,
} from "@modelcontextprotocol/client";

const TOOLS_LIST = "tools/list";

export class McpServerListCache implements ResponseCacheStore {
  /** The registration this store belongs to; another registration gets a new store. */
  readonly registration: string;
  private readonly inner = new InMemoryResponseCacheStore();
  private toolsListWrites = 0;
  private toolsListExpiresAt: number | null = null;

  constructor(registration: string) {
    this.registration = registration;
  }

  /** How many times a `tools/list` result was written (each write is a fetch). */
  get toolsListWriteCount(): number {
    return this.toolsListWrites;
  }

  /** When the held `tools/list` entry stops being fresh, as the client computed it; null when none is held. */
  get toolsListFreshUntil(): number | null {
    return this.toolsListExpiresAt;
  }

  get(key: CacheKey): CacheEntry | undefined {
    const entry = this.inner.get(key);
    if (entry && key.method === TOOLS_LIST && typeof entry.expiresAt === "number") {
      this.toolsListExpiresAt = entry.expiresAt;
    }
    return entry;
  }

  set(key: CacheKey, entry: { value: string; expiresAt?: number; scope?: CacheScope }): number {
    if (key.method === TOOLS_LIST) {
      this.toolsListWrites += 1;
      this.toolsListExpiresAt = typeof entry.expiresAt === "number" ? entry.expiresAt : null;
    }
    return this.inner.set(key, entry);
  }

  delete(key: CacheKey): void {
    if (key.method === TOOLS_LIST) this.toolsListExpiresAt = null;
    this.inner.delete(key);
  }

  evict(method: string): void {
    if (method === TOOLS_LIST) this.toolsListExpiresAt = null;
    this.inner.evict(method);
  }

  clear(): void {
    this.toolsListExpiresAt = null;
    this.inner.clear();
  }
}

/** The `ttlMs` a cacheable result carries, or null when the server sent none (legacy era). */
export function mcpResultTtlMs(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const ttl = (result as { ttlMs?: unknown }).ttlMs;
  return typeof ttl === "number" && Number.isFinite(ttl) && ttl >= 0 ? ttl : null;
}
