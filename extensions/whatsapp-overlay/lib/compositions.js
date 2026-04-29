import { findBinding, getBindings, upsertBinding, getViewState } from "./storage.js";
import {
  ensureLiveStateStream,
  getLiveForSession,
  getLiveStateStreamStatus,
  isBusyLiveActivity,
} from "./live-state.js";

export async function buildSnapshot(client, query) {
  const [sessionsResult, allBindings] = await Promise.all([
    client.sessions.list({ live: true }).catch(() => ({ sessions: [] })),
    getBindings(),
    ensureLiveStateStream().catch(() => false),
  ]);

  const sessions = normalizeSessions(sessionsResult);
  const binding = await findBinding({ chatId: query?.chatId, title: query?.title });
  const requestedSessionName = clean(query?.session) ?? clean(binding?.session);

  const resolved = resolveSession(sessions, {
    chatId: query?.chatId,
    title: query?.title,
    session: requestedSessionName,
  });

  const now = Date.now();
  const activeSessions = sessions.filter(isActive).map(toListEntry);
  const activeKeys = new Set(activeSessions.map((s) => s.sessionKey));
  const recentSessions = sessions
    .filter((s) => !activeKeys.has(s.sessionKey))
    .slice(0, 30)
    .map(toListEntry);

  const warnings = [];
  if (query?.session && !resolved.session) {
    warnings.push({ code: "session_not_found", message: `Session not found: ${query.session}` });
  }
  if (!resolved.session && (query?.chatId || query?.title) && !binding) {
    warnings.push({ code: "no_binding", message: "No binding registered for this chat" });
  }
  const liveStatus = getLiveStateStreamStatus();
  if (!liveStatus.connected && liveStatus.lastError) {
    warnings.push({
      code: "live_stream_unavailable",
      message: `Live status stream unavailable: ${liveStatus.lastError}`,
    });
  }

  return {
    ok: true,
    query: {
      chatId: clean(query?.chatId),
      title: clean(query?.title),
      session: clean(query?.session),
    },
    resolved: Boolean(resolved.session),
    session: resolved.session ? toSessionSnapshot(resolved.session, binding) : null,
    candidates: resolved.candidates.map(toListEntry),
    activeSessions,
    recentSessions,
    hotSessions: activeSessions,
    recentChats: recentSessions,
    warnings,
    generatedAt: now,
  };
}

export async function buildTasksSnapshot(client, query) {
  const eventsLimit = typeof query?.eventsLimit === "number" ? query.eventsLimit : 20;
  const filters = {};
  if (clean(query?.status)) filters.status = clean(query.status);
  if (clean(query?.agentId)) filters.agent = clean(query.agentId);
  if (clean(query?.sessionName)) filters.session = clean(query.sessionName);

  const [tasksResult, sessionsResult] = await Promise.all([
    client.tasks.list(filters).catch(() => ({ tasks: [] })),
    client.sessions.list({ live: true }).catch(() => ({ sessions: [] })),
    ensureLiveStateStream().catch(() => false),
  ]);

  const tasks = normalizeTasks(tasksResult);
  const sessions = normalizeSessions(sessionsResult);
  const dispatchSessions = sessions.map(toDispatchSessionEntry);

  const items = tasks
    .map((t) => normalizeTaskItem(t))
    .sort((a, b) => (b.task.updatedAt ?? 0) - (a.task.updatedAt ?? 0));
  const activeItems = items.filter((i) => i.task.status !== "done" && i.task.status !== "failed");

  let selectedTaskId = clean(query?.taskId) ?? activeItems[0]?.task?.id ?? items[0]?.task?.id ?? null;
  let selectedTask = null;
  if (selectedTaskId) {
    const match = items.find((i) => i.task?.id === selectedTaskId) ?? null;
    if (match) {
      selectedTask = await hydrateSelectedTask(client, match, dispatchSessions, query?.actorSession);
    } else {
      selectedTaskId = activeItems[0]?.task?.id ?? items[0]?.task?.id ?? null;
      const fallback = selectedTaskId ? items.find((i) => i.task?.id === selectedTaskId) : null;
      if (fallback) {
        selectedTask = await hydrateSelectedTask(client, fallback, dispatchSessions, query?.actorSession);
      }
    }
  }

  const stats = computeTaskStats(items);
  const dailyActivity = buildDailyActivity(items, query?.timeZone, query?.todayKey);

  return {
    ok: true,
    generatedAt: Date.now(),
    query: {
      taskId: selectedTaskId,
      status: clean(query?.status),
      agentId: clean(query?.agentId),
      sessionName: clean(query?.sessionName),
      actorSession: clean(query?.actorSession),
      eventsLimit,
      timeZone: clean(query?.timeZone),
      todayKey: clean(query?.todayKey),
    },
    agents: [],
    sessions: dispatchSessions,
    stats,
    items,
    activeItems,
    dailyActivity,
    selectedTask,
  };
}

