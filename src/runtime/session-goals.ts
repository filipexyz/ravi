import type { RuntimeGoal, RuntimeGoalStatus } from "./types.js";
import type { Database, Statement } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { isSqliteCapacityError } from "../db/write-retry.js";
import { getDb, getRaviDbPath } from "../router/router-db.js";
import { logger } from "../utils/logger.js";

const log = logger.child("runtime:session-goals");

export const SESSION_GOAL_OBJECTIVE_MAX_CHARS = 4000;

/**
 * Prompt text used when the goal store itself is unavailable. The section is a
 * snapshot; a store failure must not fail the turn or leak SQLite internals.
 */
export const SESSION_GOAL_PROMPT_UNAVAILABLE_NOTE =
  "Session goal snapshot unavailable: the local goal store returned a database capacity error. " +
  "A goal may still exist; run `ravi sessions goal get` to refresh before assuming there is none.";

const SESSION_GOAL_STATEMENT_MAX_ATTEMPTS = 2;

export type SessionGoalStatus = RuntimeGoalStatus;

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
  /** Connection the statements were prepared on. Statements die with it. */
  db: Database;
  preparedAt: number;
  get: Statement;
  replace: Statement;
  create: Statement;
  clear: Statement;
  pauseActive: Statement;
  updateStatus: Statement;
  blockGoal: Statement;
}

let stmts: SessionGoalStatements | null = null;

/**
 * Statements are cached per live `Database` object, not per DB path.
 *
 * The router connection can be closed and lazily reopened at the same path
 * inside one process (`closeRouterDb()` via `closeAllRaviDbs()`, `bot.stop()`).
 * A path-keyed cache kept handing out statements prepared on the closed
 * connection. Those keep "working" on the zombie handle until any schema change
 * forces SQLite to re-prepare them, and bun:sqlite reports that failure through
 * a NULL db handle, which SQLite renders as SQLITE_NOMEM "out of memory" even
 * though the table is empty and the process has plenty of memory.
 */
function getStatements(): SessionGoalStatements {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;
  stmts = prepareStatements(db);
  return stmts;
}

