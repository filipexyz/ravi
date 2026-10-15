// Cross-process tunnel state in `sandbox_listener_state` (ravi.db), shared by
// the tunnel runner (`ravi gateway tunnel-run`, PM2 `ravi-gateway`) and the
// sandbox listener inside the daemon. Console `sandbox-gateway/listener` SPEC
// §Drift Check; OSS `.ravi/specs/sandbox/tunnel-runner`.
//
// - `tunnel.drift_latch`: the persistent drift latch. Set by the runner's
//   poller on any drift, BEFORE it stops cloudflared; survives daemon, runner
//   and host restarts; cleared only by a successful rotate/re-expose (05b
//   calls `dbClearTunnelDriftLatch`). Kept out of `settings` on purpose: a
//   `gateway.*` setting write restarts the listener and `ravi settings set`
//   could clear it.
// - `tunnel.last_poll_at`: when the poller last read cloudflared's `/config`
//   and found it equal to the template. The listener serves nothing until it
//   exists and refuses once it is older than 10 s.
// - `tunnel.runner`: the runner pid and its cloudflared pid, so a restarted
//   runner can stop a cloudflared its dead predecessor left behind.
// - `listener.armed`: the daemon listener's pid and port while it is up; the
//   runner starts cloudflared only after the listener checks are armed, and
//   stops it when the record disappears or names another port.
//
// Fallback latch file `~/.ravi/gateway/tunnel-drift.latch` (`0600`): written
// by the runner only when the `tunnel.drift_latch` write fails. Its presence
// is a latch for the runner's start check and the listener's gate alike, and
// `dbClearTunnelDriftLatch` removes it with the row.

import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { executeWrite } from "../db/write-retry.js";
import { getRaviStateDir } from "../utils/paths.js";
import { ensureSandboxSchema } from "./runs-db.js";

/** Console listener SPEC §Drift Check: no successful poll within the last 10 s is drift. */
export const TUNNEL_POLL_MAX_AGE_MS = 10_000;

const KEY_LATCH = "tunnel.drift_latch";
const KEY_LAST_POLL = "tunnel.last_poll_at";
const KEY_RUNNER = "tunnel.runner";
const KEY_ARMED = "listener.armed";

export interface TunnelDriftLatch {
  at: number;
  reason: string;
}

export interface TunnelGateState {
  latch: TunnelDriftLatch | null;
  lastPollAt: number | null;
}

export type TunnelGateDecision =
  | { open: true }
  | { open: false; reason: "drift_latched" | "no_successful_poll" | "poll_stale" };

export function evaluateTunnelGate(state: TunnelGateState, now: number): TunnelGateDecision {
  if (state.latch) return { open: false, reason: "drift_latched" };
  if (state.lastPollAt === null) return { open: false, reason: "no_successful_poll" };
  if (now - state.lastPollAt > TUNNEL_POLL_MAX_AGE_MS || state.lastPollAt > now + TUNNEL_POLL_MAX_AGE_MS) {
    return { open: false, reason: "poll_stale" };
  }
  return { open: true };
}

export const TUNNEL_DRIFT_LATCH_FILE = "tunnel-drift.latch";

/** `~/.ravi/gateway/tunnel-drift.latch` (the runner's `gatewayDir`). */
export function tunnelDriftLatchFilePath(gatewayDir: string = join(getRaviStateDir(), "gateway")): string {
  return join(gatewayDir, TUNNEL_DRIFT_LATCH_FILE);
}

/**
 * The fallback latch, or null when there is none. A file that exists but
 * cannot be read or parsed is still a latch (fail closed).
 */
export function readTunnelDriftLatchFile(path: string = tunnelDriftLatchFilePath()): TunnelDriftLatch | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { at: 0, reason: "unreadable" };
  }
  return (
    parseJson(raw, (parsed) => {
      const at = finiteNumber(parsed.at);
      return at === null ? null : { at, reason: typeof parsed.reason === "string" ? parsed.reason : "unknown" };
    }) ?? { at: 0, reason: "unparseable" }
  );
}

/** Writes the fallback latch (`0600`, directory `0700`); an existing file keeps its first cause. */
export function writeTunnelDriftLatchFile(reason: string, at: number, path: string = tunnelDriftLatchFilePath()): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify({ at, reason }));
  } finally {
    closeSync(fd);
  }
}

