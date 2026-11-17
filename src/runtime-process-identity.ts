import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import packageMetadata from "../package.json" with { type: "json" };
import { getPm2Process, type Pm2Process } from "./pm2.js";
import { getRaviStateDir } from "./utils/paths.js";
import { errorDiagnostic } from "./utils/error-diagnostic.js";
import { logger } from "./utils/logger.js";

export type RuntimeProcessName = "ravi" | "ravi-channels";
export type RuntimeFileMetadata = { mtimeMs: number; size: number; ino: number };
export type RuntimeBundleFingerprint = RuntimeFileMetadata & { sha256: string };
export type RuntimeBootObservation = {
  bundlePath: string;
  runningVersion: string;
  bundle: RuntimeBundleFingerprint | null;
  envFile: string;
  env: RuntimeFileMetadata | null;
  capturedAt: number;
};
export type RuntimeBootReceipt = RuntimeBootObservation & {
  schemaVersion: 1;
  name: RuntimeProcessName;
  pid: number;
  startedAt: number;
};

export function runtimeFileMetadata(path: string): RuntimeFileMetadata | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino } : null;
  } catch {
    // no-cause: Missing or unreadable metadata makes this status probe unverifiable, not a command failure.
    return null;
  }
}

export function runtimeBundleFingerprint(path: string): RuntimeBundleFingerprint | null {
  try {
    const before = runtimeFileMetadata(path);
    if (!before) return null;
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    const after = runtimeFileMetadata(path);
    // Do not certify a file that was being replaced while it was read.
    if (!after || before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.ino !== after.ino)
      return null;
    return { ...after, sha256 };
  } catch {
    // no-cause: An unreadable or concurrently removed bundle cannot be certified; callers report an unknown identity.
    return null;
  }
}

export function observeRuntimeBoot(input: {
  bundlePath: string;
  runningVersion: string;
  envFile: string;
  now?: number;
}): RuntimeBootObservation {
  let bundlePath = input.bundlePath;
  try {
    bundlePath = realpathSync(bundlePath);
  } catch {
    // no-cause: A removed/inaccessible entry point stays at its original path and is independently marked unverifiable.
  }
  return {
    bundlePath,
    runningVersion: input.runningVersion,
    bundle: runtimeBundleFingerprint(bundlePath),
    envFile: input.envFile,
    env: runtimeFileMetadata(input.envFile),
    capturedAt: input.now ?? Date.now(),
  };
}

/** In PM2 Bun containers argv[1] can be the container, not the loaded bundle. */
export function runtimeBootBundlePath(moduleUrl = import.meta.url, argv: readonly string[] = process.argv): string {
  const modulePath = fileURLToPath(moduleUrl);
  return modulePath.endsWith("/dist/bundle/index.js") ? modulePath : (argv[1] ?? modulePath);
}

let bootObservation: RuntimeBootObservation | null = null;

/** Called once by the CLI bootstrap, before loading .env or the command graph. */
export function captureRuntimeBootObservation(): void {
  if (bootObservation) return;
  bootObservation = observeRuntimeBoot({
    bundlePath: runtimeBootBundlePath(),
    // JSON is embedded by the bundle build: never re-read package.json at status time.
    runningVersion: packageMetadata.version,
    envFile: join(getRaviStateDir(), ".env"),
  });
}

export function getRuntimeBootObservation(): RuntimeBootObservation | null {
  return bootObservation;
}

export function writeRuntimeBootReceipt(receipt: RuntimeBootReceipt, stateDir = getRaviStateDir()): void {
  const directory = join(stateDir, "runtime-processes");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${receipt.name}.json`);
  const temporary = `${path}.${receipt.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
  renameSync(temporary, path);
}

/** Run only in the actual daemon/runner entry point, including PM2 auto-restarts. */
export function recordManagedRuntimeBoot(name: RuntimeProcessName): boolean {
  const observation = bootObservation;
  if (!observation) return false;
  const managed = getPm2Process(name);
  if (managed?.pid !== process.pid || !managed.startedAt) return false;
  try {
    writeRuntimeBootReceipt({ ...observation, schemaVersion: 1, name, pid: process.pid, startedAt: managed.startedAt });
    return true;
  } catch (cause) {
    logger.warn(
      "Could not persist managed runtime boot identity",
      errorDiagnostic(cause, { operation: "runtime boot receipt" }),
    );
    return false;
  }
}

function validMetadata(value: unknown): value is RuntimeFileMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as RuntimeFileMetadata;
  return Number.isFinite(metadata.mtimeMs) && Number.isFinite(metadata.size) && Number.isFinite(metadata.ino);
}

export function readRuntimeBootReceipt(process: Pm2Process, stateDir = getRaviStateDir()): RuntimeBootReceipt | null {
  if (process.pid <= 0 || !process.startedAt || !["ravi", "ravi-channels"].includes(process.name)) return null;
  try {
    const value = JSON.parse(
      readFileSync(join(stateDir, "runtime-processes", `${process.name}.json`), "utf8"),
    ) as RuntimeBootReceipt;
    if (
      value.schemaVersion !== 1 ||
      value.name !== process.name ||
      value.pid !== process.pid ||
      value.startedAt !== process.startedAt ||
      typeof value.runningVersion !== "string" ||
      !value.runningVersion ||
      typeof value.bundlePath !== "string" ||
      typeof value.envFile !== "string" ||
      !Number.isFinite(value.capturedAt) ||
      value.capturedAt < value.startedAt ||
      (value.bundle !== null && (!validMetadata(value.bundle) || !/^[a-f0-9]{64}$/.test(value.bundle.sha256))) ||
      (value.env !== null && !validMetadata(value.env))
    )
      return null;
    return value;
  } catch {
    // no-cause: Missing, unreadable or corrupt receipts are untrusted evidence; status must report unverifiable identity.
    return null;
  }
}
