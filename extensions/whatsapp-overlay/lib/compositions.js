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
  filters.last = clean(query?.last) ?? "all";
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
      last: filters.last,
      archiveMode: tasksResult?.archiveMode ?? null,
      limit: tasksResult?.limit ?? null,
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

export async function buildCrmSnapshot(client, query = {}) {
  const warnings = [];
  const limit = clean(query?.limit) ?? "120";
  const owner = clean(query?.owner);
  const contact = clean(query?.contact);
  const account = clean(query?.account);
  const opportunity = clean(query?.opportunity);

  const contactsOptions = { limit };
  if (owner) contactsOptions.owner = owner;

  const nextOptions = { limit };
  if (owner) nextOptions.owner = owner;
  if (contact) nextOptions.contact = contact;
  if (account) nextOptions.account = account;
  if (opportunity) nextOptions.opportunity = opportunity;

  const [contactsResult, actionsResult, boardResult] = await Promise.all([
    safeCrmCall(warnings, "contacts", () => client.crm.contacts(contactsOptions), {
      total: 0,
      contacts: [],
      items: [],
    }),
    safeCrmCall(warnings, "next", () => client.crm.next(nextOptions), {
      total: 0,
      actions: [],
      items: [],
    }),
    safeCrmCall(warnings, "board", () => client.crm.board(), {
      total: 0,
      opportunities: [],
    }),
  ]);

  const contacts = normalizeCrmList(contactsResult, "contacts");
  const actions = normalizeCrmList(actionsResult, "actions");
  const opportunities = normalizeCrmList(boardResult, "opportunities");

  return {
    ok: true,
    generatedAt: Date.now(),
    query: {
      limit,
      owner,
      contact,
      account,
      opportunity,
    },
    contacts,
    actions,
    opportunities,
    totals: {
      contacts: normalizeCrmTotal(contactsResult, contacts),
      actions: normalizeCrmTotal(actionsResult, actions),
      opportunities: normalizeCrmTotal(boardResult, opportunities),
    },
    stats: computeCrmStats({ contacts, actions, opportunities, contactsResult, actionsResult, boardResult }),
    warnings,
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

async function safeCrmCall(warnings, name, fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    warnings.push({
      code: `crm_${name}_unavailable`,
      message: error?.message || String(error),
    });
    return fallback;
  }
}

function normalizeCrmList(result, preferredKey) {
  if (Array.isArray(result?.[preferredKey])) return result[preferredKey];
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result)) return result;
  return [];
}

function normalizeCrmTotal(result, list) {
  const numeric = Number(result?.total);
  return Number.isFinite(numeric) ? numeric : list.length;
}

function computeCrmStats({ contacts, actions, opportunities, contactsResult, actionsResult, boardResult }) {
  const contactsByLifecycle = {};
  const contactsByHealth = {};
  const actionsByPriority = {};
  const opportunitiesByStage = {};
  let overdueActions = 0;
  let attentionContacts = 0;

  for (const contact of contacts) {
    const lifecycle = clean(contact?.lifecycle) ?? "unknown";
    const health = clean(contact?.relationshipHealth) ?? "unknown";
    contactsByLifecycle[lifecycle] = (contactsByLifecycle[lifecycle] ?? 0) + 1;
    contactsByHealth[health] = (contactsByHealth[health] ?? 0) + 1;
    if (health === "at_risk" || health === "needs_attention" || health === "unknown") {
      attentionContacts++;
    }
  }

  for (const action of actions) {
    const priority = clean(action?.priority) ?? "normal";
    actionsByPriority[priority] = (actionsByPriority[priority] ?? 0) + 1;
    if (isPastCrmDate(action?.dueAt)) overdueActions++;
  }

  for (const opportunity of opportunities) {
    const stage = clean(opportunity?.stageKey) ?? clean(opportunity?.status) ?? "unknown";
    opportunitiesByStage[stage] = (opportunitiesByStage[stage] ?? 0) + 1;
  }

  return {
    totalContacts: normalizeCrmTotal(contactsResult, contacts),
    nextActions: normalizeCrmTotal(actionsResult, actions),
    openOpportunities: normalizeCrmTotal(boardResult, opportunities),
    attention: attentionContacts + overdueActions + (actionsByPriority.urgent ?? 0),
    overdueActions,
    contactsByLifecycle,
    contactsByHealth,
    actionsByPriority,
    opportunitiesByStage,
  };
}

