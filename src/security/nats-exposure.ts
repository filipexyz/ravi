/**
 * NATS exposure probe
 *
 * The local nats-server (started by Omni) runs without auth or TLS. If it
 * listens on a non-loopback interface, any client on the network can subscribe
 * to `>` (every prompt, reply and event) or publish commands. This module
 * answers "can somebody else reach our NATS?" without ever throwing:
 *
 * - local NATS_URL: try a TCP connection to every non-loopback address of this
 *   host on the NATS port and read the server `INFO` line (auth/tls flags);
 * - remote NATS_URL: flag plaintext (non `tls://`) connections unless the
 *   server itself advertises `tls_required`.
 *
 * Everything with side effects (address listing, TCP probe, firewall query) is
 * injectable so the decision logic is unit-tested with fakes only.
 */

import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { createConnection, isIP } from "node:net";
import { networkInterfaces } from "node:os";

export const DEFAULT_NATS_URL = "nats://127.0.0.1:4222";
const DEFAULT_NATS_PORT = 4222;
const DEFAULT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_RESOLVE_TIMEOUT_MS = 1_000;
const MAX_INFO_BYTES = 64 * 1024;

export type NatsExposureStatus =
  | "loopback_only"
  | "exposed"
  | "exposed_auth_required"
  | "remote_plaintext"
  | "remote"
  | "unknown";

export type HostFirewallState = "on" | "off" | "unknown";

export interface NatsProbeResult {
  /** A TCP connection was accepted. */
  reachable: boolean;
  /** Parsed server INFO flags; null when no INFO line was read. */
  authRequired: boolean | null;
  tlsRequired: boolean | null;
}

export type NatsProbe = (host: string, port: number, timeoutMs: number) => Promise<NatsProbeResult>;

export interface NatsExposureDeps {
  listAddresses?: () => string[];
  probe?: NatsProbe;
  readFirewallState?: () => Promise<HostFirewallState>;
  /** Resolve a hostname to its addresses (default: dns lookup, all families). */
  resolveHost?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
}

export interface NatsExposureReport {
  status: NatsExposureStatus;
  natsUrl: string;
  host: string | null;
  port: number | null;
  /** Non-loopback addresses (or the remote host) that accepted a connection. */
  reachableAddresses: string[];
  authRequired: boolean | null;
  tlsRequired: boolean | null;
  firewall: HostFirewallState;
  message: string;
  remediation: string[];
}

const LOCAL_REMEDIATION = [
  "bind nats-server to loopback: start it with `-a 127.0.0.1` (or `listen: 127.0.0.1:4222` in its config)",
  "enable the host firewall (macOS: System Settings > Network > Firewall; Linux: ufw/nftables) and block inbound 4222",
  "never expose or port-forward 4222: this NATS has no auth/TLS, so any client can read every message and publish commands",
];

const REMOTE_REMEDIATION = [
  "use a `tls://` NATS_URL against a TLS-enabled nats-server with auth, or tunnel NATS over SSH/WireGuard",
  "never expose 4222 in plaintext: anyone on the path can read every message and publish commands",
];

export function resolveNatsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.NATS_URL || DEFAULT_NATS_URL;
}

/**
 * Strip any `user:pass@` / `token@` userinfo so the URL is safe to log. Works per
 * comma-separated server, with or without a scheme, and up to the LAST `@` before
 * the path (URL parsing splits there, so passwords containing `@` are covered).
 */
export function redactNatsUrl(natsUrl: string): string {
  return natsUrl
    .split(",")
    .map((segment) => segment.replace(/^(\s*(?:[a-z][\w+.-]*:\/\/)?)[^/\s]*@/i, "$1***@"))
    .join(",");
}

/** true for localhost, 127.0.0.0/8 and ::1 (with or without brackets). */
export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.startsWith("::ffff:")) return isLoopbackHost(normalized.slice("::ffff:".length));
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

interface ParsedNatsUrl {
  scheme: string;
  host: string;
  port: number;
}

/** Every server in a NATS_URL (nats.js accepts comma-separated lists and bare host:port). */
function parseNatsUrls(natsUrl: string): ParsedNatsUrl[] {
  return natsUrl
    .split(",")
    .map((segment) => parseNatsServer(segment))
    .filter((server): server is ParsedNatsUrl => server !== null);
}

function parseNatsServer(segment: string): ParsedNatsUrl | null {
  const first = segment.trim();
  if (!first) return null;
  const withScheme = first.includes("://") ? first : `nats://${first}`;
  try {
    const url = new URL(withScheme);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!host) return null;
    const port = url.port ? Number(url.port) : DEFAULT_NATS_PORT;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { scheme: url.protocol.replace(/:$/, "").toLowerCase(), host, port };
  } catch {
    return null;
  }
}

/** Non-internal IPv4 + IPv6 addresses of this host (link-local IPv6 carries its zone). */
export function listHostAddresses(): string[] {
  const addresses: string[] = [];
  try {
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal) continue;
        if (isLoopbackHost(entry.address)) continue;
        const linkLocal = entry.family === "IPv6" && entry.address.toLowerCase().startsWith("fe80:");
        addresses.push(linkLocal ? `${entry.address}%${name}` : entry.address);
      }
    }
  } catch {
    // best-effort
  }
  return addresses;
}

