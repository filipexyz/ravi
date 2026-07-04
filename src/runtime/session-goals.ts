import type { Statement } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getDb, getRaviDbPath } from "../router/router-db.js";

export const SESSION_GOAL_OBJECTIVE_MAX_CHARS = 4000;

export type SessionGoalStatus = "active" | "paused" | "budget_limited" | "blocked" | "complete";

export type SessionGoalAccountingMode =
  | "active_status_only"
  | "active_only"
  | "active_or_complete"
  | "active_or_stopped";

export interface SessionGoal {
  sessionKey: string;
  goalId: string;
  objective: string;
  status: SessionGoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  taskId?: string;
  projectId?: string;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionGoalRow {
  session_key: string;
  goal_id: string;
  objective: string;
  status: SessionGoalStatus;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  task_id: string | null;
  project_id: string | null;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

const GOAL_COLUMNS = `session_key, goal_id, objective, status, token_budget, tokens_used, time_used_seconds,
             task_id, project_id, blocked_reason, created_at, updated_at`;

interface SessionGoalStatements {
  get: Statement;
  replace: Statement;
  create: Statement;
  clear: Statement;
  pauseActive: Statement;
  updateStatus: Statement;
  blockGoal: Statement;
}

let stmts: SessionGoalStatements | null = null;
let statementsDbPath: string | null = null;

function getStatements(): SessionGoalStatements {
  const currentDbPath = getRaviDbPath();
  if (stmts && statementsDbPath === currentDbPath) return stmts;
  stmts = null;
  statementsDbPath = currentDbPath;

  const db = getDb();
  stmts = {
    get: db.prepare(`
      SELECT ${GOAL_COLUMNS}
      FROM session_goals
      WHERE session_key = ?
    `),
    replace: db.prepare(`
      INSERT INTO session_goals (
        session_key, goal_id, objective, status, token_budget, tokens_used, time_used_seconds,
        task_id, project_id, blocked_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        goal_id = excluded.goal_id,
        objective = excluded.objective,
        status = excluded.status,
        token_budget = excluded.token_budget,
        tokens_used = 0,
        time_used_seconds = 0,
        task_id = excluded.task_id,
        project_id = excluded.project_id,
        blocked_reason = NULL,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
      RETURNING ${GOAL_COLUMNS}
    `),
    create: db.prepare(`
      INSERT INTO session_goals (
        session_key, goal_id, objective, status, token_budget, tokens_used, time_used_seconds,
        task_id, project_id, blocked_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, ?, ?)
      ON CONFLICT(session_key) DO NOTHING
      RETURNING ${GOAL_COLUMNS}
    `),
    clear: db.prepare("DELETE FROM session_goals WHERE session_key = ?"),
    pauseActive: db.prepare(`
      UPDATE session_goals
      SET status = 'paused', blocked_reason = NULL, updated_at = ?
      WHERE session_key = ? AND status = 'active'
      RETURNING ${GOAL_COLUMNS}
    `),
    updateStatus: db.prepare(`
      UPDATE session_goals
      SET
        status = CASE
          WHEN status = 'budget_limited' AND ? IN ('paused', 'blocked') THEN status
          WHEN status = 'complete' THEN status
          WHEN ? = 'active' AND token_budget IS NOT NULL AND tokens_used >= token_budget THEN 'budget_limited'
          ELSE ?
        END,
        blocked_reason = CASE
          WHEN ? IN ('paused', 'blocked') AND status = 'budget_limited' THEN blocked_reason
          WHEN ? = 'blocked' THEN blocked_reason
          ELSE NULL
        END,
        updated_at = ?
      WHERE session_key = ? AND (? IS NULL OR goal_id = ?)
      RETURNING ${GOAL_COLUMNS}
    `),
    blockGoal: db.prepare(`
      UPDATE session_goals
      SET
        status = CASE
          WHEN status IN ('active', 'paused') THEN 'blocked'
          ELSE status
        END,
        blocked_reason = CASE
          WHEN status IN ('active', 'paused') THEN ?
          ELSE blocked_reason
        END,
        updated_at = ?
      WHERE session_key = ? AND (? IS NULL OR goal_id = ?)
      RETURNING ${GOAL_COLUMNS}
    `),
  };

  return stmts;
}

export function closeSessionGoalStore(): void {
  stmts = null;
  statementsDbPath = null;
}

function rowToGoal(row: SessionGoalRow): SessionGoal {
  return {
    sessionKey: row.session_key,
    goalId: row.goal_id,
    objective: row.objective,
    status: row.status,
    ...(row.token_budget === null ? {} : { tokenBudget: row.token_budget }),
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeObjective(objective: string): string {
  const trimmed = objective.trim();
  if (!trimmed) {
    throw new Error("goal objective must not be empty");
  }
  if ([...trimmed].length > SESSION_GOAL_OBJECTIVE_MAX_CHARS) {
    throw new Error(`goal objective must be at most ${SESSION_GOAL_OBJECTIVE_MAX_CHARS} characters`);
  }
  return trimmed;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeBudget(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("goal budgets must be positive integers when provided");
  }
  return value;
}

function statusAfterBudgetLimit(status: SessionGoalStatus, tokenBudget: number | null): SessionGoalStatus {
  return status === "active" && tokenBudget !== null && tokenBudget <= 0 ? "budget_limited" : status;
}

export function getSessionGoal(sessionKey: string): SessionGoal | null {
  const row = getStatements().get.get(sessionKey) as SessionGoalRow | null;
  return row ? rowToGoal(row) : null;
}

export function replaceSessionGoal(input: {
  sessionKey: string;
  objective: string;
  status?: SessionGoalStatus;
  tokenBudget?: number | null;
  taskId?: string | null;
  projectId?: string | null;
}): SessionGoal {
  const tokenBudget = normalizeBudget(input.tokenBudget);
  const status = statusAfterBudgetLimit(input.status ?? "active", tokenBudget);
  const now = Date.now();
  const row = getStatements().replace.get(
    input.sessionKey,
    randomUUID(),
    normalizeObjective(input.objective),
    status,
    tokenBudget,
    normalizeOptionalString(input.taskId),
    normalizeOptionalString(input.projectId),
    now,
    now,
  ) as SessionGoalRow | null;
  if (!row) throw new Error(`failed to replace goal for session: ${input.sessionKey}`);
  return rowToGoal(row);
}

export function createSessionGoal(input: {
  sessionKey: string;
  objective: string;
  tokenBudget?: number | null;
  taskId?: string | null;
  projectId?: string | null;
}): SessionGoal | null {
  const tokenBudget = normalizeBudget(input.tokenBudget);
  const now = Date.now();
  const row = getStatements().create.get(
    input.sessionKey,
    randomUUID(),
    normalizeObjective(input.objective),
    statusAfterBudgetLimit("active", tokenBudget),
    tokenBudget,
    normalizeOptionalString(input.taskId),
    normalizeOptionalString(input.projectId),
    now,
    now,
  ) as SessionGoalRow | null;
  return row ? rowToGoal(row) : null;
}

export function updateSessionGoalStatus(
  sessionKey: string,
  status: SessionGoalStatus,
  expectedGoalId?: string | null,
): SessionGoal | null {
  const now = Date.now();
  const expected = expectedGoalId ?? null;
  const row = getStatements().updateStatus.get(
    status,
    status,
    status,
    status,
    status,
    now,
    sessionKey,
    expected,
    expected,
  ) as SessionGoalRow | null;
  return row ? rowToGoal(row) : null;
}

export function blockSessionGoal(
  sessionKey: string,
  reason: string,
  expectedGoalId?: string | null,
): SessionGoal | null {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new Error("blocked reason must not be empty");
  }
  const now = Date.now();
  const expected = expectedGoalId ?? null;
  const row = getStatements().blockGoal.get(
    trimmedReason,
    now,
    sessionKey,
    expected,
    expected,
  ) as SessionGoalRow | null;
  if (!row) return null;
  return rowToGoal(row);
}

export function pauseActiveSessionGoal(sessionKey: string): SessionGoal | null {
  const row = getStatements().pauseActive.get(Date.now(), sessionKey) as SessionGoalRow | null;
  return row ? rowToGoal(row) : null;
}

export function resumeSessionGoal(sessionKey: string): SessionGoal | null {
  return updateSessionGoalStatus(sessionKey, "active");
}

export function completeSessionGoal(sessionKey: string, expectedGoalId?: string | null): SessionGoal | null {
  return updateSessionGoalStatus(sessionKey, "complete", expectedGoalId);
}

export function clearSessionGoal(sessionKey: string): boolean {
  getStatements().clear.run(sessionKey);
  const row = getDb().prepare("SELECT changes() AS c").get() as { c: number } | null;
  return (row?.c ?? 0) > 0;
}

function statusFiltersForMode(mode: SessionGoalAccountingMode): {
  statusFilter: string;
  budgetLimitStatusFilter: string;
} {
  switch (mode) {
    case "active_status_only":
      return { statusFilter: "status = 'active'", budgetLimitStatusFilter: "status = 'active'" };
    case "active_only":
      return { statusFilter: "status IN ('active', 'budget_limited')", budgetLimitStatusFilter: "status = 'active'" };
    case "active_or_complete":
      return {
        statusFilter: "status IN ('active', 'budget_limited', 'complete')",
        budgetLimitStatusFilter: "status = 'active'",
      };
    case "active_or_stopped":
      return {
        statusFilter: "status IN ('active', 'paused', 'budget_limited')",
        budgetLimitStatusFilter: "status IN ('active', 'paused', 'budget_limited')",
      };
  }
}

export function accountSessionGoalUsage(input: {
  sessionKey: string;
  timeDeltaSeconds?: number;
  tokenDelta?: number;
  mode?: SessionGoalAccountingMode;
  expectedGoalId?: string | null;
}): { kind: "updated"; goal: SessionGoal } | { kind: "unchanged"; goal: SessionGoal | null } {
  const timeDeltaSeconds = Math.max(0, Math.trunc(input.timeDeltaSeconds ?? 0));
  const tokenDelta = Math.max(0, Math.trunc(input.tokenDelta ?? 0));
  if (timeDeltaSeconds === 0 && tokenDelta === 0) {
    return { kind: "unchanged", goal: getSessionGoal(input.sessionKey) };
  }

  const mode = input.mode ?? "active_only";
  const { statusFilter, budgetLimitStatusFilter } = statusFiltersForMode(mode);
  const expectedGoalId = input.expectedGoalId ?? null;
  const goalIdFilter = expectedGoalId ? "goal_id = ?" : "1 = 1";
  const query = `
    UPDATE session_goals
    SET
      time_used_seconds = time_used_seconds + ?,
      tokens_used = tokens_used + ?,
      status = CASE
        WHEN ${budgetLimitStatusFilter} AND token_budget IS NOT NULL AND tokens_used + ? >= token_budget
          THEN 'budget_limited'
        ELSE status
      END,
      updated_at = ?
    WHERE session_key = ?
      AND ${statusFilter}
      AND ${goalIdFilter}
    RETURNING ${GOAL_COLUMNS}
  `;
  const params: Array<string | number> = [timeDeltaSeconds, tokenDelta, tokenDelta, Date.now(), input.sessionKey];
  if (expectedGoalId) params.push(expectedGoalId);
  const row = getDb()
    .prepare(query)
    .get(...params) as SessionGoalRow | null;
  if (!row) {
    return { kind: "unchanged", goal: getSessionGoal(input.sessionKey) };
  }
  return { kind: "updated", goal: rowToGoal(row) };
}

export function buildSessionGoalPromptSection(sessionKey: string): string | null {
  const goal = getSessionGoal(sessionKey);
  if (!goal || goal.status === "complete") return null;

  const lines: string[] = [];
  lines.push(`Goal ID: ${goal.goalId}`);
  lines.push(`Status: ${goal.status}`);

  const objectivePreview = goal.objective.length > 500 ? `${goal.objective.slice(0, 497)}...` : goal.objective;
  lines.push(`Objective: ${objectivePreview}`);

  if (goal.tokenBudget !== undefined) {
    lines.push(`Budget: ${goal.tokensUsed} / ${goal.tokenBudget} tokens`);
  }
  if (goal.timeUsedSeconds > 0) {
    lines.push(`Time used: ${goal.timeUsedSeconds}s`);
  }
  if (goal.status === "blocked" && goal.blockedReason) {
    lines.push(`Blocked reason: ${goal.blockedReason}`);
  }
  if (goal.taskId) {
    lines.push(`Linked task: ${goal.taskId}`);
  }

  return lines.join("\n");
}
