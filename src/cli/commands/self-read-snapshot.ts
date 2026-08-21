import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  getRaviDbPath,
  type ChatParticipantRecord,
  type ChatRecord,
  type MessageMetadata,
  type SessionChatBindingRecord,
} from "../../router/router-db.js";
import type { RouteConfig, SessionEntry } from "../../router/types.js";

export interface SelfReadSnapshot {
  session: SessionEntry | null;
  binding: SessionChatBindingRecord | null;
  chat: ChatRecord | null;
  boundRoute: (RouteConfig & { id: number }) | null;
  sessionRoutes: Array<RouteConfig & { id: number }>;
  participants: ChatParticipantRecord[];
  messages: MessageMetadata[];
}

export interface SelfReadSnapshotOptions {
  sessionCandidates: string[];
  sourceChatId?: string | null;
  includeParticipants: boolean;
  messageLimit: number;
}

const EMPTY_SNAPSHOT: SelfReadSnapshot = {
  session: null,
  binding: null,
  chat: null,
  boundRoute: null,
  sessionRoutes: [],
  participants: [],
  messages: [],
};

/**
 * Capture every SQLite-backed SELF fact through one immutable access path.
 *
 * This function deliberately bypasses the shared writable router initializer:
 * it never creates the state directory/database, runs migrations, creates
 * tables, or changes journal mode.
 */
export function readSelfSnapshot(options: SelfReadSnapshotOptions): SelfReadSnapshot {
  const dbPath = getRaviDbPath();
  if (!existsSync(dbPath)) return { ...EMPTY_SNAPSHOT };

  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    db.exec("BEGIN DEFERRED");
    const tables = listTables(db);
    const session = tables.has("sessions") ? findSession(db, options.sessionCandidates) : null;
    const binding = session && tables.has("session_chat_bindings") ? findBinding(db, session.sessionKey) : null;
    const chatId = binding?.chatId ?? options.sourceChatId?.trim() ?? null;
    const chat = chatId && tables.has("chats") ? findChat(db, chatId) : null;
    const boundRoute = binding?.routeId && tables.has("routes") ? findActiveRoute(db, binding.routeId) : null;
    const sessionRoutes = session?.name && tables.has("routes") ? findActiveRoutesBySession(db, session.name) : [];
    const participants =
      options.includeParticipants && chatId && tables.has("chat_participants") ? findParticipants(db, chatId) : [];
    const messages =
      chatId && tables.has("message_metadata") ? findRecentMessages(db, chatId, options.messageLimit) : [];

    return { session, binding, chat, boundRoute, sessionRoutes, participants, messages };
  } finally {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Closing a read-only connection is sufficient if the snapshot never started.
    }
    db.close();
  }
}

function listTables(db: Database): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function findSession(db: Database, candidates: string[]): SessionEntry | null {
  for (const candidate of candidates) {
    const row = db
      .prepare("SELECT * FROM sessions WHERE session_key = ? OR name = ? LIMIT 1")
      .get(candidate, candidate) as SessionRow | undefined;
    if (row) return rowToSession(row);
  }
  return null;
}