function isPastCrmDate(value) {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time < Date.now();
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
  const [sessionsResult, agentsResult, routesResult, instancesResult, allBindings] = await Promise.all([
    client.sessions.list({ live: true }).catch(() => ({ sessions: [] })),
    listAgents(client),
    client.routes.list().catch(() => ({ routes: [] })),
    listInstances(client),
    getBindings(),
    ensureLiveStateStream().catch(() => false),
  ]);

  const sessions = normalizeSessions(sessionsResult);
  const agents = mergeAgentsWithSessions(normalizeAgents(agentsResult), sessions);
  const routes = Array.isArray(routesResult?.routes) ? routesResult.routes : [];
  const instances = normalizeInstances(instancesResult);
  const preferredInstance = resolvePreferredInstance(instances, query?.instance);
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
    agents,
    instances,
    preferredInstance,
  };
}

export async function executeOmniRoute(client, body) {
  const action = clean(body?.action);
  if (!action) return { ok: false, error: "Missing action", code: "invalid_action" };

  const session = clean(body?.session ?? body?.sessionName);
  const chatId = clean(body?.chatId);
  const title = clean(body?.title);
  const instance = clean(body?.instance);
  const chatType = clean(body?.chatType);
  const chatName = clean(body?.chatName);
  const agentId = clean(body?.agentId);
  const channel = clean(body?.channel) ?? "whatsapp";

  switch (action) {
    case "bind-existing": {
      if (!session || !agentId || !chatId || !instance) {
        return { ok: false, error: "session, agentId, chatId and instance required", code: "invalid_args" };
      }
      const runtimeRoute = await upsertRuntimeChatRoute(client, { session, agentId, chatId, instance, channel });
      if (runtimeRoute?.ok === false) return runtimeRoute;
      const binding = await upsertBinding({ session, agentId: clean(body?.agentId), chatId, title, instance, chatType, chatName });
      return { ok: true, binding, runtimeRoute };
    }
    case "create-session": {
      if (!agentId || !chatId || !instance) {
        return { ok: false, error: "agentId, chatId and instance required", code: "invalid_args" };
      }
      const sessionName = session || buildSyntheticSessionName(agentId, chatName || title || chatId);
      const runtimeRoute = await upsertRuntimeChatRoute(client, { session: sessionName, agentId, chatId, instance, channel });
      if (runtimeRoute?.ok === false) return runtimeRoute;
      const binding = await upsertBinding({ session: sessionName, agentId, chatId, title, instance, chatType, chatName });
      const snapshot = toSessionSnapshot(createSyntheticBindingSession(binding), binding);
      return { ok: true, createdSession: true, binding, runtimeRoute, snapshot: { session: snapshot } };
    }
    case "migrate-session": {
      if (!agentId || !chatId || !instance) {
        return { ok: false, error: "agentId, chatId and instance required", code: "invalid_args" };
      }
      const sessionName = session || buildSyntheticSessionName(agentId, chatName || title || chatId);
      const runtimeRoute = await upsertRuntimeChatRoute(client, { session: sessionName, agentId, chatId, instance, channel });
      if (runtimeRoute?.ok === false) return runtimeRoute;
      const binding = await upsertBinding({ session: sessionName, agentId, chatId, title, instance, chatType, chatName });
      const snapshot = toSessionSnapshot(createSyntheticBindingSession(binding), binding);
      return {
        ok: true,
        migratedSession: true,
        fromSession: clean(body?.fromSession) ?? null,
        binding,
        runtimeRoute,
        snapshot: { session: snapshot },
      };
    }
    case "unbind": {
      if (!chatId && !title) return { ok: false, error: "chatId or title required", code: "invalid_args" };
      const runtimeRoute = chatId && instance ? await clearRuntimeChatRouteSession(client, { chatId, instance }) : null;
      const list = await getBindings();
      const remaining = list.filter((b) => {
        if (chatId && b.chatId === chatId) return false;
        if (title && b.title === title) return false;
        return true;
      });
      if (remaining.length === list.length) return { ok: true, removed: false, runtimeRoute };
      const { setBindings } = await import("./storage.js");
      await setBindings(remaining);
      return { ok: true, removed: true, runtimeRoute };
    }
    default:
      return { ok: false, error: `Unsupported action: ${action}`, code: "unsupported_action" };
  }
}

export async function resolveChatList(client, body) {
  const entries = Array.isArray(body?.entries) ? body.entries : [];
  const [sessionsResult, agentsResult] = await Promise.all([
    client.sessions.list({ live: true }).catch(() => ({ sessions: [] })),
    listAgents(client),
    ensureLiveStateStream().catch(() => false),
  ]);
  const sessions = normalizeSessions(sessionsResult);
  const agents = mergeAgentsWithSessions(normalizeAgents(agentsResult), sessions);
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
      const syntheticSession = !resolved.session && binding?.session ? createSyntheticBindingSession(binding) : null;
      const matchedSession = resolved.session ?? syntheticSession;
      return {
        id,
        query: {
          chatId: clean(query.chatId),
          title: clean(query.title),
          session: clean(query.session),
        },
        resolved: Boolean(matchedSession),
        session: matchedSession ? toSessionSnapshot(matchedSession, binding) : null,
        warnings: [],
      };
    }),
  );
  return { ok: true, items, sessions: sessions.map(toListEntry), agents, generatedAt: Date.now() };
}

