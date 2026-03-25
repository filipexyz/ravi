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

export interface OverlayLiveState {
  activity: OverlayActivity;
  approvalPending?: boolean;
  summary?: string;
  updatedAt?: number;
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
  warnings: string[];
  generatedAt: number;
}

export interface OverlayChatListEntry {
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

export function buildOverlaySnapshot(args: {
  query: OverlayQuery;
  sessions: SessionEntry[];
  liveBySessionName?: Map<string, OverlayLiveState>;
}): OverlaySnapshot {
  const resolved = resolveSessionForOverlay(args.query, args.sessions);
  const live = resolved.session?.name ? args.liveBySessionName?.get(resolved.session.name) : undefined;

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
    warnings: buildWarnings(args.query, resolved.session, resolved.candidates),
    generatedAt: Date.now(),
  };
}

export function buildOverlayChatList(args: {
  entries: Array<{ id: string; query: OverlayQuery }>;
  sessions: SessionEntry[];
  liveBySessionName?: Map<string, OverlayLiveState>;
}): OverlayChatListEntry[] {
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
  if (!needle) return [];

  const exact: SessionEntry[] = [];
  const fuzzy: SessionEntry[] = [];

  for (const session of sessions) {
    const fields = [session.displayName, session.subject, session.name, session.lastTo]
      .map(normalizeLookupToken)
      .filter(Boolean) as string[];
    if (fields.length === 0) continue;
    if (fields.some((field) => field === needle)) {
      exact.push(session);
      continue;
    }
    if (fields.some((field) => field.includes(needle) || needle.includes(field))) {
      fuzzy.push(session);
    }
  }

  return [...exact.sort(sortByUpdatedAtDesc), ...fuzzy.sort(sortByUpdatedAtDesc)];
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
