/**
 * Storage-backed authentication state for Baileys
 *
 * Uses PluginStorage (key-value interface) instead of file-based storage.
 * Keys are namespaced per instance to support multi-device.
 */

import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "baileys";
import { baileys } from "../baileys-loader.js";
import { type PluginStorage, createLogger } from "./foundation.js";

const log = createLogger("whatsapp:auth");

/**
 * Serialize auth data with Baileys' own `BufferJSON` replacer, exactly like
 * `useMultiFileAuthState`: Buffers and Uint8Arrays become `{ type: 'Buffer', data: <base64> }`.
 */
function serialize(data: unknown): string {
  return JSON.stringify(data, baileys().BufferJSON.replacer);
}

/**
 * Deserialize with Baileys' `BufferJSON` reviver. It also accepts the legacy
 * `{ type: 'Buffer', data: number[] }` form via its numeric-key fallback.
 */
function deserialize<T>(json: string): T {
  return JSON.parse(json, baileys().BufferJSON.reviver) as T;
}

type SignalDataType = keyof SignalDataTypeMap;

/**
 * Rebuild protobuf-backed signal values, as Baileys' `useMultiFileAuthState` does.
 * (The ported code disabled this because `proto` was unavailable under tsx; ravi always has it.)
 */
function deserializeSignalData<T extends SignalDataType>(type: T, data: unknown): SignalDataTypeMap[T] {
  if (type === "app-state-sync-key" && data && typeof data === "object") {
    return baileys().proto.Message.AppStateSyncKeyData.fromObject(
      data as Record<string, unknown>,
    ) as unknown as SignalDataTypeMap[T];
  }
  return data as SignalDataTypeMap[T];
}

/** Backoff of the write-behind retry: base delay doubling to the cap, with ±20% jitter. */
export interface AuthWriteRetryOptions {
  /** First retry delay (default 250 ms). */
  baseDelayMs?: number;
  /** Delay cap (default 30 s). */
  maxDelayMs?: number;
  /** Timer seam (tests). Default `setTimeout` (unref'd). */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Async sleep used by `flush()` between attempts. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1). Default `Math.random`. */
  random?: () => number;
}

export interface CreateStorageAuthStateOptions {
  retry?: AuthWriteRetryOptions;
}

/** What `createStorageAuthState` returns besides the Baileys auth state. */
export interface StorageAuthStateHandle {
  state: AuthenticationState;
  /** Persist the creds now (through the same ordered write queue as the signal keys). */
  saveCreds: () => Promise<void>;
  /**
   * Wait until every dirty key is written. Retries with backoff while the store fails;
   * resolves false when `timeoutMs` elapsed first (the keys stay dirty and keep retrying).
   */
  flush: (options?: { timeoutMs?: number }) => Promise<boolean>;
  /** Drop every pending write and stop writing (the auth state is about to be cleared). */
  discard: () => Promise<void>;
  /** Number of keys not persisted yet. */
  pendingWrites: () => number;
}

const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 30_000;

const defaultSetTimer = (callback: () => void, ms: number): unknown => {
  const timer = setTimeout(callback, ms);
  (timer as { unref?: () => void }).unref?.();
  return timer;
};
const defaultClearTimer = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface DirtyEntry {
  /** Serialized value, or null to delete. */
  readonly value: string | null;
}

/**
 * Ordered write-behind queue over a `PluginStorage`.
 *
 * - `enqueue()` records the newest value per key (a newer value replaces the queued one)
 *   and schedules a write; it never waits for storage.
 * - One write runs at a time and covers every dirty key: ONE `writeMany` transaction when
 *   the store has it, else key by key in order.
 * - A key leaves the dirty set only once the exact value queued for it was written. A
 *   failed write leaves its keys dirty and is retried with jittered exponential backoff.
 */
