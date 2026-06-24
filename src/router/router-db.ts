/**
 * Router Database - SQLite-backed configuration storage
 *
 * Stores agents, routes, and settings in SQLite to prevent
 * direct file editing by bots (which could bypass validation).
 *
 * Uses lazy initialization - database is only created when first accessed.
 */

import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { z } from "zod";
import { join } from "node:path";
import { mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { getRaviStateDir } from "../utils/paths.js";
import { normalizePhone } from "../utils/phone.js";
import { normalizeLimitOffsetPage, type ListPage } from "../utils/pagination.js";
import { timestampLikeToMs } from "../utils/provider-timestamp.js";
import { executeWrite } from "../db/write-retry.js";
import type { AgentConfig, RouteConfig, DmScope } from "./types.js";

const log = logger.child("router:db");

// ============================================================================
// Constants
// ============================================================================

const RAVI_DIR = join(homedir(), "ravi");
const DEFAULT_RAVI_STATE_DIR = getRaviStateDir({});
const DEFAULT_DB_PATH = join(DEFAULT_RAVI_STATE_DIR, "ravi.db");
const LEGACY_DB_PATH = join(RAVI_DIR, "ravi.db");
const IDENTITY_CHAT_BACKFILL_KEY = "identity_chat_backfill_v1";

// ============================================================================
// Schemas (safe to access at import time - no I/O)
// ============================================================================

export const DmScopeSchema = z.enum(["main", "per-peer", "per-channel-peer", "per-account-channel-peer"]);

export const AgentModeSchema = z.enum(["active", "sentinel"]);
export const RuntimeProviderSchema = z.string().min(1);

export const AgentInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  cwd: z.string().min(1),
  model: z.string().optional(),
  provider: RuntimeProviderSchema.optional(),
  remote: z.string().optional(),
  remoteUser: z.string().optional(),
  dmScope: DmScopeSchema.optional(),
  systemPromptAppend: z.string().optional(),
  debounceMs: z.number().int().min(0).optional(),
  groupDebounceMs: z.number().int().min(0).optional(),
  matrixAccount: z.string().optional(),
  settingSources: z.array(z.enum(["user", "project"])).optional(),
  mode: AgentModeSchema.optional(),
});

export const RouteInputSchema = z.object({
  pattern: z.string().min(1),
  accountId: z.string().min(1),
  agent: z.string().min(1),
  dmScope: DmScopeSchema.optional(),
  session: z.string().optional(),
  priority: z.number().int().default(0),
  policy: z.string().optional(),
  channel: z.string().optional(),
});

