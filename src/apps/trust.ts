/**
 * Operator trust for calling an app from a restricted turn (spec apps/manifest, "Restricted Turn Calls").
 *
 * A manifest may ask, with `sandbox.callableFromRestrictedTurns: true`, that a turn held below the agent call it.
 * The ask alone grants nothing: the operator confirms it in their own terminal (`ravi apps trust <id> --execute`),
 * and the confirmation is pinned to the SHA-256 of the manifest file. A changed manifest is no longer trusted until
 * the operator confirms it again; `ravi apps untrust` or removing the app revokes it.
 *
 * The record lives next to the installed apps (`<state>/app-trust.json`, mode 0600): whoever can write there can
 * already install or replace an app, so the trust record adds no new writer.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import type { RaviAppManifestRecord } from "./types.js";

export const APP_TRUST_FILE = "app-trust.json";

export interface AppTrustEntry {
  /** SHA-256 of the manifest file bytes when the operator trusted it. */
  manifestSha256: string;
  manifestPath: string;
  trustedAt: string;
}

export interface AppTrustFile {
  version: 1;
  apps: Record<string, AppTrustEntry>;
}

export function appTrustPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), APP_TRUST_FILE);
}

/** Read the trust record. A missing, unreadable or malformed file trusts nothing (fails closed). */
export function readAppTrust(env: NodeJS.ProcessEnv = process.env): AppTrustFile {
  const path = appTrustPath(env);
  if (!existsSync(path)) return { version: 1, apps: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return { version: 1, apps: {} };
    const apps = (parsed as { apps?: unknown }).apps;
    if ((parsed as { version?: unknown }).version !== 1 || !apps || typeof apps !== "object") {
      return { version: 1, apps: {} };
    }
    const out: Record<string, AppTrustEntry> = {};
    for (const [id, entry] of Object.entries(apps as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const { manifestSha256, manifestPath, trustedAt } = entry as Record<string, unknown>;
      if (typeof manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifestSha256)) continue;
      out[id] = {
        manifestSha256,
        manifestPath: typeof manifestPath === "string" ? manifestPath : "",
        trustedAt: typeof trustedAt === "string" ? trustedAt : "",
      };
    }
    return { version: 1, apps: out };
  } catch {
    // no-cause: an unreadable trust record trusts nothing; restricted turns keep the closed sandbox.
    return { version: 1, apps: {} };
  }
}

function writeAppTrust(file: AppTrustFile, env: NodeJS.ProcessEnv): void {
  const path = appTrustPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function manifestFileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Whether the operator trusted exactly this manifest file (same id, same bytes). */
export function isAppTrusted(record: RaviAppManifestRecord, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!record.valid || !record.manifest) return false;
  const entry = readAppTrust(env).apps[record.manifest.id];
  if (!entry) return false;
  try {
    return entry.manifestPath === record.path && entry.manifestSha256 === manifestFileSha256(record.path);
  } catch {
    // no-cause: a manifest that cannot be read is not the one the operator trusted.
    return false;
  }
}

export function trustApp(
  record: RaviAppManifestRecord,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): { entry: AppTrustEntry; changed: boolean } {
  if (!record.valid || record.manifest?.sandbox?.callableFromRestrictedTurns !== true) {
    throw new Error(`App ${record.id} must have a valid manifest requesting sandbox.callableFromRestrictedTurns.`);
  }
  const file = readAppTrust(env);
  const entry: AppTrustEntry = {
    manifestSha256: manifestFileSha256(record.path),
    manifestPath: record.path,
    trustedAt: now().toISOString(),
  };
  const previous = file.apps[record.manifest.id];
  const changed = previous?.manifestSha256 !== entry.manifestSha256 || previous?.manifestPath !== entry.manifestPath;
  if (!changed) return { entry: previous!, changed: false };
  file.apps[record.manifest.id] = entry;
  writeAppTrust(file, env);
  return { entry, changed: true };
}

export function untrustApp(id: string, env: NodeJS.ProcessEnv = process.env): { changed: boolean } {
  const file = readAppTrust(env);
  if (!file.apps[id]) return { changed: false };
  delete file.apps[id];
  writeAppTrust(file, env);
  return { changed: true };
}
