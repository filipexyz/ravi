import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  accountSessionGoalUsage,
  clearSessionGoal,
  completeSessionGoal,
  createSessionGoal,
  getSessionGoal,
  pauseActiveSessionGoal,
  replaceSessionGoal,
  resumeSessionGoal,
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
});
