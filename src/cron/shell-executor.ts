import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export const DEFAULT_CRON_SHELL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CAPTURE_CHARS = 64 * 1024;

export interface ShellCronRunOptions {
  timeoutMs?: number;
  envFile?: string;
}

export interface ShellCronRunResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

function appendLimited(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (next.length <= MAX_CAPTURE_CHARS) return next;
  return next.slice(next.length - MAX_CAPTURE_CHARS);
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = normalized.indexOf("=");
    if (eq <= 0) continue;

    const key = normalized.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    env[key] = unquoteEnvValue(normalized.slice(eq + 1));
  }
  return env;
}

function loadEnvFile(path: string | undefined): Record<string, string> {
  if (!path) return {};
  const resolvedPath = path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
  if (!existsSync(resolvedPath)) {
    throw new Error(`Env file not found: ${path}`);
  }
  return parseEnvFile(readFileSync(resolvedPath, "utf8"));
}

export async function runShellCronCommand(
  command: string,
  options: ShellCronRunOptions = {},
): Promise<ShellCronRunResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_CRON_SHELL_TIMEOUT_MS;
  const env = { ...process.env, ...loadEnvFile(options.envFile) };

  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      detached,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const killChild = (signal: NodeJS.Signals) => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to direct child kill below.
        }
      }
      child.kill(signal);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killChild("SIGTERM");
      killTimer = setTimeout(() => killChild("SIGKILL"), 5_000);
      killTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();

    child.stdout?.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        command,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}
