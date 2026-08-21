import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TagBinding, TagAssetType } from "../tags/types.js";
import { getRaviStateDir } from "../utils/paths.js";
import type { AgentConfig, DmScope, RouteConfig, RouterConfig } from "./types.js";
import type { ChannelConfig, InstanceConfig } from "./router-db.js";

export type ReadOnlyRouteRecord = RouteConfig & { id: number };

export interface ReadOnlyRoutesSnapshot {
  dbPath: string;
  databaseExists: boolean;
  routes: ReadOnlyRouteRecord[];
  instances: InstanceConfig[];
  channels: ChannelConfig[];
  tags: TagBinding[];
  routerConfig: RouterConfig;
}

type SqlRow = Record<string, unknown>;

export class RoutesSnapshotSchemaError extends Error {
  readonly table: string;
  readonly missingColumns: string[];

  constructor(table: string, missingColumns: string[]) {
    super(`Unsupported routes snapshot schema in table ${table}`);
    this.name = "RoutesSnapshotSchemaError";
    this.table = table;
    this.missingColumns = [...missingColumns].sort();
  }
}

function tableNames(database: Database): Set<string> {
  return new Set(
    (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
}

function tableColumns(database: Database, table: string): Set<string> {
  const escaped = table.replaceAll('"', '""');
  return new Set(
    (database.prepare(`PRAGMA table_info("${escaped}")`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

function requireColumns(table: string, columns: Set<string>, required: string[]): void {
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) throw new RoutesSnapshotSchemaError(table, missing);
}

function selectExpression(columns: Set<string>, name: string, fallback: string): string {
  return columns.has(name) ? `"${name}"` : `${fallback} AS "${name}"`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

function isDmScope(value: unknown): value is DmScope {
  return (
    value === "main" || value === "per-peer" || value === "per-channel-peer" || value === "per-account-channel-peer"
  );
}

function readSettings(database: Database, tables: Set<string>): Map<string, string> {
  if (!tables.has("settings")) return new Map();
  const columns = tableColumns(database, "settings");
  requireColumns("settings", columns, ["key", "value"]);
  return new Map(
    (
      database.prepare("SELECT key, value FROM settings ORDER BY key ASC").all() as Array<{
        key: string;
        value: string;
      }>
    ).map((row) => [row.key, row.value]),
  );
}

function readAgents(database: Database, tables: Set<string>): AgentConfig[] {
  if (!tables.has("agents")) return [];
  const columns = tableColumns(database, "agents");
  requireColumns("agents", columns, ["id", "cwd"]);
  const dmScope = selectExpression(columns, "dm_scope", "NULL");
  return (database.prepare(`SELECT id, cwd, ${dmScope} FROM agents ORDER BY id ASC`).all() as SqlRow[]).map((row) => ({
    id: String(row.id),
    cwd: String(row.cwd),
    ...(isDmScope(row.dm_scope) ? { dmScope: row.dm_scope } : {}),
  }));
}

function readRoutes(database: Database, tables: Set<string>): ReadOnlyRouteRecord[] {
  if (!tables.has("routes")) return [];
  const columns = tableColumns(database, "routes");
  requireColumns("routes", columns, ["id", "pattern", "account_id", "agent_id"]);
  const expressions = [
    "id",
    "pattern",
    "account_id",
    "agent_id",
    selectExpression(columns, "dm_scope", "NULL"),
    selectExpression(columns, "session_name", "NULL"),
    selectExpression(columns, "policy", "NULL"),
    selectExpression(columns, "priority", "0"),
    selectExpression(columns, "channel", "NULL"),
  ];
  const active = columns.has("deleted_at") ? " WHERE deleted_at IS NULL" : "";
  const rows = database
    .prepare(`SELECT ${expressions.join(", ")} FROM routes${active} ORDER BY priority DESC, id ASC`)
    .all() as SqlRow[];
  return rows.map((row) => ({
    id: Number(row.id),
    pattern: String(row.pattern),
    accountId: String(row.account_id),
    agent: String(row.agent_id),
    priority: Number(row.priority ?? 0),
    ...(isDmScope(row.dm_scope) ? { dmScope: row.dm_scope } : {}),
    ...(optionalString(row.session_name) ? { session: String(row.session_name) } : {}),
    ...(optionalString(row.policy) ? { policy: String(row.policy) } : {}),
    ...(optionalString(row.channel) ? { channel: String(row.channel) } : {}),
  }));
}

function readInstances(database: Database, tables: Set<string>): InstanceConfig[] {
  if (!tables.has("instances")) return [];
  const columns = tableColumns(database, "instances");
  requireColumns("instances", columns, ["name"]);
  const expressions = [
    "name",
    selectExpression(columns, "instance_id", "NULL"),
    selectExpression(columns, "channel", "'whatsapp'"),
    selectExpression(columns, "agent", "NULL"),
    selectExpression(columns, "dm_policy", "'open'"),
    selectExpression(columns, "group_policy", "'open'"),
    selectExpression(columns, "contact_intake_mode", "'off'"),
    selectExpression(columns, "dm_scope", "NULL"),
    selectExpression(columns, "enabled", "1"),
    selectExpression(columns, "defaults", "NULL"),
    selectExpression(columns, "default_contact_tags", "NULL"),
    selectExpression(columns, "created_at", "0"),
    selectExpression(columns, "updated_at", "0"),
    selectExpression(columns, "deleted_at", "NULL"),
  ];
  const active = columns.has("deleted_at") ? " WHERE deleted_at IS NULL" : "";
  const rows = database
    .prepare(`SELECT ${expressions.join(", ")} FROM instances${active} ORDER BY name ASC`)
    .all() as SqlRow[];
  return rows.map((row) => ({
    name: String(row.name),
    channel: String(row.channel ?? "whatsapp"),
    dmPolicy: row.dm_policy === "pairing" || row.dm_policy === "closed" ? row.dm_policy : "open",
    groupPolicy: row.group_policy === "allowlist" || row.group_policy === "closed" ? row.group_policy : "open",
    contactIntakeMode:
      row.contact_intake_mode === "discovered" || row.contact_intake_mode === "pending"
        ? row.contact_intake_mode
        : "off",
    enabled: row.enabled !== 0,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    ...(optionalString(row.instance_id) ? { instanceId: String(row.instance_id) } : {}),
    ...(optionalString(row.agent) ? { agent: String(row.agent) } : {}),
    ...(isDmScope(row.dm_scope) ? { dmScope: row.dm_scope } : {}),
    ...(optionalRecord(row.defaults) ? { defaults: optionalRecord(row.defaults) } : {}),
    ...(optionalStringArray(row.default_contact_tags)
      ? { defaultContactTags: optionalStringArray(row.default_contact_tags) }
      : {}),
  }));
}

function readChannels(database: Database, tables: Set<string>): ChannelConfig[] {
  if (!tables.has("channels")) return [];
  const columns = tableColumns(database, "channels");
  requireColumns("channels", columns, ["name", "provider"]);
  const expressions = [
    "name",
    "provider",
    selectExpression(columns, "enabled", "1"),
    selectExpression(columns, "credential_connection", "NULL"),
    selectExpression(columns, "defaults", "NULL"),
    selectExpression(columns, "created_at", "0"),
    selectExpression(columns, "updated_at", "0"),
    selectExpression(columns, "deleted_at", "NULL"),
  ];
  const active = columns.has("deleted_at") ? " WHERE deleted_at IS NULL" : "";
  const rows = database
    .prepare(`SELECT ${expressions.join(", ")} FROM channels${active} ORDER BY name ASC`)
    .all() as SqlRow[];
  return rows.map((row) => ({
    name: String(row.name),
    provider: String(row.provider),
    enabled: row.enabled !== 0,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    ...(optionalString(row.credential_connection) ? { credentialConnection: String(row.credential_connection) } : {}),
    ...(optionalRecord(row.defaults) ? { defaults: optionalRecord(row.defaults) } : {}),
  }));
}

function readRouteTags(database: Database, tables: Set<string>): TagBinding[] {
  if (!tables.has("tag_bindings") || !tables.has("tag_definitions")) return [];
  const bindingColumns = tableColumns(database, "tag_bindings");
  const definitionColumns = tableColumns(database, "tag_definitions");
  requireColumns("tag_bindings", bindingColumns, [
    "id",
    "tag_id",
    "asset_type",
    "asset_id",
    "created_at",
    "updated_at",
  ]);
  requireColumns("tag_definitions", definitionColumns, ["id", "slug"]);
  const expressions = [
    "b.id",
    "b.tag_id",
    "d.slug AS tag_slug",
    "b.asset_type",
    "b.asset_id",
    bindingColumns.has("metadata_json") ? "b.metadata_json" : "NULL AS metadata_json",
    bindingColumns.has("source") ? "b.source" : "'ravi' AS source",
    bindingColumns.has("created_by") ? "b.created_by" : "NULL AS created_by",
    bindingColumns.has("updated_by") ? "b.updated_by" : "NULL AS updated_by",
    "b.created_at",
    "b.updated_at",
  ];
  const rows = database
    .prepare(
      `SELECT ${expressions.join(", ")} FROM tag_bindings b JOIN tag_definitions d ON d.id = b.tag_id WHERE b.asset_type IN ('route', 'instance') ORDER BY b.updated_at DESC, b.id ASC`,
    )
    .all() as SqlRow[];
  return rows.map((row) => ({
    id: String(row.id),
    tagId: String(row.tag_id),
    tagSlug: String(row.tag_slug),
    assetType: row.asset_type as TagAssetType,
    assetId: String(row.asset_id),
    source: String(row.source ?? "ravi"),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(optionalRecord(row.metadata_json) ? { metadata: optionalRecord(row.metadata_json) } : {}),
    ...(optionalString(row.created_by) ? { createdBy: String(row.created_by) } : {}),
    ...(optionalString(row.updated_by) ? { updatedBy: String(row.updated_by) } : {}),
  }));
}

function buildRouterConfig(
  agents: AgentConfig[],
  routes: ReadOnlyRouteRecord[],
  instances: InstanceConfig[],
  channels: ChannelConfig[],
  settings: Map<string, string>,
): RouterConfig {
  const defaultDmScope = settings.get("defaultDmScope");
  return {
    agents: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
    routes: routes.map(({ id: _id, ...route }) => route),
    defaultAgent: settings.get("defaultAgent")?.trim() || "main",
    defaultDmScope: isDmScope(defaultDmScope) ? defaultDmScope : "per-peer",
    accountAgents: Object.fromEntries(
      instances.filter((instance) => instance.agent).map((instance) => [instance.name, instance.agent!]),
    ),
    instanceToAccount: Object.fromEntries(
      instances.filter((instance) => instance.instanceId).map((instance) => [instance.instanceId!, instance.name]),
    ),
    instances: Object.fromEntries(instances.map((instance) => [instance.name, instance])),
    channels: Object.fromEntries(channels.map((channel) => [channel.name, channel])),
  };
}

export function readRoutesSnapshot(env: NodeJS.ProcessEnv = process.env): ReadOnlyRoutesSnapshot {
  const dbPath = join(getRaviStateDir(env), "ravi.db");
  if (!existsSync(dbPath)) {
    return {
      dbPath,
      databaseExists: false,
      routes: [],
      instances: [],
      channels: [],
      tags: [],
      routerConfig: buildRouterConfig([], [], [], [], new Map()),
    };
  }

  // Keep normal SQLite read-only semantics so committed WAL frames stay
  // visible while the daemon is writing. `immutable=1` would avoid shared
  // memory coordination but can return stale data or corrupt reads when a
  // writer is active. SQLite may update `-shm`; ravi.db and its WAL remain
  // untouched by this facade.
  const database = new Database(dbPath, { readonly: true, create: false });
  try {
    database.exec("PRAGMA busy_timeout = 1000");
    const tables = tableNames(database);
    const settings = readSettings(database, tables);
    const agents = readAgents(database, tables);
    const routes = readRoutes(database, tables);
    const instances = readInstances(database, tables);
    const channels = readChannels(database, tables);
    return {
      dbPath,
      databaseExists: true,
      routes,
      instances,
      channels,
      tags: readRouteTags(database, tables),
      routerConfig: buildRouterConfig(agents, routes, instances, channels, settings),
    };
  } finally {
    database.close();
  }
}
