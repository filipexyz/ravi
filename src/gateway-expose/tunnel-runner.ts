// `ravi gateway tunnel-run` (PM2 `ravi-gateway`): runs cloudflared for this
// installation's locally managed tunnel and is its drift poller. Normative:
// Console `sandbox-gateway/listener` SPEC §Host And cloudflared, §Drift Check
// (Fail Closed, Latching); OSS `.ravi/specs/sandbox/tunnel-runner`.
//
// Order on start: refuse when latched (row or fallback file), unconfigured,
// not on darwin, without credentials or without cloudflared; take the
// single-runner lock; stop a cloudflared a dead predecessor left behind and
// wait until it is gone (else exit 75); write the ingress template; wait
// until the daemon's listener is armed; close the listener's tunnel gate;
// start cloudflared with the credentials ONLY in its environment; poll
// `/config` immediately and then every 5 s, each poll also requiring the
// listener to be armed on the configured port (else exit 75).
//
// On drift the latch is written first (the listener refuses within 1 s; a
// fallback file when the database refuses), then cloudflared is stopped and
// the runner exits 78, which PM2 is told not to restart (`--stop-exit-codes
// 78`); a restarted runner refuses while latched. SIGTERM/SIGINT are
// forwarded and the runner exits with cloudflared's code. Any exception
// after the spawn stops cloudflared first; `tunnel.runner` is cleared only
// once cloudflared has exited.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { writeUserOnlyFile } from "../cloud-auth/secret-backends.js";
import { dbGetSetting } from "../router/router-db.js";
import {
  dbClearTunnelPoll,
  dbClearTunnelRunner,
  dbGetListenerArmed,
  dbGetTunnelDriftLatch,
  dbGetTunnelRunner,
  dbLatchTunnelDrift,
  dbRecordTunnelPoll,
  dbSetTunnelRunner,
  readTunnelDriftLatchFile,
  TUNNEL_POLL_MAX_AGE_MS,
  tunnelDriftLatchFilePath,
  writeTunnelDriftLatchFile,
} from "../sandbox/tunnel-state.js";
import {
  type ReadSandboxListenerConfigResult,
  readSandboxListenerConfig,
  type SandboxListenerConfig,
} from "../sandbox-listener/config.js";
import { logger } from "../utils/logger.js";
import { type LocatedCloudflared, locateCloudflared } from "./cloudflared.js";
import {
  accessTeamName,
  buildCloudflaredArgs,
  checkRemoteConfig,
  type DriftReason,
  LOOPBACK,
  renderCloudflaredConfig,
  type TunnelIngressTemplate,
} from "./ingress.js";
import {
  gatewayStateDir,
  type ReadTunnelCredentialsResult,
  readTunnelCredentials,
  serializeTunnelCredentials,
} from "./secret.js";

/** Exit code for "do not restart me" (EX_CONFIG); PM2 is registered with `--stop-exit-codes 78`. */
export const TUNNEL_RUNNER_EXIT_REFUSED = 78;
/** The gateway settings changed under a running tunnel: exit so PM2 restarts the runner with a fresh template (EX_TEMPFAIL). */
export const TUNNEL_RUNNER_EXIT_RESTART = 75;
export const TUNNEL_METRICS_PORT_SETTING = "gateway.tunnel.metricsPort";
/** cloudflared's own default metrics port. */
export const TUNNEL_DEFAULT_METRICS_PORT = 20241;
export const TUNNEL_POLL_INTERVAL_MS = 5_000;
export const TUNNEL_POLL_TIMEOUT_MS = 2_000;
/** Before the first success, an unreachable metrics server is retried for this long (cloudflared starting up). */
export const TUNNEL_STARTUP_GRACE_MS = 10_000;
export const TUNNEL_CHILD_STOP_TIMEOUT_MS = 5_000;
/** A stale cloudflared gets this long after SIGTERM, then after SIGKILL, to disappear. */
export const TUNNEL_STALE_STOP_WAIT_MS = 3_000;
/** `lsof`/`ss`/`ps` time limit. */
export const TUNNEL_TOOL_TIMEOUT_MS = 3_000;
export const TUNNEL_CONFIG_FILE = "cloudflared.yml";
/** Single-runner lock under the gateway dir: `{pid, token}`, created `O_EXCL`. */
export const TUNNEL_RUNNER_LOCK_FILE = "tunnel-runner.lock";
/** The only variable that carries the secret, and only in cloudflared's environment. */
export const TUNNEL_CREDENTIALS_ENV = "TUNNEL_CRED_CONTENTS";
const CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"];

