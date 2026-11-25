/**
 * The MCP server registry in `ravi.db` (spec mcp, Registry).
 *
 * `mcp_servers` holds one row per registered server and the status, era and
 * catalog the daemon caches for it. `mcp_agent_servers` attaches a server to
 * an agent; a server without an attachment row is reachable by no agent.
 * Secrets, including the full server URL, never enter these tables: only the
 * display form of the URL is stored.
 *
 * Every write emits `ravi.config.changed` with `reason: "mcp_servers"`.
 * `change: "config"` marks a registration change (the daemon drops its
 * connections to those servers and refreshes them); `change: "status"` marks
 * the daemon's own status and catalog cache, which needs no refresh.
 */

import { publish } from "../nats.js";
import { getDb } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import { assertMcpServerName, mcpDisplayUrl, mcpUrlCarriesSecret, parseMcpServerUrl } from "./names.js";

const log = logger.child("mcp:registry");

export type McpTransport = "http" | "stdio";
export type McpAuthKind = "none" | "bearer" | "oauth";
export type McpProtocolMode = "auto" | "2026-07-28" | "legacy";
export type McpServerStatus = "unknown" | "ok" | "needs_login" | "error";
export type McpEra = "modern" | "legacy";
export type McpAudience = "operator" | "any";

export const MCP_TRANSPORTS: readonly McpTransport[] = ["http", "stdio"];
export const MCP_AUTH_KINDS: readonly McpAuthKind[] = ["none", "bearer", "oauth"];
export const MCP_PROTOCOL_MODES: readonly McpProtocolMode[] = ["auto", "2026-07-28", "legacy"];
export const MCP_SERVER_STATUSES: readonly McpServerStatus[] = ["unknown", "ok", "needs_login", "error"];
export const MCP_AUDIENCES: readonly McpAudience[] = ["operator", "any"];

/** Names of stdio environment variables: the values live in the credentials store. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/**
 * What `envKeys` holds when the stored key list does not parse as a list of
 * key names. It is not a valid key name, so the row counts as credentialed
 * (it may hold stored values), shows the damage, and never connects.
 */
export const MCP_DAMAGED_ENV_KEYS = "(damaged)";
const MAX_STATUS_DETAIL = 500;

/** One tool of a server's cached catalog, as the gateway stored it. */
export interface McpCatalogTool {
  /** The remote tool name. */
  name: string;
  /** `mcp__<server>__<name>`. */
  exposedName: string;
  description?: string;
  /** As the runtime sees it: a file argument is already a path handle (File Uploads). */
  inputSchema?: Record<string, unknown>;
  /** The arguments the server marked `x-mcp-file`, rewritten to path handles in `inputSchema`. */
  fileArguments?: McpFileArgument[];
}

/**
 * One top-level argument the server marked `x-mcp-file` (spec mcp, File
 * Uploads): one file, or a list of them. What the runtime sends there is a
 * path handle; the gateway turns it into the server's `FileInput`.
 */
export interface McpFileArgument {
  name: string;
  multiple: boolean;
  /** The server's per-file limit (`x-mcp-file.maxSize`), in bytes. */
  maxSize?: number;
  /** The server's hint of accepted media types or `.ext` suffixes. */
  accept?: string[];
  /** Array bounds the server set on a list of files. */
  minItems?: number;
  maxItems?: number;
}

/** A remote tool that is not exposed, with the reason (shown by `ravi mcp show`). */
export interface McpDroppedTool {
  name: string;
  reason: string;
}

export interface McpCatalog {
  tools: McpCatalogTool[];
  dropped: McpDroppedTool[];
}

