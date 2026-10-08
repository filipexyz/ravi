/**
 * Remote Spawn — runs Claude Code on a Proxmox VM via SSH
 *
 * Implements the SDK's SpawnedProcess interface by spawning an SSH process
 * that executes `claude` on the remote VM. The SSH tunnel carries stdin/stdout
 * natively, making it transparent to the SDK.
 *
 * The SDK normally spawns: `bun /path/to/node_modules/.../cli.js <args>`
 * We intercept this and run: `ssh user@vm claude <args>` instead,
 * stripping local paths and adapting args for the remote environment.
 *
 * Credentials (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) never appear in the
 * ssh argv: argv is visible in local `ps` and becomes the remote shell's command
 * line. Instead the remote command reads each value from stdin (`IFS= read -r`)
 * before starting claude, and we write the values to the ssh stdin first.
 */

import { spawn, type ChildProcess, type SpawnOptions as ChildSpawnOptions } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "./utils/logger.js";

const log = logger.child("remote-spawn");

/** Auth env vars handed to the remote claude via stdin (never via argv). */
const FORWARDED_ENV_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** Spawn implementation (injectable for tests). */
export type RemoteSpawnImpl = (command: string, args: string[], options: ChildSpawnOptions) => ChildProcess;

/** Convert a VMID to an IP address (static scheme: 10.10.10.{vmid}) */
export function vmIdToIp(vmId: string): string {
  return `10.10.10.${vmId}`;
}

/**
 * Filter SDK args for remote execution.
 * - Strips the local CLI entry point (cli.js/sdk.mjs)
 * - Removes --plugin-dir flags (local paths won't exist on VM)
 * - Removes --setting-sources (project settings are local)
 * - Keeps everything else (model, format, permissions, etc.)
 *
 * NOTE: Update this list when the SDK adds new flags with local paths.
 */
function filterArgs(args: string[]): string[] {
  const filtered: string[] = [];
  let skipNext = false;

  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    const arg = args[i];

    // Skip the CLI entry point (first arg is usually a .js/.mjs path)
    if (i === 0 && (arg.endsWith(".js") || arg.endsWith(".mjs"))) {
      continue;
    }

    // Skip --plugin-dir <path> (local paths won't exist on VM)
    if (arg === "--plugin-dir") {
      skipNext = true;
      continue;
    }

    // Skip --setting-sources (project settings are local)
    if (arg === "--setting-sources") {
      skipNext = true;
      continue;
    }

    filtered.push(arg);
  }

  return filtered;
}

/**
 * Create a spawnClaudeCodeProcess function that runs Claude on a remote VM.
 *
 * @param vmId - Proxmox VMID (e.g., "201") or direct IP/hostname
 * @param sshUser - SSH user (default: "root")
 */
export function createRemoteSpawn(
  vmId: string,
  sshUser: string = "root",
  spawnImpl: RemoteSpawnImpl = spawn,
): (options: SpawnOptions) => SpawnedProcess {
  const host = vmId.match(/^\d+$/) ? vmIdToIp(vmId) : vmId;

  return (options: SpawnOptions): SpawnedProcess => {
    const { args, cwd, env, signal } = options;

    const claudeArgs = filterArgs(args);

    // Credentials go over the ssh stdin, never argv. For each key present the
    // remote command starts with `IFS= read -r KEY && export KEY && ` (key names
    // come from the fixed list above, values are never interpolated), and right
    // after spawn() we write the values, one per line, in the same order. POSIX
    // shells read a pipe byte-by-byte for `read`, so they consume exactly one
    // line each and the rest of stdin (the SDK's stream-json) reaches claude.
    const credentialKeys: string[] = [];
    const credentialValues: string[] = [];
    for (const key of FORWARDED_ENV_KEYS) {
      const val = env[key];
      if (!val) continue;
      if (/[\r\n]/.test(val)) {
        throw new Error(`Refusing remote spawn: ${key} contains a newline and cannot be passed over stdin`);
      }
      credentialKeys.push(key);
      credentialValues.push(val);
    }
    const envSetup = credentialKeys.map((key) => `IFS= read -r ${key} && export ${key} && `).join("");

    // Use home dir on VM — local macOS/Linux paths won't exist remotely
    const remoteCwd = cwd && !cwd.startsWith("/Users/") && !cwd.startsWith("/home/") ? cwd : undefined;
    const cdPrefix = remoteCwd ? `cd '${remoteCwd.replace(/'/g, "'\\''")}' && ` : "";

    // Build remote command: claude <args>
    const quotedArgs = claudeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const remoteCmd = `${cdPrefix}${envSetup}claude ${quotedArgs}`;

    log.info("Spawning remote Claude process", {
      host,
      claudeArgs,
      remoteCwd: remoteCwd ?? "(home)",
      credentialKeys,
    });

    // SSH config: accept-new for TOFU (trust on first use) — safer than StrictHostKeyChecking=no
    // Uses a dedicated known_hosts file for ravi VMs
    const raviKnownHosts = join(homedir(), ".ravi", "known_hosts");
    const sshKeyPath = join(homedir(), ".ssh", "id_ed25519");

    const sshArgs = [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${raviKnownHosts}`,
      "-o",
      "LogLevel=ERROR",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "BatchMode=yes",
      "-i",
      sshKeyPath,
      "-T", // no pseudo-terminal
      `${sshUser}@${host}`,
      remoteCmd,
    ];

    // Minimal env for SSH child — only what SSH needs to function
    const sshChildEnv: Record<string, string> = {
      HOME: env.HOME ?? process.env.HOME ?? homedir(),
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
    };
    if (env.SSH_AUTH_SOCK) sshChildEnv.SSH_AUTH_SOCK = env.SSH_AUTH_SOCK;
    else if (process.env.SSH_AUTH_SOCK) sshChildEnv.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;

    const child = spawnImpl("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: sshChildEnv,
    });

    child.stdin?.on("error", (err: Error) => {
      log.warn("Remote stdin error", { host, error: err.message });
    });

    // Feed credentials before returning the child, so they precede every SDK write.
    for (const value of credentialValues) {
      child.stdin?.write(`${value}\n`);
    }

    // Log stderr — errors as warn, debug info as debug
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        const level = /error|denied|refused|timeout/i.test(text) ? "warn" : "debug";
        log[level]("Remote stderr", { host, text: text.slice(0, 500) });
      }
    });

    child.on("exit", (code, sig) => {
      log.info("Remote process exited", { host, code, signal: sig });
    });

    // Handle abort signal
    if (signal) {
      const onAbort = () => {
        log.info("Aborting remote process", { host, pid: child.pid });
        child.kill("SIGTERM");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("exit", () => signal.removeEventListener("abort", onAbort));
    }

    return child as unknown as SpawnedProcess;
  };
}
