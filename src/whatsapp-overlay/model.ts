import type { SessionEntry } from "../router/types.js";

export type OverlayActivity =
  | "idle"
  | "thinking"
  | "streaming"
  | "compacting"
  | "awaiting_approval"
  | "blocked"
  | "unknown";

export interface OverlayQuery {
  chatId?: string | null;
  title?: string | null;
  session?: string | null;
}

export type OverlayRuntimeMetadata = Record<string, unknown>;

export interface OverlaySessionEvent {
  kind: "prompt" | "stream" | "tool" | "response" | "approval" | "runtime";
  label: string;
  detail?: string;
  timestamp: number;
  metadata?: OverlayRuntimeMetadata | null;
}

export type OverlayToolCallStatus = "running" | "ok" | "error";

export type OverlayChatArtifactAnchor =
  | {
      placement: "after-last-message";
    }
  | {
      placement: "after-message-id";
      messageId: string;
    };

export interface OverlayChatArtifact {
  id: string;
  kind: string;
  label: string;
  detail?: string | null;
  description?: string | null;
  preview?: string | null;
  fullDetail?: string | null;
  status?: OverlayToolCallStatus | null;
  duration?: string | null;
  createdAt: number;
  updatedAt?: number;
  anchor?: OverlayChatArtifactAnchor;
  dedupeKey?: string | null;
  metadata?: OverlayRuntimeMetadata | null;
}

export interface OverlayLiveState {
  activity: OverlayActivity;
  approvalPending?: boolean;
  summary?: string;
  updatedAt?: number;
  busySince?: number;
  events?: OverlaySessionEvent[];
  messages?: OverlaySessionWorkspaceMessage[];
  artifacts?: OverlayChatArtifact[];
}

export interface OverlaySessionWorkspaceMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  source?: "history" | "live";
  pending?: boolean;
  metadata?: OverlayRuntimeMetadata | null;
}

export type OverlaySessionWorkspaceTimelineItem =
  | {
      id: string;
      type: "message";
      role: "user" | "assistant";
      content: string;
      timestamp: number;
      source: "history" | "live";
      pending?: boolean;
      eventKind?: OverlaySessionEvent["kind"];
      metadata?: OverlayRuntimeMetadata | null;
    }
  | {
      id: string;
      type: "event";
      kind: OverlaySessionEvent["kind"];
      label: string;
      detail: string;
      timestamp: number;
      source: "live";
      metadata?: OverlayRuntimeMetadata | null;
    }
  | {
      id: string;
      type: "artifact";
      kind: string;
      label: string;
      detail?: string | null;
      description?: string | null;
      preview?: string | null;
      fullDetail?: string | null;
      status?: OverlayToolCallStatus | null;
      timestamp: number;
      source: "live";
      anchor?: OverlayChatArtifactAnchor;
      metadata?: OverlayRuntimeMetadata | null;
    };

export interface OverlayPermissionDecision {
  allowed: boolean;
  matched: string[];
  missing: string[];
  reason: string | null;
}

export interface OverlayItemAuth {
  visibility: "full" | "opaque";
  view: OverlayPermissionDecision;
}

export interface OverlayCandidate {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  displayName: string | null;
  source: "chatId" | "title" | "session";
  updatedAt: number;
}

export interface OverlaySessionSnapshot {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  displayName: string | null;
  subject: string | null;
  chatType: SessionEntry["chatType"] | null;
  channel: string | null;
  accountId: string | null;
  chatId: string | null;
  threadId: string | null;
  modelOverride: string | null;
  thinkingLevel: SessionEntry["thinkingLevel"] | null;
  queueMode: SessionEntry["queueMode"] | null;
  abortedLastRun: boolean;
  compactionCount: number;
  runtimeProvider: SessionEntry["runtimeProvider"] | null;
  providerSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  lastHeartbeatText: string | null;
  lastHeartbeatSentAt: number | null;
  ephemeral: boolean;
  expiresAt: number | null;
  live: OverlayLiveState;
  auth?: OverlayItemAuth;
}

export interface OverlayTaskSessionCandidate {
  id?: string | null;
  status: "open" | "dispatched" | "in_progress" | "blocked" | "done" | "failed";
  archivedAt?: number | null;
  createdAt?: number | null;
  updatedAt: number;
  dispatchedAt?: number | null;
  startedAt?: number | null;
  taskProfile?: { sessionNameTemplate?: string | null } | null;
  workSessionName?: string | null;
  assigneeSessionName?: string | null;
}