export interface McpServerRecord {
  name: string;
  transport: McpTransport;
  /** Display form of the URL (http only); never the full URL. */
  urlDisplay: string | null;
  /**
   * The full URL carries a secret (a token-like path segment, user info, a
   * query or a fragment), so the URL itself is the operator's credential.
   */
  urlSecret: boolean;
  command: string | null;
  args: string[];
  envKeys: string[];
  authKind: McpAuthKind;
  credentialRev: number;
  protocol: McpProtocolMode;
  enabled: boolean;
  origin: string;
  status: McpServerStatus;
  statusDetail: string | null;
  era: McpEra | null;
  discover: unknown;
  extensions: Record<string, unknown> | null;
  catalog: McpCatalog | null;
  catalogFingerprint: string | null;
  /**
   * The catalog listed with the files extension declared (addendum A1): what
   * an attachment with uploads on sees. Null when the server does not offer
   * uploads or it was not listed yet.
   */
  filesCatalog: McpCatalog | null;
  /**
   * When the tool list the catalog came from stops being fresh: the fetch
   * time plus the `ttlMs` a modern server sent with `tools/list` (capped at
   * 24 hours). Null when the server sent no hint (legacy era): the daily
   * refresh then applies.
   */
  catalogExpiresAt: number | null;
  checkedAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface McpAgentServerRecord {
  agentId: string;
  server: string;
  audience: McpAudience;
  uploads: boolean;
  createdBy: string | null;
  createdAt: number;
}

interface McpServerRow {
  name: string;
  transport: string;
  url_display: string | null;
  url_secret: number | null;
  command: string | null;
  args_json: string;
  env_keys_json: string;
  auth_kind: string;
  credential_rev: number;
  protocol: string;
  enabled: number;
  origin: string;
  status: string;
  status_detail: string | null;
  era: string | null;
  discover_json: string | null;
  extensions_json: string | null;
  catalog_json: string | null;
  catalog_fingerprint: string | null;
  files_catalog_json: string | null;
  catalog_expires_at?: number | null;
  checked_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface McpAgentServerRow {
  agent_id: string;
  server: string;
  audience: string;
  uploads: number;
  created_by: string | null;
  created_at: number;
}

export class McpRegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "McpRegistryError";
    this.code = code;
  }
}

// ============================================================================
// Change events
// ============================================================================

export interface McpConfigChangedEvent {
  reason: "mcp_servers";
  change: "config" | "status";
  servers: string[];
}

type McpConfigChangedEmitter = (event: McpConfigChangedEvent) => void;

let emitterForTests: McpConfigChangedEmitter | null = null;

/** Tests: replace the `ravi.config.changed` emitter (null restores it). */
export function setMcpConfigChangedEmitterForTests(emitter: McpConfigChangedEmitter | null): void {
  emitterForTests = emitter;
}

function emitMcpConfigChanged(change: McpConfigChangedEvent["change"], servers: string[]): void {
  const event: McpConfigChangedEvent = { reason: "mcp_servers", change, servers: [...new Set(servers)].sort() };
  try {
    if (emitterForTests) {
      emitterForTests(event);
      return;
    }
    publish("ravi.config.changed", { ...event }, { quietConnect: true }).catch(() => {
      // no-cause: best-effort notification; the daemon reads the registry from the database on its next use.
      log.warn("ravi.config.changed could not be emitted after an MCP registry write");
    });
  } catch {
    // no-cause: best-effort notification; the daemon reads the registry from the database on its next use.
  }
}

// ============================================================================
// Row mapping
// ============================================================================

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    // no-cause: a stored value that does not parse is read as absent, which never widens access.
    return null;
  }
}

function parseStringArray(value: string | null): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

/** The stored env key names; a list that does not parse is kept visible as damaged, never read as empty. */
function parseEnvKeys(value: string | null): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string" && ENV_KEY_PATTERN.test(item))) {
    return [MCP_DAMAGED_ENV_KEYS];
  }
  return parsed as string[];
}

function parseObject(value: string | null): Record<string, unknown> | null {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** A catalog that does not parse is no catalog: nothing is listed from it. */
function parseFileArguments(value: unknown): McpFileArgument[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: McpFileArgument[] = [];
  const count = (item: unknown) =>
    typeof item === "number" && Number.isInteger(item) && item >= 0 ? (item as number) : undefined;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== "string" || typeof entry.multiple !== "boolean") return null;
    const maxSize = count(entry.maxSize);
    const minItems = count(entry.minItems);
    const maxItems = count(entry.maxItems);
    const accept = Array.isArray(entry.accept)
      ? entry.accept.filter((item): item is string => typeof item === "string")
      : undefined;
    out.push({
      name: entry.name,
      multiple: entry.multiple,
      ...(maxSize !== undefined ? { maxSize } : {}),
      ...(accept ? { accept } : {}),
      ...(minItems !== undefined ? { minItems } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
    });
  }
  return out;
}