function prepareStatements(db: Database): SessionGoalStatements {
  return {
    db,
    preparedAt: Date.now(),
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
}

export function closeSessionGoalStore(): void {
  stmts = null;
}

function memorySnapshotMb(): Record<string, number> {
  const usage = process.memoryUsage();
  const toMb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  return {
    rssMb: toMb(usage.rss),
    heapUsedMb: toMb(usage.heapUsed),
    heapTotalMb: toMb(usage.heapTotal),
    externalMb: toMb(usage.external),
  };
}

function describeSqliteError(error: unknown): Record<string, unknown> {
  const details = error as { code?: unknown; errno?: unknown } | null;
  return {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    sqliteCode: details?.code ?? null,
    sqliteErrno: details?.errno ?? null,
  };
}

/**
 * Run one cached statement with SQLITE_NOMEM/SQLITE_FULL hardening.
 *
 * On a capacity error the cached statements are dropped and re-prepared once on
 * the live connection (statements are atomic, so a failed write never partially
 * applied). The error is instrumented either way; a second failure propagates
 * the original SQLite error so callers keep their `isSqliteCapacityError`
 * contract (CLI SQLITE_CAPACITY mapping, prompt intake ACK path).
 */
function runSessionGoalStatement<T>(
  operation: string,
  sessionKey: string,
  run: (statements: SessionGoalStatements) => T,
): T {
  for (let attempt = 1; ; attempt++) {
    let statements: SessionGoalStatements | null = null;
    try {
      statements = getStatements();
      const value = run(statements);
      if (attempt > 1) {
        log.warn("session goal statement recovered after re-preparing on the live connection", {
          operation,
          sessionKey,
          attempt,
        });
      }
      return value;
    } catch (error) {
      if (!isSqliteCapacityError(error)) throw error;
      const willRetry = attempt < SESSION_GOAL_STATEMENT_MAX_ATTEMPTS;
      log.error("session goal statement hit a SQLite capacity error", {
        operation,
        sessionKey,
        attempt,
        willRetry,
        dbPath: getRaviDbPath(),
        statementsAgeMs: statements ? Date.now() - statements.preparedAt : null,
        ...describeSqliteError(error),
        ...memorySnapshotMb(),
      });
      stmts = null;
      if (!willRetry) throw error;
    }
  }
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
  const row = runSessionGoalStatement("get", sessionKey, (s) => s.get.get(sessionKey) as SessionGoalRow | null);
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
  const objective = normalizeObjective(input.objective);
  const goalId = randomUUID();
  const now = Date.now();
  const row = runSessionGoalStatement(
    "replace",
    input.sessionKey,
    (s) =>
      s.replace.get(
        input.sessionKey,
        goalId,
        objective,
        status,
        tokenBudget,
        normalizeOptionalString(input.taskId),
        normalizeOptionalString(input.projectId),
        now,
        now,
      ) as SessionGoalRow | null,
  );
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
  const objective = normalizeObjective(input.objective);
  const goalId = randomUUID();
  const now = Date.now();
  const row = runSessionGoalStatement(
    "create",
    input.sessionKey,
    (s) =>
      s.create.get(
        input.sessionKey,
        goalId,
        objective,
        statusAfterBudgetLimit("active", tokenBudget),
        tokenBudget,
        normalizeOptionalString(input.taskId),
        normalizeOptionalString(input.projectId),
        now,
        now,
      ) as SessionGoalRow | null,
  );
  return row ? rowToGoal(row) : null;
}

export function updateSessionGoalStatus(
  sessionKey: string,
  status: SessionGoalStatus,
  expectedGoalId?: string | null,
): SessionGoal | null {
  const now = Date.now();
  const expected = expectedGoalId ?? null;
  const row = runSessionGoalStatement(
    "updateStatus",
    sessionKey,
    (s) =>
      s.updateStatus.get(
        status,
        status,
        status,
        status,
        status,
        now,
        sessionKey,
        expected,
        expected,
      ) as SessionGoalRow | null,
  );
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
  const row = runSessionGoalStatement(
    "block",
    sessionKey,
    (s) => s.blockGoal.get(trimmedReason, now, sessionKey, expected, expected) as SessionGoalRow | null,
  );
  if (!row) return null;
  return rowToGoal(row);
}

export function pauseActiveSessionGoal(sessionKey: string): SessionGoal | null {
  const now = Date.now();
  const row = runSessionGoalStatement(
    "pauseActive",
    sessionKey,
    (s) => s.pauseActive.get(now, sessionKey) as SessionGoalRow | null,
  );
  return row ? rowToGoal(row) : null;
}

export function resumeSessionGoal(sessionKey: string): SessionGoal | null {
  return updateSessionGoalStatus(sessionKey, "active");
}

export function completeSessionGoal(sessionKey: string, expectedGoalId?: string | null): SessionGoal | null {
  return updateSessionGoalStatus(sessionKey, "complete", expectedGoalId);
}

export function clearSessionGoal(sessionKey: string): boolean {
  return runSessionGoalStatement("clear", sessionKey, (s) => {
    s.clear.run(sessionKey);
    const row = s.db.prepare("SELECT changes() AS c").get() as { c: number } | null;
    return (row?.c ?? 0) > 0;
  });
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
  let goal: SessionGoal | null;
  try {
    goal = getSessionGoal(sessionKey);
  } catch (error) {
    // The section is a snapshot. A store capacity failure (already instrumented
    // by runSessionGoalStatement) must not fail the turn before the provider
    // starts, nor surface raw SQLite text to the chat.
    if (!isSqliteCapacityError(error)) throw error;
    log.warn("session goal prompt section degraded after store capacity error", { sessionKey });
    return SESSION_GOAL_PROMPT_UNAVAILABLE_NOTE;
  }
  if (!goal || goal.status === "complete") return null;

  const lines: string[] = [];
  lines.push(`Goal ID: ${goal.goalId}`);
  lines.push(`Status: ${goal.status}`);
  lines.push("Snapshot only; refresh with `ravi sessions goal get`.");

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

/** Project a confirmed runtime snapshot; local commands never invent native status or usage. */
export function syncRuntimeSessionGoal(
  sessionKey: string,
  goal: RuntimeGoal | null,
  links?: { taskId?: string; projectId?: string; blockedReason?: string },
): SessionGoal | null {
  if (!goal) {
    clearSessionGoal(sessionKey);
    return null;
  }
  const previous = getSessionGoal(sessionKey);
  const sameGoal = previous?.objective === goal.objective && previous.createdAt === goal.createdAt;
  if (sameGoal && previous.updatedAt > goal.updatedAt) return previous;
  const goalId = sameGoal ? previous.goalId : randomUUID();
  getDb()
    .prepare(`INSERT INTO session_goals (session_key, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, task_id, project_id, blocked_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET goal_id=excluded.goal_id, objective=excluded.objective, status=excluded.status,
      token_budget=excluded.token_budget, tokens_used=excluded.tokens_used, time_used_seconds=excluded.time_used_seconds,
      task_id=excluded.task_id, project_id=excluded.project_id, blocked_reason=excluded.blocked_reason,
      created_at=excluded.created_at, updated_at=excluded.updated_at`)
    .run(
      sessionKey,
      goalId,
      goal.objective,
      goal.status,
      goal.tokenBudget,
      goal.tokensUsed,
      goal.timeUsedSeconds,
      links?.taskId ?? (sameGoal ? previous.taskId : null) ?? null,
      links?.projectId ?? (sameGoal ? previous.projectId : null) ?? null,
      goal.status === "blocked" ? (links?.blockedReason ?? (sameGoal ? previous.blockedReason : null) ?? null) : null,
      goal.createdAt,
      goal.updatedAt,
    );
  return getSessionGoal(sessionKey);
}