/** Parse a NATS `INFO {...}` line. Returns null when it is not one. */
export function parseNatsInfoLine(line: string): { authRequired: boolean; tlsRequired: boolean } | null {
  const trimmed = line.trim();
  if (!/^INFO\s/i.test(trimmed)) return null;
  try {
    const info = JSON.parse(trimmed.replace(/^INFO\s+/i, "")) as Record<string, unknown>;
    return { authRequired: info.auth_required === true, tlsRequired: info.tls_required === true };
  } catch {
    return null;
  }
}

/** Open a TCP socket, read the first line (INFO), close. Never throws. */
export const defaultNatsProbe: NatsProbe = (host, port, timeoutMs) =>
  new Promise<NatsProbeResult>((resolve) => {
    let settled = false;
    let connected = false;
    let buffer = "";
    let socket: ReturnType<typeof createConnection> | null = null;

    const finish = (result: NatsProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // best-effort
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ reachable: connected, authRequired: null, tlsRequired: null });
    }, timeoutMs);
    timer.unref?.();

    try {
      socket = createConnection({ host, port });
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        connected = true;
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\r\n");
        if (end === -1 && buffer.length < MAX_INFO_BYTES) return;
        const info = parseNatsInfoLine(end === -1 ? buffer : buffer.slice(0, end));
        finish({ reachable: true, authRequired: info?.authRequired ?? null, tlsRequired: info?.tlsRequired ?? null });
      });
      socket.on("error", () => finish({ reachable: connected, authRequired: null, tlsRequired: null }));
      socket.on("close", () => finish({ reachable: connected, authRequired: null, tlsRequired: null }));
    } catch {
      finish({ reachable: false, authRequired: null, tlsRequired: null });
    }
  });

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

/**
 * Best-effort host firewall state. macOS only (Application Firewall global
 * state, readable without sudo); other platforms report `unknown`.
 */
export function readHostFirewallState(
  deps: { platform?: NodeJS.Platform; execFile?: ExecFileLike } = {},
): Promise<HostFirewallState> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return Promise.resolve("unknown");
  const run = deps.execFile ?? (execFile as unknown as ExecFileLike);
  return new Promise<HostFirewallState>((resolve) => {
    try {
      run(
        "/usr/libexec/ApplicationFirewall/socketfilterfw",
        ["--getglobalstate"],
        { timeout: 2_000 },
        (error, stdout) => {
          if (error) return resolve("unknown");
          resolve(parseFirewallGlobalState(String(stdout)));
        },
      );
    } catch {
      resolve("unknown");
    }
  });
}

export function parseFirewallGlobalState(output: string): HostFirewallState {
  const state = output.match(/State\s*=\s*(\d+)/i);
  if (state) return state[1] === "0" ? "off" : "on";
  if (/disabled/i.test(output)) return "off";
  if (/enabled/i.test(output)) return "on";
  return "unknown";
}

async function safeFirewall(read: () => Promise<HostFirewallState>): Promise<HostFirewallState> {
  try {
    return await read();
  } catch {
    return "unknown";
  }
}