async function hydrateSelectedTask(client, item, dispatchSessions, actorSessionName) {
  let detail = null;
  try {
    detail = await client.tasks.show(item.task.id, {});
  } catch {}

  const merged = detail ? mergeTaskDetail(item, detail) : item;
  const actor = clean(actorSessionName);
  const actorSession = actor ? dispatchSessions.find((s) => s.sessionName === actor) : null;

  return {
    ...merged,
    taskDocument: detail?.taskDocument ?? null,
    dispatch: buildDispatchState(merged, actorSession ?? null, dispatchSessions),
  };
}

function buildDispatchState(item, actorSession, dispatchSessions) {
  const status = item.task?.status;
  const isOpen = status === "open" || status === "queued";
  const hasAssignment = Boolean(item.activeAssignment);
  const archived = Boolean(item.task?.archived);
  if (archived) {
    return { allowed: false, reason: "archived", defaultSessionName: null, defaultReportToSessionName: null };
  }
  if (hasAssignment) {
    return { allowed: false, reason: "assigned", defaultSessionName: null, defaultReportToSessionName: null };
  }
  if (!isOpen) {
    return { allowed: false, reason: "not_open", defaultSessionName: null, defaultReportToSessionName: null };
  }
  const defaultSessionName = item.task?.defaultSessionName ?? actorSession?.sessionName ?? null;
  return {
    allowed: true,
    reason: null,
    defaultSessionName,
    defaultReportToSessionName: actorSession?.sessionName ?? null,
    actorSessionName: actorSession?.sessionName ?? null,
    actorAgentId: actorSession?.agentId ?? null,
    availableSessions: dispatchSessions,
  };
}

export async function buildOmniPanelSnapshot(client, query) {
  const [sessionsResult, routesResult, allBindings] = await Promise.all([
    client.sessions.list({ live: true }).catch(() => ({ sessions: [] })),
    client.routes.list().catch(() => ({ routes: [] })),
    getBindings(),
    ensureLiveStateStream().catch(() => false),
  ]);

  const sessions = normalizeSessions(sessionsResult);
  const routes = Array.isArray(routesResult?.routes) ? routesResult.routes : [];
  const binding = await findBinding({ chatId: query?.chatId, title: query?.title });

  return {
    ok: true,
    generatedAt: Date.now(),
    query: {
      chatId: clean(query?.chatId),
      title: clean(query?.title),
      session: clean(query?.session),
      instance: clean(query?.instance),
    },
    binding: binding ?? null,
    bindings: allBindings,
    routes,
    sessions: sessions.map(toListEntry),
    instances: [],
  };
}

export async function executeOmniRoute(client, body) {
  const action = clean(body?.action);
  if (!action) return { ok: false, error: "Missing action", code: "invalid_action" };

  const session = clean(body?.session);
  const chatId = clean(body?.chatId);
  const title = clean(body?.title);
  const instance = clean(body?.instance);
  const chatType = clean(body?.chatType);
  const chatName = clean(body?.chatName);

  switch (action) {
    case "bind-existing": {
      if (!session || (!chatId && !title)) {
        return { ok: false, error: "session and chatId/title required", code: "invalid_args" };
      }
      const binding = await upsertBinding({ session, chatId, title, instance, chatType, chatName });
      return { ok: true, binding };
    }
    case "unbind": {
      if (!chatId && !title) return { ok: false, error: "chatId or title required", code: "invalid_args" };
      const list = await getBindings();
      const remaining = list.filter((b) => {
        if (chatId && b.chatId === chatId) return false;
        if (title && b.title === title) return false;
        return true;
      });
      if (remaining.length === list.length) return { ok: true, removed: false };
      const { setBindings } = await import("./storage.js");
      await setBindings(remaining);
      return { ok: true, removed: true };
    }
    default:
      return { ok: false, error: `Unsupported action: ${action}`, code: "unsupported_action" };
  }
}

export async function resolveChatList(client, body) {
  const entries = Array.isArray(body?.entries) ? body.entries : [];
  const [sessionsResult] = await Promise.all([
    client.sessions.list({ live: true }).catch(() => ({ sessions: [] })),
    ensureLiveStateStream().catch(() => false),
  ]);
  const sessions = normalizeSessions(sessionsResult);
  const items = await Promise.all(
    entries.map(async (entry) => {
      const id = clean(entry?.id) ?? null;
      const query = entry?.query ?? entry ?? {};
      const binding = await findBinding({ chatId: query.chatId, title: query.title });
      const requestedSessionName = clean(query.session) ?? clean(binding?.session);
      const resolved = resolveSession(sessions, {
        chatId: query.chatId,
        title: query.title,
        session: requestedSessionName,
      });
      return {
        id,
        query: {
          chatId: clean(query.chatId),
          title: clean(query.title),
          session: clean(query.session),
        },
        resolved: Boolean(resolved.session),
        session: resolved.session ? toSessionSnapshot(resolved.session, binding) : null,
        warnings: [],
      };
    }),
  );
  return { ok: true, items, generatedAt: Date.now() };
}

