/**
 * NATS credentials per process role.
 *
 * The local nats-server used to run with no authentication, so any process on
 * the host could publish `ravi.inbound.*` (channel messages, Slack clicks,
 * approvals) with any sender. Each Ravi process now connects as a role:
 *
 * - `daemon`   (`ravi daemon run`)   publishes and subscribes everything;
 * - `channels` (`ravi channels run`) publishes channel input (`ravi.inbound.>`);
 * - `omni`     (the Omni API)         never publishes `ravi.inbound.>`;
 * - `cli`      (terminal, turns, cron shell) never publishes `ravi.inbound.>`.
 *
 * Credentials live in `<state>/nats/<role>.json` (mode 0600) and the server
 * configuration in `<state>/nats/server.conf`. The rollout has two phases so a
 * daemon and a channels runner on different versions keep working:
 *
 * - `open`:   every role may do everything and connections without a user
 *             still enter as `legacy`; clients that have a credential use it.
 * - `locked`: role permissions apply and unauthenticated connections are refused.
 *
 * Limit, by design: every Ravi process runs as the same OS user, so a turn with
 * an unrestricted shell can read these files. This protects against other OS
 * users, other local programs and restricted turns, not against shell turns that
 * are already operator-equivalent.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "./utils/paths.js";

export const NATS_ROLES = ["daemon", "channels", "omni", "cli"] as const;
export type NatsRole = (typeof NATS_ROLES)[number];
export type NatsAuthPhase = "open" | "locked";

const LEGACY_USER = "legacy";

export interface NatsCredential {
  user: string;
  pass: string;
}

export interface NatsRolePermissions {
  publish: { allow?: string[]; deny?: string[] };
  subscribe: { allow?: string[]; deny?: string[] };
}

/** Subjects only a channel runner (or the daemon) may publish: input that claims a verified sender. */
export const CHANNEL_INPUT_SUBJECTS = ["ravi.inbound.>"];

/**
 * JetStream stream administration. A stream can republish what it stores to
 * any subject, and the server does that without checking the client's publish
 * permissions: a client allowed to create or change a stream could forge
 * channel input through `republish`. Only the daemon and the channels runner
 * create streams (measured: audit, session prompts, channel outbound, leader KV);
 * every other role only reads stream info and manages its own consumers.
 */
export const STREAM_ADMIN_SUBJECTS = [
  "$JS.API.STREAM.CREATE.>",
  "$JS.API.STREAM.UPDATE.>",
  "$JS.API.STREAM.DELETE.>",
  "$JS.API.STREAM.PURGE.>",
  "$JS.API.STREAM.RESTORE.>",
  "$JS.API.STREAM.SNAPSHOT.>",
  "$JS.API.STREAM.MSG.DELETE.>",
  "$JS.API.STREAM.TEMPLATE.>",
];

export function natsAuthDir(stateDir: string = getRaviStateDir()): string {
  return join(stateDir, "nats");
}

export function natsServerConfigPath(stateDir?: string): string {
  return join(natsAuthDir(stateDir), "server.conf");
}

export function natsCredentialPath(role: NatsRole, stateDir?: string): string {
  return join(natsAuthDir(stateDir), `${role}.json`);
}

export function isNatsRole(value: unknown): value is NatsRole {
  return typeof value === "string" && (NATS_ROLES as readonly string[]).includes(value);
}

export function natsRolePermissions(role: NatsRole, phase: NatsAuthPhase): NatsRolePermissions {
  const everything: NatsRolePermissions = { publish: { allow: [">"] }, subscribe: { allow: [">"] } };
  if (phase === "open") return everything;
  switch (role) {
    case "daemon":
    case "channels":
      return everything;
    case "omni":
    case "cli":
      // Neither forges channel input (directly or through a stream that republishes it)
      // nor reads it: channel messages of every chat are not theirs to see.
      return {
        publish: { allow: [">"], deny: [...CHANNEL_INPUT_SUBJECTS, ...STREAM_ADMIN_SUBJECTS] },
        subscribe: { allow: [">"], deny: [...CHANNEL_INPUT_SUBJECTS] },
      };
  }
}

export class NatsCredentialError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NatsCredentialError";
  }
}

