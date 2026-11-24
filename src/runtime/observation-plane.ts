import { sessionHoldsTriggerOwnerHistory } from "../router/sessions.js";
import { isTriggerOwnSessionKey } from "../triggers/authority.js";
import {
  evaluateObservationConditions,
  parseObservationConditions,
  renderObservationConditions,
  type ObservationConditionHit,
} from "./observation-conditions.js";
import { createHash } from "node:crypto";
import { assertAutomationStoreWrite } from "../permissions/user-overlay-automation.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import {
  CLI_COMMAND_ACCESS_KIND_MIGRATION_KEYS,
  migrateSerializedCapabilityArray,
} from "../permissions/command-access-kind-migration.js";
import { getSession, getSessionByName, type AgentConfig, type SessionEntry } from "../router/index.js";
import { dbGetAgent, dbListSessionParticipants, getDb, getRaviDbPath } from "../router/router-db.js";
import { canonicalTagSlugsForAsset, dbGetTagDefinition } from "../tags/index.js";
import type { TagAssetType } from "../tags/types.js";
import { logger } from "../utils/logger.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { validateRuntimeModelSelector } from "./model-validation.js";
import {
  buildObserverProfileSnapshotMarkdown,
  renderObservationPromptForProfile,
  resolveObserverProfile,
  resolveObserverProfileFromSnapshotMarkdown,
} from "./observation-profiles.js";
import { DEFAULT_RUNTIME_PROVIDER_ID } from "./provider-registry.js";
import type { RuntimeProviderId } from "./types.js";
import { compilePredicate, type CompiledPredicate } from "../policy/predicate.js";
import { classifyTurnProvenance, type TurnProvenance } from "./turn-provenance.js";

const log = logger.child("runtime:observation-plane");

export type ObserverScope = "global" | "agent" | "session" | "task" | "profile" | "project" | "tag";
export type ObserverMode = "observe" | "summarize" | "report" | "intervene";
export type ObservationDeliveryPolicy = "realtime" | "debounce" | "end_of_turn" | "manual";
export type ObserverTagTargetType = "agent" | "session" | "task" | "project" | "contact" | "profile" | "any";
export type ObserverReconcileMode = "attach-missing" | "detach-disabled" | "refresh-profile" | "full-reconcile";

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

/**
 * Hard tool allowlist for one observation turn.
 *
 * Observer rules grant exact tools (`use:tool:tasks_show`, ...). The capability
 * gate alone is not enough: a provider with native tools (Pi: bash/edit) can
 * still call them when the agent ceiling allows it, which is how the task
 * observer ended up shelling out instead of calling its granted tools.
 * Returning the granted tool names lets the provider narrow its catalog.
 */
export function resolveObservationAllowedTools(permissionGrants: readonly string[] | undefined): string[] | undefined {
  const tools = (permissionGrants ?? [])
    .map((grant) => grant.trim())
    .filter((grant) => grant.startsWith("use:tool:"))
    .map((grant) => grant.slice("use:tool:".length).trim())
    .filter((tool) => tool.length > 0 && !tool.includes("*"));
  if (tools.length === 0) return undefined;
  return [...new Set(tools)].sort();
}

export interface ObserverRule {
  id: string;
  enabled: boolean;
  scope: ObserverScope;
  priority: number;
  observerRole: string;
  observerAgentId: string;
  observerRuntimeProviderId?: RuntimeProviderId;
  observerModel?: string;
  observerProfileId?: string;
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
  selector?: string;
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
  observerProfileId?: string | null;
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
  /** Predicate over source.*, turn.* and event.*; invalid selectors fail closed. */
  selector?: string | null;
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
  observerProfileId?: string;
  observerProfileVersion?: string;
  observerProfileSource?: string;
  observerProfileSnapshotMarkdown?: string;
  observerRole: string;
  observerMode: ObserverMode;
  ruleId: string;
  eventTypes: string[];
  deliveryPolicy: ObservationDeliveryPolicy;
  debounceMs?: number;
  permissionGrants: string[];
  selector?: string;
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
  /** Snapshot of the turn cause; required for correct deferred/debounced selection. */
  turn: TurnProvenance;
}

export interface ObservationSourceTag {
  targetType: ObserverTagTargetType;
  slug: string;
  assetId: string;
  inherited: boolean;
}

export interface ObservationTagPolicyMatch {
  consumer: "observer_rule";
  behavior: "create_observer_binding";
  ruleId: string;
  tagSelector: {
    targetType: ObserverTagTargetType;
    slug: string;
    inherited: boolean;
  };
  matchedTag: ObservationSourceTag;
  permissionsGranted: string[];
}

export interface ObservationSourceDescriptor {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  taskId?: string;
  profileId?: string;
  projectId?: string;
  projectSlug?: string;
  contactIds?: string[];
  channel?: string;
  accountId?: string;
  chatId?: string;
  threadId?: string;
  chatType?: SessionEntry["chatType"];
  actorType?: string;
  tags: ObservationSourceTag[];
}

interface ObserverRuleMatchResult {
  matched: boolean;
  reason: string;
  policyMatch?: ObservationTagPolicyMatch;
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
  observer_profile_id: string | null;
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
  selector: string | null;
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
  observer_profile_id: string | null;
  observer_profile_version: string | null;
  observer_profile_source: string | null;
  observer_profile_snapshot_markdown: string | null;
  observer_role: string;
  observer_mode: ObserverMode;
  rule_id: string;
  event_types_json: string;
  delivery_policy: ObservationDeliveryPolicy;
  debounce_ms: number | null;
  permission_grants_json: string;
  selector: string | null;
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
      observer_profile_id TEXT,
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
      selector TEXT,
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
      observer_profile_id TEXT,
      observer_profile_version TEXT,
      observer_profile_source TEXT,
      observer_profile_snapshot_markdown TEXT,
      observer_role TEXT NOT NULL,
      observer_mode TEXT NOT NULL CHECK(observer_mode IN ('observe','summarize','report','intervene')),
      rule_id TEXT NOT NULL,
      event_types_json TEXT NOT NULL,
      delivery_policy TEXT NOT NULL CHECK(delivery_policy IN ('realtime','debounce','end_of_turn','manual')),
      debounce_ms INTEGER,
      permission_grants_json TEXT NOT NULL,
      selector TEXT,
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