const OVERLAY_RECENT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const OVERLAY_RECENT_SESSIONS_LIMIT = 12;
const OVERLAY_TASK_SESSION_CREATION_WINDOW_MS = 30 * 60 * 1000;
const WORKSPACE_MESSAGE_MATCH_WINDOW_MS = 2 * 60 * 1000;

export interface OverlaySnapshot {
  ok: true;
  query: {
    chatId: string | null;
    title: string | null;
    session: string | null;
  };
  resolved: boolean;
  session: OverlaySessionSnapshot | null;
  candidates: OverlayCandidate[];
  activeSessions: OverlaySessionSnapshot[];
  recentSessions: OverlaySessionSnapshot[];
  /**
   * Backward-compatible alias for callers still expecting the older chat-centric field.
   * Keep this until the cockpit UI is fully migrated.
   */
  recentChats: OverlaySessionSnapshot[];
  /**
   * Backward-compatible alias for callers still expecting the previous "hot" label.
   * Keep this until the cockpit UI is fully migrated.
   */
  hotSessions: OverlaySessionSnapshot[];
  warnings: string[];
  generatedAt: number;
}

export interface OverlaySessionListEntry {
  id: string;
  query: {
    chatId: string | null;
    title: string | null;
    session: string | null;
  };
  resolved: boolean;
  session: OverlaySessionSnapshot | null;
  warnings: string[];
}

export interface OverlayChatListEntry extends OverlaySessionListEntry {}

export function buildOverlaySnapshot(args: {
  query: OverlayQuery;
  sessions: SessionEntry[];
  liveBySessionName?: Map<string, OverlayLiveState>;
  taskSessions?: OverlayTaskSessionCandidate[];
}): OverlaySnapshot {
  const resolved = resolveSessionForOverlay(args.query, args.sessions);
  const live = resolved.session?.name ? args.liveBySessionName?.get(resolved.session.name) : undefined;
  const activeSessions = buildActiveSessions(args.sessions, args.liveBySessionName);
  const hiddenActiveSessionNames = buildHiddenActiveSessionNames(args.taskSessions ?? [], args.sessions);
  const visibleActiveSessions = activeSessions.filter((session) => !hiddenActiveSessionNames.has(session.sessionName));
  const visibleActiveSessionKeys = new Set(visibleActiveSessions.map((session) => session.sessionKey));
  const recentSessions = buildRecentSessions(args.sessions, args.liveBySessionName).filter(
    (session) => !visibleActiveSessionKeys.has(session.sessionKey),
  );

  return {
    ok: true,
    query: {
      chatId: cleanNullable(args.query.chatId),
      title: cleanNullable(args.query.title),
      session: cleanNullable(args.query.session),
    },
    resolved: Boolean(resolved.session),
    session: resolved.session ? toOverlaySessionSnapshot(resolved.session, live) : null,
    candidates: resolved.candidates,
    activeSessions: visibleActiveSessions,
    recentSessions,
    recentChats: recentSessions,
    hotSessions: visibleActiveSessions,
    warnings: buildWarnings(args.query, resolved.session, resolved.candidates),
    generatedAt: Date.now(),
  };
}

export function buildOverlaySessionList(args: {
  entries: Array<{ id: string; query: OverlayQuery }>;
  sessions: SessionEntry[];
  liveBySessionName?: Map<string, OverlayLiveState>;
}): OverlaySessionListEntry[] {
  return args.entries.map((entry) => {
    const snapshot = buildOverlaySnapshot({
      query: entry.query,
      sessions: args.sessions,
      liveBySessionName: args.liveBySessionName,
    });

    return {
      id: entry.id,
      query: snapshot.query,
      resolved: snapshot.resolved,
      session: snapshot.session,
      warnings: snapshot.warnings,
    };
  });
}

export function buildOverlayChatList(args: {
  entries: Array<{ id: string; query: OverlayQuery }>;
  sessions: SessionEntry[];
  liveBySessionName?: Map<string, OverlayLiveState>;
}): OverlayChatListEntry[] {
  return buildOverlaySessionList(args);
}

export function upsertOverlayChatArtifact(
  artifacts: OverlayChatArtifact[] | undefined,
  artifact: OverlayChatArtifact,
): OverlayChatArtifact[] {
  const current = Array.isArray(artifacts) ? artifacts : [];
  const key = artifact.dedupeKey ?? artifact.id;
  const index = current.findIndex((item) => (item.dedupeKey ?? item.id) === key);

  if (index === -1) {
    return [...current, artifact];
  }

  const next = current.slice();
  next[index] = artifact;
  return next;
}

