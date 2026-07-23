import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  accountSessionGoalUsage,
  blockSessionGoal,
  buildSessionGoalPromptSection,
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
});
