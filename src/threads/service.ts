import { createHash, randomUUID } from "node:crypto";
import type { SQLQueryBindings } from "bun:sqlite";
import type { MessageTarget } from "../runtime/message-types.js";
import { dbFindChat, dbGetSessionChatBinding, getDb } from "../router/router-db.js";
import type { SessionEntry } from "../router/types.js";
import type {
  ThreadActor,
  ThreadBrief,
  ThreadEntryKind,
  ThreadEntryRecord,
  ThreadHandoffPromptMetadata,
  ThreadHandoffRecord,
  ThreadLinkRecord,
  ThreadPointer,
  ThreadRecord,
  ThreadStatus,
  ThreadVisibility,
} from "./types.js";

interface ThreadRow {
  id: string;
  slug: string | null;
  title: string;
  summary: string | null;
  status: ThreadStatus;
  owner_type: string;
  owner_id: string | null;
  scope_type: string;
  scope_id: string | null;
  default_agent_id: string | null;
  default_chat_id: string | null;
  default_contact_id: string | null;
  current_assignee_type: string | null;
  current_assignee_id: string | null;
  closed_reason: string | null;
  closed_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  last_entry_at: number | null;
  last_handoff_at: number | null;
}

interface ThreadEntryRow {
  id: string;
  thread_id: string;
  kind: ThreadEntryKind;
  body: string;
  summary: string | null;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_agent_id: string | null;
  actor_session_key: string | null;
  actor_session_name: string | null;
  source_type: string;
  source_id: string | null;
  source_message_id: string | null;
  source_session_key: string | null;
  source_chat_id: string | null;
  visibility: ThreadVisibility;
  importance: string | null;
  pinned: number;
  source_policy: string | null;
  resolved_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface ThreadLinkRow {
  id: string;
  thread_id: string;
  target_type: string;
  target_id: string;
  role: string;
  label: string | null;
  visibility: ThreadVisibility;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface ThreadHandoffRow {
  id: string;
  thread_id: string;
  source_session_key: string | null;
  source_session_name: string | null;
  target_session_key: string;
  target_session_name: string | null;
  target_agent_id: string | null;
  handoff_kind: string;
  source_entry_id: string | null;
  brief_text: string;
  brief_json: string | null;
  included_entry_ids_json: string;
  included_link_ids_json: string;
  snapshot_hash: string | null;
  snapshot_version: string | null;
  status: ThreadHandoffRecord["status"];
  created_thread: number;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  failed_at: number | null;
  failure_reason: string | null;
}

export interface CreateThreadInput {
  id?: string;
  slug?: string;
  title: string;
  summary?: string;
  status?: ThreadStatus;
  owner?: ThreadPointer;
  scope?: ThreadPointer;
  defaultAgentId?: string;
  defaultChatId?: string;
  defaultContactId?: string;
  currentAssignee?: ThreadPointer;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface ListThreadsQuery {
  status?: string;
  scope?: ThreadPointer;
  owner?: ThreadPointer;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ListThreadsResult {
  items: ThreadRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface AddThreadEntryInput {
  threadId: string;
  kind: ThreadEntryKind;
  body: string;
  summary?: string;
  actor?: ThreadActor;
  sourceType?: string;
  sourceId?: string;
  sourceMessageId?: string;
  sourceSessionKey?: string;
  sourceChatId?: string;
  visibility?: ThreadVisibility;
  importance?: string;
  pinned?: boolean;
  sourcePolicy?: string;
  resolvedAt?: number;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface UpsertThreadLinkInput {
  threadId: string;
  target: ThreadPointer;
  role?: string;
  label?: string;
  visibility?: ThreadVisibility;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface BuildThreadBriefOptions {
  maxEntries?: number;
  maxLinks?: number;
  maxChars?: number;
}

export interface RecordThreadHandoffInput {
  threadId: string;
  sourceSessionKey?: string;
  sourceSessionName?: string;
  targetSessionKey: string;
  targetSessionName?: string;
  targetAgentId?: string;
  handoffKind?: string;
  sourceEntryId?: string;
  brief: ThreadBrief;
  createdThread?: boolean;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface PrepareThreadHandoffInput {
  threadRef: string;
  prompt: string;
  targetSession: Pick<SessionEntry, "sessionKey" | "name" | "agentId">;
  sourceSessionKey?: string;
  sourceSessionName?: string;
  source?: MessageTarget;
  actor?: ThreadActor;
  create?: {
    title?: string;
    summary?: string;
    slug?: string;
    owner?: ThreadPointer;
    scope?: ThreadPointer;
    metadata?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface PreparedThreadHandoff {
  thread: ThreadRecord;
  entry: ThreadEntryRecord;
  handoff: ThreadHandoffRecord;
  brief: ThreadBrief;
  createdThread: boolean;
  promptMetadata: ThreadHandoffPromptMetadata;
}

export function normalizeThreadSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  if (!normalized) {
    throw new Error("Thread slug must not be empty.");
  }
  return normalized;
}

export function parseThreadPointer(value: string | undefined, fallbackType = "global"): ThreadPointer {
  const raw = value?.trim();
  if (!raw) return { type: fallbackType };
  const separator = raw.indexOf(":");
  if (separator === -1) return { type: raw };
  const type = raw.slice(0, separator).trim();
  const id = raw.slice(separator + 1).trim();
  if (!type) throw new Error(`Invalid thread pointer: ${value}`);
  return id ? { type, id } : { type };
}

export function formatThreadPointer(pointer: ThreadPointer): string {
  return pointer.id ? `${pointer.type}:${pointer.id}` : pointer.type;
}

export function createThread(input: CreateThreadInput): ThreadRecord {
  const now = input.now ?? Date.now();
  const id = input.id?.trim() || makeId("thr");
  const slug = input.slug ? normalizeThreadSlug(input.slug) : null;
  const title = requiredText(input.title, "Thread title");
  const owner = normalizePointer(input.owner, "system");
  const scope = normalizePointer(input.scope, "global");
  const assignee = normalizePointer(input.currentAssignee, "");

  getDb()
    .prepare(
      `
      INSERT INTO threads (
        id, slug, title, summary, status,
        owner_type, owner_id, scope_type, scope_id,
        default_agent_id, default_chat_id, default_contact_id,
        current_assignee_type, current_assignee_id,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      slug,
      title,
      dbText(input.summary),
      input.status ?? "open",
      owner.type,
      owner.id ?? null,
      scope.type,
      scope.id ?? null,
      dbText(input.defaultAgentId),
      dbText(input.defaultChatId),
      dbText(input.defaultContactId),
      assignee.type || null,
      assignee.id ?? null,
      stringifyRecord(input.metadata),
      now,
      now,
    );

  const thread = getThreadById(id);
  if (!thread) throw new Error(`Failed to create thread ${id}`);
  return thread;
}

export function getThreadById(id: string): ThreadRecord | null {
  const row = getDb().prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
  return row ? rowToThread(row) : null;
}

export function findThread(ref: string, options: { scope?: ThreadPointer } = {}): ThreadRecord | null {
  const trimmed = requiredText(ref, "Thread reference");
  const exact = getThreadById(trimmed);
  if (exact) return exact;

  let slug: string;
  try {
    slug = normalizeThreadSlug(trimmed);
  } catch {
    return null;
  }

  if (options.scope) {
    const scope = normalizePointer(options.scope, "global");
    const row = getDb()
      .prepare("SELECT * FROM threads WHERE slug = ? AND scope_type = ? AND COALESCE(scope_id, '') = ?")
      .get(slug, scope.type, scope.id ?? "") as ThreadRow | undefined;
    return row ? rowToThread(row) : null;
  }

  const rows = getDb()
    .prepare("SELECT * FROM threads WHERE slug = ? ORDER BY updated_at DESC")
    .all(slug) as ThreadRow[];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    const scopes = rows.map((row) => `${row.scope_type}:${row.scope_id ?? ""}`).join(", ");
    throw new Error(`Thread reference "${ref}" is ambiguous across scopes: ${scopes}`);
  }
  return rowToThread(rows[0]!);
}

export function resolveThread(ref: string, options: { scope?: ThreadPointer } = {}): ThreadRecord {
  const thread = findThread(ref, options);
  if (!thread) throw new Error(`Thread not found: ${ref}`);
  return thread;
}

export function listThreads(query: ListThreadsQuery = {}): ListThreadsResult {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.scope) {
    const scope = normalizePointer(query.scope, "global");
    where.push("scope_type = ? AND COALESCE(scope_id, '') = ?");
    params.push(scope.type, scope.id ?? "");
  }
  if (query.owner) {
    const owner = normalizePointer(query.owner, "system");
    where.push("owner_type = ? AND COALESCE(owner_id, '') = ?");
    params.push(owner.type, owner.id ?? "");
  }
  if (query.search?.trim()) {
    where.push("(title LIKE ? OR slug LIKE ? OR summary LIKE ?)");
    const pattern = `%${query.search.trim()}%`;
    params.push(pattern, pattern, pattern);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = clampListLimit(query.limit);
  const offset = Math.max(0, query.offset ?? 0);
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM threads ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as ThreadRow[];
  const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM threads ${whereSql}`).get(...params) as
    | { total: number }
    | undefined;
  return {
    items: rows.map(rowToThread),
    total: totalRow?.total ?? 0,
    limit,
    offset,
  };
}

export function updateThreadStatus(
  threadId: string,
  status: ThreadStatus,
  options: { reason?: string; now?: number } = {},
): ThreadRecord {
  const now = options.now ?? Date.now();
  const closedAt = status === "closed" || status === "resolved" ? now : null;
  getDb()
    .prepare(
      `
      UPDATE threads
      SET status = ?, closed_reason = ?, closed_at = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(status, dbText(options.reason), closedAt, now, threadId);
  return requireThreadById(threadId);
}

export function addThreadEntry(input: AddThreadEntryInput): ThreadEntryRecord {
  const now = input.now ?? Date.now();
  const thread = requireThreadById(input.threadId);
  const id = makeId("tre");
  const actor = input.actor ?? { type: "unknown" };
  getDb()
    .prepare(
      `
      INSERT INTO thread_entries (
        id, thread_id, kind, body, summary,
        actor_type, actor_id, actor_name, actor_agent_id, actor_session_key, actor_session_name,
        source_type, source_id, source_message_id, source_session_key, source_chat_id,
        visibility, importance, pinned, source_policy, resolved_at, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      thread.id,
      input.kind,
      requiredText(input.body, "Thread entry body"),
      dbText(input.summary),
      requiredText(actor.type, "Thread actor type"),
      dbText(actor.id),
      dbText(actor.name),
      dbText(actor.agentId),
      dbText(actor.sessionKey),
      dbText(actor.sessionName),
      nullableText(input.sourceType) ?? "manual",
      dbText(input.sourceId),
      dbText(input.sourceMessageId),
      dbText(input.sourceSessionKey),
      dbText(input.sourceChatId),
      input.visibility ?? "default",
      dbText(input.importance),
      input.pinned ? 1 : 0,
      dbText(input.sourcePolicy),
      input.resolvedAt ?? null,
      stringifyRecord(input.metadata),
      now,
      now,
    );

  getDb().prepare("UPDATE threads SET updated_at = ?, last_entry_at = ? WHERE id = ?").run(now, now, thread.id);

  return requireThreadEntryById(id);
}

export function listThreadEntries(
  threadId: string,
  options: { limit?: number; offset?: number; order?: "asc" | "desc" } = {},
): ThreadEntryRecord[] {
  const limit = clampListLimit(options.limit);
  const offset = Math.max(0, options.offset ?? 0);
  const order = options.order === "asc" ? "ASC" : "DESC";
  const rows = getDb()
    .prepare(
      `SELECT * FROM thread_entries WHERE thread_id = ? ORDER BY created_at ${order}, id ${order} LIMIT ? OFFSET ?`,
    )
    .all(threadId, limit, offset) as ThreadEntryRow[];
  return rows.map(rowToThreadEntry);
}

export function upsertThreadLink(input: UpsertThreadLinkInput): ThreadLinkRecord {
  const now = input.now ?? Date.now();
  const thread = requireThreadById(input.threadId);
  const target = normalizePointer(input.target, "");
  if (!target.type || !target.id) throw new Error("Thread link target must be type:id.");
  const role = nullableText(input.role) ?? "context";
  getDb()
    .prepare(
      `
      INSERT INTO thread_links (
        id, thread_id, target_type, target_id, role, label, visibility, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, target_type, target_id, role) DO UPDATE SET
        label = COALESCE(excluded.label, thread_links.label),
        visibility = excluded.visibility,
        metadata_json = COALESCE(excluded.metadata_json, thread_links.metadata_json),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      makeId("tln"),
      thread.id,
      target.type,
      target.id,
      role,
      dbText(input.label),
      input.visibility ?? "default",
      stringifyRecord(input.metadata),
      now,
      now,
    );
  getDb().prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now, thread.id);
  const row = getDb()
    .prepare("SELECT * FROM thread_links WHERE thread_id = ? AND target_type = ? AND target_id = ? AND role = ?")
    .get(thread.id, target.type, target.id, role) as ThreadLinkRow | undefined;
  if (!row) throw new Error("Failed to upsert thread link.");
  return rowToThreadLink(row);
}

export function listThreadLinks(threadId: string): ThreadLinkRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM thread_links WHERE thread_id = ? ORDER BY role, target_type, target_id")
    .all(threadId) as ThreadLinkRow[];
  return rows.map(rowToThreadLink);
}

export function buildThreadBrief(threadId: string, options: BuildThreadBriefOptions = {}): ThreadBrief {
  const thread = requireThreadById(threadId);
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? 12, 50));
  const maxLinks = Math.max(0, Math.min(options.maxLinks ?? 20, 100));
  const maxChars = Math.max(1000, Math.min(options.maxChars ?? 6000, 20000));
  const db = getDb();

  const privateEntries = countRows(
    "SELECT COUNT(*) AS total FROM thread_entries WHERE thread_id = ? AND visibility IN ('private', 'restricted')",
    thread.id,
  );
  const eligibleEntryCount = countRows(
    "SELECT COUNT(*) AS total FROM thread_entries WHERE thread_id = ? AND visibility NOT IN ('private', 'restricted')",
    thread.id,
  );
  const entryRows = db
    .prepare(
      `
      SELECT * FROM thread_entries
      WHERE thread_id = ? AND visibility NOT IN ('private', 'restricted')
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    )
    .all(thread.id, maxEntries) as ThreadEntryRow[];
  const entries = entryRows.map(rowToThreadEntry).reverse();

  const privateLinks = countRows(
    "SELECT COUNT(*) AS total FROM thread_links WHERE thread_id = ? AND visibility IN ('private', 'restricted')",
    thread.id,
  );
  const linkRows = db
    .prepare(
      `
      SELECT * FROM thread_links
      WHERE thread_id = ? AND visibility NOT IN ('private', 'restricted')
      ORDER BY role, target_type, target_id
      LIMIT ?
    `,
    )
    .all(thread.id, maxLinks) as ThreadLinkRow[];
  const links = linkRows.map(rowToThreadLink);

  const briefBase = {
    thread: {
      id: thread.id,
      ...(thread.slug ? { slug: thread.slug } : {}),
      title: thread.title,
      ...(thread.summary ? { summary: thread.summary } : {}),
      status: thread.status,
      scopeType: thread.scopeType,
      ...(thread.scopeId ? { scopeId: thread.scopeId } : {}),
      ownerType: thread.ownerType,
      ...(thread.ownerId ? { ownerId: thread.ownerId } : {}),
    },
    entries: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      body: entry.body,
      actorType: entry.actorType,
      ...(entry.actorName ? { actorName: entry.actorName } : {}),
      ...(entry.actorAgentId ? { actorAgentId: entry.actorAgentId } : {}),
      ...(entry.actorSessionName ? { actorSessionName: entry.actorSessionName } : {}),
      createdAt: entry.createdAt,
    })),
    links: links.map((link) => ({
      id: link.id,
      targetType: link.targetType,
      targetId: link.targetId,
      role: link.role,
      ...(link.label ? { label: link.label } : {}),
    })),
    omitted: {
      privateEntries,
      privateLinks,
      olderEntries: Math.max(0, eligibleEntryCount - entries.length),
      charBudgetExceeded: false,
    },
  };

  const rendered = renderBriefText(briefBase, maxChars);
  const snapshotVersion = "thread-brief-v1";
  const snapshotHash = hashJson({
    snapshotVersion,
    thread: briefBase.thread,
    entryIds: briefBase.entries.map((entry) => entry.id),
    linkIds: briefBase.links.map((link) => link.id),
    omitted: { ...briefBase.omitted, charBudgetExceeded: rendered.charBudgetExceeded },
  });

  return {
    ...briefBase,
    omitted: { ...briefBase.omitted, charBudgetExceeded: rendered.charBudgetExceeded },
    text: rendered.text,
    snapshotHash,
    snapshotVersion,
  };
}

export function recordThreadHandoff(input: RecordThreadHandoffInput): ThreadHandoffRecord {
  const now = input.now ?? Date.now();
  const id = makeId("thf");
  const entryIds = input.brief.entries.map((entry) => entry.id);
  const linkIds = input.brief.links.map((link) => link.id);
  getDb()
    .prepare(
      `
      INSERT INTO thread_handoffs (
        id, thread_id, source_session_key, source_session_name, target_session_key, target_session_name,
        target_agent_id, handoff_kind, source_entry_id, brief_text, brief_json,
        included_entry_ids_json, included_link_ids_json, snapshot_hash, snapshot_version,
        status, created_thread, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      input.threadId,
      dbText(input.sourceSessionKey),
      dbText(input.sourceSessionName),
      requiredText(input.targetSessionKey, "Target session key"),
      dbText(input.targetSessionName),
      dbText(input.targetAgentId),
      input.handoffKind ?? "session_send",
      dbText(input.sourceEntryId),
      input.brief.text,
      JSON.stringify(input.brief),
      JSON.stringify(entryIds),
      JSON.stringify(linkIds),
      input.brief.snapshotHash,
      input.brief.snapshotVersion,
      "queued",
      input.createdThread ? 1 : 0,
      stringifyRecord(input.metadata),
      now,
      now,
    );
  getDb().prepare("UPDATE threads SET updated_at = ?, last_handoff_at = ? WHERE id = ?").run(now, now, input.threadId);
  return requireThreadHandoffById(id);
}

export function markThreadHandoffDelivered(handoffId: string, now = Date.now()): ThreadHandoffRecord {
  getDb()
    .prepare("UPDATE thread_handoffs SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, handoffId);
  return requireThreadHandoffById(handoffId);
}

export function markThreadHandoffFailed(handoffId: string, reason: string, now = Date.now()): ThreadHandoffRecord {
  getDb()
    .prepare(
      "UPDATE thread_handoffs SET status = 'failed', failed_at = ?, failure_reason = ?, updated_at = ? WHERE id = ?",
    )
    .run(now, reason, now, handoffId);
  return requireThreadHandoffById(handoffId);
}

export function prepareThreadHandoff(input: PrepareThreadHandoffInput): PreparedThreadHandoff {
  const now = input.now ?? Date.now();
  const scope = normalizePointer(
    input.create?.scope ?? deriveThreadScopeForSession(input.targetSession, input.source),
    "global",
  );
  let thread = findThread(input.threadRef, { scope });
  let createdThread = false;

  if (!thread) {
    const title = nullableText(input.create?.title);
    if (!title) {
      throw new Error(
        "Missing --thread-title: sessions send --thread can only auto-create a thread with an explicit title.",
      );
    }
    const owner =
      input.create?.owner ??
      (input.sourceSessionKey
        ? { type: "session", id: input.sourceSessionKey }
        : { type: "agent", id: input.targetSession.agentId });
    thread = createThread({
      slug: input.create?.slug ?? input.threadRef,
      title,
      summary: input.create?.summary,
      owner,
      scope,
      defaultAgentId: input.targetSession.agentId,
      defaultChatId: scope.type === "chat" ? scope.id : undefined,
      currentAssignee: { type: "agent", id: input.targetSession.agentId },
      metadata: {
        ...(input.create?.metadata ?? {}),
        createdVia: "sessions.send",
      },
      now,
    });
    createdThread = true;
    upsertDefaultHandoffLinks(thread, input.targetSession, scope, now);
  }

  const actor =
    input.actor ??
    ({
      type: input.sourceSessionKey ? "session" : "system",
      id: input.sourceSessionKey,
      sessionKey: input.sourceSessionKey,
      sessionName: input.sourceSessionName,
    } satisfies ThreadActor);
  const entry = addThreadEntry({
    threadId: thread.id,
    kind: "comment",
    body: input.prompt,
    actor,
    sourceType: "sessions.send",
    sourceSessionKey: input.sourceSessionKey,
    sourceChatId: scope.type === "chat" ? scope.id : undefined,
    metadata: {
      ...(input.metadata ?? {}),
      targetSessionKey: input.targetSession.sessionKey,
      targetSessionName: input.targetSession.name ?? null,
      targetAgentId: input.targetSession.agentId,
      source: input.source ?? null,
    },
    now,
  });
  thread = requireThreadById(thread.id);
  const brief = buildThreadBrief(thread.id);
  const handoff = recordThreadHandoff({
    threadId: thread.id,
    sourceSessionKey: input.sourceSessionKey,
    sourceSessionName: input.sourceSessionName,
    targetSessionKey: input.targetSession.sessionKey,
    targetSessionName: input.targetSession.name,
    targetAgentId: input.targetSession.agentId,
    sourceEntryId: entry.id,
    brief,
    createdThread,
    metadata: input.metadata,
    now,
  });
  const promptMetadata = buildThreadHandoffPromptMetadata(thread, handoff, brief, createdThread, entry.id);
  return {
    thread,
    entry,
    handoff,
    brief,
    createdThread,
    promptMetadata,
  };
}

export function buildThreadHandoffPrompt(prepared: PreparedThreadHandoff, origin: string, prompt: string): string {
  const ref = prepared.thread.slug ?? prepared.thread.id;
  return [
    "[System] Thread Context:",
    prepared.brief.text,
    "",
    `[System] Inform: [from: ${origin}, thread: ${ref}, thread_handoff: ${prepared.handoff.id}] ${prompt}`,
  ].join("\n");
}

function buildThreadHandoffPromptMetadata(
  thread: ThreadRecord,
  handoff: ThreadHandoffRecord,
  brief: ThreadBrief,
  createdThread: boolean,
  sourceEntryId: string,
): ThreadHandoffPromptMetadata {
  return {
    id: thread.id,
    handoffId: handoff.id,
    ...(thread.slug ? { slug: thread.slug } : {}),
    title: thread.title,
    status: thread.status,
    scope: {
      type: thread.scopeType,
      ...(thread.scopeId ? { id: thread.scopeId } : {}),
    },
    owner: {
      type: thread.ownerType,
      ...(thread.ownerId ? { id: thread.ownerId } : {}),
    },
    createdThread,
    sourceEntryId,
    brief: {
      snapshotHash: brief.snapshotHash,
      snapshotVersion: brief.snapshotVersion,
      includedEntryIds: brief.entries.map((entry) => entry.id),
      includedLinkIds: brief.links.map((link) => link.id),
      omitted: brief.omitted,
    },
  };
}

function upsertDefaultHandoffLinks(
  thread: ThreadRecord,
  targetSession: Pick<SessionEntry, "sessionKey" | "name" | "agentId">,
  scope: ThreadPointer,
  now: number,
): void {
  if (scope.id && scope.type !== "global") {
    upsertThreadLink({
      threadId: thread.id,
      target: scope,
      role: "origin",
      metadata: { createdVia: "sessions.send" },
      now,
    });
  }
  upsertThreadLink({
    threadId: thread.id,
    target: { type: "session", id: targetSession.sessionKey },
    role: "worker",
    label: targetSession.name,
    metadata: { createdVia: "sessions.send" },
    now,
  });
  upsertThreadLink({
    threadId: thread.id,
    target: { type: "agent", id: targetSession.agentId },
    role: "assignee",
    metadata: { createdVia: "sessions.send" },
    now,
  });
}

function deriveThreadScopeForSession(session: Pick<SessionEntry, "sessionKey">, source?: MessageTarget): ThreadPointer {
  const binding = dbGetSessionChatBinding(session.sessionKey);
  if (binding) return { type: "chat", id: binding.chatId };
  if (source?.canonicalChatId) return { type: "chat", id: source.canonicalChatId };
  if (source?.channel && source.chatId) {
    for (const instanceId of uniqueStrings([source.instanceId, source.accountId, ""])) {
      const chat = dbFindChat({
        channel: source.channel,
        instanceId,
        platformChatId: source.threadId ? `${source.chatId}#${source.threadId}` : source.chatId,
      });
      if (chat) return { type: "chat", id: chat.id };
    }
  }
  return { type: "session", id: session.sessionKey };
}

function renderBriefText(
  brief: Omit<ThreadBrief, "text" | "snapshotHash" | "snapshotVersion">,
  maxChars: number,
): { text: string; charBudgetExceeded: boolean } {
  const lines: string[] = [
    "## Ravi Thread Brief",
    `Thread: ${brief.thread.title}`,
    `ID: ${brief.thread.id}`,
    ...(brief.thread.slug ? [`Slug: ${brief.thread.slug}`] : []),
    `Status: ${brief.thread.status}`,
    `Scope: ${brief.thread.scopeType}${brief.thread.scopeId ? `:${brief.thread.scopeId}` : ""}`,
    ...(brief.thread.summary ? [`Summary: ${compactLine(brief.thread.summary, 700)}`] : []),
    "",
    "Recent entries:",
  ];

  if (brief.entries.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of brief.entries) {
      const actor = entry.actorName ?? entry.actorSessionName ?? entry.actorAgentId ?? entry.actorType;
      lines.push(`- [${entry.kind}] ${actor}: ${compactLine(entry.body, 700)}`);
    }
  }

  lines.push("", "Links:");
  if (brief.links.length === 0) {
    lines.push("- none");
  } else {
    for (const link of brief.links) {
      lines.push(
        `- ${link.role} ${link.targetType}:${link.targetId}${link.label ? ` (${compactLine(link.label, 120)})` : ""}`,
      );
    }
  }

  if (brief.omitted.olderEntries || brief.omitted.privateEntries || brief.omitted.privateLinks) {
    lines.push(
      "",
      `Omitted: older_entries=${brief.omitted.olderEntries}, private_entries=${brief.omitted.privateEntries}, private_links=${brief.omitted.privateLinks}`,
    );
  }

  const fullText = lines.join("\n");
  if (fullText.length <= maxChars) return { text: fullText, charBudgetExceeded: false };
  return {
    text: `${fullText.slice(0, Math.max(0, maxChars - 31)).trimEnd()}\n[brief truncated by char budget]`,
    charBudgetExceeded: true,
  };
}

function rowToThread(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    ...(row.slug ? { slug: row.slug } : {}),
    title: row.title,
    ...(row.summary ? { summary: row.summary } : {}),
    status: row.status,
    ownerType: row.owner_type,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    scopeType: row.scope_type,
    ...(row.scope_id ? { scopeId: row.scope_id } : {}),
    ...(row.default_agent_id ? { defaultAgentId: row.default_agent_id } : {}),
    ...(row.default_chat_id ? { defaultChatId: row.default_chat_id } : {}),
    ...(row.default_contact_id ? { defaultContactId: row.default_contact_id } : {}),
    ...(row.current_assignee_type ? { currentAssigneeType: row.current_assignee_type } : {}),
    ...(row.current_assignee_id ? { currentAssigneeId: row.current_assignee_id } : {}),
    ...(row.closed_reason ? { closedReason: row.closed_reason } : {}),
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
    metadata: parseRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_entry_at ? { lastEntryAt: row.last_entry_at } : {}),
    ...(row.last_handoff_at ? { lastHandoffAt: row.last_handoff_at } : {}),
  };
}

function rowToThreadEntry(row: ThreadEntryRow): ThreadEntryRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    kind: row.kind,
    body: row.body,
    ...(row.summary ? { summary: row.summary } : {}),
    actorType: row.actor_type,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    ...(row.actor_name ? { actorName: row.actor_name } : {}),
    ...(row.actor_agent_id ? { actorAgentId: row.actor_agent_id } : {}),
    ...(row.actor_session_key ? { actorSessionKey: row.actor_session_key } : {}),
    ...(row.actor_session_name ? { actorSessionName: row.actor_session_name } : {}),
    sourceType: row.source_type,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    ...(row.source_session_key ? { sourceSessionKey: row.source_session_key } : {}),
    ...(row.source_chat_id ? { sourceChatId: row.source_chat_id } : {}),
    visibility: row.visibility,
    ...(row.importance ? { importance: row.importance } : {}),
    pinned: row.pinned === 1,
    ...(row.source_policy ? { sourcePolicy: row.source_policy } : {}),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    metadata: parseRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToThreadLink(row: ThreadLinkRow): ThreadLinkRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    targetType: row.target_type,
    targetId: row.target_id,
    role: row.role,
    ...(row.label ? { label: row.label } : {}),
    visibility: row.visibility,
    metadata: parseRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToThreadHandoff(row: ThreadHandoffRow): ThreadHandoffRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    ...(row.source_session_key ? { sourceSessionKey: row.source_session_key } : {}),
    ...(row.source_session_name ? { sourceSessionName: row.source_session_name } : {}),
    targetSessionKey: row.target_session_key,
    ...(row.target_session_name ? { targetSessionName: row.target_session_name } : {}),
    ...(row.target_agent_id ? { targetAgentId: row.target_agent_id } : {}),
    handoffKind: row.handoff_kind,
    ...(row.source_entry_id ? { sourceEntryId: row.source_entry_id } : {}),
    briefText: row.brief_text,
    brief: parseRecord<ThreadBrief>(row.brief_json),
    includedEntryIds: parseStringArray(row.included_entry_ids_json),
    includedLinkIds: parseStringArray(row.included_link_ids_json),
    ...(row.snapshot_hash ? { snapshotHash: row.snapshot_hash } : {}),
    ...(row.snapshot_version ? { snapshotVersion: row.snapshot_version } : {}),
    status: row.status,
    createdThread: row.created_thread === 1,
    metadata: parseRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    ...(row.failed_at ? { failedAt: row.failed_at } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
  };
}

