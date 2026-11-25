/**
 * Omni database authentication probe
 *
 * Omni keeps every WhatsApp message in PostgreSQL. When that server accepts
 * Omni's user without a password (a `trust` line in pg_hba.conf), any process
 * on the host, under any system user, reads and writes the whole history.
 * Ravi does not install that database, so it cannot fix the rule; it can see
 * it. This module answers one question without ever throwing: does the
 * database in Omni's config log Omni's user in without a password?
 *
 * The probe opens a TCP connection, sends a PostgreSQL StartupMessage with
 * the user and database from the URL and reads the first reply. It never
 * sends a password and never runs a query: an AuthenticationOk reply is
 * answered with Terminate. Only loopback hosts are probed, because the
 * question is about this host.
 *
 * The socket is injectable so the decision logic is unit-tested with fakes.
 */

import { createConnection } from "node:net";
import { userInfo } from "node:os";

const DEFAULT_PORT = 5432;
const DEFAULT_TIMEOUT_MS = 1_000;
const PROTOCOL_VERSION_3 = 196_608;
const AUTH_OK = 0;

export type OmniDbAuthStatus =
  /** The server asked for a password (or another credential). */
  | "password_required"
  /** The server let Omni's user in with no credential: a `trust` rule. */
  | "no_password_login"
  /** The server refused the startup before any authentication (no pg_hba entry, unknown role). */
  | "rejected"
  /** Omni has no database URL in its config. */
  | "not_configured"
  /** The database is on another host; it is not probed. */
  | "remote"
  /** The probe could not reach the server or read a reply. */
  | "unknown";

/** What the server answered to the StartupMessage. */
export type PgStartupReply =
  | { kind: "auth_ok" }
  | { kind: "auth_required"; method: number }
  | { kind: "error" }
  | { kind: "unreachable" };

export type PgStartupProbe = (
  host: string,
  port: number,
  user: string,
  database: string,
  timeoutMs: number,
) => Promise<PgStartupReply>;

export interface OmniDbAuthDeps {
  probe?: PgStartupProbe;
  timeoutMs?: number;
  /** User libpq falls back to when the URL has none. */
  defaultUser?: () => string;
}

export interface OmniDbAuthReport {
  status: OmniDbAuthStatus;
  /** The database URL with any password removed. */
  databaseUrl: string | null;
  host: string | null;
  port: number | null;
  user: string | null;
  database: string | null;
  /** Loopback addresses that let the user in without a password. */
  passwordlessAddresses: string[];
  message: string;
  remediation: string[];
}

const REMEDIATION = [
  "replace the `trust` lines for Omni's database in pg_hba.conf with `scram-sha-256`",
  "give Omni's database role a password and put it in Omni's database URL (`server.databaseUrl` in ~/.omni/config.json)",
  "reload PostgreSQL, restart Omni, and check that WhatsApp still sends and receives",
];

/** Omni's database URL: `server.databaseUrl` in ~/.omni/config.json. */
export function omniDatabaseUrlFromConfig(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const server = (config as { server?: unknown }).server;
  if (!server || typeof server !== "object") return null;
  const url = (server as { databaseUrl?: unknown }).databaseUrl;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

/** The URL with its password replaced, safe to print. */
export function redactDatabaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "<unparseable database url>";
  }
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Loopback addresses to probe for a host, or null when the host is not this machine. */
export function loopbackAddressesFor(host: string): string[] | null {
  const bare = stripBrackets(host).toLowerCase();
  if (bare === "localhost" || bare === "") return ["127.0.0.1", "::1"];
  if (bare === "::1") return ["::1"];
  if (/^127(\.\d{1,3}){3}$/.test(bare)) return [bare];
  return null;
}