export function mergeOverlaySessionWorkspaceMessages(
  ...groups: Array<OverlaySessionWorkspaceMessage[] | undefined>
): OverlaySessionWorkspaceMessage[] {
  const deduped = new Map<string, OverlaySessionWorkspaceMessage>();

  for (const group of groups) {
    for (const message of normalizeWorkspaceMessages(Array.isArray(group) ? group : [])) {
      const key = buildWorkspaceMessageMergeKey(message);
      const current = deduped.get(key);

      if (!current || shouldReplaceWorkspaceMessage(current, message)) {
        deduped.set(key, message);
      }
    }
  }

  return [...deduped.values()].sort((left, right) => left.createdAt - right.createdAt);
}

export function parseOverlayTimestamp(value: string | number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return 0;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }

  const sqliteTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const parsed = Date.parse(sqliteTimestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildOverlaySessionWorkspaceTimeline(args: {
  messages: OverlaySessionWorkspaceMessage[];
  live?: OverlayLiveState;
}): OverlaySessionWorkspaceTimelineItem[] {
  const historyMessages = normalizeWorkspaceMessages(args.messages).map((message) => ({
    id: `message:${message.id}`,
    type: "message" as const,
    role: message.role,
    content: message.content,
    timestamp: message.createdAt,
    source: message.source ?? "history",
    pending: message.pending ?? false,
    ...(message.metadata ? { metadata: message.metadata } : {}),
  }));

  const liveMessageItems: Extract<OverlaySessionWorkspaceTimelineItem, { type: "message" }>[] = [];
  const liveDiscreteItems: Array<Extract<OverlaySessionWorkspaceTimelineItem, { type: "event" | "artifact" }>> = [];

  const liveMessages = normalizeWorkspaceMessages(args.live?.messages ?? []);
  for (const message of liveMessages) {
    const item: Extract<OverlaySessionWorkspaceTimelineItem, { type: "message" }> = {
      id: `message:${message.id}`,
      type: "message",
      role: message.role,
      content: message.content,
      timestamp: message.createdAt,
      source: message.source ?? "live",
      pending: message.pending ?? false,
      ...(message.metadata ? { metadata: message.metadata } : {}),
    };

    if (hasMatchingWorkspaceMessage(historyMessages, item)) {
      continue;
    }

    upsertLiveWorkspaceMessage(liveMessageItems, item);
  }

  const liveEvents = [...(Array.isArray(args.live?.events) ? args.live.events : [])].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  for (const event of liveEvents) {
    const item = toWorkspaceTimelineItemFromEvent(event);
    if (!item) continue;

    if (item.type === "message") {
      if (hasMatchingWorkspaceMessage(historyMessages, item)) {
        continue;
      }

      upsertLiveWorkspaceMessage(liveMessageItems, item);
      continue;
    }

    liveDiscreteItems.push(item);
  }

  const liveArtifacts = normalizeWorkspaceArtifacts(args.live?.artifacts);
  const toolArtifactIntervals = buildToolArtifactIntervals(liveArtifacts);

  for (const artifact of liveArtifacts) {
    const timestamp = artifact.kind === "tool" ? artifact.createdAt : (artifact.updatedAt ?? artifact.createdAt);
    liveDiscreteItems.push({
      id: `artifact:${artifact.dedupeKey ?? artifact.id}`,
      type: "artifact",
      kind: artifact.kind || "artifact",
      label: artifact.label || artifact.kind || "artifact",
      detail: artifact.preview || artifact.detail || artifact.kind || "artifact",
      description: artifact.description ?? null,
      preview: artifact.preview ?? artifact.detail ?? null,
      fullDetail: artifact.fullDetail ?? null,
      status: artifact.status ?? null,
      timestamp,
      source: "live",
      anchor: artifact.anchor,
      ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
    });
  }

  const filteredDiscreteItems =
    toolArtifactIntervals.length > 0
      ? liveDiscreteItems.filter((item) => !isRedundantToolLifecycleEvent(item, toolArtifactIntervals))
      : liveDiscreteItems;

  return [...historyMessages, ...liveMessageItems, ...filteredDiscreteItems].sort(compareWorkspaceTimelineItems);
}

export function resolveSessionForOverlay(
  query: OverlayQuery,
  sessions: SessionEntry[],
): { session: SessionEntry | null; candidates: OverlayCandidate[] } {
  const bySession = resolveBySession(query.session, sessions);
  if (bySession) {
    return {
      session: bySession,
      candidates: [toCandidate(bySession, "session")],
    };
  }

  const byChatId = resolveByChatId(query.chatId, sessions);
  if (byChatId.length > 0) {
    return {
      session: byChatId[0],
      candidates: byChatId.map((session) => toCandidate(session, "chatId")),
    };
  }

  const byTitle = resolveByTitle(query.title, sessions);
  if (byTitle.length > 0) {
    return {
      session: byTitle[0],
      candidates: byTitle.map((session) => toCandidate(session, "title")),
    };
  }

  return { session: null, candidates: [] };
}

export function resolveByChatId(chatId: string | null | undefined, sessions: SessionEntry[]): SessionEntry[] {
  const variants = buildChatIdVariants(chatId);
  if (variants.length === 0) return [];

  return sessions
    .filter((session) => {
      const lastTo = normalizeLookupToken(session.lastTo);
      return Boolean(lastTo && variants.includes(lastTo));
    })
    .sort(sortByUpdatedAtDesc);
}

export function resolveByTitle(title: string | null | undefined, sessions: SessionEntry[]): SessionEntry[] {
  const needle = normalizeLookupToken(title);
  const comparableNeedle = normalizeComparableTitle(title);
  if (!needle || !comparableNeedle) return [];

  const exact: SessionEntry[] = [];
  const allowFuzzy = !shouldDisableFuzzyTitleMatching(comparableNeedle);
  const fuzzy: Array<{ session: SessionEntry; score: number }> = [];

  for (const session of sessions) {
    const exactFields = [session.displayName, session.subject, session.name, session.lastTo]
      .map(normalizeLookupToken)
      .filter(Boolean) as string[];
    if (exactFields.length === 0) continue;
    if (exactFields.some((field) => field === needle)) {
      exact.push(session);
      continue;
    }

    if (!allowFuzzy) {
      continue;
    }

    const fuzzyScore = scoreTitleMatch(session, comparableNeedle);
    if (fuzzyScore > 0) {
      fuzzy.push({ session, score: fuzzyScore });
    }
  }

  return [
    ...exact.sort(sortByUpdatedAtDesc),
    ...fuzzy
      .sort((a, b) => b.score - a.score || sortByUpdatedAtDesc(a.session, b.session))
      .map((entry) => entry.session),
  ];
}

export function buildChatIdVariants(chatId: string | null | undefined): string[] {
  const normalized = normalizeLookupToken(chatId);
  if (!normalized) return [];

  const variants = new Set<string>([normalized]);
  const groupMatch = normalized.match(/^group:(.+)$/);
  if (groupMatch) {
    variants.add(`${groupMatch[1]}@g.us`);
  }

  const jidGroupMatch = normalized.match(/^(.+)@g\.us$/);
  if (jidGroupMatch) {
    variants.add(`group:${jidGroupMatch[1]}`);
  }

  const jidDmMatch = normalized.match(/^(\d+)@s\.whatsapp\.net$/);
  if (jidDmMatch) {
    variants.add(jidDmMatch[1]);
  }

  if (/^\d+$/.test(normalized)) {
    variants.add(`group:${normalized}`);
    variants.add(`${normalized}@g.us`);
    variants.add(`${normalized}@s.whatsapp.net`);
  }

  return [...variants];
}

function resolveBySession(nameOrKey: string | null | undefined, sessions: SessionEntry[]): SessionEntry | null {
  const needle = normalizeLookupToken(nameOrKey);
  if (!needle) return null;
  return (
    sessions.find((session) => normalizeLookupToken(session.name) === needle) ??
    sessions.find((session) => normalizeLookupToken(session.sessionKey) === needle) ??
    null
  );
}

function normalizeWorkspaceMessages(messages: OverlaySessionWorkspaceMessage[]): OverlaySessionWorkspaceMessage[] {
  return [...messages]
    .map((message) => ({
      ...message,
      id: String(message.id),
      content: typeof message.content === "string" ? message.content : "",
      createdAt: parseOverlayTimestamp(message.createdAt),
    }))
    .filter((message) => Boolean(message.content.trim()))
    .sort((left, right) => left.createdAt - right.createdAt);
}

function normalizeWorkspaceArtifacts(artifacts: OverlayChatArtifact[] | undefined): OverlayChatArtifact[] {
  let next: OverlayChatArtifact[] = [];

  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    if (!artifact) continue;
    next = upsertOverlayChatArtifact(next, artifact);
  }

  return next.sort((left, right) => (left.updatedAt ?? left.createdAt) - (right.updatedAt ?? right.createdAt));
}

