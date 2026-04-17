import { basename } from "node:path";
import { dbGetAgent } from "../router/router-db.js";
import { listSessions, resolveSession as resolveSessionEntry } from "../router/sessions.js";
import type { SessionEntry } from "../router/types.js";
import {
  dbGetInsight,
  dbListInsights,
  type InsightDetail,
  type InsightLink,
  type InsightLinkTargetType,
  type InsightListQuery,
  type InsightSummary,
} from "../insights/index.js";
import { buildTaskStreamSnapshot, type TaskStatus, type TaskStreamTaskEntity } from "../tasks/index.js";
import type { OverlayActivity, OverlayLiveState } from "./model.js";

const DEFAULT_INSIGHTS_LIMIT = 80;
const MAX_INSIGHTS_LIMIT = 200;

const INSIGHT_LINK_ORDER: Record<InsightLinkTargetType, number> = {
  task: 0,
  session: 1,
  agent: 2,
  artifact: 3,
  profile: 4,
};

export interface OverlayInsightSessionRef {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  displayName: string | null;
  chatId: string | null;
  activity: OverlayActivity;
  updatedAt: number;
}

export interface OverlayInsightTaskRef {
  id: string;
  title: string | null;
  status: TaskStatus | null;
  profileId: string | null;
  updatedAt: number | null;
}

export interface OverlayInsightAgentRef {
  agentId: string;
  name: string | null;
  session: OverlayInsightSessionRef | null;
}

export interface OverlayInsightLinkRef {
  targetType: InsightLinkTargetType;
  targetId: string;
  label: string;
  value: string;
  action: "focus-task" | "open-session" | "open-agent-session" | "open-url" | "copy";
  href: string | null;
  copyText: string | null;
  task: OverlayInsightTaskRef | null;
  session: OverlayInsightSessionRef | null;
  agent: OverlayInsightAgentRef | null;
}

export interface OverlayInsightItem {
  id: string;
  kind: InsightSummary["kind"];
  summary: string;
  detail: string | null;
  confidence: InsightSummary["confidence"];
  importance: InsightSummary["importance"];
  author: InsightSummary["author"];
  origin: InsightSummary["origin"];
  createdAt: number;
  updatedAt: number;
  linkCount: number;
  commentCount: number;
  latestComment: string | null;
  links: OverlayInsightLinkRef[];
}

export interface OverlayInsightsSnapshot {
  ok: true;
  generatedAt: number;
  query: {
    limit: number;
  };
  stats: {
    total: number;
    highImportance: number;
    highConfidence: number;
    withLineage: number;
    byKind: Record<string, number>;
  };
  items: OverlayInsightItem[];
}

export interface BuildOverlayInsightsPayloadArgs {
  limit?: number;
  liveBySessionName?: Map<string, OverlayLiveState>;
  sessions?: SessionEntry[];
  listInsightSummaries?: (query: InsightListQuery) => InsightSummary[];
  getInsightDetail?: (insightId: string) => InsightDetail | null;
  resolveTask?: (taskId: string) => TaskStreamTaskEntity | null;
  resolveSession?: (nameOrKey: string) => SessionEntry | null;
  resolveAgentName?: (agentId: string) => string | null;
}

