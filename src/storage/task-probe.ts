/**
 * Task-worktree probe contract used by the storage engine for the `weekly`
 * tier. The production implementation lives in `task-worktrees.ts`; tests
 * inject fakes. The engine never deletes a task directory or worktree itself:
 * it asks the probe, which uses the canonical Git lifecycle.
 */

export interface TaskWorktreeRecord {
  taskId: string;
  status: string;
  taskDir: string | null;
  worktreePath: string;
  worktreeBranch: string | null;
  updatedAt: number;
  completedAt: number | null;
  archivedAt: number | null;
}

export interface TaskWorktreeAssessment {
  decision: "candidate" | "preserved";
  reason: string;
}

export interface TaskProbe {
  listWorktreeTasks(): { records: TaskWorktreeRecord[]; error?: string };
  assess(record: TaskWorktreeRecord): TaskWorktreeAssessment;
  remove(record: TaskWorktreeRecord): { ok: true } | { ok: false; error: string };
}

export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["done", "failed"]);

export function isTerminalTask(record: TaskWorktreeRecord): boolean {
  return TERMINAL_TASK_STATUSES.has(record.status) || record.archivedAt != null;
}

export function taskTerminalStamp(record: TaskWorktreeRecord): number {
  return record.completedAt ?? record.archivedAt ?? record.updatedAt;
}