function toWorkspaceTimelineItemFromEvent(event: OverlaySessionEvent): OverlaySessionWorkspaceTimelineItem | null {
  const kind = normalizeLookupToken(event.kind);
  const detail = normalizeWorkspaceText(event.detail);
  const timestamp = parseOverlayTimestamp(event.timestamp);
  const metadata = event.metadata ?? undefined;

  if (!kind || !timestamp) {
    return null;
  }

  if (kind === "prompt") {
    if (!detail) return null;
    return {
      id: `event:${kind}:${timestamp}`,
      type: "message",
      role: "user",
      content: event.detail ?? "",
      timestamp,
      source: "live",
      pending: true,
      eventKind: event.kind,
      ...(metadata ? { metadata } : {}),
    };
  }

  if (kind === "stream") {
    if (!detail) return null;
    return {
      id: `event:${kind}:${timestamp}`,
      type: "message",
      role: "assistant",
      content: event.detail ?? "",
      timestamp,
      source: "live",
      pending: true,
      eventKind: event.kind,
      ...(metadata ? { metadata } : {}),
    };
  }

  if (kind === "response") {
    if (!detail) return null;
    return {
      id: `event:${kind}:${timestamp}`,
      type: "message",
      role: "assistant",
      content: event.detail ?? "",
      timestamp,
      source: "live",
      pending: true,
      eventKind: event.kind,
      ...(metadata ? { metadata } : {}),
    };
  }

  if (kind === "tool") {
    return null;
  }

  if (kind === "runtime" && (!detail || detail === "idle" || detail === "turn.interrupted")) {
    return null;
  }

  const label = cleanNullable(event.label) ?? cleanNullable(event.kind) ?? "evento";
  const body = cleanNullable(event.detail) ?? label;
  if (!body) {
    return null;
  }

  return {
    id: `event:${kind}:${timestamp}`,
    type: "event",
    kind: event.kind,
    label,
    detail: body,
    timestamp,
    source: "live",
    ...(metadata ? { metadata } : {}),
  };
}

