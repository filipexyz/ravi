import { createHash } from "node:crypto";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { getProjectSurfaceByWorkflowRunId } from "../projects/service.js";
import { getSession, getSessionByName, type AgentConfig, type SessionEntry } from "../router/index.js";
import { dbGetAgent, getDb, getRaviDbPath } from "../router/router-db.js";
import { dbFindTagBindings } from "../tags/index.js";
import type { TagAssetType } from "../tags/types.js";
import { dbResolveActiveTaskBindingForSession } from "../tasks/task-db.js";
import { logger } from "../utils/logger.js";
import { dbGetTaskWorkflowSurface } from "../workflows/index.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { validateRuntimeModelSelector } from "./model-validation.js";
import { DEFAULT_RUNTIME_PROVIDER_ID } from "./provider-registry.js";
import type { RuntimeProviderId } from "./types.js";

const log = logger.child("runtime:observation-plane");

export type ObserverScope = "global" | "agent" | "session" | "task" | "profile" | "project" | "tag";
export type ObserverMode = "observe" | "summarize" | "report" | "intervene";
export type ObservationDeliveryPolicy = "realtime" | "debounce" | "end_of_turn" | "manual";
export type ObserverTagTargetType = "agent" | "session" | "task" | "project" | "contact" | "profile" | "any";

const OBSERVER_SCOPES = new Set<ObserverScope>(["global", "agent", "session", "task", "profile", "project", "tag"]);
const OBSERVER_MODES = new Set<ObserverMode>(["observe", "summarize", "report", "intervene"]);
const DELIVERY_POLICIES = new Set<ObservationDeliveryPolicy>(["realtime", "debounce", "end_of_turn", "manual"]);
const OBSERVER_TAG_TARGET_TYPES = new Set<ObserverTagTargetType>([
  "agent",
  "session",
  "task",
  "project",
  "contact",
  "profile",
  "any",
]);
const DEFAULT_EVENT_TYPES = ["message.user", "message.assistant", "turn.complete", "turn.failed", "turn.interrupt"];
const DEFAULT_DEBOUNCE_MS = 1000;