export function buildOverlayInsightsPayload(args: BuildOverlayInsightsPayloadArgs = {}): OverlayInsightsSnapshot {
  const limit = normalizeInsightsLimit(args.limit);
  const sessions = sortSessionsByUpdatedAt(args.sessions ?? listSessions());
  const listInsightSummaries = args.listInsightSummaries ?? dbListInsights;
  const getInsightDetail = args.getInsightDetail ?? dbGetInsight;
  const resolveTask = args.resolveTask ?? defaultResolveTask;
  const resolveSession = args.resolveSession ?? resolveSessionEntry;
  const resolveAgentName = args.resolveAgentName ?? defaultResolveAgentName;

  const taskCache = new Map<string, OverlayInsightTaskRef | null>();
  const sessionCache = new Map<string, OverlayInsightSessionRef | null>();
  const agentCache = new Map<string, OverlayInsightAgentRef | null>();
  const kindStats: Record<string, number> = {};

  const items = listInsightSummaries({ limit }).map((summary) => {
    const detail = getInsightDetail(summary.id);
    const latestComment = detail?.comments?.at(-1)?.body?.trim() || null;
    const links = buildDecoratedInsightLinks(summary, detail, {
      sessions,
      liveBySessionName: args.liveBySessionName,
      resolveTaskRef(taskId) {
        if (taskCache.has(taskId)) return taskCache.get(taskId) ?? null;
        const task = toInsightTaskRef(resolveTask(taskId));
        taskCache.set(taskId, task);
        return task;
      },
      resolveSessionRef(nameOrKey) {
        if (sessionCache.has(nameOrKey)) return sessionCache.get(nameOrKey) ?? null;
        const session = resolveSession(nameOrKey);
        const sessionRef = session ? toInsightSessionRef(session, args.liveBySessionName) : null;
        sessionCache.set(nameOrKey, sessionRef);
        return sessionRef;
      },
      resolveAgentRef(agentId) {
        if (agentCache.has(agentId)) return agentCache.get(agentId) ?? null;
        const agent = toInsightAgentRef(agentId, resolveAgentName(agentId), sessions, args.liveBySessionName);
        agentCache.set(agentId, agent);
        return agent;
      },
    });

    kindStats[summary.kind] = (kindStats[summary.kind] ?? 0) + 1;

    return {
      id: summary.id,
      kind: summary.kind,
      summary: summary.summary,
      detail: summary.detail ?? null,
      confidence: summary.confidence,
      importance: summary.importance,
      author: summary.author,
      origin: summary.origin,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      linkCount: summary.linkCount,
      commentCount: summary.commentCount,
      latestComment,
      links,
    } satisfies OverlayInsightItem;
  });

  return {
    ok: true,
    generatedAt: Date.now(),
    query: {
      limit,
    },
    stats: {
      total: items.length,
      highImportance: items.filter((item) => item.importance === "high").length,
      highConfidence: items.filter((item) => item.confidence === "high").length,
      withLineage: items.filter((item) => item.links.length > 0).length,
      byKind: kindStats,
    },
    items,
  };
}

function normalizeInsightsLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_INSIGHTS_LIMIT;
  }
  return Math.max(1, Math.min(MAX_INSIGHTS_LIMIT, Math.floor(limit)));
}

function sortSessionsByUpdatedAt(sessions: SessionEntry[]): SessionEntry[] {
  return [...sessions].sort((left, right) => {
    return (
      (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0) ||
      String(right.name ?? right.sessionKey).localeCompare(String(left.name ?? left.sessionKey))
    );
  });
}

function defaultResolveTask(taskId: string): TaskStreamTaskEntity | null {
  try {
    return (
      buildTaskStreamSnapshot({
        taskId,
        eventsLimit: 1,
      }).selectedTask?.task ?? null
    );
  } catch {
    return null;
  }
}

function defaultResolveAgentName(agentId: string): string | null {
  return dbGetAgent(agentId)?.name ?? null;
}

function toInsightTaskRef(task: TaskStreamTaskEntity | null): OverlayInsightTaskRef | null {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title || null,
    status: task.status ?? null,
    profileId: task.profileId ?? null,
    updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : null,
  };
}

function toInsightSessionRef(
  session: SessionEntry,
  liveBySessionName?: Map<string, OverlayLiveState>,
): OverlayInsightSessionRef {
  const sessionName = session.name ?? session.sessionKey;
  const live = liveBySessionName?.get(sessionName);
  return {
    sessionKey: session.sessionKey,
    sessionName,
    agentId: session.agentId,
    displayName: session.displayName ?? null,
    chatId: session.lastTo ?? null,
    activity: live?.activity ?? (session.abortedLastRun === true ? "blocked" : "idle"),
    updatedAt: Number(session.updatedAt) || 0,
  };
}

function toInsightAgentRef(
  agentId: string,
  name: string | null,
  sessions: SessionEntry[],
  liveBySessionName?: Map<string, OverlayLiveState>,
): OverlayInsightAgentRef | null {
  const session = sessions.find((item) => item.agentId === agentId) ?? null;
  if (!agentId && !name && !session) return null;
  return {
    agentId,
    name,
    session: session ? toInsightSessionRef(session, liveBySessionName) : null,
  };
}

