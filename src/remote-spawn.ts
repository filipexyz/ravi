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
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "./utils/logger.js";

const log = logger.child("remote-spawn");

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

/** Preserve the runtime credential and context when crossing the SSH shell. */
export function buildRemoteEnvSetup(
  host: string,
  env: Record<string, string | undefined>,
  hostEnv: Record<string, string | undefined> = process.env,
): string {
  const forwardedEnv = { ...env };
  forwardedEnv.RAVI_GATEWAY_URL = env.RAVI_GATEWAY_URL || hostEnv.RAVI_GATEWAY_URL;
  // A loopback SSH agent shares the daemon's network namespace, but not its
  // home/state directory. Other hosts need an explicitly reachable gateway URL.
  if (!forwardedEnv.RAVI_GATEWAY_URL && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    const portText = hostEnv.RAVI_HTTP_PORT ?? hostEnv.RAVI_WEBHOOK_PORT;
    const port = Number(portText);
    if (portText?.trim() && Number.isInteger(port) && port > 0 && port <= 65535) {
      const bindHost = hostEnv.RAVI_HTTP_HOST?.trim() || hostEnv.RAVI_WEBHOOK_HOST?.trim() || "127.0.0.1";
      const gatewayHost = bindHost === "::1" || bindHost === "::" ? "[::1]" : "127.0.0.1";
      forwardedEnv.RAVI_GATEWAY_URL = `http://${gatewayHost}:${port}`;
    }
  }

  const forwardKeys = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "RAVI_CONTEXT_KEY", "RAVI_GATEWAY_URL"];
  const exports = forwardKeys.flatMap((key) => {
    const value = forwardedEnv[key];
    return value ? [`export ${key}='${value.replace(/'/g, "'\\''")}'`] : [];
  });
  if (exports.length === 0) return "";

  // These must be real newlines. Literal \\n joins (or a trailing literal \\n)
  // are parsed by the remote shell as part of the preceding credential value.
  const content = exports.join("\n").replace(/'/g, "'\\''");
  return `_e=$(mktemp) && printf '%s' '${content}' > "$_e" && ` + `chmod 600 "$_e" && . "$_e" && rm -f "$_e" && `;
}

/**
 * Create a spawnClaudeCodeProcess function that runs Claude on a remote VM.
 *
 * @param vmId - Proxmox VMID (e.g., "201") or direct IP/hostname
 * @param sshUser - SSH user (default: "root")
 */
export function createRemoteSpawn(vmId: string, sshUser: string = "root"): (options: SpawnOptions) => SpawnedProcess {
  const host = vmId.match(/^\d+$/) ? vmIdToIp(vmId) : vmId;

  return (options: SpawnOptions): SpawnedProcess => {
    const { args, cwd, env, signal } = options;

    const claudeArgs = filterArgs(args);

    const envSetup = buildRemoteEnvSetup(host, env);

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

    const child = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: sshChildEnv,
    });

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