function createAuthWriteQueue(storage: PluginStorage, instanceId: string, options: AuthWriteRetryOptions = {}) {
  const baseDelay = Math.max(1, options.baseDelayMs ?? DEFAULT_RETRY_BASE_MS);
  const maxDelay = Math.max(baseDelay, options.maxDelayMs ?? DEFAULT_RETRY_MAX_MS);
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  const dirty = new Map<string, DirtyEntry>();
  let writing: Promise<boolean> | null = null;
  let retryTimer: unknown = null;
  let scheduled = false;
  let failures = 0;
  let discarded = false;

  const nextDelay = () => {
    const raw = Math.min(baseDelay * 2 ** Math.max(0, failures - 1), maxDelay);
    return Math.max(1, Math.round(raw * (0.8 + random() * 0.4)));
  };

  async function writeSnapshot(snapshot: Array<[string, DirtyEntry]>): Promise<void> {
    const markClean = (key: string, entry: DirtyEntry) => {
      if (dirty.get(key) === entry) dirty.delete(key);
    };
    if (storage.writeMany) {
      await storage.writeMany(snapshot.map(([key, entry]) => ({ key, value: entry.value })));
      for (const [key, entry] of snapshot) markClean(key, entry);
      return;
    }
    for (const [key, entry] of snapshot) {
      if (entry.value === null) await storage.delete(key);
      else await storage.set(key, entry.value);
      markClean(key, entry);
    }
  }

  function clearRetry(): void {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  /** Arm the backoff retry (once) for the keys still dirty. */
  function armRetry(): void {
    if (discarded || retryTimer !== null || dirty.size === 0) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      void loop();
    }, nextDelay());
  }

  /** One write attempt over every dirty key. Resolves true on success. */
  function attempt(): Promise<boolean> {
    if (writing) return writing;
    if (dirty.size === 0 || discarded) return Promise.resolve(true);
    const snapshot = [...dirty.entries()];
    const run = writeSnapshot(snapshot).then(
      () => {
        failures = 0;
        if (dirty.size === 0) clearRetry();
        return true;
      },
      (error: unknown) => {
        failures++;
        log.error("Auth state write failed; keys stay dirty and are retried", {
          instanceId,
          keys: snapshot.length,
          failures,
          err: String(error),
        });
        return false;
      },
    );
    writing = run.finally(() => {
      writing = null;
    });
    return writing;
  }

  function schedule(): void {
    if (discarded || scheduled || retryTimer !== null) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void loop();
    });
  }

  async function loop(): Promise<void> {
    if (writing) await writing;
    // A failed write armed the backoff timer meanwhile: that timer runs the next attempt.
    if (discarded || dirty.size === 0 || retryTimer !== null) return;
    const ok = await attempt();
    if (discarded || dirty.size === 0) return;
    if (ok) {
      schedule();
      return;
    }
    armRetry();
  }

  return {
    enqueue(writes: Array<[string, string | null]>): void {
      if (discarded) return;
      for (const [key, value] of writes) dirty.set(key, { value });
      schedule();
    },
    has(key: string): boolean {
      return dirty.has(key);
    },
    size(): number {
      return dirty.size;
    },
    /** Write now (after any in-flight write); resolves once `key` is clean or the attempt failed. */
    async writeNow(key: string): Promise<boolean> {
      while (true) {
        if (writing) await writing;
        if (!dirty.has(key) || discarded) return true;
        if (!(await attempt())) {
          armRetry();
          return false;
        }
      }
    },
    async flush(timeoutMs?: number): Promise<boolean> {
      const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
      while (!discarded && (dirty.size > 0 || writing)) {
        if (writing) {
          await writing;
          continue;
        }
        clearRetry();
        if (await attempt()) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          armRetry();
          return false;
        }
        await sleep(Math.min(nextDelay(), remaining));
      }
      return dirty.size === 0;
    },
    async discard(): Promise<void> {
      discarded = true;
      dirty.clear();
      clearRetry();
      if (writing) await writing;
    },
  };
}

/**
 * Create storage-backed authentication state for Baileys
 *
 * Uses PluginStorage key-value interface to persist auth state.
 * Keys are namespaced per instance:
 * - `auth:${instanceId}:creds` - Authentication credentials
 * - `auth:${instanceId}:keys:${type}:${id}` - Signal protocol keys
 *
 * @param storage - PluginStorage instance (auth-store.ts: SQLite `auth.db`)
 * @param instanceId - Instance identifier for namespacing
 * @returns Authentication state, saveCreds, and the write queue controls (`flush`, `discard`)
 *
 * @example
 * const { state, saveCreds, flush } = await createStorageAuthState(storage, instanceId);
 * const sock = makeWASocket({ auth: state });
 * sock.ev.on('creds.update', saveCreds);
 * // on shutdown: await flush({ timeoutMs: 10_000 });
 */