function requireThreadById(id: string): ThreadRecord {
  const thread = getThreadById(id);
  if (!thread) throw new Error(`Thread not found: ${id}`);
  return thread;
}

function requireThreadEntryById(id: string): ThreadEntryRecord {
  const row = getDb().prepare("SELECT * FROM thread_entries WHERE id = ?").get(id) as ThreadEntryRow | undefined;
  if (!row) throw new Error(`Thread entry not found: ${id}`);
  return rowToThreadEntry(row);
}

function requireThreadHandoffById(id: string): ThreadHandoffRecord {
  const row = getDb().prepare("SELECT * FROM thread_handoffs WHERE id = ?").get(id) as ThreadHandoffRow | undefined;
  if (!row) throw new Error(`Thread handoff not found: ${id}`);
  return rowToThreadHandoff(row);
}

function countRows(sql: string, ...params: SQLQueryBindings[]): number {
  const row = getDb()
    .prepare(sql)
    .get(...params) as { total: number } | undefined;
  return row?.total ?? 0;
}

function normalizePointer(pointer: ThreadPointer | undefined, fallbackType: string): ThreadPointer {
  const type = nullableText(pointer?.type) ?? fallbackType;
  const id = nullableText(pointer?.id);
  return id ? { type, id } : { type };
}

function requiredText(value: string | undefined | null, label: string): string {
  const normalized = nullableText(value);
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function nullableText(value: string | undefined | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function dbText(value: string | undefined | null): string | null {
  return nullableText(value) ?? null;
}

function stringifyRecord(value: Record<string, unknown> | undefined): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function parseRecord<T extends object = Record<string, unknown>>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
  } catch {}
  return undefined;
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
  } catch {}
  return [];
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compactLine(value: string, maxChars: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function clampListLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(Math.trunc(value), 500));
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}
