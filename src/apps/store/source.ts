/**
 * Refresh and read the official source (spec apps/store, "Source").
 *
 * Every file is verified before it is cached, and verified again when it is
 * read back, so a write to the cache by anything other than this module does
 * not change what Ravi trusts. Serials never go down: a mirror or an attacker
 * cannot replay an older index that still lists a version blocked since.
 */

import { join } from "node:path";
import { appStoreRoot, readFileIfExists, writeFileAtomic } from "./paths.js";
import { OFFICIAL_APP_SOURCE, type AppStoreSourceConfig, verifyDetachedSignature } from "./trust.js";
import {
  APP_STORE_STATE_SCHEMA,
  type AppBlocklistFile,
  type AppIndexFile,
  type AppKeysFile,
  type AppStoreSourceState,
  AppStoreError,
  appBlocklistFileSchema,
  appIndexFileSchema,
  appKeysFileSchema,
  appStoreSourceStateSchema,
} from "./types.js";

export type AppStoreFetcher = (url: string, maxBytes: number) => Promise<Uint8Array>;

export interface AppStoreContext {
  env?: NodeJS.ProcessEnv;
  source?: AppStoreSourceConfig;
  fetcher?: AppStoreFetcher;
  now?: () => Date;
}

export interface VerifiedSource {
  source: AppStoreSourceConfig;
  keys: AppKeysFile;
  index: AppIndexFile;
  blocklist: AppBlocklistFile;
  state: AppStoreSourceState;
}

const SIGNED_FILE_MAX_BYTES = 4 * 1024 * 1024;
const SIGNATURE_MAX_BYTES = 1024;
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

type SignedKind = "keys" | "index" | "blocklist";
const FILE_NAMES: Record<SignedKind, string> = {
  keys: "keys.json",
  index: "index.json",
  blocklist: "blocklist.json",
};

export function resolveSource(ctx: AppStoreContext = {}): AppStoreSourceConfig {
  return ctx.source ?? OFFICIAL_APP_SOURCE;
}

export function sourceCacheDir(ctx: AppStoreContext = {}): string {
  return join(appStoreRoot(ctx.env), "sources", resolveSource(ctx).id);
}