function upsertLiveWorkspaceMessage(
  items: Extract<OverlaySessionWorkspaceTimelineItem, { type: "message" }>[],
  candidate: Extract<OverlaySessionWorkspaceTimelineItem, { type: "message" }>,
): void {
  const candidateText = normalizeWorkspaceText(candidate.content);
  if (!candidateText) return;

  const index = items.findIndex((item) => workspaceTimelineMessagesMatch(item, candidate));
  if (index === -1) {
    items.push(candidate);
    return;
  }

  const current = items[index]!;
  const currentText = normalizeWorkspaceText(current.content);
  const shouldReplace =
    candidateText.length > currentText.length ||
    (candidateText.length === currentText.length && candidate.timestamp >= current.timestamp);
  if (shouldReplace) {
    items[index] = candidate;
  }
}

function hasMatchingWorkspaceMessage(
  messages: Extract<OverlaySessionWorkspaceTimelineItem, { type: "message" }>[],
  candidate: Extract<OverlaySessionWorkspaceTimelineItem, { type: "message" }>,
): boolean {
  const candidateText = normalizeWorkspaceText(candidate.content);
  if (!candidateText) return true;

  return messages.some((message) => workspaceTimelineMessagesMatch(message, candidate));
}

function normalizeWorkspaceText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildWorkspaceMessageMergeKey(message: OverlaySessionWorkspaceMessage): string {
  const id = cleanNullable(message.id);
  if (id) {
    return `id:${id}`;
  }

  return `fallback:${message.role}:${message.createdAt}:${normalizeWorkspaceText(message.content)}`;
}

function shouldReplaceWorkspaceMessage(
  current: OverlaySessionWorkspaceMessage,
  next: OverlaySessionWorkspaceMessage,
): boolean {
  if (current.content.length !== next.content.length) {
    return next.content.length > current.content.length;
  }

  if (current.createdAt !== next.createdAt) {
    return next.createdAt >= current.createdAt;
  }

  if ((current.source ?? "history") !== (next.source ?? "history")) {
    return (next.source ?? "history") === "history";
  }

  return String(next.id).length >= String(current.id).length;
}