export interface ObserverRule {
  id: string;
  enabled: boolean;
  scope: ObserverScope;
  priority: number;
  observerRole: string;
  observerAgentId: string;
  observerRuntimeProviderId?: RuntimeProviderId;
  observerModel?: string;
  observerMode: ObserverMode;
  eventTypes: string[];
  deliveryPolicy: ObservationDeliveryPolicy;
  debounceMs?: number;
  sourceAgentId?: string;
  sourceSession?: string;
  sourceTaskId?: string;
  sourceProfileId?: string;
  sourceProjectId?: string;
  tagTargetType?: ObserverTagTargetType;
  tagSlug?: string;
  tagInherited: boolean;
  permissionGrants: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ObserverRuleInput {
  id: string;
  enabled?: boolean;
  scope?: ObserverScope;
  priority?: number;
  observerRole?: string;
  observerAgentId: string;
  observerRuntimeProviderId?: RuntimeProviderId | null;
  observerModel?: string | null;
  observerMode?: ObserverMode;
  eventTypes?: string[];
  deliveryPolicy?: ObservationDeliveryPolicy;
  debounceMs?: number;
  sourceAgentId?: string;
  sourceSession?: string;
  sourceTaskId?: string;
  sourceProfileId?: string;
  sourceProjectId?: string;
  tagTargetType?: ObserverTagTargetType;
  tagSlug?: string;
  tagInherited?: boolean;
  permissionGrants?: string[];
  metadata?: Record<string, unknown>;
}

export interface ObserverBinding {
  id: string;
  sourceSessionKey: string;
  sourceSessionName?: string;
  sourceAgentId: string;
  observerSessionName: string;
  observerAgentId: string;
  observerRuntimeProviderId?: RuntimeProviderId;
  observerModel?: string;
  observerRole: string;
  observerMode: ObserverMode;
  ruleId: string;
  eventTypes: string[];
  deliveryPolicy: ObservationDeliveryPolicy;
  debounceMs?: number;
  permissionGrants: string[];
  metadata?: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastDeliveredAt?: number;
}

export interface ObservationEvent {
  id: string;
  type: string;
  timestamp: number;
  turnId?: string;
  preview?: string;
  payload?: Record<string, unknown>;
}

export interface ObservationSourceDescriptor {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  taskId?: string;
  profileId?: string;
  projectId?: string;
  projectSlug?: string;
  tags: Array<{
    targetType: ObserverTagTargetType;
    slug: string;
    assetId: string;
    inherited: boolean;
  }>;
}

interface ObserverRuleRow {
  id: string;
  enabled: number;
  scope: ObserverScope;
  priority: number;
  observer_role: string;
  observer_agent_id: string;
  observer_runtime_provider_id: RuntimeProviderId | null;
  observer_model: string | null;
  observer_mode: ObserverMode;
  event_types_json: string;
  delivery_policy: ObservationDeliveryPolicy;
  debounce_ms: number | null;
  source_agent_id: string | null;
  source_session: string | null;
  source_task_id: string | null;
  source_profile_id: string | null;
  source_project_id: string | null;
  tag_target_type: ObserverTagTargetType | null;
  tag_slug: string | null;
  tag_inherited: number;
  permission_grants_json: string;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface ObserverBindingRow {
  id: string;
  source_session_key: string;
  source_session_name: string | null;
  source_agent_id: string;
  observer_session_name: string;
  observer_agent_id: string;
  observer_runtime_provider_id: RuntimeProviderId | null;
  observer_model: string | null;
  observer_role: string;
  observer_mode: ObserverMode;
  rule_id: string;
  event_types_json: string;
  delivery_policy: ObservationDeliveryPolicy;
  debounce_ms: number | null;
  permission_grants_json: string;
  metadata_json: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_delivered_at: number | null;
}

let schemaReady = false;
let schemaDbPath: string | null = null;
let observationPromptPublisher: (sessionName: string, payload: Record<string, unknown>) => Promise<void> =
  publishSessionPrompt;

function ensureObservationColumn(table: string, column: string, definition: string): void {
  const columns = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function setObservationPromptPublisherForTests(
  publisher?: (sessionName: string, payload: Record<string, unknown>) => Promise<void>,
): void {
  observationPromptPublisher = publisher ?? publishSessionPrompt;
}

export function ensureObservationSchema(): void {
  const dbPath = getRaviDbPath();
  if (schemaReady && schemaDbPath === dbPath) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS observer_rules (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      scope TEXT NOT NULL CHECK(scope IN ('global','agent','session','task','profile','project','tag')),
      priority INTEGER NOT NULL DEFAULT 100,
      observer_role TEXT NOT NULL,
      observer_agent_id TEXT NOT NULL,
      observer_runtime_provider_id TEXT,
      observer_model TEXT,
      observer_mode TEXT NOT NULL CHECK(observer_mode IN ('observe','summarize','report','intervene')),
      event_types_json TEXT NOT NULL,
      delivery_policy TEXT NOT NULL CHECK(delivery_policy IN ('realtime','debounce','end_of_turn','manual')),
      debounce_ms INTEGER,
      source_agent_id TEXT,
      source_session TEXT,
      source_task_id TEXT,
      source_profile_id TEXT,
      source_project_id TEXT,
      tag_target_type TEXT,
      tag_slug TEXT,
      tag_inherited INTEGER NOT NULL DEFAULT 0 CHECK(tag_inherited IN (0,1)),
      permission_grants_json TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_observer_rules_enabled_priority
      ON observer_rules(enabled, priority, id);
    CREATE INDEX IF NOT EXISTS idx_observer_rules_scope
      ON observer_rules(scope);
    CREATE INDEX IF NOT EXISTS idx_observer_rules_tag
      ON observer_rules(tag_target_type, tag_slug);

    CREATE TABLE IF NOT EXISTS observer_bindings (
      id TEXT PRIMARY KEY,
      source_session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
      source_session_name TEXT,
      source_agent_id TEXT NOT NULL,
      observer_session_name TEXT NOT NULL,
      observer_agent_id TEXT NOT NULL,
      observer_runtime_provider_id TEXT,
      observer_model TEXT,
      observer_role TEXT NOT NULL,
      observer_mode TEXT NOT NULL CHECK(observer_mode IN ('observe','summarize','report','intervene')),
      rule_id TEXT NOT NULL,
      event_types_json TEXT NOT NULL,
      delivery_policy TEXT NOT NULL CHECK(delivery_policy IN ('realtime','debounce','end_of_turn','manual')),
      debounce_ms INTEGER,
      permission_grants_json TEXT NOT NULL,
      metadata_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_delivered_at INTEGER,
      UNIQUE(source_session_key, observer_role)
    );

    CREATE INDEX IF NOT EXISTS idx_observer_bindings_source
      ON observer_bindings(source_session_key, enabled);
    CREATE INDEX IF NOT EXISTS idx_observer_bindings_observer_session
      ON observer_bindings(observer_session_name);
    CREATE INDEX IF NOT EXISTS idx_observer_bindings_rule
      ON observer_bindings(rule_id);
  `);
  ensureObservationColumn("observer_rules", "observer_runtime_provider_id", "TEXT");
  ensureObservationColumn("observer_rules", "observer_model", "TEXT");
  ensureObservationColumn("observer_bindings", "observer_runtime_provider_id", "TEXT");
  ensureObservationColumn("observer_bindings", "observer_model", "TEXT");
  ensureObservationColumn("observer_bindings", "debounce_ms", "INTEGER");
  schemaReady = true;
  schemaDbPath = dbPath;
}

function parseJsonArray(raw: string | null | undefined, fallback: string[] = []): string[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  } catch {}
  return fallback;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}
  return undefined;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function cleanOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveOptionalTextOverride(value: string | null | undefined, existing?: string): string | undefined {
  return cleanOptionalText(value === undefined ? existing : value) ?? undefined;
}

function normalizeId(value: string, label: string): string {
  const id = value.trim().toLowerCase();
  if (!id) throw new Error(`${label} is required.`);
  if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(id)) {
    throw new Error(`Invalid ${label}: ${value}. Use lowercase letters, numbers, '.', '_', ':' or '-'.`);
  }
  return id;
}

function normalizeRole(value: string): string {
  return normalizeId(value, "observer role");
}

function normalizeScope(value: ObserverScope | undefined): ObserverScope {
  const scope = value ?? "global";
  if (!OBSERVER_SCOPES.has(scope)) throw new Error(`Invalid observer scope: ${scope}`);
  return scope;
}

function normalizeMode(value: ObserverMode | undefined): ObserverMode {
  const mode = value ?? "observe";
  if (!OBSERVER_MODES.has(mode)) throw new Error(`Invalid observer mode: ${mode}`);
  return mode;
}

function normalizeDeliveryPolicy(value: ObservationDeliveryPolicy | undefined): ObservationDeliveryPolicy {
  const policy = value ?? "end_of_turn";
  if (!DELIVERY_POLICIES.has(policy)) throw new Error(`Invalid observation delivery policy: ${policy}`);
  return policy;
}

function normalizeTagTargetType(
  value: ObserverTagTargetType | string | null | undefined,
): ObserverTagTargetType | null {
  const tagTargetType = cleanOptionalText(value);
  if (!tagTargetType) return null;
  if (!OBSERVER_TAG_TARGET_TYPES.has(tagTargetType as ObserverTagTargetType)) {
    throw new Error(`Invalid observer tag target type: ${tagTargetType}`);
  }
  return tagTargetType as ObserverTagTargetType;
}

function normalizeEventTypes(values?: string[]): string[] {
  const normalized = [
    ...new Set((values ?? DEFAULT_EVENT_TYPES).map(normalizeObservationEventType).filter(Boolean)),
  ].sort();
  if (normalized.length === 0) throw new Error("Observer rule requires at least one event type.");
  return normalized;
}

function normalizeObservationEventType(value: string): string {
  const eventType = value.trim();
  return eventType === "turn.interrupted" ? "turn.interrupt" : eventType;
}

function normalizePermissionGrants(values?: string[]): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function validateRuleSafety(input: {
  scope: ObserverScope;
  mode: ObserverMode;
  observerAgentId: string;
  observerRuntimeProviderId?: RuntimeProviderId;
  observerModel?: string;
  tagTargetType?: ObserverTagTargetType | null;
  tagSlug?: string | null;
  permissionGrants: string[];
}): void {
  const observerAgent = dbGetAgent(input.observerAgentId);
  if (!observerAgent) {
    throw new Error(`Observer agent not found: ${input.observerAgentId}`);
  }
  if (input.observerModel) {
    const providerId = input.observerRuntimeProviderId ?? observerAgent.provider ?? DEFAULT_RUNTIME_PROVIDER_ID;
    const result = validateRuntimeModelSelector(providerId, input.observerModel);
    if (!result.ok) {
      throw new Error(result.error ?? `Invalid observer model: ${input.observerModel}`);
    }
  }
  if (input.scope === "tag" && (!input.tagTargetType || !input.tagSlug)) {
    throw new Error("Tag-scoped observer rules require --tag and --tag-target.");
  }
  if (input.scope !== "tag" && (input.tagTargetType || input.tagSlug)) {
    throw new Error("Tag selector fields are only valid with scope=tag.");
  }
  if (input.mode === "observe" && input.permissionGrants.length > 0) {
    throw new Error("Observe-mode rules cannot grant permissions.");
  }
  if (input.mode === "intervene") {
    throw new Error("Intervene-mode observer rules require a future explicit policy and are not supported yet.");
  }
}

function hashParts(parts: Array<string | undefined | null>, length = 16): string {
  return createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\x1f"))
    .digest("hex")
    .slice(0, length);
}

function makeBindingId(sourceSessionKey: string, observerRole: string): string {
  return `ob_${hashParts([sourceSessionKey, observerRole], 20)}`;
}

function makeObserverSessionName(sourceSessionKey: string, observerRole: string): string {
  const role = observerRole.replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
  return `obs:${hashParts([sourceSessionKey, observerRole], 12)}:${role}`;
}

function rowToRule(row: ObserverRuleRow): ObserverRule {
  return {
    id: row.id,
    enabled: row.enabled === 1,
    scope: row.scope,
    priority: row.priority,
    observerRole: row.observer_role,
    observerAgentId: row.observer_agent_id,
    ...(row.observer_runtime_provider_id ? { observerRuntimeProviderId: row.observer_runtime_provider_id } : {}),
    ...(row.observer_model ? { observerModel: row.observer_model } : {}),
    observerMode: row.observer_mode,
    eventTypes: normalizeEventTypes(parseJsonArray(row.event_types_json, DEFAULT_EVENT_TYPES)),
    deliveryPolicy: row.delivery_policy,
    ...(row.debounce_ms !== null ? { debounceMs: row.debounce_ms } : {}),
    ...(row.source_agent_id ? { sourceAgentId: row.source_agent_id } : {}),
    ...(row.source_session ? { sourceSession: row.source_session } : {}),
    ...(row.source_task_id ? { sourceTaskId: row.source_task_id } : {}),
    ...(row.source_profile_id ? { sourceProfileId: row.source_profile_id } : {}),
    ...(row.source_project_id ? { sourceProjectId: row.source_project_id } : {}),
    ...(row.tag_target_type ? { tagTargetType: row.tag_target_type } : {}),
    ...(row.tag_slug ? { tagSlug: row.tag_slug } : {}),
    tagInherited: row.tag_inherited === 1,
    permissionGrants: parseJsonArray(row.permission_grants_json),
    ...(parseJsonObject(row.metadata_json) ? { metadata: parseJsonObject(row.metadata_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBinding(row: ObserverBindingRow): ObserverBinding {
  return {
    id: row.id,
    sourceSessionKey: row.source_session_key,
    ...(row.source_session_name ? { sourceSessionName: row.source_session_name } : {}),
    sourceAgentId: row.source_agent_id,
    observerSessionName: row.observer_session_name,
    observerAgentId: row.observer_agent_id,
    ...(row.observer_runtime_provider_id ? { observerRuntimeProviderId: row.observer_runtime_provider_id } : {}),
    ...(row.observer_model ? { observerModel: row.observer_model } : {}),
    observerRole: row.observer_role,
    observerMode: row.observer_mode,
    ruleId: row.rule_id,
    eventTypes: normalizeEventTypes(parseJsonArray(row.event_types_json, DEFAULT_EVENT_TYPES)),
    deliveryPolicy: row.delivery_policy,
    ...(row.debounce_ms !== null ? { debounceMs: row.debounce_ms } : {}),
    permissionGrants: parseJsonArray(row.permission_grants_json),
    ...(parseJsonObject(row.metadata_json) ? { metadata: parseJsonObject(row.metadata_json) } : {}),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_delivered_at !== null ? { lastDeliveredAt: row.last_delivered_at } : {}),
  };
}

export function dbListObserverRules(): ObserverRule[] {
  ensureObservationSchema();
  const rows = getDb().prepare("SELECT * FROM observer_rules ORDER BY priority ASC, id ASC").all() as ObserverRuleRow[];
  return rows.map(rowToRule);
}

export function dbGetObserverRule(id: string): ObserverRule | null {
  ensureObservationSchema();
  const row = getDb().prepare("SELECT * FROM observer_rules WHERE id = ?").get(id.trim()) as
    | ObserverRuleRow
    | undefined;
  return row ? rowToRule(row) : null;
}

export function dbUpsertObserverRule(input: ObserverRuleInput): ObserverRule {
  ensureObservationSchema();
  const id = normalizeId(input.id, "observer rule id");
  const existing = dbGetObserverRule(id);
  const scope = normalizeScope(input.scope ?? existing?.scope);
  const observerRole = normalizeRole(input.observerRole ?? existing?.observerRole ?? id);
  const observerAgentId = cleanOptionalText(input.observerAgentId ?? existing?.observerAgentId);
  if (!observerAgentId) throw new Error("Observer agent id is required.");
  const observerRuntimeProviderId = resolveOptionalTextOverride(
    input.observerRuntimeProviderId,
    existing?.observerRuntimeProviderId,
  ) as RuntimeProviderId | undefined;
  const observerModel = resolveOptionalTextOverride(input.observerModel, existing?.observerModel);
  const observerMode = normalizeMode(input.observerMode ?? existing?.observerMode);
  const eventTypes = normalizeEventTypes(input.eventTypes ?? existing?.eventTypes);
  const deliveryPolicy = normalizeDeliveryPolicy(input.deliveryPolicy ?? existing?.deliveryPolicy);
  const permissionGrants = normalizePermissionGrants(input.permissionGrants ?? existing?.permissionGrants);
  const tagTargetType = normalizeTagTargetType(input.tagTargetType ?? existing?.tagTargetType);
  const tagSlug = cleanOptionalText(input.tagSlug ?? existing?.tagSlug);

  validateRuleSafety({
    scope,
    mode: observerMode,
    observerAgentId,
    observerRuntimeProviderId,
    observerModel,
    tagTargetType,
    tagSlug,
    permissionGrants,
  });

  const now = Date.now();
  const enabled = input.enabled ?? existing?.enabled ?? true;
  getDb()
    .prepare(
      `
        INSERT INTO observer_rules (
          id, enabled, scope, priority, observer_role, observer_agent_id,
          observer_runtime_provider_id, observer_model, observer_mode,
          event_types_json, delivery_policy, debounce_ms,
          source_agent_id, source_session, source_task_id, source_profile_id, source_project_id,
          tag_target_type, tag_slug, tag_inherited, permission_grants_json, metadata_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          enabled = excluded.enabled,
          scope = excluded.scope,
          priority = excluded.priority,
          observer_role = excluded.observer_role,
          observer_agent_id = excluded.observer_agent_id,
          observer_runtime_provider_id = excluded.observer_runtime_provider_id,
          observer_model = excluded.observer_model,
          observer_mode = excluded.observer_mode,
          event_types_json = excluded.event_types_json,
          delivery_policy = excluded.delivery_policy,
          debounce_ms = excluded.debounce_ms,
          source_agent_id = excluded.source_agent_id,
          source_session = excluded.source_session,
          source_task_id = excluded.source_task_id,
          source_profile_id = excluded.source_profile_id,
          source_project_id = excluded.source_project_id,
          tag_target_type = excluded.tag_target_type,
          tag_slug = excluded.tag_slug,
          tag_inherited = excluded.tag_inherited,
          permission_grants_json = excluded.permission_grants_json,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      id,
      enabled ? 1 : 0,
      scope,
      input.priority ?? existing?.priority ?? 100,
      observerRole,
      observerAgentId,
      observerRuntimeProviderId ?? null,
      observerModel ?? null,
      observerMode,
      stringifyJson(eventTypes),
      deliveryPolicy,
      input.debounceMs ?? existing?.debounceMs ?? null,
      cleanOptionalText(input.sourceAgentId ?? existing?.sourceAgentId),
      cleanOptionalText(input.sourceSession ?? existing?.sourceSession),
      cleanOptionalText(input.sourceTaskId ?? existing?.sourceTaskId),
      cleanOptionalText(input.sourceProfileId ?? existing?.sourceProfileId),
      cleanOptionalText(input.sourceProjectId ?? existing?.sourceProjectId),
      tagTargetType,
      tagSlug,
      (input.tagInherited ?? existing?.tagInherited) ? 1 : 0,
      stringifyJson(permissionGrants),
      (input.metadata ?? existing?.metadata) ? stringifyJson(input.metadata ?? existing?.metadata) : null,
      existing?.createdAt ?? now,
      now,
    );

  return dbGetObserverRule(id)!;
}

export function dbDeleteObserverRule(id: string): boolean {
  ensureObservationSchema();
  const result = getDb().prepare("DELETE FROM observer_rules WHERE id = ?").run(id.trim());
  return result.changes > 0;
}

export function dbSetObserverRuleEnabled(id: string, enabled: boolean): ObserverRule {
  ensureObservationSchema();
  const rule = dbGetObserverRule(id);
  if (!rule) throw new Error(`Observer rule not found: ${id}`);
  getDb()
    .prepare("UPDATE observer_rules SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, Date.now(), id);
  return dbGetObserverRule(id)!;
}

export function dbListObserverBindings(
  options: {
    sourceSessionKey?: string;
    sourceSessionName?: string;
    observerSessionName?: string;
    observerAgentId?: string;
    enabled?: boolean;
  } = {},
): ObserverBinding[] {
  ensureObservationSchema();
  const filters: string[] = [];
  const params: Array<string | number> = [];
  if (options.sourceSessionKey) {
    filters.push("source_session_key = ?");
    params.push(options.sourceSessionKey);
  }
  if (options.sourceSessionName) {
    filters.push("source_session_name = ?");
    params.push(options.sourceSessionName);
  }
  if (options.observerSessionName) {
    filters.push("observer_session_name = ?");
    params.push(options.observerSessionName);
  }
  if (options.observerAgentId) {
    filters.push("observer_agent_id = ?");
    params.push(options.observerAgentId);
  }
  if (options.enabled !== undefined) {
    filters.push("enabled = ?");
    params.push(options.enabled ? 1 : 0);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM observer_bindings ${where} ORDER BY updated_at DESC, id ASC`)
    .all(...params) as ObserverBindingRow[];
  return rows.map(rowToBinding);
}

export function dbGetObserverBinding(id: string): ObserverBinding | null {
  ensureObservationSchema();
  const row = getDb().prepare("SELECT * FROM observer_bindings WHERE id = ?").get(id.trim()) as
    | ObserverBindingRow
    | undefined;
  return row ? rowToBinding(row) : null;
}

function upsertObserverBinding(input: { source: ObservationSourceDescriptor; rule: ObserverRule }): {
  binding: ObserverBinding;
  created: boolean;
} {
  ensureObservationSchema();
  const id = makeBindingId(input.source.sessionKey, input.rule.observerRole);
  const existing = dbGetObserverBinding(id);
  const now = Date.now();
  const observerSessionName =
    existing?.observerSessionName ?? makeObserverSessionName(input.source.sessionKey, input.rule.observerRole);
  getDb()
    .prepare(
      `
        INSERT INTO observer_bindings (
          id, source_session_key, source_session_name, source_agent_id,
          observer_session_name, observer_agent_id,
          observer_runtime_provider_id, observer_model,
          observer_role, observer_mode, rule_id,
          event_types_json, delivery_policy, debounce_ms, permission_grants_json, metadata_json,
          enabled, created_at, updated_at, last_delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_session_key, observer_role) DO UPDATE SET
          source_session_name = excluded.source_session_name,
          source_agent_id = excluded.source_agent_id,
          observer_agent_id = excluded.observer_agent_id,
          observer_runtime_provider_id = excluded.observer_runtime_provider_id,
          observer_model = excluded.observer_model,
          observer_mode = excluded.observer_mode,
          rule_id = excluded.rule_id,
          event_types_json = excluded.event_types_json,
          delivery_policy = excluded.delivery_policy,
          debounce_ms = excluded.debounce_ms,
          permission_grants_json = excluded.permission_grants_json,
          metadata_json = excluded.metadata_json,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      id,
      input.source.sessionKey,
      input.source.sessionName,
      input.source.agentId,
      observerSessionName,
      input.rule.observerAgentId,
      input.rule.observerRuntimeProviderId ?? null,
      input.rule.observerModel ?? null,
      input.rule.observerRole,
      input.rule.observerMode,
      input.rule.id,
      stringifyJson(input.rule.eventTypes),
      input.rule.deliveryPolicy,
      input.rule.debounceMs ?? null,
      stringifyJson(input.rule.permissionGrants),
      input.rule.metadata ? stringifyJson(input.rule.metadata) : null,
      input.rule.enabled ? 1 : 0,
      existing?.createdAt ?? now,
      now,
      existing?.lastDeliveredAt ?? null,
    );

  const binding = dbGetObserverBinding(id)!;
  return { binding, created: !existing };
}

function readSessionByNameOrKey(nameOrKey: string): SessionEntry | null {
  return getSessionByName(nameOrKey) ?? getSession(nameOrKey);
}

function uniqueTags(
  tags: Array<{
    targetType: ObserverTagTargetType;
    slug: string;
    assetId: string;
    inherited: boolean;
  }>,
) {
  const seen = new Set<string>();
  const result: typeof tags = [];
  for (const tag of tags) {
    const key = `${tag.targetType}:${tag.slug}:${tag.assetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

function collectTagsForTarget(
  targetType: TagAssetType,
  assetId?: string,
  inherited = false,
): Array<{ targetType: ObserverTagTargetType; slug: string; assetId: string; inherited: boolean }> {
  if (!assetId) return [];
  return dbFindTagBindings({ assetType: targetType, assetId }).map((binding) => ({
    targetType: binding.assetType as ObserverTagTargetType,
    slug: binding.tagSlug,
    assetId: binding.assetId,
    inherited,
  }));
}

export function buildObservationSourceDescriptor(input: {
  sessionName: string;
  session: SessionEntry;
  agentId?: string;
  prompt?: RuntimeLaunchPrompt;
}): ObservationSourceDescriptor {
  const sourceSessionName = input.session.name ?? input.sessionName;
  const activeTask = dbResolveActiveTaskBindingForSession(sourceSessionName, input.prompt?.taskBarrierTaskId);
  const task = activeTask?.task;
  const workflow = task?.id ? dbGetTaskWorkflowSurface(task.id) : null;
  const project = workflow ? getProjectSurfaceByWorkflowRunId(workflow.workflowRunId) : null;
  const tags = uniqueTags([
    ...collectTagsForTarget("session", sourceSessionName),
    ...(sourceSessionName !== input.session.sessionKey
      ? collectTagsForTarget("session", input.session.sessionKey)
      : []),
    ...collectTagsForTarget("agent", input.agentId ?? input.session.agentId, true),
    ...collectTagsForTarget("task", task?.id, true),
    ...collectTagsForTarget("profile", task?.profileId, true),
    ...collectTagsForTarget("project", project?.projectId, true),
    ...(project?.projectSlug && project.projectSlug !== project.projectId
      ? collectTagsForTarget("project", project.projectSlug, true)
      : []),
  ]);

  return {
    sessionKey: input.session.sessionKey,
    sessionName: sourceSessionName,
    agentId: input.agentId ?? input.session.agentId,
    ...(task?.id ? { taskId: task.id } : {}),
    ...(task?.profileId ? { profileId: task.profileId } : {}),
    ...(project?.projectId ? { projectId: project.projectId } : {}),
    ...(project?.projectSlug ? { projectSlug: project.projectSlug } : {}),
    tags,
  };
}

function isObserverPrompt(prompt?: RuntimeLaunchPrompt): boolean {
  return Boolean(prompt?._observation);
}

function isObserverSessionName(sessionName: string): boolean {
  return sessionName.startsWith("obs:");
}

function matchRule(rule: ObserverRule, source: ObservationSourceDescriptor): { matched: boolean; reason: string } {
  if (!rule.enabled) return { matched: false, reason: "disabled" };
  switch (rule.scope) {
    case "global":
      return { matched: true, reason: "global" };
    case "agent":
      return rule.sourceAgentId && rule.sourceAgentId !== source.agentId
        ? { matched: false, reason: "agent_mismatch" }
        : { matched: true, reason: rule.sourceAgentId ? "agent" : "agent_any" };
    case "session":
      return rule.sourceSession && rule.sourceSession !== source.sessionName && rule.sourceSession !== source.sessionKey
        ? { matched: false, reason: "session_mismatch" }
        : {
            matched: true,
            reason: rule.sourceSession ? "session" : "session_any",
          };
    case "task":
      return rule.sourceTaskId && rule.sourceTaskId !== source.taskId
        ? { matched: false, reason: "task_mismatch" }
        : source.taskId
          ? { matched: true, reason: rule.sourceTaskId ? "task" : "task_any" }
          : { matched: false, reason: "no_task" };
    case "profile":
      return rule.sourceProfileId && rule.sourceProfileId !== source.profileId
        ? { matched: false, reason: "profile_mismatch" }
        : source.profileId
          ? {
              matched: true,
              reason: rule.sourceProfileId ? "profile" : "profile_any",
            }
          : { matched: false, reason: "no_profile" };
    case "project":
      return rule.sourceProjectId &&
        rule.sourceProjectId !== source.projectId &&
        rule.sourceProjectId !== source.projectSlug
        ? { matched: false, reason: "project_mismatch" }
        : source.projectId
          ? {
              matched: true,
              reason: rule.sourceProjectId ? "project" : "project_any",
            }
          : { matched: false, reason: "no_project" };
    case "tag": {
      const tagTarget = rule.tagTargetType ?? "any";
      const matchedTag = source.tags.find(
        (tag) =>
          tag.slug === rule.tagSlug &&
          (tagTarget === "any" || tag.targetType === tagTarget) &&
          (rule.tagInherited || !tag.inherited),
      );
      return matchedTag
        ? {
            matched: true,
            reason: `tag:${matchedTag.targetType}:${matchedTag.slug}${matchedTag.inherited ? ":inherited" : ""}`,
          }
        : { matched: false, reason: "tag_mismatch" };
    }
  }
}

export function explainObserverRulesForSession(nameOrKey: string): {
  source: ObservationSourceDescriptor | null;
  rules: Array<{ rule: ObserverRule; matched: boolean; reason: string }>;
  bindings: ObserverBinding[];
} {
  const session = readSessionByNameOrKey(nameOrKey);
  if (!session) {
    return { source: null, rules: [], bindings: [] };
  }
  const source = buildObservationSourceDescriptor({
    sessionName: session.name ?? session.sessionKey,
    session,
  });
  const rules = dbListObserverRules().map((rule) => ({
    rule,
    ...matchRule(rule, source),
  }));
  const bindings = dbListObserverBindings({
    sourceSessionKey: source.sessionKey,
  });
  return { source, rules, bindings };
}

export function ensureObserverBindingsForSession(input: {
  sessionName: string;
  session: SessionEntry;
  agent?: AgentConfig;
  prompt?: RuntimeLaunchPrompt;
}): {
  source: ObservationSourceDescriptor | null;
  bindings: ObserverBinding[];
  created: ObserverBinding[];
  skipped: Array<{ ruleId?: string; reason: string }>;
} {
  if (isObserverPrompt(input.prompt) || isObserverSessionName(input.sessionName)) {
    return {
      source: null,
      bindings: [],
      created: [],
      skipped: [{ reason: "observer_session" }],
    };
  }

  const source = buildObservationSourceDescriptor({
    sessionName: input.sessionName,
    session: input.session,
    agentId: input.agent?.id,
    prompt: input.prompt,
  });
  const created: ObserverBinding[] = [];
  const bindings: ObserverBinding[] = [];
  const skipped: Array<{ ruleId?: string; reason: string }> = [];
  const usedRoles = new Set<string>();

  for (const rule of dbListObserverRules()) {
    const match = matchRule(rule, source);
    if (!match.matched) {
      skipped.push({ ruleId: rule.id, reason: match.reason });
      continue;
    }
    if (usedRoles.has(rule.observerRole)) {
      skipped.push({ ruleId: rule.id, reason: "duplicate_role" });
      continue;
    }
    usedRoles.add(rule.observerRole);
    const result = upsertObserverBinding({ source, rule });
    bindings.push(result.binding);
    if (result.created) created.push(result.binding);
  }

  return { source, bindings, created, skipped };
}

function bindingAllowsEvent(
  binding: ObserverBinding,
  event: ObservationEvent,
  deliveryPolicies?: Set<ObservationDeliveryPolicy>,
): boolean {
  return (
    binding.enabled &&
    binding.deliveryPolicy !== "manual" &&
    (!deliveryPolicies || deliveryPolicies.has(binding.deliveryPolicy)) &&
    binding.eventTypes.includes(event.type)
  );
}

function compactEvent(event: ObservationEvent): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.preview ? { preview: event.preview.slice(0, 500) } : {}),
    ...(event.payload ? { payload: event.payload } : {}),
  };
}

function observerInstructions(binding: ObserverBinding): string | undefined {
  const value = binding.metadata?.instructions;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function composeObservationPrompt(input: {
  binding: ObserverBinding;
  source: ObservationSourceDescriptor;
  events: ObservationEvent[];
  runId?: string;
}): string {
  const instructions = observerInstructions(input.binding);
  const eventLines = input.events
    .map((event, index) => `${index + 1}. ${JSON.stringify(compactEvent(event))}`)
    .join("\n");
  return `## Ravi Observation Batch

Source session: ${input.source.sessionName}
Source session key: ${input.source.sessionKey}
Source agent: ${input.source.agentId}
${input.source.taskId ? `Task: ${input.source.taskId}\n` : ""}${input.source.profileId ? `Task profile: ${input.source.profileId}\n` : ""}Observer binding: ${input.binding.id}
Observer role: ${input.binding.observerRole}
Observer mode: ${input.binding.observerMode}
Rule: ${input.binding.ruleId}
${input.runId ? `Run: ${input.runId}\n` : ""}
You are an observer session. Use only your own permissions and tools. Do not assume you can write to the source session. Do not send chat messages unless your observer instructions and permissions explicitly require that.
${instructions ? `\nObserver instructions:\n${instructions}\n` : ""}

Events:
${eventLines}
`;
}

export async function deliverObservationEvents(input: {
  sourceSessionName: string;
  sourceSession: SessionEntry;
  agentId: string;
  events: ObservationEvent[];
  deliveryPolicies?: ObservationDeliveryPolicy[];
  runId?: string;
}): Promise<{
  delivered: Array<{
    bindingId: string;
    observerSessionName: string;
    eventCount: number;
  }>;
  skipped: Array<{ bindingId: string; reason: string }>;
}> {
  if (input.events.length === 0 || isObserverSessionName(input.sourceSessionName)) {
    return { delivered: [], skipped: [] };
  }
  const source = buildObservationSourceDescriptor({
    sessionName: input.sourceSessionName,
    session: input.sourceSession,
    agentId: input.agentId,
  });
  const bindings = dbListObserverBindings({
    sourceSessionKey: source.sessionKey,
    enabled: true,
  });
  const delivered: Array<{
    bindingId: string;
    observerSessionName: string;
    eventCount: number;
  }> = [];
  const skipped: Array<{ bindingId: string; reason: string }> = [];
  const deliveryPolicies = input.deliveryPolicies ? new Set(input.deliveryPolicies) : undefined;

  for (const binding of bindings) {
    const selected = input.events.filter((event) => bindingAllowsEvent(binding, event, deliveryPolicies));
    if (selected.length === 0) {
      skipped.push({ bindingId: binding.id, reason: "no_matching_events" });
      continue;
    }

    const prompt = composeObservationPrompt({
      binding,
      source,
      events: selected,
      runId: input.runId,
    });
    await observationPromptPublisher(binding.observerSessionName, {
      prompt,
      _agentId: binding.observerAgentId,
      ...(binding.observerRuntimeProviderId ? { _runtimeProviderId: binding.observerRuntimeProviderId } : {}),
      ...(binding.observerModel ? { _runtimeModel: binding.observerModel } : {}),
      _observation: {
        sourceSessionKey: source.sessionKey,
        sourceSessionName: source.sessionName,
        bindingId: binding.id,
        ruleId: binding.ruleId,
        role: binding.observerRole,
        mode: binding.observerMode,
        eventIds: selected.map((event) => event.id),
      },
      deliveryBarrier: "after_response",
    });
    getDb()
      .prepare("UPDATE observer_bindings SET last_delivered_at = ?, updated_at = ? WHERE id = ?")
      .run(Date.now(), Date.now(), binding.id);
    delivered.push({
      bindingId: binding.id,
      observerSessionName: binding.observerSessionName,
      eventCount: selected.length,
    });
  }

  return { delivered, skipped };
}

export function getObservationDebounceMs(input: {
  sourceSessionName: string;
  sourceSession: SessionEntry;
  agentId: string;
  eventTypes: string[];
}): number | null {
  if (input.eventTypes.length === 0 || isObserverSessionName(input.sourceSessionName)) {
    return null;
  }
  const source = buildObservationSourceDescriptor({
    sessionName: input.sourceSessionName,
    session: input.sourceSession,
    agentId: input.agentId,
  });
  const bindings = dbListObserverBindings({
    sourceSessionKey: source.sessionKey,
    enabled: true,
  });
  const delays = bindings
    .filter(
      (binding) =>
        binding.deliveryPolicy === "debounce" &&
        input.eventTypes.some((eventType) => binding.eventTypes.includes(eventType)),
    )
    .map((binding) => binding.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  return delays.length > 0 ? Math.min(...delays) : null;
}

export function validateObserverRules(): {
  ok: boolean;
  errors: Array<{ ruleId: string; message: string }>;
} {
  const errors: Array<{ ruleId: string; message: string }> = [];
  for (const rule of dbListObserverRules()) {
    try {
      validateRuleSafety({
        scope: rule.scope,
        mode: rule.observerMode,
        observerAgentId: rule.observerAgentId,
        observerRuntimeProviderId: rule.observerRuntimeProviderId,
        observerModel: rule.observerModel,
        tagTargetType: rule.tagTargetType,
        tagSlug: rule.tagSlug,
        permissionGrants: rule.permissionGrants,
      });
    } catch (error) {
      errors.push({
        ruleId: rule.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

export function createObservationEvent(
  input: Omit<ObservationEvent, "id" | "timestamp"> & {
    runId: string;
    sequence: number;
    timestamp?: number;
  },
): ObservationEvent {
  return {
    id: `obs_evt_${input.runId}_${input.sequence}`,
    type: input.type,
    timestamp: input.timestamp ?? Date.now(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.preview ? { preview: input.preview } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
  };
}

export function logObservationDeliveryFailure(error: unknown, context: Record<string, unknown>): void {
  log.warn("Observation delivery failed", { ...context, error });
}