export interface TunnelChild {
  readonly pid?: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export type TunnelSpawn = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; stdio: ["ignore", "pipe", "pipe"] },
) => TunnelChild;

export interface TunnelStateStore {
  getLatch: typeof dbGetTunnelDriftLatch;
  latch: typeof dbLatchTunnelDrift;
  recordPoll: typeof dbRecordTunnelPoll;
  clearPoll: typeof dbClearTunnelPoll;
  getRunner: typeof dbGetTunnelRunner;
  setRunner: typeof dbSetTunnelRunner;
  clearRunner: typeof dbClearTunnelRunner;
  getListenerArmed: typeof dbGetListenerArmed;
}

/**
 * PIDs listening on 127.0.0.1:<port>. `null`: ownership cannot be determined
 * at all (neither `lsof` nor `ss` exists) — drift. `{failed}`: the tool ran
 * but did not answer (timeout, error) — a transient poll failure.
 */
export type SocketOwnersResult = number[] | null | { failed: string };

export interface TunnelRunnerDeps {
  spawn: TunnelSpawn;
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  /** Wall clock, for the persisted `last_poll_at` and the runner record. */
  now?: () => number;
  /** Monotonic clock (ms) for the runner's own staleness and grace bookkeeping. Default `performance.now`. */
  monotonic?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default `process.platform`; anything but darwin refuses (confinement not verified elsewhere). */
  platform?: NodeJS.Platform;
  readListenerConfig?: () => ReadSandboxListenerConfigResult;
  readSetting?: (key: string) => string | null;
  readCredentials?: () => ReadTunnelCredentialsResult;
  locate?: () => LocatedCloudflared;
  socketOwners?: (port: number) => Promise<SocketOwnersResult>;
  isAlive?: (pid: number) => boolean;
  /** Command name of a pid, to stop a stale cloudflared and never an unrelated reused pid. */
  processName?: (pid: number) => Promise<string | null>;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  gatewayDir?: string;
  /** Source of the child's non-secret variables (allowlisted). Never mutated. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Registers the SIGTERM/SIGINT handler; returns its remover. */
  onSignal?: (handler: (signal: NodeJS.Signals) => void) => () => void;
  state?: TunnelStateStore;
  output?: { stdout: (text: string) => void; stderr: (text: string) => void };
  pollIntervalMs?: number;
  startupGraceMs?: number;
  armedWaitMs?: number;
  staleStopWaitMs?: number;
}

export type TunnelRunOutcome =
  | { outcome: "refused"; exitCode: typeof TUNNEL_RUNNER_EXIT_REFUSED; reason: string }
  | { outcome: "drift"; exitCode: typeof TUNNEL_RUNNER_EXIT_REFUSED; reason: DriftReason; detail: string }
  | { outcome: "config_changed"; exitCode: typeof TUNNEL_RUNNER_EXIT_RESTART; reason: string }
  | {
      outcome: "restart";
      exitCode: typeof TUNNEL_RUNNER_EXIT_RESTART;
      reason: "stale_cloudflared_alive" | "listener_unarmed";
    }
  | { outcome: "child_exit"; exitCode: number; signal: NodeJS.Signals | null }
  | { outcome: "signal"; exitCode: number; signal: NodeJS.Signals };

const log = logger.child("gateway-tunnel");

export const defaultTunnelState: TunnelStateStore = {
  getLatch: dbGetTunnelDriftLatch,
  latch: dbLatchTunnelDrift,
  recordPoll: dbRecordTunnelPoll,
  clearPoll: dbClearTunnelPoll,
  getRunner: dbGetTunnelRunner,
  setRunner: dbSetTunnelRunner,
  clearRunner: dbClearTunnelRunner,
  getListenerArmed: dbGetListenerArmed,
};

