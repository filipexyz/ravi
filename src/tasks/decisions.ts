import type {
  TaskDecision,
  TaskDecisionAttentionEntry,
  TaskDecisionAttentionItem,
  TaskDecisionAttentionOptions,
  TaskDecisionAttentionReport,
  TaskDecisionOwnerType,
  TaskDecisionStatus,
  TaskOpenDecisionRow,
  TaskStatus,
} from "./types.js";

export type TaskDecisionErrorCode =
  | "TASK_DECISION_NOT_FOUND"
  | "TASK_DECISION_NOT_OPEN"
  | "TASK_DECISION_SELF_ANSWER"
  | "TASK_DECISION_INVALID_KEY"
  | "TASK_DECISION_INVALID_OWNER"
  | "TASK_DECISION_INVALID_ASK"
  | "TASK_DECISION_INVALID_ANSWER";

export class TaskDecisionError extends Error {
  readonly code: TaskDecisionErrorCode;
  readonly exitCode: number;
  readonly suggestedAction?: string;

  constructor(
    code: TaskDecisionErrorCode,
    message: string,
    options: { exitCode?: number; suggestedAction?: string } = {},
  ) {
    super(message);
    this.name = "TaskDecisionError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.suggestedAction = options.suggestedAction;
  }
}

export const TASK_DECISION_STATUSES = [
  "open",
  "answered",
  "superseded",
] as const satisfies readonly TaskDecisionStatus[];

export const TASK_DECISION_OWNER_TYPES = [
  "human",
  "agent",
  "unassigned",
] as const satisfies readonly TaskDecisionOwnerType[];

const TASK_DECISION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["done", "failed"]);

/** Normalize and validate a decision key. Keys are stable per task. */
export function normalizeTaskDecisionKey(raw: string | null | undefined): string {
  const key = (raw ?? "").trim().toLowerCase();
  if (!TASK_DECISION_KEY_PATTERN.test(key)) {
    throw new TaskDecisionError(
      "TASK_DECISION_INVALID_KEY",
      `Invalid decision key ${JSON.stringify(raw ?? "")}: use a lowercase slug (a-z, 0-9, dot, dash, underscore; max 64 chars).`,
      { exitCode: 2, suggestedAction: "Pick a stable key such as 'deploy-window' or 'owner-approval'." },
    );
  }
  return key;
}

/**
 * Parse `human:<contact>`, `agent:<id>` or `unassigned`. Anything else is a
 * usage error; the owner is never inferred from free text.
 */
export function parseTaskDecisionOwner(raw: string | null | undefined): {
  ownerType: TaskDecisionOwnerType;
  ownerId: string | null;
} {
  const value = (raw ?? "").trim();
  if (!value) {
    return { ownerType: "unassigned", ownerId: null };
  }
  if (value === "unassigned") {
    return { ownerType: "unassigned", ownerId: null };
  }

  const separator = value.indexOf(":");
  const ownerType = (separator === -1 ? "" : value.slice(0, separator)) as TaskDecisionOwnerType;
  const ownerId = separator === -1 ? "" : value.slice(separator + 1).trim();
  if (!TASK_DECISION_OWNER_TYPES.includes(ownerType) || ownerType === "unassigned" || !ownerId) {
    throw new TaskDecisionError(
      "TASK_DECISION_INVALID_OWNER",
      `Invalid decision owner ${JSON.stringify(value)}: use human:<contact>, agent:<agent-id> or unassigned.`,
      { exitCode: 2, suggestedAction: "Pass --owner human:<contact-id>, --owner agent:<agent-id> or omit it." },
    );
  }
  return { ownerType, ownerId };
}

export function formatTaskDecisionOwner(decision: Pick<TaskDecision, "ownerType" | "ownerId">): string {
  return decision.ownerType === "unassigned" || !decision.ownerId
    ? "unassigned"
    : `${decision.ownerType}:${decision.ownerId}`;
}

export function isTaskDecisionParked(row: TaskOpenDecisionRow, now = Date.now()): boolean {
  void now;
  if (TERMINAL_TASK_STATUSES.has(row.taskStatus)) return false;
  return row.decision.status === "open" && row.decision.blocks && row.decision.ownerType === "human";
}

/**
 * Deterministic, side-effect-free attention fold: open decisions grouped by
 * task, oldest first. It reads decisions only; it does not detect stalls or
 * blocked tasks.
 */
export function foldTaskDecisionAttention(
  rows: readonly TaskOpenDecisionRow[],
  options: {
    filters?: TaskDecisionAttentionOptions;
    now?: number;
  } = {},
): TaskDecisionAttentionReport {
  const now = options.now ?? Date.now();
  type FoldEntry = TaskDecisionAttentionEntry & { hasHuman: boolean; hasAgent: boolean };
  const byTask = new Map<string, FoldEntry>();

  const ordered = [...rows].sort(
    (left, right) =>
      left.decision.askedAt - right.decision.askedAt || left.decision.id.localeCompare(right.decision.id),
  );

  for (const row of ordered) {
    if (row.decision.status !== "open") continue;
    const ageSeconds = Math.max(0, Math.floor((now - row.decision.askedAt) / 1000));
    const item: TaskDecisionAttentionItem = {
      id: row.decision.id,
      key: row.decision.key,
      ask: row.decision.ask,
      ownerType: row.decision.ownerType,
      ownerId: row.decision.ownerId,
      askedBy: row.decision.askedBy,
      askedAt: row.decision.askedAt,
      blocks: row.decision.blocks,
      ageSeconds,
    };
    const parked = isTaskDecisionParked(row, now);

    const existing = byTask.get(row.decision.taskId);
    if (existing) {
      existing.decisions.push(item);
      existing.decisionCount = existing.decisions.length;
      existing.parked = existing.parked || parked;
      existing.hasHuman = existing.hasHuman || item.ownerType === "human";
      existing.hasAgent = existing.hasAgent || item.ownerType === "agent";
      continue;
    }

    byTask.set(row.decision.taskId, {
      taskId: row.decision.taskId,
      taskTitle: row.taskTitle,
      taskStatus: row.taskStatus,
      taskPriority: row.taskPriority,
      assigneeAgentId: row.assigneeAgentId,
      assigneeSessionName: row.assigneeSessionName,
      parked,
      waitingFor: "unassigned",
      ageSeconds,
      decisionCount: 1,
      decisions: [item],
      hasHuman: item.ownerType === "human",
      hasAgent: item.ownerType === "agent",
    });
  }

  // `ordered` is ascending by askedAt, so the first decision of an entry is its
  // oldest question: the entry age is read from it instead of a second sweep.
  const entries: TaskDecisionAttentionEntry[] = [...byTask.values()].map(({ hasHuman, hasAgent, ...entry }) => ({
    ...entry,
    waitingFor: hasHuman ? "human" : hasAgent ? "agent" : "unassigned",
    ageSeconds: Math.max(0, Math.floor((now - (entry.decisions[0]?.askedAt ?? now)) / 1000)),
  }));

  entries.sort((left, right) => right.ageSeconds - left.ageSeconds || left.taskId.localeCompare(right.taskId));

  return {
    kind: "task.decision.attention",
    generatedAt: now,
    total: entries.length,
    parkedCount: entries.filter((entry) => entry.parked).length,
    decisionCount: entries.reduce((sum, entry) => sum + entry.decisionCount, 0),
    filters: options.filters ?? {},
    entries,
  };
}