function buildDecoratedInsightLinks(
  summary: InsightSummary,
  detail: InsightDetail | null,
  helpers: {
    sessions: SessionEntry[];
    liveBySessionName?: Map<string, OverlayLiveState>;
    resolveTaskRef: (taskId: string) => OverlayInsightTaskRef | null;
    resolveSessionRef: (nameOrKey: string) => OverlayInsightSessionRef | null;
    resolveAgentRef: (agentId: string) => OverlayInsightAgentRef | null;
  },
): OverlayInsightLinkRef[] {
  const uniqueLinks = new Map<
    string,
    InsightLink | { targetType: InsightLinkTargetType; targetId: string; label?: string }
  >();
  for (const link of detail?.links ?? []) {
    uniqueLinks.set(`${link.targetType}:${link.targetId}`, link);
  }

  const syntheticTargets: Array<{
    targetType: InsightLinkTargetType;
    targetId: string | undefined;
    label?: string;
  }> = [
    { targetType: "task", targetId: summary.origin.taskId, label: "origin task" },
    {
      targetType: "session",
      targetId: summary.origin.sessionName ?? summary.author.sessionName,
      label: "origin session",
    },
    {
      targetType: "agent",
      targetId: summary.origin.agentId ?? summary.author.agentId,
      label: "origin agent",
    },
  ];

  for (const target of syntheticTargets) {
    const targetId = target.targetId?.trim();
    if (!targetId) continue;
    const key = `${target.targetType}:${targetId}`;
    if (!uniqueLinks.has(key)) {
      uniqueLinks.set(key, {
        targetType: target.targetType,
        targetId,
        ...(target.label ? { label: target.label } : {}),
      });
    }
  }

  return [...uniqueLinks.values()]
    .sort((left, right) => {
      const orderDiff = INSIGHT_LINK_ORDER[left.targetType] - INSIGHT_LINK_ORDER[right.targetType];
      if (orderDiff !== 0) return orderDiff;
      return left.targetId.localeCompare(right.targetId);
    })
    .map((link) => decorateInsightLink(link, helpers));
}

function decorateInsightLink(
  link: Pick<InsightLink, "targetType" | "targetId" | "label">,
  helpers: {
    sessions: SessionEntry[];
    liveBySessionName?: Map<string, OverlayLiveState>;
    resolveTaskRef: (taskId: string) => OverlayInsightTaskRef | null;
    resolveSessionRef: (nameOrKey: string) => OverlayInsightSessionRef | null;
    resolveAgentRef: (agentId: string) => OverlayInsightAgentRef | null;
  },
): OverlayInsightLinkRef {
  switch (link.targetType) {
    case "task": {
      const task = helpers.resolveTaskRef(link.targetId);
      return {
        targetType: link.targetType,
        targetId: link.targetId,
        label: link.label?.trim() || "task",
        value: task?.id ?? link.targetId,
        action: "focus-task",
        href: null,
        copyText: task?.id ?? link.targetId,
        task,
        session: null,
        agent: null,
      };
    }
    case "session": {
      const session = helpers.resolveSessionRef(link.targetId);
      return {
        targetType: link.targetType,
        targetId: link.targetId,
        label: link.label?.trim() || "session",
        value: session?.sessionName ?? link.targetId,
        action: "open-session",
        href: null,
        copyText: session?.sessionName ?? link.targetId,
        task: null,
        session,
        agent: null,
      };
    }
    case "agent": {
      const agent = helpers.resolveAgentRef(link.targetId);
      return {
        targetType: link.targetType,
        targetId: link.targetId,
        label: link.label?.trim() || "agent",
        value: agent?.name || agent?.agentId || link.targetId,
        action: "open-agent-session",
        href: null,
        copyText: agent?.agentId ?? link.targetId,
        task: null,
        session: agent?.session ?? null,
        agent,
      };
    }
    case "artifact": {
      const href = isAbsoluteUrl(link.targetId) ? link.targetId : null;
      return {
        targetType: link.targetType,
        targetId: link.targetId,
        label: link.label?.trim() || "artifact",
        value: summarizeArtifactTarget(link.targetId),
        action: href ? "open-url" : "copy",
        href,
        copyText: link.targetId,
        task: null,
        session: null,
        agent: null,
      };
    }
    case "profile":
    default:
      return {
        targetType: link.targetType,
        targetId: link.targetId,
        label: link.label?.trim() || "profile",
        value: link.targetId,
        action: "copy",
        href: null,
        copyText: link.targetId,
        task: null,
        session: null,
        agent: null,
      };
  }
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function summarizeArtifactTarget(value: string): string {
  if (isAbsoluteUrl(value)) {
    try {
      const url = new URL(value);
      return url.pathname.split("/").filter(Boolean).at(-1) ?? url.host;
    } catch {
      return value;
    }
  }

  const trimmed = value.trim();
  if (!trimmed) return value;
  const base = basename(trimmed);
  return base || trimmed;
}