export async function createStorageAuthState(
  storage: PluginStorage,
  instanceId: string,
  options: CreateStorageAuthStateOptions = {},
): Promise<StorageAuthStateHandle> {
  const credsKey = `auth:${instanceId}:creds`;
  const keyPrefix = `auth:${instanceId}:keys`;

  // Load existing credentials or create new ones
  let creds: AuthenticationCreds;
  const existingCreds = await storage.get<AuthenticationCreds | string>(credsKey);

  if (existingCreds) {
    // Handle both cases: raw object (from storage.get parsing) or JSON string (legacy)
    if (typeof existingCreds === "string") {
      creds = deserialize<AuthenticationCreds>(existingCreds);
    } else {
      // Storage already parsed it, but we need to reconstruct Buffers
      creds = deserialize<AuthenticationCreds>(JSON.stringify(existingCreds));
    }
    log.info("Restored credentials", { instanceId, registered: creds.registered });
  } else {
    creds = baileys().initAuthCreds();
    log.info("Created new credentials", { instanceId });
  }

  // Write-behind cache for signal keys (omni#70).
  //
  // Baileys' commitWithRetry awaits keys.set() while holding the meId transaction
  // mutex, so a slow or locked store would freeze ALL message processing.
  // keys.set() therefore updates an in-memory cache and returns immediately; the
  // ordered write queue persists the batch in the background (one transaction per
  // write when the store supports it). A failed write keeps its keys dirty and
  // retries with backoff, and dirty keys are never evicted from the cache, so
  // nothing Baileys wrote is lost while the store is unavailable. keys.get() reads
  // the cache first and falls through to the store for misses.
  const keyCache = new Map<string, unknown>();
  const queue = createAuthWriteQueue(storage, instanceId, options.retry);
  const configuredKeyCacheLimit = Number.parseInt(process.env.WHATSAPP_AUTH_KEY_CACHE_MAX_ENTRIES ?? "50000", 10);
  const keyCacheMaxEntries =
    Number.isFinite(configuredKeyCacheLimit) && configuredKeyCacheLimit > 0 ? configuredKeyCacheLimit : 50_000;
  // Sentinel to distinguish "cached null/deleted" from "not in cache"
  const DELETED = Symbol("deleted");

  /** Set cache entry with bounded size to avoid unbounded long-lived growth */
  function setCachedValue(key: string, value: unknown): void {
    // Refresh insertion order so oldest entries can be evicted first.
    if (keyCache.has(key)) keyCache.delete(key);
    keyCache.set(key, value);

    let scanned = 0;
    while (keyCache.size > keyCacheMaxEntries) {
      const oldestKey = keyCache.keys().next().value;
      if (oldestKey === undefined) break;

      // Dirty keys (not persisted yet) stay cached until their write succeeded.
      if (queue.has(oldestKey)) {
        const oldestValue = keyCache.get(oldestKey);
        keyCache.delete(oldestKey);
        keyCache.set(oldestKey, oldestValue);
        scanned++;
        if (scanned >= keyCache.size) break;
        continue;
      }

      keyCache.delete(oldestKey);
      scanned = 0;
    }
  }

  /** Parse a raw storage value into a usable object, reconstructing Buffers */
  function parseStorageValue(value: unknown): unknown {
    if (typeof value === "string") return deserialize<unknown>(value);
    return deserialize<unknown>(JSON.stringify(value, baileys().BufferJSON.replacer));
  }

  /**
   * Returns true if this sender key should be blocked (phone-JID LID-first enforcement).
   * Blocks phone-based sender keys when LID-based ones exist to prevent group decrypt failures.
   */
  function isBlockedPhoneSenderKey(type: string, id: string, value: unknown, botPhone: string | undefined): boolean {
    if (type !== "sender-key" || !botPhone || value == null) return false;
    const parts = id.split("::");
    return parts.length >= 2 && parts[1] === botPhone;
  }

  /**
   * Process a single signal key entry: check the block rule and return the write to
   * queue plus the value to cache (cached only after the write is queued, so the new
   * entry is already dirty and protected from eviction).
   */
  function processSignalKeyEntry(
    type: string,
    id: string,
    value: unknown,
    botPhone: string | undefined,
  ): { key: string; stored: string | null; cached: unknown } {
    const key = `${keyPrefix}:${type}:${id}`;
    if (isBlockedPhoneSenderKey(type, id, value, botPhone)) {
      const parts = id.split("::");
      log.warn("Blocked phone-JID sender key (LID-first enforced)", {
        instanceId,
        group: parts[0]?.slice(-20),
        participant: parts[1]?.replace(/\d(?=\d{4})/g, "*"),
      });
      // Tombstone cache + delete from storage so stale pre-auth keys are purged
      return { key, stored: null, cached: DELETED };
    }
    const present = value !== null && value !== undefined;
    return { key, stored: present ? serialize(value) : null, cached: present ? value : DELETED };
  }

  return {
    state: {
      creds,
      keys: {
        get: async <T extends SignalDataType>(
          type: T,
          ids: string[],
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};

          for (const id of ids) {
            const key = `${keyPrefix}:${type}:${id}`;

            // Check write-behind cache first (#70)
            const cached = keyCache.get(key);
            if (cached === DELETED) continue;
            if (cached !== undefined) {
              data[id] = deserializeSignalData(type, cached);
              continue;
            }

            // Cache miss — read from storage
            const value = await storage.get<unknown>(key);
            if (value !== null && value !== undefined) {
              const parsed = parseStorageValue(value);
              setCachedValue(key, parsed);
              data[id] = deserializeSignalData(type, parsed);
            }
          }

          return data;
        },

        // One queued batch per keys.set; the queue writes it in one transaction, in order.
        set: async (
          data: {
            [T in SignalDataType]?: {
              [id: string]: SignalDataTypeMap[T] | null;
            };
          },
        ): Promise<void> => {
          // LID-first guardrail: extract bot's phone number to block phone-JID
          // sender keys. When both phone and LID sender keys exist for the same
          // group, recipients can't decrypt — messages are silently dropped.
          // Only LID-based sender keys must be stored.
          const botPhone = creds.me?.id?.split(":")[0]?.split("@")[0];
          const entries: Array<{ key: string; stored: string | null; cached: unknown }> = [];

          for (const [type, typeEntries] of Object.entries(data)) {
            if (!typeEntries) continue;
            for (const [id, value] of Object.entries(typeEntries)) {
              entries.push(processSignalKeyEntry(type, id, value, botPhone));
            }
          }
          if (entries.length === 0) return;
          queue.enqueue(entries.map((entry): [string, string | null] => [entry.key, entry.stored]));
          for (const entry of entries) setCachedValue(entry.key, entry.cached);
        },
      },
    },

    saveCreds: async () => {
      queue.enqueue([[credsKey, serialize(creds)]]);
      if (!(await queue.writeNow(credsKey))) {
        throw new Error("WhatsApp creds could not be written yet; they stay queued and are retried");
      }
    },
    flush: (flushOptions = {}) => queue.flush(flushOptions.timeoutMs),
    discard: () => queue.discard(),
    pendingWrites: () => queue.size(),
  };
}