function workspaceTextsOverlap(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function workspaceTimelineMessagesMatch(
  left: Extract<OverlaySessionWorkspaceTimelineItem, { type: "message" }>,
  right: Extract<OverlaySessionWorkspaceTimelineItem, { type: "message" }>,
): boolean {
  const leftId = cleanNullable(left.id);
  const rightId = cleanNullable(right.id);
  if (leftId && rightId && leftId === rightId) {
    return true;
  }

  if (left.role !== right.role) {
    return false;
  }

  if (!workspaceMessagesAreTemporallyClose(left.timestamp, right.timestamp)) {
    return false;
  }

  return workspaceTextsOverlap(normalizeWorkspaceText(left.content), normalizeWorkspaceText(right.content));
}

function workspaceMessagesAreTemporallyClose(left: number, right: number): boolean {
  if (!left || !right) {
    return false;
  }

  return Math.abs(left - right) <= WORKSPACE_MESSAGE_MATCH_WINDOW_MS;
}

interface ToolArtifactInterval {
  label: string;
  start: number;
  end: number;
}

const TOOL_LIFECYCLE_WINDOW_MS = 5_000;

const TOOL_LIFECYCLE_DETAILS = new Set([
  "running",
  "finished",
  "started",
  "completed",
  "tool running",
  "tool finished",
  "tool started",
  "tool completed",
]);

function buildToolArtifactIntervals(artifacts: OverlayChatArtifact[]): ToolArtifactInterval[] {
  return artifacts
    .filter((artifact) => artifact.kind === "tool")
    .map((artifact) => ({
      label: normalizeLookupToken(artifact.label) ?? "",
      start: artifact.createdAt - TOOL_LIFECYCLE_WINDOW_MS,
      end: (artifact.updatedAt ?? artifact.createdAt) + TOOL_LIFECYCLE_WINDOW_MS,
    }));
}

function isRedundantToolLifecycleEvent(
  item: Extract<OverlaySessionWorkspaceTimelineItem, { type: "event" | "artifact" }>,
  intervals: ToolArtifactInterval[],
): boolean {
  if (item.type !== "event") return false;

  const detail = normalizeLookupToken("detail" in item && typeof item.detail === "string" ? item.detail : null);
  if (!detail) return false;

  if (item.kind === "tool" || TOOL_LIFECYCLE_DETAILS.has(detail)) {
    return intervals.some((interval) => item.timestamp >= interval.start && item.timestamp <= interval.end);
  }

  return false;
}

function compareWorkspaceTimelineItems(
  left: OverlaySessionWorkspaceTimelineItem,
  right: OverlaySessionWorkspaceTimelineItem,
): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }

  const priorityDiff = workspaceTimelinePriority(left) - workspaceTimelinePriority(right);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  return left.id.localeCompare(right.id);
}

function workspaceTimelinePriority(item: OverlaySessionWorkspaceTimelineItem): number {
  switch (item.type) {
    case "message":
      return 0;
    case "artifact":
      return 1;
    case "event":
      return 2;
    default:
      return 3;
  }
}

function toCandidate(session: SessionEntry, source: OverlayCandidate["source"]): OverlayCandidate {
  return {
    sessionKey: session.sessionKey,
    sessionName: session.name ?? session.sessionKey,
    agentId: session.agentId,
    displayName: session.displayName ?? session.subject ?? session.lastTo ?? null,
    source,
    updatedAt: session.updatedAt,
  };
}

function toOverlaySessionSnapshot(session: SessionEntry, live?: OverlayLiveState): OverlaySessionSnapshot {
  return {
    sessionKey: session.sessionKey,
    sessionName: session.name ?? session.sessionKey,
    agentId: session.agentId,
    displayName: session.displayName ?? null,
    subject: session.subject ?? null,
    chatType: session.chatType ?? null,
    channel: session.lastChannel ?? session.channel ?? null,
    accountId: session.lastAccountId ?? session.accountId ?? null,
    chatId: session.lastTo ?? null,
    threadId: session.lastThreadId ?? null,
    modelOverride: session.modelOverride ?? null,
    thinkingLevel: session.thinkingLevel ?? null,
    queueMode: session.queueMode ?? null,
    abortedLastRun: session.abortedLastRun === true,
    compactionCount: session.compactionCount ?? 0,
    runtimeProvider: session.runtimeProvider ?? null,
    providerSessionId: session.providerSessionId ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastHeartbeatText: session.lastHeartbeatText ?? null,
    lastHeartbeatSentAt: session.lastHeartbeatSentAt ?? null,
    ephemeral: session.ephemeral === true,
    expiresAt: session.expiresAt ?? null,
    live: live ?? defaultLiveState(session),
  };
}

function buildActiveSessions(
  sessions: SessionEntry[],
  liveBySessionName?: Map<string, OverlayLiveState>,
): OverlaySessionSnapshot[] {
  return sessions
    .filter(isRelevantOverlaySession)
    .map((session) => ({
      session,
      live: session.name ? liveBySessionName?.get(session.name) : undefined,
    }))
    .filter(({ live }) => isBusyOverlayActivity(live?.activity))
    .sort((left, right) => sortByCreatedAtAsc(left.session, right.session))
    .map(({ session, live }) => toOverlaySessionSnapshot(session, live));
}

