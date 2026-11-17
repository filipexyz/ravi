/**
 * PM2 Utilities
 *
 * Thin wrapper around pm2 CLI for process management.
 */

import { execSync, spawnSync } from "node:child_process";
import { which } from "bun";
import { parsePm2Jlist } from "./pm2-output.js";

export const PM2_PROCESS_NAME = "ravi";
export const CHANNELS_PM2_PROCESS_NAME = "ravi-channels";
const PM2_ENV_DENYLIST = [
  "RAVI_CONTEXT_KEY",
  "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND",
  "RAVI_GATEWAY_URL",
  "RAVI_GATEWAY_INTERNAL",
  "RAVI_HOST_CLI_GATEWAY",
  "RAVI_DAEMON_RESTART_HANDOFF",
  "RAVI_DAEMON_RESTART_HANDOFF_WORKER",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_SESSION_TOKEN",
  "RAVI_SESSION_CALLBACK_URL",
  "RAVI_AGENT_ID",
  "RAVI_CHANNEL",
  "RAVI_ACCOUNT_ID",
  "RAVI_INSTANCE_ID",
  "RAVI_CANONICAL_CHAT_ID",
  "RAVI_CHAT_ID",
  "RAVI_THREAD_ID",
  "RAVI_SLACK_CONNECTION",
  "RAVI_SLACK_CONNECTIONS",
  "RAVI_SLACK_CREDENTIAL_CONNECTION",
  "RAVI_TASK_ID",
  "RAVI_TASK_PROFILE_ID",
  "RAVI_TASK_SESSION",
  "RAVI_TASK_WORKSPACE",
  "RAVI_TASK_ACTOR",
] as const;

export function clearedPm2ContextEnv(): Record<string, string> {
  // PM2 merges environments on restart; omitted keys retain their old values.
  return Object.fromEntries(PM2_ENV_DENYLIST.map((key) => [key, ""]));
}

export function buildPm2Env(envOverrides?: Record<string, string>): Record<string, string> {
  return {
    ...process.env,
    RAVI_PM2_EXECUTABLE: process.execPath,
    ...envOverrides,
    ...clearedPm2ContextEnv(),
  } as Record<string, string>;
}

/**
 * Check if pm2 is available in PATH.
 */
export function isPm2Available(): boolean {
  try {
    execSync("which pm2", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a pm2 command with inherited stdio.
 */
export function runPm2(
  args: string[],
  envOverrides?: Record<string, string>,
  options: { cwd?: string } = {},
): { status: number } {
  const executable = which("pm2", { PATH: process.env.PATH });
  if (!executable) return { status: 1 };
  const result = spawnSync(executable, args, {
    stdio: "inherit",
    env: buildPm2Env(envOverrides),
    cwd: options.cwd,
  });

  return { status: result.status ?? 1 };
}

/**
 * Run a pm2 command and capture stdout.
 */
export function capturePm2(...args: string[]): string {
  try {
    return execSync(`pm2 ${args.join(" ")}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: any) {
    return err.stdout?.toString()?.trim() ?? "";
  }
}

export interface Pm2Process {
  name: string;
  namespace?: string;
  pm_id: number;
  pid: number;
  status: string;
  cpu: number;
  memory: number;
  execPath?: string | null;
  cwd?: string | null;
  args?: string[];
  createdAt?: number | null;
  /** Start of this PID; PM2 created_at survives some restarts and is not process age. */
  startedAt?: number | null;
}

/**
 * Parse pm2 jlist output into structured data.
 */
export function parsePm2Processes(raw: string): Pm2Process[] {
  const list = parsePm2Jlist(raw);
  return list.map((p: any) => ({
    name: p.name,
    namespace: typeof p.pm2_env?.namespace === "string" ? p.pm2_env.namespace : undefined,
    pm_id: p.pm_id,
    pid: p.pid,
    status: p.pm2_env?.status ?? "unknown",
    cpu: p.monit?.cpu ?? 0,
    memory: p.monit?.memory ?? 0,
    execPath: typeof p.pm2_env?.pm_exec_path === "string" ? p.pm2_env.pm_exec_path : null,
    cwd: typeof p.pm2_env?.pm_cwd === "string" ? p.pm2_env.pm_cwd : null,
    args: Array.isArray(p.pm2_env?.args)
      ? p.pm2_env.args.filter((arg: unknown): arg is string => typeof arg === "string")
      : [],
    createdAt: typeof p.pm2_env?.created_at === "number" ? p.pm2_env.created_at : null,
    startedAt: typeof p.pm2_env?.pm_uptime === "number" ? p.pm2_env.pm_uptime : null,
  }));
}

function parsePm2List(strict = false): Pm2Process[] {
  try {
    const raw = execSync("pm2 jlist", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    if (strict && !raw) throw new Error("Empty PM2 snapshot");
    return parsePm2Processes(raw);
  } catch (cause) {
    if (strict)
      throw new Error("Unable to read the managed PM2 processes; runtime reconciliation cannot be verified.", {
        cause,
      });
    return [];
  }
}

/**
 * Check if the ravi process is running in PM2.
 */
export function isRaviRunning(): boolean {
  return isPm2ProcessRunning(PM2_PROCESS_NAME);
}

/**
 * Get the PID of the ravi PM2 process.
 */
export function getRaviPid(): number | null {
  return getPm2Process(PM2_PROCESS_NAME)?.pid ?? null;
}

/**
 * Get all PM2 processes (for status display).
 */
export function getPm2Processes(options: { strict?: boolean } = {}): Pm2Process[] {
  return parsePm2List(options.strict);
}

export function getPm2Process(name: string): Pm2Process | undefined {
  return parsePm2List().find((p) => p.name === name);
}

export function isPm2ProcessRunning(name: string): boolean {
  return getPm2Process(name)?.status === "online";
}
