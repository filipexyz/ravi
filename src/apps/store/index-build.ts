/**
 * Maintainer side of the official source (spec apps/store, "Publishing").
 *
 * The index repository holds `apps/<id>/` folders. `build` turns them into
 * `bundles/*.json` and an unsigned `index.json`; `sign` adds the detached
 * signature with a key that never leaves the maintainer's machine. These run
 * inside Ravi, so no script from the apps repository ever touches a key.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isExactVersion, isVersionRange } from "../composition.js";
import type { ClassifyOptions } from "./classify.js";
import { inspectPackage } from "./install.js";
import { type AppPackageFile, readPackageDir, sha256Hex } from "./package.js";
import { writeFileAtomic } from "./paths.js";
import { ed25519PublicKeyFromPrivatePem, signDetached, verifyDetachedSignature } from "./trust.js";
import {
  APP_BLOCKLIST_SCHEMA,
  APP_BUNDLE_SCHEMA,
  APP_INDEX_SCHEMA,
  APP_SIGNERS_SCHEMA,
  type AppBlocklistFile,
  type AppIndexEntry,
  type AppIndexFile,
  type AppIndexVersion,
  type AppKeysFile,
  AppStoreError,
  appBlocklistFileSchema,
  appIndexFileSchema,
  appKeysFileSchema,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BuildIndexOptions extends ClassifyOptions {
  repoDir: string;
  source?: string;
  publisher?: string;
  expiresDays?: number;
  now?: Date;
  /** Plan only: return the index and bundles without writing. */
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface BuildIndexResult {
  index: AppIndexFile;
  added: Array<{ id: string; version: string; treeHash: string; class: string }>;
  unchanged: Array<{ id: string; version: string }>;
  bundles: string[];
  written: boolean;
}