    CREATE TABLE IF NOT EXISTS observer_delivery_events (
      binding_id TEXT NOT NULL REFERENCES observer_bindings(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      delivered_at INTEGER NOT NULL,
      PRIMARY KEY(binding_id, event_id)
    );
  `);
  ensureObservationColumn("observer_rules", "observer_runtime_provider_id", "TEXT");
  ensureObservationColumn("observer_rules", "observer_model", "TEXT");
  ensureObservationColumn("observer_rules", "observer_profile_id", "TEXT");
  ensureObservationColumn("observer_bindings", "observer_runtime_provider_id", "TEXT");
  ensureObservationColumn("observer_bindings", "observer_model", "TEXT");
  ensureObservationColumn("observer_bindings", "observer_profile_id", "TEXT");
  ensureObservationColumn("observer_bindings", "observer_profile_version", "TEXT");
  ensureObservationColumn("observer_bindings", "observer_profile_source", "TEXT");
  ensureObservationColumn("observer_bindings", "observer_profile_snapshot_markdown", "TEXT");
  ensureObservationColumn("observer_bindings", "debounce_ms", "INTEGER");
  ensureObservationColumn("observer_rules", "selector", "TEXT");
  ensureObservationColumn("observer_bindings", "selector", "TEXT");
  ensureObservationCommandAccessGrantMigration();
  ensureBindingsFollowRuleMigration();
  schemaReady = true;
  schemaDbPath = dbPath;
}

// Runtime lines the source prompt starts with (session surface hint, knowledge audience). They tell
// the source agent how to answer; an observer reading what the person said only pays for them.
const OBSERVATION_PREAMBLE_LINE = /^\[(?:session surface|knowledge)\] [^\n]*(?:\n|$)/;

/** The one truncation every observation preview uses. */
export function truncateObservationText(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 15)}... [truncated]` : value;
}

/** The `message.user` preview observers get: the prompt without its runtime lines, truncated. */
export function observedUserPreview(text: string, maxLength = 500): string {
  return truncateObservationText(stripObservationPreamble(text), maxLength);
}

/** The source prompt without its leading runtime lines, as observers should read it. */
export function stripObservationPreamble(text: string): string {
  let out = text;
  for (let match = OBSERVATION_PREAMBLE_LINE.exec(out); match; match = OBSERVATION_PREAMBLE_LINE.exec(out)) {
    out = out.slice(match[0].length);
  }
  return out;
}

const BINDINGS_FOLLOW_RULE_MIGRATION_KEY = "observation.bindings-follow-rule.v1";

/**
 * One-time repair for bindings left delivering by the old disable/rm path, which only refused new
 * bindings: every enabled binding whose rule is disabled or gone is disabled. Runs once per
 * database; from then on disable and rm keep bindings in step with their rule.
 */
export function ensureBindingsFollowRuleMigration(): { bindingsDisabled: number } {
  const db = getDb();
  const done = db.prepare("SELECT value FROM router_meta WHERE key = ?").get(BINDINGS_FOLLOW_RULE_MIGRATION_KEY) as
    | { value: string }
    | undefined;
  if (done?.value === "done") return { bindingsDisabled: 0 };
  const bindingsDisabled = db.transaction(() => {
    const changes = db
      .prepare(
        `UPDATE observer_bindings SET enabled = 0, updated_at = ?
         WHERE enabled = 1
           AND NOT EXISTS (
             SELECT 1 FROM observer_rules r WHERE r.id = observer_bindings.rule_id AND r.enabled = 1
           )`,
      )
      .run(Date.now()).changes;
    db.prepare("INSERT OR REPLACE INTO router_meta (key, value, updated_at) VALUES (?, ?, ?)").run(
      BINDINGS_FOLLOW_RULE_MIGRATION_KEY,
      "done",
      Date.now(),
    );
    return changes;
  })();
  if (bindingsDisabled > 0) {
    log.info("Disabled observer bindings whose rule is disabled or deleted", { bindingsDisabled });
  }
  return { bindingsDisabled };
}

export interface ObservationCommandAccessGrantMigrationSummary {
  changedRules: number;
  changedBindings: number;
  addedGrants: number;
  ambiguousGrants: number;
}

export function ensureObservationCommandAccessGrantMigration(): ObservationCommandAccessGrantMigrationSummary {
  const db = getDb();
  const existing = db
    .prepare("SELECT value FROM router_meta WHERE key = ?")
    .get(CLI_COMMAND_ACCESS_KIND_MIGRATION_KEYS.observation) as { value: string } | undefined;
  if (existing?.value === "done") {
    return { changedRules: 0, changedBindings: 0, addedGrants: 0, ambiguousGrants: 0 };
  }

  const summary = migrateObservationCommandAccessGrants();
  db.prepare("INSERT OR REPLACE INTO router_meta (key, value, updated_at) VALUES (?, ?, ?)").run(
    CLI_COMMAND_ACCESS_KIND_MIGRATION_KEYS.observation,
    "done",
    Date.now(),
  );
  return summary;
}

/**
 * Preserve least-privilege access after CLI operations move from read to mutate.
 * Rules and binding snapshots are both authoritative; runtime contexts are
 * intentionally immutable historical snapshots and are not touched here.
 */
export function migrateObservationCommandAccessGrants(): ObservationCommandAccessGrantMigrationSummary {
  const db = getDb();
  const summary: ObservationCommandAccessGrantMigrationSummary = {
    changedRules: 0,
    changedBindings: 0,
    addedGrants: 0,
    ambiguousGrants: 0,
  };

  db.transaction(() => {
    for (const table of ["observer_rules", "observer_bindings"] as const) {
      const rows = db.prepare(`SELECT id, permission_grants_json FROM ${table}`).all() as Array<{
        id: string;
        permission_grants_json: string;
      }>;
      const update = db.prepare(`UPDATE ${table} SET permission_grants_json = ? WHERE id = ?`);
      for (const row of rows) {
        const migration = migrateSerializedCapabilityArray(row.permission_grants_json);
        summary.ambiguousGrants += migration.ambiguous;
        if (!migration.changed) continue;
        update.run(migration.serialized, row.id);
        summary.addedGrants += migration.added;
        if (table === "observer_rules") summary.changedRules += 1;
        else summary.changedBindings += 1;
      }
    }
  })();

  if (summary.changedRules > 0 || summary.changedBindings > 0) {
    log.info("Migrated CLI read grants for reclassified commands", {
      store: "observation-plane",
      ...summary,
    });
  } else if (summary.ambiguousGrants > 0) {
    log.debug("Found broad observation read grants requiring manual review", {
      ambiguousGrants: summary.ambiguousGrants,
    });
  }

  return summary;
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

const OBSERVER_SELECTOR_ROOTS = ["source", "turn", "event"] as const;
const observerSelectorCache = new Map<string, CompiledPredicate>();

function compileObserverSelector(selector: string): CompiledPredicate {
  const cached = observerSelectorCache.get(selector);
  if (cached) return cached;
  const result = compilePredicate(selector, {
    allowedRoots: OBSERVER_SELECTOR_ROOTS,
    pathLabel: "source.<path>, turn.<path> or event.<path>",
  });
  if (!result.ok) throw new Error(`Invalid observer selector: ${result.error}`);
  observerSelectorCache.set(selector, result.predicate);
  if (observerSelectorCache.size > 500) {
    observerSelectorCache.delete(observerSelectorCache.keys().next().value ?? "");
  }
  return result.predicate;
}

function resolveSelectorOverride(value: string | null | undefined, existing?: string): string | undefined {
  const selector = resolveOptionalTextOverride(value, existing);
  if (selector) compileObserverSelector(selector);
  return selector;
}

interface ObserverSourceExclusions {
  agentIds: string[];
  sessionKeys: string[];
  sessionNames: string[];
  sessionKeyFragments: string[];
}

const OBSERVER_SOURCE_EXCLUSION_KEYS = [
  "agentIds",
  "sessionKeys",
  "sessionNames",
  "sessionKeyFragments",
] as const satisfies readonly (keyof ObserverSourceExclusions)[];
const OBSERVER_SOURCE_EXCLUSION_KEY_SET = new Set<string>(OBSERVER_SOURCE_EXCLUSION_KEYS);

function sourceExclusionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function observerSourceExclusions(metadata?: Record<string, unknown>): ObserverSourceExclusions | null {
  validateObserverSourceExclusions(metadata);
  const value = metadata?.sourceExclusions;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    agentIds: sourceExclusionList(raw.agentIds),
    sessionKeys: sourceExclusionList(raw.sessionKeys),
    sessionNames: sourceExclusionList(raw.sessionNames),
    sessionKeyFragments: sourceExclusionList(raw.sessionKeyFragments),
  };
}

/** `metadata.when`: the conditions that gate delivery; the binding then delivers only at end of turn. */
function observerConditions(metadata?: Record<string, unknown>): string[] | null {
  const value = metadata?.when;
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Observer metadata.when must be a list of condition names.");
  }
  return parseObservationConditions(value as string[]);
}