function parseCatalog(value: string | null): McpCatalog | null {
  const parsed = parseObject(value);
  if (!parsed || !Array.isArray(parsed.tools)) return null;
  const tools: McpCatalogTool[] = [];
  for (const item of parsed.tools) {
    if (!item || typeof item !== "object") return null;
    const tool = item as Record<string, unknown>;
    if (typeof tool.name !== "string" || typeof tool.exposedName !== "string") return null;
    // A file argument list that does not parse makes the catalog unusable: a file must never pass as text.
    const fileArguments = parseFileArguments(tool.fileArguments);
    if (fileArguments === null) return null;
    tools.push({
      name: tool.name,
      exposedName: tool.exposedName,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
        ? { inputSchema: tool.inputSchema as Record<string, unknown> }
        : {}),
      ...(fileArguments.length > 0 ? { fileArguments } : {}),
    });
  }
  const dropped: McpDroppedTool[] = [];
  if (Array.isArray(parsed.dropped)) {
    for (const item of parsed.dropped) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.name === "string" && typeof entry.reason === "string") {
        dropped.push({ name: entry.name, reason: entry.reason });
      }
    }
  }
  return { tools, dropped };
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function rowToServer(row: McpServerRow): McpServerRecord {
  return {
    name: row.name,
    transport: oneOf(row.transport, MCP_TRANSPORTS, "http"),
    urlDisplay: row.url_display,
    // Anything but a stored 0 counts as a secret URL: a damaged row never widens access.
    urlSecret: row.url_secret !== 0,
    command: row.command,
    args: parseStringArray(row.args_json),
    envKeys: parseEnvKeys(row.env_keys_json),
    // An unknown auth kind is read as credentialed: it never widens access.
    authKind: oneOf(row.auth_kind, MCP_AUTH_KINDS, "oauth"),
    credentialRev: row.credential_rev,
    protocol: oneOf(row.protocol, MCP_PROTOCOL_MODES, "auto"),
    enabled: row.enabled === 1,
    origin: row.origin,
    status: oneOf(row.status, MCP_SERVER_STATUSES, "unknown"),
    statusDetail: row.status_detail,
    era: row.era === "modern" || row.era === "legacy" ? row.era : null,
    discover: parseJson(row.discover_json),
    extensions: parseObject(row.extensions_json),
    catalog: parseCatalog(row.catalog_json),
    catalogFingerprint: row.catalog_fingerprint,
    filesCatalog: parseCatalog(row.files_catalog_json ?? null),
    catalogExpiresAt:
      typeof row.catalog_expires_at === "number" && Number.isFinite(row.catalog_expires_at)
        ? row.catalog_expires_at
        : null,
    checkedAt: row.checked_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAttachment(row: McpAgentServerRow): McpAgentServerRecord {
  return {
    agentId: row.agent_id,
    server: row.server,
    // An unknown audience is read as the narrow one.
    audience: row.audience === "any" ? "any" : "operator",
    uploads: row.uploads === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// ============================================================================
// Validation
// ============================================================================

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new McpRegistryError("invalid_value", `${label} must be one of: ${allowed.join(", ")}.`);
}

function requireAgentId(agentId: unknown): string {
  if (typeof agentId !== "string" || !agentId.trim()) {
    throw new McpRegistryError("invalid_value", "An agent id is required.");
  }
  return agentId.trim();
}

function normalizeEnvKeys(keys: readonly string[] | undefined): string[] {
  const unique = new Set<string>();
  for (const key of keys ?? []) {
    if (typeof key !== "string" || !ENV_KEY_PATTERN.test(key)) {
      throw new McpRegistryError(
        "invalid_env_key",
        "Environment keys are names only (letters, digits and underscores, not starting with a digit); values are read from stdin.",
      );
    }
    unique.add(key);
  }
  return [...unique].sort();
}

function normalizeArgs(args: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const arg of args ?? []) {
    if (typeof arg !== "string") throw new McpRegistryError("invalid_value", "Command arguments must be strings.");
    out.push(arg);
  }
  return out;
}

function capText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

// ============================================================================
// Servers
// ============================================================================

export type CreateMcpServerInput = {
  name: string;
  authKind?: McpAuthKind;
  protocol?: McpProtocolMode;
  enabled?: boolean;
  /** `manual` (default) or `import:<path>`. */
  origin?: string;
  createdBy?: string | null;
  now?: number;
} & (
  | {
      transport: "http";
      /**
       * The full URL. Only its display form is stored; the caller keeps the
       * full URL in the credentials store.
       */
      url: string;
    }
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      /** Names only; the values go to the credentials store. */
      envKeys?: string[];
    }
);

export function createMcpServer(input: CreateMcpServerInput): McpServerRecord {
  const name = assertMcpServerName(input.name);
  const transport = requireOneOf(input.transport, MCP_TRANSPORTS, "transport");
  const authKind = requireOneOf(input.authKind ?? "none", MCP_AUTH_KINDS, "auth");
  const protocol = requireOneOf(input.protocol ?? "auto", MCP_PROTOCOL_MODES, "protocol");
  const origin = input.origin?.trim() || "manual";
  if (origin !== "manual" && !origin.startsWith("import:")) {
    throw new McpRegistryError("invalid_value", "origin must be manual or import:<path>.");
  }
  let urlDisplay: string | null = null;
  let urlSecret = false;
  let command: string | null = null;
  let args: string[] = [];
  let envKeys: string[] = [];
  if (input.transport === "http") {
    const url = parseMcpServerUrl(input.url);
    urlDisplay = mcpDisplayUrl(url);
    urlSecret = mcpUrlCarriesSecret(url);
  } else {
    command = input.command?.trim() || null;
    if (!command) throw new McpRegistryError("invalid_value", "A stdio server needs a command.");
    if (authKind !== "none") {
      throw new McpRegistryError("invalid_value", "A stdio server has no bearer or OAuth login; use env keys.");
    }
    args = normalizeArgs(input.args);
    envKeys = normalizeEnvKeys(input.envKeys);
  }
  const now = input.now ?? Date.now();
  const db = getDb();
  // The insert itself claims the name: of two concurrent registrations of one
  // name exactly one inserts, and the other gets already_registered.
  const inserted = db
    .prepare(
      `
    INSERT INTO mcp_servers (
      name, transport, url_display, url_secret, command, args_json, env_keys_json, auth_kind, credential_rev,
      protocol, enabled, origin, status, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'unknown', ?, ?, ?)
    ON CONFLICT(name) DO NOTHING
    `,
    )
    .run(
      name,
      transport,
      urlDisplay,
      urlSecret ? 1 : 0,
      command,
      JSON.stringify(args),
      JSON.stringify(envKeys),
      authKind,
      protocol,
      input.enabled === false ? 0 : 1,
      origin,
      input.createdBy?.trim() || null,
      now,
      now,
    );
  if (inserted.changes === 0) {
    throw new McpRegistryError("already_registered", `MCP server "${name}" is already registered.`);
  }
  emitMcpConfigChanged("config", [name]);
  const saved = getMcpServer(name);
  if (!saved) throw new McpRegistryError("write_failed", `MCP server "${name}" was not saved.`);
  return saved;
}

export function getMcpServer(name: string): McpServerRecord | null {
  const row = getDb().prepare("SELECT * FROM mcp_servers WHERE name = ?").get(name) as McpServerRow | null;
  return row ? rowToServer(row) : null;
}

export function listMcpServers(filter: { enabled?: boolean } = {}): McpServerRecord[] {
  const where = filter.enabled === undefined ? "" : "WHERE enabled = ?";
  const params = filter.enabled === undefined ? [] : [filter.enabled ? 1 : 0];
  const rows = getDb()
    .prepare(`SELECT * FROM mcp_servers ${where} ORDER BY name`)
    .all(...params) as McpServerRow[];
  return rows.map(rowToServer);
}

export interface UpdateMcpServerConfigInput {
  enabled?: boolean;
  protocol?: McpProtocolMode;
  authKind?: McpAuthKind;
  /** http only: a new full URL; only its display form is stored. */
  url?: string;
  /** stdio only. */
  command?: string;
  args?: string[];
  envKeys?: string[];
  now?: number;
}

/**
 * Change a server's registration. Returns the updated row, or null when no
 * such server is registered.
 */
export function updateMcpServerConfig(name: string, input: UpdateMcpServerConfigInput): McpServerRecord | null {
  const existing = getMcpServer(name);
  if (!existing) return null;
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (input.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(input.enabled ? 1 : 0);
  }
  if (input.protocol !== undefined) {
    sets.push("protocol = ?");
    params.push(requireOneOf(input.protocol, MCP_PROTOCOL_MODES, "protocol"));
  }
  if (input.authKind !== undefined) {
    const authKind = requireOneOf(input.authKind, MCP_AUTH_KINDS, "auth");
    if (existing.transport === "stdio" && authKind !== "none") {
      throw new McpRegistryError("invalid_value", "A stdio server has no bearer or OAuth login; use env keys.");
    }
    sets.push("auth_kind = ?");
    params.push(authKind);
  }
  if (input.url !== undefined) {
    if (existing.transport !== "http") throw new McpRegistryError("invalid_value", "Only an http server has a URL.");
    const url = parseMcpServerUrl(input.url);
    sets.push("url_display = ?", "url_secret = ?");
    params.push(mcpDisplayUrl(url), mcpUrlCarriesSecret(url) ? 1 : 0);
  }
  if (input.command !== undefined || input.args !== undefined || input.envKeys !== undefined) {
    if (existing.transport !== "stdio") {
      throw new McpRegistryError("invalid_value", "Only a stdio server has a command, arguments and env keys.");
    }
    if (input.command !== undefined) {
      const command = input.command.trim();
      if (!command) throw new McpRegistryError("invalid_value", "A stdio server needs a command.");
      sets.push("command = ?");
      params.push(command);
    }
    if (input.args !== undefined) {
      sets.push("args_json = ?");
      params.push(JSON.stringify(normalizeArgs(input.args)));
    }
    if (input.envKeys !== undefined) {
      sets.push("env_keys_json = ?");
      params.push(JSON.stringify(normalizeEnvKeys(input.envKeys)));
    }
  }
  if (sets.length === 0) return existing;
  // A changed registration invalidates what the daemon learned about the old one.
  const resetsProbe = input.protocol !== undefined || input.url !== undefined || input.command !== undefined;
  if (resetsProbe) {
    sets.push(
      "era = NULL",
      "discover_json = NULL",
      "status = 'unknown'",
      "status_detail = NULL",
      "files_catalog_json = NULL",
      "catalog_expires_at = NULL",
    );
  }
  sets.push("updated_at = ?");
  params.push(input.now ?? Date.now());
  getDb()
    .prepare(`UPDATE mcp_servers SET ${sets.join(", ")} WHERE name = ?`)
    .run(...params, name);
  emitMcpConfigChanged("config", [name]);
  return getMcpServer(name);
}

export interface RecordMcpServerProbeInput {
  status: McpServerStatus;
  statusDetail?: string | null;
  era?: McpEra | null;
  discover?: unknown;
  extensions?: Record<string, unknown> | null;
  catalog?: McpCatalog | null;
  catalogFingerprint?: string | null;
  /** The catalog listed with the files extension declared; null clears it. */
  filesCatalog?: McpCatalog | null;
  /** When the listed catalog stops being fresh (see `McpServerRecord.catalogExpiresAt`); null clears it. */
  catalogExpiresAt?: number | null;
  checkedAt?: number;
}

/**
 * The daemon's cache of what it learned from a server: status, era, discover
 * result, extensions and catalog. Fields left undefined keep their value.
 * The status detail must already be free of secrets (it is shown by `show`).
 */
export function recordMcpServerProbe(name: string, input: RecordMcpServerProbeInput): McpServerRecord | null {
  const sets: string[] = ["status = ?", "checked_at = ?", "updated_at = ?"];
  const checkedAt = input.checkedAt ?? Date.now();
  const params: Array<string | number | null> = [
    requireOneOf(input.status, MCP_SERVER_STATUSES, "status"),
    checkedAt,
    checkedAt,
  ];
  if (input.statusDetail !== undefined) {
    sets.push("status_detail = ?");
    params.push(capText(input.statusDetail, MAX_STATUS_DETAIL));
  }
  if (input.era !== undefined) {
    if (input.era !== null && input.era !== "modern" && input.era !== "legacy") {
      throw new McpRegistryError("invalid_value", "era must be modern or legacy.");
    }
    sets.push("era = ?");
    params.push(input.era);
  }
  if (input.discover !== undefined) {
    sets.push("discover_json = ?");
    params.push(input.discover === null ? null : JSON.stringify(input.discover));
  }
  if (input.extensions !== undefined) {
    sets.push("extensions_json = ?");
    params.push(input.extensions === null ? null : JSON.stringify(input.extensions));
  }
  if (input.catalog !== undefined) {
    sets.push("catalog_json = ?");
    params.push(input.catalog === null ? null : JSON.stringify(input.catalog));
  }
  if (input.catalogFingerprint !== undefined) {
    sets.push("catalog_fingerprint = ?");
    params.push(input.catalogFingerprint);
  }
  if (input.filesCatalog !== undefined) {
    sets.push("files_catalog_json = ?");
    params.push(input.filesCatalog === null ? null : JSON.stringify(input.filesCatalog));
  }
  if (input.catalogExpiresAt !== undefined) {
    const expiresAt = input.catalogExpiresAt;
    sets.push("catalog_expires_at = ?");
    params.push(expiresAt !== null && Number.isFinite(expiresAt) ? Math.trunc(expiresAt) : null);
  }
  const result = getDb()
    .prepare(`UPDATE mcp_servers SET ${sets.join(", ")} WHERE name = ?`)
    .run(...params, name);
  if (result.changes === 0) return null;
  emitMcpConfigChanged("status", [name]);
  return getMcpServer(name);
}

/**
 * Compare-and-swap of the credential revision, taken before a token refresh
 * or a login writes a new secret. Returns the new revision, or null when the
 * stored revision is no longer `expected` (another writer got there first).
 */
export function bumpMcpCredentialRev(name: string, expected: number, now = Date.now()): number | null {
  const result = getDb()
    .prepare(
      "UPDATE mcp_servers SET credential_rev = credential_rev + 1, updated_at = ? WHERE name = ? AND credential_rev = ?",
    )
    .run(now, name, expected);
  if (result.changes === 0) return null;
  emitMcpConfigChanged("config", [name]);
  return expected + 1;
}

/**
 * Remove a server and its attachments. The caller deletes the server's
 * secrets. Returns the removed row, or null when it was not registered.
 */
export function removeMcpServer(name: string): McpServerRecord | null {
  const existing = getMcpServer(name);
  if (!existing) return null;
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM mcp_agent_servers WHERE server = ?").run(name);
    db.prepare("DELETE FROM mcp_servers WHERE name = ?").run(name);
  })();
  emitMcpConfigChanged("config", [name]);
  return existing;
}

