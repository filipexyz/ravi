/**
 * Operator trust for restricted-turn app calls, pinned to the manifest hash and path.
 * Each app has an independent atomic record: trusting one cannot restore a concurrently revoked app.
 * Records live under <state>/app-trust (0700), with files mode 0600.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { normalizeAppId } from "./service.js";
import type { RaviAppManifestRecord } from "./types.js";

export interface AppTrustEntry {
  manifestSha256: string;
  manifestPath: string;
  trustedAt: string;
}

function appTrustPath(id: string, env: NodeJS.ProcessEnv): string {
  const name = createHash("sha256").update(normalizeAppId(id)).digest("hex");
  return join(getRaviStateDir(env), "app-trust", `${name}.json`);
}

/** Missing, unreadable or malformed records trust nothing. */
function readAppTrust(id: string, env: NodeJS.ProcessEnv): AppTrustEntry | undefined {
  try {
    const parsed = JSON.parse(readFileSync(appTrustPath(id, env), "utf8"));
    if (
      parsed?.version !== 1 ||
      parsed.id !== normalizeAppId(id) ||
      typeof parsed.manifestSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(parsed.manifestSha256) ||
      typeof parsed.manifestPath !== "string" ||
      typeof parsed.trustedAt !== "string"
    )
      return undefined;
    return { manifestSha256: parsed.manifestSha256, manifestPath: parsed.manifestPath, trustedAt: parsed.trustedAt };
  } catch {
    // no-cause: unreadable trust records leave restricted turns in the sandbox.
    return undefined;
  }
}

export function manifestFileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function isAppTrusted(record: RaviAppManifestRecord, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!record.valid || !record.manifest) return false;
  const entry = readAppTrust(record.manifest.id, env);
  if (!entry) return false;
  try {
    return entry.manifestPath === record.path && entry.manifestSha256 === manifestFileSha256(record.path);
  } catch {
    // no-cause: an unreadable manifest cannot be the manifest that the operator trusted.
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
  const id = record.manifest.id;
  const previous = readAppTrust(id, env);
  const entry: AppTrustEntry = {
    manifestSha256: manifestFileSha256(record.path),
    manifestPath: record.path,
    trustedAt: now().toISOString(),
  };
  const changed = previous?.manifestSha256 !== entry.manifestSha256 || previous?.manifestPath !== entry.manifestPath;
  if (!changed) return { entry: previous!, changed: false };
  const path = appTrustPath(id, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, id, ...entry })}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
  return { entry, changed: true };
}

export function untrustApp(id: string, env: NodeJS.ProcessEnv = process.env): { changed: boolean } {
  const path = appTrustPath(id, env);
  try {
    unlinkSync(path);
    return { changed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { changed: false };
    throw error;
  }
}