function readValue(key: string): string | null {
  const db = ensureSandboxSchema();
  const row = db.prepare("SELECT value FROM sandbox_listener_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeValue(key: string, value: string, at: number, label: string): void {
  const db = ensureSandboxSchema();
  executeWrite(
    db,
    (handle) =>
      handle
        .prepare(
          `INSERT INTO sandbox_listener_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, value, at),
    { label },
  );
}

function deleteValue(key: string, label: string): void {
  const db = ensureSandboxSchema();
  executeWrite(db, (handle) => handle.prepare("DELETE FROM sandbox_listener_state WHERE key = ?").run(key), { label });
}

function parseJson<T>(value: string | null, guard: (parsed: Record<string, unknown>) => T | null): T | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? guard(parsed) : null;
  } catch {
    return null;
  }
}

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * One read of both keys; what the listener evaluates (cached ≤ 1 s) on every
 * request. The fallback latch file wins over the database (and is read first,
 * so a database that cannot be written to still closes the gate).
 */
export function dbReadTunnelGateState(latchFile: string = tunnelDriftLatchFilePath()): TunnelGateState {
  const fileLatch = readTunnelDriftLatchFile(latchFile);
  if (fileLatch) return { latch: fileLatch, lastPollAt: null };
  const db = ensureSandboxSchema();
  const rows = db
    .prepare("SELECT key, value FROM sandbox_listener_state WHERE key IN (?, ?)")
    .all(KEY_LATCH, KEY_LAST_POLL) as Array<{ key: string; value: string }>;
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const rawLatch = byKey.get(KEY_LATCH) ?? null;
  // A latch row that does not parse is still a latch: fail closed.
  const latch =
    rawLatch === null
      ? null
      : (parseJson(rawLatch, (parsed) => {
          const at = finiteNumber(parsed.at);
          return at === null ? null : { at, reason: typeof parsed.reason === "string" ? parsed.reason : "unknown" };
        }) ?? { at: 0, reason: "unparseable" });
  const lastPoll = byKey.get(KEY_LAST_POLL);
  const lastPollAt = lastPoll === undefined ? null : finiteNumber(Number(lastPoll));
  return { latch, lastPollAt };
}

export function dbGetTunnelDriftLatch(latchFile?: string): TunnelDriftLatch | null {
  return dbReadTunnelGateState(latchFile).latch;
}

/** Sets the latch unless one is already set (the first cause is kept). Returns the latch in force. */
export function dbLatchTunnelDrift(reason: string, at = Date.now()): TunnelDriftLatch {
  const db = ensureSandboxSchema();
  return executeWrite(
    db,
    (handle) => {
      handle
        .prepare("INSERT OR IGNORE INTO sandbox_listener_state (key, value, updated_at) VALUES (?, ?, ?)")
        .run(KEY_LATCH, JSON.stringify({ at, reason }), at);
      handle.prepare("DELETE FROM sandbox_listener_state WHERE key = ?").run(KEY_LAST_POLL);
      const row = handle.prepare("SELECT value FROM sandbox_listener_state WHERE key = ?").get(KEY_LATCH) as {
        value: string;
      };
      return (
        parseJson(row.value, (parsed) => ({
          at: finiteNumber(parsed.at) ?? at,
          reason: typeof parsed.reason === "string" ? parsed.reason : reason,
        })) ?? { at, reason }
      );
    },
    { label: "sandbox_listener_state.latch_drift" },
  );
}

/** Only a successful rotate / re-expose (05b) calls this; it also removes the fallback latch file. */
export function dbClearTunnelDriftLatch(latchFile: string = tunnelDriftLatchFilePath()): void {
  deleteValue(KEY_LATCH, "sandbox_listener_state.clear_drift");
  rmSync(latchFile, { force: true });
}

export function dbRecordTunnelPoll(at = Date.now()): void {
  writeValue(KEY_LAST_POLL, String(at), at, "sandbox_listener_state.tunnel_poll");
}

/** Closes the listener's tunnel gate until the next successful poll (runner start and stop). */
export function dbClearTunnelPoll(): void {
  deleteValue(KEY_LAST_POLL, "sandbox_listener_state.clear_tunnel_poll");
}

export interface TunnelRunnerRecord {
  pid: number;
  cloudflaredPid: number | null;
  startedAt: number;
}

export function dbSetTunnelRunner(record: TunnelRunnerRecord, at = Date.now()): void {
  writeValue(KEY_RUNNER, JSON.stringify(record), at, "sandbox_listener_state.tunnel_runner");
}

export function dbGetTunnelRunner(): TunnelRunnerRecord | null {
  return parseJson(readValue(KEY_RUNNER), (parsed) => {
    const pid = finiteNumber(parsed.pid);
    const startedAt = finiteNumber(parsed.startedAt);
    if (pid === null || startedAt === null) return null;
    return { pid, cloudflaredPid: finiteNumber(parsed.cloudflaredPid), startedAt };
  });
}

export function dbClearTunnelRunner(): void {
  deleteValue(KEY_RUNNER, "sandbox_listener_state.clear_tunnel_runner");
}

export interface ListenerArmedRecord {
  pid: number;
  port: number;
  at: number;
}

export function dbSetListenerArmed(record: ListenerArmedRecord): void {
  writeValue(KEY_ARMED, JSON.stringify(record), record.at, "sandbox_listener_state.listener_armed");
}

export function dbGetListenerArmed(): ListenerArmedRecord | null {
  return parseJson(readValue(KEY_ARMED), (parsed) => {
    const pid = finiteNumber(parsed.pid);
    const port = finiteNumber(parsed.port);
    const at = finiteNumber(parsed.at);
    return pid === null || port === null || at === null ? null : { pid, port, at };
  });
}

/** Clears the armed record only when it is still this process's (a newer listener may have replaced it). */
export function dbClearListenerArmed(pid = process.pid): void {
  const current = dbGetListenerArmed();
  if (current && current.pid !== pid) return;
  deleteValue(KEY_ARMED, "sandbox_listener_state.clear_listener_armed");
}
