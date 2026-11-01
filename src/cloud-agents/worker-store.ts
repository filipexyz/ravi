/**
 * Local state of the cloud worker (F4, self-hosted environments): whether this
 * machine serves cloud agents at all, and the environment keys an admin typed
 * in with `ravi cloud worker key set <workerId>`.
 *
 *   ~/.ravi/cloud-workers/state.json          { enabled, enabledAt }   (0600)
 *   ~/.ravi/cloud-workers/runtime.json        what the daemon's runner did last tick (0600)
 *   ~/.ravi/cloud-workers/keys/<workerId>.key  the environment key      (0600)
 *   ~/.ravi/cloud-workers/<agentId>/work       the worker's workdir
 *
 * An environment key goes to the provider only; it is never sent to the Ravi
 * Console, logged or printed.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeUserOnlyFile } from "../cloud-auth/secret-backends.js";
import { getRaviStateDir } from "../utils/paths.js";

export const CLOUD_WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY_SUFFIX = ".key";
const MAX_KEY_CHARS = 4_096;

export interface CloudWorkerLocalState {
  enabled: boolean;
  enabledAt: string | null;
}

export function getCloudWorkersDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "cloud-workers");
}

/** The workdir of one agent's worker (bash and file tools run there). */
export function cloudWorkerWorkdir(agentId: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = agentId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "agent";
  return join(getCloudWorkersDir(env), safe, "work");
}

export function isCloudWorkerId(value: string): boolean {
  return CLOUD_WORKER_ID_PATTERN.test(value);
}

/** One environment key: no whitespace inside, bounded. */
export function isCloudWorkerKey(value: string): boolean {
  return value.length > 0 && value.length <= MAX_KEY_CHARS && !/\s/.test(value);
}

function keyPath(workerId: string, env: NodeJS.ProcessEnv): string {
  if (!isCloudWorkerId(workerId)) throw new Error("Invalid cloud worker id.");
  return join(getCloudWorkersDir(env), "keys", `${workerId}${KEY_SUFFIX}`);
}

export function writeCloudWorkerKey(workerId: string, key: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isCloudWorkerKey(key)) throw new Error("Invalid environment key.");
  writeUserOnlyFile(keyPath(workerId, env), key);
}

export function readCloudWorkerKey(workerId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isCloudWorkerId(workerId)) return null;
  const path = keyPath(workerId, env);
  if (!existsSync(path)) return null;
  const key = readFileSync(path, "utf8").trim();
  return isCloudWorkerKey(key) ? key : null;
}

export function removeCloudWorkerKey(workerId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = keyPath(workerId, env);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** Worker ids that have a key on this machine. */
export function listCloudWorkerKeyIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = join(getCloudWorkersDir(env), "keys");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(KEY_SUFFIX))
    .map((name) => name.slice(0, -KEY_SUFFIX.length))
    .filter(isCloudWorkerId)
    .sort();
}

export function readCloudWorkerState(env: NodeJS.ProcessEnv = process.env): CloudWorkerLocalState {
  const path = join(getCloudWorkersDir(env), "state.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CloudWorkerLocalState>;
    return {
      enabled: parsed.enabled === true,
      enabledAt: typeof parsed.enabledAt === "string" ? parsed.enabledAt : null,
    };
  } catch {
    return { enabled: false, enabledAt: null };
  }
}

export function writeCloudWorkerState(state: CloudWorkerLocalState, env: NodeJS.ProcessEnv = process.env): void {
  writeUserOnlyFile(join(getCloudWorkersDir(env), "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

/** What the daemon's runner does with one worker: runs it, waits for its key, or waits to restart it. */
export type CloudWorkerRunState = "running" | "waiting_key" | "backoff";

export interface CloudWorkerRuntime {
  updatedAt: string;
  workers: Record<string, { state: CloudWorkerRunState; error: string | null; restartAt: string | null }>;
}

export function readCloudWorkerRuntime(env: NodeJS.ProcessEnv = process.env): CloudWorkerRuntime | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(getCloudWorkersDir(env), "runtime.json"), "utf8"),
    ) as CloudWorkerRuntime;
    if (typeof parsed?.updatedAt !== "string" || !parsed.workers || typeof parsed.workers !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCloudWorkerRuntime(runtime: CloudWorkerRuntime, env: NodeJS.ProcessEnv = process.env): void {
  writeUserOnlyFile(join(getCloudWorkersDir(env), "runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`);
}