function normalizeSessions(result) {
  const list = Array.isArray(result?.sessions)
    ? result.sessions
    : Array.isArray(result?.items)
      ? result.items
      : Array.isArray(result)
        ? result
        : [];
  return list.map((s) => ({
    sessionKey: s.sessionKey ?? s.key ?? s.id,
    name: s.name ?? null,
    agentId: s.agentId ?? null,
    displayName: s.displayName ?? null,
    subject: s.subject ?? null,
    chatType: s.chatType ?? null,
    channel: s.channel ?? null,
    lastTo: s.lastTo ?? null,
    lastChannel: s.lastChannel ?? null,
    lastThreadId: s.lastThreadId ?? null,
    accountId: s.accountId ?? null,
    groupId: s.groupId ?? null,
    thinkingLevel: s.thinkingLevel ?? null,
    modelOverride: s.modelOverride ?? null,
    updatedAt: s.updatedAt ?? 0,
    createdAt: s.createdAt ?? 0,
    ...s,
  }));
}

function normalizeTasks(result) {
  const list = Array.isArray(result?.tasks)
    ? result.tasks
    : Array.isArray(result?.items)
      ? result.items
      : Array.isArray(result)
        ? result
        : [];
  return list;
}

function normalizeTaskItem(raw) {
  const task = raw?.task ?? raw;
  return {
    task,
    activeAssignment: raw?.activeAssignment ?? null,
    project: raw?.project ?? null,
    visualStatus: raw?.visualStatus ?? task?.status ?? null,
    runtime: raw?.runtime ?? null,
    readiness: raw?.readiness ?? null,
    dependencyCount: raw?.dependencyCount ?? 0,
    unsatisfiedDependencyCount: raw?.unsatisfiedDependencyCount ?? 0,
    launchPlan: raw?.launchPlan ?? null,
    events: raw?.events ?? [],
  };
}

function mergeTaskDetail(item, detail) {
  return {
    ...item,
    task: detail?.task ?? item.task,
    activeAssignment: detail?.activeAssignment ?? item.activeAssignment,
    events: detail?.events ?? item.events,
    runtime: detail?.runtime ?? item.runtime,
  };
}

function isActive(session) {
  const live = getLiveForSession(session);
  return isBusyLiveActivity(live?.activity);
}

function toListEntry(session) {
  const live = getLiveForSession(session);
  return {
    sessionKey: session.sessionKey,
    sessionName: session.name ?? session.sessionKey,
    agentId: session.agentId,
    displayName: session.displayName ?? null,
    chatType: session.chatType ?? null,
    channel: session.channel ?? null,
    chatId: session.lastTo ?? null,
    updatedAt: session.updatedAt ?? 0,
    createdAt: session.createdAt ?? 0,
    thinkingLevel: session.thinkingLevel ?? null,
    modelOverride: session.modelOverride ?? null,
    live,
  };
}

function toDispatchSessionEntry(session) {
  const live = getLiveForSession(session);
  return {
    sessionName: session.name ?? session.sessionKey,
    agentId: session.agentId,
    displayName: session.displayName ?? null,
    activity: live.activity,
    live,
  };
}

function toSessionSnapshot(session, binding) {
  return {
    ...toListEntry(session),
    name: session.name ?? null,
    subject: session.subject ?? null,
    accountId: session.accountId ?? null,
    groupId: session.groupId ?? null,
    boundChatId: binding?.chatId ?? null,
    boundTitle: binding?.title ?? null,
  };
}

function resolveSession(sessions, query) {
  const name = clean(query?.session);
  if (name) {
    const exact = sessions.find((s) => s.name === name || s.sessionKey === name);
    if (exact) return { session: exact, candidates: [] };
  }
  const chatId = clean(query?.chatId);
  if (chatId) {
    const byChat = sessions.find((s) => s.lastTo === chatId);
    if (byChat) {
      const others = sessions.filter((s) => s.lastTo === chatId && s.sessionKey !== byChat.sessionKey);
      return { session: byChat, candidates: others };
    }
  }
  const title = clean(query?.title);
  if (title) {
    const byTitle = sessions.find((s) => s.subject === title || s.displayName === title);
    if (byTitle) {
      const others = sessions.filter((s) => (s.subject === title || s.displayName === title) && s.sessionKey !== byTitle.sessionKey);
      return { session: byTitle, candidates: others };
    }
  }
  return { session: null, candidates: [] };
}

function computeTaskStats(items) {
  const stats = { open: 0, queued: 0, dispatched: 0, done: 0, failed: 0, total: items.length };
  for (const item of items) {
    const status = item.task?.status;
    if (status && status in stats) stats[status]++;
  }
  return stats;
}

function buildDailyActivity(items, timeZone, todayKey) {
  const byDay = new Map();
  for (const item of items) {
    const ts = item.task?.updatedAt ?? item.task?.createdAt;
    if (!ts) continue;
    const key = formatDayKey(ts, timeZone);
    const bucket = byDay.get(key) ?? { date: key, total: 0, done: 0, open: 0, failed: 0 };
    bucket.total++;
    if (item.task.status === "done") bucket.done++;
    else if (item.task.status === "failed") bucket.failed++;
    else bucket.open++;
    byDay.set(key, bucket);
  }
  return {
    timeZone: clean(timeZone) ?? "UTC",
    todayKey: clean(todayKey),
    days: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function formatDayKey(ts, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function clean(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
