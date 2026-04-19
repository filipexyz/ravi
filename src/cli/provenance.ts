import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename } from "node:path";
import { getContext } from "./context.js";
import { RAVI_CONTEXT_KEY_ENV } from "../runtime/context-registry.js";

const MAX_ARG_LENGTH = 240;
const MAX_ARG_COUNT = 80;
const SENSITIVE_KEY_PATTERN = /(token|secret|password|passwd|pwd|api[-_]?key|auth|bearer|credential|context[-_]?key)/i;

export interface CliInvocationMetadata {
  invocationId: string;
  command?: {
    group?: string;
    name?: string;
    tool?: string;
  };
  process: {
    pid: number;
    ppid: number;
    execPath: string;
    argv: string[];
    title?: string;
    cwd: string;
    uid?: number;
    gid?: number;
    user?: string;
  };
  parentProcess?: {
    pid: number;
    command?: string;
    argv?: string[];
    cwd?: string;
    exe?: string;
  };
  host: {
    hostname: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  terminal: {
    stdinIsTTY: boolean;
    stdoutIsTTY: boolean;
    stderrIsTTY: boolean;
    tty?: string;
    term?: string;
    shell?: string;
  };
  runtime: {
    nodeVersion: string;
    bunVersion?: string;
    packageVersion?: string;
  };
  ssh?: {
    present: boolean;
    connectionHash?: string;
    clientHash?: string;
    remoteAddressHash?: string;
  };
  raviContext: {
    hasContextKey: boolean;
    contextKeyHash?: string;
    contextIdHash?: string;
    sessionKey?: string;
    sessionName?: string;
    agentId?: string;
    source?: {
      channel?: string;
      accountId?: string;
      chatIdHash?: string;
    };
  };
}

export function hashForAudit(value: string | null | undefined, length = 16): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function sanitizeCliArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let redactNext = false;

  for (const rawArg of argv.slice(0, MAX_ARG_COUNT)) {
    const arg = truncateAuditString(rawArg);

    if (redactNext) {
      out.push("[REDACTED]");
      redactNext = false;
      continue;
    }

    const eqIndex = arg.indexOf("=");
    if (eqIndex > 0) {
      const key = arg.slice(0, eqIndex);
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out.push(`${key}=[REDACTED]`);
        continue;
      }
    }

    if (SENSITIVE_KEY_PATTERN.test(arg.replace(/^--?/, ""))) {
      out.push(arg);
      redactNext = true;
      continue;
    }

    out.push(arg);
  }

  if (argv.length > MAX_ARG_COUNT) out.push(`...[${argv.length - MAX_ARG_COUNT} more]`);
  return out;
}

export function buildCliInvocationMetadata(command?: {
  group?: string;
  name?: string;
  tool?: string;
}): CliInvocationMetadata {
  const ctx = getContext();
  const contextKey = process.env[RAVI_CONTEXT_KEY_ENV];
  const sshConnection = process.env.SSH_CONNECTION;
  const sshClient = process.env.SSH_CLIENT;
  const user = safeUserInfo();
  const parentProcess = getParentProcessMetadata(process.ppid);

  return {
    invocationId: randomUUID(),
    ...(command ? { command } : {}),
    process: {
      pid: process.pid,
      ppid: process.ppid,
      execPath: process.execPath,
      argv: sanitizeCliArgv(process.argv),
      title: truncateAuditString(process.title),
      cwd: process.cwd(),
      ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
      ...(typeof process.getgid === "function" ? { gid: process.getgid() } : {}),
      ...(user ? { user } : {}),
    },
    ...(parentProcess ? { parentProcess } : {}),
    host: {
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
    },
    terminal: {
      stdinIsTTY: Boolean(process.stdin.isTTY),
      stdoutIsTTY: Boolean(process.stdout.isTTY),
      stderrIsTTY: Boolean(process.stderr.isTTY),
      ...(process.env.TTY ? { tty: truncateAuditString(process.env.TTY) } : {}),
      ...(process.env.TERM ? { term: truncateAuditString(process.env.TERM) } : {}),
      ...(process.env.SHELL ? { shell: basename(process.env.SHELL) } : {}),
    },
    runtime: {
      nodeVersion: process.versions.node,
      ...(process.versions.bun ? { bunVersion: process.versions.bun } : {}),
      ...(process.env.npm_package_version
        ? { packageVersion: truncateAuditString(process.env.npm_package_version) }
        : {}),
    },
    ...(sshConnection || sshClient
      ? {
          ssh: {
            present: true,
            ...(sshConnection ? { connectionHash: hashForAudit(sshConnection) } : {}),
            ...(sshClient ? { clientHash: hashForAudit(sshClient) } : {}),
            ...(sshConnection ? { remoteAddressHash: hashForAudit(sshConnection.split(/\s+/)[0]) } : {}),
          },
        }
      : {}),
    raviContext: {
      hasContextKey: Boolean(contextKey),
      ...(contextKey ? { contextKeyHash: hashForAudit(contextKey) } : {}),
      ...(ctx?.contextId ? { contextIdHash: hashForAudit(ctx.contextId) } : {}),
      ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      ...(ctx?.sessionName ? { sessionName: ctx.sessionName } : {}),
      ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx?.source
        ? {
            source: {
              channel: ctx.source.channel,
              accountId: ctx.source.accountId,
              chatIdHash: hashForAudit(ctx.source.chatId),
            },
          }
        : {}),
    },
  };
}

function truncateAuditString(value: string): string {
  return value.length > MAX_ARG_LENGTH ? `${value.slice(0, MAX_ARG_LENGTH)}...` : value;
}

function safeUserInfo(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

function getParentProcessMetadata(pid: number): CliInvocationMetadata["parentProcess"] | undefined {
  if (!pid || pid <= 0 || process.platform !== "linux") return undefined;

  const argv = readProcCmdline(pid);
  const command = readProcText(pid, "comm")?.trim();
  const cwd = readProcLink(pid, "cwd");
  const exe = readProcLink(pid, "exe");

  if (!argv && !command && !cwd && !exe) return undefined;

  return {
    pid,
    ...(command ? { command: truncateAuditString(command) } : {}),
    ...(argv ? { argv } : {}),
    ...(cwd ? { cwd: truncateAuditString(cwd) } : {}),
    ...(exe ? { exe: truncateAuditString(exe) } : {}),
  };
}

function readProcText(pid: number, name: string): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/${name}`, "utf8");
  } catch {
    return undefined;
  }
}

function readProcLink(pid: number, name: string): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/${name}`);
  } catch {
    return undefined;
  }
}

function readProcCmdline(pid: number): string[] | undefined {
  const raw = readProcText(pid, "cmdline");
  if (!raw) return undefined;
  const argv = raw.split("\0").filter(Boolean);
  if (argv.length === 0) return undefined;
  return sanitizeCliArgv(argv);
}
