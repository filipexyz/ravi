import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { CrmFacadePlanInput } from "./facade.js";

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
let taskDueAt: string | null = null;
let opportunityStageId = "stage-old";
let contactProfile: Record<string, unknown> = { priority: "normal" };
let accountLink: Record<string, unknown> | null = null;
let opportunityLink: Record<string, unknown> | null = null;
let effectCalls: Array<{ operation: string; input: Record<string, unknown> }> = [];
let taskAvailable = true;
let opportunityAvailable = true;
let factAvailable = true;
let contactAvailable = true;
let accountAvailable = true;

function dispatch(operation: string, input: Record<string, unknown>, apply: () => void): void {
  effectCalls.push({ operation, input });
  if (effectUpdatesTask) apply();
  if (effectError) throw effectError;
}

mock.module("../contacts.js", () => ({
  ...actualContacts,
  getCrmTask: (taskId: string) => {
    if (!taskAvailable) return null;
    if (taskReadbackError && completedTaskIds.includes(taskId)) throw taskReadbackError;
    return {
      id: taskId,
      title: "Follow up",
      status: taskStatus,
      dueAt: taskDueAt,
      snoozedUntil: taskStatus === "snoozed" ? taskDueAt : null,
    };
  },
  getCrmOpportunity: (opportunityId: string) =>
    opportunityAvailable && opportunityId === "opp-1"
      ? {
          id: "opp-1",
          title: "Renewal",
          status: "open",
          stageId: opportunityStageId,
          accountId: "acct-1",
          pipelineId: "pipe-1",
        }
      : null,
  getCrmPipelineStage: (_pipelineId: string, stageRef: string) => ({
    pipeline: { id: "pipe-1" },
    stage: { id: stageRef === "won" ? "stage-won" : stageRef, status: "active" },
    topics: [],
  }),
  getCrmFact: (factId: string) =>
    factAvailable && factId === "fact-1" ? { id: "fact-1", key: "budget", status: factStatus } : null,
  getCrmAccount: (accountId: string) =>
    accountId === "acct-1" ? { account: { id: "acct-1", name: "ACME" }, contacts: [] } : null,
  getCrmAccountSummary: (accountId: string) =>
    accountAvailable && accountId === "acct-1" ? { id: "acct-1", name: "ACME" } : null,
  getCrmAccountContact: () => accountLink,
  getCrmOpportunityContact: () => opportunityLink,
  getContactDetails: (contactId: string) =>
    contactAvailable && contactId === "contact-1" ? { contact: { id: "contact-1", displayName: "Ana" } } : null,
  getCrmContactProfile: (contactId: string) =>
    contactAvailable && contactId === "contact-1" ? { contact: { id: contactId }, profile: contactProfile } : null,
  completeCrmTask: (input: Record<string, unknown>) => {
    dispatch("task.done", input, () => {
      completedTaskIds.push(String(input.taskId));
      taskStatus = "done";
    });
    return { id: input.taskId, title: "Follow up", status: "done" };
  },
  cancelCrmTask: (input: Record<string, unknown>) => {
    dispatch("task.cancel", input, () => {
      taskStatus = "canceled";
    });
    return { id: input.taskId, status: taskStatus };
  },
  snoozeCrmTask: (input: Record<string, unknown>) => {
    dispatch("task.snooze", input, () => {
      taskStatus = "snoozed";
      taskDueAt = String(input.snoozedUntil);
    });
    return { id: input.taskId, status: taskStatus, snoozedUntil: taskDueAt };
  },
  moveCrmOpportunityStage: (input: Record<string, unknown>) => {
    dispatch("opportunity.move", input, () => {
      opportunityStageId = String(input.stageRef);
    });
    return { id: input.opportunityId, stageId: opportunityStageId };
  },
  confirmCrmFact: (input: Record<string, unknown>) => {
    dispatch("fact.confirm", input, () => {
      factStatus = "confirmed";
    });
    return { id: input.factId, status: factStatus };
  },
  rejectCrmFact: (input: Record<string, unknown>) => {
    dispatch("fact.reject", input, () => {
      factStatus = "rejected";
    });
    return { id: input.factId, status: factStatus };
  },
  updateCrmContactProfile: (input: Record<string, unknown>) => {
    dispatch("contact.set", input, () => {
      if (input.priority !== undefined) contactProfile.priority = input.priority;
    });
    return contactProfile;
  },
  linkCrmAccountContact: (input: Record<string, unknown>) => {
    dispatch("account.link-contact", input, () => {
      accountLink = {
        accountId: input.accountId,
        contactId: input.contactRef,
        role: input.role,
        isPrimary: input.isPrimary ?? true,
        secret: "hidden-account-link-data",
      };
    });
    return accountLink;
  },
  linkCrmOpportunityContact: (input: Record<string, unknown>) => {
    dispatch("opportunity.link-contact", input, () => {
      opportunityLink = {
        opportunityId: input.opportunityId,
        contactId: input.contactRef,
        accountId: input.accountId,
        role: input.role,
        isPrimary: input.isPrimary ?? true,
        secret: "hidden-opportunity-link-data",
      };
    });
    return opportunityLink;
  },
  saveCrmFacadePlan: (record: StoredPlan) => plans.set(record.planId, { ...record }),
  pruneExpiredUnapprovedCrmFacadePlans: () => [],
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

const operationCases: Array<{
  name: string;
  input: CrmFacadePlanInput;
  expectedArguments: Record<string, unknown>;
  targetType: "task" | "opportunity" | "fact" | "contact" | "account";
}> = [
  { name: "task.done", input: { operation: "task.done", target: "task-1" }, expectedArguments: {}, targetType: "task" },
  {
    name: "task.cancel",
    input: { operation: "task.cancel", target: "task-1", reason: "duplicate" },
    expectedArguments: { reason: "duplicate" },
    targetType: "task",
  },
  {
    name: "task.snooze",
    input: { operation: "task.snooze", target: "task-1", until: "2030-01-01T10:00:00Z" },
    expectedArguments: { until: "2030-01-01T10:00:00.000Z" },
    targetType: "task",
  },
  {
    name: "opportunity.move",
    input: { operation: "opportunity.move", target: "opp-1", stage: "stage-new" },
    expectedArguments: { stage: "stage-new" },
    targetType: "opportunity",
  },
  {
    name: "fact.confirm",
    input: { operation: "fact.confirm", target: "fact-1" },
    expectedArguments: {},
    targetType: "fact",
  },
  {
    name: "fact.reject",
    input: { operation: "fact.reject", target: "fact-1" },
    expectedArguments: {},
    targetType: "fact",
  },
  {
    name: "contact.set",
    input: { operation: "contact.set", target: "contact-1", field: "priority", value: "HIGH" },
    expectedArguments: { field: "priority", value: "high" },
    targetType: "contact",
  },
  {
    name: "account.link-contact",
    input: { operation: "account.link-contact", target: "acct-1", contact: "contact-1" },
    expectedArguments: { contact: "contact-1", role: "member" },
    targetType: "account",
  },
  {
    name: "opportunity.link-contact",
    input: { operation: "opportunity.link-contact", target: "opp-1", contact: "contact-1" },
    expectedArguments: { contact: "contact-1", account: "acct-1", role: "stakeholder" },
    targetType: "opportunity",
  },
];

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
    taskDueAt = null;
    opportunityStageId = "stage-old";
    contactProfile = { priority: "normal" };
    accountLink = null;
    opportunityLink = null;
    effectCalls = [];
    taskAvailable = true;
    opportunityAvailable = true;
    factAvailable = true;
    contactAvailable = true;
    accountAvailable = true;
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
    expect(() => applyCrmFacadePlan(plan.planId, { actorId: "agent-1" })).toThrow(/approval/i);

    externallyApprove(plan.planId);
    const result = applyCrmFacadePlan(plan.planId, { actorId: "agent-1" });
    expect(result.state).toBe("applied");
    expect(completedTaskIds).toEqual(["task-1"]);
    expect(loadCrmFacadePlan(plan.planId)?.state).toBe("applied");
    expect(verifyCrmFacadePlan(plan.planId).outcome).toBe("applied");
    expect(() => applyCrmFacadePlan(plan.planId, { actorId: "agent-1" })).toThrow(/applied|cannot be applied/i);
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

    const result = applyCrmFacadePlan(plan.planId, { actorId: "agent-1" });

    expect(result).toMatchObject({ state: "partial", readback: { status: "open" } });
    expect(loadCrmFacadePlan(plan.planId)?.state).toBe("partial");
    expect(verifyCrmFacadePlan(plan.planId).outcome).toBe("partial");
  });

  it("leaves an unreadable effect unknown and recovery never replays it", () => {
    const plan = buildCrmFacadePlan({ operation: "task.done", target: "task-1" });
    persistCrmFacadePlan(plan);
    externallyApprove(plan.planId);
    taskReadbackError = new Error("sensor unavailable");

    const result = applyCrmFacadePlan(plan.planId, { actorId: "agent-1" });

    expect(result).toMatchObject({ state: "unknown", reason: expect.stringContaining("sensor unavailable") });
    expect(loadCrmFacadePlan(plan.planId)?.state).toBe("unknown");
    taskReadbackError = null;
    expect(verifyCrmFacadePlan(plan.planId).outcome).toBe("applied");
    expect(() => applyCrmFacadePlan(plan.planId, { actorId: "agent-1" })).toThrow(/unknown|cannot be applied/i);
    expect(completedTaskIds).toEqual(["task-1"]);
  });

  it("refuses a stale approved transition before claiming or dispatching an effect", () => {
    const plan = buildCrmFacadePlan({ operation: "task.done", target: "task-1" });
    persistCrmFacadePlan(plan);
    externallyApprove(plan.planId);
    taskStatus = "canceled";

    expect(() => applyCrmFacadePlan(plan.planId, { actorId: "agent-1" })).toThrow(/cannot transition/i);
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

  for (const scenario of operationCases) {
    it(`${scenario.name} closes normalize, dispatch, readback, audit and retry boundaries`, () => {
      const plan = buildCrmFacadePlan(scenario.input);
      expect(plan.arguments).toMatchObject({ target: scenario.input.target, ...scenario.expectedArguments });
      if (scenario.name.endsWith("link-contact")) expect(plan.arguments).not.toHaveProperty("primary");

      persistCrmFacadePlan(plan);
      expect(verifyCrmFacadePlan(plan.planId).outcome).toBe("not_applied");
      externallyApprove(plan.planId);
      const result = applyCrmFacadePlan(plan.planId, { actorId: "agent-matrix" });

      expect(result.state).toBe("applied");
      expect(effectCalls).toHaveLength(1);
      expect(effectCalls[0]).toMatchObject({
        operation: scenario.name,
        input: { actorId: "agent-matrix", actorType: "agent", idempotencyKey: plan.effects[0]?.effectId },
      });
      expect(effects[0]).toMatchObject({
        operation: scenario.name,
        idempotencyKey: plan.effects[0]?.effectId,
        state: "observed",
      });
      expect(JSON.stringify(result.readback)).not.toContain("secret");
      expect(() => applyCrmFacadePlan(plan.planId, { actorId: "agent-matrix" })).toThrow(/cannot be applied/i);
    });

    it(`${scenario.name} classifies divergent readback as partial`, () => {
      const plan = buildCrmFacadePlan(scenario.input);
      persistCrmFacadePlan(plan);
      externallyApprove(plan.planId);
      effectUpdatesTask = false;

      const result = applyCrmFacadePlan(plan.planId, { actorId: "agent-matrix" });

      expect(result.state).toBe("partial");
      expect(verifyCrmFacadePlan(plan.planId).outcome).toBe("partial");
    });

    it(`${scenario.name} classifies ambiguous execution as unknown without replay`, () => {
      const plan = buildCrmFacadePlan(scenario.input);
      persistCrmFacadePlan(plan);
      externallyApprove(plan.planId);
      effectUpdatesTask = false;
      effectError = new Error("transport interrupted");

      const result = applyCrmFacadePlan(plan.planId, { actorId: "agent-matrix" });

      expect(result.state).toBe("unknown");
      expect(result.reason).toContain("transport interrupted");
      expect(() => applyCrmFacadePlan(plan.planId, { actorId: "agent-matrix" })).toThrow(/cannot be applied/i);
      expect(effectCalls).toHaveLength(1);
    });

    it(`${scenario.name} rechecks the exact target before claim and dispatch`, () => {
      const plan = buildCrmFacadePlan(scenario.input);
      persistCrmFacadePlan(plan);
      externallyApprove(plan.planId);
      if (scenario.targetType === "task") taskAvailable = false;
      if (scenario.targetType === "opportunity") opportunityAvailable = false;
      if (scenario.targetType === "fact") factAvailable = false;
      if (scenario.targetType === "contact") contactAvailable = false;
      if (scenario.targetType === "account") accountAvailable = false;

      expect(() => applyCrmFacadePlan(plan.planId, { actorId: "agent-matrix" })).toThrow(/not found/i);
      expect(effectCalls).toEqual([]);
      expect(effects).toEqual([]);
      expect(loadCrmFacadePlan(plan.planId)?.state).toBe("approved");
    });
  }

  it("preserves omitted primary and applies an explicit false from SDK-compatible input", () => {
    const omitted = buildCrmFacadePlan({
      operation: "account.link-contact",
      target: "acct-1",
      contact: "contact-1",
    });
    expect(omitted.arguments).not.toHaveProperty("primary");

    const explicit = buildCrmFacadePlan({
      operation: "account.link-contact",
      target: "acct-1",
      contact: "contact-1",
      primary: false,
    });
    expect(explicit.arguments.primary).toBe(false);
    persistCrmFacadePlan(explicit);
    externallyApprove(explicit.planId);
    expect(applyCrmFacadePlan(explicit.planId, { actorId: "agent-1" }).state).toBe("applied");
    expect(effectCalls[0]?.input.isPrimary).toBe(false);
  });

  it("requires trusted actor context before claiming an approved plan", () => {
    const plan = buildCrmFacadePlan({ operation: "task.done", target: "task-1" });
    persistCrmFacadePlan(plan);
    externallyApprove(plan.planId);

    expect(() => applyCrmFacadePlan(plan.planId, { actorId: "" })).toThrow(/actor id/i);
    expect(loadCrmFacadePlan(plan.planId)?.state).toBe("approved");
    expect(effects).toEqual([]);
  });
});