export function buildTunnelChildEnv(baseEnv: NodeJS.ProcessEnv, credentialsJson: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = baseEnv[key];
    if (typeof value === "string" && value) env[key] = value;
  }
  env[TUNNEL_CREDENTIALS_ENV] = credentialsJson;
  return env;
}

export function readTunnelMetricsPort(read: (key: string) => string | null, listenerPort: number): number | null {
  const raw = read(TUNNEL_METRICS_PORT_SETTING)?.trim();
  const port = raw ? (/^[0-9]{1,5}$/.test(raw) ? Number(raw) : Number.NaN) : TUNNEL_DEFAULT_METRICS_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === listenerPort) return null;
  return port;
}

export async function runTunnel(deps: TunnelRunnerDeps): Promise<TunnelRunOutcome> {
  const now = deps.now ?? Date.now;
  const monotonic = deps.monotonic ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const state = deps.state ?? defaultTunnelState;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const output = deps.output ?? {
    stdout: (text: string) => process.stdout.write(text),
    stderr: (text: string) => process.stderr.write(text),
  };
  const refused = (reason: string): TunnelRunOutcome => {
    log.error("Tunnel runner refused to start cloudflared", { reason });
    return { outcome: "refused", exitCode: TUNNEL_RUNNER_EXIT_REFUSED, reason };
  };

  const gatewayDir = deps.gatewayDir ?? gatewayStateDir();
  const latchFile = tunnelDriftLatchFilePath(gatewayDir);
  // The fallback latch file first: it exists exactly when the database could not take the latch.
  const latch = readTunnelDriftLatchFile(latchFile) ?? state.getLatch();
  if (latch) return refused(`drift_latched:${latch.reason}`);
  const readListener = deps.readListenerConfig ?? (() => readSandboxListenerConfig());
  const listener = readListener();
  if (!listener.enabled) return refused(`gateway_${listener.reason}`);
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return refused(`platform_unsupported:${platform}`);
  const config = listener.config;
  const metricsPort = readTunnelMetricsPort(deps.readSetting ?? dbGetSetting, config.port);
  if (metricsPort === null) return refused("metrics_port_invalid");
  const credentials = (deps.readCredentials ?? (() => readTunnelCredentials()))();
  if (!credentials.found) return refused(`credentials_${credentials.reason}`);
  const binary = (deps.locate ?? (() => locateCloudflared()))();
  if (!binary.found) return refused(`cloudflared_${binary.reason}`);
  if (!binary.verified) log.warn("Running an unverified cloudflared", { path: binary.path, source: binary.source });

  // Narrowed values for `runLocked`.
  const tunnelCredentials = credentials.credentials;
  const located = binary;
  const metrics = metricsPort;

  mkdirSync(gatewayDir, { recursive: true, mode: 0o700 });
  const lock = acquireRunnerLock(join(gatewayDir, TUNNEL_RUNNER_LOCK_FILE), isAlive);
  if (!lock.acquired) return refused(`runner_already_running:${lock.holder ?? "unknown"}`);
  try {
    return await runLocked();
  } finally {
    lock.release();
  }

  async function runLocked(): Promise<TunnelRunOutcome> {
    if ((await stopStaleCloudflared(state, isAlive, sleep, deps)) === "still_alive") {
      log.error("A stale cloudflared survived SIGKILL; exiting for a restart instead of starting a second one");
      return { outcome: "restart", exitCode: TUNNEL_RUNNER_EXIT_RESTART, reason: "stale_cloudflared_alive" };
    }

    const template: TunnelIngressTemplate = {
      tunnelId: tunnelCredentials.TunnelID,
      hostname: config.tunnelHostname,
      servicePort: config.port,
      teamName: accessTeamName(config.accessTeamDomain),
      accessAud: config.accessAud,
    };
    const configPath = join(gatewayDir, TUNNEL_CONFIG_FILE);
    writeUserOnlyFile(configPath, renderCloudflaredConfig(template));
    const listenerArmed = () => {
      const armed = state.getListenerArmed();
      return armed !== null && armed.port === config.port && isAlive(armed.pid);
    };

    // Signals before anything long-running, so a stop during the armed wait is honoured.
    let stopSignal: NodeJS.Signals | null = null;
    let child: TunnelChild | null = null;
    let childDone = false;
    let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = Promise.resolve({
      code: null,
      signal: null,
    });
    let wake: () => void = () => {};
    const removeSignal = (deps.onSignal ?? defaultOnSignal)((signal) => {
      if (stopSignal) return;
      stopSignal = signal;
      log.info("Stopping cloudflared", { signal });
      child?.kill(signal);
      wake();
    });

    try {
      // Order (Console SPEC): the listener checks are armed before cloudflared starts.
      let waitingLogged = false;
      for (;;) {
        if (stopSignal) return { outcome: "signal", exitCode: 0, signal: stopSignal };
        if (listenerArmed()) break;
        if (!waitingLogged) {
          log.info("Waiting for the daemon's sandbox listener before starting cloudflared", { port: config.port });
          waitingLogged = true;
        }
        await interruptibleSleep(sleep, deps.armedWaitMs ?? 1_000, (resolve) => {
          wake = resolve;
        });
      }

      state.clearPoll();
      const secret = tunnelCredentials.TunnelSecret;
      const args = buildCloudflaredArgs({ configPath, metricsPort: metrics, tunnelId: template.tunnelId });
      const spawned = deps.spawn(located.path, args, {
        env: buildTunnelChildEnv(deps.baseEnv ?? process.env, serializeTunnelCredentials(tunnelCredentials)),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = spawned;
      // From here on any exception stops cloudflared before it propagates (catch below).
      exited = new Promise((resolve) => {
        spawned.once("exit", (code, signal) => {
          childDone = true;
          wake();
          resolve({ code, signal });
        });
        spawned.once("error", (error) => {
          log.error("cloudflared failed to start or to be signalled", { error: error.message });
          // Only a spawn failure (no pid) means there is no process; a failed kill leaves it running.
          if (spawned.pid !== undefined) return;
          childDone = true;
          wake();
          resolve({ code: 1, signal: null });
        });
      });
      const startedAt = now();
      const startedMono = monotonic();
      forward(spawned.stdout, output.stdout, secret);
      forward(spawned.stderr, output.stderr, secret);
      state.setRunner({ pid: process.pid, cloudflaredPid: spawned.pid ?? null, startedAt }, startedAt);
      log.info("cloudflared started", {
        pid: spawned.pid,
        version: located.version,
        verified: located.verified,
        metrics: `${LOOPBACK}:${metrics}`,
        hostname: template.hostname,
      });
      if (stopSignal) spawned.kill(stopSignal);

      const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
      const socketOwners = deps.socketOwners ?? defaultSocketOwners;
      const graceMs = deps.startupGraceMs ?? TUNNEL_STARTUP_GRACE_MS;
      // The runner's own staleness bookkeeping is monotonic; `last_poll_at` (for the listener) stays wall-clock.
      let lastSuccessMono: number | null = null;
      let drift: { reason: DriftReason; detail: string } | null = null;
      let configChanged: string | null = null;
      let listenerGone = false;
      try {
        while (!childDone && !stopSignal) {
          const at = monotonic();
          if (lastSuccessMono !== null && at - lastSuccessMono > TUNNEL_POLL_MAX_AGE_MS) {
            drift = { reason: "poll_stale", detail: `last success ${Math.round(at - lastSuccessMono)} ms ago` };
            break;
          }
          // The listener cloudflared routes to must still be armed on the configured port.
          if (!listenerArmed()) {
            listenerGone = true;
            break;
          }
          const result = await pollOnce({
            fetchImpl,
            socketOwners,
            metricsPort: metrics,
            childPid: spawned.pid,
            template,
          });
          if (childDone || stopSignal) break;
          if (result.ok) {
            lastSuccessMono = monotonic();
            state.recordPoll(now());
            configChanged = templateSettingsChanged(readListener, config);
            if (configChanged) break;
          } else {
            const inGrace = lastSuccessMono === null && monotonic() - startedMono < graceMs;
            // `until_stale`: tolerated after the first success too; staleness (10 s) still fails closed.
            const tolerated =
              (result.retry === "startup" && inGrace) ||
              (result.retry === "until_stale" && (lastSuccessMono !== null || inGrace));
            if (!tolerated) {
              drift = { reason: result.reason, detail: result.detail };
              break;
            }
            if (lastSuccessMono !== null) {
              log.warn("Tunnel poll failed; retrying until stale", { reason: result.reason, detail: result.detail });
            }
          }
          const wait = lastSuccessMono === null ? 500 : (deps.pollIntervalMs ?? TUNNEL_POLL_INTERVAL_MS);
          await interruptibleSleep(sleep, wait, (resolve) => {
            wake = resolve;
          });
        }
      } catch (error) {
        drift = { reason: "poll_failed", detail: error instanceof Error ? error.message : String(error) };
      }

      if (drift) {
        // Latch first: the listener refuses from its next gate read (≤ 1 s).
        latchDrift(state, drift.reason, now(), latchFile);
        log.error("Tunnel drift: stopping cloudflared; the latch holds until a rotate", drift);
        await stopChild(spawned, () => childDone, exited, sleep);
        return { outcome: "drift", exitCode: TUNNEL_RUNNER_EXIT_REFUSED, ...drift };
      }

      if (listenerGone) {
        log.warn("The daemon's sandbox listener is no longer armed on the configured port; stopping cloudflared", {
          port: config.port,
        });
        await stopChild(spawned, () => childDone, exited, sleep);
        return { outcome: "restart", exitCode: TUNNEL_RUNNER_EXIT_RESTART, reason: "listener_unarmed" };
      }

      if (configChanged) {
        log.info("Gateway settings changed; restarting the tunnel with a new template", { reason: configChanged });
        await stopChild(spawned, () => childDone, exited, sleep);
        return { outcome: "config_changed", exitCode: TUNNEL_RUNNER_EXIT_RESTART, reason: configChanged };
      }

      const result = await exited;
      if (stopSignal) {
        return { outcome: "signal", exitCode: exitCodeOf(result), signal: stopSignal };
      }
      log.warn("cloudflared exited", result);
      return { outcome: "child_exit", exitCode: exitCodeOf(result), signal: result.signal };
    } catch (error) {
      if (child && !childDone) {
        log.error("Tunnel runner failed after starting cloudflared; stopping it", { error });
        await stopChild(child, () => childDone, exited, sleep);
      }
      throw error;
    } finally {
      removeSignal();
      if (child) {
        // Fail closed: the listener's gate stays shut until the next runner polls.
        safe(() => state.clearPoll());
        // The record is what lets the next runner stop a cloudflared that outlived us.
        if (childDone) safe(() => state.clearRunner());
        else log.error("cloudflared did not exit; tunnel.runner kept so the next runner stops it", { pid: child.pid });
      }
    }
  }
}

/** The drift latch row; when the database refuses it, the fallback latch file (checked at start and by the listener). */
function latchDrift(state: TunnelStateStore, reason: string, at: number, latchFile: string): void {
  try {
    state.latch(reason, at);
    return;
  } catch (error) {
    log.error("Could not persist the drift latch; writing the fallback latch file", { error, path: latchFile });
  }
  try {
    writeTunnelDriftLatchFile(reason, at, latchFile);
  } catch (error) {
    log.error("Could not write the fallback latch file either; stopping cloudflared anyway", { error });
  }
}

/**
 * One runner per installation: an `O_EXCL` lock file under the gateway dir
 * holding `{pid, token}`. A lock whose pid is dead (or that does not parse)
 * is stale and replaced; a live holder means another runner (PM2 or a
 * hand-run `tunnel-run`) owns cloudflared and this one must not touch it.
 */
function acquireRunnerLock(
  path: string,
  isAlive: (pid: number) => boolean,
): { acquired: true; release: () => void } | { acquired: false; holder: number | null } {
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }));
      } finally {
        closeSync(fd);
      }
      return {
        acquired: true,
        release: () => {
          if (readRunnerLock(path)?.token === token) safe(() => rmSync(path, { force: true }));
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = readRunnerLock(path);
    if (holder && isAlive(holder.pid)) return { acquired: false, holder: holder.pid };
    log.warn("Removing a stale tunnel runner lock", { pid: holder?.pid ?? null });
    rmSync(path, { force: true });
  }
  return { acquired: false, holder: null };
}