export const GroupPolicySchema = z.enum(["open", "allowlist", "closed"]);
export const DmPolicySchema = z.enum(["open", "pairing", "closed"]);
export const ContactIntakeModeSchema = z.enum(["off", "discovered", "pending"]);
export const ContextSourceSchema = z.object({
  channel: z.string().min(1),
  accountId: z.string().min(1),
  chatId: z.string().min(1),
  threadId: z.string().min(1).optional(),
});
export const ContextCapabilitySchema = z.object({
  permission: z.string().min(1),
  objectType: z.string().min(1),
  objectId: z.string().min(1),
  source: z.string().optional(),
});
export const ContextInputSchema = z.object({
  contextId: z.string().min(1),
  contextKey: z.string().min(1),
  kind: z.string().min(1).default("runtime"),
  agentId: z.string().min(1).optional(),
  sessionKey: z.string().min(1).optional(),
  sessionName: z.string().min(1).optional(),
  source: ContextSourceSchema.optional(),
  capabilities: z.array(ContextCapabilitySchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int().optional(),
  expiresAt: z.number().int().optional(),
  lastUsedAt: z.number().int().optional(),
  revokedAt: z.number().int().optional(),
});

export const InstanceInputSchema = z.object({
  name: z.string().min(1),
  instanceId: z.string().optional(),
  channel: z.string().default("whatsapp"),
  agent: z.string().optional(),
  dmPolicy: DmPolicySchema.default("open"),
  groupPolicy: GroupPolicySchema.default("open"),
  contactIntakeMode: ContactIntakeModeSchema.default("off"),
  dmScope: DmScopeSchema.optional(),
  enabled: z.boolean().default(true),
  defaults: z.record(z.string(), z.unknown()).optional(),
  defaultContactTags: z.array(z.string()).optional(),
});

// ============================================================================
// Row Types
// ============================================================================

interface AgentRow {
  id: string;
  name: string | null;
  cwd: string;
  model: string | null;
  provider: string | null;
  remote: string | null;
  remote_user: string | null;
  dm_scope: string | null;
  system_prompt_append: string | null;
  debounce_ms: number | null;
  group_debounce_ms: number | null;
  matrix_account: string | null;
  setting_sources: string | null;
  // Heartbeat columns
  heartbeat_enabled: number;
  heartbeat_interval_ms: number;
  heartbeat_model: string | null;
  heartbeat_active_start: string | null;
  heartbeat_active_end: string | null;
  heartbeat_last_run_at: number | null;
  heartbeat_account_id: string | null;
  // Scope isolation columns
  spec_mode: number;
  contact_scope: string | null;
  allowed_sessions: string | null;
  // Agent mode
  agent_mode: string | null;
  // Generic defaults
  defaults: string | null;
  created_at: number;
  updated_at: number;
}

interface RouteRow {
  id: number;
  pattern: string;
  account_id: string;
  agent_id: string;
  dm_scope: string | null;
  session_name: string | null;
  policy: string | null;
  priority: number;
  channel: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface InstanceRow {
  name: string;
  instance_id: string | null;
  channel: string;
  agent: string | null;
  dm_policy: string;
  group_policy: string;
  contact_intake_mode: string | null;
  dm_scope: string | null;
  enabled: number | null;
  defaults: string | null;
  default_contact_tags: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface ContextRow {
  context_id: string;
  context_key: string;
  kind: string;
  agent_id: string | null;
  session_key: string | null;
  session_name: string | null;
  source_json: string | null;
  capabilities_json: string;
  metadata_json: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface DaemonRestartEpochRow {
  restart_epoch: string;
  reason: string;
  caller_session_name: string | null;
  created_at: number;
  updated_at: number;
}

interface DaemonRestartSessionSnapshotRow {
  restart_epoch: string;
  session_key: string;
  session_name: string;
  agent_id: string | null;
  runtime_provider: string | null;
  activity: string;
  non_idle: number;
  last_activity_at: number;
  stopped_at: number;
  pending_message_count: number;
  pending_messages_json: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface ChatRow {
  id: string;
  channel: string;
  instance_id: string;
  platform_chat_id: string;
  normalized_chat_id: string;
  chat_type: string;
  title: string | null;
  avatar_url: string | null;
  metadata_json: string | null;
  raw_provenance_json: string | null;
  first_seen_at: number;
  last_seen_at: number;
  created_at: number;
  updated_at: number;
}

interface ChatParticipantRow {
  id: string;
  chat_id: string;
  platform_identity_id: string | null;
  contact_id: string | null;
  agent_id: string | null;
  raw_platform_user_id: string | null;
  normalized_platform_user_id: string | null;
  role: string;
  status: string;
  source: string;
  first_seen_at: number;
  last_seen_at: number;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface ChatMessageRow {
  id: string;
  chat_id: string;
  channel: string;
  instance_id: string;
  provider_message_id: string;
  raw_chat_id: string;
  raw_sender_id: string | null;
  normalized_sender_id: string | null;
  actor_type: string;
  contact_id: string | null;
  agent_id: string | null;
  platform_identity_id: string | null;
  message_type: string | null;
  content_json: string | null;
  raw_provenance_json: string | null;
  provider_timestamp: number | null;
  edited_at: number | null;
  deleted_at: number | null;
  ingested_at: number;
  created_at: number;
  updated_at: number;
}

interface ChatMessageWithSortKeyRow extends ChatMessageRow {
  message_sort_key: string;
}

interface ChatReadingListRow {
  id: string;
  name: string;
  description: string | null;
  owner_type: string;
  owner_id: string;
  visibility: string;
  mode: string;
  selector_json: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface ChatReadingListMemberRow {
  id: string;
  list_id: string;
  chat_id: string;
  source: string;
  reason: string | null;
  priority: number;
  metadata_json: string | null;
  added_at: number;
  removed_at: number | null;
}

interface ChatReadingCursorRow {
  id: string;
  list_id: string;
  chat_id: string;
  reader_type: string;
  reader_id: string;
  last_read_message_id: string | null;
  last_read_message_sort_key: string | null;
  last_read_event_id: string | null;
  last_read_event_sort_key: string | null;
  last_read_at: number | null;
  read_reason: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface SessionChatBindingRow {
  session_key: string;
  chat_id: string;
  agent_id: string | null;
  route_id: number | null;
  binding_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface SessionParticipantRow {
  id: string;
  session_key: string;
  owner_type: string;
  owner_id: string | null;
  platform_identity_id: string | null;
  role: string;
  first_seen_at: number;
  last_seen_at: number;
  message_count: number;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface InstanceConfig {
  name: string;
  instanceId?: string;
  channel: string;
  agent?: string;
  dmPolicy: "open" | "pairing" | "closed";
  groupPolicy: "open" | "allowlist" | "closed";
  contactIntakeMode: z.infer<typeof ContactIntakeModeSchema>;
  dmScope?: DmScope;
  enabled?: boolean;
  defaults?: Record<string, unknown>;
  defaultContactTags?: string[];
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

interface SkillGateRuleRow {
  id: string;
  skill: string | null;
  disabled: number;
  pattern: string | null;
  group_regex: string | null;
  tool: string | null;
  tool_prefix: string | null;
  tool_regex: string | null;
  command: string | null;
  command_prefix: string | null;
  command_regex: string | null;
  created_at: number;
  updated_at: number;
}

export interface DbSkillGateRule {
  id: string;
  skill?: string;
  disabled: boolean;
  pattern?: string;
  groupRegex?: string;
  tool?: string;
  toolPrefix?: string;
  toolRegex?: string;
  command?: string;
  commandPrefix?: string;
  commandRegex?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DbSkillGateRuleInput {
  id: string;
  skill?: string | null;
  disabled?: boolean;
  pattern?: string | null;
  groupRegex?: string | null;
  tool?: string | null;
  toolPrefix?: string | null;
  toolRegex?: string | null;
  command?: string | null;
  commandPrefix?: string | null;
  commandRegex?: string | null;
}

interface MatrixAccountRow {
  username: string;
  user_id: string;
  homeserver: string;
  access_token: string;
  device_id: string | null;
  created_at: number;
  last_used_at: number | null;
}

export interface MatrixAccount {
  username: string;
  userId: string;
  homeserver: string;
  accessToken: string;
  deviceId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface ContextSource {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string;
}

export interface ContextCapability {
  permission: string;
  objectType: string;
  objectId: string;
  source?: string;
}

export interface ContextRecord {
  contextId: string;
  contextKey: string;
  kind: string;
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
  source?: ContextSource;
  capabilities: ContextCapability[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export type ChatType = "dm" | "group" | "room" | "thread" | "channel" | "unknown";
export type ChatParticipantType = "contact" | "agent" | "raw";
export type ChatParticipantRole = "member" | "admin" | "owner" | "agent" | "unknown" | (string & {});
export type ChatParticipantStatus = "active" | "left" | "removed" | "unknown" | (string & {});
export type ChatParticipantSource = "omni" | "inbound_message" | "manual" | "import" | "backfill" | (string & {});
export type SessionParticipantOwnerType = "contact" | "agent" | "unknown";
export type SessionParticipantRole = "human" | "agent" | "system" | "observer" | "unknown" | (string & {});

export interface ChatRecord {
  id: string;
  channel: string;
  instanceId: string;
  platformChatId: string;
  normalizedChatId: string;
  chatType: ChatType;
  title?: string;
  avatarUrl?: string;
  metadata?: Record<string, unknown>;
  rawProvenance?: Record<string, unknown>;
  firstSeenAt: number;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertChatInput {
  channel: string;
  instanceId?: string | null;
  platformChatId: string;
  normalizedChatId?: string | null;
  chatType?: ChatType;
  title?: string | null;
  avatarUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  rawProvenance?: Record<string, unknown> | null;
  seenAt?: number;
}

export interface CanonicalizeDmChatForContactInput {
  chatId: string;
  contactId: string;
  platformChatId?: string | null;
  title?: string | null;
  avatarUrl?: string | null;
  rawProvenance?: Record<string, unknown> | null;
  seenAt?: number;
}

export interface ChatParticipantRecord {
  id: string;
  chatId: string;
  participantType: ChatParticipantType;
  platformIdentityId?: string;
  contactId?: string;
  agentId?: string;
  rawPlatformUserId?: string;
  normalizedPlatformUserId?: string;
  role: ChatParticipantRole;
  status: ChatParticipantStatus;
  source: ChatParticipantSource;
  firstSeenAt: number;
  lastSeenAt: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessageRecord {
  id: string;
  chatId: string;
  channel: string;
  instanceId: string;
  providerMessageId: string;
  rawChatId: string;
  rawSenderId?: string;
  normalizedSenderId?: string;
  actorType: "contact" | "agent" | "system" | "unknown" | string;
  contactId?: string;
  agentId?: string;
  platformIdentityId?: string;
  messageType?: string;
  content?: Record<string, unknown>;
  rawProvenance?: Record<string, unknown>;
  providerTimestamp?: number;
  editedAt?: number;
  deletedAt?: number;
  ingestedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessageProviderTimestampBackfillItem {
  id: string;
  chatId: string;
  providerMessageId: string;
  previousProviderTimestamp?: number;
  providerTimestamp: number;
}

export interface ChatMessageProviderTimestampBackfillResult {
  dryRun: boolean;
  scanned: number;
  candidates: number;
  skipped: number;
  unchanged: number;
  wouldUpdate: number;
  updated: number;
  items: ChatMessageProviderTimestampBackfillItem[];
}

export interface ChatMessageWithSortKey extends ChatMessageRecord {
  sortKey: string;
}

export interface ChatMessageContactIdentityRef {
  id?: string | null;
  channel?: string | null;
  instanceId?: string | null;
  normalizedPlatformUserId?: string | null;
}

export interface ChatListItem {
  chat: ChatRecord;
  messageCount: number;
  participantCount: number;
  lastMessage: ChatMessageWithSortKey | null;
}

export interface UpsertChatMessageInput {
  chatId: string;
  channel: string;
  instanceId?: string | null;
  providerMessageId?: string | null;
  rawChatId: string;
  rawSenderId?: string | null;
  normalizedSenderId?: string | null;
  actorType?: "contact" | "agent" | "system" | "unknown" | string | null;
  contactId?: string | null;
  agentId?: string | null;
  platformIdentityId?: string | null;
  messageType?: string | null;
  content?: Record<string, unknown> | null;
  rawProvenance?: Record<string, unknown> | null;
  providerTimestamp?: number | null;
  editedAt?: number | null;
  deletedAt?: number | null;
  ingestedAt?: number;
}

export interface UpsertChatMessageResult {
  message: ChatMessageRecord;
  created: boolean;
}

export type ChatReadingListOwnerType = "user" | "agent" | "team" | "system" | "workflow" | string;
export type ChatReadingListVisibility = "private" | "team" | "system" | string;
export type ChatReadingListMode = "static" | "dynamic" | "hybrid" | string;
export type ChatReadingListMemberSource = "manual" | "selector" | "observer" | "crm" | "migration" | string;
export type ChatReadingCursorReaderType = "user" | "agent" | "team" | "system" | "workflow" | string;

export interface ChatReadingListRecord {
  id: string;
  name: string;
  description?: string;
  ownerType: ChatReadingListOwnerType;
  ownerId: string;
  visibility: ChatReadingListVisibility;
  mode: ChatReadingListMode;
  selector?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface ChatReadingListMemberRecord {
  id: string;
  listId: string;
  chatId: string;
  source: ChatReadingListMemberSource;
  reason?: string;
  priority: number;
  metadata?: Record<string, unknown>;
  addedAt: number;
  removedAt?: number;
}

export interface ChatReadingCursorRecord {
  id: string;
  listId: string;
  chatId: string;
  readerType: ChatReadingCursorReaderType;
  readerId: string;
  lastReadMessageId?: string;
  lastReadMessageSortKey?: string;
  lastReadEventId?: string;
  lastReadEventSortKey?: string;
  lastReadAt?: number;
  readReason?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ChatReadingListMemberItem {
  member: ChatReadingListMemberRecord;
  chat: ChatRecord;
  messageCount: number;
  unreadMessageCount: number;
  lastMessage: ChatMessageWithSortKey | null;
  cursor: ChatReadingCursorRecord | null;
}

export interface ChatReadingDelta {
  list: ChatReadingListRecord;
  chat: ChatRecord;
  reader: { type: ChatReadingCursorReaderType; id: string };
  previousCursor: ChatReadingCursorRecord | null;
  nextCursor: ChatReadingCursorRecord | null;
  messages: ChatMessageWithSortKey[];
  events: unknown[];
  newMessageCount: number;
  editedMessageCount: number;
  deletedMessageCount: number;
  participantChanges: unknown[];
  firstUnreadMessage: ChatMessageWithSortKey | null;
  lastUnreadMessage: ChatMessageWithSortKey | null;
}

export interface UpsertChatParticipantInput {
  chatId: string;
  platformIdentityId?: string | null;
  contactId?: string | null;
  agentId?: string | null;
  rawPlatformUserId?: string | null;
  normalizedPlatformUserId?: string | null;
  role?: ChatParticipantRole | null;
  status?: ChatParticipantStatus | null;
  source?: ChatParticipantSource | null;
  metadata?: Record<string, unknown> | null;
  seenAt?: number;
}

export interface SessionChatBindingRecord {
  sessionKey: string;
  chatId: string;
  agentId?: string;
  routeId?: number;
  bindingReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionParticipantRecord {
  id: string;
  sessionKey: string;
  ownerType: SessionParticipantOwnerType;
  ownerId?: string;
  platformIdentityId?: string;
  role: SessionParticipantRole;
  firstSeenAt: number;
  lastSeenAt: number;
  messageCount: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertSessionParticipantInput {
  sessionKey: string;
  ownerType?: SessionParticipantOwnerType | null;
  ownerId?: string | null;
  platformIdentityId?: string | null;
  role?: SessionParticipantRole | null;
  metadata?: Record<string, unknown> | null;
  incrementMessageCount?: boolean;
  seenAt?: number;
}

// ----- sessions/attach -----
// see .ravi/specs/sessions/attach/SPEC.md
export type SubscriptionRole = "primary" | "input" | "mirror";
export type AttachedByType = "user" | "agent" | "system";
export type SubscriptionSpeechMode = "muted" | "speak";

export interface SessionChatSubscriptionRecord {
  id: number;
  sessionKey: string;
  chatId: string;
  role: SubscriptionRole;
  attachedByType: AttachedByType;
  attachedById?: string;
  attachedReason?: string;
  contextSnapshotAtAttach?: Record<string, unknown>;
  speechMode: SubscriptionSpeechMode;
  speechUpdatedAt?: number;
  speechReason?: string;
  outputAttachedAt?: number;
  createdAt: number;
  updatedAt: number;
  detachedAt?: number;
}

export interface CreateSessionChatSubscriptionInput {
  sessionKey: string;
  chatId: string;
  role?: SubscriptionRole;
  attachedByType?: AttachedByType;
  attachedById?: string | null;
  attachedReason?: string | null;
  contextSnapshotAtAttach?: Record<string, unknown> | null;
  speechMode?: SubscriptionSpeechMode | null;
  speechUpdatedAt?: number | null;
  speechReason?: string | null;
  outputAttachedAt?: number | null;
}

export interface DaemonRestartEpochRecord {
  restartEpoch: string;
  reason: string;
  callerSessionName?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DaemonRestartEpochInput {
  restartEpoch: string;
  reason: string;
  callerSessionName?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface DaemonRestartSessionSnapshotRecord {
  restartEpoch: string;
  sessionKey: string;
  sessionName: string;
  agentId?: string;
  runtimeProvider?: string;
  activity: string;
  nonIdle: boolean;
  lastActivityAt: number;
  stoppedAt: number;
  pendingMessageCount: number;
  pendingMessagesJson?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface DaemonRestartSessionSnapshotInput {
  restartEpoch: string;
  sessionKey: string;
  sessionName: string;
  agentId?: string | null;
  runtimeProvider?: string | null;
  activity: string;
  nonIdle: boolean;
  lastActivityAt: number;
  stoppedAt: number;
  pendingMessages?: unknown[];
  metadata?: Record<string, unknown> | null;
  recordedAt?: number;
}

export interface ListContextsOptions {
  agentId?: string;
  sessionKey?: string;
  kind?: string;
  includeInactive?: boolean;
}

// ============================================================================
// Slow Query Instrumentation
// ============================================================================

const SLOW_QUERY_WARN_MS = Number(process.env.RAVI_DB_SLOW_QUERY_WARN_MS ?? 250);
const SLOW_QUERY_ERROR_MS = Number(process.env.RAVI_DB_SLOW_QUERY_ERROR_MS ?? 5000);
const SLOW_QUERY_DISABLED = process.env.RAVI_DB_SLOW_QUERY_DISABLE === "1";

function shortSql(sql: string): string {
  const collapsed = sql.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

function reportSlowQuery(elapsed: number, method: string, sql: string): void {
  if (elapsed >= SLOW_QUERY_ERROR_MS) {
    log.error("very slow db query (possible lock contention)", {
      ms: elapsed,
      method,
      sql: shortSql(sql),
    });
  } else if (elapsed >= SLOW_QUERY_WARN_MS) {
    log.warn("slow db query", { ms: elapsed, method, sql: shortSql(sql) });
  }
}

function instrumentSlowQueries(db: Database): void {
  if (SLOW_QUERY_DISABLED) return;

  const originalPrepare = db.prepare.bind(db);
  // @ts-expect-error: replacing method with a wrapper of identical signature
  db.prepare = (sql: string) => {
    const stmt = originalPrepare(sql);
    const proxy = new Proxy(stmt, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (
          typeof value === "function" &&
          (prop === "run" || prop === "get" || prop === "all" || prop === "iterate" || prop === "values")
        ) {
          return (...args: unknown[]) => {
            const start = Date.now();
            try {
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            } finally {
              reportSlowQuery(Date.now() - start, String(prop), sql);
            }
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return proxy;
  };

  const originalExec = db.exec.bind(db);
  db.exec = (sql: string, ...rest: unknown[]) => {
    const start = Date.now();
    try {
      return originalExec(sql, ...(rest as []));
    } finally {
      reportSlowQuery(Date.now() - start, "exec", sql);
    }
  };
}

// ============================================================================
// Lazy Database Initialization
// ============================================================================

type RouterDbState = {
  db: Database | null;
  dbPath: string | null;
  stmts: PreparedStatements | null;
};

type RouterDbGlobal = typeof globalThis & {
  __raviRouterDbState?: RouterDbState;
};

const routerDbGlobal = globalThis as RouterDbGlobal;
const routerDbState =
  routerDbGlobal.__raviRouterDbState ??
  (routerDbGlobal.__raviRouterDbState = {
    db: null,
    dbPath: null,
    stmts: null,
  });

function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "ravi.db");
}

/**
 * Get database connection with lazy initialization.
 * Creates database and schema on first access.
 */
function getDb(): Database {
  const nextDbPath = resolveDbPath();
  if (routerDbState.db !== null && routerDbState.dbPath === nextDbPath) {
    return routerDbState.db;
  }
  if (routerDbState.db !== null && routerDbState.dbPath !== nextDbPath) {
    closeRouterDb();
  }

  const stateDir = getRaviStateDir();

  // Create directory on first access
  mkdirSync(stateDir, { recursive: true });

  // Auto-migrate from legacy path (~/ravi/ravi.db → ~/.ravi/ravi.db)
  if (nextDbPath === DEFAULT_DB_PATH && !existsSync(nextDbPath) && existsSync(LEGACY_DB_PATH)) {
    log.info("Migrating database from ~/ravi/ravi.db to ~/.ravi/ravi.db");
    renameSync(LEGACY_DB_PATH, nextDbPath);
    // Also move WAL/SHM files if they exist
    for (const suffix of ["-wal", "-shm"]) {
      const legacy = LEGACY_DB_PATH + suffix;
      if (existsSync(legacy)) renameSync(legacy, nextDbPath + suffix);
    }
  }

  const db = new Database(nextDbPath);
  instrumentSlowQueries(db);
  routerDbState.db = db;
  routerDbState.dbPath = nextDbPath;

  // WAL mode for concurrent read/write access (CLI + daemon).
  db.exec("PRAGMA journal_mode = WAL");
  // Wait up to 5s for locks to clear instead of failing immediately.
  db.exec("PRAGMA busy_timeout = 5000");
  // synchronous=NORMAL halves fsync count vs FULL while remaining crash-safe in
  // WAL mode (only the WAL is fsynced per commit; the DB file is fsynced at
  // checkpoint). This is the single biggest knob to mitigate disk-pressure
  // induced lock spirals.
  db.exec("PRAGMA synchronous = NORMAL");
  // 64MB page cache (default ~2MB). Most reads hit cache; reduces disk pressure.
  db.exec("PRAGMA cache_size = -64000");
  // Temp tables & sort scratch in RAM.
  db.exec("PRAGMA temp_store = MEMORY");
  // 256MB memory-mapped read window. Hot queries become page-cache hits.
  db.exec("PRAGMA mmap_size = 268435456");

  // Enable foreign keys before schema creation
  db.exec("PRAGMA foreign_keys = ON");

  // Initialize schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      cwd TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      remote TEXT,
      remote_user TEXT,
      dm_scope TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
      system_prompt_append TEXT,
      debounce_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      account_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      dm_scope TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
      priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(pattern, account_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_gate_rules (
      id TEXT PRIMARY KEY,
      skill TEXT,
      disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
      pattern TEXT,
      group_regex TEXT,
      tool TEXT,
      tool_prefix TEXT,
      tool_regex TEXT,
      command TEXT,
      command_prefix TEXT,
      command_regex TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_gate_rules_disabled ON skill_gate_rules(disabled);

    CREATE TABLE IF NOT EXISTS sessions (
      session_key TEXT PRIMARY KEY,
      name TEXT,
      sdk_session_id TEXT,
      runtime_provider TEXT,
      runtime_session_json TEXT,
      runtime_session_display_id TEXT,
      agent_id TEXT NOT NULL,
      agent_cwd TEXT NOT NULL,
      chat_type TEXT,
      channel TEXT,
      account_id TEXT,
      group_id TEXT,
      subject TEXT,
      display_name TEXT,
      last_channel TEXT,
      last_to TEXT,
      last_account_id TEXT,
      last_thread_id TEXT,
      model_override TEXT,
      thinking_level TEXT,
      queue_mode TEXT,
      queue_debounce_ms INTEGER,
      queue_cap INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      context_tokens INTEGER DEFAULT 0,
      system_sent INTEGER DEFAULT 0,
      aborted_last_run INTEGER DEFAULT 0,
      compaction_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_goals (
      session_key TEXT PRIMARY KEY REFERENCES sessions(session_key) ON DELETE CASCADE,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','paused','budget_limited','complete')),
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      task_id TEXT,
      project_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_goals_status ON session_goals(status);
    CREATE INDEX IF NOT EXISTS idx_session_goals_task ON session_goals(task_id);
    CREATE INDEX IF NOT EXISTS idx_session_goals_project ON session_goals(project_id);

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      instance_id TEXT NOT NULL DEFAULT '',
      platform_chat_id TEXT NOT NULL,
      normalized_chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL DEFAULT 'unknown',
      title TEXT,
      avatar_url TEXT,
      metadata_json TEXT,
      raw_provenance_json TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(channel, instance_id, normalized_chat_id)
    );

    CREATE TABLE IF NOT EXISTS chat_participants (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      platform_identity_id TEXT,
      contact_id TEXT,
      agent_id TEXT,
      raw_platform_user_id TEXT,
      normalized_platform_user_id TEXT,
      role TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'unknown',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_participants_identity
      ON chat_participants(chat_id, platform_identity_id)
      WHERE platform_identity_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_participants_contact
      ON chat_participants(chat_id, contact_id)
      WHERE contact_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_participants_agent
      ON chat_participants(chat_id, agent_id)
      WHERE agent_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_participants_raw_identity
      ON chat_participants(chat_id, normalized_platform_user_id)
      WHERE platform_identity_id IS NULL AND contact_id IS NULL AND agent_id IS NULL AND normalized_platform_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_participants_contact_lookup
      ON chat_participants(contact_id, chat_id)
      WHERE contact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_participants_agent_lookup
      ON chat_participants(agent_id, chat_id)
      WHERE agent_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      instance_id TEXT NOT NULL DEFAULT '',
      provider_message_id TEXT NOT NULL,
      raw_chat_id TEXT NOT NULL,
      raw_sender_id TEXT,
      normalized_sender_id TEXT,
      actor_type TEXT NOT NULL DEFAULT 'unknown',
      contact_id TEXT,
      agent_id TEXT,
      platform_identity_id TEXT,
      message_type TEXT,
      content_json TEXT,
      raw_provenance_json TEXT,
      provider_timestamp INTEGER,
      edited_at INTEGER,
      deleted_at INTEGER,
      ingested_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(channel, instance_id, chat_id, provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_time
      ON chat_messages(chat_id, provider_timestamp, ingested_at, id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_contact_time
      ON chat_messages(contact_id, provider_timestamp, ingested_at)
      WHERE contact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_messages_contact_chat_time
      ON chat_messages(contact_id, chat_id, provider_timestamp, ingested_at)
      WHERE contact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_chat_time
      ON chat_messages(agent_id, chat_id, provider_timestamp, ingested_at)
      WHERE agent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_messages_platform_identity
      ON chat_messages(platform_identity_id, provider_timestamp)
      WHERE platform_identity_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS chat_reading_lists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      owner_type TEXT NOT NULL DEFAULT 'system',
      owner_id TEXT NOT NULL DEFAULT 'ravi',
      visibility TEXT NOT NULL DEFAULT 'system',
      mode TEXT NOT NULL DEFAULT 'static',
      selector_json TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_reading_lists_owner_name
      ON chat_reading_lists(owner_type, owner_id, name)
      WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_reading_lists_name
      ON chat_reading_lists(name)
      WHERE archived_at IS NULL;

    CREATE TABLE IF NOT EXISTS chat_reading_list_members (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL REFERENCES chat_reading_lists(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'manual',
      reason TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      added_at INTEGER NOT NULL,
      removed_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_reading_list_members_active
      ON chat_reading_list_members(list_id, chat_id)
      WHERE removed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_reading_list_members_chat
      ON chat_reading_list_members(chat_id)
      WHERE removed_at IS NULL;

    CREATE TABLE IF NOT EXISTS chat_reading_cursors (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL REFERENCES chat_reading_lists(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      reader_type TEXT NOT NULL,
      reader_id TEXT NOT NULL,
      last_read_message_id TEXT,
      last_read_message_sort_key TEXT,
      last_read_event_id TEXT,
      last_read_event_sort_key TEXT,
      last_read_at INTEGER,
      read_reason TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(list_id, chat_id, reader_type, reader_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_reading_cursors_reader
      ON chat_reading_cursors(reader_type, reader_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_reading_cursor_events (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL REFERENCES chat_reading_lists(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      reader_type TEXT NOT NULL,
      reader_id TEXT NOT NULL,
      previous_message_id TEXT,
      previous_message_sort_key TEXT,
      next_message_id TEXT,
      next_message_sort_key TEXT,
      reason TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_reading_cursor_events_scope
      ON chat_reading_cursor_events(list_id, chat_id, reader_type, reader_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS session_chat_bindings (
      session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      agent_id TEXT,
      route_id INTEGER,
      binding_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_key, chat_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_chat_bindings_session
      ON session_chat_bindings(session_key);
    CREATE INDEX IF NOT EXISTS idx_session_chat_bindings_chat
      ON session_chat_bindings(chat_id);

    CREATE TABLE IF NOT EXISTS session_chat_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'input' CHECK(role IN ('primary', 'input', 'mirror')),
      attached_by_type TEXT NOT NULL DEFAULT 'system' CHECK(attached_by_type IN ('user', 'agent', 'system')),
      attached_by_id TEXT,
      attached_reason TEXT,
      context_snapshot_at_attach_json TEXT,
      speech_mode TEXT NOT NULL DEFAULT 'speak' CHECK(speech_mode IN ('muted', 'speak')),
      speech_updated_at INTEGER,
      speech_reason TEXT,
      output_attached_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      detached_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_chat_subscriptions_active_pair
      ON session_chat_subscriptions(session_key, chat_id)
      WHERE detached_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_session_chat_subscriptions_session
      ON session_chat_subscriptions(session_key, detached_at);

    CREATE TABLE IF NOT EXISTS session_participants (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
      owner_type TEXT NOT NULL DEFAULT 'unknown' CHECK(owner_type IN ('contact', 'agent', 'unknown')),
      owner_id TEXT,
      platform_identity_id TEXT,
      role TEXT NOT NULL DEFAULT 'unknown',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_participants_owner
      ON session_participants(session_key, owner_type, owner_id)
      WHERE owner_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_participants_identity
      ON session_participants(session_key, platform_identity_id)
      WHERE platform_identity_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_session_participants_session
      ON session_participants(session_key);

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      slug TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      owner_type TEXT NOT NULL DEFAULT 'system',
      owner_id TEXT,
      scope_type TEXT NOT NULL DEFAULT 'global',
      scope_id TEXT,
      default_agent_id TEXT,
      default_chat_id TEXT,
      default_contact_id TEXT,
      current_assignee_type TEXT,
      current_assignee_id TEXT,
      closed_reason TEXT,
      closed_at INTEGER,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_entry_at INTEGER,
      last_handoff_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_scope_slug
      ON threads(scope_type, COALESCE(scope_id, ''), slug)
      WHERE slug IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_threads_status_updated
      ON threads(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_owner
      ON threads(owner_type, owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_scope
      ON threads(scope_type, scope_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS thread_entries (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      summary TEXT,
      actor_type TEXT NOT NULL DEFAULT 'unknown',
      actor_id TEXT,
      actor_name TEXT,
      actor_agent_id TEXT,
      actor_session_key TEXT,
      actor_session_name TEXT,
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT,
      source_message_id TEXT,
      source_session_key TEXT,
      source_chat_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'default',
      importance TEXT,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
      source_policy TEXT,
      resolved_at INTEGER,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_thread_entries_thread_time
      ON thread_entries(thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_thread_entries_kind
      ON thread_entries(thread_id, kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS thread_links (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'context',
      label TEXT,
      visibility TEXT NOT NULL DEFAULT 'default',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(thread_id, target_type, target_id, role)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_links_thread
      ON thread_links(thread_id, role, target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_thread_links_target
      ON thread_links(target_type, target_id, role);

    CREATE TABLE IF NOT EXISTS thread_handoffs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      source_session_key TEXT,
      source_session_name TEXT,
      target_session_key TEXT NOT NULL,
      target_session_name TEXT,
      target_agent_id TEXT,
      handoff_kind TEXT NOT NULL DEFAULT 'session_send',
      source_entry_id TEXT REFERENCES thread_entries(id) ON DELETE SET NULL,
      brief_text TEXT NOT NULL,
      brief_json TEXT,
      included_entry_ids_json TEXT NOT NULL DEFAULT '[]',
      included_link_ids_json TEXT NOT NULL DEFAULT '[]',
      snapshot_hash TEXT,
      snapshot_version TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      created_thread INTEGER NOT NULL DEFAULT 0 CHECK(created_thread IN (0,1)),
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      delivered_at INTEGER,
      failed_at INTEGER,
      failure_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_thread_handoffs_thread_time
      ON thread_handoffs(thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_thread_handoffs_target
      ON thread_handoffs(target_session_key, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_routes_priority ON routes(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_routes_agent ON routes(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_sdk ON sessions(sdk_session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name) WHERE name IS NOT NULL;

    -- local-grants: Relationship-based access control
    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      grant_mode TEXT NOT NULL DEFAULT 'permanent',
      expires_at INTEGER,
      revoked_at INTEGER,
      revocation_batch_id TEXT,
      reason TEXT,
      issued_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique
      ON relations(subject_type, subject_id, relation, object_type, object_id);
    CREATE INDEX IF NOT EXISTS idx_relations_subject
      ON relations(subject_type, subject_id);
    CREATE INDEX IF NOT EXISTS idx_relations_object
      ON relations(object_type, object_id);

    CREATE TABLE IF NOT EXISTS permission_denials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      agent_id TEXT,
      session_key TEXT,
      session_name TEXT,
      context_id TEXT,
      reason TEXT,
      command TEXT,
      detail_json TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolved_relation_id INTEGER,
      notified_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_permission_denials_pending
      ON permission_denials(subject_type, subject_id, relation, object_type, object_id, resolved_at);
    CREATE INDEX IF NOT EXISTS idx_permission_denials_session
      ON permission_denials(session_key, session_name, created_at DESC);

    CREATE TABLE IF NOT EXISTS permission_policy_rules (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      source_path TEXT,
      rule_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      disabled_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS permission_policy_materializations (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      selector_asset_type TEXT NOT NULL,
      selector_asset_id TEXT NOT NULL,
      tag_slug TEXT NOT NULL,
      tag_binding_id TEXT,
      tag_binding_source TEXT,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      desired_hash TEXT NOT NULL,
      relation_id INTEGER,
      status TEXT NOT NULL,
      conflict_source TEXT,
      reason TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_policy_materializations_policy_hash
      ON permission_policy_materializations(policy_id, desired_hash);
    CREATE INDEX IF NOT EXISTS idx_permission_policy_materializations_relation
      ON permission_policy_materializations(subject_type, subject_id, relation, object_type, object_id, status);
    CREATE INDEX IF NOT EXISTS idx_permission_policy_materializations_selector
      ON permission_policy_materializations(selector_asset_type, selector_asset_id, tag_slug, status);

    -- Message metadata (transcriptions, media paths — for reply reinjection)
    CREATE TABLE IF NOT EXISTS message_metadata (
      message_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      canonical_chat_id TEXT,
      actor_type TEXT,
      contact_id TEXT,
      agent_id TEXT,
      platform_identity_id TEXT,
      raw_sender_id TEXT,
      normalized_sender_id TEXT,
      identity_confidence REAL,
      identity_provenance_json TEXT,
      transcription TEXT,
      media_path TEXT,
      media_type TEXT,
      created_at INTEGER NOT NULL
    );
    -- TTL pruning hot path (DELETE FROM message_metadata WHERE created_at < ?)
    CREATE INDEX IF NOT EXISTS idx_message_metadata_created ON message_metadata(created_at);
    CREATE INDEX IF NOT EXISTS idx_message_metadata_contact_time
      ON message_metadata(contact_id, created_at);

    -- Cost tracking: granular per-turn cost events
    CREATE TABLE IF NOT EXISTS cost_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      input_cost_usd REAL NOT NULL,
      output_cost_usd REAL NOT NULL,
      cache_cost_usd REAL DEFAULT 0,
      total_cost_usd REAL NOT NULL,
      pricing_status TEXT NOT NULL DEFAULT 'legacy',
      pricing_source TEXT,
      pricing_source_url TEXT,
      pricing_source_version TEXT,
      pricing_fetched_at INTEGER,
      pricing_model TEXT,
      pricing_error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cost_events_agent ON cost_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_cost_events_session ON cost_events(session_key);
    CREATE INDEX IF NOT EXISTS idx_cost_events_created ON cost_events(created_at);

    -- Daily aggregated metrics. Source of truth for historical reporting AND
    -- the gate that allows TTL pruning of session_events / cost_events: a date
    -- without a row here cannot be pruned. UPSERT-friendly: re-running the
    -- rollup for a day overwrites the previous aggregation.
    CREATE TABLE IF NOT EXISTS daily_metrics (
      agent_id              TEXT NOT NULL,
      date                  TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
      model                 TEXT NOT NULL,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd        REAL    NOT NULL DEFAULT 0,
      cost_event_count      INTEGER NOT NULL DEFAULT 0,
      turns_complete        INTEGER NOT NULL DEFAULT 0,
      turns_failed          INTEGER NOT NULL DEFAULT 0,
      turns_interrupted     INTEGER NOT NULL DEFAULT 0,
      tool_calls            INTEGER NOT NULL DEFAULT 0,
      tool_errors           INTEGER NOT NULL DEFAULT 0,
      total_duration_ms     INTEGER NOT NULL DEFAULT 0,
      rolled_up_at          INTEGER NOT NULL,
      PRIMARY KEY (agent_id, date, model)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date);
    CREATE INDEX IF NOT EXISTS idx_daily_metrics_agent_date ON daily_metrics(agent_id, date DESC);

    -- Session trace: append-only session inspection ledger
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      session_name TEXT,
      agent_id TEXT,
      run_id TEXT,
      turn_id TEXT,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_group TEXT NOT NULL,
      status TEXT,
      timestamp INTEGER NOT NULL,
      source_channel TEXT,
      source_account_id TEXT,
      source_chat_id TEXT,
      source_thread_id TEXT,
      canonical_chat_id TEXT,
      actor_type TEXT,
      contact_id TEXT,
      actor_agent_id TEXT,
      platform_identity_id TEXT,
      raw_sender_id TEXT,
      normalized_sender_id TEXT,
      identity_confidence REAL,
      identity_provenance_json TEXT,
      message_id TEXT,
      provider TEXT,
      model TEXT,
      payload_json TEXT,
      preview TEXT,
      error TEXT,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_key_time
      ON session_events(session_key, timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_events_name_time
      ON session_events(session_name, timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_events_run_seq
      ON session_events(run_id, seq);
    -- Hot path: SELECT COALESCE(MAX(seq), 0) + 1 FROM session_events WHERE session_key = ?
    CREATE INDEX IF NOT EXISTS idx_session_events_key_seq
      ON session_events(session_key, seq DESC);
    -- TTL pruning: DELETE FROM session_events WHERE timestamp < ?
    CREATE INDEX IF NOT EXISTS idx_session_events_timestamp
      ON session_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_events_turn_seq
      ON session_events(turn_id, seq);
    CREATE INDEX IF NOT EXISTS idx_session_events_type_time
      ON session_events(event_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_events_chat_time
      ON session_events(source_chat_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_events_contact_time
      ON session_events(contact_id, timestamp);

    -- Omni group metadata cache: local snapshot used by prompt context.
    CREATE TABLE IF NOT EXISTS omni_group_metadata (
      account_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chat_uuid TEXT,
      external_id TEXT,
      channel TEXT,
      name TEXT,
      description TEXT,
      avatar_url TEXT,
      participant_count INTEGER,
      participants_json TEXT,
      settings_json TEXT,
      platform_metadata_json TEXT,
      fetched_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, instance_id, chat_id)
    );

    CREATE INDEX IF NOT EXISTS idx_omni_group_metadata_fetched
      ON omni_group_metadata(fetched_at);

    CREATE TABLE IF NOT EXISTS session_turns (
      turn_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      session_name TEXT,
      run_id TEXT,
      agent_id TEXT,
      provider TEXT,
      model TEXT,
      effort TEXT,
      thinking TEXT,
      cwd TEXT,
      status TEXT NOT NULL,
      resume INTEGER NOT NULL DEFAULT 0,
      fork INTEGER NOT NULL DEFAULT 0,
      provider_session_id_before TEXT,
      provider_session_id_after TEXT,
      user_prompt_sha256 TEXT,
      system_prompt_sha256 TEXT,
      request_blob_sha256 TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      error TEXT,
      abort_reason TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_turns_session_time
      ON session_turns(session_key, started_at);
    CREATE INDEX IF NOT EXISTS idx_session_turns_run
      ON session_turns(run_id, started_at);

    CREATE TABLE IF NOT EXISTS daemon_restart_epochs (
      restart_epoch TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      caller_session_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daemon_restart_session_snapshots (
      restart_epoch TEXT NOT NULL,
      session_key TEXT NOT NULL,
      session_name TEXT NOT NULL,
      agent_id TEXT,
      runtime_provider TEXT,
      activity TEXT NOT NULL,
      non_idle INTEGER NOT NULL DEFAULT 0 CHECK(non_idle IN (0,1)),
      last_activity_at INTEGER NOT NULL,
      stopped_at INTEGER NOT NULL,
      pending_message_count INTEGER NOT NULL DEFAULT 0,
      pending_messages_json TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (restart_epoch, session_key),
      FOREIGN KEY(restart_epoch) REFERENCES daemon_restart_epochs(restart_epoch) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_daemon_restart_snapshots_epoch_active
      ON daemon_restart_session_snapshots(restart_epoch, non_idle, stopped_at, last_activity_at);

    CREATE TABLE IF NOT EXISTS daemon_restart_resume_deliveries (
      restart_epoch TEXT NOT NULL,
      session_key TEXT NOT NULL,
      session_name TEXT,
      delivered_at INTEGER NOT NULL,
      PRIMARY KEY (restart_epoch, session_key),
      FOREIGN KEY(restart_epoch) REFERENCES daemon_restart_epochs(restart_epoch) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS session_trace_blobs (
      sha256 TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_text TEXT,
      content_json TEXT,
      redacted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_trace_blobs_kind
      ON session_trace_blobs(kind, created_at);
    -- TTL pruning: DELETE FROM session_trace_blobs WHERE created_at < ?
    CREATE INDEX IF NOT EXISTS idx_session_trace_blobs_created
      ON session_trace_blobs(created_at);

    -- Local-first sync: optional, best-effort replication ledger.
    -- SQLite remains the local source of truth; these tables are durable queues
    -- for remote bridge delivery and cursor-based remote intake.
    CREATE TABLE IF NOT EXISTS sync_outbox (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      origin_installation_id TEXT,
      domain TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_revision INTEGER,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      evidence_refs_json TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('pending','leased','sent','acked','failed','dead')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      lease_id TEXT,
      leased_until INTEGER,
      last_error_code TEXT,
      occurred_at INTEGER NOT NULL,
      sent_at INTEGER,
      acked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_next
      ON sync_outbox(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_domain_status
      ON sync_outbox(domain, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_lease
      ON sync_outbox(lease_id, leased_until);

    CREATE TABLE IF NOT EXISTS sync_inbox (
      id TEXT PRIMARY KEY,
      remote_sequence TEXT,
      remote_event_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','applied','skipped','failed','dead')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      received_at INTEGER NOT NULL,
      applied_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(remote_event_id),
      UNIQUE(domain, remote_sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_inbox_status
      ON sync_inbox(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_inbox_domain_status
      ON sync_inbox(domain, status, created_at);

    CREATE TABLE IF NOT EXISTS sync_cursors (
      domain TEXT NOT NULL,
      cursor_key TEXT NOT NULL,
      cursor_value TEXT,
      updated_at INTEGER NOT NULL,
      meta_json TEXT,
      PRIMARY KEY (domain, cursor_key)
    );

    CREATE TABLE IF NOT EXISTS sync_dead_letters (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      domain TEXT,
      reason_code TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_dead_letters_source
      ON sync_dead_letters(source, source_id);

    -- Instances: central config entity (one per omni connection)
    CREATE TABLE IF NOT EXISTS instances (
      name         TEXT PRIMARY KEY,
      instance_id  TEXT UNIQUE,
      channel      TEXT NOT NULL DEFAULT 'whatsapp',
      agent        TEXT REFERENCES agents(id) ON DELETE SET NULL,
      dm_policy    TEXT NOT NULL DEFAULT 'open' CHECK(dm_policy IN ('open','pairing','closed')),
      group_policy TEXT NOT NULL DEFAULT 'open' CHECK(group_policy IN ('open','allowlist','closed')),
      contact_intake_mode TEXT NOT NULL DEFAULT 'off' CHECK(contact_intake_mode IN ('off','discovered','pending')),
      dm_scope     TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
      enabled      INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      defaults     TEXT,
      default_contact_tags TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contexts (
      context_id TEXT PRIMARY KEY,
      context_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'runtime',
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      session_key TEXT REFERENCES sessions(session_key) ON DELETE SET NULL,
      session_name TEXT,
      source_json TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_used_at INTEGER,
      revoked_at INTEGER
    );

    -- Matrix accounts (all users - both regular users and agents)
    CREATE TABLE IF NOT EXISTS matrix_accounts (
      username TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      homeserver TEXT NOT NULL,
      access_token TEXT NOT NULL,
      device_id TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);

  // Migration: add matrix_account column to agents if not exists
  const agentColumns = db.prepare("PRAGMA table_info(agents)").all() as Array<{
    name: string;
  }>;
  if (!agentColumns.some((c) => c.name === "matrix_account")) {
    db.exec("ALTER TABLE agents ADD COLUMN matrix_account TEXT REFERENCES matrix_accounts(username)");
    log.info("Added matrix_account column to agents table");
  }

  // Migration: Phase 1 CRM business-unit pointer on instances. Unenforced TEXT
  // pointer — NO foreign key, not even in Phase 3. The router owns ravi.db while
  // crm_business_units lives in chat.db (src/contacts.ts), and SQLite foreign
  // keys cannot cross database files. An inline REFERENCES to a table absent
  // from ravi.db is worse than useless: under foreign_keys=ON it makes SQLite
  // reject every prepared INSERT/UPDATE on instances ("no such table:
  // crm_business_units" at prepare time), which would crash the router. The
  // pointer is resolved/validated at the app layer by the Phase 2 resolver,
  // which already performs the cross-DB lookup; unmapped instances stay NULL
  // and resolve to the default business unit.
  const instanceColumns = db.prepare("PRAGMA table_info(instances)").all() as Array<{ name: string }>;
  if (!instanceColumns.some((c) => c.name === "crm_business_unit_id")) {
    db.exec("ALTER TABLE instances ADD COLUMN crm_business_unit_id TEXT");
    log.info("Added crm_business_unit_id column to instances table");
  }

  // Migration: add heartbeat columns to agents if not exists
  if (!agentColumns.some((c) => c.name === "heartbeat_enabled")) {
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_enabled INTEGER DEFAULT 0;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_interval_ms INTEGER DEFAULT 1800000;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_model TEXT;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_active_start TEXT;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_active_end TEXT;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_last_run_at INTEGER;
    `);
    log.info("Added heartbeat columns to agents table");
  }

  // Migration: add setting_sources column to agents if not exists
  if (!agentColumns.some((c) => c.name === "setting_sources")) {
    db.exec("ALTER TABLE agents ADD COLUMN setting_sources TEXT");
    log.info("Added setting_sources column to agents table");
  }

  // Migration: add provider column to agents if not exists
  if (!agentColumns.some((c) => c.name === "provider")) {
    db.exec("ALTER TABLE agents ADD COLUMN provider TEXT");
    log.info("Added provider column to agents table");
  }

  if (!agentColumns.some((c) => c.name === "remote")) {
    db.exec("ALTER TABLE agents ADD COLUMN remote TEXT");
    log.info("Added remote column to agents table");
  }

  if (!agentColumns.some((c) => c.name === "remote_user")) {
    db.exec("ALTER TABLE agents ADD COLUMN remote_user TEXT");
    log.info("Added remote_user column to agents table");
  }

  // Migration: drop legacy permission columns (replaced by local-grants)
  const legacyCols = ["allowed_tools", "bash_mode", "bash_allowlist", "bash_denylist"];
  const toDrop = legacyCols.filter((c) => agentColumns.some((ac) => ac.name === c));
  if (toDrop.length > 0) {
    for (const col of toDrop) {
      db.exec(`ALTER TABLE agents DROP COLUMN ${col}`);
    }
    log.info("Dropped legacy permission columns from agents table", {
      columns: toDrop,
    });
  }

  // Migration: add spec_mode column to agents if not exists
  if (!agentColumns.some((c) => c.name === "spec_mode")) {
    db.exec("ALTER TABLE agents ADD COLUMN spec_mode INTEGER DEFAULT 0");
    log.info("Added spec_mode column to agents table");
  }

  // Migration: add scope isolation columns to agents if not exists
  if (!agentColumns.some((c) => c.name === "contact_scope")) {
    db.exec("ALTER TABLE agents ADD COLUMN contact_scope TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN allowed_sessions TEXT");
    log.info("Added scope isolation columns to agents table");
  }

  // Migration: add agent_mode column to agents if not exists
  if (!agentColumns.some((c) => c.name === "agent_mode")) {
    db.exec("ALTER TABLE agents ADD COLUMN agent_mode TEXT");
    log.info("Added agent_mode column to agents table");
  }

  // Migration: add group_debounce_ms column to agents if not exists
  if (!agentColumns.some((c) => c.name === "group_debounce_ms")) {
    db.exec("ALTER TABLE agents ADD COLUMN group_debounce_ms INTEGER");
    log.info("Added group_debounce_ms column to agents table");
  }

  // Migration: add defaults column to agents if not exists
  if (!agentColumns.some((c) => c.name === "defaults")) {
    db.exec("ALTER TABLE agents ADD COLUMN defaults TEXT");
    log.info("Added defaults column to agents table");
  }

  // Migration: add heartbeat columns to sessions if not exists
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!sessionColumns.some((c) => c.name === "last_heartbeat_text")) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN last_heartbeat_text TEXT;
    `);
    db.exec(`
      ALTER TABLE sessions ADD COLUMN last_heartbeat_sent_at INTEGER;
    `);
    log.info("Added heartbeat columns to sessions table");
  }

  // Migration: add last_context column to sessions if not exists
  if (!sessionColumns.some((c) => c.name === "last_context")) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_context TEXT");
    log.info("Added last_context column to sessions table");
  }

  // Migration: add runtime_provider column to sessions if not exists
  if (!sessionColumns.some((c) => c.name === "runtime_provider")) {
    db.exec("ALTER TABLE sessions ADD COLUMN runtime_provider TEXT");
    log.info("Added runtime_provider column to sessions table");
  }
  if (!sessionColumns.some((c) => c.name === "runtime_session_json")) {
    db.exec("ALTER TABLE sessions ADD COLUMN runtime_session_json TEXT");
    log.info("Added runtime_session_json column to sessions table");
  }
  if (!sessionColumns.some((c) => c.name === "runtime_session_display_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN runtime_session_display_id TEXT");
    log.info("Added runtime_session_display_id column to sessions table");
  }
  db.exec(
    "UPDATE sessions SET runtime_provider = 'claude' WHERE runtime_provider IS NULL AND sdk_session_id IS NOT NULL",
  );
  db.exec(`
    UPDATE sessions
    SET runtime_session_display_id = sdk_session_id
    WHERE runtime_session_display_id IS NULL AND sdk_session_id IS NOT NULL
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_runtime_display ON sessions(runtime_session_display_id)");

  // Migration: add policy column to routes if not exists
  const routeColumns = db.prepare("PRAGMA table_info(routes)").all() as Array<{
    name: string;
  }>;
  if (!routeColumns.some((c) => c.name === "policy")) {
    db.exec("ALTER TABLE routes ADD COLUMN policy TEXT");
    log.info("Added policy column to routes table");
  }

  // Migration: seed instances table from account.* settings (one-time)
  const instanceCount = (db.prepare("SELECT COUNT(*) as n FROM instances").get() as { n: number }).n;
  if (instanceCount === 0) {
    const settingRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'account.%'").all() as Array<{
      key: string;
      value: string;
    }>;
    const instanceData: Record<string, Partial<InstanceConfig>> = {};

    for (const { key, value } of settingRows) {
      const m = key.match(/^account\.([^.]+)\.(.+)$/);
      if (!m) continue;
      const [, name, field] = m;
      if (!instanceData[name]) instanceData[name] = { name };
      if (field === "instanceId") instanceData[name].instanceId = value;
      else if (field === "agent") instanceData[name].agent = value;
      else if (field === "dmPolicy" && (value === "open" || value === "pairing" || value === "closed"))
        instanceData[name].dmPolicy = value;
      else if (field === "groupPolicy" && (value === "open" || value === "allowlist" || value === "closed"))
        instanceData[name].groupPolicy = value;
    }

    const insertInstance = db.prepare(`
      INSERT OR IGNORE INTO instances (
        name, instance_id, channel, agent, dm_policy, group_policy, contact_intake_mode,
        enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'off', ?, ?, ?)
    `);
    const now = Date.now();
    for (const inst of Object.values(instanceData)) {
      if (!inst.name) continue;
      insertInstance.run(
        inst.name,
        inst.instanceId ?? null,
        "whatsapp",
        inst.agent ?? null,
        inst.dmPolicy ?? "open",
        inst.groupPolicy ?? "open",
        inst.enabled === false ? 0 : 1,
        now,
        now,
      );
      log.info("Migrated instance from settings", { name: inst.name });
    }
  }

  // Migration: add ephemeral session columns
  if (!sessionColumns.some((c) => c.name === "ephemeral")) {
    db.exec("ALTER TABLE sessions ADD COLUMN ephemeral INTEGER DEFAULT 0");
    db.exec("ALTER TABLE sessions ADD COLUMN expires_at INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_ephemeral ON sessions(ephemeral, expires_at) WHERE ephemeral = 1");
    log.info("Added ephemeral session columns to sessions table");
  }

  // Migration: add name column to sessions (human-readable unique identifier)
  if (!sessionColumns.some((c) => c.name === "name")) {
    db.exec("ALTER TABLE sessions ADD COLUMN name TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name) WHERE name IS NOT NULL");
    log.info("Added name column to sessions table");

    // Migrate existing sessions: generate names from session_key
    const rows = db
      .prepare("SELECT session_key, agent_id, display_name, chat_type, group_id FROM sessions")
      .all() as Array<{
      session_key: string;
      agent_id: string;
      display_name: string | null;
      chat_type: string | null;
      group_id: string | null;
    }>;
    const usedNames = new Set<string>();
    const { slugify } = require("./session-name.js") as typeof import("./session-name.js");
    const updateName = db.prepare("UPDATE sessions SET name = ? WHERE session_key = ?");
    for (const row of rows) {
      let name: string;
      const agent = slugify(row.agent_id);
      if (row.session_key.endsWith(":main")) {
        name = agent;
      } else if (row.display_name) {
        name = `${agent}-${slugify(row.display_name)}`;
      } else if (row.group_id) {
        const cleanId = row.group_id.replace(/^group:/, "").slice(-8);
        name = `${agent}-group-${cleanId}`;
      } else {
        // DM or unknown — use last part of session key
        const parts = row.session_key.split(":");
        const lastPart = parts[parts.length - 1];
        const clean = slugify(lastPart).slice(-12);
        name = `${agent}-${clean || "session"}`;
      }
      // Deduplicate
      let finalName = name.slice(0, 64);
      let i = 2;
      while (usedNames.has(finalName)) {
        finalName = `${name.slice(0, 60)}-${i}`;
        i++;
      }
      usedNames.add(finalName);
      updateName.run(finalName, row.session_key);
    }
    if (rows.length > 0) {
      log.info(`Migrated ${rows.length} session names`);
    }
  }

  // Migration: create cron_jobs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER DEFAULT 1,
      delete_after_run INTEGER DEFAULT 0,

      -- Schedule (one of these is set based on schedule_type)
      schedule_type TEXT NOT NULL,
      schedule_at INTEGER,
      schedule_every INTEGER,
      schedule_cron TEXT,
      schedule_timezone TEXT,

      -- Execution config
      session_target TEXT DEFAULT 'main',
      reply_session TEXT,
      execution_type TEXT DEFAULT 'agent',
      payload_text TEXT NOT NULL,
      shell_command TEXT,
      shell_timeout_ms INTEGER,
      shell_env_file TEXT,
      on_error TEXT,

      -- State
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      last_error TEXT,
      last_duration_ms INTEGER,
      last_exit_code INTEGER,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at);
  `);

  // Migration: add reply_session to cron_jobs
  try {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN reply_session TEXT");
  } catch {
    /* column already exists */
  }

  db.exec(`
    -- Event triggers
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT,
      topic TEXT NOT NULL,
      message TEXT NOT NULL,
      session TEXT DEFAULT 'isolated' CHECK(session IN ('main','isolated')),
      enabled INTEGER DEFAULT 1,
      cooldown_ms INTEGER DEFAULT 5000,
      last_fired_at INTEGER,
      fire_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_triggers_enabled ON triggers(enabled);
    CREATE INDEX IF NOT EXISTS idx_triggers_topic ON triggers(topic);
  `);

  // Migrations for triggers
  const triggerColumns = db.prepare("PRAGMA table_info(triggers)").all() as Array<{ name: string }>;
  if (!triggerColumns.some((c) => c.name === "reply_session")) {
    db.exec("ALTER TABLE triggers ADD COLUMN reply_session TEXT");
    log.info("Added reply_session column to triggers table");
  }
  if (!triggerColumns.some((c) => c.name === "account_id")) {
    db.exec("ALTER TABLE triggers ADD COLUMN account_id TEXT");
    log.info("Added account_id column to triggers table");
  }
  if (!triggerColumns.some((c) => c.name === "filter")) {
    db.exec("ALTER TABLE triggers ADD COLUMN filter TEXT");
    log.info("Added filter column to triggers table");
  }
  if (!triggerColumns.some((c) => c.name === "reply_source")) {
    db.exec("ALTER TABLE triggers ADD COLUMN reply_source TEXT");
    log.info("Added reply_source column to triggers table");
  }
  if (!triggerColumns.some((c) => c.name === "message_source")) {
    db.exec("ALTER TABLE triggers ADD COLUMN message_source TEXT DEFAULT 'manual'");
    log.info("Added message_source column to triggers table");
  }
  if (!triggerColumns.some((c) => c.name === "message_template_id")) {
    db.exec("ALTER TABLE triggers ADD COLUMN message_template_id TEXT");
    log.info("Added message_template_id column to triggers table");
  }

  // Migration: add account_id column to cron_jobs
  const cronColumns = db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
  if (!cronColumns.some((c) => c.name === "account_id")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN account_id TEXT");
    log.info("Added account_id column to cron_jobs table");
  }
  if (!cronColumns.some((c) => c.name === "execution_type")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN execution_type TEXT DEFAULT 'agent'");
    log.info("Added execution_type column to cron_jobs table");
  }
  if (!cronColumns.some((c) => c.name === "shell_command")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN shell_command TEXT");
    log.info("Added shell_command column to cron_jobs table");
  }
  if (!cronColumns.some((c) => c.name === "shell_timeout_ms")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN shell_timeout_ms INTEGER");
    log.info("Added shell_timeout_ms column to cron_jobs table");
  }
  if (!cronColumns.some((c) => c.name === "shell_env_file")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN shell_env_file TEXT");
    log.info("Added shell_env_file column to cron_jobs table");
  }
  if (!cronColumns.some((c) => c.name === "on_error")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN on_error TEXT");
    log.info("Added on_error column to cron_jobs table");
  }
  if (!cronColumns.some((c) => c.name === "last_exit_code")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN last_exit_code INTEGER");
    log.info("Added last_exit_code column to cron_jobs table");
  }

  // Migration: add heartbeat_account_id column to agents
  if (!agentColumns.some((c) => c.name === "heartbeat_account_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN heartbeat_account_id TEXT");
    log.info("Added heartbeat_account_id column to agents table");
  }

  // Migration: add account_id column to routes (recreate table for UNIQUE constraint change)
  const routeColumnsV1 = db.prepare("PRAGMA table_info(routes)").all() as Array<{ name: string }>;
  if (!routeColumnsV1.some((c) => c.name === "account_id")) {
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE routes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern TEXT NOT NULL,
          account_id TEXT NOT NULL,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          dm_scope TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
          priority INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(pattern, account_id)
        );
        INSERT INTO routes_new (id, pattern, account_id, agent_id, dm_scope, priority, created_at, updated_at)
          SELECT id, pattern, 'unknown', agent_id, dm_scope, priority, created_at, updated_at FROM routes;
        DROP TABLE routes;
        ALTER TABLE routes_new RENAME TO routes;
        CREATE INDEX IF NOT EXISTS idx_routes_priority ON routes(priority DESC);
        CREATE INDEX IF NOT EXISTS idx_routes_agent ON routes(agent_id);
        CREATE INDEX IF NOT EXISTS idx_routes_account ON routes(account_id);
        COMMIT;
      `);
      log.info("Migrated routes table: added account_id column with UNIQUE(pattern, account_id)");
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }
  // Ensure account index exists (for fresh DBs that skip migration)
  db.exec("CREATE INDEX IF NOT EXISTS idx_routes_account ON routes(account_id)");

  // Migration: add session_name column to routes
  const routeColumnsAfter = db.prepare("PRAGMA table_info(routes)").all() as Array<{ name: string }>;
  if (!routeColumnsAfter.some((c) => c.name === "session_name")) {
    db.exec("ALTER TABLE routes ADD COLUMN session_name TEXT");
    log.info("Added session_name column to routes table");
  }

  // Migration: add channel column to routes (null = applies to all channels)
  if (!routeColumnsAfter.some((c) => c.name === "channel")) {
    db.exec("ALTER TABLE routes ADD COLUMN channel TEXT");
    // Drop old unique index and recreate including channel
    db.exec("DROP INDEX IF EXISTS idx_routes_unique_pattern");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_unique ON routes(pattern, account_id, COALESCE(channel, ''))",
    );
    log.info("Added channel column to routes table");
  }

  // Migration: soft-delete columns for routes and instances + audit_log table
  if (!routeColumnsAfter.some((c) => c.name === "deleted_at")) {
    db.exec("ALTER TABLE routes ADD COLUMN deleted_at INTEGER");
    log.info("Added deleted_at column to routes table");
  }
  ensureColumn(db, "instances", "deleted_at", "INTEGER");
  ensureColumn(db, "instances", "enabled", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(
    db,
    "instances",
    "contact_intake_mode",
    "TEXT NOT NULL DEFAULT 'off' CHECK(contact_intake_mode IN ('off','discovered','pending'))",
  );
  ensureColumn(db, "instances", "defaults", "TEXT");
  ensureColumn(db, "instances", "default_contact_tags", "TEXT");

  const contextColumns = db.prepare("PRAGMA table_info(contexts)").all() as Array<{ name: string }>;
  if (contextColumns.length > 0 && !contextColumns.some((c) => c.name === "context_id")) {
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE contexts_new (
          context_id TEXT PRIMARY KEY,
          context_key TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL DEFAULT 'runtime',
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          session_key TEXT REFERENCES sessions(session_key) ON DELETE SET NULL,
          session_name TEXT,
          source_json TEXT,
          capabilities_json TEXT NOT NULL DEFAULT '[]',
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          last_used_at INTEGER,
          revoked_at INTEGER
        );
        INSERT INTO contexts_new (
          context_id, context_key, kind, agent_id, session_key, session_name,
          source_json, capabilities_json, metadata_json, created_at, expires_at, last_used_at, revoked_at
        )
        SELECT
          'ctx_legacy_' || lower(hex(randomblob(12))),
          context_key,
          'legacy',
          agent_id,
          session_key,
          session_name,
          CASE
            WHEN source_channel IS NOT NULL AND source_account_id IS NOT NULL AND source_chat_id IS NOT NULL
              THEN json_object('channel', source_channel, 'accountId', source_account_id, 'chatId', source_chat_id)
            ELSE NULL
          END,
          '[]',
          NULL,
          created_at,
          NULL,
          updated_at,
          NULL
        FROM contexts;
        DROP TABLE contexts;
        ALTER TABLE contexts_new RENAME TO contexts;
        COMMIT;
      `);
      log.info("Migrated contexts table to central registry schema");
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }
  const contextColumnsNow = db.prepare("PRAGMA table_info(contexts)").all() as Array<{ name: string }>;
  if (!contextColumnsNow.some((c) => c.name === "kind")) {
    db.exec("ALTER TABLE contexts ADD COLUMN kind TEXT NOT NULL DEFAULT 'runtime'");
  }
  if (!contextColumnsNow.some((c) => c.name === "capabilities_json")) {
    db.exec("ALTER TABLE contexts ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!contextColumnsNow.some((c) => c.name === "metadata_json")) {
    db.exec("ALTER TABLE contexts ADD COLUMN metadata_json TEXT");
  }
  if (!contextColumnsNow.some((c) => c.name === "expires_at")) {
    db.exec("ALTER TABLE contexts ADD COLUMN expires_at INTEGER");
  }
  if (!contextColumnsNow.some((c) => c.name === "last_used_at")) {
    db.exec("ALTER TABLE contexts ADD COLUMN last_used_at INTEGER");
  }
  if (!contextColumnsNow.some((c) => c.name === "revoked_at")) {
    db.exec("ALTER TABLE contexts ADD COLUMN revoked_at INTEGER");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_contexts_key ON contexts(context_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contexts_agent ON contexts(agent_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contexts_session ON contexts(session_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contexts_expires ON contexts(expires_at)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      action     TEXT NOT NULL,
      entity     TEXT NOT NULL,
      entity_id  TEXT NOT NULL,
      old_value  TEXT,
      actor      TEXT NOT NULL DEFAULT 'daemon',
      ts         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

    CREATE TABLE IF NOT EXISTS router_meta (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  ensureRelationMigrations(db);
  ensureCostEventMigrations(db);
  ensureIdentityChatMigrations(db);
  backfillChatModelOnce(db);

  // Create default agent if none exist
  const count = db.prepare("SELECT COUNT(*) as count FROM agents").get() as {
    count: number;
  };
  if (count.count === 0) {
    const now = Date.now();
    db.prepare(
      `
      INSERT INTO agents (id, name, cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run("main", "Ravi", join(RAVI_DIR, "main"), now, now);
    log.info("Created default agent: main");
  }

  // Startup cleanup: remove any expired ephemeral sessions left over from previous runs
  const expiredCount = (
    db
      .prepare("SELECT COUNT(*) as n FROM sessions WHERE ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ?")
      .get(Date.now()) as { n: number }
  ).n;
  if (expiredCount > 0) {
    db.prepare("DELETE FROM sessions WHERE ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ?").run(
      Date.now(),
    );
    log.info("Cleaned up expired ephemeral sessions at startup", {
      count: expiredCount,
    });
  }

  log.debug("Database initialized", { path: nextDbPath });
  return db;
}

/**
 * Get the number of rows changed by the last INSERT/UPDATE/DELETE.
 * Uses SQLite's changes() function since bun:sqlite doesn't expose db.changes.
 */
function getDbChanges(): number {
  const row = getDb().prepare("SELECT changes() AS c").get() as {
    c: number;
  } | null;
  return row?.c ?? 0;
}

// ============================================================================
// Identity/chats schema helpers
// ============================================================================

function semanticId(prefix: string, parts: Array<string | null | undefined>): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\x1f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${hash}`;
}

function uniqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function tableHasColumn(database: Database, table: string, column: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

function ensureColumn(database: Database, table: string, column: string, definition: string): void {
  if (!tableHasColumn(database, table, column)) {
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      log.info("Added schema column", { table, column });
    } catch (error) {
      if (isDuplicateColumnRace(error) && tableHasColumn(database, table, column)) {
        log.debug("Schema column already added by another process", {
          table,
          column,
        });
        return;
      }
      throw error;
    }
  }
}

function isDuplicateColumnRace(error: unknown): boolean {
  return error instanceof Error && /duplicate column name/i.test(error.message);
}

function ensureRelationMigrations(database: Database): void {
  ensureColumn(database, "relations", "grant_mode", "TEXT NOT NULL DEFAULT 'permanent'");
  ensureColumn(database, "relations", "expires_at", "INTEGER");
  ensureColumn(database, "relations", "revoked_at", "INTEGER");
  ensureColumn(database, "relations", "revocation_batch_id", "TEXT");
  ensureColumn(database, "relations", "reason", "TEXT");
  ensureColumn(database, "relations", "issued_by", "TEXT");
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_relations_revocation_batch ON relations(revocation_batch_id) WHERE revocation_batch_id IS NOT NULL",
  );
}

function ensureCostEventMigrations(database: Database): void {
  ensureColumn(database, "cost_events", "pricing_status", "TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn(database, "cost_events", "pricing_source", "TEXT");
  ensureColumn(database, "cost_events", "pricing_source_url", "TEXT");
  ensureColumn(database, "cost_events", "pricing_source_version", "TEXT");
  ensureColumn(database, "cost_events", "pricing_fetched_at", "INTEGER");
  ensureColumn(database, "cost_events", "pricing_model", "TEXT");
  ensureColumn(database, "cost_events", "pricing_error", "TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS idx_cost_events_pricing_status ON cost_events(pricing_status, created_at)");
}

function ensureIdentityChatMigrations(database: Database): void {
  ensureColumn(database, "message_metadata", "canonical_chat_id", "TEXT");
  ensureColumn(database, "message_metadata", "actor_type", "TEXT");
  ensureColumn(database, "message_metadata", "contact_id", "TEXT");
  ensureColumn(database, "message_metadata", "agent_id", "TEXT");
  ensureColumn(database, "message_metadata", "platform_identity_id", "TEXT");
  ensureColumn(database, "message_metadata", "raw_sender_id", "TEXT");
  ensureColumn(database, "message_metadata", "normalized_sender_id", "TEXT");
  ensureColumn(database, "message_metadata", "identity_confidence", "REAL");
  ensureColumn(database, "message_metadata", "identity_provenance_json", "TEXT");

  ensureColumn(database, "session_events", "canonical_chat_id", "TEXT");
  ensureColumn(database, "session_events", "actor_type", "TEXT");
  ensureColumn(database, "session_events", "contact_id", "TEXT");
  ensureColumn(database, "session_events", "actor_agent_id", "TEXT");
  ensureColumn(database, "session_events", "platform_identity_id", "TEXT");
  ensureColumn(database, "session_events", "raw_sender_id", "TEXT");
  ensureColumn(database, "session_events", "normalized_sender_id", "TEXT");
  ensureColumn(database, "session_events", "identity_confidence", "REAL");
  ensureColumn(database, "session_events", "identity_provenance_json", "TEXT");
  ensureColumn(database, "chat_messages", "edited_at", "INTEGER");
  ensureColumn(database, "chat_messages", "deleted_at", "INTEGER");

  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_message_metadata_canonical_chat ON message_metadata(canonical_chat_id)",
  );
  database.exec("CREATE INDEX IF NOT EXISTS idx_session_events_canonical_chat ON session_events(canonical_chat_id)");

  // sessions/attach owns the output attachment. Remove legacy focus state
  // so old focus rows cannot surprise a future downgrade/inspection path.
  database.exec("DROP TABLE IF EXISTS session_focus");
  ensureColumn(database, "session_chat_subscriptions", "output_attached_at", "INTEGER");
  const hadSubscriptionSpeechMode = tableHasColumn(database, "session_chat_subscriptions", "speech_mode");
  ensureColumn(
    database,
    "session_chat_subscriptions",
    "speech_mode",
    "TEXT NOT NULL DEFAULT 'speak' CHECK(speech_mode IN ('muted', 'speak'))",
  );
  ensureColumn(database, "session_chat_subscriptions", "speech_updated_at", "INTEGER");
  ensureColumn(database, "session_chat_subscriptions", "speech_reason", "TEXT");
  if (!hadSubscriptionSpeechMode) {
    backfillSessionSpeechModes(database);
  }

  // sessions/attach: enforce the spec invariant that a chat can only be
  // active in one session at a time. Order matters here:
  //   1. dedupe any existing duplicates (soft-detach all but the most
  //      recent active row per chat) so the UNIQUE index can install;
  //   2. drop any legacy non-unique index by the same name (created by
  //      older code on this branch);
  //   3. install the partial UNIQUE index;
  //   4. backfill from session_chat_bindings, picking one binding per
  //      chat (the most recent) so legacy 1:N data does not regenerate
  //      duplicates after cleanup.
  // The whole sequence is wrapped in a transaction so a concurrent
  // writer (e.g. the daemon's consumer doing `attachChatToSession`)
  // cannot squeeze an INSERT between dedupe and CREATE UNIQUE INDEX,
  // which would make the CREATE fail and leave the migration half-done.
  database.transaction(() => {
    dedupeSessionChatSubscriptions(database);
    database.exec("DROP INDEX IF EXISTS idx_session_chat_subscriptions_active_chat");
    database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_chat_subscriptions_active_chat ON session_chat_subscriptions(chat_id) WHERE detached_at IS NULL",
    );
    backfillSessionChatSubscriptionsFromBindings(database);
    backfillSessionOutputAttachments(database);
    database.exec("DROP INDEX IF EXISTS idx_session_chat_subscriptions_output_target");
    database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_chat_subscriptions_output_target ON session_chat_subscriptions(session_key) WHERE detached_at IS NULL AND output_attached_at IS NOT NULL",
    );
  })();
}

/**
 * Test-only: re-run the dedupe + backfill migration steps on the current
 * database. Production callers must rely on `ensureIdentityChatMigrations`
 * running once at startup.
 */
export function dbRunSessionAttachMigrationForTests(): void {
  const db = getDb();
  ensureColumn(
    db,
    "session_chat_subscriptions",
    "speech_mode",
    "TEXT NOT NULL DEFAULT 'speak' CHECK(speech_mode IN ('muted', 'speak'))",
  );
  ensureColumn(db, "session_chat_subscriptions", "speech_updated_at", "INTEGER");
  ensureColumn(db, "session_chat_subscriptions", "speech_reason", "TEXT");
  dedupeSessionChatSubscriptions(db);
  db.exec("DROP INDEX IF EXISTS idx_session_chat_subscriptions_active_chat");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_chat_subscriptions_active_chat ON session_chat_subscriptions(chat_id) WHERE detached_at IS NULL",
  );
  backfillSessionChatSubscriptionsFromBindings(db);
  backfillSessionOutputAttachments(db);
  db.exec("DROP INDEX IF EXISTS idx_session_chat_subscriptions_output_target");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_chat_subscriptions_output_target ON session_chat_subscriptions(session_key) WHERE detached_at IS NULL AND output_attached_at IS NOT NULL",
  );
}

function dedupeSessionChatSubscriptions(database: Database): void {
  const now = Date.now();
  const result = database
    .prepare(
      `
      UPDATE session_chat_subscriptions
      SET detached_at = ?, updated_at = ?
      WHERE detached_at IS NULL
        AND id NOT IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY chat_id
                     ORDER BY updated_at DESC, id DESC
                   ) AS rn
            FROM session_chat_subscriptions
            WHERE detached_at IS NULL
          )
          WHERE rn = 1
        )
    `,
    )
    .run(now, now);
  if (result.changes > 0) {
    log.warn("Detached duplicate active session_chat_subscriptions (kept most recent per chat)", {
      rows: result.changes,
    });
  }
}

function backfillSessionChatSubscriptionsFromBindings(database: Database): void {
  const now = Date.now();
  // Backfill at most ONE subscription per chat. When legacy
  // session_chat_bindings has multiple sessions sharing the same chat
  // (allowed by the legacy schema), pick the most recently updated row
  // (tiebreak by session_key for determinism). This matches the spec
  // invariant "one chat → one session" at the cost of losing the older
  // bindings; operators can manually attach to recover if needed.
  const result = database
    .prepare(
      `
      INSERT INTO session_chat_subscriptions (
        session_key, chat_id, role, attached_by_type, attached_by_id,
        attached_reason, context_snapshot_at_attach_json,
        speech_mode, speech_updated_at, speech_reason,
        output_attached_at, created_at, updated_at, detached_at
      )
      SELECT
        ranked.session_key, ranked.chat_id, 'primary', 'system', NULL,
        'backfill-from-session-chat-bindings', NULL,
        'speak', ?, 'backfill-from-session-chat-bindings',
        ?, ?, ?, NULL
      FROM (
        SELECT b.session_key,
               b.chat_id,
               ROW_NUMBER() OVER (
                 PARTITION BY b.chat_id
                 ORDER BY b.updated_at DESC, b.session_key
               ) AS rn
        FROM session_chat_bindings b
      ) ranked
      WHERE ranked.rn = 1
        AND NOT EXISTS (
          SELECT 1 FROM session_chat_subscriptions s
          WHERE s.chat_id = ranked.chat_id
            AND s.detached_at IS NULL
        )
    `,
    )
    .run(now, now, now, now);
  if (result.changes > 0) {
    log.info("Backfilled session_chat_subscriptions from session_chat_bindings", { rows: result.changes });
  }
}

function backfillSessionOutputAttachments(database: Database): void {
  const now = Date.now();
  const result = database
    .prepare(
      `
      UPDATE session_chat_subscriptions
      SET output_attached_at = ?,
          speech_mode = 'speak',
          speech_updated_at = ?,
          speech_reason = 'backfill-output-attachment',
          updated_at = ?
      WHERE id IN (
        SELECT id FROM (
          SELECT s.id,
                 ROW_NUMBER() OVER (
                   PARTITION BY s.session_key
                   ORDER BY CASE WHEN s.role = 'primary' THEN 0 ELSE 1 END,
                            s.updated_at DESC,
                            s.id DESC
                 ) AS rn
          FROM session_chat_subscriptions s
          WHERE s.detached_at IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM session_chat_subscriptions o
              WHERE o.session_key = s.session_key
                AND o.detached_at IS NULL
                AND o.output_attached_at IS NOT NULL
            )
        )
        WHERE rn = 1
      )
    `,
    )
    .run(now, now, now);
  if (result.changes > 0) {
    log.info("Backfilled session output attachments", { rows: result.changes });
  }
}

function backfillSessionSpeechModes(database: Database): void {
  const now = Date.now();
  const result = database
    .prepare(
      `
      UPDATE session_chat_subscriptions
      SET speech_mode = CASE
            WHEN output_attached_at IS NOT NULL OR role = 'primary' THEN 'speak'
            ELSE 'muted'
          END,
          speech_updated_at = ?,
          speech_reason = 'backfill-from-attach-output',
          updated_at = ?
      WHERE detached_at IS NULL
    `,
    )
    .run(now, now);
  if (result.changes > 0) {
    log.info("Backfilled session subscription speech modes", {
      rows: result.changes,
    });
  }
}

function cleanJsonRecord(value: Record<string, unknown> | null | undefined): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mergeJsonRecords(
  ...values: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  for (const value of values) {
    if (!value) continue;
    Object.assign(merged, value);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeChannelId(channel: string | null | undefined): string {
  const cleaned = channel
    ?.trim()
    .toLowerCase()
    .replace(/-baileys$/, "");
  return cleaned || "unknown";
}

function normalizeChatIdentity(channel: string, platformChatId: string, chatType?: ChatType): string {
  const trimmed = platformChatId.trim();
  if (!trimmed) return "unknown";
  const threadSeparator = trimmed.indexOf("#");
  if (threadSeparator !== -1) {
    const baseChatId = trimmed.slice(0, threadSeparator);
    const threadId = trimmed
      .slice(threadSeparator + 1)
      .trim()
      .toLowerCase();
    const baseType =
      chatType === "thread" || chatType === "unknown" || !chatType ? inferChatType(baseChatId, undefined) : chatType;
    const normalizedBase = normalizeChatIdentity(channel, baseChatId, baseType);
    return threadId ? `${normalizedBase}#${threadId}` : normalizedBase;
  }
  if (channel === "whatsapp") {
    const normalized = normalizePhone(trimmed);
    if (chatType === "group" || normalized.startsWith("group:") || trimmed.endsWith("@g.us")) {
      return normalized.startsWith("group:") ? normalized : `group:${normalized}`;
    }
    return normalized || trimmed.toLowerCase();
  }
  return trimmed.toLowerCase();
}

export function dbContactDmNormalizedChatId(contactId: string): string {
  const trimmed = contactId.trim();
  if (!trimmed) throw new Error("contactId is required to canonicalize a DM chat");
  return `contact:${trimmed}`;
}

function inferChatType(platformChatId: string, explicit?: ChatType | null): ChatType {
  if (explicit && explicit !== "unknown") return explicit;
  if (platformChatId.includes("#")) return "thread";
  if (platformChatId.endsWith("@g.us") || platformChatId.startsWith("group:")) return "group";
  return "dm";
}

function rowToChat(row: ChatRow): ChatRecord {
  return {
    id: row.id,
    channel: row.channel,
    instanceId: row.instance_id,
    platformChatId: row.platform_chat_id,
    normalizedChatId: row.normalized_chat_id,
    chatType: row.chat_type as ChatType,
    title: row.title ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    metadata: parseJsonRecord(row.metadata_json),
    rawProvenance: parseJsonRecord(row.raw_provenance_json),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToChatParticipant(row: ChatParticipantRow): ChatParticipantRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    participantType: inferChatParticipantType({
      contactId: row.contact_id,
      agentId: row.agent_id,
    }),
    platformIdentityId: row.platform_identity_id ?? undefined,
    contactId: row.contact_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    rawPlatformUserId: row.raw_platform_user_id ?? undefined,
    normalizedPlatformUserId: row.normalized_platform_user_id ?? undefined,
    role: row.role,
    status: row.status,
    source: row.source,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToChatMessage(row: ChatMessageRow): ChatMessageRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    channel: row.channel,
    instanceId: row.instance_id,
    providerMessageId: row.provider_message_id,
    rawChatId: row.raw_chat_id,
    rawSenderId: row.raw_sender_id ?? undefined,
    normalizedSenderId: row.normalized_sender_id ?? undefined,
    actorType: row.actor_type,
    contactId: row.contact_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    platformIdentityId: row.platform_identity_id ?? undefined,
    messageType: row.message_type ?? undefined,
    content: parseJsonRecord(row.content_json),
    rawProvenance: parseJsonRecord(row.raw_provenance_json),
    providerTimestamp: row.provider_timestamp ?? undefined,
    editedAt: row.edited_at ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    ingestedAt: row.ingested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chatMessageSortKey(row: Pick<ChatMessageRow, "id" | "provider_timestamp" | "ingested_at">): string {
  const primary = String(row.provider_timestamp ?? row.ingested_at).padStart(13, "0");
  const ingested = String(row.ingested_at).padStart(13, "0");
  return `${primary}:${ingested}:${row.id}`;
}

function rowToChatMessageWithSortKey(row: ChatMessageWithSortKeyRow): ChatMessageWithSortKey {
  return {
    ...rowToChatMessage(row),
    sortKey: row.message_sort_key || chatMessageSortKey(row),
  };
}

function parsePositiveIntegerOption(value: number | string | null | undefined, optionName: string): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function rawPayloadRecord(rawProvenance: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const rawPayload = rawProvenance?.rawPayload;
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return undefined;
  return rawPayload as Record<string, unknown>;
}

function providerTimestampFromRawProvenance(rawProvenanceJson: string | null): number | undefined {
  const rawPayload = rawPayloadRecord(parseJsonRecord(rawProvenanceJson));
  return timestampLikeToMs(rawPayload?.messageTimestamp);
}

function rowToChatReadingList(row: ChatReadingListRow): ChatReadingListRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    visibility: row.visibility,
    mode: row.mode,
    selector: parseJsonRecord(row.selector_json),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function rowToChatReadingListMember(row: ChatReadingListMemberRow): ChatReadingListMemberRecord {
  return {
    id: row.id,
    listId: row.list_id,
    chatId: row.chat_id,
    source: row.source,
    reason: row.reason ?? undefined,
    priority: row.priority,
    metadata: parseJsonRecord(row.metadata_json),
    addedAt: row.added_at,
    removedAt: row.removed_at ?? undefined,
  };
}

function rowToChatReadingCursor(row: ChatReadingCursorRow): ChatReadingCursorRecord {
  return {
    id: row.id,
    listId: row.list_id,
    chatId: row.chat_id,
    readerType: row.reader_type,
    readerId: row.reader_id,
    lastReadMessageId: row.last_read_message_id ?? undefined,
    lastReadMessageSortKey: row.last_read_message_sort_key ?? undefined,
    lastReadEventId: row.last_read_event_id ?? undefined,
    lastReadEventSortKey: row.last_read_event_sort_key ?? undefined,
    lastReadAt: row.last_read_at ?? undefined,
    readReason: row.read_reason ?? undefined,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSessionChatBinding(row: SessionChatBindingRow): SessionChatBindingRecord {
  return {
    sessionKey: row.session_key,
    chatId: row.chat_id,
    agentId: row.agent_id ?? undefined,
    routeId: row.route_id ?? undefined,
    bindingReason: row.binding_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSessionParticipant(row: SessionParticipantRow): SessionParticipantRecord {
  return {
    id: row.id,
    sessionKey: row.session_key,
    ownerType: row.owner_type as SessionParticipantOwnerType,
    ownerId: row.owner_id ?? undefined,
    platformIdentityId: row.platform_identity_id ?? undefined,
    role: row.role,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    messageCount: row.message_count,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function upsertChat(database: Database, input: UpsertChatInput): ChatRecord {
  const now = input.seenAt ?? Date.now();
  const channel = normalizeChannelId(input.channel);
  const instanceId = input.instanceId?.trim() ?? "";
  const chatType = inferChatType(input.platformChatId, input.chatType);
  const existingByPlatform = findChatByPlatformOrAlias(database, channel, instanceId, input.platformChatId);
  const normalizedChatId =
    existingByPlatform?.normalized_chat_id ||
    input.normalizedChatId?.trim() ||
    normalizeChatIdentity(channel, input.platformChatId, chatType);
  const id = semanticId("chat", [channel, instanceId, normalizedChatId]);

  database
    .prepare(
      `
      INSERT INTO chats (
        id, channel, instance_id, platform_chat_id, normalized_chat_id, chat_type,
        title, avatar_url, metadata_json, raw_provenance_json,
        first_seen_at, last_seen_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel, instance_id, normalized_chat_id) DO UPDATE SET
        platform_chat_id = excluded.platform_chat_id,
        chat_type = excluded.chat_type,
        title = COALESCE(excluded.title, chats.title),
        avatar_url = COALESCE(excluded.avatar_url, chats.avatar_url),
        metadata_json = COALESCE(excluded.metadata_json, chats.metadata_json),
        raw_provenance_json = COALESCE(excluded.raw_provenance_json, chats.raw_provenance_json),
        last_seen_at = MAX(chats.last_seen_at, excluded.last_seen_at),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      id,
      channel,
      instanceId,
      input.platformChatId,
      normalizedChatId,
      chatType,
      input.title ?? null,
      input.avatarUrl ?? null,
      cleanJsonRecord(input.metadata),
      cleanJsonRecord(input.rawProvenance),
      now,
      now,
      now,
      now,
    );

  const row = database
    .prepare("SELECT * FROM chats WHERE channel = ? AND instance_id = ? AND normalized_chat_id = ?")
    .get(channel, instanceId, normalizedChatId) as ChatRow;
  return rowToChat(row);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function chatPlatformAliases(row: ChatRow): string[] {
  const provenance = parseJsonRecord(row.raw_provenance_json);
  const canonicalization =
    provenance?.canonicalization && typeof provenance.canonicalization === "object"
      ? (provenance.canonicalization as Record<string, unknown>)
      : {};
  const platformChatIds = Array.isArray(canonicalization.platformChatIds)
    ? canonicalization.platformChatIds.filter((value): value is string => typeof value === "string")
    : [];
  return uniqueStrings([row.platform_chat_id, ...platformChatIds]);
}

function findChatByPlatformOrAlias(
  database: Database,
  channel: string,
  instanceId: string,
  platformChatId: string,
): ChatRow | undefined {
  const exact = database
    .prepare("SELECT * FROM chats WHERE channel = ? AND instance_id = ? AND platform_chat_id = ?")
    .get(channel, instanceId, platformChatId) as ChatRow | undefined;
  if (exact) return exact;

  const rows = database
    .prepare("SELECT * FROM chats WHERE channel = ? AND instance_id = ? AND raw_provenance_json IS NOT NULL")
    .all(channel, instanceId) as ChatRow[];
  return rows.find((row) => chatPlatformAliases(row).includes(platformChatId));
}

function mergeChatCanonicalizationProvenance(
  target: ChatRow,
  source: ChatRow | null,
  input: CanonicalizeDmChatForContactInput,
): Record<string, unknown> {
  const existingTarget = parseJsonRecord(target.raw_provenance_json) ?? {};
  const existingSource = source ? (parseJsonRecord(source.raw_provenance_json) ?? {}) : {};
  const existingCanonicalization =
    existingTarget.canonicalization && typeof existingTarget.canonicalization === "object"
      ? (existingTarget.canonicalization as Record<string, unknown>)
      : {};
  const previousPlatformChatIds = Array.isArray(existingCanonicalization.platformChatIds)
    ? existingCanonicalization.platformChatIds.filter((value): value is string => typeof value === "string")
    : [];
  const previousMergedChatIds = Array.isArray(existingCanonicalization.mergedChatIds)
    ? existingCanonicalization.mergedChatIds.filter((value): value is string => typeof value === "string")
    : [];
  return mergeJsonRecords(existingSource, existingTarget, input.rawProvenance ?? undefined, {
    canonicalization: {
      ...existingCanonicalization,
      source: "contact_dm",
      contactId: input.contactId,
      platformChatIds: uniqueStrings([
        ...previousPlatformChatIds,
        target.platform_chat_id,
        source?.platform_chat_id,
        input.platformChatId,
      ]),
      mergedChatIds: uniqueStrings([
        ...previousMergedChatIds,
        source?.id && source.id !== target.id ? source.id : null,
      ]),
    },
  })!;
}

function mergeChatMessagesIntoTarget(
  database: Database,
  sourceChatId: string,
  targetChatId: string,
  now: number,
): void {
  const rows = database.prepare("SELECT * FROM chat_messages WHERE chat_id = ?").all(sourceChatId) as ChatMessageRow[];
  for (const row of rows) {
    const existing = database
      .prepare(
        `
        SELECT *
        FROM chat_messages
        WHERE channel = ? AND instance_id = ? AND chat_id = ? AND provider_message_id = ?
      `,
      )
      .get(row.channel, row.instance_id, targetChatId, row.provider_message_id) as ChatMessageRow | undefined;
    if (!existing) {
      database
        .prepare("UPDATE chat_messages SET chat_id = ?, updated_at = ? WHERE id = ?")
        .run(targetChatId, now, row.id);
      continue;
    }
    const mergedProvenance = mergeJsonRecords(
      parseJsonRecord(existing.raw_provenance_json),
      parseJsonRecord(row.raw_provenance_json),
      { mergedFromChatId: sourceChatId },
    );
    database
      .prepare(
        `
        UPDATE chat_messages
        SET raw_sender_id = COALESCE(raw_sender_id, ?),
            normalized_sender_id = COALESCE(normalized_sender_id, ?),
            actor_type = CASE WHEN actor_type = 'unknown' AND ? != 'unknown' THEN ? ELSE actor_type END,
            contact_id = COALESCE(contact_id, ?),
            agent_id = COALESCE(agent_id, ?),
            platform_identity_id = COALESCE(platform_identity_id, ?),
            message_type = COALESCE(message_type, ?),
            content_json = COALESCE(content_json, ?),
            raw_provenance_json = COALESCE(?, raw_provenance_json),
            provider_timestamp = COALESCE(provider_timestamp, ?),
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        row.raw_sender_id,
        row.normalized_sender_id,
        row.actor_type,
        row.actor_type,
        row.contact_id,
        row.agent_id,
        row.platform_identity_id,
        row.message_type,
        row.content_json,
        cleanJsonRecord(mergedProvenance),
        row.provider_timestamp,
        now,
        existing.id,
      );
    database.prepare("DELETE FROM chat_messages WHERE id = ?").run(row.id);
  }
}

function mergeChatParticipantsIntoTarget(
  database: Database,
  sourceChatId: string,
  targetChatId: string,
  now: number,
): void {
  const rows = database
    .prepare("SELECT * FROM chat_participants WHERE chat_id = ?")
    .all(sourceChatId) as ChatParticipantRow[];
  for (const row of rows) {
    upsertChatParticipant(database, {
      chatId: targetChatId,
      platformIdentityId: row.platform_identity_id,
      contactId: row.contact_id,
      agentId: row.agent_id,
      rawPlatformUserId: row.raw_platform_user_id,
      normalizedPlatformUserId: row.normalized_platform_user_id ?? undefined,
      role: row.role,
      status: row.status,
      source: row.source,
      metadata: mergeJsonRecords(parseJsonRecord(row.metadata_json), {
        canonicalizedFromChatId: sourceChatId,
      }),
      seenAt: Math.max(row.last_seen_at, now),
    });
    database.prepare("DELETE FROM chat_participants WHERE id = ?").run(row.id);
  }
}

function mergeSessionChatBindingsIntoTarget(database: Database, sourceChatId: string, targetChatId: string): void {
  const rows = database
    .prepare("SELECT session_key FROM session_chat_bindings WHERE chat_id = ?")
    .all(sourceChatId) as Array<{ session_key: string }>;
  for (const row of rows) {
    const existing = database
      .prepare("SELECT 1 FROM session_chat_bindings WHERE session_key = ? AND chat_id = ?")
      .get(row.session_key, targetChatId);
    if (existing) {
      database
        .prepare("DELETE FROM session_chat_bindings WHERE session_key = ? AND chat_id = ?")
        .run(row.session_key, sourceChatId);
    } else {
      database
        .prepare("UPDATE session_chat_bindings SET chat_id = ? WHERE session_key = ? AND chat_id = ?")
        .run(targetChatId, row.session_key, sourceChatId);
    }
  }
}

function mergeSessionChatSubscriptionsIntoTarget(
  database: Database,
  sourceChatId: string,
  targetChatId: string,
  now: number,
): void {
  const rows = database
    .prepare("SELECT id, session_key, detached_at FROM session_chat_subscriptions WHERE chat_id = ?")
    .all(sourceChatId) as Array<{
    id: number;
    session_key: string;
    detached_at: number | null;
  }>;
  for (const row of rows) {
    const activeTarget = database
      .prepare("SELECT 1 FROM session_chat_subscriptions WHERE chat_id = ? AND detached_at IS NULL")
      .get(targetChatId);
    const activePair = database
      .prepare("SELECT 1 FROM session_chat_subscriptions WHERE session_key = ? AND chat_id = ? AND detached_at IS NULL")
      .get(row.session_key, targetChatId);
    if (row.detached_at === null && (activeTarget || activePair)) {
      database
        .prepare("UPDATE session_chat_subscriptions SET detached_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, row.id);
      continue;
    }
    database
      .prepare("UPDATE session_chat_subscriptions SET chat_id = ?, updated_at = ? WHERE id = ?")
      .run(targetChatId, now, row.id);
  }
}

function mergeReadingListMembersIntoTarget(
  database: Database,
  sourceChatId: string,
  targetChatId: string,
  now: number,
): void {
  const rows = database
    .prepare("SELECT id, list_id, removed_at FROM chat_reading_list_members WHERE chat_id = ?")
    .all(sourceChatId) as Array<{
    id: string;
    list_id: string;
    removed_at: number | null;
  }>;
  for (const row of rows) {
    const activeTarget = database
      .prepare("SELECT 1 FROM chat_reading_list_members WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL")
      .get(row.list_id, targetChatId);
    if (row.removed_at === null && activeTarget) {
      database.prepare("UPDATE chat_reading_list_members SET removed_at = ? WHERE id = ?").run(now, row.id);
    } else {
      database.prepare("UPDATE chat_reading_list_members SET chat_id = ? WHERE id = ?").run(targetChatId, row.id);
    }
  }
}

function mergeReadingCursorsIntoTarget(
  database: Database,
  sourceChatId: string,
  targetChatId: string,
  now: number,
): void {
  const rows = database.prepare("SELECT * FROM chat_reading_cursors WHERE chat_id = ?").all(sourceChatId) as Array<{
    id: string;
    list_id: string;
    reader_type: string;
    reader_id: string;
    last_read_message_id: string | null;
    last_read_message_sort_key: string | null;
    last_read_event_id: string | null;
    last_read_event_sort_key: string | null;
    last_read_at: number | null;
    read_reason: string | null;
    metadata_json: string | null;
    updated_at: number;
  }>;
  for (const row of rows) {
    const existing = database
      .prepare(
        `
        SELECT id, updated_at
        FROM chat_reading_cursors
        WHERE list_id = ? AND chat_id = ? AND reader_type = ? AND reader_id = ?
      `,
      )
      .get(row.list_id, targetChatId, row.reader_type, row.reader_id) as { id: string; updated_at: number } | undefined;
    if (!existing) {
      database
        .prepare("UPDATE chat_reading_cursors SET chat_id = ?, updated_at = ? WHERE id = ?")
        .run(targetChatId, now, row.id);
      continue;
    }
    if (row.updated_at > existing.updated_at) {
      database
        .prepare(
          `
          UPDATE chat_reading_cursors
          SET last_read_message_id = ?,
              last_read_message_sort_key = ?,
              last_read_event_id = ?,
              last_read_event_sort_key = ?,
              last_read_at = ?,
              read_reason = ?,
              metadata_json = ?,
              updated_at = ?
          WHERE id = ?
        `,
        )
        .run(
          row.last_read_message_id,
          row.last_read_message_sort_key,
          row.last_read_event_id,
          row.last_read_event_sort_key,
          row.last_read_at,
          row.read_reason,
          row.metadata_json,
          now,
          existing.id,
        );
    }
    database.prepare("DELETE FROM chat_reading_cursors WHERE id = ?").run(row.id);
  }
  database
    .prepare("UPDATE chat_reading_cursor_events SET chat_id = ? WHERE chat_id = ?")
    .run(targetChatId, sourceChatId);
}

function canonicalizeDmChatForContact(database: Database, input: CanonicalizeDmChatForContactInput): ChatRecord {
  const contactId = input.contactId.trim();
  if (!contactId) throw new Error("contactId is required to canonicalize a DM chat");
  const source = database.prepare("SELECT * FROM chats WHERE id = ?").get(input.chatId) as ChatRow | undefined;
  if (!source) throw new Error(`Chat not found: ${input.chatId}`);
  if (source.chat_type !== "dm") return rowToChat(source);

  const now = input.seenAt ?? Date.now();
  const normalizedChatId = dbContactDmNormalizedChatId(contactId);
  const target = database
    .prepare("SELECT * FROM chats WHERE channel = ? AND instance_id = ? AND normalized_chat_id = ?")
    .get(source.channel, source.instance_id, normalizedChatId) as ChatRow | undefined;
  const targetRow = target ?? source;
  const rawProvenance = mergeChatCanonicalizationProvenance(targetRow, target ? source : null, input);

  if (!target || target.id === source.id) {
    database
      .prepare(
        `
        UPDATE chats
        SET normalized_chat_id = ?,
            platform_chat_id = COALESCE(?, platform_chat_id),
            title = COALESCE(?, title),
            avatar_url = COALESCE(?, avatar_url),
            raw_provenance_json = ?,
            last_seen_at = MAX(last_seen_at, ?),
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        normalizedChatId,
        input.platformChatId ?? null,
        input.title ?? null,
        input.avatarUrl ?? null,
        cleanJsonRecord(rawProvenance),
        now,
        now,
        source.id,
      );
    const row = database.prepare("SELECT * FROM chats WHERE id = ?").get(source.id) as ChatRow;
    return rowToChat(row);
  }

  mergeChatMessagesIntoTarget(database, source.id, target.id, now);
  mergeChatParticipantsIntoTarget(database, source.id, target.id, now);
  mergeSessionChatBindingsIntoTarget(database, source.id, target.id);
  mergeSessionChatSubscriptionsIntoTarget(database, source.id, target.id, now);
  mergeReadingListMembersIntoTarget(database, source.id, target.id, now);
  mergeReadingCursorsIntoTarget(database, source.id, target.id, now);

  database
    .prepare("UPDATE message_metadata SET canonical_chat_id = ? WHERE canonical_chat_id = ?")
    .run(target.id, source.id);
  database
    .prepare("UPDATE session_events SET canonical_chat_id = ? WHERE canonical_chat_id = ?")
    .run(target.id, source.id);
  database
    .prepare(
      `
      UPDATE chats
      SET platform_chat_id = COALESCE(?, platform_chat_id),
          title = COALESCE(?, title),
          avatar_url = COALESCE(?, avatar_url),
          raw_provenance_json = ?,
          first_seen_at = MIN(first_seen_at, ?),
          last_seen_at = MAX(last_seen_at, ?),
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      input.platformChatId ?? source.platform_chat_id,
      input.title ?? source.title,
      input.avatarUrl ?? source.avatar_url,
      cleanJsonRecord(rawProvenance),
      source.first_seen_at,
      Math.max(source.last_seen_at, now),
      now,
      target.id,
    );
  database.prepare("DELETE FROM chats WHERE id = ?").run(source.id);

  const row = database.prepare("SELECT * FROM chats WHERE id = ?").get(target.id) as ChatRow;
  return rowToChat(row);
}

function normalizedParticipantId(input: UpsertChatParticipantInput): string | null {
  const explicit = input.normalizedPlatformUserId?.trim();
  if (explicit) return explicit;
  const raw = input.rawPlatformUserId?.trim();
  if (!raw) return null;
  return normalizePhone(raw) || raw.toLowerCase();
}

function inferChatParticipantType(input: { contactId?: string | null; agentId?: string | null }): ChatParticipantType {
  if (input.agentId) return "agent";
  if (input.contactId) return "contact";
  return "raw";
}

function validateChatParticipantInput(input: UpsertChatParticipantInput): void {
  if (input.contactId && input.agentId) {
    throw new Error("Chat participant cannot be both contact and agent");
  }
}

function chatParticipantSemanticParts(
  input: UpsertChatParticipantInput,
  normalized: string | null,
): Array<string | null | undefined> {
  if (input.agentId) return [input.chatId, "agent", input.agentId];
  if (input.contactId) return [input.chatId, "contact", input.contactId];
  if (input.platformIdentityId) return [input.chatId, "platform", input.platformIdentityId];
  return [input.chatId, "raw", normalized];
}

interface ExistingChatParticipantMatches {
  semantic?: string;
  contact?: string;
  agent?: string;
  platform?: string;
  raw?: string;
  all: string[];
}

function pushChatParticipantMatch(
  matches: ExistingChatParticipantMatches,
  kind: keyof Omit<ExistingChatParticipantMatches, "all">,
  id: string | undefined,
): void {
  if (!id) return;
  matches[kind] ??= id;
  if (!matches.all.includes(id)) {
    matches.all.push(id);
  }
}

function findExistingChatParticipantMatches(
  database: Database,
  input: UpsertChatParticipantInput,
  normalized: string | null,
  semanticParticipantId: string,
): ExistingChatParticipantMatches {
  const matches: ExistingChatParticipantMatches = { all: [] };
  const byId = database.prepare("SELECT id FROM chat_participants WHERE id = ?").get(semanticParticipantId) as
    | { id: string }
    | undefined;
  pushChatParticipantMatch(matches, "semantic", byId?.id);

  if (input.contactId) {
    const row = database
      .prepare("SELECT id FROM chat_participants WHERE chat_id = ? AND contact_id = ?")
      .get(input.chatId, input.contactId) as { id: string } | undefined;
    pushChatParticipantMatch(matches, "contact", row?.id);
  }

  if (input.agentId) {
    const row = database
      .prepare("SELECT id FROM chat_participants WHERE chat_id = ? AND agent_id = ?")
      .get(input.chatId, input.agentId) as { id: string } | undefined;
    pushChatParticipantMatch(matches, "agent", row?.id);
  }

  if (input.platformIdentityId) {
    const row = database
      .prepare("SELECT id FROM chat_participants WHERE chat_id = ? AND platform_identity_id = ?")
      .get(input.chatId, input.platformIdentityId) as { id: string } | undefined;
    pushChatParticipantMatch(matches, "platform", row?.id);
  }

  if (normalized) {
    const row = database
      .prepare(
        `
        SELECT id
        FROM chat_participants
        WHERE chat_id = ?
          AND normalized_platform_user_id = ?
          AND platform_identity_id IS NULL
          AND contact_id IS NULL
          AND agent_id IS NULL
      `,
      )
      .get(input.chatId, normalized) as { id: string } | undefined;
    pushChatParticipantMatch(matches, "raw", row?.id);
  }

  return matches;
}

function listChatParticipantsByIds(database: Database, ids: string[]): ChatParticipantRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return database
    .prepare(`SELECT * FROM chat_participants WHERE id IN (${placeholders})`)
    .all(...ids) as ChatParticipantRow[];
}

function upsertChatParticipant(database: Database, input: UpsertChatParticipantInput): ChatParticipantRecord {
  validateChatParticipantInput(input);
  const now = input.seenAt ?? Date.now();
  const normalized = normalizedParticipantId(input);
  const semanticParticipantId = semanticId("cp", chatParticipantSemanticParts(input, normalized));
  const matches = findExistingChatParticipantMatches(database, input, normalized, semanticParticipantId);
  const id =
    matches.semantic ?? matches.agent ?? matches.contact ?? matches.platform ?? matches.raw ?? semanticParticipantId;
  const mergedRows = listChatParticipantsByIds(database, matches.all);
  const duplicateIds = matches.all.filter((existingId) => existingId !== id);
  const firstSeenAt = Math.min(now, ...mergedRows.map((row) => row.first_seen_at));
  const lastSeenAt = Math.max(now, ...mergedRows.map((row) => row.last_seen_at));
  const mergedMetadata = mergeJsonRecords(
    ...mergedRows.map((row) => parseJsonRecord(row.metadata_json)),
    input.metadata ?? undefined,
  );

  if (duplicateIds.length > 0) {
    const placeholders = duplicateIds.map(() => "?").join(", ");
    database.prepare(`DELETE FROM chat_participants WHERE id IN (${placeholders})`).run(...duplicateIds);
  }

  database
    .prepare(
      `
      INSERT INTO chat_participants (
        id, chat_id, platform_identity_id, contact_id, agent_id,
        raw_platform_user_id, normalized_platform_user_id, role, status, source,
        first_seen_at, last_seen_at, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        platform_identity_id = COALESCE(excluded.platform_identity_id, chat_participants.platform_identity_id),
        contact_id = COALESCE(excluded.contact_id, chat_participants.contact_id),
        agent_id = COALESCE(excluded.agent_id, chat_participants.agent_id),
        raw_platform_user_id = COALESCE(excluded.raw_platform_user_id, chat_participants.raw_platform_user_id),
        normalized_platform_user_id = COALESCE(excluded.normalized_platform_user_id, chat_participants.normalized_platform_user_id),
        role = CASE WHEN excluded.role != 'unknown' THEN excluded.role ELSE chat_participants.role END,
        status = excluded.status,
        source = excluded.source,
        first_seen_at = MIN(chat_participants.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(chat_participants.last_seen_at, excluded.last_seen_at),
        metadata_json = COALESCE(excluded.metadata_json, chat_participants.metadata_json),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      id,
      input.chatId,
      input.platformIdentityId ?? null,
      input.contactId ?? null,
      input.agentId ?? null,
      input.rawPlatformUserId ?? null,
      normalized,
      input.role ?? "unknown",
      input.status ?? "active",
      input.source ?? "unknown",
      firstSeenAt,
      lastSeenAt,
      cleanJsonRecord(mergedMetadata),
      now,
      now,
    );

  const row = database.prepare("SELECT * FROM chat_participants WHERE id = ?").get(id) as ChatParticipantRow;
  return rowToChatParticipant(row);
}

function upsertChatMessage(database: Database, input: UpsertChatMessageInput): UpsertChatMessageResult {
  const channel = normalizeChannelId(input.channel);
  const instanceId = input.instanceId?.trim() ?? "";
  const providerMessageId =
    input.providerMessageId?.trim() ||
    semanticId("provider_message", [
      channel,
      instanceId,
      input.chatId,
      input.rawChatId,
      input.rawSenderId ?? null,
      String(input.providerTimestamp ?? input.ingestedAt ?? Date.now()),
    ]);
  const existing = database
    .prepare(
      `
      SELECT id FROM chat_messages
      WHERE channel = ? AND instance_id = ? AND chat_id = ? AND provider_message_id = ?
    `,
    )
    .get(channel, instanceId, input.chatId, providerMessageId) as { id: string } | undefined;
  const now = input.ingestedAt ?? Date.now();
  const id = existing?.id ?? semanticId("cm", [channel, instanceId, input.chatId, providerMessageId]);

  database
    .prepare(
      `
      INSERT INTO chat_messages (
        id, chat_id, channel, instance_id, provider_message_id, raw_chat_id,
        raw_sender_id, normalized_sender_id, actor_type, contact_id, agent_id, platform_identity_id,
        message_type, content_json, raw_provenance_json, provider_timestamp,
        edited_at, deleted_at, ingested_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel, instance_id, chat_id, provider_message_id) DO UPDATE SET
        raw_sender_id = COALESCE(excluded.raw_sender_id, chat_messages.raw_sender_id),
        normalized_sender_id = COALESCE(excluded.normalized_sender_id, chat_messages.normalized_sender_id),
        actor_type = CASE
          WHEN excluded.actor_type != 'unknown' THEN excluded.actor_type
          ELSE chat_messages.actor_type
        END,
        contact_id = COALESCE(excluded.contact_id, chat_messages.contact_id),
        agent_id = COALESCE(excluded.agent_id, chat_messages.agent_id),
        platform_identity_id = COALESCE(excluded.platform_identity_id, chat_messages.platform_identity_id),
        message_type = COALESCE(excluded.message_type, chat_messages.message_type),
        content_json = COALESCE(excluded.content_json, chat_messages.content_json),
        raw_provenance_json = COALESCE(excluded.raw_provenance_json, chat_messages.raw_provenance_json),
        provider_timestamp = COALESCE(excluded.provider_timestamp, chat_messages.provider_timestamp),
        edited_at = COALESCE(excluded.edited_at, chat_messages.edited_at),
        deleted_at = COALESCE(excluded.deleted_at, chat_messages.deleted_at),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      id,
      input.chatId,
      channel,
      instanceId,
      providerMessageId,
      input.rawChatId,
      input.rawSenderId ?? null,
      input.normalizedSenderId ?? null,
      input.actorType ?? "unknown",
      input.contactId ?? null,
      input.agentId ?? null,
      input.platformIdentityId ?? null,
      input.messageType ?? null,
      cleanJsonRecord(input.content),
      cleanJsonRecord(input.rawProvenance),
      input.providerTimestamp ?? null,
      input.editedAt ?? null,
      input.deletedAt ?? null,
      now,
      now,
      now,
    );

  const row = database.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as ChatMessageRow;
  return { message: rowToChatMessage(row), created: !existing };
}

function bindSessionToChat(
  database: Database,
  input: {
    sessionKey: string;
    chatId: string;
    agentId?: string | null;
    routeId?: number | null;
    bindingReason?: string | null;
    seenAt?: number;
  },
): SessionChatBindingRecord {
  const now = input.seenAt ?? Date.now();
  database
    .prepare(
      `
      INSERT INTO session_chat_bindings (
        session_key, chat_id, agent_id, route_id, binding_reason, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        chat_id = excluded.chat_id,
        agent_id = COALESCE(excluded.agent_id, session_chat_bindings.agent_id),
        route_id = COALESCE(excluded.route_id, session_chat_bindings.route_id),
        binding_reason = COALESCE(excluded.binding_reason, session_chat_bindings.binding_reason),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      input.sessionKey,
      input.chatId,
      input.agentId ?? null,
      input.routeId ?? null,
      input.bindingReason ?? null,
      now,
      now,
    );

  const row = database.prepare("SELECT * FROM session_chat_bindings WHERE session_key = ?").get(input.sessionKey) as
    | SessionChatBindingRow
    | undefined;
  if (!row) throw new Error(`Session chat binding not found after upsert: ${input.sessionKey}`);
  return rowToSessionChatBinding(row);
}

interface ExistingSessionParticipantMatches {
  semantic?: string;
  owner?: string;
  platform?: string;
  all: string[];
}

function pushSessionParticipantMatch(
  matches: ExistingSessionParticipantMatches,
  kind: keyof Omit<ExistingSessionParticipantMatches, "all">,
  id: string | undefined,
): void {
  if (!id) return;
  matches[kind] ??= id;
  if (!matches.all.includes(id)) {
    matches.all.push(id);
  }
}

function findExistingSessionParticipantMatches(
  database: Database,
  input: UpsertSessionParticipantInput,
  ownerType: SessionParticipantOwnerType,
  semanticParticipantId: string,
): ExistingSessionParticipantMatches {
  const matches: ExistingSessionParticipantMatches = { all: [] };
  const byId = database.prepare("SELECT id FROM session_participants WHERE id = ?").get(semanticParticipantId) as
    | { id: string }
    | undefined;
  pushSessionParticipantMatch(matches, "semantic", byId?.id);

  if (input.ownerId) {
    const row = database
      .prepare("SELECT id FROM session_participants WHERE session_key = ? AND owner_type = ? AND owner_id = ?")
      .get(input.sessionKey, ownerType, input.ownerId) as { id: string } | undefined;
    pushSessionParticipantMatch(matches, "owner", row?.id);
  }

  if (input.platformIdentityId) {
    const row = database
      .prepare("SELECT id FROM session_participants WHERE session_key = ? AND platform_identity_id = ?")
      .get(input.sessionKey, input.platformIdentityId) as { id: string } | undefined;
    pushSessionParticipantMatch(matches, "platform", row?.id);
  }

  return matches;
}

function listSessionParticipantsByIds(database: Database, ids: string[]): SessionParticipantRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return database
    .prepare(`SELECT * FROM session_participants WHERE id IN (${placeholders})`)
    .all(...ids) as SessionParticipantRow[];
}

function upsertSessionParticipant(database: Database, input: UpsertSessionParticipantInput): SessionParticipantRecord {
  const now = input.seenAt ?? Date.now();
  const ownerType = input.ownerType ?? (input.ownerId ? "contact" : "unknown");
  const semanticParticipantId = semanticId("sp", [
    input.sessionKey,
    ownerType,
    input.ownerId,
    input.platformIdentityId,
  ]);
  const matches = findExistingSessionParticipantMatches(database, input, ownerType, semanticParticipantId);
  const id = matches.semantic ?? matches.owner ?? matches.platform ?? semanticParticipantId;
  const mergedRows = listSessionParticipantsByIds(database, matches.all);
  const duplicateIds = matches.all.filter((existingId) => existingId !== id);
  const increment = input.incrementMessageCount === false ? 0 : 1;
  const firstSeenAt = Math.min(now, ...mergedRows.map((row) => row.first_seen_at));
  const lastSeenAt = Math.max(now, ...mergedRows.map((row) => row.last_seen_at));
  const messageCount = mergedRows.reduce((total, row) => total + row.message_count, 0) + increment;
  const mergedMetadata = mergeJsonRecords(
    ...mergedRows.map((row) => parseJsonRecord(row.metadata_json)),
    input.metadata ?? undefined,
  );

  if (duplicateIds.length > 0) {
    const placeholders = duplicateIds.map(() => "?").join(", ");
    database.prepare(`DELETE FROM session_participants WHERE id IN (${placeholders})`).run(...duplicateIds);
  }

  database
    .prepare(
      `
      INSERT INTO session_participants (
        id, session_key, owner_type, owner_id, platform_identity_id, role,
        first_seen_at, last_seen_at, message_count, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_type = CASE WHEN excluded.owner_type != 'unknown' THEN excluded.owner_type ELSE session_participants.owner_type END,
        owner_id = COALESCE(excluded.owner_id, session_participants.owner_id),
        platform_identity_id = COALESCE(excluded.platform_identity_id, session_participants.platform_identity_id),
        role = CASE WHEN excluded.role != 'unknown' THEN excluded.role ELSE session_participants.role END,
        first_seen_at = MIN(session_participants.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(session_participants.last_seen_at, excluded.last_seen_at),
        message_count = excluded.message_count,
        metadata_json = COALESCE(excluded.metadata_json, session_participants.metadata_json),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      id,
      input.sessionKey,
      ownerType,
      input.ownerId ?? null,
      input.platformIdentityId ?? null,
      input.role ?? "unknown",
      firstSeenAt,
      lastSeenAt,
      messageCount,
      cleanJsonRecord(mergedMetadata),
      now,
      now,
    );

  const row = database.prepare("SELECT * FROM session_participants WHERE id = ?").get(id) as SessionParticipantRow;
  return rowToSessionParticipant(row);
}

function backfillChatModel(database: Database): void {
  const now = Date.now();
  executeWrite(
    database,
    (database) => {
      const groupRows = database.prepare("SELECT * FROM omni_group_metadata").all() as Array<{
        account_id: string;
        instance_id: string;
        chat_id: string;
        chat_uuid: string | null;
        external_id: string | null;
        channel: string | null;
        name: string | null;
        avatar_url: string | null;
        participant_count: number | null;
        participants_json: string | null;
        platform_metadata_json: string | null;
        fetched_at: number;
      }>;

      for (const row of groupRows) {
        const chat = upsertChat(database, {
          channel: row.channel ?? "whatsapp",
          instanceId: row.instance_id,
          platformChatId: row.chat_id,
          chatType: "group",
          title: row.name,
          avatarUrl: row.avatar_url,
          metadata: {
            accountId: row.account_id,
            chatUuid: row.chat_uuid,
            externalId: row.external_id,
            participantCount: row.participant_count,
          },
          rawProvenance: {
            sourceTable: "omni_group_metadata",
            accountId: row.account_id,
            instanceId: row.instance_id,
            chatId: row.chat_id,
            chatUuid: row.chat_uuid,
            externalId: row.external_id,
            platformMetadata: parseJsonRecord(row.platform_metadata_json),
          },
          seenAt: row.fetched_at || now,
        });

        const participants = parseParticipantsJson(row.participants_json);
        for (const participant of participants) {
          upsertChatParticipant(database, {
            chatId: chat.id,
            rawPlatformUserId: participant.platformUserId,
            normalizedPlatformUserId: normalizePhone(participant.platformUserId) || participant.platformUserId,
            role: normalizeParticipantRole(participant.role),
            status: "active",
            source: "omni",
            metadata: {
              omniParticipantId: participant.id ?? null,
              displayName: participant.displayName ?? null,
            },
            seenAt: row.fetched_at || now,
          });
        }
      }

      const sessionRows = database
        .prepare(
          `
        SELECT session_key, agent_id, channel, account_id, group_id, last_channel, last_account_id,
               last_to, last_thread_id, chat_type, display_name, subject, updated_at, created_at
        FROM sessions
        WHERE COALESCE(last_to, group_id) IS NOT NULL
      `,
        )
        .all() as Array<{
        session_key: string;
        agent_id: string;
        channel: string | null;
        account_id: string | null;
        group_id: string | null;
        last_channel: string | null;
        last_account_id: string | null;
        last_to: string | null;
        last_thread_id: string | null;
        chat_type: string | null;
        display_name: string | null;
        subject: string | null;
        updated_at: number;
        created_at: number;
      }>;

      for (const row of sessionRows) {
        const rawChatId = row.last_to ?? row.group_id;
        if (!rawChatId) continue;
        const chat = upsertChat(database, {
          channel: row.last_channel ?? row.channel ?? "unknown",
          instanceId: row.last_account_id ?? row.account_id ?? "",
          platformChatId: rawChatId,
          chatType: inferChatType(rawChatId, row.chat_type as ChatType | null),
          title: row.display_name ?? row.subject,
          rawProvenance: {
            sourceTable: "sessions",
            sessionKey: row.session_key,
            groupId: row.group_id,
            lastTo: row.last_to,
            lastThreadId: row.last_thread_id,
          },
          seenAt: row.updated_at || row.created_at || now,
        });
        bindSessionToChat(database, {
          sessionKey: row.session_key,
          chatId: chat.id,
          agentId: row.agent_id,
          bindingReason: "legacy_session_backfill",
          seenAt: row.updated_at || now,
        });
      }

      const eventRows = database
        .prepare(
          `
        SELECT DISTINCT source_channel, source_account_id, source_chat_id, source_thread_id
        FROM session_events
        WHERE source_chat_id IS NOT NULL
      `,
        )
        .all() as Array<{
        source_channel: string | null;
        source_account_id: string | null;
        source_chat_id: string;
        source_thread_id: string | null;
      }>;

      for (const row of eventRows) {
        upsertChat(database, {
          channel: row.source_channel ?? "unknown",
          instanceId: row.source_account_id ?? "",
          platformChatId: row.source_thread_id ? `${row.source_chat_id}#${row.source_thread_id}` : row.source_chat_id,
          chatType: row.source_thread_id ? "thread" : inferChatType(row.source_chat_id),
          rawProvenance: {
            sourceTable: "session_events",
            sourceChatId: row.source_chat_id,
            sourceThreadId: row.source_thread_id,
          },
          seenAt: now,
        });
      }

      const messageRows = database
        .prepare("SELECT DISTINCT chat_id FROM message_metadata WHERE chat_id IS NOT NULL")
        .all() as Array<{ chat_id: string }>;
      for (const row of messageRows) {
        upsertChat(database, {
          channel: "unknown",
          instanceId: "",
          platformChatId: row.chat_id,
          chatType: inferChatType(row.chat_id),
          rawProvenance: {
            sourceTable: "message_metadata",
            chatId: row.chat_id,
          },
          seenAt: now,
        });
      }
    },
    { label: "router:backfillChatModel" },
  );
}

function backfillChatModelOnce(database: Database): void {
  const existing = database.prepare("SELECT value FROM router_meta WHERE key = ?").get(IDENTITY_CHAT_BACKFILL_KEY) as
    | { value: string }
    | undefined;
  if (existing?.value === "done") {
    return;
  }

  backfillChatModel(database);
  database
    .prepare("INSERT OR REPLACE INTO router_meta (key, value, updated_at) VALUES (?, ?, ?)")
    .run(IDENTITY_CHAT_BACKFILL_KEY, "done", Date.now());
}

type ParsedBackfillParticipant = {
  id: string | null;
  platformUserId: string;
  displayName: string | null;
  role: string | null;
};

function parseParticipantsJson(raw: string | null): ParsedBackfillParticipant[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const record = item as Record<string, unknown>;
        const platformUserId =
          typeof record.platformUserId === "string"
            ? record.platformUserId
            : typeof record.userId === "string"
              ? record.userId
              : null;
        if (!platformUserId) return null;
        return {
          id: typeof record.id === "string" ? record.id : null,
          platformUserId,
          displayName:
            typeof record.displayName === "string"
              ? record.displayName
              : typeof record.name === "string"
                ? record.name
                : null,
          role: typeof record.role === "string" ? record.role : null,
        };
      })
      .filter((item): item is ParsedBackfillParticipant => item !== null);
  } catch {
    return [];
  }
}

function normalizeParticipantRole(role: string | null | undefined): ChatParticipantRole {
  const normalized = role?.trim().toLowerCase();
  if (normalized === "admin" || normalized === "owner" || normalized === "member") return normalized;
  return "unknown";
}

// ============================================================================
// Prepared Statement Cache
// ============================================================================

interface PreparedStatements {
  insertAgent: Statement;
  updateAgent: Statement;
  updateAgentHeartbeatLastRun: Statement;
  deleteAgent: Statement;
  getAgent: Statement;
  listAgents: Statement;
  insertRoute: Statement;
  updateRoute: Statement;
  deleteRoute: Statement;
  getRoute: Statement;
  listRoutes: Statement;
  listRoutesByAccount: Statement;
  upsertSetting: Statement;
  getSetting: Statement;
  deleteSetting: Statement;
  listSettings: Statement;
  // Skill gate rules
  upsertSkillGateRule: Statement;
  getSkillGateRule: Statement;
  deleteSkillGateRule: Statement;
  listSkillGateRules: Statement;
  // Matrix accounts
  upsertMatrixAccount: Statement;
  getMatrixAccount: Statement;
  deleteMatrixAccount: Statement;
  listMatrixAccounts: Statement;
  touchMatrixAccount: Statement;
  // Message metadata
  upsertMessageMeta: Statement;
  getMessageMeta: Statement;
  listMessageMetaByChatId: Statement;
  cleanupMessageMeta: Statement;
  cleanupExpiredSessions: Statement;
  // Audit log
  insertAuditLog: Statement;
  // Soft-delete
  softDeleteRoute: Statement;
  restoreRoute: Statement;
  listDeletedRoutes: Statement;
  listDeletedRoutesByAccount: Statement;
  softDeleteInstance: Statement;
  restoreInstance: Statement;
  listDeletedInstances: Statement;
  // Cost events
  insertCostEvent: Statement;
  // Instances
  upsertInstance: Statement;
  getInstanceByName: Statement;
  getInstanceByInstanceId: Statement;
  listInstances: Statement;
  deleteInstance: Statement;
  updateInstance: Statement;
  // Contexts
  insertContext: Statement;
  getContextById: Statement;
  getContextByKey: Statement;
  listContexts: Statement;
  touchContext: Statement;
  revokeContext: Statement;
  updateContextRuntimeState: Statement;
  updateContextCapabilities: Statement;
  deleteContext: Statement;
}

/**
 * Get prepared statements, creating them on first access.
 */
function getStatements(): PreparedStatements {
  if (routerDbState.stmts !== null) {
    return routerDbState.stmts;
  }

  const database = getDb();

  routerDbState.stmts = {
    // Agents
    insertAgent: database.prepare(`
      INSERT INTO agents (id, name, cwd, model, provider, remote, remote_user, dm_scope, system_prompt_append, debounce_ms, group_debounce_ms, matrix_account, setting_sources,
        heartbeat_enabled, heartbeat_interval_ms, heartbeat_model, heartbeat_active_start, heartbeat_active_end, heartbeat_account_id,
        spec_mode,
        contact_scope, allowed_sessions,
        agent_mode,
        defaults,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateAgent: database.prepare(`
      UPDATE agents SET
        name = ?,
        cwd = ?,
        model = ?,
        provider = ?,
        remote = ?,
        remote_user = ?,
        dm_scope = ?,
        system_prompt_append = ?,
        debounce_ms = ?,
        group_debounce_ms = ?,
        matrix_account = ?,
        setting_sources = ?,
        heartbeat_enabled = ?,
        heartbeat_interval_ms = ?,
        heartbeat_model = ?,
        heartbeat_active_start = ?,
        heartbeat_active_end = ?,
        heartbeat_account_id = ?,
        spec_mode = ?,
        contact_scope = ?,
        allowed_sessions = ?,
        agent_mode = ?,
        defaults = ?,
        updated_at = ?
      WHERE id = ?
    `),
    updateAgentHeartbeatLastRun: database.prepare(`
      UPDATE agents SET heartbeat_last_run_at = ?, updated_at = ? WHERE id = ?
    `),
    deleteAgent: database.prepare("DELETE FROM agents WHERE id = ?"),
    getAgent: database.prepare("SELECT * FROM agents WHERE id = ?"),
    listAgents: database.prepare("SELECT * FROM agents ORDER BY id"),

    // Routes
    insertRoute: database.prepare(`
      INSERT INTO routes (pattern, account_id, agent_id, dm_scope, session_name, policy, priority, channel, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateRoute: database.prepare(`
      UPDATE routes SET
        agent_id = ?,
        dm_scope = ?,
        session_name = ?,
        policy = ?,
        priority = ?,
        channel = ?,
        updated_at = ?
      WHERE pattern = ? AND account_id = ?
    `),
    deleteRoute: database.prepare("DELETE FROM routes WHERE pattern = ? AND account_id = ?"),
    getRoute: database.prepare("SELECT * FROM routes WHERE pattern = ? AND account_id = ? AND deleted_at IS NULL"),
    listRoutes: database.prepare("SELECT * FROM routes WHERE deleted_at IS NULL ORDER BY priority DESC, id"),
    listRoutesByAccount: database.prepare(
      "SELECT * FROM routes WHERE account_id = ? AND deleted_at IS NULL ORDER BY priority DESC, id",
    ),

    // Settings
    upsertSetting: database.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    getSetting: database.prepare("SELECT * FROM settings WHERE key = ?"),
    deleteSetting: database.prepare("DELETE FROM settings WHERE key = ?"),
    listSettings: database.prepare("SELECT * FROM settings ORDER BY key"),

    // Skill gate rules
    upsertSkillGateRule: database.prepare(`
      INSERT INTO skill_gate_rules (
        id, skill, disabled, pattern, group_regex, tool, tool_prefix, tool_regex,
        command, command_prefix, command_regex, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        skill = excluded.skill,
        disabled = excluded.disabled,
        pattern = excluded.pattern,
        group_regex = excluded.group_regex,
        tool = excluded.tool,
        tool_prefix = excluded.tool_prefix,
        tool_regex = excluded.tool_regex,
        command = excluded.command,
        command_prefix = excluded.command_prefix,
        command_regex = excluded.command_regex,
        updated_at = excluded.updated_at
    `),
    getSkillGateRule: database.prepare("SELECT * FROM skill_gate_rules WHERE id = ?"),
    deleteSkillGateRule: database.prepare("DELETE FROM skill_gate_rules WHERE id = ?"),
    listSkillGateRules: database.prepare("SELECT * FROM skill_gate_rules ORDER BY id"),

    // Matrix accounts
    upsertMatrixAccount: database.prepare(`
      INSERT INTO matrix_accounts (username, user_id, homeserver, access_token, device_id, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        user_id = excluded.user_id,
        homeserver = excluded.homeserver,
        access_token = excluded.access_token,
        device_id = excluded.device_id,
        last_used_at = excluded.last_used_at
    `),
    getMatrixAccount: database.prepare("SELECT * FROM matrix_accounts WHERE username = ?"),
    deleteMatrixAccount: database.prepare("DELETE FROM matrix_accounts WHERE username = ?"),
    listMatrixAccounts: database.prepare("SELECT * FROM matrix_accounts ORDER BY username"),
    touchMatrixAccount: database.prepare("UPDATE matrix_accounts SET last_used_at = ? WHERE username = ?"),
    // Message metadata
    upsertMessageMeta: database.prepare(`
      INSERT INTO message_metadata (
        message_id, chat_id, canonical_chat_id, actor_type, contact_id, agent_id, platform_identity_id,
        raw_sender_id, normalized_sender_id, identity_confidence, identity_provenance_json,
        transcription, media_path, media_type, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        canonical_chat_id = COALESCE(excluded.canonical_chat_id, message_metadata.canonical_chat_id),
        actor_type = COALESCE(excluded.actor_type, message_metadata.actor_type),
        contact_id = COALESCE(excluded.contact_id, message_metadata.contact_id),
        agent_id = COALESCE(excluded.agent_id, message_metadata.agent_id),
        platform_identity_id = COALESCE(excluded.platform_identity_id, message_metadata.platform_identity_id),
        raw_sender_id = COALESCE(excluded.raw_sender_id, message_metadata.raw_sender_id),
        normalized_sender_id = COALESCE(excluded.normalized_sender_id, message_metadata.normalized_sender_id),
        identity_confidence = COALESCE(excluded.identity_confidence, message_metadata.identity_confidence),
        identity_provenance_json = COALESCE(excluded.identity_provenance_json, message_metadata.identity_provenance_json),
        transcription = COALESCE(excluded.transcription, message_metadata.transcription),
        media_path = COALESCE(excluded.media_path, message_metadata.media_path),
        media_type = COALESCE(excluded.media_type, message_metadata.media_type)
    `),
    getMessageMeta: database.prepare("SELECT * FROM message_metadata WHERE message_id = ?"),
    listMessageMetaByChatId: database.prepare(
      "SELECT * FROM message_metadata WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?",
    ),
    cleanupMessageMeta: database.prepare("DELETE FROM message_metadata WHERE created_at < ?"),
    cleanupExpiredSessions: database.prepare(
      "DELETE FROM sessions WHERE ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ?",
    ),
    // Audit log
    insertAuditLog: database.prepare(
      "INSERT INTO audit_log (action, entity, entity_id, old_value, actor, ts) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    // Soft-delete: routes
    softDeleteRoute: database.prepare(
      "UPDATE routes SET deleted_at = ? WHERE pattern = ? AND account_id = ? AND deleted_at IS NULL",
    ),
    restoreRoute: database.prepare("UPDATE routes SET deleted_at = NULL WHERE pattern = ? AND account_id = ?"),
    listDeletedRoutes: database.prepare("SELECT * FROM routes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
    listDeletedRoutesByAccount: database.prepare(
      "SELECT * FROM routes WHERE account_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    ),
    // Soft-delete: instances
    softDeleteInstance: database.prepare("UPDATE instances SET deleted_at = ? WHERE name = ? AND deleted_at IS NULL"),
    restoreInstance: database.prepare("UPDATE instances SET deleted_at = NULL WHERE name = ?"),
    listDeletedInstances: database.prepare(
      "SELECT * FROM instances WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    ),
    // Cost events
    insertCostEvent: database.prepare(`
      INSERT INTO cost_events (session_key, agent_id, model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, input_cost_usd, output_cost_usd, cache_cost_usd,
        total_cost_usd, pricing_status, pricing_source, pricing_source_url, pricing_source_version,
        pricing_fetched_at, pricing_model, pricing_error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    // Instances
    upsertInstance: database.prepare(`
      INSERT INTO instances (
        name, instance_id, channel, agent, dm_policy, group_policy, contact_intake_mode,
        dm_scope, enabled, defaults, default_contact_tags, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        instance_id  = excluded.instance_id,
        channel      = excluded.channel,
        agent        = excluded.agent,
        dm_policy    = excluded.dm_policy,
        group_policy = excluded.group_policy,
        contact_intake_mode = excluded.contact_intake_mode,
        dm_scope     = excluded.dm_scope,
        enabled      = excluded.enabled,
        defaults     = excluded.defaults,
        default_contact_tags = excluded.default_contact_tags,
        updated_at   = excluded.updated_at
    `),
    getInstanceByName: database.prepare("SELECT * FROM instances WHERE name = ? AND deleted_at IS NULL"),
    getInstanceByInstanceId: database.prepare("SELECT * FROM instances WHERE instance_id = ? AND deleted_at IS NULL"),
    listInstances: database.prepare("SELECT * FROM instances WHERE deleted_at IS NULL ORDER BY name"),
    deleteInstance: database.prepare("DELETE FROM instances WHERE name = ?"),
    updateInstance: database.prepare(`
      UPDATE instances SET
        instance_id  = ?,
        channel      = ?,
        agent        = ?,
        dm_policy    = ?,
        group_policy = ?,
        contact_intake_mode = ?,
        dm_scope     = ?,
        enabled      = ?,
        defaults     = ?,
        default_contact_tags = ?,
        updated_at   = ?
      WHERE name = ?
    `),
    // Contexts
    insertContext: database.prepare(`
      INSERT INTO contexts (
        context_id, context_key, kind, agent_id, session_key, session_name,
        source_json, capabilities_json, metadata_json, created_at, expires_at, last_used_at, revoked_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getContextById: database.prepare("SELECT * FROM contexts WHERE context_id = ?"),
    getContextByKey: database.prepare("SELECT * FROM contexts WHERE context_key = ?"),
    listContexts: database.prepare("SELECT * FROM contexts ORDER BY created_at DESC"),
    touchContext: database.prepare("UPDATE contexts SET last_used_at = ? WHERE context_id = ?"),
    revokeContext: database.prepare("UPDATE contexts SET revoked_at = ? WHERE context_id = ?"),
    updateContextRuntimeState: database.prepare(`
      UPDATE contexts SET
        session_name = ?,
        source_json = ?,
        metadata_json = ?,
        last_used_at = ?
      WHERE context_id = ?
    `),
    updateContextCapabilities: database.prepare(`
      UPDATE contexts SET
        capabilities_json = ?,
        last_used_at = ?
      WHERE context_id = ?
    `),
    deleteContext: database.prepare("DELETE FROM contexts WHERE context_id = ?"),
  };

  return routerDbState.stmts!;
}

// ============================================================================
// Row Mapping
// ============================================================================

function rowToAgent(row: AgentRow): AgentConfig {
  const result: AgentConfig = {
    id: row.id,
    cwd: row.cwd,
  };

  if (row.name !== null) result.name = row.name;
  if (row.model !== null) result.model = row.model;
  if (row.provider !== null) result.provider = row.provider;
  if (row.remote !== null) result.remote = row.remote;
  if (row.remote_user !== null) result.remoteUser = row.remote_user;
  if (row.dm_scope !== null) {
    // Validate before casting
    const parsed = DmScopeSchema.safeParse(row.dm_scope);
    if (parsed.success) {
      result.dmScope = parsed.data;
    }
  }
  if (row.system_prompt_append !== null) result.systemPromptAppend = row.system_prompt_append;
  if (row.debounce_ms !== null) result.debounceMs = row.debounce_ms;
  if (row.group_debounce_ms !== null) result.groupDebounceMs = row.group_debounce_ms;
  if (row.matrix_account !== null) result.matrixAccount = row.matrix_account;
  if (row.setting_sources !== null) {
    try {
      result.settingSources = JSON.parse(row.setting_sources);
    } catch {
      // Ignore invalid JSON
    }
  }

  // Heartbeat fields
  result.heartbeat = {
    enabled: row.heartbeat_enabled === 1,
    intervalMs: row.heartbeat_interval_ms ?? 1800000,
    model: row.heartbeat_model ?? undefined,
    accountId: row.heartbeat_account_id ?? undefined,
    activeStart: row.heartbeat_active_start ?? undefined,
    activeEnd: row.heartbeat_active_end ?? undefined,
    lastRunAt: row.heartbeat_last_run_at ?? undefined,
  };

  // Spec mode
  result.specMode = row.spec_mode === 1;

  // Scope isolation
  if (row.contact_scope !== null) result.contactScope = row.contact_scope;
  if (row.allowed_sessions !== null) {
    try {
      result.allowedSessions = JSON.parse(row.allowed_sessions);
    } catch {
      // Ignore invalid JSON
    }
  }

  // Agent mode
  if (row.agent_mode === "active" || row.agent_mode === "sentinel") {
    result.mode = row.agent_mode;
  }

  // Generic defaults
  if (row.defaults !== null) {
    try {
      result.defaults = JSON.parse(row.defaults);
    } catch {
      // Ignore invalid JSON
    }
  }

  return result;
}

function rowToRoute(row: RouteRow): RouteConfig & { id: number } {
  const result: RouteConfig & { id: number } = {
    id: row.id,
    pattern: row.pattern,
    accountId: row.account_id,
    agent: row.agent_id,
    priority: row.priority,
  };

  if (row.dm_scope !== null) {
    const parsed = DmScopeSchema.safeParse(row.dm_scope);
    if (parsed.success) {
      result.dmScope = parsed.data;
    }
  }

  if (row.session_name !== null) {
    result.session = row.session_name;
  }

  if ((row as RouteRow & { policy?: string | null }).policy != null) {
    result.policy = (row as RouteRow & { policy?: string | null }).policy!;
  }

  if (row.channel !== null) {
    result.channel = row.channel;
  }

  return result;
}

function rowToInstance(row: InstanceRow): InstanceConfig {
  const contactIntakeMode = ContactIntakeModeSchema.safeParse(row.contact_intake_mode ?? "off");
  const result: InstanceConfig = {
    name: row.name,
    channel: row.channel,
    dmPolicy: (row.dm_policy ?? "open") as InstanceConfig["dmPolicy"],
    groupPolicy: (row.group_policy ?? "open") as InstanceConfig["groupPolicy"],
    contactIntakeMode: contactIntakeMode.success ? contactIntakeMode.data : "off",
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.instance_id) result.instanceId = row.instance_id;
  if (row.agent) result.agent = row.agent;
  if (row.dm_scope) {
    const parsed = DmScopeSchema.safeParse(row.dm_scope);
    if (parsed.success) result.dmScope = parsed.data;
  }
  if (row.defaults) {
    try {
      result.defaults = JSON.parse(row.defaults);
    } catch {
      // Ignore invalid JSON so a bad defaults blob does not break instance listing.
    }
  }
  if (row.default_contact_tags) {
    try {
      const parsed = JSON.parse(row.default_contact_tags);
      if (Array.isArray(parsed)) {
        result.defaultContactTags = parsed
          .filter((value): value is string => typeof value === "string")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
      }
    } catch {
      // Ignore invalid tag payload to avoid breaking instance listing.
    }
  }
  if (row.deleted_at) result.deletedAt = row.deleted_at;
  return result;
}

function rowToContext(row: ContextRow): ContextRecord {
  const result: ContextRecord = {
    contextId: row.context_id,
    contextKey: row.context_key,
    kind: row.kind,
    capabilities: [],
    createdAt: row.created_at,
  };

  if (row.agent_id) result.agentId = row.agent_id;
  if (row.session_key) result.sessionKey = row.session_key;
  if (row.session_name) result.sessionName = row.session_name;
  if (row.expires_at) result.expiresAt = row.expires_at;
  if (row.last_used_at) result.lastUsedAt = row.last_used_at;
  if (row.revoked_at) result.revokedAt = row.revoked_at;

  if (row.source_json) {
    try {
      const parsed = ContextSourceSchema.safeParse(JSON.parse(row.source_json));
      if (parsed.success) result.source = parsed.data;
    } catch {
      // Ignore invalid JSON
    }
  }

  try {
    const parsed = z.array(ContextCapabilitySchema).safeParse(JSON.parse(row.capabilities_json));
    if (parsed.success) result.capabilities = parsed.data;
  } catch {
    // Ignore invalid JSON
  }

  if (row.metadata_json) {
    try {
      const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(row.metadata_json));
      if (parsed.success) result.metadata = parsed.data;
    } catch {
      // Ignore invalid JSON
    }
  }

  return result;
}

function rowToDaemonRestartEpoch(row: DaemonRestartEpochRow): DaemonRestartEpochRecord {
  return {
    restartEpoch: row.restart_epoch,
    reason: row.reason,
    callerSessionName: row.caller_session_name ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDaemonRestartSessionSnapshot(row: DaemonRestartSessionSnapshotRow): DaemonRestartSessionSnapshotRecord {
  return {
    restartEpoch: row.restart_epoch,
    sessionKey: row.session_key,
    sessionName: row.session_name,
    agentId: row.agent_id ?? undefined,
    runtimeProvider: row.runtime_provider ?? undefined,
    activity: row.activity,
    nonIdle: row.non_idle === 1,
    lastActivityAt: row.last_activity_at,
    stoppedAt: row.stopped_at,
    pendingMessageCount: row.pending_message_count,
    pendingMessagesJson: row.pending_messages_json ?? undefined,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function dbUpsertDaemonRestartEpoch(input: DaemonRestartEpochInput): DaemonRestartEpochRecord {
  const createdAt = input.createdAt ?? Date.now();
  const updatedAt = input.updatedAt ?? createdAt;
  return executeWrite(
    getDb(),
    (database) => {
      database
        .prepare(
          `
          INSERT INTO daemon_restart_epochs (
            restart_epoch, reason, caller_session_name, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(restart_epoch) DO UPDATE SET
            reason = excluded.reason,
            caller_session_name = COALESCE(excluded.caller_session_name, daemon_restart_epochs.caller_session_name),
            updated_at = excluded.updated_at
        `,
        )
        .run(input.restartEpoch, input.reason, input.callerSessionName ?? null, createdAt, updatedAt);

      const row = database
        .prepare("SELECT * FROM daemon_restart_epochs WHERE restart_epoch = ?")
        .get(input.restartEpoch) as DaemonRestartEpochRow | undefined;
      if (!row) {
        throw new Error(`Restart epoch not found after upsert: ${input.restartEpoch}`);
      }
      return rowToDaemonRestartEpoch(row);
    },
    { label: "daemon_restart_epoch_upsert" },
  );
}

export function dbRecordDaemonRestartSessionSnapshot(
  input: DaemonRestartSessionSnapshotInput,
): DaemonRestartSessionSnapshotRecord {
  const now = input.recordedAt ?? Date.now();
  const pendingMessages = input.pendingMessages ?? [];
  const pendingMessagesJson = pendingMessages.length > 0 ? JSON.stringify(pendingMessages) : null;
  return executeWrite(
    getDb(),
    (database) => {
      database
        .prepare(
          `
          INSERT INTO daemon_restart_session_snapshots (
            restart_epoch, session_key, session_name, agent_id, runtime_provider,
            activity, non_idle, last_activity_at, stopped_at, pending_message_count,
            pending_messages_json, metadata_json, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(restart_epoch, session_key) DO UPDATE SET
            session_name = excluded.session_name,
            agent_id = COALESCE(excluded.agent_id, daemon_restart_session_snapshots.agent_id),
            runtime_provider = COALESCE(excluded.runtime_provider, daemon_restart_session_snapshots.runtime_provider),
            activity = excluded.activity,
            non_idle = excluded.non_idle,
            last_activity_at = MAX(daemon_restart_session_snapshots.last_activity_at, excluded.last_activity_at),
            stopped_at = MAX(daemon_restart_session_snapshots.stopped_at, excluded.stopped_at),
            pending_message_count = excluded.pending_message_count,
            pending_messages_json = excluded.pending_messages_json,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `,
        )
        .run(
          input.restartEpoch,
          input.sessionKey,
          input.sessionName,
          input.agentId ?? null,
          input.runtimeProvider ?? null,
          input.activity,
          input.nonIdle ? 1 : 0,
          input.lastActivityAt,
          input.stoppedAt,
          pendingMessages.length,
          pendingMessagesJson,
          cleanJsonRecord(input.metadata ?? null),
          now,
          now,
        );

      const row = database
        .prepare("SELECT * FROM daemon_restart_session_snapshots WHERE restart_epoch = ? AND session_key = ?")
        .get(input.restartEpoch, input.sessionKey) as DaemonRestartSessionSnapshotRow | undefined;
      if (!row) {
        throw new Error(`Restart snapshot not found after upsert: ${input.restartEpoch}/${input.sessionKey}`);
      }
      return rowToDaemonRestartSessionSnapshot(row);
    },
    { label: "daemon_restart_snapshot_record" },
  );
}

export function dbListEligibleDaemonRestartSessionSnapshots(input: {
  restartEpoch: string;
  now?: number;
  windowMs?: number;
}): DaemonRestartSessionSnapshotRecord[] {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? 60 * 60 * 1000;
  const cutoff = now - windowMs;
  const rows = getDb()
    .prepare(
      `
      SELECT snapshots.*
      FROM daemon_restart_session_snapshots snapshots
      JOIN sessions live_sessions ON live_sessions.session_key = snapshots.session_key
      WHERE snapshots.restart_epoch = ?
        AND snapshots.non_idle = 1
        AND snapshots.stopped_at >= ?
        AND (live_sessions.ephemeral = 0 OR live_sessions.expires_at IS NULL OR live_sessions.expires_at > ?)
        AND NOT EXISTS (
          SELECT 1
          FROM daemon_restart_resume_deliveries delivered
          WHERE delivered.restart_epoch = snapshots.restart_epoch
            AND delivered.session_key = snapshots.session_key
        )
      ORDER BY snapshots.stopped_at ASC, snapshots.session_name ASC
    `,
    )
    .all(input.restartEpoch, cutoff, now) as DaemonRestartSessionSnapshotRow[];
  return rows.map(rowToDaemonRestartSessionSnapshot);
}

export function dbGetDaemonRestartPendingMessages(restartEpoch: string, sessionKey: string): unknown[] {
  const row = getDb()
    .prepare(
      "SELECT pending_messages_json FROM daemon_restart_session_snapshots WHERE restart_epoch = ? AND session_key = ?",
    )
    .get(restartEpoch, sessionKey) as { pending_messages_json: string | null } | undefined;
  return parseJsonArray(row?.pending_messages_json ?? null);
}

export function dbHasDaemonRestartResumeDelivery(restartEpoch: string, sessionKey: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS found FROM daemon_restart_resume_deliveries WHERE restart_epoch = ? AND session_key = ?")
    .get(restartEpoch, sessionKey) as { found: number } | undefined;
  return Boolean(row);
}

export function dbMarkDaemonRestartResumeDelivered(input: {
  restartEpoch: string;
  sessionKey: string;
  sessionName?: string | null;
  deliveredAt?: number;
}): boolean {
  const deliveredAt = input.deliveredAt ?? Date.now();
  return executeWrite(
    getDb(),
    (database) => {
      const result = database
        .prepare(
          `
          INSERT OR IGNORE INTO daemon_restart_resume_deliveries (
            restart_epoch, session_key, session_name, delivered_at
          )
          VALUES (?, ?, ?, ?)
        `,
        )
        .run(input.restartEpoch, input.sessionKey, input.sessionName ?? null, deliveredAt);
      return result.changes > 0;
    },
    { label: "daemon_restart_resume_delivered" },
  );
}

export function dbUpsertChat(input: UpsertChatInput): ChatRecord {
  return upsertChat(getDb(), input);
}

export function dbCanonicalizeDmChatForContact(input: CanonicalizeDmChatForContactInput): ChatRecord {
  return executeWrite(getDb(), (database) => canonicalizeDmChatForContact(database, input), {
    label: "canonicalize_dm_chat_for_contact",
  });
}

export function dbGetChat(id: string): ChatRecord | null {
  const row = getDb().prepare("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | undefined;
  return row ? rowToChat(row) : null;
}

export function dbFindChat(input: {
  channel: string;
  instanceId?: string | null;
  platformChatId: string;
  chatType?: ChatType;
}): ChatRecord | null {
  const channel = normalizeChannelId(input.channel);
  const instanceId = input.instanceId?.trim() ?? "";
  const normalizedChatId = normalizeChatIdentity(channel, input.platformChatId, input.chatType);
  const row = getDb()
    .prepare("SELECT * FROM chats WHERE channel = ? AND instance_id = ? AND normalized_chat_id = ?")
    .get(channel, instanceId, normalizedChatId) as ChatRow | undefined;
  if (row) return rowToChat(row);
  const byPlatform = findChatByPlatformOrAlias(getDb(), channel, instanceId, input.platformChatId);
  return byPlatform ? rowToChat(byPlatform) : null;
}

function chatRefCandidates(ref: string): string[] {
  const raw = ref.trim();
  const normalized = normalizePhone(raw);
  return [...new Set([raw, raw.toLowerCase(), normalized].filter(Boolean))];
}

export function dbFindChatByRef(input: {
  ref: string;
  channel?: string | null;
  instanceId?: string | null;
  chatType?: ChatType | null;
}): ChatRecord | null {
  return dbListChatsByRef({ ...input, limit: 1 })[0] ?? null;
}

export function dbListChatsByRef(input: {
  ref: string;
  channel?: string | null;
  instanceId?: string | null;
  chatType?: ChatType | null;
  limit?: number;
}): ChatRecord[] {
  const candidates = chatRefCandidates(input.ref);
  if (candidates.length === 0) return [];
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (input.channel?.trim()) {
    where.push("channel = ?");
    params.push(normalizeChannelId(input.channel));
  }
  if (input.instanceId?.trim()) {
    where.push("instance_id = ?");
    params.push(input.instanceId.trim());
  }
  if (input.chatType?.trim()) {
    where.push("chat_type = ?");
    params.push(input.chatType.trim());
  }
  const placeholders = candidates.map(() => "?").join(", ");
  where.push(
    `(id IN (${placeholders}) OR platform_chat_id IN (${placeholders}) OR normalized_chat_id IN (${placeholders}))`,
  );
  params.push(...candidates, ...candidates, ...candidates);
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 50)));
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM chats
      WHERE ${where.join(" AND ")}
      ORDER BY last_seen_at DESC, updated_at DESC
      LIMIT ?
    `,
    )
    .all(...params, limit) as ChatRow[];
  return rows.map(rowToChat);
}

export function dbListChats(
  input: {
    channel?: string | null;
    instanceId?: string | null;
    chatType?: ChatType | null;
    contactId?: string | null;
    agentId?: string | null;
    query?: string | null;
    limit?: number | string | null;
    offset?: number | string | null;
  } = {},
): ListPage<ChatListItem> {
  const { limit, offset } = normalizeLimitOffsetPage(input, {
    defaultLimit: 25,
    maxLimit: 500,
    minLimit: 1,
  });
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (input.channel?.trim()) {
    where.push("c.channel = ?");
    params.push(normalizeChannelId(input.channel));
  }
  if (input.instanceId?.trim()) {
    where.push("c.instance_id = ?");
    params.push(input.instanceId.trim());
  }
  if (input.chatType?.trim()) {
    where.push("c.chat_type = ?");
    params.push(input.chatType.trim());
  }
  if (input.contactId?.trim()) {
    where.push(
      `(EXISTS (SELECT 1 FROM chat_participants cp WHERE cp.chat_id = c.id AND cp.contact_id = ?)
        OR EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.chat_id = c.id AND cm.contact_id = ?))`,
    );
    params.push(input.contactId.trim(), input.contactId.trim());
  }
  if (input.agentId?.trim()) {
    where.push(
      `(EXISTS (SELECT 1 FROM chat_participants cp WHERE cp.chat_id = c.id AND cp.agent_id = ?)
        OR EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.chat_id = c.id AND cm.agent_id = ?))`,
    );
    params.push(input.agentId.trim(), input.agentId.trim());
  }
  if (input.query?.trim()) {
    const like = `%${input.query.trim()}%`;
    where.push(
      `(c.id LIKE ? OR c.title LIKE ? OR c.platform_chat_id LIKE ? OR c.normalized_chat_id LIKE ?
        OR EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.chat_id = c.id AND cm.content_json LIKE ?))`,
    );
    params.push(like, like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const database = getDb();
  const count = database.prepare(`SELECT COUNT(*) AS total FROM chats c ${whereSql}`).get(...params) as
    | { total: number }
    | undefined;
  const rows = database
    .prepare(
      `
      SELECT
        c.*,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS message_count,
        (SELECT COUNT(*) FROM chat_participants p WHERE p.chat_id = c.id) AS participant_count,
        (
          SELECT m.id FROM chat_messages m
          WHERE m.chat_id = c.id
          ORDER BY COALESCE(m.provider_timestamp, m.ingested_at) DESC, m.ingested_at DESC, m.id DESC
          LIMIT 1
        ) AS last_message_id
      FROM chats c
      ${whereSql}
      ORDER BY c.last_seen_at DESC, c.updated_at DESC, c.id ASC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params, limit, offset) as Array<
    ChatRow & {
      message_count: number;
      participant_count: number;
      last_message_id: string | null;
    }
  >;
  return {
    total: count?.total ?? 0,
    limit,
    offset,
    items: rows.map((row) => ({
      chat: rowToChat(row),
      messageCount: row.message_count,
      participantCount: row.participant_count,
      lastMessage: row.last_message_id ? dbGetChatMessageWithSortKey(row.last_message_id) : null,
    })),
  };
}

function normalizePositiveInteger(value: number | string | null | undefined, fallback: number, max: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function dbListChatIdsByContactIds(input: {
  contactIds: string[];
  limitPerContact?: number | string | null;
}): Map<string, string[]> {
  const contactIds = Array.from(new Set(input.contactIds.map((id) => id.trim()).filter(Boolean)));
  const result = new Map<string, string[]>(contactIds.map((id) => [id, []]));
  if (contactIds.length === 0) return result;

  const limitPerContact = normalizePositiveInteger(input.limitPerContact, 500, 5_000);
  const database = getDb();
  const chunkSize = 250;

  for (let index = 0; index < contactIds.length; index += chunkSize) {
    const chunk = contactIds.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database
      .prepare(
        `
        WITH related_raw AS (
          SELECT cp.contact_id AS contact_id, cp.chat_id AS chat_id, c.last_seen_at AS last_seen_at
          FROM chat_participants cp
          JOIN chats c ON c.id = cp.chat_id
          WHERE cp.contact_id IN (${placeholders})

          UNION ALL

          SELECT cm.contact_id AS contact_id, cm.chat_id AS chat_id, c.last_seen_at AS last_seen_at
          FROM chat_messages cm
          JOIN chats c ON c.id = cm.chat_id
          WHERE cm.contact_id IN (${placeholders})
        ),
        related AS (
          SELECT contact_id, chat_id, MAX(last_seen_at) AS last_seen_at
          FROM related_raw
          WHERE contact_id IS NOT NULL AND chat_id IS NOT NULL
          GROUP BY contact_id, chat_id
        ),
        ranked AS (
          SELECT
            contact_id,
            chat_id,
            ROW_NUMBER() OVER (
              PARTITION BY contact_id
              ORDER BY last_seen_at DESC, chat_id ASC
            ) AS rank
          FROM related
        )
        SELECT contact_id, chat_id
        FROM ranked
        WHERE rank <= ?
        ORDER BY contact_id ASC, rank ASC
      `,
      )
      .all(...chunk, ...chunk, limitPerContact) as Array<{
      contact_id: string;
      chat_id: string;
    }>;

    for (const row of rows) {
      const chats = result.get(row.contact_id);
      if (chats) chats.push(row.chat_id);
    }
  }

  return result;
}

export function dbUpsertChatParticipant(input: UpsertChatParticipantInput): ChatParticipantRecord {
  return upsertChatParticipant(getDb(), input);
}

export function dbUpsertChatMessage(input: UpsertChatMessageInput): UpsertChatMessageResult {
  return upsertChatMessage(getDb(), input);
}

export function dbGetChatMessage(id: string): ChatMessageRecord | null {
  const row = getDb().prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as ChatMessageRow | undefined;
  return row ? rowToChatMessage(row) : null;
}

export function dbGetChatMessageWithSortKey(id: string): ChatMessageWithSortKey | null {
  const row = getDb()
    .prepare(
      `
      SELECT m.*, printf('%013d:%013d:%s', COALESCE(m.provider_timestamp, m.ingested_at), m.ingested_at, m.id) AS message_sort_key
      FROM chat_messages m
      WHERE m.id = ?
    `,
    )
    .get(id) as ChatMessageWithSortKeyRow | undefined;
  return row ? rowToChatMessageWithSortKey(row) : null;
}

export function dbFindChatMessage(input: {
  channel: string;
  instanceId?: string | null;
  chatId: string;
  providerMessageId: string;
}): ChatMessageRecord | null {
  const channel = normalizeChannelId(input.channel);
  const instanceId = input.instanceId?.trim() ?? "";
  const row = getDb()
    .prepare(
      `
      SELECT * FROM chat_messages
      WHERE channel = ? AND instance_id = ? AND chat_id = ? AND provider_message_id = ?
    `,
    )
    .get(channel, instanceId, input.chatId, input.providerMessageId) as ChatMessageRow | undefined;
  return row ? rowToChatMessage(row) : null;
}

function normalizeChatMessageScopeIds(chatIds?: string[] | null): string[] {
  return Array.from(new Set((chatIds ?? []).map((chatId) => chatId.trim()).filter(Boolean)));
}

export function dbFindAgentChatMessageByRef(input: {
  agentId: string;
  messageRef: string;
  chatIds?: string[] | null;
  includeDeleted?: boolean;
}): ChatMessageRecord | null {
  const agentId = input.agentId.trim();
  const messageRef = input.messageRef.trim();
  if (!agentId || !messageRef) return null;

  const whereClauses = ["m.actor_type = 'agent'", "m.agent_id = ?", "(m.id = ? OR m.provider_message_id = ?)"];
  const params: SQLQueryBindings[] = [agentId, messageRef, messageRef];
  const chatIds = normalizeChatMessageScopeIds(input.chatIds);
  if (chatIds.length > 0) {
    whereClauses.push(`m.chat_id IN (${chatIds.map(() => "?").join(", ")})`);
    params.push(...chatIds);
  }
  if (!input.includeDeleted) {
    whereClauses.push("m.deleted_at IS NULL");
  }

  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM chat_messages m
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY COALESCE(m.provider_timestamp, m.ingested_at) DESC, m.ingested_at DESC, m.id DESC
      LIMIT 1
    `,
    )
    .get(...params) as ChatMessageRow | undefined;
  return row ? rowToChatMessage(row) : null;
}

export function dbListAgentChatMessagesPage(input: {
  agentId: string;
  chatIds?: string[] | null;
  limit?: number | string | null;
  offset?: number | string | null;
  order?: "asc" | "desc";
  includeDeleted?: boolean;
}): ListPage<ChatMessageWithSortKey> {
  const agentId = input.agentId.trim();
  if (!agentId) {
    return { total: 0, limit: 0, offset: 0, items: [] };
  }

  const { limit, offset } = normalizeLimitOffsetPage(input, {
    defaultLimit: 10,
    maxLimit: 100,
    minLimit: 1,
  });
  const order = input.order === "asc" ? "ASC" : "DESC";
  const whereClauses = ["m.actor_type = 'agent'", "m.agent_id = ?"];
  const params: SQLQueryBindings[] = [agentId];
  const chatIds = normalizeChatMessageScopeIds(input.chatIds);
  if (chatIds.length > 0) {
    whereClauses.push(`m.chat_id IN (${chatIds.map(() => "?").join(", ")})`);
    params.push(...chatIds);
  }
  if (!input.includeDeleted) {
    whereClauses.push("m.deleted_at IS NULL");
  }

  const whereSql = whereClauses.join(" AND ");
  const database = getDb();
  const count = database.prepare(`SELECT COUNT(*) AS total FROM chat_messages m WHERE ${whereSql}`).get(...params) as
    | { total: number }
    | undefined;
  const rows = database
    .prepare(
      `
      SELECT m.*, printf('%013d:%013d:%s', COALESCE(m.provider_timestamp, m.ingested_at), m.ingested_at, m.id) AS message_sort_key
      FROM chat_messages m
      WHERE ${whereSql}
      ORDER BY message_sort_key ${order}
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params, limit, offset) as ChatMessageWithSortKeyRow[];
  return {
    total: count?.total ?? 0,
    limit,
    offset,
    items: rows.map(rowToChatMessageWithSortKey),
  };
}

export function dbMarkChatMessageDeleted(id: string, deletedAt = Date.now()): ChatMessageRecord | null {
  const messageId = id.trim();
  if (!messageId) return null;
  const database = getDb();
  database
    .prepare("UPDATE chat_messages SET deleted_at = ?, updated_at = ? WHERE id = ?")
    .run(deletedAt, deletedAt, messageId);
  return dbGetChatMessage(messageId);
}

export function dbMarkChatMessageEdited(id: string, text: string, editedAt = Date.now()): ChatMessageRecord | null {
  const messageId = id.trim();
  const nextText = text.trim();
  if (!messageId || !nextText) return null;
  const current = dbGetChatMessage(messageId);
  if (!current) return null;

  const previousContent = current.content ?? {};
  const previousText = typeof previousContent.text === "string" ? previousContent.text : undefined;
  const nextContent = {
    ...previousContent,
    type: previousContent.type ?? current.messageType ?? "text",
    text: nextText,
    editedAt,
  };
  const previousProvenance = current.rawProvenance ?? {};
  const previousHistory = Array.isArray(previousProvenance.raviEditHistory) ? previousProvenance.raviEditHistory : [];
  const nextProvenance = {
    ...previousProvenance,
    lastRaviEditAt: editedAt,
    raviEditHistory: [
      ...previousHistory,
      {
        editedAt,
        previousText: previousText ?? null,
        text: nextText,
      },
    ],
  };

  getDb()
    .prepare(
      `
      UPDATE chat_messages
      SET content_json = ?,
          raw_provenance_json = ?,
          edited_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(cleanJsonRecord(nextContent), cleanJsonRecord(nextProvenance), editedAt, editedAt, messageId);
  return dbGetChatMessage(messageId);
}

export function dbListChatMessagesPage(input: {
  chatId: string;
  limit?: number | string | null;
  offset?: number | string | null;
  order?: "asc" | "desc";
}): ListPage<ChatMessageWithSortKey> {
  const { limit, offset } = normalizeLimitOffsetPage(input, {
    defaultLimit: 50,
    maxLimit: 500,
    minLimit: 1,
  });
  const order = input.order === "desc" ? "DESC" : "ASC";
  const database = getDb();
  const count = database.prepare("SELECT COUNT(*) AS total FROM chat_messages WHERE chat_id = ?").get(input.chatId) as
    | { total: number }
    | undefined;
  const rows = database
    .prepare(
      `
      SELECT m.*, printf('%013d:%013d:%s', COALESCE(m.provider_timestamp, m.ingested_at), m.ingested_at, m.id) AS message_sort_key
      FROM chat_messages m
      WHERE m.chat_id = ?
      ORDER BY message_sort_key ${order}
      LIMIT ? OFFSET ?
    `,
    )
    .all(input.chatId, limit, offset) as ChatMessageWithSortKeyRow[];
  return {
    total: count?.total ?? 0,
    limit,
    offset,
    items: rows.map(rowToChatMessageWithSortKey),
  };
}

export function dbListChatMessagesPageByContactId(input: {
  contactId: string;
  identityRefs?: ChatMessageContactIdentityRef[] | null;
  limit?: number | string | null;
  offset?: number | string | null;
  order?: "asc" | "desc";
}): ListPage<ChatMessageWithSortKey> & { contactId: string } {
  const { limit, offset } = normalizeLimitOffsetPage(input, {
    defaultLimit: 50,
    maxLimit: 500,
    minLimit: 1,
  });
  const order = input.order === "asc" ? "ASC" : "DESC";
  const database = getDb();
  const whereClauses = ["m.contact_id = ?"];
  const whereParams: SQLQueryBindings[] = [input.contactId];

  const identityRefs = input.identityRefs ?? [];
  const platformIdentityIds = Array.from(
    new Set(
      identityRefs
        .map((identity) => (typeof identity.id === "string" ? identity.id.trim() : ""))
        .filter((id) => id.length > 0),
    ),
  );
  if (platformIdentityIds.length > 0) {
    whereClauses.push(`m.platform_identity_id IN (${platformIdentityIds.map(() => "?").join(", ")})`);
    whereParams.push(...platformIdentityIds);
  }

  const senderIdentityClauses: string[] = [];
  const senderIdentityParams: SQLQueryBindings[] = [];
  for (const identity of identityRefs) {
    const normalizedSenderId =
      typeof identity.normalizedPlatformUserId === "string" ? identity.normalizedPlatformUserId.trim() : "";
    const channel = typeof identity.channel === "string" ? normalizeChannelId(identity.channel) : "";
    const instanceId = typeof identity.instanceId === "string" ? identity.instanceId.trim() : "";
    if (!normalizedSenderId || !channel) continue;
    if (channel === "phone") {
      senderIdentityClauses.push("(m.normalized_sender_id = ? AND m.channel LIKE 'whatsapp%')");
      senderIdentityParams.push(normalizedSenderId);
      continue;
    }
    if (channel === "whatsapp") {
      senderIdentityClauses.push("(m.normalized_sender_id = ? AND m.channel LIKE 'whatsapp%' AND m.instance_id = ?)");
      senderIdentityParams.push(normalizedSenderId, instanceId);
      continue;
    }
    senderIdentityClauses.push("(m.normalized_sender_id = ? AND m.channel = ? AND m.instance_id = ?)");
    senderIdentityParams.push(normalizedSenderId, channel, instanceId);
  }
  if (senderIdentityClauses.length > 0) {
    whereClauses.push(senderIdentityClauses.join(" OR "));
    whereParams.push(...senderIdentityParams);
  }

  const whereSql = whereClauses.map((clause) => `(${clause})`).join(" OR ");
  const count = database
    .prepare(`SELECT COUNT(*) AS total FROM chat_messages m WHERE ${whereSql}`)
    .get(...whereParams) as { total: number } | undefined;
  const rows = database
    .prepare(
      `
      SELECT m.*, printf('%013d:%013d:%s', COALESCE(m.provider_timestamp, m.ingested_at), m.ingested_at, m.id) AS message_sort_key
      FROM chat_messages m
      WHERE ${whereSql}
      ORDER BY message_sort_key ${order}
      LIMIT ? OFFSET ?
    `,
    )
    .all(...whereParams, limit, offset) as ChatMessageWithSortKeyRow[];
  return {
    contactId: input.contactId,
    total: count?.total ?? 0,
    limit,
    offset,
    items: rows.map(rowToChatMessageWithSortKey),
  };
}

export function dbListChatMessages(chatId: string, limit = 50): ChatMessageRecord[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM chat_messages
      WHERE chat_id = ?
      ORDER BY COALESCE(provider_timestamp, ingested_at), ingested_at, id
      LIMIT ?
    `,
    )
    .all(chatId, limit) as ChatMessageRow[];
  return rows.map(rowToChatMessage);
}

export function dbBackfillChatMessageProviderTimestamps(
  input: { dryRun?: boolean; limit?: number | string | null } = {},
): ChatMessageProviderTimestampBackfillResult {
  const limit = parsePositiveIntegerOption(input.limit, "--limit");
  const limitSql = limit ? "LIMIT ?" : "";
  const params = limit ? [limit] : [];
  const database = getDb();
  const rows = database
    .prepare(
      `
      SELECT id, chat_id, provider_message_id, provider_timestamp, raw_provenance_json
      FROM chat_messages
      WHERE raw_provenance_json LIKE '%messageTimestamp%'
      ORDER BY ingested_at ASC, id ASC
      ${limitSql}
    `,
    )
    .all(...params) as Array<
    Pick<ChatMessageRow, "id" | "chat_id" | "provider_message_id" | "provider_timestamp" | "raw_provenance_json">
  >;

  let skipped = 0;
  let unchanged = 0;
  const items: ChatMessageProviderTimestampBackfillItem[] = [];

  for (const row of rows) {
    const providerTimestamp = providerTimestampFromRawProvenance(row.raw_provenance_json);
    if (providerTimestamp === undefined) {
      skipped++;
      continue;
    }
    if (row.provider_timestamp === providerTimestamp) {
      unchanged++;
      continue;
    }
    items.push({
      id: row.id,
      chatId: row.chat_id,
      providerMessageId: row.provider_message_id,
      previousProviderTimestamp: row.provider_timestamp ?? undefined,
      providerTimestamp,
    });
  }

  const dryRun = input.dryRun !== false;
  let updated = 0;
  if (!dryRun && items.length > 0) {
    updated = executeWrite(
      database,
      (db) => {
        const now = Date.now();
        const stmt = db.prepare("UPDATE chat_messages SET provider_timestamp = ?, updated_at = ? WHERE id = ?");
        let changes = 0;
        for (const item of items) {
          changes += stmt.run(item.providerTimestamp, now, item.id).changes;
        }
        return changes;
      },
      { label: "router:backfillChatMessageProviderTimestamps" },
    );
  }

  return {
    dryRun,
    scanned: rows.length,
    candidates: rows.length - skipped,
    skipped,
    unchanged,
    wouldUpdate: items.length,
    updated,
    items: items.slice(0, 20),
  };
}

function normalizeReadingListOwner(input: { ownerType?: string | null; ownerId?: string | null }): {
  ownerType: string;
  ownerId: string;
} {
  return {
    ownerType: input.ownerType?.trim() || "system",
    ownerId: input.ownerId?.trim() || "ravi",
  };
}

function normalizeReadingCursorReader(input: { readerType?: string | null; readerId?: string | null }): {
  readerType: string;
  readerId: string;
} {
  return {
    readerType: input.readerType?.trim() || "agent",
    readerId: input.readerId?.trim() || "ravi",
  };
}

export function dbCreateChatReadingList(input: {
  name: string;
  description?: string | null;
  ownerType?: string | null;
  ownerId?: string | null;
  visibility?: string | null;
  mode?: string | null;
  selector?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}): ChatReadingListRecord {
  const name = input.name.trim();
  if (!name) throw new Error("Reading list name is required");
  const { ownerType, ownerId } = normalizeReadingListOwner(input);
  const id = semanticId("crl", [ownerType, ownerId, name]);
  const now = Date.now();
  getDb()
    .prepare(
      `
      INSERT INTO chat_reading_lists (
        id, name, description, owner_type, owner_id, visibility, mode,
        selector_json, metadata_json, created_at, updated_at, archived_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = COALESCE(excluded.description, chat_reading_lists.description),
        visibility = excluded.visibility,
        mode = excluded.mode,
        selector_json = COALESCE(excluded.selector_json, chat_reading_lists.selector_json),
        metadata_json = COALESCE(excluded.metadata_json, chat_reading_lists.metadata_json),
        updated_at = excluded.updated_at,
        archived_at = NULL
    `,
    )
    .run(
      id,
      name,
      input.description ?? null,
      ownerType,
      ownerId,
      input.visibility?.trim() || "system",
      input.mode?.trim() || "static",
      cleanJsonRecord(input.selector),
      cleanJsonRecord(input.metadata),
      now,
      now,
    );
  const row = getDb().prepare("SELECT * FROM chat_reading_lists WHERE id = ?").get(id) as ChatReadingListRow;
  return rowToChatReadingList(row);
}

export function dbListChatReadingLists(
  input: {
    ownerType?: string | null;
    ownerId?: string | null;
    includeArchived?: boolean;
    limit?: number | string | null;
    offset?: number | string | null;
  } = {},
): ListPage<ChatReadingListRecord> {
  const { limit, offset } = normalizeLimitOffsetPage(input, {
    defaultLimit: 50,
    maxLimit: 500,
    minLimit: 1,
  });
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (input.ownerType?.trim()) {
    where.push("owner_type = ?");
    params.push(input.ownerType.trim());
  }
  if (input.ownerId?.trim()) {
    where.push("owner_id = ?");
    params.push(input.ownerId.trim());
  }
  if (!input.includeArchived) where.push("archived_at IS NULL");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const database = getDb();
  const count = database.prepare(`SELECT COUNT(*) AS total FROM chat_reading_lists ${whereSql}`).get(...params) as
    | { total: number }
    | undefined;
  const rows = database
    .prepare(
      `
      SELECT * FROM chat_reading_lists
      ${whereSql}
      ORDER BY updated_at DESC, name ASC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params, limit, offset) as ChatReadingListRow[];
  return {
    total: count?.total ?? 0,
    limit,
    offset,
    items: rows.map(rowToChatReadingList),
  };
}

export function dbFindChatReadingList(input: {
  ref: string;
  ownerType?: string | null;
  ownerId?: string | null;
}): ChatReadingListRecord | null {
  const ref = input.ref.trim();
  if (!ref) return null;
  const ownerType = input.ownerType?.trim();
  const ownerId = input.ownerId?.trim();
  const database = getDb();
  const exact = database.prepare("SELECT * FROM chat_reading_lists WHERE id = ? AND archived_at IS NULL").get(ref) as
    | ChatReadingListRow
    | undefined;
  if (exact) {
    if (ownerType && exact.owner_type !== ownerType) return null;
    if (ownerId && exact.owner_id !== ownerId) return null;
    return rowToChatReadingList(exact);
  }
  const where: string[] = ["archived_at IS NULL", "name = ?"];
  const params: Array<string | number> = [ref];
  if (ownerType) {
    where.push("owner_type = ?");
    params.push(ownerType);
  }
  if (ownerId) {
    where.push("owner_id = ?");
    params.push(ownerId);
  }
  const rows = database
    .prepare(
      `
      SELECT * FROM chat_reading_lists
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC, name ASC
      LIMIT 2
    `,
    )
    .all(...params) as ChatReadingListRow[];
  if (rows.length > 1) {
    throw new Error(`Reading list name is ambiguous: ${ref}. Pass --owner <type:id> or use the list id.`);
  }
  return rows[0] ? rowToChatReadingList(rows[0]) : null;
}

export function dbAddChatToReadingList(input: {
  listId: string;
  chatId: string;
  source?: ChatReadingListMemberSource | null;
  reason?: string | null;
  priority?: number | string | null;
  metadata?: Record<string, unknown> | null;
}): ChatReadingListMemberRecord {
  const database = getDb();
  const existing = database
    .prepare("SELECT * FROM chat_reading_list_members WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL")
    .get(input.listId, input.chatId) as ChatReadingListMemberRow | undefined;
  if (existing) return rowToChatReadingListMember(existing);
  const now = Date.now();
  const id = uniqueId("crlm");
  const priority = Number(input.priority ?? 0);
  database
    .prepare(
      `
      INSERT INTO chat_reading_list_members (
        id, list_id, chat_id, source, reason, priority, metadata_json, added_at, removed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `,
    )
    .run(
      id,
      input.listId,
      input.chatId,
      input.source?.trim() || "manual",
      input.reason ?? null,
      Number.isFinite(priority) ? priority : 0,
      cleanJsonRecord(input.metadata),
      now,
    );
  const row = database
    .prepare("SELECT * FROM chat_reading_list_members WHERE id = ?")
    .get(id) as ChatReadingListMemberRow;
  return rowToChatReadingListMember(row);
}

export function dbRemoveChatFromReadingList(input: { listId: string; chatId: string }): boolean {
  const result = getDb()
    .prepare(
      "UPDATE chat_reading_list_members SET removed_at = ? WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL",
    )
    .run(Date.now(), input.listId, input.chatId);
  return result.changes > 0;
}

function getActiveChatReadingListMember(listId: string, chatId: string): ChatReadingListMemberRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM chat_reading_list_members WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL")
    .get(listId, chatId) as ChatReadingListMemberRow | undefined;
  return row ? rowToChatReadingListMember(row) : null;
}

function requireActiveChatReadingListMember(listId: string, chatId: string): ChatReadingListMemberRecord {
  const member = getActiveChatReadingListMember(listId, chatId);
  if (!member) {
    throw new Error(`Chat ${chatId} is not an active member of reading list ${listId}`);
  }
  return member;
}

export function dbGetChatReadingCursor(input: {
  listId: string;
  chatId: string;
  readerType?: string | null;
  readerId?: string | null;
}): ChatReadingCursorRecord | null {
  const { readerType, readerId } = normalizeReadingCursorReader(input);
  const row = getDb()
    .prepare(
      `
      SELECT * FROM chat_reading_cursors
      WHERE list_id = ? AND chat_id = ? AND reader_type = ? AND reader_id = ?
    `,
    )
    .get(input.listId, input.chatId, readerType, readerId) as ChatReadingCursorRow | undefined;
  return row ? rowToChatReadingCursor(row) : null;
}

function listChatMessagesAfterCursor(input: {
  chatId: string;
  afterSortKey?: string | null;
  limit?: number | string | null;
}): ChatMessageWithSortKey[] {
  const { limit } = normalizeLimitOffsetPage(
    { limit: input.limit, offset: 0 },
    { defaultLimit: 50, maxLimit: 500, minLimit: 1 },
  );
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM (
        SELECT m.*, printf('%013d:%013d:%s', COALESCE(m.provider_timestamp, m.ingested_at), m.ingested_at, m.id) AS message_sort_key
        FROM chat_messages m
        WHERE m.chat_id = ?
      )
      WHERE ? IS NULL OR message_sort_key > ?
      ORDER BY message_sort_key ASC
      LIMIT ?
    `,
    )
    .all(input.chatId, input.afterSortKey ?? null, input.afterSortKey ?? null, limit) as ChatMessageWithSortKeyRow[];
  return rows.map(rowToChatMessageWithSortKey);
}

function countChatMessagesAfterCursor(chatId: string, afterSortKey?: string | null): number {
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS total FROM (
        SELECT printf('%013d:%013d:%s', COALESCE(provider_timestamp, ingested_at), ingested_at, id) AS message_sort_key
        FROM chat_messages
        WHERE chat_id = ?
      )
      WHERE ? IS NULL OR message_sort_key > ?
    `,
    )
    .get(chatId, afterSortKey ?? null, afterSortKey ?? null) as { total: number } | undefined;
  return row?.total ?? 0;
}

function latestChatMessage(chatId: string): ChatMessageWithSortKey | null {
  const row = getDb()
    .prepare(
      `
      SELECT m.*, printf('%013d:%013d:%s', COALESCE(m.provider_timestamp, m.ingested_at), m.ingested_at, m.id) AS message_sort_key
      FROM chat_messages m
      WHERE m.chat_id = ?
      ORDER BY message_sort_key DESC
      LIMIT 1
    `,
    )
    .get(chatId) as ChatMessageWithSortKeyRow | undefined;
  return row ? rowToChatMessageWithSortKey(row) : null;
}

export function dbListChatReadingListMembers(input: {
  listId: string;
  readerType?: string | null;
  readerId?: string | null;
  limit?: number | string | null;
  offset?: number | string | null;
}): ListPage<ChatReadingListMemberItem> {
  const { limit, offset } = normalizeLimitOffsetPage(input, {
    defaultLimit: 50,
    maxLimit: 500,
    minLimit: 1,
  });
  const { readerType, readerId } = normalizeReadingCursorReader(input);
  const database = getDb();
  const count = database
    .prepare("SELECT COUNT(*) AS total FROM chat_reading_list_members WHERE list_id = ? AND removed_at IS NULL")
    .get(input.listId) as { total: number } | undefined;
  const rows = database
    .prepare(
      `
      SELECT m.* FROM chat_reading_list_members m
      JOIN chats c ON c.id = m.chat_id
      WHERE m.list_id = ? AND m.removed_at IS NULL
      ORDER BY m.priority DESC, c.last_seen_at DESC, m.added_at DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(input.listId, limit, offset) as ChatReadingListMemberRow[];
  const items = rows.flatMap((memberRow): ChatReadingListMemberItem[] => {
    const chat = dbGetChat(memberRow.chat_id);
    if (!chat) return [];
    const cursor = dbGetChatReadingCursor({
      listId: input.listId,
      chatId: chat.id,
      readerType,
      readerId,
    });
    const messageCount = database
      .prepare("SELECT COUNT(*) AS total FROM chat_messages WHERE chat_id = ?")
      .get(chat.id) as { total: number } | undefined;
    return [
      {
        member: rowToChatReadingListMember(memberRow),
        chat,
        messageCount: messageCount?.total ?? 0,
        unreadMessageCount: countChatMessagesAfterCursor(chat.id, cursor?.lastReadMessageSortKey),
        lastMessage: latestChatMessage(chat.id),
        cursor,
      },
    ];
  });
  return { total: count?.total ?? 0, limit, offset, items };
}

export function dbGetChatReadingDelta(input: {
  listId: string;
  chatId: string;
  readerType?: string | null;
  readerId?: string | null;
  limit?: number | string | null;
}): ChatReadingDelta | null {
  const list = dbFindChatReadingList({ ref: input.listId });
  const chat = dbGetChat(input.chatId);
  if (!list || !chat) return null;
  requireActiveChatReadingListMember(list.id, chat.id);
  const { readerType, readerId } = normalizeReadingCursorReader(input);
  const previousCursor = dbGetChatReadingCursor({
    listId: list.id,
    chatId: chat.id,
    readerType,
    readerId,
  });
  const messages = listChatMessagesAfterCursor({
    chatId: chat.id,
    afterSortKey: previousCursor?.lastReadMessageSortKey,
    limit: input.limit,
  });
  const lastUnreadMessage = messages.at(-1) ?? null;
  const now = Date.now();
  const nextCursor: ChatReadingCursorRecord | null = lastUnreadMessage
    ? {
        id: semanticId("crc", [list.id, chat.id, readerType, readerId]),
        listId: list.id,
        chatId: chat.id,
        readerType,
        readerId,
        lastReadMessageId: lastUnreadMessage.id,
        lastReadMessageSortKey: lastUnreadMessage.sortKey,
        lastReadAt: now,
        readReason: "delta_preview",
        createdAt: previousCursor?.createdAt ?? now,
        updatedAt: now,
      }
    : previousCursor;
  return {
    list,
    chat,
    reader: { type: readerType, id: readerId },
    previousCursor,
    nextCursor,
    messages,
    events: [],
    newMessageCount: countChatMessagesAfterCursor(chat.id, previousCursor?.lastReadMessageSortKey),
    editedMessageCount: 0,
    deletedMessageCount: 0,
    participantChanges: [],
    firstUnreadMessage: messages[0] ?? null,
    lastUnreadMessage,
  };
}

export function dbMarkChatReadingCursor(input: {
  listId: string;
  chatId: string;
  readerType?: string | null;
  readerId?: string | null;
  messageId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}): ChatReadingCursorRecord {
  const list = dbFindChatReadingList({ ref: input.listId });
  const chat = dbGetChat(input.chatId);
  if (!list) throw new Error(`Reading list not found: ${input.listId}`);
  if (!chat) throw new Error(`Chat not found: ${input.chatId}`);
  requireActiveChatReadingListMember(list.id, chat.id);
  const { readerType, readerId } = normalizeReadingCursorReader(input);
  const previous = dbGetChatReadingCursor({
    listId: list.id,
    chatId: chat.id,
    readerType,
    readerId,
  });
  const requestedMessageId = input.messageId?.trim();
  const message = requestedMessageId ? dbGetChatMessageWithSortKey(requestedMessageId) : latestChatMessage(chat.id);
  if (requestedMessageId && !message) {
    throw new Error(`Message not found: ${requestedMessageId}`);
  }
  if (message && message.chatId !== chat.id) {
    throw new Error(`Message ${message.id} does not belong to chat ${chat.id}`);
  }
  const now = Date.now();
  const id = semanticId("crc", [list.id, chat.id, readerType, readerId]);
  getDb()
    .prepare(
      `
      INSERT INTO chat_reading_cursors (
        id, list_id, chat_id, reader_type, reader_id,
        last_read_message_id, last_read_message_sort_key,
        last_read_event_id, last_read_event_sort_key,
        last_read_at, read_reason, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(list_id, chat_id, reader_type, reader_id) DO UPDATE SET
        last_read_message_id = excluded.last_read_message_id,
        last_read_message_sort_key = excluded.last_read_message_sort_key,
        last_read_at = excluded.last_read_at,
        read_reason = excluded.read_reason,
        metadata_json = COALESCE(excluded.metadata_json, chat_reading_cursors.metadata_json),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      id,
      list.id,
      chat.id,
      readerType,
      readerId,
      message?.id ?? null,
      message?.sortKey ?? null,
      now,
      input.reason?.trim() || "manual",
      cleanJsonRecord(input.metadata),
      now,
      now,
    );
  getDb()
    .prepare(
      `
      INSERT INTO chat_reading_cursor_events (
        id, list_id, chat_id, reader_type, reader_id,
        previous_message_id, previous_message_sort_key,
        next_message_id, next_message_sort_key,
        reason, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      uniqueId("crce"),
      list.id,
      chat.id,
      readerType,
      readerId,
      previous?.lastReadMessageId ?? null,
      previous?.lastReadMessageSortKey ?? null,
      message?.id ?? null,
      message?.sortKey ?? null,
      input.reason?.trim() || "manual",
      cleanJsonRecord(input.metadata),
      now,
    );
  const row = getDb().prepare("SELECT * FROM chat_reading_cursors WHERE id = ?").get(id) as ChatReadingCursorRow;
  return rowToChatReadingCursor(row);
}

export function dbListChatParticipants(chatId: string): ChatParticipantRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM chat_participants WHERE chat_id = ? ORDER BY role, normalized_platform_user_id, id")
    .all(chatId) as ChatParticipantRow[];
  return rows.map(rowToChatParticipant);
}

export function dbBindSessionToChat(input: {
  sessionKey: string;
  chatId: string;
  agentId?: string | null;
  routeId?: number | null;
  bindingReason?: string | null;
  seenAt?: number;
}): SessionChatBindingRecord {
  return bindSessionToChat(getDb(), input);
}

export function dbGetSessionChatBinding(sessionKey: string): SessionChatBindingRecord | null {
  const row = getDb().prepare("SELECT * FROM session_chat_bindings WHERE session_key = ?").get(sessionKey) as
    | SessionChatBindingRow
    | undefined;
  return row ? rowToSessionChatBinding(row) : null;
}

export function dbListSessionChatBindings(chatId: string): SessionChatBindingRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM session_chat_bindings WHERE chat_id = ? ORDER BY updated_at DESC")
    .all(chatId) as SessionChatBindingRow[];
  return rows.map(rowToSessionChatBinding);
}

export function dbUpsertSessionParticipant(input: UpsertSessionParticipantInput): SessionParticipantRecord {
  return upsertSessionParticipant(getDb(), input);
}

export function dbListSessionParticipants(sessionKey: string): SessionParticipantRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM session_participants WHERE session_key = ? ORDER BY last_seen_at DESC")
    .all(sessionKey) as SessionParticipantRow[];
  return rows.map(rowToSessionParticipant);
}

export function dbBackfillChatModel(): void {
  backfillChatModel(getDb());
}

// ============================================================================
// sessions/attach — subscriptions
// See .ravi/specs/sessions/attach/SPEC.md
// ============================================================================

interface SessionChatSubscriptionRow {
  id: number;
  session_key: string;
  chat_id: string;
  role: string;
  attached_by_type: string;
  attached_by_id: string | null;
  attached_reason: string | null;
  context_snapshot_at_attach_json: string | null;
  speech_mode: string | null;
  speech_updated_at: number | null;
  speech_reason: string | null;
  output_attached_at: number | null;
  created_at: number;
  updated_at: number;
  detached_at: number | null;
}

function rowToSessionChatSubscription(row: SessionChatSubscriptionRow): SessionChatSubscriptionRecord {
  return {
    id: row.id,
    sessionKey: row.session_key,
    chatId: row.chat_id,
    role: row.role as SubscriptionRole,
    attachedByType: row.attached_by_type as AttachedByType,
    attachedById: row.attached_by_id ?? undefined,
    attachedReason: row.attached_reason ?? undefined,
    contextSnapshotAtAttach: parseJsonRecord(row.context_snapshot_at_attach_json),
    speechMode: row.speech_mode === "muted" ? "muted" : "speak",
    speechUpdatedAt: row.speech_updated_at ?? undefined,
    speechReason: row.speech_reason ?? undefined,
    outputAttachedAt: row.output_attached_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    detachedAt: row.detached_at ?? undefined,
  };
}

/**
 * Create or reactivate a session→chat subscription. Idempotent: re-attaching
 * the same `(session_key, chat_id)` when an active row exists returns it
 * untouched. The unique partial index on active `chat_id` enforces the
 * cross-session rule (a chat can only be attached to one session at a time).
 */
export function dbCreateSessionChatSubscription(
  input: CreateSessionChatSubscriptionInput,
): SessionChatSubscriptionRecord {
  const db = getDb();
  const now = Date.now();
  const speechMode = input.speechMode ?? "speak";
  const speechUpdatedAt = input.speechUpdatedAt ?? now;
  const existingActive = db
    .prepare("SELECT * FROM session_chat_subscriptions WHERE session_key = ? AND chat_id = ? AND detached_at IS NULL")
    .get(input.sessionKey, input.chatId) as SessionChatSubscriptionRow | undefined;
  if (existingActive) {
    return rowToSessionChatSubscription(existingActive);
  }

  // Both write paths below (reactivation UPDATE and fresh INSERT) can
  // violate the partial UNIQUE index on (chat_id) WHERE detached_at IS
  // NULL — the reactivation does it by flipping `detached_at = NULL`,
  // the insert by adding a new active row. Both get translated into the
  // same typed conflict so concurrent inbound dispatches surface a
  // clean SessionAttachConflictError instead of raw SQLite errors.

  // Reactivate any prior detached row for the same (session, chat) so
  // we keep the audit minimal across detach/reattach cycles.
  try {
    const reactivated = db
      .prepare(
        `
        UPDATE session_chat_subscriptions
        SET detached_at = NULL,
            role = ?,
            attached_by_type = ?,
            attached_by_id = ?,
            attached_reason = ?,
            context_snapshot_at_attach_json = ?,
            speech_mode = ?,
            speech_updated_at = ?,
            speech_reason = ?,
            output_attached_at = ?,
            updated_at = ?
        WHERE session_key = ? AND chat_id = ? AND detached_at IS NOT NULL
        `,
      )
      .run(
        input.role ?? "input",
        input.attachedByType ?? "system",
        input.attachedById ?? null,
        input.attachedReason ?? null,
        cleanJsonRecord(input.contextSnapshotAtAttach ?? null),
        speechMode,
        speechUpdatedAt,
        input.speechReason ?? null,
        input.outputAttachedAt ?? null,
        now,
        input.sessionKey,
        input.chatId,
      );
    if (reactivated.changes > 0) {
      const row = db
        .prepare(
          "SELECT * FROM session_chat_subscriptions WHERE session_key = ? AND chat_id = ? AND detached_at IS NULL",
        )
        .get(input.sessionKey, input.chatId) as SessionChatSubscriptionRow;
      return rowToSessionChatSubscription(row);
    }
  } catch (err) {
    return translateChatUniqueRace(err, input.sessionKey, input.chatId);
  }

  try {
    const insert = db
      .prepare(
        `
        INSERT INTO session_chat_subscriptions (
          session_key, chat_id, role, attached_by_type, attached_by_id,
          attached_reason, context_snapshot_at_attach_json,
          speech_mode, speech_updated_at, speech_reason,
          output_attached_at, created_at, updated_at, detached_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `,
      )
      .run(
        input.sessionKey,
        input.chatId,
        input.role ?? "input",
        input.attachedByType ?? "system",
        input.attachedById ?? null,
        input.attachedReason ?? null,
        cleanJsonRecord(input.contextSnapshotAtAttach ?? null),
        speechMode,
        speechUpdatedAt,
        input.speechReason ?? null,
        input.outputAttachedAt ?? null,
        now,
        now,
      );
    const row = db
      .prepare("SELECT * FROM session_chat_subscriptions WHERE id = ?")
      .get(insert.lastInsertRowid) as SessionChatSubscriptionRow;
    return rowToSessionChatSubscription(row);
  } catch (err) {
    return translateChatUniqueRace(err, input.sessionKey, input.chatId);
  }
}

/**
 * Translate a raw SQLite UNIQUE-constraint error on the
 * `(chat_id) WHERE detached_at IS NULL` index into one of:
 *   - the existing row, when the race winner is the requested session
 *     (idempotent recovery);
 *   - `SubscriptionChatConflictError`, when another session won;
 *   - the original error, when neither path applies (e.g. the winning
 *     row was detached between the failure and the re-check — no clean
 *     translation, let the caller decide).
 *
 * Non-UNIQUE errors are re-thrown unchanged.
 */
function translateChatUniqueRace(err: unknown, sessionKey: string, chatId: string): SessionChatSubscriptionRecord {
  if (!isUniqueConstraintError(err)) throw err;
  const existing = dbFindActiveSubscriptionByChat(chatId);
  if (existing && existing.sessionKey === sessionKey) return existing;
  if (existing) {
    throw new SubscriptionChatConflictError(chatId, existing.sessionKey, sessionKey);
  }
  throw err;
}

/**
 * Thrown by `dbCreateSessionChatSubscription` when a concurrent writer
 * already attached the requested chat to a different session. Caller
 * (typically `attachChatToSession`) should translate this into the
 * higher-level `SessionAttachConflictError`.
 */
export class SubscriptionChatConflictError extends Error {
  readonly code = "SUBSCRIPTION_CHAT_CONFLICT" as const;
  constructor(
    public readonly chatId: string,
    public readonly currentSessionKey: string,
    public readonly requestedSessionKey: string,
  ) {
    super(
      `chat ${chatId} is attached to ${currentSessionKey}; cannot subscribe ${requestedSessionKey} (concurrent attach won)`,
    );
    this.name = "SubscriptionChatConflictError";
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /UNIQUE constraint failed/i.test(message);
}

/**
 * Active subscriptions (not detached) for a session.
 */
export function dbListSessionChatSubscriptions(sessionKey: string): SessionChatSubscriptionRecord[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM session_chat_subscriptions WHERE session_key = ? AND detached_at IS NULL ORDER BY role, created_at",
    )
    .all(sessionKey) as SessionChatSubscriptionRow[];
  return rows.map(rowToSessionChatSubscription);
}

/**
 * Look up the (single) active subscription that owns a chat, across all
 * sessions. Used by the consumer to detect "this chat is already attached
 * elsewhere" and route inbound dispatch into the owning session.
 */
export function dbFindActiveSubscriptionByChat(chatId: string): SessionChatSubscriptionRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM session_chat_subscriptions WHERE chat_id = ? AND detached_at IS NULL")
    .get(chatId) as SessionChatSubscriptionRow | undefined;
  return row ? rowToSessionChatSubscription(row) : null;
}

/**
 * Current output attachment for a session. This is the chat that receives
 * emitted responses from the session until another attach selects a new one
 * or detach clears it.
 */
export function dbGetSessionOutputAttachment(sessionKey: string): SessionChatSubscriptionRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM session_chat_subscriptions
      WHERE session_key = ?
        AND detached_at IS NULL
        AND output_attached_at IS NOT NULL
      ORDER BY output_attached_at DESC, updated_at DESC, id DESC
      LIMIT 1
    `,
    )
    .get(sessionKey) as SessionChatSubscriptionRow | undefined;
  return row ? rowToSessionChatSubscription(row) : null;
}

/**
 * Select a session's output attachment. The target row must already be an
 * active subscription for this session.
 */
export function dbSetSessionOutputAttachment(sessionKey: string, chatId: string): SessionChatSubscriptionRecord {
  const db = getDb();
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `
      UPDATE session_chat_subscriptions
      SET output_attached_at = NULL, updated_at = ?
      WHERE session_key = ?
        AND detached_at IS NULL
        AND output_attached_at IS NOT NULL
        AND chat_id <> ?
    `,
    ).run(now, sessionKey, chatId);
    const result = db
      .prepare(
        `
        UPDATE session_chat_subscriptions
        SET output_attached_at = ?,
            speech_mode = 'speak',
            speech_updated_at = ?,
            speech_reason = 'output-attachment',
            updated_at = ?
        WHERE session_key = ?
          AND chat_id = ?
          AND detached_at IS NULL
      `,
      )
      .run(now, now, now, sessionKey, chatId);
    if (result.changes === 0) {
      throw new Error(`Cannot attach output: chat ${chatId} is not active in session ${sessionKey}`);
    }
  })();

  const row = db
    .prepare("SELECT * FROM session_chat_subscriptions WHERE session_key = ? AND chat_id = ? AND detached_at IS NULL")
    .get(sessionKey, chatId) as SessionChatSubscriptionRow;
  return rowToSessionChatSubscription(row);
}

export function dbSetSessionChatSpeechMode(
  sessionKey: string,
  chatId: string,
  speechMode: SubscriptionSpeechMode,
  reason?: string | null,
): SessionChatSubscriptionRecord {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `
      UPDATE session_chat_subscriptions
      SET speech_mode = ?,
          speech_updated_at = ?,
          speech_reason = ?,
          output_attached_at = CASE WHEN ? = 'muted' THEN NULL ELSE output_attached_at END,
          updated_at = ?
      WHERE session_key = ?
        AND chat_id = ?
        AND detached_at IS NULL
    `,
    )
    .run(speechMode, now, reason ?? null, speechMode, now, sessionKey, chatId);
  if (result.changes === 0) {
    throw new Error(`Cannot set speech mode: chat ${chatId} is not active in session ${sessionKey}`);
  }
  const row = db
    .prepare("SELECT * FROM session_chat_subscriptions WHERE session_key = ? AND chat_id = ? AND detached_at IS NULL")
    .get(sessionKey, chatId) as SessionChatSubscriptionRow;
  return rowToSessionChatSubscription(row);
}

/**
 * Clear the session's output attachment. When `chatId` is provided, only that
 * chat is cleared if it is currently selected.
 */
export function dbClearSessionOutputAttachment(sessionKey: string, chatId?: string): boolean {
  const now = Date.now();
  const result = chatId
    ? getDb()
        .prepare(
          `
          UPDATE session_chat_subscriptions
          SET output_attached_at = NULL,
              speech_mode = 'muted',
              speech_updated_at = ?,
              speech_reason = 'output-detached',
              updated_at = ?
          WHERE session_key = ?
            AND chat_id = ?
            AND detached_at IS NULL
            AND output_attached_at IS NOT NULL
        `,
        )
        .run(now, now, sessionKey, chatId)
    : getDb()
        .prepare(
          `
          UPDATE session_chat_subscriptions
          SET output_attached_at = NULL,
              speech_mode = 'muted',
              speech_updated_at = ?,
              speech_reason = 'output-detached',
              updated_at = ?
          WHERE session_key = ?
            AND detached_at IS NULL
            AND output_attached_at IS NOT NULL
        `,
        )
        .run(now, now, sessionKey);
  return result.changes > 0;
}

/**
 * Soft-delete a subscription. Idempotent: detaching an already-detached
 * subscription is a no-op. Returns true when the row was actually flipped.
 */
export function dbDetachSessionChatSubscription(sessionKey: string, chatId: string): boolean {
  const now = Date.now();
  const result = getDb()
    .prepare(
      "UPDATE session_chat_subscriptions SET detached_at = ?, output_attached_at = NULL, updated_at = ? WHERE session_key = ? AND chat_id = ? AND detached_at IS NULL",
    )
    .run(now, now, sessionKey, chatId);
  return result.changes > 0;
}

// ============================================================================
// Agent CRUD
// ============================================================================

/**
 * Create a new agent
 */
export function dbCreateAgent(input: z.input<typeof AgentInputSchema>): AgentConfig {
  const validated = AgentInputSchema.parse(input);
  const now = Date.now();
  const s = getStatements();

  // Verify matrix account exists if specified
  if (validated.matrixAccount) {
    const account = dbGetMatrixAccount(validated.matrixAccount);
    if (!account) {
      throw new Error(`Matrix account not found: ${validated.matrixAccount}`);
    }
  }

  try {
    s.insertAgent.run(
      validated.id,
      validated.name ?? null,
      validated.cwd,
      validated.model ?? null,
      validated.provider ?? null,
      validated.remote ?? null,
      validated.remoteUser ?? null,
      validated.dmScope ?? null,
      validated.systemPromptAppend ?? null,
      validated.debounceMs ?? null,
      validated.groupDebounceMs ?? null,
      validated.matrixAccount ?? null,
      validated.settingSources ? JSON.stringify(validated.settingSources) : null,
      // Heartbeat fields (defaults)
      0, // heartbeat_enabled
      1800000, // heartbeat_interval_ms (30 min)
      null, // heartbeat_model
      null, // heartbeat_active_start
      null, // heartbeat_active_end
      null, // heartbeat_account_id
      0, // spec_mode (disabled by default)
      null, // contact_scope (no restriction by default)
      null, // allowed_sessions (no cross-session by default)
      validated.mode ?? null, // agent_mode
      null, // defaults
      now,
      now,
    );

    log.info("Created agent", { id: validated.id });
    return dbGetAgent(validated.id)!;
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE constraint failed")) {
      throw new Error(`Agent already exists: ${validated.id}`);
    }
    throw err;
  }
}

/**
 * Get agent by ID
 */
export function dbGetAgent(id: string): AgentConfig | null {
  const s = getStatements();
  const row = s.getAgent.get(id) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

/**
 * List all agents
 */
export function dbListAgents(): AgentConfig[] {
  const s = getStatements();
  const rows = s.listAgents.all() as AgentRow[];
  return rows.map(rowToAgent);
}

/**
 * Update an existing agent
 */
export function dbUpdateAgent(id: string, updates: Partial<AgentConfig>): AgentConfig {
  const s = getStatements();
  const row = s.getAgent.get(id) as AgentRow | undefined;

  if (!row) {
    throw new Error(`Agent not found: ${id}`);
  }

  // Validate dmScope if provided
  if (updates.dmScope !== undefined) {
    DmScopeSchema.parse(updates.dmScope);
  }

  // Verify matrix account exists if specified
  if (updates.matrixAccount !== undefined && updates.matrixAccount !== null) {
    const account = dbGetMatrixAccount(updates.matrixAccount);
    if (!account) {
      throw new Error(`Matrix account not found: ${updates.matrixAccount}`);
    }
  }

  const now = Date.now();
  const hb = updates.heartbeat;
  s.updateAgent.run(
    updates.name !== undefined ? (updates.name ?? null) : row.name,
    updates.cwd ?? row.cwd,
    updates.model !== undefined ? (updates.model ?? null) : row.model,
    updates.provider !== undefined ? (updates.provider ?? null) : row.provider,
    updates.remote !== undefined ? (updates.remote ?? null) : row.remote,
    updates.remoteUser !== undefined ? (updates.remoteUser ?? null) : row.remote_user,
    updates.dmScope !== undefined ? (updates.dmScope ?? null) : row.dm_scope,
    updates.systemPromptAppend !== undefined ? (updates.systemPromptAppend ?? null) : row.system_prompt_append,
    updates.debounceMs !== undefined ? (updates.debounceMs ?? null) : row.debounce_ms,
    updates.groupDebounceMs !== undefined ? (updates.groupDebounceMs ?? null) : row.group_debounce_ms,
    updates.matrixAccount !== undefined ? (updates.matrixAccount ?? null) : row.matrix_account,
    updates.settingSources !== undefined
      ? updates.settingSources
        ? JSON.stringify(updates.settingSources)
        : null
      : row.setting_sources,
    // Heartbeat fields
    hb?.enabled !== undefined ? (hb.enabled ? 1 : 0) : row.heartbeat_enabled,
    hb?.intervalMs !== undefined ? hb.intervalMs : row.heartbeat_interval_ms,
    hb?.model !== undefined ? (hb.model ?? null) : row.heartbeat_model,
    hb?.activeStart !== undefined ? (hb.activeStart ?? null) : row.heartbeat_active_start,
    hb?.activeEnd !== undefined ? (hb.activeEnd ?? null) : row.heartbeat_active_end,
    hb?.accountId !== undefined ? (hb.accountId ?? null) : row.heartbeat_account_id,
    // Spec mode
    updates.specMode !== undefined ? (updates.specMode ? 1 : 0) : row.spec_mode,
    // Scope isolation
    updates.contactScope !== undefined ? (updates.contactScope ?? null) : row.contact_scope,
    updates.allowedSessions !== undefined
      ? updates.allowedSessions
        ? JSON.stringify(updates.allowedSessions)
        : null
      : row.allowed_sessions,
    // Agent mode
    updates.mode !== undefined ? (updates.mode ?? null) : row.agent_mode,
    // Generic defaults
    updates.defaults !== undefined ? (updates.defaults ? JSON.stringify(updates.defaults) : null) : row.defaults,
    now,
    id,
  );

  log.info("Updated agent", { id });
  return dbGetAgent(id)!;
}

/**
 * Update agent's heartbeat last run timestamp
 */
export function dbUpdateAgentHeartbeatLastRun(id: string): void {
  const s = getStatements();
  const now = Date.now();
  s.updateAgentHeartbeatLastRun.run(now, now, id);
}

/**
 * Delete an agent
 */
export function dbDeleteAgent(id: string): boolean {
  // Cannot delete the default agent
  const defaultAgentId = getDefaultAgentId();
  if (id === defaultAgentId) {
    throw new Error(`Cannot delete default agent: ${id}`);
  }

  const s = getStatements();
  s.deleteAgent.run(id);
  if (getDbChanges() > 0) {
    log.info("Deleted agent", { id });
    return true;
  }
  return false;
}

/**
 * Set debounce time for an agent (null = disable debounce)
 */
export function dbSetAgentDebounce(id: string, debounceMs: number | null): void {
  dbUpdateAgent(id, { debounceMs: debounceMs as number | undefined });
  log.info("Set agent debounce", { id, debounceMs });
}

// ============================================================================
// Agent Spec Mode
// ============================================================================

/**
 * Enable or disable spec mode for an agent
 */
export function dbSetAgentSpecMode(id: string, enabled: boolean): void {
  dbUpdateAgent(id, { specMode: enabled });
  log.info("Set agent spec mode", { id, enabled });
}

// ============================================================================
// Route CRUD
// ============================================================================

/**
 * Create a new route
 */
export function dbCreateRoute(input: z.input<typeof RouteInputSchema>): RouteConfig {
  const validated = RouteInputSchema.parse(input);
  const s = getStatements();

  // Verify agent exists
  if (!dbGetAgent(validated.agent)) {
    throw new Error(`Agent not found: ${validated.agent}`);
  }

  const now = Date.now();
  const normalizedPattern = validated.pattern.toLowerCase();

  try {
    s.insertRoute.run(
      normalizedPattern,
      validated.accountId,
      validated.agent,
      validated.dmScope ?? null,
      validated.session ?? null,
      validated.policy ?? null,
      validated.priority,
      validated.channel ?? null,
      now,
      now,
    );

    log.info("Created route", {
      pattern: normalizedPattern,
      account: validated.accountId,
      agent: validated.agent,
      channel: validated.channel ?? "*",
    });
    return dbGetRoute(normalizedPattern, validated.accountId)!;
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE constraint failed")) {
      const channelSuffix = validated.channel ? ` [${validated.channel}]` : "";
      throw new Error(`Route already exists: ${validated.pattern} (account: ${validated.accountId}${channelSuffix})`);
    }
    throw err;
  }
}

/**
 * Get route by pattern and account
 */
export function dbGetRoute(pattern: string, accountId: string): (RouteConfig & { id: number }) | null {
  const s = getStatements();
  const row = s.getRoute.get(pattern, accountId) as RouteRow | undefined;
  return row ? rowToRoute(row) : null;
}

/**
 * Get an active route by its durable config id.
 */
export function dbGetRouteById(id: number): (RouteConfig & { id: number }) | null {
  const row = getDb().prepare("SELECT * FROM routes WHERE id = ? AND deleted_at IS NULL").get(id) as
    | RouteRow
    | undefined;
  return row ? rowToRoute(row) : null;
}

/**
 * List routes, optionally filtered by account
 */
export function dbListRoutes(accountId?: string): (RouteConfig & { id: number })[] {
  const s = getStatements();
  const rows = accountId ? (s.listRoutesByAccount.all(accountId) as RouteRow[]) : (s.listRoutes.all() as RouteRow[]);
  return rows.map(rowToRoute);
}

/**
 * List active routes that force a specific session name.
 */
export function dbListRoutesBySessionName(sessionName: string): (RouteConfig & { id: number })[] {
  const rows = getDb()
    .prepare("SELECT * FROM routes WHERE session_name = ? AND deleted_at IS NULL ORDER BY priority DESC, id")
    .all(sessionName) as RouteRow[];
  return rows.map(rowToRoute);
}

/**
 * Rename active route session references after a canonical session rename.
 */
export function dbRenameRouteSessionName(oldName: string, newName: string): number {
  getDb()
    .prepare("UPDATE routes SET session_name = ?, updated_at = ? WHERE session_name = ? AND deleted_at IS NULL")
    .run(newName, Date.now(), oldName);
  return getDbChanges();
}

/**
 * Update an existing route
 */
export function dbUpdateRoute(pattern: string, updates: Partial<RouteConfig>, accountId: string): RouteConfig {
  const s = getStatements();
  const row = s.getRoute.get(pattern, accountId) as RouteRow | undefined;

  if (!row) {
    throw new Error(`Route not found: ${pattern} (account: ${accountId})`);
  }

  // Verify agent if updating
  if (updates.agent && !dbGetAgent(updates.agent)) {
    throw new Error(`Agent not found: ${updates.agent}`);
  }

  // Validate dmScope if provided
  if (updates.dmScope !== undefined) {
    DmScopeSchema.parse(updates.dmScope);
  }

  const now = Date.now();
  s.updateRoute.run(
    updates.agent ?? row.agent_id,
    updates.dmScope !== undefined ? (updates.dmScope ?? null) : row.dm_scope,
    updates.session !== undefined ? (updates.session ?? null) : row.session_name,
    updates.policy !== undefined ? (updates.policy ?? null) : row.policy,
    updates.priority ?? row.priority,
    updates.channel !== undefined ? (updates.channel ?? null) : row.channel,
    now,
    pattern,
    accountId,
  );

  log.info("Updated route", { pattern, accountId });
  return dbGetRoute(pattern, accountId)!;
}

/**
 * Soft-delete a route (sets deleted_at, keeps row for audit/recovery).
 */
export function dbDeleteRoute(pattern: string, accountId: string): boolean {
  const s = getStatements();
  const route = dbGetRoute(pattern, accountId);
  if (!route) return false;
  const now = Date.now();
  s.softDeleteRoute.run(now, pattern, accountId);
  if (getDbChanges() > 0) {
    s.insertAuditLog.run(
      "route.deleted",
      "route",
      `${pattern}@${accountId}`,
      JSON.stringify(route),
      process.env.USER ?? "daemon",
      now,
    );
    log.info("Soft-deleted route", { pattern, accountId });
    return true;
  }
  return false;
}

/**
 * Restore a soft-deleted route.
 */
export function dbRestoreRoute(pattern: string, accountId: string): boolean {
  const s = getStatements();
  const now = Date.now();
  s.restoreRoute.run(pattern, accountId);
  if (getDbChanges() > 0) {
    s.insertAuditLog.run("route.restored", "route", `${pattern}@${accountId}`, null, process.env.USER ?? "daemon", now);
    log.info("Restored route", { pattern, accountId });
    return true;
  }
  return false;
}

/**
 * List soft-deleted routes (for recovery/audit).
 */
export function dbListDeletedRoutes(accountId?: string): RouteConfig[] {
  const s = getStatements();
  const rows = (accountId ? s.listDeletedRoutesByAccount.all(accountId) : s.listDeletedRoutes.all()) as RouteRow[];
  return rows.map(rowToRoute);
}

// ============================================================================
// Settings
// ============================================================================

/**
 * Get a setting value
 */
export function dbGetSetting(key: string): string | null {
  const s = getStatements();
  const row = s.getSetting.get(key) as SettingRow | undefined;
  return row?.value ?? null;
}

/**
 * Set a setting value
 */
export function dbSetSetting(key: string, value: string): void {
  // Validate specific settings
  if (key === "defaultDmScope") {
    DmScopeSchema.parse(value);
  }
  if (key === "defaultAgent") {
    if (!dbGetAgent(value)) {
      throw new Error(`Agent not found: ${value}`);
    }
  }

  const s = getStatements();
  const now = Date.now();
  s.upsertSetting.run(key, value, now);
  log.info("Set setting", { key, value });
}

/**
 * Delete a setting
 */
export function dbDeleteSetting(key: string): boolean {
  const s = getStatements();
  s.deleteSetting.run(key);
  return getDbChanges() > 0;
}

/**
 * List all settings
 */
export function dbListSettings(): Record<string, string> {
  const s = getStatements();
  const rows = s.listSettings.all() as SettingRow[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// ============================================================================
// Skill Gate Rule CRUD
// ============================================================================

function cleanOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function rowToSkillGateRule(row: SkillGateRuleRow): DbSkillGateRule {
  return {
    id: row.id,
    ...(row.skill !== null ? { skill: row.skill } : {}),
    disabled: row.disabled === 1,
    ...(row.pattern !== null ? { pattern: row.pattern } : {}),
    ...(row.group_regex !== null ? { groupRegex: row.group_regex } : {}),
    ...(row.tool !== null ? { tool: row.tool } : {}),
    ...(row.tool_prefix !== null ? { toolPrefix: row.tool_prefix } : {}),
    ...(row.tool_regex !== null ? { toolRegex: row.tool_regex } : {}),
    ...(row.command !== null ? { command: row.command } : {}),
    ...(row.command_prefix !== null ? { commandPrefix: row.command_prefix } : {}),
    ...(row.command_regex !== null ? { commandRegex: row.command_regex } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function dbListSkillGateRules(): DbSkillGateRule[] {
  const s = getStatements();
  return (s.listSkillGateRules.all() as SkillGateRuleRow[]).map(rowToSkillGateRule);
}

export function dbGetSkillGateRule(id: string): DbSkillGateRule | null {
  const s = getStatements();
  const row = s.getSkillGateRule.get(id) as SkillGateRuleRow | undefined;
  return row ? rowToSkillGateRule(row) : null;
}

export function dbUpsertSkillGateRule(input: DbSkillGateRuleInput): DbSkillGateRule {
  const id = cleanOptionalText(input.id);
  if (!id) {
    throw new Error("Skill gate rule id is required.");
  }

  const s = getStatements();
  const existing = dbGetSkillGateRule(id);
  const now = Date.now();
  s.upsertSkillGateRule.run(
    id,
    cleanOptionalText(input.skill),
    input.disabled === true ? 1 : 0,
    cleanOptionalText(input.pattern),
    cleanOptionalText(input.groupRegex),
    cleanOptionalText(input.tool),
    cleanOptionalText(input.toolPrefix),
    cleanOptionalText(input.toolRegex),
    cleanOptionalText(input.command),
    cleanOptionalText(input.commandPrefix),
    cleanOptionalText(input.commandRegex),
    existing?.createdAt ?? now,
    now,
  );
  log.info("Upserted skill gate rule", {
    id,
    disabled: input.disabled === true,
  });
  return dbGetSkillGateRule(id)!;
}

export function dbDeleteSkillGateRule(id: string): boolean {
  const cleanId = cleanOptionalText(id);
  if (!cleanId) {
    return false;
  }

  const s = getStatements();
  s.deleteSkillGateRule.run(cleanId);
  return getDbChanges() > 0;
}

// ============================================================================
// Instance CRUD
// ============================================================================

export function dbUpsertInstance(input: z.input<typeof InstanceInputSchema>): InstanceConfig {
  const validated = InstanceInputSchema.parse(input);
  if (validated.agent && !dbGetAgent(validated.agent)) {
    throw new Error(`Agent not found: ${validated.agent}`);
  }
  const s = getStatements();
  const now = Date.now();
  const normalizedTags = validated.defaultContactTags
    ? Array.from(new Set(validated.defaultContactTags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)))
    : null;
  s.upsertInstance.run(
    validated.name,
    validated.instanceId ?? null,
    validated.channel,
    validated.agent ?? null,
    validated.dmPolicy,
    validated.groupPolicy,
    validated.contactIntakeMode,
    validated.dmScope ?? null,
    validated.enabled ? 1 : 0,
    validated.defaults ? JSON.stringify(validated.defaults) : null,
    normalizedTags && normalizedTags.length > 0 ? JSON.stringify(normalizedTags) : null,
    now,
    now,
  );
  log.info("Upserted instance", { name: validated.name });
  return dbGetInstance(validated.name)!;
}

export function dbGetInstance(name: string): InstanceConfig | null {
  const s = getStatements();
  const row = s.getInstanceByName.get(name) as InstanceRow | undefined;
  return row ? rowToInstance(row) : null;
}

export function dbGetInstanceByInstanceId(instanceId: string): InstanceConfig | null {
  const s = getStatements();
  const row = s.getInstanceByInstanceId.get(instanceId) as InstanceRow | undefined;
  return row ? rowToInstance(row) : null;
}

export function dbListInstances(): InstanceConfig[] {
  const s = getStatements();
  const rows = s.listInstances.all() as InstanceRow[];
  return rows.map(rowToInstance);
}

export function dbUpdateInstance(
  name: string,
  updates: Partial<Omit<InstanceConfig, "name" | "createdAt" | "updatedAt" | "defaults" | "defaultContactTags">> & {
    defaults?: Record<string, unknown> | null;
    defaultContactTags?: string[] | null;
  },
): InstanceConfig {
  const s = getStatements();
  const row = s.getInstanceByName.get(name) as InstanceRow | undefined;
  if (!row) throw new Error(`Instance not found: ${name}`);
  if (updates.agent && !dbGetAgent(updates.agent)) {
    throw new Error(`Agent not found: ${updates.agent}`);
  }
  if (updates.dmScope) DmScopeSchema.parse(updates.dmScope);
  if (updates.dmPolicy) DmPolicySchema.parse(updates.dmPolicy);
  if (updates.groupPolicy) GroupPolicySchema.parse(updates.groupPolicy);
  if (updates.contactIntakeMode) ContactIntakeModeSchema.parse(updates.contactIntakeMode);
  const now = Date.now();
  let nextDefaultContactTags: string | null;
  if (updates.defaultContactTags !== undefined) {
    if (updates.defaultContactTags === null) {
      nextDefaultContactTags = null;
    } else {
      const normalized = Array.from(
        new Set(updates.defaultContactTags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)),
      );
      nextDefaultContactTags = normalized.length > 0 ? JSON.stringify(normalized) : null;
    }
  } else {
    nextDefaultContactTags = row.default_contact_tags ?? null;
  }
  s.updateInstance.run(
    updates.instanceId !== undefined ? (updates.instanceId ?? null) : row.instance_id,
    updates.channel ?? row.channel,
    updates.agent !== undefined ? (updates.agent ?? null) : row.agent,
    updates.dmPolicy ?? row.dm_policy,
    updates.groupPolicy ?? row.group_policy,
    updates.contactIntakeMode ?? row.contact_intake_mode ?? "off",
    updates.dmScope !== undefined ? (updates.dmScope ?? null) : row.dm_scope,
    updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (row.enabled ?? 1),
    updates.defaults !== undefined ? (updates.defaults ? JSON.stringify(updates.defaults) : null) : row.defaults,
    nextDefaultContactTags,
    now,
    name,
  );
  log.info("Updated instance", { name, ...updates });
  return dbGetInstance(name)!;
}

/**
 * Soft-delete an instance (sets deleted_at, keeps row for audit/recovery).
 */
export function dbDeleteInstance(name: string): boolean {
  const s = getStatements();
  const inst = dbGetInstance(name);
  if (!inst) return false;
  const now = Date.now();
  s.softDeleteInstance.run(now, name);
  if (getDbChanges() > 0) {
    s.insertAuditLog.run("instance.deleted", "instance", name, JSON.stringify(inst), process.env.USER ?? "daemon", now);
    log.info("Soft-deleted instance", { name });
    return true;
  }
  return false;
}

/**
 * Restore a soft-deleted instance.
 */
export function dbRestoreInstance(name: string): boolean {
  const s = getStatements();
  const now = Date.now();
  s.restoreInstance.run(name);
  if (getDbChanges() > 0) {
    s.insertAuditLog.run("instance.restored", "instance", name, null, process.env.USER ?? "daemon", now);
    log.info("Restored instance", { name });
    return true;
  }
  return false;
}

/**
 * List soft-deleted instances (for recovery/audit).
 */
export function dbListDeletedInstances(): InstanceConfig[] {
  const s = getStatements();
  return (s.listDeletedInstances.all() as InstanceRow[]).map(rowToInstance);
}

// ============================================================================
// Context Registry
// ============================================================================

export function dbCreateContext(input: z.input<typeof ContextInputSchema>): ContextRecord {
  const validated = ContextInputSchema.parse(input);
  if (validated.agentId && !dbGetAgent(validated.agentId)) {
    throw new Error(`Agent not found: ${validated.agentId}`);
  }

  const s = getStatements();
  const createdAt = validated.createdAt ?? Date.now();

  try {
    s.insertContext.run(
      validated.contextId,
      validated.contextKey,
      validated.kind,
      validated.agentId ?? null,
      validated.sessionKey ?? null,
      validated.sessionName ?? null,
      validated.source ? JSON.stringify(validated.source) : null,
      JSON.stringify(validated.capabilities),
      validated.metadata ? JSON.stringify(validated.metadata) : null,
      createdAt,
      validated.expiresAt ?? null,
      validated.lastUsedAt ?? null,
      validated.revokedAt ?? null,
    );
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE constraint failed")) {
      throw new Error(`Context already exists: ${validated.contextId}`);
    }
    throw err;
  }

  return dbGetContext(validated.contextId)!;
}

export function dbGetContext(contextId: string): ContextRecord | null {
  const s = getStatements();
  const row = s.getContextById.get(contextId) as ContextRow | undefined;
  return row ? rowToContext(row) : null;
}

export function dbGetContextByKey(contextKey: string): ContextRecord | null {
  const s = getStatements();
  const row = s.getContextByKey.get(contextKey) as ContextRow | undefined;
  return row ? rowToContext(row) : null;
}

export function dbGetContextByKeyReadOnly(contextKey: string): ContextRecord | null {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) return null;

  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    const row = db.prepare("SELECT * FROM contexts WHERE context_key = ?").get(contextKey) as ContextRow | undefined;
    return row ? rowToContext(row) : null;
  } catch (error) {
    if (error instanceof Error && /no such table: contexts/i.test(error.message)) {
      return null;
    }
    throw error;
  } finally {
    db.close();
  }
}

export function dbListContexts(options: ListContextsOptions = {}): ContextRecord[] {
  const s = getStatements();
  const now = Date.now();
  const rows = s.listContexts.all() as ContextRow[];

  return rows
    .map((row) => rowToContext(row))
    .filter((context) => {
      if (options.agentId && context.agentId !== options.agentId) return false;
      if (options.sessionKey && context.sessionKey !== options.sessionKey) return false;
      if (options.kind && context.kind !== options.kind) return false;

      if (!options.includeInactive) {
        if (context.revokedAt && context.revokedAt <= now) return false;
        if (context.expiresAt && context.expiresAt <= now) return false;
      }

      return true;
    });
}

export function dbTouchContext(contextId: string, lastUsedAt = Date.now()): void {
  const s = getStatements();
  s.touchContext.run(lastUsedAt, contextId);
}

export function dbUpdateContextRuntimeState(
  contextId: string,
  input: {
    sessionName?: string;
    source?: ContextSource;
    metadata?: Record<string, unknown>;
  },
  lastUsedAt = Date.now(),
): ContextRecord {
  if (!dbGetContext(contextId)) {
    throw new Error(`Context not found: ${contextId}`);
  }
  const source = input.source === undefined ? undefined : ContextSourceSchema.parse(input.source);
  const metadata = input.metadata === undefined ? undefined : z.record(z.string(), z.unknown()).parse(input.metadata);
  const s = getStatements();
  s.updateContextRuntimeState.run(
    input.sessionName ?? null,
    source ? JSON.stringify(source) : null,
    metadata ? JSON.stringify(metadata) : null,
    lastUsedAt,
    contextId,
  );
  return dbGetContext(contextId)!;
}

export interface RevokeContextOptions {
  revokedAt?: number;
  cascade?: boolean;
  reason?: string;
}

export interface RevokeContextResult {
  context: ContextRecord;
  cascaded: ContextRecord[];
  revokedAt: number;
}

/**
 * Revoke a context. By default cascades to all descendants (children whose
 * `metadata.parentContextId` chains back to this context) within one
 * transaction; the same `revokedAt` timestamp is applied to every record.
 *
 * Pass `cascade: false` only when rotating a parent without invalidating
 * already-issued workers. The CLI surface should require an opt-in flag and
 * emit a warning before calling this with cascade disabled.
 */
export function dbRevokeContextCascade(contextId: string, options: RevokeContextOptions = {}): RevokeContextResult {
  const root = dbGetContext(contextId);
  if (!root) {
    throw new Error(`Context not found: ${contextId}`);
  }
  const revokedAt = options.revokedAt ?? Date.now();
  const cascade = options.cascade !== false;
  const s = getStatements();

  const targets: ContextRecord[] = [root];
  if (cascade) {
    const allRows = s.listContexts.all() as ContextRow[];
    const all = allRows.map((row) => rowToContext(row));
    const childrenByParent = new Map<string, ContextRecord[]>();
    for (const ctx of all) {
      const parentId = typeof ctx.metadata?.parentContextId === "string" ? ctx.metadata.parentContextId : null;
      if (!parentId) continue;
      const list = childrenByParent.get(parentId) ?? [];
      list.push(ctx);
      childrenByParent.set(parentId, list);
    }

    const visited = new Set<string>([root.contextId]);
    const queue: string[] = [root.contextId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = childrenByParent.get(current) ?? [];
      for (const child of children) {
        if (visited.has(child.contextId)) continue;
        visited.add(child.contextId);
        targets.push(child);
        queue.push(child.contextId);
      }
    }
  }

  const db = getDb();
  const reasonNote = options.reason?.trim();
  const reasonKey = "revocationReason";
  const cascadeKey = "cascadedFrom";
  const cascadeFlagKey = "revokedViaCascade";
  const cascadeRootKey = "cascadeRootContextId";

  executeWrite(
    db,
    (database) => {
      for (const target of targets) {
        // Skip if already revoked at the same or earlier timestamp (idempotency).
        if (target.revokedAt && target.revokedAt <= revokedAt) {
          // Still update metadata if a reason or cascade flag should be set.
        }
        const metadata: Record<string, unknown> = {
          ...(target.metadata ?? {}),
        };
        if (reasonNote) {
          metadata[reasonKey] = reasonNote;
        }
        if (target.contextId !== root.contextId) {
          metadata[cascadeFlagKey] = true;
          metadata[cascadeRootKey] = root.contextId;
          const chain = Array.isArray(metadata[cascadeKey]) ? (metadata[cascadeKey] as unknown[]) : [];
          if (!chain.includes(root.contextId)) {
            chain.push(root.contextId);
          }
          metadata[cascadeKey] = chain;
        }

        database
          .prepare(`UPDATE contexts SET revoked_at = ?, metadata_json = ? WHERE context_id = ?`)
          .run(revokedAt, JSON.stringify(metadata), target.contextId);
      }
    },
    { label: "router:revokeContextCascade" },
  );

  const finalRoot = dbGetContext(contextId)!;
  const cascaded: ContextRecord[] = [];
  for (const target of targets) {
    if (target.contextId === root.contextId) continue;
    const refreshed = dbGetContext(target.contextId);
    if (refreshed) cascaded.push(refreshed);
  }
  return { context: finalRoot, cascaded, revokedAt };
}

export function dbRevokeContext(contextId: string, revokedAt = Date.now()): ContextRecord {
  const result = dbRevokeContextCascade(contextId, {
    revokedAt,
    cascade: false,
  });
  return result.context;
}

export function dbUpdateContextCapabilities(contextId: string, capabilities: ContextCapability[]): ContextRecord {
  const s = getStatements();
  if (!dbGetContext(contextId)) {
    throw new Error(`Context not found: ${contextId}`);
  }
  const validated = z.array(ContextCapabilitySchema).parse(capabilities);
  s.updateContextCapabilities.run(JSON.stringify(validated), Date.now(), contextId);
  return dbGetContext(contextId)!;
}

export function dbDeleteContext(contextId: string): boolean {
  const s = getStatements();
  s.deleteContext.run(contextId);
  return getDbChanges() > 0;
}

export interface PruneContextsResult {
  matched: number;
  pruned: number;
}

/**
 * Compact the context store by deleting inactive (revoked or expired) runtime
 * contexts older than the retention cutoff. Active contexts are never removed,
 * so pruning cannot drop live authority. Timestamps are epoch milliseconds.
 */
export function dbPruneContexts(options: { apply?: boolean; olderThanMs?: number } = {}): PruneContextsResult {
  const now = Date.now();
  const cutoff = options.olderThanMs != null ? now - Math.max(0, options.olderThanMs) : now;
  const prunable = dbListContexts({ includeInactive: true }).filter((context) => {
    const inactive =
      (context.revokedAt != null && context.revokedAt <= now) ||
      (context.expiresAt != null && context.expiresAt <= now);
    return inactive && context.createdAt <= cutoff;
  });

  if (options.apply === true) {
    for (const context of prunable) {
      dbDeleteContext(context.contextId);
    }
  }

  return { matched: prunable.length, pruned: options.apply === true ? prunable.length : 0 };
}

// ============================================================================
// Convenience Getters
// ============================================================================

/**
 * Get default agent ID
 */
export function getDefaultAgentId(): string {
  return dbGetSetting("defaultAgent") ?? "main";
}

/**
 * Get default DM scope
 */
export function getDefaultDmScope(): DmScope {
  const value = dbGetSetting("defaultDmScope");
  if (value === null) {
    return "per-peer";
  }
  const parsed = DmScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : "per-peer";
}

/**
 * Get default timezone for cron jobs
 */
export function getDefaultTimezone(): string | undefined {
  return dbGetSetting("defaultTimezone") ?? undefined;
}

/**
 * Get the first registered instance name.
 */
export function getFirstAccountName(): string | undefined {
  const instances = dbListInstances();
  return instances.find((instance) => instance.enabled !== false)?.name;
}

/**
 * Get the instance name explicitly mapped to a specific agent.
 *
 * Returns `undefined` when no enabled instance is mapped to the agent.
 * Previously this fell back to "first enabled instance", which silently
 * picked an unrelated account in multi-account setups and caused outbound
 * deliveries to fail with "chat not found". Callers that genuinely want a
 * best-effort guess must opt in explicitly.
 */
export function getAccountForAgent(agentId: string): string | undefined {
  const instances = dbListInstances();
  return instances.find((instance) => instance.enabled !== false && instance.agent === agentId)?.name;
}

/**
 * Whether to announce compaction start/end to the active session's channel.
 * Setting value: "true" or "false" (default: "true")
 */
export function getAnnounceCompaction(): boolean {
  return dbGetSetting("announceCompaction") !== "false";
}

// ============================================================================
// Database Management
// ============================================================================

/**
 * Close the database connection
 */
export function closeRouterDb(): void {
  if (routerDbState.db !== null) {
    routerDbState.db.close();
    routerDbState.db = null;
    routerDbState.stmts = null;
    routerDbState.dbPath = null;
  }
}

/**
 * Get the shared database connection (for sessions.ts)
 */
export { getDb, getDbChanges };

/**
 * Get the database path
 */
export function getRaviDbPath(): string {
  return resolveDbPath();
}

/**
 * Get the ravi directory
 */
export function getRaviDir(): string {
  return getRaviStateDir();
}

// ============================================================================
// Matrix Accounts (all Matrix users - both regular users and agents)
// ============================================================================

function rowToMatrixAccount(row: MatrixAccountRow): MatrixAccount {
  const result: MatrixAccount = {
    username: row.username,
    userId: row.user_id,
    homeserver: row.homeserver,
    accessToken: row.access_token,
    createdAt: row.created_at,
  };
  if (row.device_id) result.deviceId = row.device_id;
  if (row.last_used_at) result.lastUsedAt = row.last_used_at;
  return result;
}

/**
 * Add or update a Matrix account
 */
export function dbUpsertMatrixAccount(account: Omit<MatrixAccount, "createdAt" | "lastUsedAt">): MatrixAccount {
  const s = getStatements();
  const existing = s.getMatrixAccount.get(account.username) as MatrixAccountRow | undefined;
  const now = Date.now();

  s.upsertMatrixAccount.run(
    account.username,
    account.userId,
    account.homeserver,
    account.accessToken,
    account.deviceId ?? null,
    existing?.created_at ?? now,
    now,
  );

  log.info("Upserted matrix account", {
    username: account.username,
    userId: account.userId,
  });
  return dbGetMatrixAccount(account.username)!;
}

/**
 * Get a Matrix account by username
 */
export function dbGetMatrixAccount(username: string): MatrixAccount | null {
  const s = getStatements();
  const row = s.getMatrixAccount.get(username) as MatrixAccountRow | undefined;
  return row ? rowToMatrixAccount(row) : null;
}

/**
 * List all Matrix accounts
 */
export function dbListMatrixAccounts(): MatrixAccount[] {
  const s = getStatements();
  const rows = s.listMatrixAccounts.all() as MatrixAccountRow[];
  return rows.map(rowToMatrixAccount);
}

/**
 * Delete a Matrix account
 */
export function dbDeleteMatrixAccount(username: string): boolean {
  // Check if any agent references this account
  const agents = dbListAgents();
  const referencingAgent = agents.find((a) => a.matrixAccount === username);
  if (referencingAgent) {
    throw new Error(`Cannot delete: account is used by agent "${referencingAgent.id}"`);
  }

  const s = getStatements();
  s.deleteMatrixAccount.run(username);
  if (getDbChanges() > 0) {
    log.info("Deleted matrix account", { username });
    return true;
  }
  return false;
}

/**
 * Touch a Matrix account (update last_used_at)
 */
export function dbTouchMatrixAccount(username: string): void {
  const s = getStatements();
  s.touchMatrixAccount.run(Date.now(), username);
}

/**
 * Get Matrix account for an agent
 */
export function dbGetAgentMatrixAccount(agentId: string): MatrixAccount | null {
  const agent = dbGetAgent(agentId);
  if (!agent?.matrixAccount) return null;
  return dbGetMatrixAccount(agent.matrixAccount);
}

// ============================================================================
// Message Metadata (transcriptions + media paths for reply reinjection)
// ============================================================================

export interface MessageMetadata {
  messageId: string;
  chatId: string;
  canonicalChatId?: string;
  actorType?: "contact" | "agent" | "system" | "unknown" | string;
  contactId?: string;
  agentId?: string;
  platformIdentityId?: string;
  rawSenderId?: string;
  normalizedSenderId?: string;
  identityConfidence?: number;
  identityProvenance?: Record<string, unknown>;
  transcription?: string;
  mediaPath?: string;
  mediaType?: string;
  createdAt: number;
}

interface MessageMetadataRow {
  message_id: string;
  chat_id: string;
  canonical_chat_id: string | null;
  actor_type: string | null;
  contact_id: string | null;
  agent_id: string | null;
  platform_identity_id: string | null;
  raw_sender_id: string | null;
  normalized_sender_id: string | null;
  identity_confidence: number | null;
  identity_provenance_json: string | null;
  transcription: string | null;
  media_path: string | null;
  media_type: string | null;
  created_at: number;
}

export interface MessageMetadataPage extends ListPage<MessageMetadata> {
  contactId: string;
}

function rowToMessageMetadata(row: MessageMetadataRow): MessageMetadata {
  return {
    messageId: row.message_id,
    chatId: row.chat_id,
    canonicalChatId: row.canonical_chat_id ?? undefined,
    actorType: row.actor_type ?? undefined,
    contactId: row.contact_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    platformIdentityId: row.platform_identity_id ?? undefined,
    rawSenderId: row.raw_sender_id ?? undefined,
    normalizedSenderId: row.normalized_sender_id ?? undefined,
    identityConfidence: row.identity_confidence ?? undefined,
    identityProvenance: parseJsonRecord(row.identity_provenance_json),
    transcription: row.transcription ?? undefined,
    mediaPath: row.media_path ?? undefined,
    mediaType: row.media_type ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Store message metadata (transcription/media path).
 * Upserts — safe to call multiple times for the same message.
 */
export function dbSaveMessageMeta(
  messageId: string,
  chatId: string,
  opts: {
    canonicalChatId?: string;
    actorType?: string;
    contactId?: string;
    agentId?: string;
    platformIdentityId?: string;
    rawSenderId?: string;
    normalizedSenderId?: string;
    identityConfidence?: number;
    identityProvenance?: Record<string, unknown>;
    transcription?: string;
    mediaPath?: string;
    mediaType?: string;
  },
): void {
  const s = getStatements();
  s.upsertMessageMeta.run(
    messageId,
    chatId,
    opts.canonicalChatId ?? null,
    opts.actorType ?? null,
    opts.contactId ?? null,
    opts.agentId ?? null,
    opts.platformIdentityId ?? null,
    opts.rawSenderId ?? null,
    opts.normalizedSenderId ?? null,
    opts.identityConfidence ?? null,
    cleanJsonRecord(opts.identityProvenance),
    opts.transcription ?? null,
    opts.mediaPath ?? null,
    opts.mediaType ?? null,
    Date.now(),
  );
}

/**
 * Get message metadata by message ID.
 */
export function dbGetMessageMeta(messageId: string): MessageMetadata | null {
  const s = getStatements();
  const row = s.getMessageMeta.get(messageId) as MessageMetadataRow | null;
  return row ? rowToMessageMetadata(row) : null;
}

export function dbListMessageMetaByChatId(chatId: string, limit = 50): MessageMetadata[] {
  const s = getStatements();
  const rows = s.listMessageMetaByChatId.all(chatId, limit) as MessageMetadataRow[];
  return rows.reverse().map(rowToMessageMetadata);
}

export function dbListMessageMetaByContactId(
  contactId: string,
  options: {
    limit?: number | string | null;
    offset?: number | string | null;
  } = {},
): MessageMetadataPage {
  const { limit, offset } = normalizeLimitOffsetPage(options, {
    defaultLimit: 50,
    maxLimit: 500,
  });
  const db = getDb();
  const total =
    (
      db.prepare("SELECT COUNT(*) AS total FROM message_metadata WHERE contact_id = ?").get(contactId) as
        | { total: number }
        | undefined
    )?.total ?? 0;
  const rows = db
    .prepare("SELECT * FROM message_metadata WHERE contact_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(contactId, limit, offset) as MessageMetadataRow[];
  return {
    contactId,
    total,
    limit,
    offset,
    items: rows.map(rowToMessageMetadata),
  };
}

const MESSAGE_META_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_EVENTS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — daily rollup preserves aggregate metrics
const SESSION_TRACE_BLOBS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — keep blob TTL aligned with events
const AUDIT_LOG_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const COST_EVENTS_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const TRACE_EXPORT_CURSOR_DOMAIN = "runtime_trace";
const TRACE_EXPORT_SESSION_EVENTS_CURSOR = "session_events_enqueued";

function getTraceExportSessionEventsCursor(db: Database): number | null {
  const row = db
    .prepare("SELECT cursor_value FROM sync_cursors WHERE domain = ? AND cursor_key = ?")
    .get(TRACE_EXPORT_CURSOR_DOMAIN, TRACE_EXPORT_SESSION_EVENTS_CURSOR) as { cursor_value: string | null } | undefined;
  if (!row?.cursor_value) return null;
  const cursor = Number(row.cursor_value);
  return Number.isFinite(cursor) && cursor >= 0 ? cursor : null;
}

/**
 * Delete message metadata older than 7 days.
 * Returns number of rows deleted.
 */
export function dbCleanupMessageMeta(): number {
  const s = getStatements();
  s.cleanupMessageMeta.run(Date.now() - MESSAGE_META_TTL_MS);
  return getDbChanges();
}

/**
 * Hard-delete ephemeral sessions that have already expired.
 * Safe to call at any time — idempotent, only removes rows with expires_at <= now.
 * Returns number of rows deleted.
 */
export function dbCleanupExpiredSessions(): number {
  const s = getStatements();
  s.cleanupExpiredSessions.run(Date.now());
  return getDbChanges();
}

export interface DbPruneResult {
  messageMetadata: number;
  sessionEvents: number;
  sessionTraceBlobs: number;
  auditLog: number;
  costEvents: number;
  expiredSessions: number;
  vacuumed: boolean;
  vacuumedBytesReclaimed?: number;
  walCheckpointed: boolean;
}

export interface DbPruneOptions {
  vacuum?: boolean;
  dryRun?: boolean;
  walCheckpoint?: boolean;
  now?: number;
}

/**
 * Prune stale rows from large tables.
 *
 * In dry-run mode, returns the row counts that WOULD be deleted (no writes).
 *
 * In live mode, runs each delete in its own transaction so a slow path doesn't
 * block subsequent prunes if the daemon is under load. After pruning, optionally
 * runs `PRAGMA wal_checkpoint(PASSIVE)` to drain the WAL and `VACUUM` to reclaim
 * file space (rewrites the file — slow but reclaims megabytes).
 */
export function dbPruneStaleRows(options: DbPruneOptions = {}): DbPruneResult {
  const db = getDb();
  const now = options.now ?? Date.now();
  const traceExportCursor = getTraceExportSessionEventsCursor(db);
  const result: DbPruneResult = {
    messageMetadata: 0,
    sessionEvents: 0,
    sessionTraceBlobs: 0,
    auditLog: 0,
    costEvents: 0,
    expiredSessions: 0,
    vacuumed: false,
    walCheckpointed: false,
  };

  if (options.dryRun) {
    const count = (sql: string, threshold: number): number =>
      Number((db.prepare(sql).get(threshold) as { c: number }).c ?? 0);
    const countSessionEvents = (): number => {
      if (traceExportCursor === null) {
        return count("SELECT COUNT(*) AS c FROM session_events WHERE timestamp < ?", now - SESSION_EVENTS_TTL_MS);
      }
      return Number(
        (
          db
            .prepare("SELECT COUNT(*) AS c FROM session_events WHERE timestamp < ? AND id <= ?")
            .get(now - SESSION_EVENTS_TTL_MS, traceExportCursor) as {
            c: number;
          }
        ).c ?? 0,
      );
    };
    result.messageMetadata = count(
      "SELECT COUNT(*) AS c FROM message_metadata WHERE created_at < ?",
      now - MESSAGE_META_TTL_MS,
    );
    result.sessionEvents = countSessionEvents();
    result.sessionTraceBlobs = count(
      "SELECT COUNT(*) AS c FROM session_trace_blobs WHERE created_at < ?",
      now - SESSION_TRACE_BLOBS_TTL_MS,
    );
    result.auditLog = count("SELECT COUNT(*) AS c FROM audit_log WHERE ts < ?", now - AUDIT_LOG_TTL_MS);
    result.costEvents = count("SELECT COUNT(*) AS c FROM cost_events WHERE created_at < ?", now - COST_EVENTS_TTL_MS);
    result.expiredSessions = count(
      "SELECT COUNT(*) AS c FROM sessions WHERE ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ?",
      now,
    );
    return result;
  }

  // Each delete runs in its own implicit transaction. We deliberately don't
  // wrap them in a single BEGIN/COMMIT — a long single transaction is a worse
  // lock-contention risk than several short ones.
  const runDelete = (sql: string, threshold: number): number => {
    db.prepare(sql).run(threshold);
    return getDbChanges();
  };
  const deleteSessionEvents = (): number => {
    if (traceExportCursor === null) {
      return runDelete("DELETE FROM session_events WHERE timestamp < ?", now - SESSION_EVENTS_TTL_MS);
    }
    db.prepare("DELETE FROM session_events WHERE timestamp < ? AND id <= ?").run(
      now - SESSION_EVENTS_TTL_MS,
      traceExportCursor,
    );
    return getDbChanges();
  };

  result.messageMetadata = runDelete("DELETE FROM message_metadata WHERE created_at < ?", now - MESSAGE_META_TTL_MS);
  result.sessionEvents = deleteSessionEvents();
  result.sessionTraceBlobs = runDelete(
    "DELETE FROM session_trace_blobs WHERE created_at < ?",
    now - SESSION_TRACE_BLOBS_TTL_MS,
  );
  result.auditLog = runDelete("DELETE FROM audit_log WHERE ts < ?", now - AUDIT_LOG_TTL_MS);
  result.costEvents = runDelete("DELETE FROM cost_events WHERE created_at < ?", now - COST_EVENTS_TTL_MS);
  result.expiredSessions = dbCleanupExpiredSessions();

  if (options.walCheckpoint) {
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    result.walCheckpointed = true;
  }

  if (options.vacuum) {
    const before = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
    const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size;
    db.exec("VACUUM");
    const after = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
    result.vacuumed = true;
    result.vacuumedBytesReclaimed = Math.max(0, (before - after) * pageSize);
  }

  return result;
}

// ============================================================================
// Audit Log
// ============================================================================

export interface AuditEntry {
  id: number;
  action: string;
  entity: string;
  entityId: string;
  oldValue: unknown | null;
  actor: string;
  ts: number;
}

// ============================================================================
// Cost Events
// ============================================================================

export interface CostEvent {
  id: number;
  sessionKey: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCostUsd: number;
  totalCostUsd: number;
  pricingStatus?: string | null;
  pricingSource?: string | null;
  pricingSourceUrl?: string | null;
  pricingSourceVersion?: string | null;
  pricingFetchedAt?: number | null;
  pricingModel?: string | null;
  pricingError?: string | null;
  createdAt: number;
}

/**
 * Insert a cost event for a single turn.
 */
export function dbInsertCostEvent(event: Omit<CostEvent, "id">): void {
  const s = getStatements();
  s.insertCostEvent.run(
    event.sessionKey,
    event.agentId,
    event.model,
    event.inputTokens,
    event.outputTokens,
    event.cacheReadTokens,
    event.cacheCreationTokens,
    event.inputCostUsd,
    event.outputCostUsd,
    event.cacheCostUsd,
    event.totalCostUsd,
    event.pricingStatus ?? "legacy",
    event.pricingSource ?? null,
    event.pricingSourceUrl ?? null,
    event.pricingSourceVersion ?? null,
    event.pricingFetchedAt ?? null,
    event.pricingModel ?? null,
    event.pricingError ?? null,
    event.createdAt,
  );
}

interface CostSummaryRow {
  total_cost: number;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_creation: number;
  turns: number;
}

interface AgentCostRow extends CostSummaryRow {
  agent_id: string;
  model: string;
}

interface SessionCostRow extends CostSummaryRow {
  session_key: string;
}

export interface CostPricingCoverageRow {
  pricing_status: string;
  model: string;
  pricing_model: string | null;
  pricing_source: string | null;
  events: number;
  total_cost: number;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_creation: number;
  last_created_at: number | null;
}

export interface CostEventPricingRecomputeRow {
  id: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  pricing_status: string;
  created_at: number;
}

export interface CostEventPricingUpdate {
  id: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCostUsd: number;
  totalCostUsd: number;
  pricingStatus: string;
  pricingSource?: string | null;
  pricingSourceUrl?: string | null;
  pricingSourceVersion?: string | null;
  pricingFetchedAt?: number | null;
  pricingModel?: string | null;
  pricingError?: string | null;
}

/**
 * Get total cost summary for a time range.
 */
export function dbGetCostSummary(sinceMs: number): CostSummaryRow {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        COALESCE(SUM(total_cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
        COUNT(*) as turns
      FROM cost_events WHERE created_at >= ?`,
    )
    .get(sinceMs) as CostSummaryRow;
}

/**
 * Get cost breakdown by agent for a time range.
 */
export function dbGetCostByAgent(sinceMs: number): AgentCostRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
      agent_id,
      model,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
      COUNT(*) as turns
    FROM cost_events WHERE created_at >= ?
    GROUP BY agent_id, model
    ORDER BY total_cost DESC`,
    )
    .all(sinceMs) as AgentCostRow[];
}

/**
 * Get cost for a specific agent in a time range.
 */
export function dbGetCostForAgent(agentId: string, sinceMs: number): CostSummaryRow {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        COALESCE(SUM(total_cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
        COUNT(*) as turns
      FROM cost_events WHERE agent_id = ? AND created_at >= ?`,
    )
    .get(agentId, sinceMs) as CostSummaryRow;
}

/**
 * Get cost for a specific session.
 */
export function dbGetCostForSession(sessionKey: string): CostSummaryRow {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        COALESCE(SUM(total_cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
        COUNT(*) as turns
      FROM cost_events WHERE session_key = ?`,
    )
    .get(sessionKey) as CostSummaryRow;
}

/**
 * Get top N most expensive sessions in a time range.
 */
export function dbGetTopSessions(sinceMs: number, limit = 10): SessionCostRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
      session_key,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
      COUNT(*) as turns
    FROM cost_events WHERE created_at >= ?
    GROUP BY session_key
    ORDER BY total_cost DESC
    LIMIT ?`,
    )
    .all(sinceMs, limit) as SessionCostRow[];
}

/**
 * Get cost report for a date range (from, to in ms).
 */
export function dbGetCostReport(fromMs: number, toMs: number): AgentCostRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
      agent_id,
      model,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
      COUNT(*) as turns
    FROM cost_events WHERE created_at >= ? AND created_at < ?
    GROUP BY agent_id, model
    ORDER BY total_cost DESC`,
    )
    .all(fromMs, toMs) as AgentCostRow[];
}

/**
 * Audit pricing coverage for recent cost events.
 */
export function dbGetCostPricingCoverage(sinceMs: number): CostPricingCoverageRow[] {
  const db = getDb();
  return db
    .prepare(
      `WITH coverage AS (
      SELECT
        CASE
          WHEN pricing_status = 'priced' AND pricing_source IS NULL AND pricing_model IS NULL THEN 'legacy'
          ELSE pricing_status
        END as pricing_status,
        model,
        pricing_model,
        pricing_source,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        total_cost_usd,
        created_at
      FROM cost_events
      WHERE created_at >= ?
    )
    SELECT
      pricing_status,
      model,
      pricing_model,
      pricing_source,
      COUNT(*) as events,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
      MAX(created_at) as last_created_at
    FROM coverage
    GROUP BY pricing_status, model, pricing_model, pricing_source
    ORDER BY
      CASE pricing_status WHEN 'unpriced' THEN 0 ELSE 1 END,
      events DESC,
      last_created_at DESC`,
    )
    .all(sinceMs) as CostPricingCoverageRow[];
}

export function dbListCostEventsForPricingRecompute(options: {
  sinceMs: number;
  limit: number;
  includePriced?: boolean;
}): CostEventPricingRecomputeRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        id,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        pricing_status,
        created_at
      FROM cost_events
      WHERE created_at >= ?
        AND (
          ? = 1
          OR pricing_status IS NULL
          OR pricing_status != 'priced'
          OR (pricing_status = 'priced' AND pricing_source IS NULL AND pricing_model IS NULL)
        )
      ORDER BY created_at ASC
      LIMIT ?`,
    )
    .all(options.sinceMs, options.includePriced ? 1 : 0, options.limit) as CostEventPricingRecomputeRow[];
}

export function dbUpdateCostEventPricing(update: CostEventPricingUpdate): void {
  const db = getDb();
  db.prepare(
    `UPDATE cost_events
      SET input_cost_usd = ?,
        output_cost_usd = ?,
        cache_cost_usd = ?,
        total_cost_usd = ?,
        pricing_status = ?,
        pricing_source = ?,
        pricing_source_url = ?,
        pricing_source_version = ?,
        pricing_fetched_at = ?,
        pricing_model = ?,
        pricing_error = ?
      WHERE id = ?`,
  ).run(
    update.inputCostUsd,
    update.outputCostUsd,
    update.cacheCostUsd,
    update.totalCostUsd,
    update.pricingStatus,
    update.pricingSource ?? null,
    update.pricingSourceUrl ?? null,
    update.pricingSourceVersion ?? null,
    update.pricingFetchedAt ?? null,
    update.pricingModel ?? null,
    update.pricingError ?? null,
    update.id,
  );
}

/**
 * Read recent audit log entries.
 * @param entity  Filter by entity type ("route" | "instance"). Omit for all.
 * @param limit   Max rows to return (default 100).
 */
export function dbListAuditLog(entity?: string, limit = 100): AuditEntry[] {
  const db = getDb();
  const rows = entity
    ? (db.prepare("SELECT * FROM audit_log WHERE entity = ? ORDER BY ts DESC LIMIT ?").all(entity, limit) as Array<{
        id: number;
        action: string;
        entity: string;
        entity_id: string;
        old_value: string | null;
        actor: string;
        ts: number;
      }>)
    : (db.prepare("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?").all(limit) as Array<{
        id: number;
        action: string;
        entity: string;
        entity_id: string;
        old_value: string | null;
        actor: string;
        ts: number;
      }>);
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    oldValue: r.old_value ? JSON.parse(r.old_value) : null,
    actor: r.actor,
    ts: r.ts,
  }));
}