/** Plain HTTPS GET: no redirects, no credentials, a size cap. */
export const defaultAppStoreFetcher: AppStoreFetcher = async (url, maxBytes) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new AppStoreError("APP_STORE_FETCH_FAILED", `Refusing to fetch ${url}: only HTTPS sources are allowed.`);
  }
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", headers: { accept: "application/json, text/plain" } });
  } catch (error) {
    throw new AppStoreError("APP_STORE_FETCH_FAILED", `Could not fetch ${url}.`, 1, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (response.status !== 200) {
    throw new AppStoreError("APP_STORE_FETCH_FAILED", `Fetching ${url} returned HTTP ${response.status}.`, 1, {
      status: response.status,
    });
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new AppStoreError("APP_STORE_FETCH_FAILED", `${url} is larger than ${maxBytes} bytes.`);
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > maxBytes) {
    throw new AppStoreError("APP_STORE_FETCH_FAILED", `${url} is larger than ${maxBytes} bytes.`);
  }
  return body;
};

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

export function readSourceState(ctx: AppStoreContext = {}): AppStoreSourceState {
  const raw = readFileIfExists(join(sourceCacheDir(ctx), "state.json"));
  if (!raw) return appStoreSourceStateSchema.parse({ schema: APP_STORE_STATE_SCHEMA });
  try {
    return appStoreSourceStateSchema.parse(JSON.parse(raw.toString("utf8")));
  } catch (error) {
    throw new AppStoreError("APP_STORE_STATE_INVALID", "The store's source state file is unreadable.", 1, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseSigned<T>(kind: SignedKind, bytes: Uint8Array, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch (error) {
    throw new AppStoreError("APP_STORE_SOURCE_INVALID", `${FILE_NAMES[kind]} does not match its schema.`, 1, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function checkSignature(kind: SignedKind, bytes: Uint8Array, signature: Uint8Array, keys: readonly string[]): void {
  if (keys.length === 0 || !verifyDetachedSignature(bytes, Buffer.from(signature).toString("utf8"), keys)) {
    throw new AppStoreError("APP_STORE_SIGNATURE_INVALID", `${FILE_NAMES[kind]} is not signed by a trusted key.`, 1, {
      file: FILE_NAMES[kind],
    });
  }
}

function checkExpiry(kind: SignedKind, expires: string, now: Date): void {
  if (Date.parse(expires) <= now.getTime()) {
    throw new AppStoreError(
      "APP_STORE_SOURCE_EXPIRED",
      `${FILE_NAMES[kind]} expired at ${expires}. The source must be re-signed before anything is installed or updated.`,
      1,
      { file: FILE_NAMES[kind], expires },
    );
  }
}

function checkSerial(
  kind: SignedKind,
  serial: number,
  stored: number,
  minSerial: number,
  bytes: Uint8Array,
  cached: Buffer | null,
): void {
  const floor = Math.max(stored, minSerial);
  if (serial < floor) {
    throw new AppStoreError(
      "APP_STORE_ROLLBACK",
      `${FILE_NAMES[kind]} has serial ${serial}, older than ${floor} already seen.`,
      1,
      { file: FILE_NAMES[kind], serial, seen: floor },
    );
  }
  if (serial === stored && cached && !cached.equals(Buffer.from(bytes))) {
    throw new AppStoreError("APP_STORE_ROLLBACK", `${FILE_NAMES[kind]} changed without a new serial (${serial}).`, 1, {
      file: FILE_NAMES[kind],
      serial,
    });
  }
}

/** Verify one already-fetched set of files against the source's roots and stored serials. */
function verifySet(
  source: AppStoreSourceConfig,
  files: Record<SignedKind, { bytes: Uint8Array; sig: Uint8Array }>,
  state: AppStoreSourceState,
  cached: Record<SignedKind, Buffer | null>,
  now: Date,
  options: { checkExpiry: boolean; checkSerials: boolean },
): { keys: AppKeysFile; index: AppIndexFile; blocklist: AppBlocklistFile } {
  checkSignature("keys", files.keys.bytes, files.keys.sig, source.rootKeys);
  const keys = parseSigned("keys", files.keys.bytes, (value) => appKeysFileSchema.parse(value));

  checkSignature("index", files.index.bytes, files.index.sig, keys.publish);
  const index = parseSigned("index", files.index.bytes, (value) => appIndexFileSchema.parse(value));
  if (index.source !== source.id) {
    throw new AppStoreError(
      "APP_STORE_SOURCE_INVALID",
      `index.json names source "${index.source}", expected "${source.id}".`,
    );
  }
  if (Date.parse(index.issuedAt) > now.getTime() + FUTURE_SKEW_MS) {
    throw new AppStoreError("APP_STORE_SOURCE_INVALID", `index.json is issued in the future (${index.issuedAt}).`);
  }
  for (const [id, entry] of Object.entries(index.apps)) {
    const seen = new Set<string>();
    for (const version of entry.versions) {
      if (seen.has(version.version)) {
        throw new AppStoreError("APP_STORE_SOURCE_INVALID", `index.json lists ${id}@${version.version} twice.`);
      }
      seen.add(version.version);
    }
  }

  const blockKeys = keys.block.length > 0 ? keys.block : keys.publish;
  checkSignature("blocklist", files.blocklist.bytes, files.blocklist.sig, blockKeys);
  const blocklist = parseSigned("blocklist", files.blocklist.bytes, (value) => appBlocklistFileSchema.parse(value));

  if (options.checkSerials) {
    checkSerial("keys", keys.serial, state.keysSerial, source.minSerial, files.keys.bytes, cached.keys);
    checkSerial("index", index.serial, state.indexSerial, source.minSerial, files.index.bytes, cached.index);
    checkSerial(
      "blocklist",
      blocklist.serial,
      state.blockSerial,
      source.minSerial,
      files.blocklist.bytes,
      cached.blocklist,
    );
  }
  if (options.checkExpiry) {
    checkExpiry("keys", keys.expires, now);
    checkExpiry("index", index.expires, now);
    checkExpiry("blocklist", blocklist.expires, now);
  }
  return { keys, index, blocklist };
}

function requireConfigured(source: AppStoreSourceConfig): void {
  if (source.rootKeys.length === 0) {
    throw new AppStoreError(
      "APP_STORE_SOURCE_UNCONFIGURED",
      `The ${source.id} app source has no root key in this Ravi release yet.`,
      1,
      { source: source.id },
    );
  }
}

/** Fetch, verify and cache the source. Returns what is now trusted. */
export async function refreshSource(ctx: AppStoreContext = {}): Promise<VerifiedSource & { changed: boolean }> {
  const source = resolveSource(ctx);
  requireConfigured(source);
  const fetcher = ctx.fetcher ?? defaultAppStoreFetcher;
  const now = (ctx.now ?? (() => new Date()))();
  const dir = sourceCacheDir(ctx);
  const state = readSourceState(ctx);

  const fetched = {} as Record<SignedKind, { bytes: Uint8Array; sig: Uint8Array }>;
  for (const kind of ["keys", "index", "blocklist"] as const) {
    const name = FILE_NAMES[kind];
    fetched[kind] = {
      bytes: await fetcher(`${source.baseUrl}${name}`, SIGNED_FILE_MAX_BYTES),
      sig: await fetcher(`${source.baseUrl}${name}.sig`, SIGNATURE_MAX_BYTES),
    };
  }
  const cached = {
    keys: readFileIfExists(join(dir, FILE_NAMES.keys)),
    index: readFileIfExists(join(dir, FILE_NAMES.index)),
    blocklist: readFileIfExists(join(dir, FILE_NAMES.blocklist)),
  };
  const verified = verifySet(source, fetched, state, cached, now, { checkExpiry: true, checkSerials: true });

  const changed =
    verified.keys.serial !== state.keysSerial ||
    verified.index.serial !== state.indexSerial ||
    verified.blocklist.serial !== state.blockSerial;
  for (const kind of ["keys", "index", "blocklist"] as const) {
    writeFileAtomic(join(dir, FILE_NAMES[kind]), fetched[kind].bytes);
    writeFileAtomic(join(dir, `${FILE_NAMES[kind]}.sig`), fetched[kind].sig);
  }
  const nextState = appStoreSourceStateSchema.parse({
    schema: APP_STORE_STATE_SCHEMA,
    keysSerial: verified.keys.serial,
    indexSerial: verified.index.serial,
    blockSerial: verified.blocklist.serial,
    refreshedAt: now.toISOString(),
  });
  writeFileAtomic(join(dir, "state.json"), `${JSON.stringify(nextState, null, 2)}\n`);
  return { source, ...verified, state: nextState, changed };
}

/**
 * The cached source, verified again. `null` when nothing was refreshed yet.
 * With `requireFresh`, an expired file fails (install and update need it);
 * without it, an expired cache still answers block checks.
 */
export function loadCachedSource(
  ctx: AppStoreContext = {},
  options: { requireFresh?: boolean } = {},
): VerifiedSource | null {
  const source = resolveSource(ctx);
  if (source.rootKeys.length === 0) return null;
  const dir = sourceCacheDir(ctx);
  const files = {} as Record<SignedKind, { bytes: Uint8Array; sig: Uint8Array }>;
  for (const kind of ["keys", "index", "blocklist"] as const) {
    const bytes = readFileIfExists(join(dir, FILE_NAMES[kind]));
    const sig = readFileIfExists(join(dir, `${FILE_NAMES[kind]}.sig`));
    if (!bytes || !sig) return null;
    files[kind] = { bytes, sig };
  }
  const state = readSourceState(ctx);
  const now = (ctx.now ?? (() => new Date()))();
  const verified = verifySet(source, files, state, { keys: null, index: null, blocklist: null }, now, {
    checkExpiry: options.requireFresh === true,
    checkSerials: false,
  });
  // The cache must be exactly what the last refresh accepted.
  if (
    verified.keys.serial !== state.keysSerial ||
    verified.index.serial !== state.indexSerial ||
    verified.blocklist.serial !== state.blockSerial
  ) {
    throw new AppStoreError("APP_STORE_STATE_INVALID", "The cached source does not match the store state.");
  }
  return { source, ...verified, state };
}

export function findBlock(
  blocklist: AppBlocklistFile,
  id: string,
  version: string,
  treeHash: string,
): AppBlocklistFile["blocked"][number] | null {
  return (
    blocklist.blocked.find(
      (entry) =>
        entry.id === id &&
        (entry.version === undefined || entry.version === version) &&
        (entry.treeHash === undefined || entry.treeHash === treeHash),
    ) ?? null
  );
}

export function sourceFileUrl(source: AppStoreSourceConfig, relativePath: string): string {
  return `${source.baseUrl}${relativePath}`;
}

export const APP_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;
