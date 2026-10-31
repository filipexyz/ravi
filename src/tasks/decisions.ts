import type {
  TaskDecisionAttentionEntry,
  TaskDecisionAttentionItem,
  TaskDecisionAttentionOptions,
  TaskDecisionAttentionReport,
  TaskOpenDecisionRow,
  TaskStatus,
} from "./types.js";

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["done", "failed"]);

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