function readRunnerLock(path: string): { pid: number; token: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; token?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && typeof parsed.token === "string"
      ? { pid: parsed.pid, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

/**
 * The template was built from the settings at start; a change to any of them
 * (05b re-expose with a new port, unexpose) means cloudflared is routing by
 * stale values. A read error is not a change (the next poll re-reads).
 */
function templateSettingsChanged(
  read: () => ReadSandboxListenerConfigResult,
  started: SandboxListenerConfig,
): string | null {
  let current: ReadSandboxListenerConfigResult;
  try {
    current = read();
  } catch {
    return null;
  }
  if (!current.enabled) return `gateway_${current.reason}`;
  for (const key of ["port", "tunnelHostname", "accessAud", "accessTeamDomain"] as const) {
    if (current.config[key] !== started[key]) return `${key}_changed`;
  }
  return null;
}

/**
 * `retry`: `never` is drift at once; `startup` is retried only before the
 * first success, within the grace window; `until_stale` is retried at any
 * time (bounded by the grace window, then by the 10 s staleness rule).
 */
type PollResult =
  | { ok: true }
  | { ok: false; reason: DriftReason; detail: string; retry: "never" | "startup" | "until_stale" };

async function pollOnce(input: {
  fetchImpl: NonNullable<TunnelRunnerDeps["fetch"]>;
  socketOwners: NonNullable<TunnelRunnerDeps["socketOwners"]>;
  metricsPort: number;
  childPid: number | undefined;
  template: TunnelIngressTemplate;
}): Promise<PollResult> {
  const owners = await input.socketOwners(input.metricsPort);
  if (owners === null) {
    return { ok: false, reason: "metrics_socket_owner", detail: "socket owner unverifiable", retry: "never" };
  }
  if (!Array.isArray(owners)) {
    return {
      ok: false,
      reason: "metrics_socket_owner",
      detail: `socket owner check failed: ${owners.failed}`,
      retry: "until_stale",
    };
  }
  if (owners.length === 0) {
    return { ok: false, reason: "poll_failed", detail: "metrics port not listening", retry: "startup" };
  }
  if (input.childPid === undefined || owners.some((pid) => pid !== input.childPid)) {
    return { ok: false, reason: "metrics_socket_owner", detail: "metrics port owned by another pid", retry: "never" };
  }
  let response: Response;
  try {
    response = await input.fetchImpl(`http://${LOOPBACK}:${input.metricsPort}/config`, {
      signal: AbortSignal.timeout(TUNNEL_POLL_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "poll_failed",
      detail: error instanceof Error ? error.name : "fetch failed",
      retry: "startup",
    };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, reason: "poll_failed", detail: `HTTP ${response.status}`, retry: "startup" };
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return { ok: false, reason: "config_unparseable", detail: "invalid JSON", retry: "never" };
  }
  const check = checkRemoteConfig(body, input.template);
  return check.ok ? { ok: true } : { ...check, retry: "never" };
}

/**
 * Stops the cloudflared a dead predecessor recorded in `tunnel.runner` and
 * waits until it is gone: SIGTERM, up to 3 s, SIGKILL, up to 3 s. The caller
 * holds the runner lock, so the recorded runner is not running (a live pid
 * there is a reused one). A pid that is not named `cloudflared` is left alone.
 * `still_alive`: it survived SIGKILL; starting a second cloudflared now would
 * find the metrics port taken and latch, so the caller exits 75 instead.
 */
async function stopStaleCloudflared(
  state: TunnelStateStore,
  isAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
  deps: TunnelRunnerDeps,
): Promise<"clear" | "still_alive"> {
  const previous = state.getRunner();
  if (!previous?.cloudflaredPid || previous.pid === process.pid) return "clear";
  const pid = previous.cloudflaredPid;
  if (!isAlive(pid)) return "clear";
  const name = await (deps.processName ?? defaultProcessName)(pid);
  if (!name || !/cloudflared/.test(name)) return "clear";
  const kill = deps.killPid ?? ((target, signal) => process.kill(target, signal));
  const wait = deps.staleStopWaitMs ?? TUNNEL_STALE_STOP_WAIT_MS;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    log.warn("Stopping a cloudflared left behind by a dead tunnel runner", { pid, signal });
    try {
      kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "clear";
      log.error("Could not signal the stale cloudflared", { pid, signal, error });
    }
    if (await waitForExit(pid, isAlive, sleep, wait)) return "clear";
  }
  return "still_alive";
}

async function waitForExit(
  pid: number,
  isAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  const step = 100;
  for (let waited = 0; ; waited += step) {
    if (!isAlive(pid)) return true;
    if (waited >= timeoutMs) return false;
    await sleep(step);
  }
}

async function stopChild(
  child: TunnelChild,
  isDone: () => boolean,
  exited: Promise<unknown>,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (isDone()) return;
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(TUNNEL_CHILD_STOP_TIMEOUT_MS)]);
  if (!isDone()) {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(TUNNEL_CHILD_STOP_TIMEOUT_MS)]);
  }
}

function interruptibleSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  setWake: (resolve: () => void) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    setWake(resolve);
    void sleep(ms).then(resolve);
  });
}

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

function exitCodeOf(result: { code: number | null; signal: NodeJS.Signals | null }): number {
  if (result.code !== null) return result.code;
  return result.signal ? 128 + (SIGNAL_NUMBERS[result.signal] ?? 0) : 1;
}

/** Child output goes to the runner's (PM2) log, with the secret masked should it ever appear. */
function forward(stream: Readable | null, write: (text: string) => void, secret: string): void {
  stream?.on("data", (chunk: Buffer | string) => {
    write(String(chunk).split(secret).join("[redacted]"));
  });
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    log.warn("Tunnel state cleanup failed", { error });
  }
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultOnSignal(handler: (signal: NodeJS.Signals) => void): () => void {
  const onTerm = () => handler("SIGTERM");
  const onInt = () => handler("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  return () => {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  };
}

interface ToolRun {
  code: number | null;
  stdout: string;
  missing: boolean;
  timedOut: boolean;
}

function run(command: string, args: string[]): Promise<ToolRun> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: TUNNEL_TOOL_TIMEOUT_MS, encoding: "utf8" }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
      resolve({
        code,
        stdout: stdout ?? "",
        missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
        timedOut: Boolean((error as { killed?: boolean } | null)?.killed),
      });
    });
  });
}