// ============================================================================
// Attachments
// ============================================================================

export interface AttachMcpServerInput {
  agentId: string;
  server: string;
  audience?: McpAudience;
  uploads?: boolean;
  createdBy?: string | null;
  now?: number;
}

/**
 * Attach a server to an agent. An existing attachment is returned unchanged
 * (`created: false`): widening its audience or uploads is a separate,
 * explicit change.
 */
export function attachMcpServer(input: AttachMcpServerInput): { attachment: McpAgentServerRecord; created: boolean } {
  const agentId = requireAgentId(input.agentId);
  const server = getMcpServer(input.server);
  if (!server) throw new McpRegistryError("not_registered", `MCP server "${input.server}" is not registered.`);
  const audience = requireOneOf(input.audience ?? "operator", MCP_AUDIENCES, "audience");
  const existing = getMcpAttachment(agentId, server.name);
  if (existing) return { attachment: existing, created: false };
  getDb()
    .prepare(
      `
      INSERT INTO mcp_agent_servers (agent_id, server, audience, uploads, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      agentId,
      server.name,
      audience,
      input.uploads ? 1 : 0,
      input.createdBy?.trim() || null,
      input.now ?? Date.now(),
    );
  emitMcpConfigChanged("config", [server.name]);
  const saved = getMcpAttachment(agentId, server.name);
  if (!saved) throw new McpRegistryError("write_failed", `MCP server "${server.name}" was not attached.`);
  return { attachment: saved, created: true };
}

/** Returns true when an attachment was removed. */
export function detachMcpServer(agentId: string, server: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM mcp_agent_servers WHERE agent_id = ? AND server = ?")
    .run(agentId, server);
  if (result.changes === 0) return false;
  emitMcpConfigChanged("config", [server]);
  return true;
}

export function getMcpAttachment(agentId: string, server: string): McpAgentServerRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM mcp_agent_servers WHERE agent_id = ? AND server = ?")
    .get(agentId, server) as McpAgentServerRow | null;
  return row ? rowToAttachment(row) : null;
}

export function listMcpAttachments(filter: { agentId?: string; server?: string } = {}): McpAgentServerRecord[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.agentId !== undefined) {
    where.push("agent_id = ?");
    params.push(filter.agentId);
  }
  if (filter.server !== undefined) {
    where.push("server = ?");
    params.push(filter.server);
  }
  const rows = getDb()
    .prepare(
      `SELECT * FROM mcp_agent_servers ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY server, agent_id`,
    )
    .all(...params) as McpAgentServerRow[];
  return rows.map(rowToAttachment);
}

export interface UpdateMcpAttachmentsInput {
  server: string;
  /** One agent's attachment; every attachment of the server when omitted. */
  agentId?: string;
  audience?: McpAudience;
  uploads?: boolean;
}

/** Returns the number of attachments changed. */
export function updateMcpAttachments(input: UpdateMcpAttachmentsInput): number {
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (input.audience !== undefined) {
    sets.push("audience = ?");
    params.push(requireOneOf(input.audience, MCP_AUDIENCES, "audience"));
  }
  if (input.uploads !== undefined) {
    sets.push("uploads = ?");
    params.push(input.uploads ? 1 : 0);
  }
  if (sets.length === 0) return 0;
  const where = ["server = ?"];
  params.push(input.server);
  if (input.agentId !== undefined) {
    where.push("agent_id = ?");
    params.push(input.agentId);
  }
  const result = getDb()
    .prepare(`UPDATE mcp_agent_servers SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`)
    .run(...params);
  if (result.changes > 0) emitMcpConfigChanged("config", [input.server]);
  return result.changes;
}

// ============================================================================
// Elicitation surfaces
// ============================================================================

/** How long a settled or expired Slack elicitation row is kept (spec mcp, Elicitation). */
export const MCP_ELICITATION_ROW_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Drop `mcp_elicitation_requests` rows settled, or expired, more than a day
 * ago. The rows hold what a person was asked (never an answer); the Slack
 * runner only prunes when it inserts, so the daemon's status refresh prunes
 * too. Returns the number of rows removed.
 */
export function pruneMcpElicitationRequests(now: number = Date.now()): number {
  const before = now - MCP_ELICITATION_ROW_KEEP_MS;
  return getDb()
    .prepare(
      "DELETE FROM mcp_elicitation_requests WHERE (settled_at IS NOT NULL AND settled_at <= ?) OR expires_at <= ?",
    )
    .run(before, before).changes;
}
