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

export interface OverlaySessionEvent {
  kind: "prompt" | "stream" | "tool" | "response" | "approval" | "runtime";
  label: string;
  detail?: string;
  timestamp: number;
}

export interface OverlayLiveState {
  activity: OverlayActivity;
  approvalPending?: boolean;
  summary?: string;
  updatedAt?: number;
  events?: OverlaySessionEvent[];
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
  updatedAt: number;
  lastHeartbeatText: string | null;
  lastHeartbeatSentAt: number | null;
  ephemeral: boolean;
  expiresAt: number | null;
  live: OverlayLiveState;
}

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
  recentSessions: OverlaySessionSnapshot[];
  /**
   * Backward-compatible alias for callers still expecting the older chat-centric field.
   * Keep this until the cockpit UI is fully migrated.
   */
  recentChats: OverlaySessionSnapshot[];
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
}): OverlaySnapshot {
  const resolved = resolveSessionForOverlay(args.query, args.sessions);
  const live = resolved.session?.name ? args.liveBySessionName?.get(resolved.session.name) : undefined;
  const recentSessions = buildRecentSessions(args.sessions, args.liveBySessionName);

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
    recentSessions,
    recentChats: recentSessions,
    hotSessions: buildHotSessions(args.sessions, args.liveBySessionName),
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
    updatedAt: session.updatedAt,
    lastHeartbeatText: session.lastHeartbeatText ?? null,
    lastHeartbeatSentAt: session.lastHeartbeatSentAt ?? null,
    ephemeral: session.ephemeral === true,
    expiresAt: session.expiresAt ?? null,
    live: live ?? defaultLiveState(session),
  };
}

function buildRecentSessions(
  sessions: SessionEntry[],
  liveBySessionName?: Map<string, OverlayLiveState>,
): OverlaySessionSnapshot[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return sessions
    .filter((session) => session.updatedAt >= cutoff && isRelevantOverlaySession(session))
    .sort(sortByUpdatedAtDesc)
    .slice(0, 12)
    .map((session) =>
      toOverlaySessionSnapshot(session, session.name ? liveBySessionName?.get(session.name) : undefined),
    );
}

function buildHotSessions(
  sessions: SessionEntry[],
  liveBySessionName?: Map<string, OverlayLiveState>,
): OverlaySessionSnapshot[] {
  return sessions
    .filter(isRelevantOverlaySession)
    .map((session) =>
      toOverlaySessionSnapshot(session, session.name ? liveBySessionName?.get(session.name) : undefined),
    )
    .filter((session) => session.live.activity !== "idle" && session.live.activity !== "unknown")
    .sort((a, b) => (b.live.updatedAt ?? b.updatedAt) - (a.live.updatedAt ?? a.updatedAt))
    .slice(0, 8);
}

function isRelevantOverlaySession(session: SessionEntry): boolean {
  const channel = normalizeLookupToken(session.lastChannel ?? session.channel);
  return !channel || channel.includes("whatsapp");
}

function defaultLiveState(session: SessionEntry): OverlayLiveState {
  if (session.abortedLastRun) {
    return { activity: "blocked", summary: "last run aborted", updatedAt: session.updatedAt };
  }
  return { activity: "idle", updatedAt: session.updatedAt };
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
  if (tokens.length !== 1) return false;
  const token = tokens[0] ?? "";
  return token.length <= 5;
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