function buildRecentSessions(
  sessions: SessionEntry[],
  liveBySessionName?: Map<string, OverlayLiveState>,
): OverlaySessionSnapshot[] {
  const cutoff = Date.now() - OVERLAY_RECENT_SESSION_WINDOW_MS;
  return sessions
    .map((session) => ({
      session,
      live: session.name ? liveBySessionName?.get(session.name) : undefined,
    }))
    .filter(
      ({ session, live }) => getOverlaySessionActivityAt(session, live) >= cutoff && isRelevantOverlaySession(session),
    )
    .sort(sortByActivityAtDesc)
    .slice(0, OVERLAY_RECENT_SESSIONS_LIMIT)
    .map(({ session, live }) => toOverlaySessionSnapshot(session, live));
}

function buildHiddenActiveSessionNames(
  taskSessions: OverlayTaskSessionCandidate[],
  sessions: SessionEntry[],
): Set<string> {
  const resolvedTaskBySessionName = new Map<string, OverlayTaskSessionCandidate>();
  const sessionByName = buildSessionLookupByName(sessions);

  for (const task of taskSessions) {
    for (const sessionName of getTaskSessionNames(task)) {
      if (!isDedicatedTaskSession(sessionName, task, sessionByName.get(sessionName) ?? null)) {
        continue;
      }
      const current = resolvedTaskBySessionName.get(sessionName);
      if (!current || shouldReplaceTaskSessionCandidate(current, task)) {
        resolvedTaskBySessionName.set(sessionName, task);
      }
    }
  }

  return new Set(
    [...resolvedTaskBySessionName.entries()]
      .filter(([, task]) => shouldHideTaskSessionFromActiveSessions(task))
      .map(([sessionName]) => sessionName),
  );
}

function buildSessionLookupByName(sessions: SessionEntry[]): Map<string, SessionEntry> {
  const lookup = new Map<string, SessionEntry>();
  for (const session of sessions) {
    const names = [cleanNullable(session.name), cleanNullable(session.sessionKey)].filter(Boolean) as string[];
    for (const name of names) {
      lookup.set(name, session);
    }
  }
  return lookup;
}

function getTaskSessionNames(task: OverlayTaskSessionCandidate): string[] {
  return [
    ...new Set([cleanNullable(task.workSessionName), cleanNullable(task.assigneeSessionName)].filter(Boolean)),
  ] as string[];
}

function shouldHideTaskSessionFromActiveSessions(task: OverlayTaskSessionCandidate): boolean {
  return task.status === "done" || task.status === "failed" || Boolean(task.archivedAt);
}

function isDedicatedTaskSession(
  sessionName: string,
  task?: OverlayTaskSessionCandidate | null,
  session?: SessionEntry | null,
): boolean {
  if (session && taskSessionCreationMatchesTask(session, task)) {
    return true;
  }

  const normalizedSessionName = cleanNullable(sessionName);
  if (!normalizedSessionName) return false;

  const taskId = cleanNullable(task?.id ?? null);
  if (taskId && (normalizedSessionName === taskId || normalizedSessionName.startsWith(`${taskId}-`))) {
    return true;
  }

  const sessionNameTemplate = cleanNullable(task?.taskProfile?.sessionNameTemplate ?? null);
  if (taskId && sessionNameTemplate?.includes("<task-id>")) {
    const rendered = sessionNameTemplate.replaceAll("<task-id>", taskId);
    if (normalizedSessionName === rendered) return true;
  }

  return !taskId && normalizedSessionName.startsWith("task-");
}

function taskSessionCreationMatchesTask(session: SessionEntry, task?: OverlayTaskSessionCandidate | null): boolean {
  const sessionCreatedAt = normalizeTimestamp(session.createdAt);
  if (!sessionCreatedAt) return false;

  return getTaskSessionReferenceTimes(task).some(
    (timestamp) => Math.abs(sessionCreatedAt - timestamp) <= OVERLAY_TASK_SESSION_CREATION_WINDOW_MS,
  );
}

function getTaskSessionReferenceTimes(task?: OverlayTaskSessionCandidate | null): number[] {
  const timestamps = [task?.createdAt, task?.dispatchedAt, task?.startedAt].map(normalizeTimestamp).filter(Boolean);
  return [...new Set(timestamps)] as number[];
}

function normalizeTimestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function shouldReplaceTaskSessionCandidate(
  current: OverlayTaskSessionCandidate,
  next: OverlayTaskSessionCandidate,
): boolean {
  const currentHidden = shouldHideTaskSessionFromActiveSessions(current);
  const nextHidden = shouldHideTaskSessionFromActiveSessions(next);
  if (currentHidden !== nextHidden) {
    return !nextHidden;
  }
  return next.updatedAt > current.updatedAt;
}