/**
 * `metadata.deliverTo`: a live session that gets the observation as a `[System] Inform`, through the
 * normal prompt path, instead of a dedicated observer session. Used by `ravi sessions observe`.
 */
function bindingInformTarget(binding: { metadata?: Record<string, unknown> }): string | null {
  const value = binding.metadata?.deliverTo;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Why a source session may not feed a live receiver, or null. A trigger's own session, and any
 * session whose history holds what a turn read with its trigger owner's authority, answer no chat
 * (`sessionHoldsTriggerOwnerHistory`); forwarding their turns to a conversation would be that answer.
 */
export function liveReceiverSourceRefusal(sourceSessionKey: string): string | null {
  if (isTriggerOwnSessionKey(sourceSessionKey)) return "source is a trigger's own session";
  if (sessionHoldsTriggerOwnerHistory(sourceSessionKey)) return "source holds what a turn read for its trigger's owner";
  return null;
}

function validateObserverInformTarget(
  metadata: Record<string, unknown> | undefined,
  scope: ObserverScope,
  sourceSession: string | null | undefined,
): void {
  if (metadata?.deliverTo === undefined || metadata.deliverTo === null) return;
  const target = bindingInformTarget({ metadata });
  if (!target) throw new Error("Observer metadata.deliverTo must be a session name.");
  if (scope !== "session" || !sourceSession) {
    throw new Error("Observer metadata.deliverTo needs a session-scoped rule with a source session.");
  }
  if (target === sourceSession.trim()) {
    throw new Error("A session cannot observe itself.");
  }
  // For every writer, operator included: owner reads never reach a conversation.
  const source = readSessionByNameOrKey(sourceSession.trim());
  const refusal = liveReceiverSourceRefusal(source?.sessionKey ?? sourceSession.trim());
  if (refusal) throw new Error(`A live receiver cannot observe this source: ${refusal}.`);
}

function validateObserverConditions(
  metadata: Record<string, unknown> | undefined,
  deliveryPolicy: ObservationDeliveryPolicy,
): void {
  const conditions = observerConditions(metadata);
  if (conditions && deliveryPolicy !== "end_of_turn") {
    throw new Error("Observer conditions (metadata.when) are checked at end of turn: use --delivery end_of_turn.");
  }
}

function validateObserverSourceExclusions(metadata?: Record<string, unknown>): void {
  const value = metadata?.sourceExclusions;
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Observer metadata.sourceExclusions must be an object.");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!OBSERVER_SOURCE_EXCLUSION_KEY_SET.has(key)) {
      throw new Error(`Observer metadata.sourceExclusions.${key} is not supported.`);
    }
  }
  for (const key of OBSERVER_SOURCE_EXCLUSION_KEYS) {
    const list = raw[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`Observer metadata.sourceExclusions.${key} must be an array of non-empty strings.`);
    }
  }
}

