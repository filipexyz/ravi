import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Database, Statement } from "bun:sqlite";
import { isSqliteCapacityError } from "../db/write-retry.js";
import { closeRouterDb, getDb } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { formatUserFacingTurnFailure } from "./public-failure.js";
import {
  SESSION_GOAL_PROMPT_UNAVAILABLE_NOTE,
  accountSessionGoalUsage,
  blockSessionGoal,
  buildSessionGoalPromptSection,
  clearSessionGoal,
  closeSessionGoalStore,
  completeSessionGoal,
  createSessionGoal,
  getSessionGoal,
  pauseActiveSessionGoal,
  replaceSessionGoal,
  resumeSessionGoal,
  syncRuntimeSessionGoal,
} from "./session-goals.js";

const SESSION_KEY = "agent:dev:main";
let stateDir: string | null = null;

describe("session goals", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-session-goals-");
    getOrCreateSession(SESSION_KEY, "dev", "/tmp/dev", { name: "dev" });
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("stores one durable goal per session", () => {
    const goal = replaceSessionGoal({
      sessionKey: SESSION_KEY,
      objective: "Implement session goals",
      tokenBudget: 100,
      taskId: "task-1",
      projectId: "proj-1",
    });

    expect(goal).toMatchObject({
      sessionKey: SESSION_KEY,
      objective: "Implement session goals",
      status: "active",
      tokenBudget: 100,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      taskId: "task-1",
      projectId: "proj-1",
    });
    expect(getSessionGoal(SESSION_KEY)?.goalId).toBe(goal.goalId);
  });

  it("mirrors runtime usage and status while preserving local links across pause and resume", () => {
    const snapshot = {
      objective: "Finish fixture",
      status: "active" as const,
      tokenBudget: 100,
      tokensUsed: 12,
      timeUsedSeconds: 3,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const first = syncRuntimeSessionGoal(SESSION_KEY, snapshot, { taskId: "task_fixture" });
    syncRuntimeSessionGoal(SESSION_KEY, { ...snapshot, status: "paused", updatedAt: 3000 });
    const resumed = syncRuntimeSessionGoal(SESSION_KEY, { ...snapshot, updatedAt: 4000 });
    expect(resumed).toMatchObject({ ...snapshot, goalId: first?.goalId, taskId: "task_fixture", updatedAt: 4000 });
    syncRuntimeSessionGoal(SESSION_KEY, { ...snapshot, status: "usage_limited", updatedAt: 5000 });
    expect(getSessionGoal(SESSION_KEY)?.status).toBe("usage_limited");
    syncRuntimeSessionGoal(SESSION_KEY, { ...snapshot, status: "paused", updatedAt: 3000 });
    expect(getSessionGoal(SESSION_KEY)?.status).toBe("usage_limited");
    syncRuntimeSessionGoal(SESSION_KEY, null);
    expect(getSessionGoal(SESSION_KEY)).toBeNull();
  });

  it("create refuses to replace an existing goal", () => {
    const first = createSessionGoal({
      sessionKey: SESSION_KEY,
      objective: "First objective",
    });
    const second = createSessionGoal({
      sessionKey: SESSION_KEY,
      objective: "Second objective",
    });

    expect(first?.objective).toBe("First objective");
    expect(second).toBeNull();
    expect(getSessionGoal(SESSION_KEY)?.objective).toBe("First objective");
  });

  it("accounts usage and marks active goals budget-limited", () => {
    const goal = replaceSessionGoal({
      sessionKey: SESSION_KEY,
      objective: "Spend carefully",
      tokenBudget: 10,
    });

    const first = accountSessionGoalUsage({
      sessionKey: SESSION_KEY,
      tokenDelta: 6,
      timeDeltaSeconds: 2,
      expectedGoalId: goal.goalId,
    });
    expect(first.kind).toBe("updated");
    expect(first.goal).toMatchObject({
      status: "active",
      tokensUsed: 6,
      timeUsedSeconds: 2,
    });

    const second = accountSessionGoalUsage({
      sessionKey: SESSION_KEY,
      tokenDelta: 5,
      timeDeltaSeconds: 3,
      expectedGoalId: goal.goalId,
    });
    expect(second.kind).toBe("updated");
    expect(second.goal).toMatchObject({
      status: "budget_limited",
      tokensUsed: 11,
      timeUsedSeconds: 5,
    });
  });

  it("keeps budget-limited goals from being paused away", () => {
    replaceSessionGoal({
      sessionKey: SESSION_KEY,
      objective: "Spend carefully",
      tokenBudget: 10,
    });
    accountSessionGoalUsage({ sessionKey: SESSION_KEY, tokenDelta: 10 });

    const paused = pauseActiveSessionGoal(SESSION_KEY);
    expect(paused).toBeNull();
    expect(getSessionGoal(SESSION_KEY)?.status).toBe("budget_limited");
  });

  it("resume cannot reactivate a goal already over budget", () => {
    replaceSessionGoal({
      sessionKey: SESSION_KEY,
      objective: "Spend carefully",
      tokenBudget: 10,
    });
    accountSessionGoalUsage({ sessionKey: SESSION_KEY, tokenDelta: 10 });

    const resumed = resumeSessionGoal(SESSION_KEY);
    expect(resumed?.status).toBe("budget_limited");
  });

  it("completes and clears goals", () => {
    const goal = replaceSessionGoal({
      sessionKey: SESSION_KEY,
      objective: "Finish",
    });

    expect(completeSessionGoal(SESSION_KEY, goal.goalId)?.status).toBe("complete");
    expect(clearSessionGoal(SESSION_KEY)).toBe(true);
    expect(getSessionGoal(SESSION_KEY)).toBeNull();
  });

  describe("blocked status", () => {
    it("blocks an active goal with a reason", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Work on feature",
      });

      const blocked = blockSessionGoal(SESSION_KEY, "Waiting for API credentials");
      expect(blocked?.status).toBe("blocked");
      expect(blocked?.blockedReason).toBe("Waiting for API credentials");

      const fetched = getSessionGoal(SESSION_KEY);
      expect(fetched?.status).toBe("blocked");
      expect(fetched?.blockedReason).toBe("Waiting for API credentials");
    });

    it("blocks a paused goal with a reason", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Work on feature",
      });
      pauseActiveSessionGoal(SESSION_KEY);

      const blocked = blockSessionGoal(SESSION_KEY, "Missing dependency");
      expect(blocked?.status).toBe("blocked");
      expect(blocked?.blockedReason).toBe("Missing dependency");
    });

    it("rejects blocking without a reason", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Work on feature",
      });

      expect(() => blockSessionGoal(SESSION_KEY, "")).toThrow("blocked reason must not be empty");
      expect(() => blockSessionGoal(SESSION_KEY, "   ")).toThrow("blocked reason must not be empty");
    });

    it("does not block a budget-limited goal", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Spend carefully",
        tokenBudget: 10,
      });
      accountSessionGoalUsage({ sessionKey: SESSION_KEY, tokenDelta: 10 });

      const result = blockSessionGoal(SESSION_KEY, "Some reason");
      expect(result?.status).toBe("budget_limited");
    });

    it("does not block a complete goal", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Done",
      });
      completeSessionGoal(SESSION_KEY);

      const result = blockSessionGoal(SESSION_KEY, "Some reason");
      expect(result?.status).toBe("complete");
    });

    it("resumes a blocked goal back to active", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Work on feature",
      });
      blockSessionGoal(SESSION_KEY, "Waiting for input");

      const resumed = resumeSessionGoal(SESSION_KEY);
      expect(resumed?.status).toBe("active");
      expect(resumed?.blockedReason).toBeUndefined();
    });

    it("completes a blocked goal", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Work on feature",
      });
      blockSessionGoal(SESSION_KEY, "Waiting for input");

      const completed = completeSessionGoal(SESSION_KEY);
      expect(completed?.status).toBe("complete");
    });

    it("clears blockedReason when replacing a goal", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Work on feature",
      });
      blockSessionGoal(SESSION_KEY, "Some blocker");

      const replaced = replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "New objective",
      });
      expect(replaced.status).toBe("active");
      expect(replaced.blockedReason).toBeUndefined();
    });
  });

  describe("prompt rendering", () => {
    it("renders active goal into prompt section", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Implement the feature",
        tokenBudget: 50000,
      });

      const section = buildSessionGoalPromptSection(SESSION_KEY);
      expect(section).not.toBeNull();
      expect(section).toContain("Implement the feature");
      expect(section).toContain("Status: active");
      expect(section).toContain("0 / 50000 tokens");
    });

    it("renders blocked goal with reason", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Work on feature",
      });
      blockSessionGoal(SESSION_KEY, "Waiting for API key");

      const section = buildSessionGoalPromptSection(SESSION_KEY);
      expect(section).not.toBeNull();
      expect(section).toContain("Status: blocked");
      expect(section).toContain("Blocked reason: Waiting for API key");
    });

    it("renders paused goal", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Paused work",
      });
      pauseActiveSessionGoal(SESSION_KEY);

      const section = buildSessionGoalPromptSection(SESSION_KEY);
      expect(section).not.toBeNull();
      expect(section).toContain("Status: paused");
    });

    it("renders budget-limited goal", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Spend carefully",
        tokenBudget: 10,
      });
      accountSessionGoalUsage({ sessionKey: SESSION_KEY, tokenDelta: 10 });

      const section = buildSessionGoalPromptSection(SESSION_KEY);
      expect(section).not.toBeNull();
      expect(section).toContain("Status: budget_limited");
    });

    it("does not render completed goals", () => {
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Done",
      });
      completeSessionGoal(SESSION_KEY);

      const section = buildSessionGoalPromptSection(SESSION_KEY);
      expect(section).toBeNull();
    });

    it("does not render when no goal exists", () => {
      const section = buildSessionGoalPromptSection(SESSION_KEY);
      expect(section).toBeNull();
    });

    it("includes goalId for traceability", () => {
      const goal = replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: "Traceable work",
      });

      const section = buildSessionGoalPromptSection(SESSION_KEY);
      expect(section).toContain(`Goal ID: ${goal.goalId}`);
    });

    it("truncates long objectives in prompt", () => {
      const longObjective = "A".repeat(600);
      replaceSessionGoal({
        sessionKey: SESSION_KEY,
        objective: longObjective,
      });

      const section = buildSessionGoalPromptSection(SESSION_KEY);
      expect(section).not.toBeNull();
      expect(section!.length).toBeLessThan(700);
      expect(section).toContain("...");
    });
  });

  describe("store hardening (SQLITE_NOMEM)", () => {
    const GET_GOAL_SQL = /^\s*SELECT[\s\S]*FROM session_goals\s+WHERE session_key = \?\s*$/;

    function sqliteOutOfMemory(): Error {
      // Shape of the bun:sqlite error observed in production: SQLiteError
      // "out of memory", code SQLITE_NOMEM, errno 7.
      return Object.assign(new Error("out of memory"), { name: "SQLiteError", code: "SQLITE_NOMEM", errno: 7 });
    }

    /**
     * Make `Statement.get` for the goal lookup throw `makeError()` until
     * `remaining` failures are consumed; later calls hit the real statement.
     */
    function injectGoalReadFailures(db: Database, remaining: number, makeError: () => Error) {
      const state = { remaining, thrown: 0, goalPrepares: 0 };
      const originalPrepare = db.prepare.bind(db);
      const prepareSpy = spyOn(db, "prepare").mockImplementation(((sql: string) => {
        const statement = originalPrepare(sql);
        if (!GET_GOAL_SQL.test(sql)) return statement;
        state.goalPrepares++;
        return new Proxy(statement, {
          get(target, prop, receiver) {
            if (prop === "get" && state.remaining > 0) {
              return () => {
                state.remaining--;
                state.thrown++;
                throw makeError();
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as Statement;
      }) as typeof db.prepare);
      return { state, prepareSpy };
    }

    function captureStderr() {
      const lines: string[] = [];
      const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
      return { lines, spy };
    }

    it("survives an in-process router db close and reopen at the same path", () => {
      replaceSessionGoal({ sessionKey: SESSION_KEY, objective: "Survive reconnect" });
      expect(getSessionGoal(SESSION_KEY)?.objective).toBe("Survive reconnect");

      // Control: a statement prepared on the connection that is about to be
      // closed is exactly what a path-keyed cache would keep handing out.
      const staleStatement = getDb().prepare("SELECT goal_id FROM session_goals WHERE session_key = ?");

      // closeAllRaviDbs() / bot.stop() close the router db; the next getDb()
      // lazily reopens it at the same path.
      closeRouterDb();
      const reopened = getDb();
      // Any schema change forces SQLite to re-prepare cached statements.
      reopened.exec("CREATE TABLE IF NOT EXISTS session_goal_reconnect_probe (id INTEGER PRIMARY KEY)");

      // bun:sqlite surfaces the stale-handle failure as SQLITE_NOMEM "out of memory".
      expect(() => staleStatement.get(SESSION_KEY)).toThrow(/out of memory|finalized|closed/i);

      const stderr = captureStderr();
      try {
        expect(getSessionGoal(SESSION_KEY)?.objective).toBe("Survive reconnect");
        expect(buildSessionGoalPromptSection(SESSION_KEY)).toContain("Survive reconnect");
        expect(completeSessionGoal(SESSION_KEY)?.status).toBe("complete");
        expect(clearSessionGoal(SESSION_KEY)).toBe(true);
        expect(getSessionGoal(SESSION_KEY)).toBeNull();
      } finally {
        stderr.spy.mockRestore();
      }
      // The cache is keyed on the live connection, so the stale statements were
      // never executed: no capacity error, no retry.
      expect(stderr.lines.join("")).not.toContain("SQLite capacity error");
    });

    it("retries once on a SQLite capacity error and logs instrumentation", () => {
      replaceSessionGoal({ sessionKey: SESSION_KEY, objective: "Recover after NOMEM" });
      closeSessionGoalStore();
      const { state, prepareSpy } = injectGoalReadFailures(getDb(), 1, sqliteOutOfMemory);
      const stderr = captureStderr();
      try {
        expect(getSessionGoal(SESSION_KEY)?.objective).toBe("Recover after NOMEM");
      } finally {
        stderr.spy.mockRestore();
        prepareSpy.mockRestore();
        closeSessionGoalStore();
      }

      expect(state.thrown).toBe(1);
      // First attempt used the poisoned statement; the retry re-prepared it.
      expect(state.goalPrepares).toBe(2);

      const output = stderr.lines.join("");
      expect(output).toContain("session goal statement hit a SQLite capacity error");
      expect(output).toContain(`session=${SESSION_KEY}`);
      expect(output).toContain("operation=get");
      expect(output).toContain("sqliteCode=SQLITE_NOMEM");
      expect(output).toContain("sqliteErrno=7");
      expect(output).toContain("willRetry=true");
      expect(output).toContain("rssMb=");
      expect(output).toContain("session goal statement recovered after re-preparing on the live connection");
    });

    it("degrades the prompt section instead of failing the turn when the store keeps failing", () => {
      replaceSessionGoal({ sessionKey: SESSION_KEY, objective: "Hidden by NOMEM" });
      closeSessionGoalStore();
      const { state, prepareSpy } = injectGoalReadFailures(getDb(), Number.POSITIVE_INFINITY, sqliteOutOfMemory);
      const stderr = captureStderr();
      let thrown: unknown = null;
      try {
        expect(buildSessionGoalPromptSection(SESSION_KEY)).toBe(SESSION_GOAL_PROMPT_UNAVAILABLE_NOTE);
        try {
          getSessionGoal(SESSION_KEY);
        } catch (error) {
          thrown = error;
        }
      } finally {
        stderr.spy.mockRestore();
        prepareSpy.mockRestore();
        closeSessionGoalStore();
      }

      // One retry per call: 2 attempts for the prompt section, 2 for the direct read.
      expect(state.thrown).toBe(4);
      expect(SESSION_GOAL_PROMPT_UNAVAILABLE_NOTE).not.toMatch(/sqlite|out of memory/i);

      // Direct readers keep the original SQLite error so the CLI SQLITE_CAPACITY
      // contract and prompt-intake ACK path still recognize it...
      expect(thrown).toBeInstanceOf(Error);
      expect(isSqliteCapacityError(thrown)).toBe(true);
      // ...but chat delivery never sees the raw engine text.
      expect(formatUserFacingTurnFailure(thrown)).toBe(
        "Error: The agent could not complete this request because of an internal runtime error. Please try again.",
      );

      const output = stderr.lines.join("");
      expect(output).toContain("willRetry=false");
      expect(output).toContain("session goal prompt section degraded after store capacity error");

      // The store heals as soon as the connection serves reads again.
      expect(getSessionGoal(SESSION_KEY)?.objective).toBe("Hidden by NOMEM");
    });

    it("propagates non-capacity errors without retrying", () => {
      closeSessionGoalStore();
      const { state, prepareSpy } = injectGoalReadFailures(getDb(), Number.POSITIVE_INFINITY, () =>
        Object.assign(new Error("no such table: session_goals"), { name: "SQLiteError" }),
      );
      const stderr = captureStderr();
      try {
        expect(() => getSessionGoal(SESSION_KEY)).toThrow("no such table: session_goals");
        expect(() => buildSessionGoalPromptSection(SESSION_KEY)).toThrow("no such table: session_goals");
      } finally {
        stderr.spy.mockRestore();
        prepareSpy.mockRestore();
        closeSessionGoalStore();
      }
      expect(state.thrown).toBe(2);
    });
  });
});