async function upsertRuntimeChatRoute(client, input) {
  const instance = clean(input?.instance);
  const agentId = clean(input?.agentId);
  const session = clean(input?.session);
  const pattern = normalizeChatRoutePattern(input?.chatId);
  const channel = clean(input?.channel) ?? "whatsapp";
  if (!instance || !agentId || !session || !pattern) {
    return { ok: false, error: "instance, agentId, session and chatId required", code: "invalid_route_args" };
  }

  const options = { allowRuntimeMismatch: true, asJson: true };
  const route = await getRuntimeRoute(client, instance, pattern);
  if (!route) {
    const created = await client.instances.routes.add(instance, pattern, agentId, {
      ...options,
      session,
      priority: "100",
      channel,
    });
    return { ok: true, action: "created", pattern, instance, route: created?.route ?? created };
  }

  await client.instances.routes.set(instance, pattern, "agent", agentId, options);
  await client.instances.routes.set(instance, pattern, "session", session, options);
  await client.instances.routes.set(instance, pattern, "priority", "100", options).catch(() => null);
  await client.instances.routes.set(instance, pattern, "channel", channel, options).catch(() => null);
  const updated = await getRuntimeRoute(client, instance, pattern).catch(() => null);
  return { ok: true, action: "updated", pattern, instance, route: updated };
}

async function clearRuntimeChatRouteSession(client, input) {
  const instance = clean(input?.instance);
  const pattern = normalizeChatRoutePattern(input?.chatId);
  if (!instance || !pattern) return { ok: false, error: "instance and chatId required", code: "invalid_route_args" };
  const route = await getRuntimeRoute(client, instance, pattern);
  if (!route) return { ok: true, action: "missing", pattern, instance };
  if (!route.session) return { ok: true, action: "unchanged", pattern, instance, route };
  const options = { allowRuntimeMismatch: true, asJson: true };
  await client.instances.routes.set(instance, pattern, "session", "-", options);
  const updated = await getRuntimeRoute(client, instance, pattern).catch(() => null);
  return { ok: true, action: "cleared-session", pattern, instance, route: updated };
}

async function getRuntimeRoute(client, instance, pattern) {
  try {
    const result = await client.instances.routes.show(instance, pattern);
    return result?.route ?? null;
  } catch {
    return null;
  }
}

function normalizeChatRoutePattern(chatId) {
  const value = clean(chatId);
  if (!value) return null;
  const lowered = value.toLowerCase();
  if (lowered.startsWith("group:")) {
    const groupId = lowered.slice(6).replace(/@.*$/, "");
    return groupId ? `group:${groupId}` : null;
  }
  const groupMatch = lowered.match(/^(\d+(?:-\d+)?)@g\.us$/);
  if (groupMatch?.[1]) return `group:${groupMatch[1]}`;
  const userMatch = lowered.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  if (userMatch?.[1]) return userMatch[1];
  const lidMatch = lowered.match(/^(\d+)@lid$/);
  if (lidMatch?.[1]) return `lid:${lidMatch[1]}`;
  if (lowered.startsWith("lid:")) return lowered;
  const digits = lowered.replace(/\D/g, "");
  return digits || lowered;
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
    lastAccountId: s.lastAccountId ?? null,
    groupId: s.groupId ?? null,
    thinkingLevel: s.thinkingLevel ?? null,
    modelOverride: s.modelOverride ?? null,
    updatedAt: s.updatedAt ?? 0,
    createdAt: s.createdAt ?? 0,
    ...s,
  }));
}

function listAgents(client) {
  return client?.agents?.list
    ? client.agents.list({}).catch(() => ({ agents: [] }))
    : Promise.resolve({ agents: [] });
}

function listInstances(client) {
  return client?.instances?.list
    ? client.instances.list({ asJson: true, limit: "100" }).catch(() => ({ instances: [] }))
    : Promise.resolve({ instances: [] });
}

