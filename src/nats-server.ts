/**
 * Ravi's own nats-server provisioning (D15).
 *
 * `ravi setup` reuses whatever NATS already answers on the configured URL. On existing hosts that is usually the
 * `omni-nats` PM2 process, and it holds Ravi's streams (SESSION_PROMPTS, RAVI_EVENTS, CHANNEL_INBOUND): nothing here
 * ever stops, deletes or restarts it. Only when no NATS answers does setup download a pinned nats-server binary into
 * `~/.ravi/bin` and start it under PM2 as `ravi-nats`.
 *
 * This module only computes paths/arguments, probes a socket and downloads the binary. It never talks to PM2.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { getRaviStateDir } from "./utils/paths.js";

/** Pinned nats-server release used by `ravi setup` and the E2B sandbox template. */
export const NATS_SERVER_VERSION = "2.11.8";
/** PM2 process name of the nats-server Ravi provisions itself. */
export const NATS_PM2_PROCESS = "ravi-nats";
/** PM2 process name of the nats-server the Omni CLI installs (Ravi's NATS on hosts set up before D15). */
export const OMNI_NATS_PM2_PROCESS = "omni-nats";
/** Same default as `src/nats.ts`. */
export const DEFAULT_NATS_URL = "nats://127.0.0.1:4222";

const DEFAULT_NATS_PORT = 4222;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

export interface NatsEndpoint {
  host: string;
  port: number;
  /** True when the host is this machine, i.e. a local nats-server could serve it. */
  loopback: boolean;
}

/** Parse `nats://host:port` (scheme optional, first server of a comma list). Throws on an unparseable URL. */
export function parseNatsEndpoint(url: string = DEFAULT_NATS_URL): NatsEndpoint {
  const first = (url.split(",")[0] ?? "").trim() || DEFAULT_NATS_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `nats://${first}`;
  const parsed = new URL(withScheme);
  const host = parsed.hostname || "127.0.0.1";
  const port = parsed.port ? Number(parsed.port) : DEFAULT_NATS_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid NATS port in ${url}`);
  }
  return { host, port, loopback: LOOPBACK_HOSTS.has(host.toLowerCase()) };
}

/** Minimal socket surface `isNatsReachable` needs; `node:net` sockets satisfy it. */
export interface NatsProbeSocket {
  once(event: "connect", listener: () => void): unknown;
  once(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: () => void): unknown;
  destroy(): unknown;
}

export interface IsNatsReachableOptions {
  timeoutMs?: number;
  /** Socket factory seam (tests). Defaults to `net.createConnection`. */
  connect?: (port: number, host: string) => NatsProbeSocket;
}

/**
 * True when a NATS server answers on `url`: a TCP connection opens and the server greets with its `INFO` line.
 * Anything else (refused, timeout, a non-NATS listener) is false. Never throws.
 */
export function isNatsReachable(
  url: string = DEFAULT_NATS_URL,
  options: IsNatsReachableOptions = {},
): Promise<boolean> {
  let endpoint: NatsEndpoint;
  try {
    endpoint = parseNatsEndpoint(url);
  } catch {
    return Promise.resolve(false);
  }
  const timeoutMs = options.timeoutMs ?? 1500;
  const connect = options.connect ?? ((port: number, host: string) => createConnection({ port, host }));

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let socket: NatsProbeSocket | null = null;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        /* already closed */
      }
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = connect(endpoint.port, endpoint.host.replace(/^\[|\]$/g, ""));
    } catch {
      finish(false);
      return;
    }
    socket.once("data", (chunk) => finish(String(chunk).startsWith("INFO ")));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

export interface NatsServerArgsOptions {
  /** JetStream store dir. Default `~/.ravi/jetstream`. */
  storeDir?: string;
  host?: string;
  port?: number;
}

/** nats-server CLI arguments: `-js -sd <storeDir> -a <host> -p <port>`. */
export function natsServerArgs(options: NatsServerArgsOptions = {}): string[] {
  const storeDir = options.storeDir ?? join(getRaviStateDir(), "jetstream");
  return ["-js", "-sd", storeDir, "-a", options.host ?? "127.0.0.1", "-p", String(options.port ?? DEFAULT_NATS_PORT)];
}

/** `pm2 start <bin> --name ravi-nats --interpreter none -- <natsServerArgs>`. */
export function natsPm2StartArgs(binaryPath: string, options: NatsServerArgsOptions = {}): string[] {
  return ["start", binaryPath, "--name", NATS_PM2_PROCESS, "--interpreter", "none", "--", ...natsServerArgs(options)];
}

export interface NatsPm2ProcessLike {
  name: string;
  status?: string;
}

/**
 * The PM2 process that owns the local NATS: the first ONLINE process among `ravi-nats` and `omni-nats`, else null
 * (NATS not managed by PM2, or not running).
 */
export function findNatsPm2Owner<T extends NatsPm2ProcessLike>(processes: readonly T[]): T | null {
  for (const name of [NATS_PM2_PROCESS, OMNI_NATS_PM2_PROCESS]) {
    const owner = processes.find((process) => process.name === name && process.status === "online");
    if (owner) return owner;
  }
  return null;
}

export interface NatsReleaseAsset {
  /** Archive base name, also the directory the archive extracts to. */
  name: string;
  url: string;
}

const RELEASE_OS: Readonly<Partial<Record<NodeJS.Platform, string>>> = { linux: "linux", darwin: "darwin" };
const RELEASE_ARCH: Readonly<Record<string, string>> = { x64: "amd64", amd64: "amd64", arm64: "arm64" };

/** GitHub release asset for linux/darwin × amd64/arm64. Throws for any other platform. */
export function natsServerReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  version: string = NATS_SERVER_VERSION,
): NatsReleaseAsset {
  const os = RELEASE_OS[platform];
  const cpu = RELEASE_ARCH[arch];
  if (!os || !cpu) {
    throw new Error(`nats-server download is not supported on ${platform}/${arch}; install nats-server manually.`);
  }
  const name = `nats-server-v${version}-${os}-${cpu}`;
  return { name, url: `https://github.com/nats-io/nats-server/releases/download/v${version}/${name}.tar.gz` };
}