export async function probeOmniDatabaseAuth(
  databaseUrl: string | null,
  deps: OmniDbAuthDeps = {},
): Promise<OmniDbAuthReport> {
  const empty = {
    databaseUrl: databaseUrl ? redactDatabaseUrl(databaseUrl) : null,
    host: null,
    port: null,
    user: null,
    database: null,
    passwordlessAddresses: [],
    remediation: [],
  };
  if (!databaseUrl) {
    return { ...empty, status: "not_configured", message: "Omni has no database URL in its config" };
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return { ...empty, status: "unknown", message: "Omni's database URL could not be parsed" };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return { ...empty, status: "unknown", message: `Omni's database URL is not a PostgreSQL URL (${url.protocol})` };
  }

  const host = url.hostname;
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  const user = decodeURIComponent(url.username) || (deps.defaultUser ?? (() => userInfo().username))();
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || user;
  const located = { ...empty, host: stripBrackets(host), port, user, database };

  const addresses = loopbackAddressesFor(host);
  if (!addresses) {
    return {
      ...located,
      status: "remote",
      message: `Omni's database is on another host (${stripBrackets(host)}); not probed`,
    };
  }

  const probe = deps.probe ?? startupProbe;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const replies = await Promise.all(
    addresses.map(async (address) => {
      try {
        return { address, reply: await probe(address, port, user, database, timeoutMs) };
      } catch {
        return { address, reply: { kind: "unreachable" } as PgStartupReply };
      }
    }),
  );

  const passwordless = replies.filter((r) => r.reply.kind === "auth_ok").map((r) => r.address);
  if (passwordless.length > 0) {
    return {
      ...located,
      status: "no_password_login",
      passwordlessAddresses: passwordless,
      message: `Omni's database lets user "${user}" log in to "${database}" without a password on ${passwordless.join(", ")}: any process on this host can read and change every WhatsApp message`,
      remediation: REMEDIATION,
    };
  }
  if (replies.some((r) => r.reply.kind === "auth_required")) {
    return { ...located, status: "password_required", message: `Omni's database asks user "${user}" for a password` };
  }
  if (replies.some((r) => r.reply.kind === "error")) {
    return { ...located, status: "rejected", message: `Omni's database refused user "${user}" before authentication` };
  }
  return {
    ...located,
    status: "unknown",
    message: `Omni's database did not answer on ${addresses.join(", ")}:${port}`,
  };
}

/** Bytes of a PostgreSQL v3 StartupMessage for this user and database. */
export function buildStartupMessage(user: string, database: string): Buffer {
  const params = Buffer.from(`user\0${user}\0database\0${database}\0\0`, "utf8");
  const message = Buffer.alloc(8 + params.length);
  message.writeInt32BE(message.length, 0);
  message.writeInt32BE(PROTOCOL_VERSION_3, 4);
  params.copy(message, 8);
  return message;
}

/** Classifies the first backend message; null while it is incomplete. */
export function classifyStartupReply(data: Buffer): PgStartupReply | null {
  if (data.length < 1) return null;
  const type = String.fromCharCode(data[0]);
  if (type === "E") return { kind: "error" };
  if (type !== "R") return { kind: "error" };
  if (data.length < 9) return null;
  const method = data.readInt32BE(5);
  return method === AUTH_OK ? { kind: "auth_ok" } : { kind: "auth_required", method };
}

const TERMINATE = Buffer.from([0x58, 0, 0, 0, 4]);

const startupProbe: PgStartupProbe = (host, port, user, database, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = createConnection({ host, port });
    const finish = (reply: PgStartupReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reply.kind === "auth_ok") socket.end(TERMINATE);
      else socket.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => finish({ kind: "unreachable" }), timeoutMs);
    socket.on("connect", () => socket.write(buildStartupMessage(user, database)));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const reply = classifyStartupReply(buffer);
      if (reply) finish(reply);
    });
    socket.on("error", () => finish({ kind: "unreachable" }));
    socket.on("close", () => finish({ kind: "unreachable" }));
  });

export function isRiskyOmniDbAuth(status: OmniDbAuthStatus): boolean {
  return status === "no_password_login";
}
