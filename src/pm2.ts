/**
 * PM2 Utilities
 *
 * Thin wrapper around pm2 CLI for process management.
 */

import { execSync, spawnSync } from "node:child_process";

export const PM2_PROCESS_NAME = "ravi";
export const CHANNELS_PM2_PROCESS_NAME = "ravi-channels";
const PM2_ENV_DENYLIST = [
  "RAVI_CONTEXT_KEY",
  "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_AGENT_ID",
  "RAVI_CHANNEL",
  "RAVI_ACCOUNT_ID",
  "RAVI_CHAT_ID",
  "RAVI_THREAD_ID",
  "RAVI_SLACK_CONNECTION",
  "RAVI_SLACK_CONNECTIONS",
  "RAVI_SLACK_CREDENTIAL_CONNECTION",
] as const;

export function buildPm2Env(envOverrides?: Record<string, string>): Record<string, string> {
  const env = { ...process.env, ...(envOverrides ?? {}) } as Record<string, string>;
  for (const key of PM2_ENV_DENYLIST) delete env[key];
  return env;
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
  const result = spawnSync("pm2", args, {
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
  pm_id: number;
  pid: number;
  status: string;
  cpu: number;
  memory: number;
  execPath?: string | null;
  cwd?: string | null;
  args?: string[];
  createdAt?: number | null;
}

/**
 * Parse pm2 jlist output into structured data.
 */
function parsePm2List(): Pm2Process[] {
  try {
    const raw = execSync("pm2 jlist", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!raw || raw === "[]") return [];
    const list = JSON.parse(raw);
    return list.map((p: any) => ({
      name: p.name,
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
    }));
  } catch {
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
export function getPm2Processes(): Pm2Process[] {
  return parsePm2List();
}

export function getPm2Process(name: string): Pm2Process | undefined {
  return parsePm2List().find((p) => p.name === name);
}

export function isPm2ProcessRunning(name: string): boolean {
  return getPm2Process(name)?.status === "online";
}