function readJson<T>(path: string, parse: (value: unknown) => T, label: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new AppStoreError("APP_INDEX_INVALID", `${label} is invalid.`, 1, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function bundlePathFor(id: string, version: string): string {
  return `bundles/${id.replaceAll("/", "--")}-${version}.json`;
}

function findAppDirs(appsDir: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 3) return;
    if (existsSync(join(dir, "ravi.app.json"))) {
      found.push(dir);
      return;
    }
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full, depth + 1);
    }
  };
  if (existsSync(appsDir)) visit(appsDir, 0);
  return found;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildIndex(options: BuildIndexOptions): BuildIndexResult {
  const now = options.now ?? new Date();
  const source = options.source ?? "official";
  const indexPath = join(options.repoDir, "index.json");
  const previous = readJson(indexPath, (value) => appIndexFileSchema.parse(value), "index.json");
  const apps: Record<string, AppIndexEntry> = {};
  const added: BuildIndexResult["added"] = [];
  const unchanged: BuildIndexResult["unchanged"] = [];
  const bundles: Array<{ path: string; content: string }> = [];
  const problems: string[] = [];
  // Staging for manifest checks goes to a throwaway folder, never the maintainer's own Ravi state.
  const scratch = mkdtempSync(join(tmpdir(), "ravi-app-index-"));
  const scratchEnv = { ...(options.env ?? process.env), RAVI_STATE_DIR: scratch };
  try {
    for (const dir of findAppDirs(join(options.repoDir, "apps"))) {
      const expectedId = relative(join(options.repoDir, "apps"), dir).split("\\").join("/");
      let files: AppPackageFile[];
      let inspected: ReturnType<typeof inspectPackage>;
      try {
        files = readPackageDir(dir);
        inspected = inspectPackage(files, { id: expectedId }, { registry: options.registry, env: scratchEnv });
      } catch (error) {
        problems.push(`apps/${expectedId}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!isExactVersion(inspected.version)) {
        problems.push(`apps/${expectedId}: version ${inspected.version} must be x.y.z`);
        continue;
      }
      if (inspected.class !== "compose") {
        problems.push(
          `apps/${expectedId}: the official index takes only compose apps; ${inspected.reasons.join("; ")}`,
        );
        continue;
      }
      const manifest = JSON.parse(files.find((file) => file.path === "ravi.app.json")!.content) as {
        name?: string;
        description?: string;
        engines?: { ravi?: unknown };
      };
      const engineRange = manifest.engines?.ravi;
      if (engineRange !== undefined && !isVersionRange(engineRange)) {
        problems.push(`apps/${expectedId}: engines.ravi must be a version range`);
        continue;
      }
      const prior = previous?.apps[inspected.id];
      const priorVersion = prior?.versions.find((entry) => entry.version === inspected.version);
      if (priorVersion && priorVersion.treeHash !== inspected.treeHash) {
        problems.push(
          `apps/${expectedId}: version ${inspected.version} was already published with other files; bump the version`,
        );
        continue;
      }
      const bundleContent = stableJson({
        schema: APP_BUNDLE_SCHEMA,
        id: inspected.id,
        version: inspected.version,
        files,
      });
      const bundlePath = bundlePathFor(inspected.id, inspected.version);
      const version: AppIndexVersion = priorVersion ?? {
        version: inspected.version,
        class: inspected.class,
        treeHash: inspected.treeHash,
        bundle: { path: bundlePath, sha256: sha256Hex(bundleContent), size: Buffer.byteLength(bundleContent) },
        grants: inspected.grants,
        engines: typeof engineRange === "string" ? { ravi: engineRange } : {},
        publishedAt: now.toISOString(),
        status: "active",
        security: false,
      };
      if (priorVersion) unchanged.push({ id: inspected.id, version: inspected.version });
      else {
        added.push({
          id: inspected.id,
          version: inspected.version,
          treeHash: inspected.treeHash,
          class: inspected.class,
        });
        bundles.push({ path: bundlePath, content: bundleContent });
      }
      const keptVersions = (prior?.versions ?? []).filter((entry) => entry.version !== inspected.version);
      apps[inspected.id] = {
        name: manifest.name ?? inspected.id,
        description: manifest.description ?? "",
        publisher: options.publisher ?? prior?.publisher ?? "ravi",
        versions: [...keptVersions, version],
      };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // An app folder removed from the repo keeps its published versions: installs keep verifying.
  for (const [id, entry] of Object.entries(previous?.apps ?? {})) {
    if (!apps[id]) apps[id] = entry;
  }
  if (problems.length > 0) {
    throw new AppStoreError("APP_INDEX_INVALID", `The index cannot be built:\n- ${problems.join("\n- ")}`, 1, {
      problems,
    });
  }
  const index = appIndexFileSchema.parse({
    schema: APP_INDEX_SCHEMA,
    source,
    serial: (previous?.serial ?? 0) + 1,
    issuedAt: now.toISOString(),
    expires: new Date(now.getTime() + (options.expiresDays ?? 30) * DAY_MS).toISOString(),
    apps: Object.fromEntries(Object.entries(apps).sort(([left], [right]) => left.localeCompare(right))),
  });
  if (!options.dryRun) {
    for (const bundle of bundles) writeFileAtomic(join(options.repoDir, bundle.path), bundle.content);
    writeFileAtomic(indexPath, stableJson(index));
    rmSync(`${indexPath}.sig`, { force: true });
  }
  return { index, added, unchanged, bundles: bundles.map((bundle) => bundle.path), written: !options.dryRun };
}

export function writeKeysFile(options: {
  repoDir: string;
  publish: string[];
  block: string[];
  expiresDays?: number;
  now?: Date;
}): AppKeysFile {
  const path = join(options.repoDir, "keys.json");
  const previous = readJson(path, (value) => appKeysFileSchema.parse(value), "keys.json");
  const now = options.now ?? new Date();
  const keys = appKeysFileSchema.parse({
    schema: APP_SIGNERS_SCHEMA,
    serial: (previous?.serial ?? 0) + 1,
    expires: new Date(now.getTime() + (options.expiresDays ?? 365) * DAY_MS).toISOString(),
    publish: options.publish,
    block: options.block,
  });
  writeFileAtomic(path, stableJson(keys));
  rmSync(`${path}.sig`, { force: true });
  return keys;
}

/** Add one entry to the block list (it only grows) and bump its serial. */
export function addBlock(options: {
  repoDir: string;
  id: string;
  version?: string;
  treeHash?: string;
  reason: string;
  expiresDays?: number;
  now?: Date;
}): AppBlocklistFile {
  const path = join(options.repoDir, "blocklist.json");
  const previous = readJson(path, (value) => appBlocklistFileSchema.parse(value), "blocklist.json");
  const now = options.now ?? new Date();
  const blocklist = appBlocklistFileSchema.parse({
    schema: APP_BLOCKLIST_SCHEMA,
    serial: (previous?.serial ?? 0) + 1,
    expires: new Date(now.getTime() + (options.expiresDays ?? 30) * DAY_MS).toISOString(),
    blocked: [
      ...(previous?.blocked ?? []),
      ...(options.id
        ? [
            {
              id: options.id,
              ...(options.version ? { version: options.version } : {}),
              ...(options.treeHash ? { treeHash: options.treeHash } : {}),
              reason: options.reason,
              blockedAt: now.toISOString(),
            },
          ]
        : []),
    ],
  });
  writeFileAtomic(path, stableJson(blocklist));
  rmSync(`${path}.sig`, { force: true });
  return blocklist;
}

/** Re-issue the block list unchanged with a new serial and expiry (it must be re-signed before it expires). */
export function renewBlocklist(options: { repoDir: string; expiresDays?: number; now?: Date }): AppBlocklistFile {
  return addBlock({ ...options, id: "", reason: "" });
}

/** Sign one file in place: writes `<file>.sig`. Returns the public key that signed it. */
export function signFile(path: string, privateKeyPem: string): { signature: string; publicKey: string } {
  const data = readFileSync(path);
  const signature = signDetached(data, privateKeyPem);
  const publicKey = ed25519PublicKeyFromPrivatePem(privateKeyPem);
  if (!verifyDetachedSignature(data, signature, [publicKey])) {
    throw new AppStoreError("APP_SIGNATURE_FAILED", "The signature does not verify with its own key.");
  }
  writeFileAtomic(`${path}.sig`, `${signature}\n`);
  return { signature, publicKey };
}

export interface RepoVerifyReport {
  ok: boolean;
  problems: string[];
  keysSerial: number | null;
  indexSerial: number | null;
  blockSerial: number | null;
  apps: number;
}

/** Offline check of a whole source folder against root keys: what a client would accept. */
export function verifyRepo(repoDir: string, rootKeys: string[], now: Date = new Date()): RepoVerifyReport {
  const problems: string[] = [];
  const read = (name: string) => {
    const bytes = existsSync(join(repoDir, name)) ? readFileSync(join(repoDir, name)) : null;
    const sig = existsSync(join(repoDir, `${name}.sig`)) ? readFileSync(join(repoDir, `${name}.sig`), "utf8") : null;
    if (!bytes) problems.push(`${name} is missing`);
    else if (!sig) problems.push(`${name}.sig is missing`);
    return { bytes, sig };
  };
  const keysFile = read("keys.json");
  const indexFile = read("index.json");
  const blockFile = read("blocklist.json");
  let keys: AppKeysFile | null = null;
  let index: AppIndexFile | null = null;
  let blocklist: AppBlocklistFile | null = null;
  if (keysFile.bytes && keysFile.sig) {
    if (!verifyDetachedSignature(keysFile.bytes, keysFile.sig, rootKeys))
      problems.push("keys.json is not signed by a root key");
    keys = appKeysFileSchema.safeParse(JSON.parse(keysFile.bytes.toString("utf8"))).data ?? null;
    if (!keys) problems.push("keys.json does not match its schema");
  }
  if (keys && indexFile.bytes && indexFile.sig) {
    if (!verifyDetachedSignature(indexFile.bytes, indexFile.sig, keys.publish)) {
      problems.push("index.json is not signed by a publication key");
    }
    index = appIndexFileSchema.safeParse(JSON.parse(indexFile.bytes.toString("utf8"))).data ?? null;
    if (!index) problems.push("index.json does not match its schema");
  }
  if (keys && blockFile.bytes && blockFile.sig) {
    const blockKeys = keys.block.length > 0 ? keys.block : keys.publish;
    if (!verifyDetachedSignature(blockFile.bytes, blockFile.sig, blockKeys)) {
      problems.push("blocklist.json is not signed by a block key");
    }
    blocklist = appBlocklistFileSchema.safeParse(JSON.parse(blockFile.bytes.toString("utf8"))).data ?? null;
    if (!blocklist) problems.push("blocklist.json does not match its schema");
  }
  for (const [name, file] of [
    ["keys.json", keys],
    ["index.json", index],
    ["blocklist.json", blocklist],
  ] as const) {
    if (file && Date.parse(file.expires) <= now.getTime()) problems.push(`${name} expired at ${file.expires}`);
  }
  for (const [id, entry] of Object.entries(index?.apps ?? {})) {
    for (const version of entry.versions) {
      const path = join(repoDir, version.bundle.path);
      if (!existsSync(path)) {
        problems.push(`${id}@${version.version}: ${version.bundle.path} is missing`);
        continue;
      }
      const bytes = readFileSync(path);
      if (sha256Hex(bytes) !== version.bundle.sha256 || bytes.byteLength !== version.bundle.size) {
        problems.push(`${id}@${version.version}: ${version.bundle.path} does not match the index`);
      }
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    keysSerial: keys?.serial ?? null,
    indexSerial: index?.serial ?? null,
    blockSerial: blocklist?.serial ?? null,
    apps: Object.keys(index?.apps ?? {}).length,
  };
}