/** Resolve a hostname with a timeout; [] on failure. Never throws. */
async function safeResolve(resolveHost: (host: string) => Promise<string[]>, host: string): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([]), DEFAULT_RESOLVE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([resolveHost(host).catch(() => [] as string[]), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const defaultResolveHost = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

async function safeProbe(probe: NatsProbe, host: string, port: number, timeoutMs: number): Promise<NatsProbeResult> {
  try {
    return await probe(host, port, timeoutMs);
  } catch {
    return { reachable: false, authRequired: null, tlsRequired: null };
  }
}

/** Probe whether the NATS server behind `natsUrl` is reachable from the network. Never throws. */
export async function probeNatsExposure(
  natsUrl: string = resolveNatsUrl(),
  deps: NatsExposureDeps = {},
): Promise<NatsExposureReport> {
  const probe = deps.probe ?? defaultNatsProbe;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const firewallPromise = safeFirewall(deps.readFirewallState ?? (() => readHostFirewallState()));

  const base = {
    natsUrl: redactNatsUrl(natsUrl),
    reachableAddresses: [] as string[],
    authRequired: null as boolean | null,
    tlsRequired: null as boolean | null,
  };

  const servers = parseNatsUrls(natsUrl);
  if (servers.length === 0) {
    return {
      ...base,
      status: "unknown",
      host: null,
      port: null,
      firewall: await firewallPromise,
      message: `could not parse NATS_URL ${JSON.stringify(redactNatsUrl(natsUrl))}; NATS exposure was not checked`,
      remediation: LOCAL_REMEDIATION,
    };
  }

  let hostAddresses: string[] = [];
  try {
    hostAddresses = (deps.listAddresses ?? listHostAddresses)();
  } catch {
    hostAddresses = [];
  }
  const nonLoopback = hostAddresses.filter((address) => !isLoopbackHost(address));
  const isOwnAddress = (address: string) =>
    isLoopbackHost(address) || isWildcardHost(address) || nonLoopback.includes(address);
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const isLocalServer = async (server: ParsedNatsUrl): Promise<boolean> => {
    if (isOwnAddress(server.host)) return true;
    if (isIP(server.host) !== 0) return false;
    // A hostname (e.g. from /etc/hosts) is local only when every address it resolves to is ours.
    const resolved = await safeResolve(resolveHost, server.host);
    return resolved.length > 0 && resolved.every(isOwnAddress);
  };

  const classified = await Promise.all(servers.map(async (server) => ({ server, local: await isLocalServer(server) })));
  const remoteServers = classified.filter((entry) => !entry.local).map((entry) => entry.server);
  const localServer = classified.find((entry) => entry.local)?.server;

  const remoteChecks = await Promise.all(
    remoteServers.map(async (server) => {
      const result = server.scheme === "tls" ? null : await safeProbe(probe, server.host, server.port, timeoutMs);
      const encrypted = server.scheme === "tls" || result?.tlsRequired === true;
      return { server, result, encrypted, where: `${server.host}:${server.port}` };
    }),
  );
  const plaintext = remoteChecks.filter((check) => !check.encrypted);

  if (plaintext.length > 0 || !localServer) {
    const firewall = await firewallPromise;
    const shown = plaintext[0] ?? remoteChecks[0];
    const encrypted = plaintext.length === 0;
    const where = (encrypted ? remoteChecks : plaintext).map((check) => check.where).join(", ");
    return {
      ...base,
      host: shown.server.host,
      port: shown.server.port,
      reachableAddresses: remoteChecks.filter((check) => check.result?.reachable).map((check) => check.where),
      authRequired: shown.result?.authRequired ?? null,
      tlsRequired: shown.server.scheme === "tls" ? true : (shown.result?.tlsRequired ?? null),
      firewall,
      status: encrypted ? "remote" : "remote_plaintext",
      message: encrypted
        ? `NATS is remote (${where}) over TLS`
        : `NATS is remote (${where}) over plaintext: prompts, replies and events cross the network unencrypted`,
      remediation: encrypted ? [] : REMOTE_REMEDIATION,
    };
  }

  const parsed = localServer;

  const results = await Promise.all(
    nonLoopback.map(async (address) => ({
      address,
      result: await safeProbe(probe, address, parsed.port, timeoutMs),
    })),
  );
  const firewall = await firewallPromise;
  const reachable = results.filter((entry) => entry.result.reachable);
  const reachableAddresses = reachable.map((entry) => `${entry.address}:${parsed.port}`);
  const common = { ...base, host: parsed.host, port: parsed.port, reachableAddresses, firewall };

  if (reachable.length === 0) {
    return {
      ...common,
      status: "loopback_only",
      message: `NATS port ${parsed.port} is not reachable on any non-loopback address`,
      remediation: [],
    };
  }

  const unauthenticated = reachable.some((entry) => entry.result.authRequired !== true);
  const authRequired = !unauthenticated;
  const tlsRequired = reachable.every((entry) => entry.result.tlsRequired === true);
  if (!unauthenticated) {
    return {
      ...common,
      authRequired,
      tlsRequired,
      status: "exposed_auth_required",
      message: `NATS port ${parsed.port} is reachable from the network (${reachableAddresses.join(", ")}) but requires auth`,
      remediation: LOCAL_REMEDIATION,
    };
  }

  return {
    ...common,
    authRequired,
    tlsRequired,
    status: "exposed",
    message:
      `NATS port ${parsed.port} accepts unauthenticated connections from the network ` +
      `(${reachableAddresses.join(", ")}): anyone who can reach it can read every message and publish commands`,
    remediation: LOCAL_REMEDIATION,
  };
}

export const REQUIRE_PRIVATE_NATS_ENV = "RAVI_REQUIRE_PRIVATE_NATS";

export function isPrivateNatsRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REQUIRE_PRIVATE_NATS_ENV] === "1";
}

/** Statuses that mean NATS traffic is readable/writable by others. */
export function isRiskyNatsExposure(status: NatsExposureStatus): boolean {
  return status === "exposed" || status === "remote_plaintext";
}

export type NatsExposureBootAction = "none" | "warn" | "refuse";

/**
 * Daemon boot decision. `refuse` only when RAVI_REQUIRE_PRIVATE_NATS=1; with
 * that flag an `unknown` result also refuses (fail closed).
 */
export function decideNatsExposureBootAction(
  report: Pick<NatsExposureReport, "status">,
  options: { requirePrivate: boolean },
): NatsExposureBootAction {
  const risky = isRiskyNatsExposure(report.status);
  if (options.requirePrivate && (risky || report.status === "unknown")) return "refuse";
  return risky ? "warn" : "none";
}

/** Structured log payload for a boot warning/refusal. */
export function natsExposureLogData(report: NatsExposureReport): Record<string, unknown> {
  return {
    status: report.status,
    natsUrl: report.natsUrl,
    reachableAddresses: report.reachableAddresses,
    authRequired: report.authRequired,
    tlsRequired: report.tlsRequired,
    firewall: report.firewall,
    remediation: report.remediation,
  };
}
