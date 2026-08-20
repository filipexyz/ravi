import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

const actualContacts = await import("../contacts.js");
type StoredPlan = {
  planId: string;
  planHash: string;
  planJson: string;
  state: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  approvalJson: string | null;
  appliedAt: string | null;
};

const plans = new Map<string, StoredPlan>();
const effects: Array<Record<string, unknown>> = [];
let completedTaskIds: string[] = [];

mock.module("../contacts.js", () => ({
  ...actualContacts,
  getCrmTask: (taskId: string) => ({
    id: taskId,
    title: "Follow up",
    status: completedTaskIds.includes(taskId) ? "done" : "open",
  }),
  getCrmOpportunity: () => null,
  getCrmFact: () => null,
  getCrmAccount: () => null,
  getContactDetails: () => null,
  completeCrmTask: (input: { taskId: string }) => {
    completedTaskIds.push(input.taskId);
    return { id: input.taskId, title: "Follow up", status: "done" };
  },
  saveCrmFacadePlan: (record: StoredPlan) => plans.set(record.planId, { ...record }),
  getCrmFacadePlan: (planId: string) => plans.get(planId) ?? null,
  updateCrmFacadePlanState: (planId: string, state: string, updatedAt: string, appliedAt?: string) => {
    const plan = plans.get(planId);
    if (plan) plans.set(planId, { ...plan, state, updatedAt, appliedAt: appliedAt ?? plan.appliedAt });
  },
  recordCrmFacadeApproval: (planId: string, approvalJson: string, updatedAt: string) => {
    const plan = plans.get(planId);
    if (plan?.state === "planned") plans.set(planId, { ...plan, state: "approved", approvalJson, updatedAt });
  },
  claimCrmFacadePlanApply: (planId: string) => {
    const plan = plans.get(planId);
    if (!plan || plan.state !== "approved" || Date.parse(plan.expiresAt) <= Date.now()) return false;
    plans.set(planId, { ...plan, state: "applying", updatedAt: new Date().toISOString() });
    return true;
  },
  saveCrmFacadeEffect: (effect: Record<string, unknown>) => effects.push(effect),
  updateCrmFacadeEffect: (effectId: string, update: Record<string, unknown>) => {
    const effect = effects.find((candidate) => candidate.effectId === effectId);
    if (effect) Object.assign(effect, update);
  },
}));

const { applyCrmFacadePlan, approveCrmFacadePlan, buildCrmFacadePlan, loadCrmFacadePlan, persistCrmFacadePlan } =
  await import("./facade.js");

describe("CRM facade", () => {
  beforeEach(() => {
    plans.clear();
    effects.length = 0;
    completedTaskIds = [];
  });

  it("creates an immutable, expiring plan without changing the task", () => {
    const plan = buildCrmFacadePlan({ operation: "task.done", target: "task-1" }, new Date("2026-08-20T12:00:00Z"));
    expect(plan.target).toMatchObject({ type: "task", id: "task-1" });
    expect(plan.expiresAt).toBe("2026-08-20T12:15:00.000Z");
    expect(plan.effects[0]?.retry).toBe("never");
    expect(completedTaskIds).toEqual([]);
  });

  it("requires approval and consumes an approved plan only once", () => {
    const plan = buildCrmFacadePlan({ operation: "task.done", target: "task-1" });
    persistCrmFacadePlan(plan);
    expect(() => applyCrmFacadePlan(plan.planId)).toThrow(/approval/i);

    approveCrmFacadePlan(plan.planId, { channel: "telegram", accountId: "acct", chatId: "chat" });
    const result = applyCrmFacadePlan(plan.planId);
    expect(result.state).toBe("applied");
    expect(completedTaskIds).toEqual(["task-1"]);
    expect(loadCrmFacadePlan(plan.planId)?.state).toBe("applied");
    expect(() => applyCrmFacadePlan(plan.planId)).toThrow(/applied|cannot be applied/i);
  });
});