/**
 * The credential for `role`, or null when this host has none yet (open phase,
 * old install). A credential file that others can read, or that is malformed,
 * fails closed with an error instead of being used or silently ignored.
 */
export function loadNatsCredential(role: NatsRole, stateDir?: string): NatsCredential | null {
  const path = natsCredentialPath(role, stateDir);
  if (!existsSync(path)) return null;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new NatsCredentialError(
      `NATS credential ${path} is readable by others (mode ${mode.toString(8)}); run: chmod 600 ${path}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new NatsCredentialError(`NATS credential ${path} is not valid JSON`, { cause: error });
  }
  const record = parsed as Partial<NatsCredential> | null;
  if (!record || typeof record.user !== "string" || typeof record.pass !== "string" || !record.user || !record.pass) {
    throw new NatsCredentialError(`NATS credential ${path} must hold a non-empty "user" and "pass"`);
  }
  return { user: record.user, pass: record.pass };
}

/**
 * Connect options for a process of `role`: its credential when present, nothing
 * otherwise. The role is passed in code by the daemon and the channels runner,
 * never read from the environment: children (turns, cron shell, apps) inherit
 * the environment and must stay `cli`.
 */
export function natsConnectAuth(
  role: NatsRole = "cli",
  stateDir?: string,
): { user?: string; pass?: string; role: NatsRole } {
  const credential = loadNatsCredential(role, stateDir);
  return credential ? { role, user: credential.user, pass: credential.pass } : { role };
}

function newPassword(): string {
  return randomBytes(24).toString("base64url");
}

/** Existing credentials are kept (a rewrite must not cut live connections); missing roles get new ones. */
export function ensureNatsCredentials(stateDir?: string): Record<NatsRole, NatsCredential> {
  const dir = natsAuthDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const result = {} as Record<NatsRole, NatsCredential>;
  for (const role of NATS_ROLES) {
    const existing = loadNatsCredential(role, stateDir);
    if (existing) {
      result[role] = existing;
      continue;
    }
    const credential = { user: `ravi-${role}`, pass: newPassword() };
    writeFileSync(natsCredentialPath(role, stateDir), `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    result[role] = credential;
  }
  return result;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function renderPermissions(permissions: NatsRolePermissions, indent: string): string {
  const side = (name: "publish" | "subscribe") => {
    const rule = permissions[name];
    const parts: string[] = [];
    if (rule.allow?.length) parts.push(`allow: [${rule.allow.map(quote).join(", ")}]`);
    if (rule.deny?.length) parts.push(`deny: [${rule.deny.map(quote).join(", ")}]`);
    return `${indent}  ${name}: { ${parts.join(", ")} }`;
  };
  return `${indent}permissions: {\n${side("publish")}\n${side("subscribe")}\n${indent}}`;
}

export interface NatsServerConfigInput {
  phase: NatsAuthPhase;
  credentials: Record<NatsRole, NatsCredential>;
  host?: string;
  port?: number;
  jetstreamDir: string;
}

/** nats-server configuration for the given phase. Passwords are written as given (the file is 0600). */
export function renderNatsServerConfig(input: NatsServerConfigInput): string {
  const users = NATS_ROLES.map((role) => {
    const credential = input.credentials[role];
    return [
      "    {",
      `      user: ${quote(credential.user)}`,
      `      password: ${quote(credential.pass)}`,
      renderPermissions(natsRolePermissions(role, input.phase), "      "),
      "    }",
    ].join("\n");
  });
  if (input.phase === "open") {
    users.push(
      [
        "    {",
        `      user: ${quote(LEGACY_USER)}`,
        `      password: ${quote(newPassword())}`,
        renderPermissions(natsRolePermissions("daemon", "open"), "      "),
        "    }",
      ].join("\n"),
    );
  }
  return [
    `# Generated by ravi nats config (phase: ${input.phase}). Do not edit by hand.`,
    `host: ${quote(input.host ?? "127.0.0.1")}`,
    `port: ${input.port ?? 4222}`,
    "jetstream {",
    `  store_dir: ${quote(input.jetstreamDir)}`,
    "}",
    "authorization {",
    "  users: [",
    users.join("\n"),
    "  ]",
    "}",
    ...(input.phase === "open" ? [`no_auth_user: ${quote(LEGACY_USER)}`] : []),
    "",
  ].join("\n");
}