function sourceExclusionReason(
  metadata: Record<string, unknown> | undefined,
  source: ObservationSourceDescriptor,
): string | null {
  let exclusions: ObserverSourceExclusions | null;
  try {
    exclusions = observerSourceExclusions(metadata);
  } catch {
    // Persisted legacy metadata may predate validation or have been edited
    // directly. Unknown/malformed exclusions must never become an allow.
    return "invalid_source_exclusions";
  }
  if (!exclusions) return null;
  if (exclusions.agentIds.includes(source.agentId)) return "excluded_source_agent";
  if (exclusions.sessionKeys.includes(source.sessionKey)) return "excluded_source_session_key";
  if (exclusions.sessionNames.includes(source.sessionName)) return "excluded_source_session_name";
  if (exclusions.sessionKeyFragments.some((fragment) => source.sessionKey.includes(fragment))) {
    return "excluded_source_session_key_fragment";
  }
  return null;
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

function normalizeTagSlug(value: string | null | undefined): string | null {
  const slug = cleanOptionalText(value)?.toLowerCase();
  if (!slug) return null;
  if (!/^[a-z0-9._:-]+$/.test(slug)) {
    throw new Error(`Invalid observer tag slug: ${value}. Use [a-z0-9._:-].`);
  }
  return slug;
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
  observerProfileId?: string;
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
  if (input.observerProfileId) {
    resolveObserverProfile(input.observerProfileId);
  }
  if (input.scope === "tag" && (!input.tagTargetType || !input.tagSlug)) {
    throw new Error("Tag-scoped observer rules require --tag and --tag-target.");
  }
  if (input.scope !== "tag" && (input.tagTargetType || input.tagSlug)) {
    throw new Error("Tag selector fields are only valid with scope=tag.");
  }
  if (input.scope === "tag" && input.tagSlug) {
    const tag = dbGetTagDefinition(input.tagSlug);
    if (!tag) {
      throw new Error(`Tag selector references unknown tag: ${input.tagSlug}. Create it before using it in a rule.`);
    }
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
    ...(row.observer_profile_id ? { observerProfileId: row.observer_profile_id } : {}),
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
    ...(row.selector ? { selector: row.selector } : {}),
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
    ...(row.observer_profile_id ? { observerProfileId: row.observer_profile_id } : {}),
    ...(row.observer_profile_version ? { observerProfileVersion: row.observer_profile_version } : {}),
    ...(row.observer_profile_source ? { observerProfileSource: row.observer_profile_source } : {}),
    ...(row.observer_profile_snapshot_markdown
      ? { observerProfileSnapshotMarkdown: row.observer_profile_snapshot_markdown }
      : {}),
    observerRole: row.observer_role,
    observerMode: row.observer_mode,
    ruleId: row.rule_id,
    eventTypes: normalizeEventTypes(parseJsonArray(row.event_types_json, DEFAULT_EVENT_TYPES)),
    deliveryPolicy: row.delivery_policy,
    ...(row.debounce_ms !== null ? { debounceMs: row.debounce_ms } : {}),
    permissionGrants: parseJsonArray(row.permission_grants_json),
    ...(row.selector ? { selector: row.selector } : {}),
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
  // An observer rule makes the agent take turns later; a limited turn cannot
  // write one (disabling is a reduction and stays allowed).
  // Disabling is a reduction only for an existing rule whose other fields stay
  // as they are: creating a disabled rule, or changing observer, scope or
  // grants while passing `enabled: false`, is a write like any other.
  assertAutomationStoreWrite("observer rule", { disablesOnly: isObserverRuleDisableOnly(input) });
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
  const observerProfileId = resolveOptionalTextOverride(input.observerProfileId, existing?.observerProfileId);
  const observerProfile = resolveObserverProfile(observerProfileId);
  const observerMode = normalizeMode(input.observerMode ?? existing?.observerMode ?? observerProfile.defaults.mode);
  const eventTypes = normalizeEventTypes(
    input.eventTypes ?? existing?.eventTypes ?? observerProfile.defaults.eventTypes,
  );
  const deliveryPolicy = normalizeDeliveryPolicy(
    input.deliveryPolicy ?? existing?.deliveryPolicy ?? observerProfile.defaults.deliveryPolicy,
  );
  const permissionGrants = normalizePermissionGrants(input.permissionGrants ?? existing?.permissionGrants);
  const tagTargetType = normalizeTagTargetType(input.tagTargetType ?? existing?.tagTargetType);
  const tagSlug = normalizeTagSlug(input.tagSlug ?? existing?.tagSlug);
  const selector = resolveSelectorOverride(input.selector, existing?.selector);
  const metadata = input.metadata ?? existing?.metadata;
  validateObserverSourceExclusions(metadata);
  validateObserverConditions(metadata, deliveryPolicy);
  validateObserverInformTarget(metadata, scope, input.sourceSession ?? existing?.sourceSession);

  validateRuleSafety({
    scope,
    mode: observerMode,
    observerAgentId,
    observerRuntimeProviderId,
    observerModel,
    observerProfileId,
    tagTargetType,
    tagSlug,
    permissionGrants,
  });

  const now = Date.now();
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const db = getDb();
  // The rule row and the cascade commit together, like `rules disable` and `rules rm`.
  db.transaction(() => {
    db.prepare(
      `
        INSERT INTO observer_rules (
          id, enabled, scope, priority, observer_role, observer_agent_id,
          observer_runtime_provider_id, observer_model, observer_profile_id, observer_mode,
          event_types_json, delivery_policy, debounce_ms,
          source_agent_id, source_session, source_task_id, source_profile_id, source_project_id,
          tag_target_type, tag_slug, tag_inherited, permission_grants_json, selector, metadata_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          enabled = excluded.enabled,
          scope = excluded.scope,
          priority = excluded.priority,
          observer_role = excluded.observer_role,
          observer_agent_id = excluded.observer_agent_id,
          observer_runtime_provider_id = excluded.observer_runtime_provider_id,
          observer_model = excluded.observer_model,
          observer_profile_id = excluded.observer_profile_id,
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
          selector = excluded.selector,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
    ).run(
      id,
      enabled ? 1 : 0,
      scope,
      input.priority ?? existing?.priority ?? 100,
      observerRole,
      observerAgentId,
      observerRuntimeProviderId ?? null,
      observerModel ?? null,
      observerProfileId ?? null,
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
      selector ?? null,
      metadata ? stringifyJson(metadata) : null,
      existing?.createdAt ?? now,
      now,
    );

    // A rule saved disabled (`rules set --disabled`) stops its bindings too, like `rules disable`.
    if (!enabled) disableBindingsForRule(id);
  })();
  return dbGetObserverRule(id)!;
}

/** Delete a rule and stop every binding it created: a binding never outlives its rule. */
export function dbDeleteObserverRule(id: string): boolean {
  ensureObservationSchema();
  const db = getDb();
  const ruleId = id.trim();
  return db.transaction(() => {
    const result = db.prepare("DELETE FROM observer_rules WHERE id = ?").run(ruleId);
    if (result.changes > 0) disableBindingsForRule(ruleId);
    return result.changes > 0;
  })();
}

export function dbSetObserverRuleEnabled(id: string, enabled: boolean): ObserverRule {
  return setObserverRuleEnabled(id, enabled).rule;
}

/**
 * Enable or disable a rule. Disabling also disables every binding the rule created, so a
 * disabled rule stops delivering at once instead of only refusing new bindings. Enabling does
 * not touch bindings: each one comes back when its source session next launches and the rule
 * matches it again (the binding upsert copies the rule's state).
 */
export function setObserverRuleEnabled(id: string, enabled: boolean): { rule: ObserverRule; bindingsDisabled: number } {
  ensureObservationSchema();
  const rule = dbGetObserverRule(id);
  if (!rule) throw new Error(`Observer rule not found: ${id}`);
  const db = getDb();
  const bindingsDisabled = db.transaction(() => {
    db.prepare("UPDATE observer_rules SET enabled = ?, updated_at = ? WHERE id = ?").run(
      enabled ? 1 : 0,
      Date.now(),
      id,
    );
    return enabled ? 0 : disableBindingsForRule(id);
  })();
  return { rule: dbGetObserverRule(id)!, bindingsDisabled };
}

function disableBindingsForRule(ruleId: string): number {
  return getDb()
    .prepare("UPDATE observer_bindings SET enabled = 0, updated_at = ? WHERE rule_id = ? AND enabled = 1")
    .run(Date.now(), ruleId).changes;
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

function buildObserverBindingMetadata(
  rule: ObserverRule,
  match: ObserverRuleMatchResult,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = { ...(rule.metadata ?? {}) };
  if (match.policyMatch) {
    metadata.observerPolicy = match.policyMatch;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function upsertObserverBinding(input: {
  source: ObservationSourceDescriptor;
  rule: ObserverRule;
  match: ObserverRuleMatchResult;
}): {
  binding: ObserverBinding;
  created: boolean;
} {
  ensureObservationSchema();
  const id = makeBindingId(input.source.sessionKey, input.rule.observerRole);
  const existing = dbGetObserverBinding(id);
  const now = Date.now();
  const observerSessionName =
    existing?.observerSessionName ?? makeObserverSessionName(input.source.sessionKey, input.rule.observerRole);
  const profile = existing?.observerProfileSnapshotMarkdown
    ? resolveObserverProfileFromSnapshotMarkdown(existing.observerProfileSnapshotMarkdown)
    : resolveObserverProfile(input.rule.observerProfileId);
  const profileSnapshotMarkdown =
    existing?.observerProfileSnapshotMarkdown ?? buildObserverProfileSnapshotMarkdown(profile);
  const metadata = buildObserverBindingMetadata(input.rule, input.match);
  getDb()
    .prepare(
      `
        INSERT INTO observer_bindings (
          id, source_session_key, source_session_name, source_agent_id,
          observer_session_name, observer_agent_id,
          observer_runtime_provider_id, observer_model,
          observer_profile_id, observer_profile_version, observer_profile_source, observer_profile_snapshot_markdown,
          observer_role, observer_mode, rule_id,
          event_types_json, delivery_policy, debounce_ms, permission_grants_json, selector, metadata_json,
          enabled, created_at, updated_at, last_delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_session_key, observer_role) DO UPDATE SET
          source_session_name = excluded.source_session_name,
          source_agent_id = excluded.source_agent_id,
          observer_agent_id = excluded.observer_agent_id,
          observer_runtime_provider_id = excluded.observer_runtime_provider_id,
          observer_model = excluded.observer_model,
          observer_profile_id = COALESCE(observer_bindings.observer_profile_id, excluded.observer_profile_id),
          observer_profile_version = COALESCE(observer_bindings.observer_profile_version, excluded.observer_profile_version),
          observer_profile_source = COALESCE(observer_bindings.observer_profile_source, excluded.observer_profile_source),
          observer_profile_snapshot_markdown = COALESCE(observer_bindings.observer_profile_snapshot_markdown, excluded.observer_profile_snapshot_markdown),
          observer_mode = excluded.observer_mode,
          rule_id = excluded.rule_id,
          event_types_json = excluded.event_types_json,
          delivery_policy = excluded.delivery_policy,
          debounce_ms = excluded.debounce_ms,
          permission_grants_json = excluded.permission_grants_json,
          selector = excluded.selector,
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
      existing?.observerProfileId ?? profile.id,
      existing?.observerProfileVersion ?? profile.version,
      existing?.observerProfileSource ?? profile.source,
      profileSnapshotMarkdown,
      input.rule.observerRole,
      input.rule.observerMode,
      input.rule.id,
      stringifyJson(input.rule.eventTypes),
      input.rule.deliveryPolicy,
      input.rule.debounceMs ?? null,
      stringifyJson(input.rule.permissionGrants),
      input.rule.selector ?? null,
      metadata ? stringifyJson(metadata) : null,
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
  return canonicalTagSlugsForAsset(targetType, assetId).map((slug) => ({
    targetType: targetType as ObserverTagTargetType,
    slug,
    assetId,
    inherited,
  }));
}

function resolveSessionContactIds(session: SessionEntry): string[] {
  try {
    const participants = dbListSessionParticipants(session.sessionKey);
    const contactIds = participants
      .filter((participant) => participant.ownerType === "contact" && participant.ownerId)
      .map((participant) => participant.ownerId!.trim())
      .filter((value) => value.length > 0);
    return Array.from(new Set(contactIds));
  } catch (error) {
    log.warn("Failed to resolve session contact ids for observation descriptor", {
      sessionKey: session.sessionKey,
      error,
    });
    return [];
  }
}

export function buildObservationSourceDescriptor(input: {
  sessionName: string;
  session: SessionEntry;
  agentId?: string;
  prompt?: RuntimeLaunchPrompt;
}): ObservationSourceDescriptor {
  const sourceSessionName = input.session.name ?? input.sessionName;
  // The task id is provenance carried by the prompt; the observer plane does not read task state.
  const taskId = input.prompt?.taskBarrierTaskId?.trim() || undefined;
  const contactIds = resolveSessionContactIds(input.session);
  const promptSource = input.prompt?.source;
  const promptContext = input.prompt?.context;
  const tags = uniqueTags([
    ...collectTagsForTarget("session", sourceSessionName),
    ...(sourceSessionName !== input.session.sessionKey
      ? collectTagsForTarget("session", input.session.sessionKey)
      : []),
    ...collectTagsForTarget("agent", input.agentId ?? input.session.agentId, true),
    ...contactIds.flatMap((contactId) => collectTagsForTarget("contact", contactId)),
  ]);

  return {
    sessionKey: input.session.sessionKey,
    sessionName: sourceSessionName,
    agentId: input.agentId ?? input.session.agentId,
    ...(taskId ? { taskId } : {}),
    ...(contactIds.length > 0 ? { contactIds } : {}),
    ...((promptSource?.channel ?? input.session.channel ?? input.session.lastChannel)
      ? { channel: promptSource?.channel ?? input.session.channel ?? input.session.lastChannel }
      : {}),
    ...((promptSource?.accountId ?? promptContext?.accountId ?? input.session.accountId ?? input.session.lastAccountId)
      ? {
          accountId:
            promptSource?.accountId ??
            promptContext?.accountId ??
            input.session.accountId ??
            input.session.lastAccountId,
        }
      : {}),
    ...((promptSource?.chatId ?? promptContext?.chatId ?? input.session.lastTo)
      ? { chatId: promptSource?.chatId ?? promptContext?.chatId ?? input.session.lastTo }
      : {}),
    ...((promptSource?.threadId ?? input.session.lastThreadId)
      ? { threadId: promptSource?.threadId ?? input.session.lastThreadId }
      : {}),
    ...(input.session.chatType ? { chatType: input.session.chatType } : {}),
    ...((promptContext?.actorType ?? promptSource?.actorType)
      ? { actorType: promptContext?.actorType ?? promptSource?.actorType }
      : {}),
    tags,
  };
}

function isObserverPrompt(prompt?: RuntimeLaunchPrompt): boolean {
  return Boolean(prompt?._observation);
}

function isObserverSessionName(sessionName: string): boolean {
  return sessionName.startsWith("obs:");
}

function matchLegacyRule(rule: ObserverRule, source: ObservationSourceDescriptor): ObserverRuleMatchResult {
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
      if (!rule.tagSlug) return { matched: false, reason: "tag_mismatch" };
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
            policyMatch: {
              consumer: "observer_rule",
              behavior: "create_observer_binding",
              ruleId: rule.id,
              tagSelector: {
                targetType: tagTarget,
                slug: rule.tagSlug,
                inherited: rule.tagInherited,
              },
              matchedTag,
              permissionsGranted: rule.permissionGrants,
            },
          }
        : { matched: false, reason: "tag_mismatch" };
    }
  }
}

function matchRule(rule: ObserverRule, source: ObservationSourceDescriptor): ObserverRuleMatchResult {
  const legacy = matchLegacyRule(rule, source);
  if (!legacy.matched) return legacy;
  const exclusionReason = sourceExclusionReason(rule.metadata, source);
  if (exclusionReason) return { matched: false, reason: exclusionReason };
  if (!rule.selector) return legacy;

  try {
    const selector = compileObserverSelector(rule.selector);
    if (selector.roots.some((root) => root !== "source")) {
      return { ...legacy, reason: `${legacy.reason}+selector_deferred` };
    }
    return selector.evaluate({ source })
      ? { ...legacy, reason: `${legacy.reason}+selector` }
      : { matched: false, reason: "selector_mismatch" };
  } catch {
    return { matched: false, reason: "invalid_selector" };
  }
}

export function explainObserverRulesForSession(nameOrKey: string): {
  source: ObservationSourceDescriptor | null;
  rules: Array<{ rule: ObserverRule; matched: boolean; reason: string; policyMatch?: ObservationTagPolicyMatch }>;
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
    const result = upsertObserverBinding({ source, rule, match });
    bindings.push(result.binding);
    if (result.created) created.push(result.binding);
  }

  return { source, bindings, created, skipped };
}

/** Disable every binding a rule created, e.g. when an observed task reaches a terminal state. */
export function dbDisableObserverBindingsForRule(ruleId: string): number {
  ensureObservationSchema();
  return disableBindingsForRule(ruleId.trim());
}

/** Reconcile durable bindings against the current rule/profile desired state. */
export function reconcileObserverBindingsForSession(input: {
  sessionName: string;
  session: SessionEntry;
  agent?: AgentConfig;
  prompt?: RuntimeLaunchPrompt;
  mode?: ObserverReconcileMode;
}): ReturnType<typeof ensureObserverBindingsForSession> & {
  mode: ObserverReconcileMode;
  disabled: ObserverBinding[];
  refreshedProfiles: ObserverBinding[];
} {
  const mode = input.mode ?? "attach-missing";
  const result = ensureObserverBindingsForSession(input);
  if (!result.source || mode === "attach-missing") {
    return { ...result, mode, disabled: [], refreshedProfiles: [] };
  }

  const selectedIds = new Set(result.bindings.map((binding) => binding.id));
  const disabled: ObserverBinding[] = [];
  const refreshedProfiles: ObserverBinding[] = [];
  const shouldDetach = mode === "detach-disabled" || mode === "full-reconcile";
  const shouldRefreshProfiles = mode === "refresh-profile" || mode === "full-reconcile";

  const existingBindings = dbListObserverBindings({ sourceSessionKey: result.source.sessionKey });
  const db = getDb();
  db.transaction(() => {
    for (const binding of existingBindings) {
      const selected = selectedIds.has(binding.id);
      if (shouldDetach && !selected && binding.enabled) {
        db.prepare("UPDATE observer_bindings SET enabled = 0, updated_at = ? WHERE id = ?").run(Date.now(), binding.id);
        const updated = dbGetObserverBinding(binding.id);
        if (updated) disabled.push(updated);
        continue;
      }
      if (!shouldRefreshProfiles || !selected) continue;

      const rule = dbGetObserverRule(binding.ruleId);
      // A present rule is authoritative even when its explicit profile was cleared.
      // Only an orphaned binding falls back to its previously persisted profile id.
      const profile = resolveObserverProfile(rule ? rule.observerProfileId : binding.observerProfileId);
      db.prepare(
        `UPDATE observer_bindings
         SET observer_profile_id = ?, observer_profile_version = ?, observer_profile_source = ?,
             observer_profile_snapshot_markdown = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        profile.id,
        profile.version,
        profile.source,
        buildObserverProfileSnapshotMarkdown(profile),
        Date.now(),
        binding.id,
      );
      const updated = dbGetObserverBinding(binding.id);
      if (updated) refreshedProfiles.push(updated);
    }
  })();

  const reload = (binding: ObserverBinding): ObserverBinding => dbGetObserverBinding(binding.id) ?? binding;
  return {
    ...result,
    bindings: result.bindings.map(reload),
    created: result.created.map(reload),
    mode,
    disabled,
    refreshedProfiles,
  };
}

function bindingAllowsEvent(
  binding: ObserverBinding,
  source: ObservationSourceDescriptor,
  event: ObservationEvent,
  deliveryPolicies?: Set<ObservationDeliveryPolicy>,
): boolean {
  const basicMatch =
    binding.enabled &&
    binding.deliveryPolicy !== "manual" &&
    (!deliveryPolicies || deliveryPolicies.has(binding.deliveryPolicy)) &&
    binding.eventTypes.includes(event.type);
  if (!basicMatch) return false;
  if (sourceExclusionReason(binding.metadata, source)) return false;
  if (!binding.selector) return true;
  try {
    return compileObserverSelector(binding.selector).evaluate({
      source,
      turn: event.turn,
      event: {
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        turnId: event.turnId,
        preview: event.preview,
        payload: event.payload,
      },
    });
  } catch {
    // Persisted invalid selectors fail closed even if the database was edited manually.
    return false;
  }
}

function composeObservationPrompt(input: {
  binding: ObserverBinding;
  source: ObservationSourceDescriptor;
  events: ObservationEvent[];
  runId?: string;
  deliveryId?: string;
  input?: Record<string, unknown>;
  conditions?: readonly ObservationConditionHit[];
}): string {
  const profile = input.binding.observerProfileSnapshotMarkdown
    ? resolveObserverProfileFromSnapshotMarkdown(input.binding.observerProfileSnapshotMarkdown)
    : resolveObserverProfile(input.binding.observerProfileId);
  const conditionsText = input.conditions ? renderObservationConditions(input.conditions) : "";
  const rendered = renderObservationPromptForProfile({
    profile,
    source: input.source,
    binding: input.binding,
    events: input.events,
    deliveryPolicy: input.binding.deliveryPolicy,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    ...(input.input ? { input: input.input } : {}),
    conditionsText,
  });
  // A profile (or an older snapshot) that does not place the condition lines still gets them first:
  // the reason the observer was woken must never be lost.
  const template = profile.templates.delivery[input.binding.deliveryPolicy] ?? "";
  return conditionsText && !template.includes("delivery.conditions") ? `${conditionsText}\n\n${rendered}` : rendered;
}

/** Full text and tool input ride on events as `payload.detail`; only bindings that ask for them read them. */
function bindingReadsDetail(binding: ObserverBinding): boolean {
  return binding.metadata?.observationDetail === true;
}

function stripObservationDetail(events: ObservationEvent[]): ObservationEvent[] {
  return events.map((event) => {
    if (!event.payload || !("detail" in event.payload)) return event;
    const { detail: _detail, ...payload } = event.payload;
    return { ...event, payload };
  });
}

function bindingPulseMs(binding: ObserverBinding): number | null {
  const value = binding.metadata?.pulseMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export type ObservationDeliveryTrigger = "end_of_turn" | "pulse" | "realtime" | "debounce";

function resolveDeliveryTrigger(
  binding: ObserverBinding,
  deliveryPolicies: Set<ObservationDeliveryPolicy> | undefined,
  pulse: boolean,
): ObservationDeliveryTrigger {
  if (pulse) return "pulse";
  if (deliveryPolicies?.size === 1) {
    const [policy] = [...deliveryPolicies];
    if (policy && policy !== "manual") return policy;
  }
  return binding.deliveryPolicy === "manual" ? "end_of_turn" : binding.deliveryPolicy;
}

function claimObservationEvents(bindingId: string, events: ObservationEvent[]): ObservationEvent[] {
  const statement = getDb().prepare(
    "INSERT OR IGNORE INTO observer_delivery_events (binding_id, event_id, delivered_at) VALUES (?, ?, ?)",
  );
  const now = Date.now();
  return events.filter((event) => statement.run(bindingId, event.id, now).changes > 0);
}

function releaseObservationEventClaims(bindingId: string, events: ObservationEvent[]): void {
  const statement = getDb().prepare("DELETE FROM observer_delivery_events WHERE binding_id = ? AND event_id = ?");
  for (const event of events) statement.run(bindingId, event.id);
}

export async function deliverObservationEvents(input: {
  sourceSessionName: string;
  sourceSession: SessionEntry;
  agentId: string;
  events: ObservationEvent[];
  deliveryPolicies?: ObservationDeliveryPolicy[];
  runId?: string;
  /** Mid-turn read: only bindings with `metadata.pulseMs` receive the events gathered so far. */
  pulse?: boolean;
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
  const pulse = input.pulse === true;

  // Conditions are facts about a finished turn: computed once, over every event of the batch (an
  // end-of-turn batch holds the whole turn, pulses included), never from a partial view.
  let turnConditions: ObservationConditionHit[] | undefined;
  const endOfTurnBatch = !pulse && (!deliveryPolicies || deliveryPolicies.has("end_of_turn"));

  for (const binding of bindings) {
    if (pulse && bindingPulseMs(binding) === null) {
      skipped.push({ bindingId: binding.id, reason: "no_pulse" });
      continue;
    }
    let conditionHits: ObservationConditionHit[] | undefined;
    let wanted: string[] | null;
    try {
      wanted = observerConditions(binding.metadata);
    } catch (error) {
      // A persisted invalid condition list fails closed, like an invalid selector, and says why.
      log.warn("Skipping observer binding with invalid conditions", {
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
      });
      skipped.push({ bindingId: binding.id, reason: "invalid_conditions" });
      continue;
    }
    if (wanted) {
      if (!endOfTurnBatch) {
        skipped.push({ bindingId: binding.id, reason: "conditions_wait_end_of_turn" });
        continue;
      }
      turnConditions ??= evaluateObservationConditions(input.events);
      conditionHits = turnConditions.filter((hit) => wanted!.includes(hit.condition));
      if (conditionHits.length === 0) {
        skipped.push({ bindingId: binding.id, reason: "no_condition" });
        continue;
      }
    }
    const exclusionReason = sourceExclusionReason(binding.metadata, source);
    if (exclusionReason) {
      skipped.push({ bindingId: binding.id, reason: exclusionReason });
      continue;
    }
    // A live receiver is stored by session key and published to under its current name: a rename
    // keeps the observation, and a name reused by another session never receives it.
    let informTarget: string | null = null;
    const informKey = bindingInformTarget(binding);
    if (informKey) {
      const receiver = getSession(informKey);
      if (!receiver || receiver.sessionKey !== informKey) {
        skipped.push({ bindingId: binding.id, reason: "receiver_missing" });
        continue;
      }
      informTarget = receiver.name ?? receiver.sessionKey;
      // Checked at every delivery: the owner-read mark is written on a trigger's first fire, which
      // can come after the rule was created.
      const refusal = liveReceiverSourceRefusal(source.sessionKey);
      if (refusal) {
        log.warn("Refusing to forward a session that holds owner reads to a live receiver", {
          bindingId: binding.id,
          sourceSessionKey: source.sessionKey,
          reason: refusal,
        });
        skipped.push({ bindingId: binding.id, reason: "source_holds_owner_reads" });
        continue;
      }
    }
    const selected = input.events.filter((event) => bindingAllowsEvent(binding, source, event, deliveryPolicies));
    if (selected.length === 0) {
      skipped.push({
        bindingId: binding.id,
        reason: binding.selector ? "selector_or_event_mismatch" : "no_matching_events",
      });
      continue;
    }

    const claimed = claimObservationEvents(binding.id, selected);
    if (claimed.length === 0) {
      skipped.push({ bindingId: binding.id, reason: "events_already_delivered" });
      continue;
    }

    const trigger = resolveDeliveryTrigger(binding, deliveryPolicies, pulse);
    const deliveryId = `od_${hashParts([binding.id, trigger, input.runId, ...claimed.map((event) => event.id)], 24)}`;
    const prompt = composeObservationPrompt({
      binding,
      source,
      events: bindingReadsDetail(binding) ? claimed : stripObservationDetail(claimed),
      ...(input.runId ? { runId: input.runId } : {}),
      deliveryId,
      ...(conditionHits ? { conditions: conditionHits } : {}),
    });
    const sourceTurnIds = [
      ...new Set(claimed.map((event) => event.turnId).filter((id): id is string => Boolean(id))),
    ].sort();
    try {
      if (informTarget) {
        // A live session (often a conversation) is not an observer session: it gets a normal
        // `[System] Inform` it can act on, not an `_observation` prompt with observer isolation.
        // The notice is observer-originated, so the receiving turn emits no observation events.
        await observationPromptPublisher(informTarget, {
          prompt: `[System] Inform: [from: ravi observer] ${prompt}`,
          deliveryBarrier: "after_response",
          _observationNotice: { bindingId: binding.id, sourceSessionKey: source.sessionKey },
        });
      } else {
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
            ...(binding.observerProfileId ? { profileId: binding.observerProfileId } : {}),
            ...(binding.observerProfileVersion ? { profileVersion: binding.observerProfileVersion } : {}),
            ...(binding.permissionGrants.length > 0 ? { permissionGrants: binding.permissionGrants } : {}),
            eventIds: claimed.map((event) => event.id),
            ...(sourceTurnIds.length > 0 ? { sourceTurnIds } : {}),
            ...(source.taskId ? { taskId: source.taskId } : {}),
            deliveryId,
            trigger,
            ...(conditionHits ? { conditions: conditionHits.map((hit) => hit.condition) } : {}),
          },
          deliveryBarrier: "after_response",
        });
      }
    } catch (error) {
      releaseObservationEventClaims(binding.id, claimed);
      throw error;
    }
    getDb()
      .prepare("UPDATE observer_bindings SET last_delivered_at = ?, updated_at = ? WHERE id = ?")
      .run(Date.now(), Date.now(), binding.id);
    delivered.push({
      bindingId: binding.id,
      observerSessionName: informTarget ?? binding.observerSessionName,
      eventCount: claimed.length,
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
        !sourceExclusionReason(binding.metadata, source) &&
        (!binding.selector ||
          (() => {
            try {
              const selector = compileObserverSelector(binding.selector);
              return selector.roots.some((root) => root !== "source") || selector.evaluate({ source });
            } catch {
              return false;
            }
          })()) &&
        binding.deliveryPolicy === "debounce" &&
        input.eventTypes.some((eventType) => binding.eventTypes.includes(eventType)),
    )
    .map((binding) => binding.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  return delays.length > 0 ? Math.min(...delays) : null;
}

/** Shortest pulse among the session's bindings, or null when none reads mid-turn. */
export function getObservationPulseMs(input: {
  sourceSessionName: string;
  sourceSession: SessionEntry;
  agentId: string;
}): number | null {
  if (isObserverSessionName(input.sourceSessionName)) return null;
  const bindings = dbListObserverBindings({ sourceSessionKey: input.sourceSession.sessionKey, enabled: true });
  // A condition-gated binding is only read at end of turn: it must not arm a pulse it would refuse.
  const pulses = bindings
    .filter((binding) => binding.metadata?.when === undefined || binding.metadata?.when === null)
    .map(bindingPulseMs)
    .filter((value): value is number => value !== null);
  return pulses.length > 0 ? Math.min(...pulses) : null;
}

export function validateObserverRules(): {
  ok: boolean;
  errors: Array<{ ruleId: string; message: string }>;
} {
  const errors: Array<{ ruleId: string; message: string }> = [];
  for (const rule of dbListObserverRules()) {
    try {
      if (rule.selector) compileObserverSelector(rule.selector);
      validateObserverSourceExclusions(rule.metadata);
      validateObserverConditions(rule.metadata, rule.deliveryPolicy);
      validateRuleSafety({
        scope: rule.scope,
        mode: rule.observerMode,
        observerAgentId: rule.observerAgentId,
        observerRuntimeProviderId: rule.observerRuntimeProviderId,
        observerModel: rule.observerModel,
        observerProfileId: rule.observerProfileId,
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
  input: Omit<ObservationEvent, "id" | "timestamp" | "turn"> & {
    runId: string;
    sequence: number;
    timestamp?: number;
    turn?: TurnProvenance;
  },
): ObservationEvent {
  return {
    id: `obs_evt_${input.runId}_${input.sequence}`,
    type: input.type,
    timestamp: input.timestamp ?? Date.now(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.preview ? { preview: input.preview } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
    turn: input.turn ?? classifyTurnProvenance(),
  };
}

export function logObservationDeliveryFailure(error: unknown, context: Record<string, unknown>): void {
  log.warn("Observation delivery failed", { ...context, error });
}

function isObserverRuleDisableOnly(input: ObserverRuleInput): boolean {
  if (input.enabled !== false) return false;
  const existing = dbGetObserverRule(input.id);
  if (!existing) return false;
  const current = existing as unknown as Record<string, unknown>;
  return Object.entries(input as unknown as Record<string, unknown>).every(([key, value]) => {
    if (key === "id" || key === "enabled" || value === undefined) return true;
    return JSON.stringify(value) === JSON.stringify(current[key]);
  });
}