function findBinding(db: Database, sessionKey: string): SessionChatBindingRecord | null {
  const row = db.prepare("SELECT * FROM session_chat_bindings WHERE session_key = ?").get(sessionKey) as
    | SessionChatBindingRow
    | undefined;
  return row
    ? {
        sessionKey: row.session_key,
        chatId: row.chat_id,
        agentId: row.agent_id ?? undefined,
        routeId: row.route_id ?? undefined,
        bindingReason: row.binding_reason ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function findChat(db: Database, chatId: string): ChatRecord | null {
  const row = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
  return row
    ? {
        id: row.id,
        channel: row.channel,
        instanceId: row.instance_id,
        platformChatId: row.platform_chat_id,
        normalizedChatId: row.normalized_chat_id,
        actorId: row.actor_id ?? undefined,
        agentId: row.agent_id ?? undefined,
        chatType: row.chat_type as ChatRecord["chatType"],
        title: row.title ?? undefined,
        avatarUrl: row.avatar_url ?? undefined,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function findActiveRoute(db: Database, routeId: number): (RouteConfig & { id: number }) | null {
  const row = db.prepare("SELECT * FROM routes WHERE id = ? AND deleted_at IS NULL").get(routeId) as
    | RouteRow
    | undefined;
  return row ? rowToRoute(row) : null;
}

function findActiveRoutesBySession(db: Database, sessionName: string): Array<RouteConfig & { id: number }> {
  const rows = db
    .prepare("SELECT * FROM routes WHERE session_name = ? AND deleted_at IS NULL ORDER BY priority DESC, id")
    .all(sessionName) as RouteRow[];
  return rows.map(rowToRoute);
}

function findParticipants(db: Database, chatId: string): ChatParticipantRecord[] {
  const rows = db
    .prepare("SELECT * FROM chat_participants WHERE chat_id = ? ORDER BY role, normalized_platform_user_id, id")
    .all(chatId) as ChatParticipantRow[];
  return rows.map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    participantType: row.agent_id ? "agent" : row.contact_id ? "contact" : "raw",
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function findRecentMessages(db: Database, chatId: string, limit: number): MessageMetadata[] {
  const rows = db
    .prepare("SELECT * FROM message_metadata WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(chatId, limit) as MessageMetadataRow[];
  return rows.reverse().map((row) => ({
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
    transcription: row.transcription ?? undefined,
    mediaPath: row.media_path ?? undefined,
    mediaType: row.media_type ?? undefined,
    createdAt: row.created_at,
  }));
}

function rowToRoute(row: RouteRow): RouteConfig & { id: number } {
  return {
    id: row.id,
    pattern: row.pattern,
    accountId: row.account_id,
    agent: row.agent_id,
    dmScope: (row.dm_scope ?? undefined) as RouteConfig["dmScope"],
    session: row.session_name ?? undefined,
    priority: row.priority,
    policy: row.policy ?? undefined,
    channel: row.channel ?? undefined,
  };
}

function rowToSession(row: SessionRow): SessionEntry {
  return {
    sessionKey: row.session_key,
    name: row.name ?? undefined,
    runtimeProvider: (row.runtime_provider ?? undefined) as SessionEntry["runtimeProvider"],
    runtimeProviderOverride: (row.runtime_provider_override ?? undefined) as SessionEntry["runtimeProviderOverride"],
    runtimeSessionDisplayId: row.runtime_session_display_id ?? undefined,
    providerSessionId: row.runtime_session_display_id ?? row.sdk_session_id ?? undefined,
    sdkSessionId: row.sdk_session_id ?? undefined,
    agentId: row.agent_id,
    agentCwd: row.agent_cwd,
    chatType: (row.chat_type ?? undefined) as SessionEntry["chatType"],
    channel: row.channel ?? undefined,
    accountId: row.account_id ?? undefined,
    groupId: row.group_id ?? undefined,
    subject: row.subject ?? undefined,
    displayName: row.display_name ?? undefined,
    lastChannel: row.last_channel ?? undefined,
    lastTo: row.last_to ?? undefined,
    lastAccountId: row.last_account_id ?? undefined,
    lastThreadId: row.last_thread_id ?? undefined,
    lastContext: row.last_context ?? undefined,
    modelOverride: row.model_override ?? undefined,
    effortOverride: (row.effort_override ?? undefined) as SessionEntry["effortOverride"],
    thinkingLevel: (row.thinking_level ?? undefined) as SessionEntry["thinkingLevel"],
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    contextTokens: row.context_tokens,
    compactionCount: row.compaction_count,
    ephemeral: row.ephemeral === 1,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface SessionRow {
  session_key: string;
  name: string | null;
  sdk_session_id: string | null;
  runtime_provider: string | null;
  runtime_provider_override: string | null;
  runtime_session_display_id: string | null;
  agent_id: string;
  agent_cwd: string;
  chat_type: string | null;
  channel: string | null;
  account_id: string | null;
  group_id: string | null;
  subject: string | null;
  display_name: string | null;
  last_channel: string | null;
  last_to: string | null;
  last_account_id: string | null;
  last_thread_id: string | null;
  last_context: string | null;
  model_override: string | null;
  effort_override: string | null;
  thinking_level: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  context_tokens: number;
  compaction_count: number;
  ephemeral: number;
  expires_at: number | null;
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

interface ChatRow {
  id: string;
  channel: string;
  instance_id: string;
  platform_chat_id: string;
  normalized_chat_id: string;
  actor_id: string | null;
  agent_id: string | null;
  chat_type: string;
  title: string | null;
  avatar_url: string | null;
  first_seen_at: number;
  last_seen_at: number;
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
  priority: number;
  policy: string | null;
  channel: string | null;
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
  created_at: number;
  updated_at: number;
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
  transcription: string | null;
  media_path: string | null;
  media_type: string | null;
  created_at: number;
}