function normalizeAgents(result) {
  const list = Array.isArray(result?.agents)
    ? result.agents
    : Array.isArray(result?.items)
      ? result.items
      : Array.isArray(result)
        ? result
        : [];
  return list
    .map((agent) => {
      const id = clean(agent?.id ?? agent?.agentId ?? agent?.name);
      if (!id) return null;
      return {
        ...agent,
        id,
        name: clean(agent?.name ?? agent?.displayName ?? id) ?? id,
        displayName: clean(agent?.displayName ?? agent?.name ?? id) ?? id,
        cwd: clean(agent?.cwd),
        provider: clean(agent?.provider),
        model: clean(agent?.model),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function mergeAgentsWithSessions(agents, sessions) {
  const byId = new Map();
  for (const agent of agents) {
    if (agent?.id && !byId.has(agent.id)) byId.set(agent.id, agent);
  }
  for (const session of sessions) {
    const id = clean(session?.agentId);
    if (!id || byId.has(id)) continue;
    byId.set(id, { id, name: id, displayName: id, inferred: true });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeInstances(result) {
  const list = Array.isArray(result?.instances)
    ? result.instances
    : Array.isArray(result?.items)
      ? result.items
      : Array.isArray(result)
        ? result
        : [];
  return list
    .map((instance) => {
      if (!instance || typeof instance !== "object") return null;
      const live = instance.live && typeof instance.live === "object" ? instance.live : {};
      const name = clean(instance.name ?? instance.id);
      const id = name ?? clean(instance.id ?? instance.instanceId);
      if (!id) return null;
      const profileName = clean(instance.profileName ?? live.profileName ?? instance.profile?.name);
      const instanceId = clean(instance.instanceId);
      const channel = clean(instance.channel) ?? "whatsapp";
      const ownerIdentifier = clean(instance.ownerIdentifier ?? instanceId ?? instance.externalId);
      const phone = clean(instance.phone ?? live.phone ?? instance.defaults?.phone);
      const enabled = instance.enabled !== false && instance.raviStatus !== "disabled";
      const isConnected = Boolean(instance.isConnected ?? live.isConnected);
      const isActive = enabled && Boolean(instance.isActive ?? live.isActive ?? isConnected);
      return {
        ...instance,
        id,
        name: name ?? id,
        instanceId,
        channel,
        profileName,
        phone,
        ownerIdentifier,
        isConnected,
        isActive,
        raviStatus: instance.raviStatus ?? (enabled ? "enabled" : "disabled"),
        updatedAt: instance.updatedAt ?? live.updatedAt ?? null,
        lastSeenAt: instance.lastSeenAt ?? live.lastSeenAt ?? null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.isConnected !== right.isConnected) return left.isConnected ? -1 : 1;
      if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

function resolvePreferredInstance(instances, requested) {
  const preferred = clean(requested);
  if (preferred) {
    const exact = instances.find((instance) =>
      [instance.id, instance.name, instance.instanceId].filter(Boolean).includes(preferred),
    );
    if (exact) return exact;
  }
  return (
    instances.find((instance) => instance.isConnected) ??
    instances.find((instance) => instance.isActive) ??
    instances[0] ??
    null
  );
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
    accountId: session.accountId ?? session.lastAccountId ?? null,
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
    accountId: session.accountId ?? session.lastAccountId ?? null,
    groupId: session.groupId ?? null,
    boundChatId: binding?.chatId ?? null,
    boundTitle: binding?.title ?? null,
  };
}

function createSyntheticBindingSession(binding) {
  const sessionName = clean(binding?.session);
  const agentId = clean(binding?.agentId) ?? inferAgentIdFromSessionName(sessionName) ?? "agent";
  const now = Number(binding?.updatedAt || Date.now());
  return {
    sessionKey: sessionName,
    name: sessionName,
    agentId,
    displayName: clean(binding?.chatName ?? binding?.title),
    subject: clean(binding?.chatName ?? binding?.title),
    chatType: clean(binding?.chatType),
    channel: "whatsapp",
    lastChannel: "whatsapp",
    lastTo: clean(binding?.chatId),
    accountId: clean(binding?.instance),
    updatedAt: now,
    createdAt: now,
    live: {
      activity: "idle",
      summary: "local binding",
      updatedAt: now,
    },
  };
}

function buildSyntheticSessionName(agentId, label) {
  const agentStem = slugifyToken(agentId) || "agent";
  const chatStem = slugifyToken(label) || "chat";
  return `${agentStem}-${chatStem}`.slice(0, 48);
}

function inferAgentIdFromSessionName(sessionName) {
  const raw = clean(sessionName);
  if (!raw) return null;
  const match = raw.match(/^agent:([^:]+):/);
  if (match?.[1]) return match[1];
  const dash = raw.match(/^([a-zA-Z0-9_-]+)-/);
  return dash?.[1] ?? null;
}

function slugifyToken(value) {
  return clean(value)
    ?.toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) ?? "";
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
  const stats = {
    open: 0,
    queued: 0,
    dispatched: 0,
    inProgress: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    total: items.length,
  };
  for (const item of items) {
    const status = item.task?.status;
    if (status === "in_progress") {
      stats.inProgress++;
    } else if (status === "dispatched") {
      stats.dispatched++;
      stats.queued++;
    } else if (status && status in stats) {
      stats[status]++;
    }
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
