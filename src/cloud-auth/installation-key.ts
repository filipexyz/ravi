import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeUserOnlyFile } from "./secret-backends.js";
import { getCloudAuthDir } from "./storage.js";

const INSTALLATION_KEY_FILE = "installation-key";
const INSTALLATION_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function getInstallationKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getCloudAuthDir(env), INSTALLATION_KEY_FILE);
}

/**
 * Random per-install key sent to the Console as `installation.machineFingerprint`.
 * The Console stores only its hash and reuses the same local installation when
 * the same user logs in again, so bindings pinned to the installation survive
 * a re-login. It is not derived from hardware and survives `ravi logout`.
 */
export function readOrCreateInstallationKey(env: NodeJS.ProcessEnv = process.env): string {
  const path = getInstallationKeyPath(env);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (INSTALLATION_KEY_PATTERN.test(existing)) return existing;
  }
  const key = randomBytes(32).toString("base64url");
  writeUserOnlyFile(path, `${key}\n`);
  return key;
}
