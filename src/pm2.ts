/**
 * PM2 Utilities
 *
 * Thin wrapper around pm2 CLI for process management.
 */

import { execSync, spawnSync } from "node:child_process";

export const PM2_PROCESS_NAME = "ravi";
export const CHANNELS_PM2_PROCESS_NAME = "ravi-channels";

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
  const env = envOverrides ? { ...process.env, ...envOverrides } : process.env;

  const result = spawnSync("pm2", args, {
    stdio: "inherit",
    env: env as Record<string, string>,
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

interface Pm2Process {
  name: string;
  pm_id: number;
  pid: number;
  status: string;
  cpu: number;
  memory: number;
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