/**
 * Clear sender keys for an instance — forces fresh key generation + redistribution.
 *
 * Use this to recover from sender key desync caused by previous hung sessions
 * where the DB persist never completed. After clearing, the next group send
 * will generate new sender keys and distribute them to all participants.
 *
 * Note: This only clears persisted keys in storage, not the in-memory keyCache.
 * Intended for use as a recovery tool between sessions, not during an active connection.
 *
 * @param storage - PluginStorage instance
 * @param instanceId - Instance identifier
 * @returns Number of keys deleted
 */
export async function clearSenderKeys(storage: PluginStorage, instanceId: string): Promise<number> {
  const keyPrefix = `auth:${instanceId}:keys`;
  const allKeys = await storage.keys(`${keyPrefix}:sender-key*`);
  const batchSize = 50;

  let deleted = 0;
  for (let i = 0; i < allKeys.length; i += batchSize) {
    const batch = allKeys.slice(i, i + batchSize);
    await Promise.all(batch.map((key) => storage.delete(key)));
    deleted += batch.length;
  }

  log.info("Cleared sender keys", { instanceId, deleted });
  return deleted;
}

/**
 * Clear all authentication data for an instance
 *
 * @param storage - PluginStorage instance
 * @param instanceId - Instance identifier
 */
export async function clearAuthState(storage: PluginStorage, instanceId: string): Promise<void> {
  const credsKey = `auth:${instanceId}:creds`;
  const keyPrefix = `auth:${instanceId}:keys`;

  // Delete credentials
  await storage.delete(credsKey);

  // Delete all keys matching the prefix
  const keys = await storage.keys(`${keyPrefix}:*`);
  const batchSize = 50;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    await Promise.all(batch.map((key) => storage.delete(key)));
  }
}
