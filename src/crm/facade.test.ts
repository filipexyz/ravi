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
let taskStatus = "open";
let taskReadbackError: Error | null = null;
let effectUpdatesTask = true;
let effectError: Error | null = null;
let factStatus = "proposed";

mock.module("../contacts.js", () => ({
  ...actualContacts,
  getCrmTask: (taskId: string) => {
    if (taskReadbackError) throw taskReadbackError;
    return {
      id: taskId,
      title: "Follow up",
      status: completedTaskIds.includes(taskId) ? "done" : taskStatus,
    };
  },
  getCrmOpportunity: (opportunityId: string) =>
    opportunityId === "opp-1"
      ? { id: "opp-1", title: "Renewal", status: "open", accountId: "acct-1", pipelineId: "pipe-1" }
      : null,
  getCrmFact: (factId: string) => (factId === "fact-1" ? { id: "fact-1", key: "budget", status: factStatus } : null),
  getCrmAccount: (accountId: string) =>
    accountId === "acct-1" ? { account: { id: "acct-1", name: "ACME" }, contacts: [] } : null,
  getContactDetails: (contactId: string) =>
    contactId === "contact-1" ? { contact: { id: "contact-1", displayName: "Ana" } } : null,
  completeCrmTask: (input: { taskId: string }) => {
    if (effectUpdatesTask) completedTaskIds.push(input.taskId);
    if (effectError) throw effectError;
    return { id: input.taskId, title: "Follow up", status: "done" };
  },
  saveCrmFacadePlan: (record: StoredPlan) => plans.set(record.planId, { ...record }),
  getCrmFacadePlan: (planId: string) => plans.get(planId) ?? null,
  updateCrmFacadePlanState: (planId: string, state: string, updatedAt: string, appliedAt?: string) => {
    const plan = plans.get(planId);
    if (plan) plans.set(planId, { ...plan, state, updatedAt, appliedAt: appliedAt ?? plan.appliedAt });
  },
  recordCrmFacadeApprovalRequest: (planId: string, approvalJson: string, updatedAt: string) => {
    const plan = plans.get(planId);
    if (plan?.state !== "planned" || plan.approvalJson !== null || Date.parse(plan.expiresAt) <= Date.parse(updatedAt))
      return false;
    plans.set(planId, { ...plan, approvalJson, updatedAt });
    return true;
  },
  recordCrmFacadeApproval: (planId: string, expectedApprovalJson: string, approvalJson: string, updatedAt: string) => {
    const plan = plans.get(planId);
    if (
      plan?.state !== "planned" ||
      plan.approvalJson !== expectedApprovalJson ||
      Date.parse(plan.expiresAt) <= Date.parse(updatedAt)
    )
      return false;
    plans.set(planId, { ...plan, state: "approved", approvalJson, updatedAt });
    return true;
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

const {
  applyCrmFacadePlan,
  approveCrmFacadePlan,
  buildCrmFacadePlan,
  loadCrmFacadePlan,
  persistCrmFacadePlan,
  recordCrmFacadeApprovalRequest,
  verifyCrmFacadePlan,
} = await import("./facade.js");

const approvalSource = { channel: "telegram", accountId: "acct", chatId: "chat" };

function externallyApprove(planId: string, externalMessageId = "msg-1", approverId = "human-1"): void {
  recordCrmFacadeApprovalRequest(planId, {
    source: approvalSource,
    externalMessageId,
    authorizedApproverId: "human-1",
  });
  approveCrmFacadePlan(planId, { externalMessageId, approverId });
}

describe("CRM facade", () => {
  beforeEach(() => {
    plans.clear();
    effects.length = 0;
    completedTaskIds = [];
    taskStatus = "open";
    taskReadbackError = null;
    effectUpdatesTask = true;
    effectError = null;
    factStatus = "proposed";
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
    expect(verifyCrmFacadePlan(plan.planId).outcome).toBe("not_applied");
    expect(() => applyCrmFacadePlan(plan.planId)).toThrow(/approval/i);

    externallyApprove(plan.planId);
    const result = applyCrmFacadePlan(plan.planId);
    expect(result.state).toBe("applied");
    expect(completedTaskIds).toEqual(["task-1"]);
    expect(loadCrmFacadePlan(plan.planId)?.state).toBe("applied");
    expect(verifyCrmFacadePlan(plan.planId).outcome).toBe("applied");
    expect(() => applyCrmFacadePlan(plan.planId)).toThrow(/applied|cannot be applied/i);
  });

  it("rejects a persisted plan whose payload no longer matches its hash", () => {
    const plan = buildCrmFacadePlan({ operation: "task.done", target: "task-1" });
    persistCrmFacadePlan(plan);
    const stored = plans.get(plan.planId)!;
    plans.set(plan.planId, { ...stored, planJson: stored.planJson.replace("task.done", "task.cancel") });
    expect(() => loadCrmFacadePlan(plan.planId)).toThrow(/integrity/i);
  });

  it("rejects approval binding after plan expiry", () => {
    const createdAt = new Date(Date.now() - 16 * 60 * 1000);
    const plan = buildCrmFacadePlan({ operation: "task.done", target: "task-1" }, createdAt);
    persistCrmFacadePlan(plan);

    expect(() =>
      recordCrmFacadeApprovalRequest(plan.planId, {
        source: approvalSource,
        externalMessageId: "msg-expired",
        authorizedApproverId: "human-1",
      }),
    ).toThrow(/expired/i);
  });

  it("binds approval to the plan hash, external message, and authorized identity", () => {
    const plan = buildCrmFacadePlan({ operation: "task.done", target: "task-1" });
    persistCrmFacadePlan(plan);
    recordCrmFacadeApprovalRequest(plan.planId, {
      source: approvalSource,
      externalMessageId: "msg-bound",
      authorizedApproverId: "human-1",
    });

    expect(loadCrmFacadePlan(plan.planId)?.approval).toMatchObject({
      state: "requested",
      planHash: plan.planHash,
      externalMessageId: "msg-bound",
      authorizedApproverId: "human-1",
      approverId: null,
    });
    expect(() => approveCrmFacadePlan(plan.planId, { externalMessageId: "msg-other", approverId: "human-1" })).toThrow(
      /does not match/i,
    );
    expect(() => approveCrmFacadePlan(plan.planId, { externalMessageId: "msg-bound", approverId: "intruder" })).toThrow(
      /unauthorized/i,
    );

    approveCrmFacadePlan(plan.planId, { externalMessageId: "msg-bound", approverId: "human-1" });
    expect(loadCrmFacadePlan(plan.planId)?.approval).toMatchObject({
      state: "approved",
      externalMessageId: "msg-bound",
      authorizedApproverId: "human-1",
      approverId: "human-1",
    });
  });

  it("finishes as partial when independent readback diverges", () => {
    const plan = buildCrmFacadePlan({ operation: "task.done", target: "task-1" });
    persistCrmFacadePlan(plan);
    externallyApprove(plan.planId);
    effectUpdatesTask = false;

    const result = applyCrmFacadePlan(plan.planId);

    expect(result).toMatchObject({ state: "partial", readback: { status: "open" } });
    expect(loadCrmFacadePlan(plan.planId)?.state).toBe("partial");
    expect(verifyCrmFacadePlan(plan.planId).outcome).toBe("partial");
  });

  it("leaves an unreadable effect unknown and recovery never replays it", () => {
    const plan = buildCrmFacadePlan({ operation: "task.done", target: "task-1" });
    persistCrmFacadePlan(plan);
    externallyApprove(plan.planId);
    taskReadbackError = new Error("sensor unavailable");

    const result = applyCrmFacadePlan(plan.planId);

    expect(result).toMatchObject({ state: "unknown", reason: expect.stringContaining("sensor unavailable") });
    expect(loadCrmFacadePlan(plan.planId)?.state).toBe("unknown");
    taskReadbackError = null;
    expect(verifyCrmFacadePlan(plan.planId).outcome).toBe("applied");
    expect(() => applyCrmFacadePlan(plan.planId)).toThrow(/unknown|cannot be applied/i);
    expect(completedTaskIds).toEqual(["task-1"]);
  });

  it("refuses a stale approved transition before claiming or dispatching an effect", () => {
    const plan = buildCrmFacadePlan({ operation: "task.done", target: "task-1" });
    persistCrmFacadePlan(plan);
    externallyApprove(plan.planId);
    taskStatus = "canceled";

    expect(() => applyCrmFacadePlan(plan.planId)).toThrow(/cannot transition/i);
    expect(completedTaskIds).toEqual([]);
    expect(effects).toEqual([]);
    expect(loadCrmFacadePlan(plan.planId)?.state).toBe("approved");
  });

  it("accepts only canonical contact enums and resolves relationship references", () => {
    const lifecycle = buildCrmFacadePlan({
      operation: "contact.set",
      target: "contact-1",
      field: "lifecycle",
      value: "QUALIFIED",
    });
    expect(lifecycle.arguments).toMatchObject({ field: "lifecycle", value: "qualified" });

    const account = buildCrmFacadePlan({
      operation: "contact.set",
      target: "contact-1",
      field: "primary-account",
      value: "acct-1",
    });
    expect(account.arguments.value).toBe("acct-1");

    const clearedPriority = buildCrmFacadePlan({
      operation: "contact.set",
      target: "contact-1",
      field: "priority",
      value: "-",
    });
    expect(clearedPriority.arguments.value).toBeNull();
    expect(() =>
      buildCrmFacadePlan({
        operation: "contact.set",
        target: "contact-1",
        field: "lifecycle",
        value: "maybe",
      }),
    ).toThrow(/Invalid lifecycle/i);
    expect(() =>
      buildCrmFacadePlan({
        operation: "contact.set",
        target: "contact-1",
        field: "primary-account",
        value: "missing",
      }),
    ).toThrow(/account not found/i);
  });

  it("rejects task and fact transitions from terminal states during planning", () => {
    taskStatus = "canceled";
    expect(() => buildCrmFacadePlan({ operation: "task.done", target: "task-1" })).toThrow(/cannot transition/i);

    factStatus = "confirmed";
    expect(() => buildCrmFacadePlan({ operation: "fact.reject", target: "fact-1" })).toThrow(/cannot transition/i);
  });
});