/** `<stateDir>/bin/nats-server` (default `~/.ravi/bin/nats-server`). */
export function natsServerBinaryPath(stateDir: string = getRaviStateDir()): string {
  return join(stateDir, "bin", "nats-server");
}

export interface EnsureNatsServerBinaryOptions {
  stateDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  version?: string;
  /** Command runner seam (tests). Must throw on failure. Defaults to a synchronous spawn. */
  run?: (command: string, args: string[]) => void;
}

export interface NatsServerBinary {
  path: string;
  version: string;
  downloaded: boolean;
  /** Download URL when downloaded, else null. */
  url: string | null;
}

function runChecked(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * Return `~/.ravi/bin/nats-server`, downloading the pinned release first when it is missing
 * (curl + tar into a temp dir next to it, then an atomic rename). Throws when the download fails.
 */
export async function ensureNatsServerBinary(options: EnsureNatsServerBinaryOptions = {}): Promise<NatsServerBinary> {
  const version = options.version ?? NATS_SERVER_VERSION;
  const path = natsServerBinaryPath(options.stateDir);
  if (existsSync(path)) return { path, version, downloaded: false, url: null };

  const asset = natsServerReleaseAsset(options.platform, options.arch, version);
  const run = options.run ?? runChecked;
  const binDir = join(path, "..");
  mkdirSync(binDir, { recursive: true });
  const workDir = mkdtempSync(join(binDir, ".nats-download-"));
  try {
    const archive = join(workDir, `${asset.name}.tar.gz`);
    run("curl", ["-fsSL", "--retry", "2", "-o", archive, asset.url]);
    run("tar", ["-xzf", archive, "-C", workDir]);
    const extracted = join(workDir, asset.name, "nats-server");
    if (!existsSync(extracted)) {
      throw new Error(`nats-server not found in ${asset.name}.tar.gz`);
    }
    chmodSync(extracted, 0o755);
    renameSync(extracted, path);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return { path, version, downloaded: true, url: asset.url };
}
