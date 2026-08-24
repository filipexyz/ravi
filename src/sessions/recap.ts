import type { SessionEntry } from "../router/types.js";
import type { SessionGoal } from "../runtime/session-goals.js";

export const SESSION_RECAP_SCHEMA_VERSION = 1;
export const DEFAULT_SESSION_RECAP_TAIL = 8;
export const MAX_SESSION_RECAP_TAIL = 40;
export const DEFAULT_SESSION_RECAP_TEXT_CHARS = 400;

export interface SessionRecapHistoryMessage {
  role: "user" | "assistant";
  text: string;
  time: string;
}

export interface SessionRecapHistoryInput {
  available: boolean;
  source?: string;
  reason?: string;
  totalMessages: number;
  messages: SessionRecapHistoryMessage[];
}

export interface SessionRecapGoal {
  sessionKey: string;
  goalId: string;
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  taskId: string | null;
  projectId: string | null;
  blockedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRecapRecentItem {
  role: "user" | "assistant";
  text: string;
  textTruncated: boolean;
  time: string;
}

export interface SessionRecap {
  schemaVersion: typeof SESSION_RECAP_SCHEMA_VERSION;
  computed: true;
  persisted: false;
  session: {
    sessionKey: string;
    name: string | null;
    displayName: string | null;
    agentId: string;
    compactionCount: number;
    createdAt: number;
    updatedAt: number;
  };
  goal: SessionRecapGoal | null;
  summary: string | null;
  pinned: string[];
  decisions: string[];
  openLoops: string[];
  recent: {
    available: boolean;
    source: string | null;
    reason: string | null;
    limit: number;
    totalMessages: number;
    truncated: boolean;
    omittedTools: true;
    items: SessionRecapRecentItem[];
  };
  sources: {
    sessionRow: true;
    goal: boolean;
    history: string | null;
  };
}

export interface BuildSessionRecapInput {
  session: Pick<
    SessionEntry,
    "sessionKey" | "name" | "displayName" | "agentId" | "compactionCount" | "createdAt" | "updatedAt"
  >;
  goal?: SessionGoal | null;
  history?: SessionRecapHistoryInput;
  tailLimit?: number;
  maxTextChars?: number;
}

export function parseSessionRecapTailCount(countStr?: string): number {
  const parsed = Number.parseInt(countStr ?? String(DEFAULT_SESSION_RECAP_TAIL), 10);
  const count = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_RECAP_TAIL;
  return Math.min(count, MAX_SESSION_RECAP_TAIL);
}

export function truncateRecapText(
  text: string,
  maxChars = DEFAULT_SESSION_RECAP_TEXT_CHARS,
): { text: string; textTruncated: boolean } {
  if (text.length <= maxChars) return { text, textTruncated: false };
  return { text: `${text.slice(0, maxChars).trimEnd()}…`, textTruncated: true };
}

export function projectSessionRecapGoal(goal: SessionGoal | null | undefined): SessionRecapGoal | null {
  if (!goal) return null;
  return {
    sessionKey: goal.sessionKey,
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    taskId: goal.taskId ?? null,
    projectId: goal.projectId ?? null,
    blockedReason: goal.blockedReason ?? null,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

function deriveOpenLoops(goal: SessionRecapGoal | null): string[] {
  const reason = goal?.blockedReason?.trim();
  if (goal?.status === "blocked" && reason) return [reason];
  return [];
}

export function buildSessionRecap(input: BuildSessionRecapInput): SessionRecap {
  const tailLimit = Math.min(MAX_SESSION_RECAP_TAIL, Math.max(1, input.tailLimit ?? DEFAULT_SESSION_RECAP_TAIL));
  const maxTextChars = Math.max(1, input.maxTextChars ?? DEFAULT_SESSION_RECAP_TEXT_CHARS);
  const goal = projectSessionRecapGoal(input.goal);
  const history = input.history;
  const rawMessages = history?.messages ?? [];
  const items = rawMessages.slice(-tailLimit).map((message) => {
    const truncated = truncateRecapText(message.text, maxTextChars);
    return {
      role: message.role,
      text: truncated.text,
      textTruncated: truncated.textTruncated,
      time: message.time,
    };
  });
  const totalMessages = history?.totalMessages ?? rawMessages.length;
  const source = history?.source ?? null;

  return {
    schemaVersion: SESSION_RECAP_SCHEMA_VERSION,
    computed: true,
    persisted: false,
    session: {
      sessionKey: input.session.sessionKey,
      name: input.session.name ?? null,
      displayName: input.session.displayName ?? null,
      agentId: input.session.agentId,
      compactionCount: input.session.compactionCount ?? 0,
      createdAt: input.session.createdAt,
      updatedAt: input.session.updatedAt,
    },
    goal,
    summary: null,
    pinned: [],
    decisions: [],
    openLoops: deriveOpenLoops(goal),
    recent: {
      available: history?.available === true && items.length > 0,
      source,
      reason: history?.reason ?? (items.length === 0 ? "No history available" : null),
      limit: tailLimit,
      totalMessages,
      truncated: totalMessages > items.length || items.some((item) => item.textTruncated),
      omittedTools: true,
      items,
    },
    sources: {
      sessionRow: true,
      goal: goal !== null,
      history: source,
    },
  };
}

export function formatSessionRecap(recap: SessionRecap): string {
  const label = recap.session.name ?? recap.session.sessionKey;
  const lines = [
    `Session recap: ${label}`,
    `  sessionKey: ${recap.session.sessionKey}`,
    `  agent: ${recap.session.agentId}`,
  ];
  if (recap.session.displayName) lines.push(`  displayName: ${recap.session.displayName}`);
  lines.push(`  compactionCount: ${recap.session.compactionCount}`);
  lines.push(`  updatedAt: ${new Date(recap.session.updatedAt).toISOString()}`);

  if (recap.goal) {
    lines.push(`  goal: ${recap.goal.status} — ${recap.goal.objective}`);
    if (recap.goal.blockedReason) lines.push(`  blocked: ${recap.goal.blockedReason}`);
  } else {
    lines.push("  goal: (none)");
  }

  lines.push(`  summary: ${recap.summary ?? "(empty)"}`);
  lines.push(`  pinned: ${formatEmptyList(recap.pinned)}`);
  lines.push(`  decisions: ${formatEmptyList(recap.decisions)}`);
  lines.push(`  openLoops: ${formatEmptyList(recap.openLoops)}`);

  const recent = recap.recent;
  const tailLabel = recent.available
    ? `last ${recent.items.length} of ${recent.totalMessages}`
    : (recent.reason ?? "none");
  lines.push(`  recent: ${tailLabel} (tools omitted)`);
  if (recent.items.length === 0) {
    lines.push("    (empty)");
  } else {
    for (const item of recent.items) {
      const who = item.role === "user" ? "user" : "assistant";
      const time = item.time ? ` [${item.time}]` : "";
      lines.push(`    ${who}${time}: ${item.text}`);
    }
  }

  return lines.join("\n");
}

function formatEmptyList(values: string[]): string {
  return values.length > 0 ? values.join("; ") : "(empty)";
}