const describeToolFailure = (name: string, result: ToolRun) =>
  result.timedOut ? `${name} timed out` : `${name} exit ${result.code ?? "unknown"}`;

/**
 * `lsof` (macOS, most Linux), then `ss` (iproute2). `null` only when neither
 * tool exists; a tool that exists but times out or fails is `{failed}`, a
 * transient poll failure (a slow `lsof` under load is not drift by itself).
 */
export async function defaultSocketOwners(port: number): Promise<SocketOwnersResult> {
  const lsof = await run("lsof", ["-nP", "-a", `-iTCP@${LOOPBACK}:${port}`, "-sTCP:LISTEN", "-Fp"]);
  if (!lsof.missing && (lsof.code === 0 || (lsof.code === 1 && lsof.stdout.trim() === ""))) {
    return [...new Set([...lsof.stdout.matchAll(/^p(\d+)$/gm)].map((match) => Number(match[1])))];
  }
  const ss = await run("ss", ["-Hltnp", "sport", "=", `:${port}`]);
  if (!ss.missing && ss.code === 0) {
    return [...new Set([...ss.stdout.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])))];
  }
  if (lsof.missing && ss.missing) return null;
  return {
    failed: [lsof.missing ? null : describeToolFailure("lsof", lsof), ss.missing ? null : describeToolFailure("ss", ss)]
      .filter((part): part is string => part !== null)
      .join("; "),
  };
}

async function defaultProcessName(pid: number): Promise<string | null> {
  const ps = await run("ps", ["-o", "comm=", "-p", String(pid)]);
  return ps.code === 0 ? ps.stdout.trim() || null : null;
}