function isRelevantOverlaySession(session: SessionEntry): boolean {
  const channel = normalizeLookupToken(session.lastChannel ?? session.channel);
  return !channel || channel.includes("whatsapp");
}

function isBusyOverlayActivity(activity: OverlayActivity | null | undefined): boolean {
  return Boolean(activity && activity !== "idle" && activity !== "unknown");
}

function defaultLiveState(session: SessionEntry): OverlayLiveState {
  if (session.abortedLastRun) {
    return {
      activity: "blocked",
      summary: "last run aborted",
      updatedAt: session.updatedAt,
      busySince: session.updatedAt,
      artifacts: [],
    };
  }
  return { activity: "idle", updatedAt: session.updatedAt, artifacts: [] };
}

function buildWarnings(query: OverlayQuery, session: SessionEntry | null, candidates: OverlayCandidate[]): string[] {
  const warnings: string[] = [];
  if (!query.chatId && !query.title && !query.session) {
    warnings.push("No chat context detected in WhatsApp Web.");
  }
  if (!session && candidates.length === 0) {
    warnings.push("No Ravi session matched this chat yet.");
  }
  if (!session && candidates.length > 1) {
    warnings.push("Multiple candidate sessions matched; refine the current chat context.");
  }
  return warnings;
}

function scoreTitleMatch(session: SessionEntry, needle: string): number {
  let best = 0;

  for (const field of [session.displayName, session.subject]) {
    best = Math.max(best, scoreComparableField(field, needle, 100));
  }

  best = Math.max(best, scoreComparableField(session.name, needle, 40));

  return best;
}

function shouldDisableFuzzyTitleMatching(needle: string): boolean {
  const tokens = tokenizeComparable(needle);
  return tokens.length === 1;
}

function scoreComparableField(rawField: string | null | undefined, needle: string, baseWeight: number): number {
  const field = normalizeComparableTitle(rawField);
  if (!field) return 0;
  if (field === needle) return baseWeight + 1000;

  const fieldTokens = tokenizeComparable(field);
  const needleTokens = tokenizeComparable(needle);
  if (fieldTokens.length === 0 || needleTokens.length === 0) return 0;

  const overlap = fieldTokens.filter((token) => needleTokens.includes(token)).length;
  const allFieldTokensMatch = overlap === fieldTokens.length;
  const meaningfulField = field.length >= 5;

  if (allFieldTokensMatch && fieldTokens.length >= 2) {
    return baseWeight + 500 + overlap * 20 + field.length;
  }

  if (meaningfulField && fieldTokens.length >= 2 && overlap >= 2) {
    return baseWeight + 300 + overlap * 15 + field.length;
  }

  if (meaningfulField && fieldTokens.length >= 2 && (needle.includes(field) || field.includes(needle))) {
    return baseWeight + 220 + field.length;
  }

  if (meaningfulField && fieldTokens.length === 1 && field.length >= 6 && needle.includes(field)) {
    return baseWeight + 120 + field.length;
  }

  return 0;
}

function normalizeComparableTitle(value: string | null | undefined): string | null {
  const cleaned = cleanNullable(value);
  if (!cleaned) return null;
  const comparable = cleaned
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[@._-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return comparable.length > 0 ? comparable : null;
}

function tokenizeComparable(value: string): string[] {
  return value
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function normalizeLookupToken(value: string | null | undefined): string | null {
  const cleaned = cleanNullable(value);
  if (!cleaned) return null;
  return cleaned.normalize("NFKC").trim().toLowerCase();
}

function cleanNullable(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sortByUpdatedAtDesc(a: SessionEntry, b: SessionEntry): number {
  return b.updatedAt - a.updatedAt;
}

function getOverlaySessionActivityAt(session: SessionEntry, live?: OverlayLiveState): number {
  return Math.max(session.updatedAt, live?.updatedAt ?? 0);
}

function sortByActivityAtDesc(
  a: { session: SessionEntry; live?: OverlayLiveState },
  b: { session: SessionEntry; live?: OverlayLiveState },
): number {
  const activityDiff = getOverlaySessionActivityAt(b.session, b.live) - getOverlaySessionActivityAt(a.session, a.live);
  if (activityDiff !== 0) return activityDiff;
  return sortByCreatedAtDesc(a.session, b.session);
}

function sortByCreatedAtAsc(a: SessionEntry, b: SessionEntry): number {
  return a.createdAt - b.createdAt || a.updatedAt - b.updatedAt || a.sessionKey.localeCompare(b.sessionKey);
}

function sortByCreatedAtDesc(a: SessionEntry, b: SessionEntry): number {
  return b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || a.sessionKey.localeCompare(b.sessionKey);
}
