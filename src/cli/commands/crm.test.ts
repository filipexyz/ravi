import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { CrmFacadePlan, CrmFacadePlanInput } from "../../crm/facade.js";

afterAll(() => mock.restore());

const actualCliContextModule = await import("../context.js");
const actualContactsModule = await import("../../contacts.js");
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

let crmContactProfile: Record<string, unknown> | null = null;
let crmAccount: Record<string, unknown> | null = null;
let crmOpportunity: Record<string, unknown> | null = null;
let crmTask: Record<string, unknown> | null = null;
let taskRecords: Array<Record<string, unknown>> = [];
let nextActionRecords: Array<Record<string, unknown>> = [];
let contactCardRecords: Array<Record<string, unknown>> = [];
let opportunityBoardRecords: Array<Record<string, unknown>> = [];
let opportunityContactRecords: Array<Record<string, unknown>> = [];
let pipelineRecords: Array<Record<string, unknown>> = [];
let pipelineStageRecords: Array<Record<string, unknown>> = [];
let pipelineTopicRecords: Array<Record<string, unknown>> = [];
let factRecords: Array<Record<string, unknown>> = [];
let accountContactIds: string[] = [];
let scopeEnforced = false;
let readableContactIds = new Set<string>();
let lastAccountCreateInput: Record<string, unknown> | null = null;
let lastAccountContactInput: Record<string, unknown> | null = null;
let lastOpportunityCreateInput: Record<string, unknown> | null = null;
let lastOpportunityMoveInput: Record<string, unknown> | null = null;
let lastTaskCreateInput: Record<string, unknown> | null = null;
let lastTaskMutationInput: Record<string, unknown> | null = null;
let lastProfileUpdateInput: Record<string, unknown> | null = null;
let lastOpportunityContactInput: Record<string, unknown> | null = null;
let lastFactInput: Record<string, unknown> | null = null;
let lastFactMutationInput: Record<string, unknown> | null = null;
let lastPipelineCreateInput: Record<string, unknown> | null = null;
let lastPipelineUpdateInput: Record<string, unknown> | null = null;
let lastPipelineStageCreateInput: Record<string, unknown> | null = null;
let lastPipelineStageUpdateInput: Record<string, unknown> | null = null;
let lastPipelineTopicCreateInput: Record<string, unknown> | null = null;
let lastPipelineTopicUpdateInput: Record<string, unknown> | null = null;
const facadePlans = new Map<string, StoredPlan>();
const facadeEffects: Array<Record<string, unknown>> = [];

function pageRecords<T>(
  records: T[],
  options: { limit?: string | number | null; offset?: string | number | null } = {},
) {
  const limit = Number(options.limit ?? 25);
  const offset = Number(options.offset ?? 0);
  return {
    total: records.length,
    limit,
    offset,
    items: records.slice(offset, offset + limit),
  };
}

function filterReadableRecords<T extends Record<string, unknown>>(
  records: T[],
  options: { readableContactIds?: readonly string[] | null } = {},
): T[] {
  if (options.readableContactIds == null) return records;
  const readable = new Set(options.readableContactIds);
  return records.filter((record) => {
    const direct = record.contactId ?? record.contact_id;
    const contactId =
      typeof direct === "string"
        ? direct
        : record.entityType === "contact" && typeof record.entityId === "string"
          ? record.entityId
          : null;
    return contactId === null || readable.has(contactId);
  });
}

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../permissions/scope.js", () => ({
  getScopeContext: () => ({ agentId: "scoped-agent" }),
  isScopeEnforced: () => scopeEnforced,
  canAccessContact: (_scopeCtx: unknown, contact: { id: string }) => readableContactIds.has(contact.id),
  // Named imports of src/cli/command-access.ts and src/cli/registry.ts, pulled in
  // when a test builds the real commander tree. Usage errors are raised by the
  // parser, so authorization is never reached.
  enforceScopeCheck: () => ({ allowed: true, errorMessage: "" }),
  flushAuditAndExit: (code: number): never => {
    throw new Error(`flushAuditAndExit(${code})`);
  },
}));

mock.module("../../contacts.js", () => ({
  ...actualContactsModule,
  getCrmContactProfile: (contactRef: string) =>
    crmContactProfile
      ? {
          contact: { id: contactRef, displayName: "Alice" },
          policy: null,
          profile: crmContactProfile,
          card: null,
          accountMemberships: [],
          opportunities: [],
          tasks: [],
          nextActions: [],
          facts: [],
        }
      : null,
  getContactDetails: (contactRef: string) =>
    crmContactProfile
      ? {
          contact: { id: contactRef, displayName: "Alice" },
          policy: null,
          platformIdentities: [],
        }
      : null,
  getAllContactAccessRecords: () =>
    contactCardRecords.map((record) => ({
      id: String(record.contactId),
      tags: [],
      identityValues: [],
    })),
  listCrmNextActions: (options: { limit?: string; offset?: string; readableContactIds?: readonly string[] }) =>
    pageRecords(filterReadableRecords(nextActionRecords, options), options),
  listCrmContactCards: (options: { limit?: string; offset?: string; readableContactIds?: readonly string[] }) =>
    pageRecords(filterReadableRecords(contactCardRecords, options), options),
  listCrmOpportunityBoard: (options: { pipelineRef?: string } = {}) =>
    options.pipelineRef
      ? opportunityBoardRecords.filter((record) => record.pipelineId === options.pipelineRef)
      : opportunityBoardRecords,
  listCrmOpportunityBoardStages: () =>
    pipelineStageRecords.map((stage) => ({
      stage,
      opportunities: opportunityBoardRecords.filter((record) => record.stageKey === stage.key),
    })),
  listCrmOpportunityContacts: () => opportunityContactRecords,
  listCrmPipelines: () => pipelineRecords,
  getCrmPipeline: (pipelineRef: string) => {
    const pipeline = pipelineRecords.find((record) => record.id === pipelineRef || record.name === pipelineRef);
    return pipeline
      ? {
          pipeline,
          stages: pipelineStageRecords,
          topicsByStage: Object.fromEntries(
            pipelineStageRecords.map((stage) => [
              String(stage.id),
              pipelineTopicRecords.filter((topic) => topic.stageId === stage.id),
            ]),
          ),
        }
      : null;
  },
  createCrmPipeline: (input: Record<string, unknown>) => {
    lastPipelineCreateInput = input;
    return {
      id: "crm_pipeline_new",
      name: input.name,
      entityType: input.entityType ?? "opportunity",
      isDefault: input.isDefault === true,
      status: "active",
    };
  },
  updateCrmPipeline: (input: Record<string, unknown>) => {
    lastPipelineUpdateInput = input;
    return {
      id: input.pipelineRef,
      name: input.name ?? "Default Sales Pipeline",
      entityType: input.entityType ?? "opportunity",
      isDefault: input.isDefault === true,
      status: input.status ?? "active",
    };
  },
  listCrmPipelineStages: () => pipelineStageRecords,
  getCrmPipelineStage: (pipelineRef: string, stageRef: string) => {
    const stage = pipelineStageRecords.find((record) => record.id === stageRef || record.key === stageRef);
    return stage
      ? {
          pipeline: pipelineRecords.find((record) => record.id === pipelineRef) ?? pipelineRecords[0],
          stage,
          topics: pipelineTopicRecords.filter((topic) => topic.stageId === stage.id),
        }
      : null;
  },
  createCrmPipelineStage: (input: Record<string, unknown>) => {
    lastPipelineStageCreateInput = input;
    return {
      id: "crm_stage_new",
      pipelineId: input.pipelineRef,
      key: input.key,
      name: input.name,
      sortOrder: input.sortOrder,
      status: "active",
    };
  },
  updateCrmPipelineStage: (input: Record<string, unknown>) => {
    lastPipelineStageUpdateInput = input;
    return {
      id: input.stageRef,
      pipelineId: input.pipelineRef,
      key: input.key ?? input.stageRef,
      name: input.name ?? "Qualified",
      sortOrder: input.sortOrder ?? 20,
      status: input.status ?? "active",
    };
  },
  archiveCrmPipelineStage: (input: Record<string, unknown>) => {
    lastPipelineStageUpdateInput = { ...input, status: "archived" };
    return {
      id: input.stageRef,
      pipelineId: input.pipelineRef,
      key: input.stageRef,
      name: "Qualified",
      sortOrder: 20,
      status: "archived",
    };
  },
  listCrmPipelineStageTopics: () => pipelineTopicRecords,
  createCrmPipelineStageTopic: (input: Record<string, unknown>) => {
    lastPipelineTopicCreateInput = input;
    return {
      id: "crm_stage_topic_new",
      pipelineId: input.pipelineRef,
      stageId: input.stageRef,
      key: input.key,
      title: input.title,
      status: "active",
    };
  },
  updateCrmPipelineStageTopic: (input: Record<string, unknown>) => {
    lastPipelineTopicUpdateInput = input;
    return {
      id: input.topicRef,
      pipelineId: input.pipelineRef,
      stageId: input.stageRef,
      key: input.key ?? input.topicRef,
      title: input.title ?? "Budget",
      status: input.status ?? "active",
    };
  },
  archiveCrmPipelineStageTopic: (input: Record<string, unknown>) => {
    lastPipelineTopicUpdateInput = { ...input, status: "archived" };
    return {
      id: input.topicRef,
      pipelineId: input.pipelineRef,
      stageId: input.stageRef,
      key: input.topicRef,
      title: "Budget",
      status: "archived",
    };
  },
  getCrmAccount: (accountRef: string) =>
    crmAccount
      ? {
          account: { id: accountRef, name: "Acme", ...crmAccount },
          contacts: [],
          opportunities: [],
          tasks: [],
        }
      : null,
  getCrmAccountSummary: (accountRef: string) => (crmAccount ? { id: accountRef, name: "Acme", ...crmAccount } : null),
  listCrmAccountContactIds: () => accountContactIds,
  createCrmAccount: (input: Record<string, unknown>) => {
    lastAccountCreateInput = input;
    return { id: "crm_acc_1", name: input.name, domain: input.domain ?? null };
  },
  linkCrmAccountContact: (input: Record<string, unknown>) => {
    lastAccountContactInput = input;
    return {
      id: "crm_ac_1",
      accountId: input.accountId,
      contactId: input.contactRef,
      role: input.role ?? "member",
      isPrimary: input.isPrimary === true,
    };
  },
  getCrmOpportunity: (opportunityId: string) =>
    crmOpportunity
      ? {
          id: opportunityId,
          title: "Pilot",
          status: "open",
          priority: "normal",
          valueCents: null,
          currency: "BRL",
          ...crmOpportunity,
        }
      : null,
  listCrmOpportunityContactIds: () =>
    opportunityContactRecords
      .map((record) => record.contactId)
      .filter((contactId): contactId is string => typeof contactId === "string"),
  createCrmOpportunity: (input: Record<string, unknown>) => {
    lastOpportunityCreateInput = input;
    return { id: "crm_opp_1", title: input.title, accountId: input.accountId ?? null };
  },
  moveCrmOpportunityStage: (input: Record<string, unknown>) => {
    lastOpportunityMoveInput = input;
    return {
      id: input.opportunityId,
      title: "Pilot",
      status: "open",
      stageId: input.stageRef,
    };
  },
  linkCrmOpportunityContact: (input: Record<string, unknown>) => {
    lastOpportunityContactInput = input;
    return {
      id: "crm_oc_1",
      opportunityId: input.opportunityId,
      contactId: input.contactRef,
      role: input.role ?? "stakeholder",
      isPrimary: input.isPrimary === true,
    };
  },
  listCrmFacts: (options: { limit?: string; offset?: string; readableContactIds?: readonly string[] }) =>
    pageRecords(filterReadableRecords(factRecords, options), options),
  getCrmFact: (factId: string) => {
    const fact = factRecords.find((record) => record.id === factId);
    return fact ? { ...fact, contactId: fact.entityType === "contact" ? fact.entityId : null } : null;
  },
  proposeCrmFact: (input: Record<string, unknown>) => {
    lastFactInput = input;
    return {
      id: "crm_fact_1",
      entityType: input.entityType,
      entityId: input.entityId,
      key: input.key,
      value: input.value,
      status: input.status ?? "proposed",
    };
  },
  confirmCrmFact: (input: Record<string, unknown>) => {
    lastFactMutationInput = input;
    return { id: input.factId, key: "profile.role", status: "confirmed" };
  },
  rejectCrmFact: (input: Record<string, unknown>) => {
    lastFactMutationInput = input;
    return { id: input.factId, key: "profile.role", status: "rejected" };
  },
  getCrmTask: (taskId: string) =>
    crmTask
      ? {
          id: taskId,
          title: "Follow up",
          status: "open",
          dueAt: null,
          ...crmTask,
        }
      : null,
  listCrmTasks: (options: { limit?: string; offset?: string; readableContactIds?: readonly string[] }) =>
    pageRecords(filterReadableRecords(taskRecords, options), options),
  createCrmTask: (input: Record<string, unknown>) => {
    lastTaskCreateInput = input;
    return { id: "crm_task_1", title: input.title, contactId: input.contactRef ?? null };
  },
  completeCrmTask: (input: Record<string, unknown>) => {
    lastTaskMutationInput = input;
    return { id: input.taskId, title: "Follow up", status: "done" };
  },
  cancelCrmTask: (input: Record<string, unknown>) => {
    lastTaskMutationInput = input;
    return { id: input.taskId, title: "Follow up", status: "canceled" };
  },
  snoozeCrmTask: (input: Record<string, unknown>) => {
    lastTaskMutationInput = input;
    return { id: input.taskId, title: "Follow up", status: "snoozed" };
  },
  updateCrmContactProfile: (input: Record<string, unknown>) => {
    lastProfileUpdateInput = input;
    return {
      contactId: input.contactRef,
      lifecycle: input.lifecycle ?? "unknown",
      relationshipHealth: input.relationshipHealth ?? "unknown",
      priority: input.priority ?? "normal",
    };
  },
  saveCrmFacadePlan: (record: StoredPlan) => facadePlans.set(record.planId, { ...record }),
  pruneExpiredUnapprovedCrmFacadePlans: () => [],
  getCrmFacadePlan: (planId: string) => facadePlans.get(planId) ?? null,
  updateCrmFacadePlanState: (planId: string, state: string, updatedAt: string, appliedAt?: string) => {
    const plan = facadePlans.get(planId);
    if (plan) facadePlans.set(planId, { ...plan, state, updatedAt, appliedAt: appliedAt ?? plan.appliedAt });
  },
  recordCrmFacadeApprovalRequest: (planId: string, approvalJson: string, updatedAt: string) => {
    const plan = facadePlans.get(planId);
    if (
      plan?.state !== "planned" ||
      plan.approvalJson !== null ||
      Date.parse(plan.expiresAt) <= Date.parse(updatedAt)
    ) {
      return false;
    }
    facadePlans.set(planId, { ...plan, approvalJson, updatedAt });
    return true;
  },
  recordCrmFacadeApproval: (planId: string, expectedApprovalJson: string, approvalJson: string, updatedAt: string) => {
    const plan = facadePlans.get(planId);
    if (
      plan?.state !== "planned" ||
      plan.approvalJson !== expectedApprovalJson ||
      Date.parse(plan.expiresAt) <= Date.parse(updatedAt)
    ) {
      return false;
    }
    facadePlans.set(planId, { ...plan, state: "approved", approvalJson, updatedAt });
    return true;
  },
  claimCrmFacadePlanApply: (planId: string) => {
    const plan = facadePlans.get(planId);
    if (!plan || plan.state !== "approved" || Date.parse(plan.expiresAt) <= Date.now()) return false;
    facadePlans.set(planId, { ...plan, state: "applying", updatedAt: new Date().toISOString() });
    return true;
  },
  saveCrmFacadeEffect: (effect: Record<string, unknown>) => {
    facadeEffects.push(effect);
  },
  updateCrmFacadeEffect: (effectId: string, update: Record<string, unknown>) => {
    const effect = facadeEffects.find((candidate) => candidate.effectId === effectId);
    if (effect) Object.assign(effect, update);
  },
}));

const {
  ACrmCommands,
  CrmAccountCommands,
  CrmContactCommands,
  CrmFacadeCommands,
  formatCrmFacadeApprovalText,
  CrmFactCommands,
  CrmLifecycleCommands,
  CrmOpportunityCommands,
  CrmPipelineCommands,
  CrmPipelinePolicyCommands,
  CrmPipelineStageCommands,
  CrmPipelineStageTopicCommands,
  CrmTaskCommands,
} = await import("./crm.js");

const { ContractError: CrmContractError, installUsageContract } = await import("../agent-contract.js");
const { Command: CommanderCommand } = await import("commander");
const { registerCommands } = await import("../registry.js");
const { buildCrmFacadePlan, persistCrmFacadePlan } = await import("../../crm/facade.js");

/**
 * Real commander tree for the `crm` group, wired exactly like `src/cli/index.ts`
 * (classes in the barrel's alphabetical order, then the usage contract). Usage
 * errors are raised by the parser, so they never reach the action handler.
 */
function buildCrmProgram() {
  const program = new CommanderCommand();
  program.name("ravi");
  program.showSuggestionAfterError();
  registerCommands(program, [
    ACrmCommands,
    CrmAccountCommands,
    CrmContactCommands,
    CrmFacadeCommands,
    CrmFactCommands,
    CrmLifecycleCommands,
    CrmOpportunityCommands,
    CrmPipelineCommands,
    CrmPipelinePolicyCommands,
    CrmPipelineStageCommands,
    CrmPipelineStageTopicCommands,
    CrmTaskCommands,
  ]);
  installUsageContract(program, "crm");
  return program;
}

function captureJson(run: () => unknown): Record<string, unknown> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    run();
    return JSON.parse(lines.join("\n")) as Record<string, unknown>;
  } finally {
    console.log = original;
  }
}

function captureJsonError(run: () => unknown): { payload: Record<string, unknown>; error: unknown } {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  } finally {
    console.log = original;
  }
  return { payload: JSON.parse(lines.join("\n")) as Record<string, unknown>, error };
}

async function captureJsonErrorAsync(
  run: () => Promise<unknown>,
): Promise<{ payload: Record<string, unknown>; error: unknown }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  } finally {
    console.log = original;
  }
  return { payload: JSON.parse(lines.join("\n")) as Record<string, unknown>, error };
}

function expectTypedNotFound(run: () => unknown, op: string, code: string): Record<string, unknown> {
  const { payload, error } = captureJsonError(run);
  expect(error).toBeInstanceOf(CrmContractError);
  const contractError = error as InstanceType<typeof CrmContractError>;
  expect(contractError.exitCode).toBe(1);
  expect(contractError.code).toBe(code);
  expect(payload).toMatchObject({ success: false, op });
  expect(payload.error).toMatchObject({ code, retryable: false });
  expect((payload.error as Record<string, unknown>).suggestedAction).toBeTruthy();
  return payload;
}

function silenceLogs(run: () => unknown): void {
  const original = console.log;
  console.log = () => {};
  try {
    run();
  } finally {
    console.log = original;
  }
}

function planFacade(input: CrmFacadePlanInput): unknown {
  return new CrmFacadeCommands().plan(
    input.operation,
    input.target,
    input.stage,
    input.contact,
    input.field,
    input.value,
    input.until,
    input.reason,
    input.role,
    input.account,
    input.primary,
    true,
  );
}

describe("CRM commands", () => {
  beforeEach(() => {
    scopeEnforced = false;
    readableContactIds = new Set<string>();
    accountContactIds = [];
    crmContactProfile = {
      contactId: "contact-1",
      lifecycle: "lead",
      relationshipHealth: "good",
      priority: "high",
      nextActionSummary: "Follow up tomorrow",
    };
    crmAccount = { lifecycle: "lead" };
    crmOpportunity = { valueCents: 500_000 };
    crmTask = { dueAt: "2026-05-09T10:00:00Z" };
    taskRecords = [
      {
        id: "crm_task_1",
        contactId: "contact-1",
        accountId: "crm_acc_1",
        opportunityId: "crm_opp_1",
        chatId: "chat-1",
        sessionKey: "dev",
        title: "Follow up",
        body: null,
        taskType: "commitment",
        status: "open",
        priority: "urgent",
        dueAt: "2026-05-09T10:00:00Z",
        snoozedUntil: null,
        completedAt: null,
        canceledAt: null,
        ownerType: "agent",
        ownerId: "dev",
        createdByType: "user",
        createdById: "luis",
        source: "test",
        idempotencyKey: "idem-task",
        confidence: 0.9,
        evidence: [],
        metadata: {},
        raviTaskId: "task-1",
        createdAt: "2026-05-09T09:00:00Z",
        updatedAt: "2026-05-09T09:30:00Z",
      },
    ];
    nextActionRecords = [
      {
        taskId: "crm_task_1",
        title: "Follow up",
        status: "open",
        priority: "urgent",
        dueAt: "2026-05-09T10:00:00Z",
        contactName: "Alice",
        accountName: null,
      },
    ];
    contactCardRecords = [
      {
        contactId: "contact-1",
        displayName: "Alice",
        lifecycle: "lead",
        nextActionSummary: "Follow up",
      },
    ];
    opportunityBoardRecords = [
      { opportunityId: "crm_opp_1", title: "Pilot", pipelineId: "crm_pipeline_default", stageKey: "qualified" },
    ];
    opportunityContactRecords = [{ opportunityId: "crm_opp_1", contactId: "contact-1", role: "stakeholder" }];
    pipelineRecords = [
      {
        id: "crm_pipeline_default",
        name: "Default Sales Pipeline",
        entityType: "opportunity",
        isDefault: true,
        status: "active",
      },
    ];
    pipelineStageRecords = [
      {
        id: "crm_stage_qualified",
        pipelineId: "crm_pipeline_default",
        key: "qualified",
        name: "Qualified",
        sortOrder: 20,
        status: "active",
      },
    ];
    pipelineTopicRecords = [
      {
        id: "crm_stage_topic_budget",
        pipelineId: "crm_pipeline_default",
        stageId: "crm_stage_qualified",
        key: "budget",
        title: "Budget",
        status: "active",
      },
    ];
    factRecords = [
      {
        id: "crm_fact_1",
        entityType: "contact",
        entityId: "contact-1",
        key: "profile.role",
        status: "proposed",
      },
    ];
    lastAccountCreateInput = null;
    lastAccountContactInput = null;
    lastOpportunityCreateInput = null;
    lastOpportunityMoveInput = null;
    lastTaskCreateInput = null;
    lastTaskMutationInput = null;
    lastProfileUpdateInput = null;
    lastOpportunityContactInput = null;
    lastFactInput = null;
    lastFactMutationInput = null;
    lastPipelineCreateInput = null;
    lastPipelineUpdateInput = null;
    lastPipelineStageCreateInput = null;
    lastPipelineStageUpdateInput = null;
    lastPipelineTopicCreateInput = null;
    lastPipelineTopicUpdateInput = null;
    facadePlans.clear();
    facadeEffects.length = 0;
  });

  it("lists CRM next actions as a paginated JSON surface", () => {
    const payload = captureJson(() => {
      new ACrmCommands().next(
        "agent:dev",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "10",
        "0",
        true,
      );
    });

    expect(payload.total).toBe(1);
    expect((payload.pagination as Record<string, unknown>).returned).toBe(1);
    expect((payload.items as Array<Record<string, unknown>>)[0]?.taskId).toBe("crm_task_1");
  });

  it("applies contact visibility before paginating CRM list surfaces", () => {
    scopeEnforced = true;
    const hiddenContactIds = Array.from({ length: 60 }, (_, index) => `contact-hidden-${index + 1}`);
    const visibleContactId = "contact-visible";
    readableContactIds.add(visibleContactId);
    contactCardRecords = [
      ...hiddenContactIds.map((contactId) => ({ contactId, displayName: contactId })),
      { contactId: visibleContactId, displayName: "Visible" },
    ];
    taskRecords = [
      ...hiddenContactIds.slice(0, 30).map((contactId, index) => ({ id: `task-hidden-${index}`, contactId })),
      { id: "task-visible", contactId: visibleContactId },
    ];
    nextActionRecords = [
      ...hiddenContactIds.slice(0, 30).map((contactId, index) => ({ taskId: `task-hidden-${index}`, contactId })),
      { taskId: "task-visible", contactId: visibleContactId },
    ];
    factRecords = [
      ...hiddenContactIds.slice(0, 30).map((contactId, index) => ({
        id: `fact-hidden-${index}`,
        entityType: "contact",
        entityId: contactId,
      })),
      { id: "fact-visible", entityType: "contact", entityId: visibleContactId },
    ];

    const contactsPayload = captureJson(() => {
      new ACrmCommands().contacts(undefined, undefined, "10", "0", true);
    });
    const tasksPayload = captureJson(() => {
      new CrmTaskCommands().list(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "10",
        "0",
        true,
      );
    });
    const factsPayload = captureJson(() => {
      new CrmFactCommands().list(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "10",
        "0",
        true,
      );
    });
    const nextPayload = captureJson(() => {
      new ACrmCommands().next(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "10",
        "0",
        true,
      );
    });

    expect(contactsPayload.total).toBe(1);
    expect((contactsPayload.items as Array<Record<string, unknown>>)[0]?.contactId).toBe(visibleContactId);
    expect(tasksPayload.total).toBe(1);
    expect((tasksPayload.items as Array<Record<string, unknown>>)[0]?.id).toBe("task-visible");
    expect(factsPayload.total).toBe(1);
    expect((factsPayload.items as Array<Record<string, unknown>>)[0]?.id).toBe("fact-visible");
    expect(nextPayload.total).toBe(1);
    expect((nextPayload.items as Array<Record<string, unknown>>)[0]?.taskId).toBe("task-visible");
  });

  it("adds snake_case aliases to CRM task JSON surfaces", () => {
    const listPayload = captureJson(() => {
      new CrmTaskCommands().list(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "10",
        "0",
        true,
      );
    });
    const showPayload = captureJson(() => {
      new CrmTaskCommands().show("crm_task_1", true);
    });

    const task = (listPayload.tasks as Array<Record<string, unknown>>)[0];
    expect(task).toMatchObject({
      taskType: "commitment",
      task_type: "commitment",
      dueAt: "2026-05-09T10:00:00Z",
      due_at: "2026-05-09T10:00:00Z",
      due_date: "2026-05-09T10:00:00Z",
      ownerType: "agent",
      owner_type: "agent",
      idempotencyKey: "idem-task",
      idempotency_key: "idem-task",
      createdAt: "2026-05-09T09:00:00Z",
      created_at: "2026-05-09T09:00:00Z",
    });
    expect((listPayload.items as Array<Record<string, unknown>>)[0]).toEqual(task);
    expect(showPayload.task).toMatchObject({
      dueAt: "2026-05-09T10:00:00Z",
      due_at: "2026-05-09T10:00:00Z",
      due_date: "2026-05-09T10:00:00Z",
    });
  });

  it("supports direct ravi crm contact/account/opportunity read commands", () => {
    const root = new ACrmCommands();

    const contactPayload = captureJson(() => {
      root.contact("contact-1", true);
    });
    const accountPayload = captureJson(() => {
      root.account("crm_acc_1", true);
    });
    const opportunityPayload = captureJson(() => {
      root.opportunity("crm_opp_1", true);
    });

    expect(((contactPayload.crm as Record<string, unknown>).profile as Record<string, unknown>).lifecycle).toBe("lead");
    expect(((accountPayload.crm as Record<string, unknown>).account as Record<string, unknown>).id).toBe("crm_acc_1");
    expect((opportunityPayload.opportunity as Record<string, unknown>).id).toBe("crm_opp_1");
  });

  it("keeps explicit show subcommands compatible", () => {
    const contactPayload = captureJson(() => {
      new CrmContactCommands().show("contact-1", true);
    });
    const accountPayload = captureJson(() => {
      new CrmAccountCommands().show("crm_acc_1", true);
    });
    const opportunityPayload = captureJson(() => {
      new CrmOpportunityCommands().show("crm_opp_1", true);
    });

    expect(((contactPayload.crm as Record<string, unknown>).profile as Record<string, unknown>).priority).toBe("high");
    expect(((accountPayload.crm as Record<string, unknown>).account as Record<string, unknown>).name).toBe("Acme");
    expect((opportunityPayload.opportunity as Record<string, unknown>).title).toBe("Pilot");
  });

  it("lists CRM pipelines, stages, and stage topics as JSON surfaces", () => {
    const pipelinePayload = captureJson(() => {
      new CrmPipelineCommands().list(undefined, undefined, true);
    });
    const stagePayload = captureJson(() => {
      new CrmPipelineStageCommands().list("crm_pipeline_default", undefined, true);
    });
    const topicPayload = captureJson(() => {
      new CrmPipelineStageCommands().topics("crm_pipeline_default", "qualified", undefined, true);
    });
    const boardPayload = captureJson(() => {
      new ACrmCommands().board(true, "crm_pipeline_default", true);
    });

    expect((pipelinePayload.pipelines as Array<Record<string, unknown>>)[0]?.id).toBe("crm_pipeline_default");
    expect((pipelinePayload.pagination as Record<string, unknown>).returned).toBe(1);
    expect((stagePayload.stages as Array<Record<string, unknown>>)[0]?.key).toBe("qualified");
    expect((stagePayload.pagination as Record<string, unknown>).returned).toBe(1);
    expect((topicPayload.topics as Array<Record<string, unknown>>)[0]?.key).toBe("budget");
    expect((topicPayload.pagination as Record<string, unknown>).returned).toBe(1);
    expect((boardPayload.stages as Array<Record<string, unknown>>)[0]).toMatchObject({
      stage: expect.objectContaining({ key: "qualified" }),
    });
  });

  it("passes CRM pipeline mutation inputs to service APIs", () => {
    silenceLogs(() => {
      new CrmPipelineCommands().create(
        "Reativacao",
        "opportunity",
        true,
        '{"source":"test"}',
        true,
        "idem-pipeline-cli",
      );
      new CrmPipelineCommands().set("crm_pipeline_default", "default", "false", true);
      new CrmPipelineStageCommands().add(
        "crm_pipeline_default",
        "reactivation",
        "Reactivation",
        "15",
        "active",
        "0.25",
        undefined,
        undefined,
        true,
        "idem-stage-cli",
      );
      new CrmPipelineStageCommands().set("crm_pipeline_default", "qualified", "probability", "0.4", true);
      new CrmPipelineStageTopicCommands().add(
        "crm_pipeline_default",
        "qualified",
        "budget",
        "Budget",
        "Confirm budget range",
        "qualification",
        "10",
        undefined,
        true,
        "idem-topic-cli",
      );
      new CrmPipelineStageTopicCommands().archive("crm_pipeline_default", "qualified", "budget", true);
    });

    expect(lastPipelineCreateInput).toMatchObject({
      name: "Reativacao",
      entityType: "opportunity",
      isDefault: true,
      metadata: { source: "test" },
      idempotencyKey: "idem-pipeline-cli",
    });
    expect(lastPipelineUpdateInput).toMatchObject({ pipelineRef: "crm_pipeline_default", isDefault: false });
    expect(lastPipelineStageCreateInput).toMatchObject({
      pipelineRef: "crm_pipeline_default",
      key: "reactivation",
      sortOrder: 15,
      probability: 0.25,
      idempotencyKey: "idem-stage-cli",
    });
    expect(lastPipelineStageUpdateInput).toMatchObject({ stageRef: "qualified", probability: 0.4 });
    expect(lastPipelineTopicCreateInput).toMatchObject({
      stageRef: "qualified",
      key: "budget",
      title: "Budget",
      topicType: "qualification",
      sortOrder: 10,
      idempotencyKey: "idem-topic-cli",
    });
    expect(lastPipelineTopicUpdateInput).toMatchObject({ topicRef: "budget", status: "archived" });
  });

  it("lists and links CRM opportunity contacts", () => {
    const contactsPayload = captureJson(() => {
      new CrmOpportunityCommands().contacts("crm_opp_1", true);
    });
    silenceLogs(() => {
      new CrmOpportunityCommands().linkContact("crm_opp_1", "contact-2", "champion", "crm_acc_1", true, true);
    });

    expect((contactsPayload.contacts as Array<Record<string, unknown>>)[0]?.contactId).toBe("contact-1");
    expect(lastOpportunityContactInput).toMatchObject({
      opportunityId: "crm_opp_1",
      contactRef: "contact-2",
      role: "champion",
      accountId: "crm_acc_1",
      isPrimary: true,
    });
  });

  it("lists, proposes, confirms, and rejects CRM facts", () => {
    factRecords.push({
      id: "crm_fact_2",
      entityType: "contact",
      entityId: "contact-1",
      key: "profile.priority",
      status: "proposed",
    });
    const factsPayload = captureJson(() => {
      new CrmFactCommands().list(
        undefined,
        undefined,
        "contact-1",
        undefined,
        undefined,
        "proposed",
        undefined,
        "1",
        "0",
        true,
      );
    });
    silenceLogs(() => {
      new CrmFactCommands().propose(
        "contact",
        "contact-1",
        "profile.role",
        '{"role":"buyer"}',
        "contact-1",
        undefined,
        undefined,
        "proposed",
        "0.7",
        "fact-idem",
        true,
      );
      new CrmFactCommands().confirm("crm_fact_1", true);
      new CrmFactCommands().reject("crm_fact_1", true);
    });

    expect((factsPayload.facts as Array<Record<string, unknown>>)[0]?.id).toBe("crm_fact_1");
    expect((factsPayload.pagination as Record<string, unknown>).nextCommand).toBe(
      "ravi crm fact list --json --limit 1 --offset 1 --contact contact-1 --status proposed",
    );
    expect(lastFactInput).toMatchObject({
      entityType: "contact",
      entityId: "contact-1",
      key: "profile.role",
      value: { role: "buyer" },
      confidence: 0.7,
      idempotencyKey: "fact-idem",
    });
  });

  it("passes normalized mutation inputs to CRM service APIs", () => {
    silenceLogs(() => {
      new CrmContactCommands().set("contact-1", "owner", "agent:dev", "test", true);
      new CrmAccountCommands().create("Acme", "org-1", "acme.example", "team:sales", true);
      new CrmOpportunityCommands().create(
        "Pilot",
        "crm_acc_1",
        "contact-1",
        "crm_pipeline_new",
        "qualified",
        "500000",
        "BRL",
        "agent:dev",
        true,
      );
      new CrmTaskCommands().create(
        "Follow up",
        "contact-1",
        "crm_acc_1",
        "crm_opp_1",
        "2026-05-09T10:00:00Z",
        "urgent",
        "agent:dev",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
    });

    expect(lastProfileUpdateInput).toMatchObject({ ownerType: "agent", ownerId: "dev", source: "test" });
    expect(lastAccountCreateInput).toMatchObject({ name: "Acme", ownerType: "team", ownerId: "sales" });
    expect(lastOpportunityCreateInput).toMatchObject({
      pipelineId: "crm_pipeline_new",
      stageKey: "qualified",
      valueCents: 500000,
      ownerType: "agent",
      ownerId: "dev",
    });
    expect(lastTaskCreateInput).toMatchObject({ priority: "urgent", ownerType: "agent", ownerId: "dev" });
  });

  it("fails CRM CLI commands on invalid input or missing CRM records", () => {
    expect(() => {
      new ACrmCommands().next(
        "agent",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
    }).toThrow(/--owner must use <type:id>/);

    crmContactProfile = null;

    expect(() => {
      new CrmContactCommands().show("missing-contact", true);
    }).toThrow(/Contact not found: missing-contact/);
  });

  it("keeps the legacy text error path for pipeline show without --json", () => {
    expect(() => {
      new CrmPipelineCommands().show("vendas");
    }).toThrow(/CRM pipeline not found: vendas/);
  });

  it("emits PIPELINE_NOT_FOUND envelope with suggestions on --json (exit 1)", () => {
    process.env.RAVI_AGENT_ID = "crm-contract-test";
    try {
      const { payload, error } = captureJsonError(() => {
        new CrmPipelineCommands().show("vendas", true);
      });
      expect(error).toBeInstanceOf(CrmContractError);
      const contractError = error as InstanceType<typeof CrmContractError>;
      expect(contractError.code).toBe("PIPELINE_NOT_FOUND");
      expect(contractError.exitCode).toBe(1);
      expect(payload.success).toBe(false);
      expect(payload.op).toBe("crm pipeline show");
      const errorPayload = payload.error as Record<string, unknown>;
      expect(errorPayload.code).toBe("PIPELINE_NOT_FOUND");
      expect(errorPayload.retryable).toBe(false);
      expect(errorPayload.suggestedAction).toBeTruthy();
      const suggestions = errorPayload.suggestions as string[];
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.length).toBeLessThanOrEqual(3);
      expect(suggestions).toContain("Default Sales Pipeline");
    } finally {
      delete process.env.RAVI_AGENT_ID;
    }
  });

  it("emits PIPELINE_REVIEW_FAILED when review finds high-severity gaps", () => {
    process.env.RAVI_AGENT_ID = "crm-contract-test";
    try {
      const { payload, error } = captureJsonError(() => {
        new CrmPipelineCommands().review("crm_pipeline_default", true);
      });
      expect(error).toBeInstanceOf(CrmContractError);
      const contractError = error as InstanceType<typeof CrmContractError>;
      expect(contractError.code).toBe("PIPELINE_REVIEW_FAILED");
      expect(contractError.exitCode).toBe(1);
      expect(payload.success).toBe(false);
      expect(payload.op).toBe("crm pipeline review");
      const errorPayload = payload.error as Record<string, unknown>;
      expect(errorPayload.code).toBe("PIPELINE_REVIEW_FAILED");
      expect(errorPayload.pipelineId).toBe("crm_pipeline_default");
      expect(Number(errorPayload.highSeverityGaps)).toBeGreaterThan(0);
      expect((errorPayload.gaps as Array<Record<string, unknown>>)[0]).not.toHaveProperty("detail");
    } finally {
      delete process.env.RAVI_AGENT_ID;
    }
  });

  it("emits PIPELINE_VALIDATION_FAILED when pipeline metadata is invalid", () => {
    process.env.RAVI_AGENT_ID = "crm-contract-test";
    const secretValue = "SENTINEL_SECRET_7M4Q";
    pipelineRecords[0] = { ...pipelineRecords[0], metadata: { priority_global: secretValue } };
    try {
      const { payload, error } = captureJsonError(() => {
        new CrmPipelineCommands().validate("crm_pipeline_default", true);
      });
      expect(error).toBeInstanceOf(CrmContractError);
      const contractError = error as InstanceType<typeof CrmContractError>;
      expect(contractError.code).toBe("PIPELINE_VALIDATION_FAILED");
      expect(contractError.exitCode).toBe(1);
      expect(payload.success).toBe(false);
      expect(payload.op).toBe("crm pipeline validate");
      const errorPayload = payload.error as Record<string, unknown>;
      expect(errorPayload.code).toBe("PIPELINE_VALIDATION_FAILED");
      expect(errorPayload.pipelineId).toBe("crm_pipeline_default");
      const errors = errorPayload.errors as Array<Record<string, unknown>>;
      expect(errors).toHaveLength(1);
      expect(errors[0]?.path).toBe("priority_global");
      expect(JSON.stringify(payload)).not.toContain(secretValue);
    } finally {
      delete process.env.RAVI_AGENT_ID;
    }
  });

  it("emits OPPORTUNITY_NOT_FOUND without broad suggestions on --json (exit 1)", () => {
    process.env.RAVI_AGENT_ID = "crm-contract-test";
    crmOpportunity = null;
    try {
      const { payload, error } = captureJsonError(() => {
        new CrmOpportunityCommands().show("crm_opp_missing", true);
      });
      expect(error).toBeInstanceOf(CrmContractError);
      const contractError = error as InstanceType<typeof CrmContractError>;
      expect(contractError.code).toBe("OPPORTUNITY_NOT_FOUND");
      expect(contractError.exitCode).toBe(1);
      const errorPayload = payload.error as Record<string, unknown>;
      expect(payload.success).toBe(false);
      expect(errorPayload.code).toBe("OPPORTUNITY_NOT_FOUND");
      expect(errorPayload).not.toHaveProperty("suggestions");
    } finally {
      delete process.env.RAVI_AGENT_ID;
    }
  });

  it("fails task mutations with CRM_TASK_NOT_FOUND before calling a mutator", () => {
    crmTask = null;

    expectTypedNotFound(
      () => new CrmTaskCommands().done("crm_task_missing", true),
      "crm task done",
      "CRM_TASK_NOT_FOUND",
    );
    expect(lastTaskMutationInput).toBeNull();

    expectTypedNotFound(
      () => new CrmTaskCommands().cancel("crm_task_missing", "duplicate", true),
      "crm task cancel",
      "CRM_TASK_NOT_FOUND",
    );
    expect(lastTaskMutationInput).toBeNull();

    expectTypedNotFound(
      () => new CrmTaskCommands().snooze("crm_task_missing", "2026-08-21T12:00:00Z", "later", true),
      "crm task snooze",
      "CRM_TASK_NOT_FOUND",
    );
    expect(lastTaskMutationInput).toBeNull();
  });

  it("does not reveal a task linked to a hidden contact during mutation preflight", () => {
    crmTask = { contactId: "contact-1" };
    scopeEnforced = true;
    readableContactIds = new Set<string>();

    expectTypedNotFound(() => new CrmTaskCommands().done("crm_task_1", true), "crm task done", "CRM_TASK_NOT_FOUND");
    expect(lastTaskMutationInput).toBeNull();
  });

  it("fails fact mutations with CRM_FACT_NOT_FOUND before calling a mutator", () => {
    factRecords = [];

    expectTypedNotFound(
      () => new CrmFactCommands().confirm("crm_fact_missing", true),
      "crm fact confirm",
      "CRM_FACT_NOT_FOUND",
    );
    expect(lastFactMutationInput).toBeNull();

    expectTypedNotFound(
      () => new CrmFactCommands().reject("crm_fact_missing", true),
      "crm fact reject",
      "CRM_FACT_NOT_FOUND",
    );
    expect(lastFactMutationInput).toBeNull();
  });

  it("fails opportunity move with OPPORTUNITY_NOT_FOUND before calling the mutator", () => {
    crmOpportunity = null;

    const payload = expectTypedNotFound(
      () => new CrmOpportunityCommands().move("crm_opp_missing", "qualified", undefined, true),
      "crm opportunity move",
      "OPPORTUNITY_NOT_FOUND",
    );
    expect(payload.error).not.toHaveProperty("suggestions");
    expect(lastOpportunityMoveInput).toBeNull();
  });

  it("preflights every target of contact set and link-contact mutations", () => {
    crmContactProfile = null;
    expectTypedNotFound(
      () => new CrmContactCommands().set("contact-missing", "priority", "high", undefined, true),
      "crm contact set",
      "CONTACT_NOT_FOUND",
    );
    expect(lastProfileUpdateInput).toBeNull();

    crmContactProfile = { contactId: "contact-1" };
    crmAccount = null;
    expectTypedNotFound(
      () => new CrmAccountCommands().linkContact("crm_acc_missing", "contact-1", undefined, undefined, true),
      "crm account link-contact",
      "CRM_ACCOUNT_NOT_FOUND",
    );
    expect(lastAccountContactInput).toBeNull();

    crmAccount = { lifecycle: "lead" };
    crmContactProfile = null;
    expectTypedNotFound(
      () => new CrmAccountCommands().linkContact("crm_acc_1", "contact-missing", undefined, undefined, true),
      "crm account link-contact",
      "CONTACT_NOT_FOUND",
    );
    expect(lastAccountContactInput).toBeNull();

    crmContactProfile = { contactId: "contact-1" };
    crmOpportunity = null;
    expectTypedNotFound(
      () =>
        new CrmOpportunityCommands().linkContact("crm_opp_missing", "contact-1", undefined, undefined, undefined, true),
      "crm opportunity link-contact",
      "OPPORTUNITY_NOT_FOUND",
    );
    expect(lastOpportunityContactInput).toBeNull();

    crmOpportunity = { valueCents: 500_000 };
    crmContactProfile = null;
    expectTypedNotFound(
      () =>
        new CrmOpportunityCommands().linkContact("crm_opp_1", "contact-missing", undefined, undefined, undefined, true),
      "crm opportunity link-contact",
      "CONTACT_NOT_FOUND",
    );
    expect(lastOpportunityContactInput).toBeNull();

    crmContactProfile = { contactId: "contact-1" };
    crmAccount = null;
    expectTypedNotFound(
      () =>
        new CrmOpportunityCommands().linkContact(
          "crm_opp_1",
          "contact-1",
          undefined,
          "crm_acc_missing",
          undefined,
          true,
        ),
      "crm opportunity link-contact",
      "CRM_ACCOUNT_NOT_FOUND",
    );
    expect(lastOpportunityContactInput).toBeNull();
  });

  it("creates an opportunity immediately without --execute", () => {
    process.env.RAVI_AGENT_ID = "crm-contract-test";
    try {
      const payload = captureJson(() => {
        new CrmOpportunityCommands().create(
          "Pilot",
          "crm_acc_1",
          "contact-1",
          "crm_pipeline_default",
          "qualified",
          "500000",
          "BRL",
          "agent:dev",
          true,
        );
      });
      expect(payload.status).toBe("created");
      expect(lastOpportunityCreateInput).toMatchObject({ title: "Pilot", stageKey: "qualified" });
    } finally {
      delete process.env.RAVI_AGENT_ID;
    }
  });

  it("creates a pipeline immediately without --execute", () => {
    process.env.RAVI_AGENT_ID = "crm-contract-test";
    try {
      const payload = captureJson(() => {
        new CrmPipelineCommands().create("Reativacao", "opportunity", true, undefined, true);
      });
      expect(payload.status).toBe("created");
      expect(lastPipelineCreateInput).toMatchObject({ name: "Reativacao", isDefault: true });
    } finally {
      delete process.env.RAVI_AGENT_ID;
    }
  });

  it("moves an opportunity immediately without --execute", () => {
    process.env.RAVI_AGENT_ID = "crm-contract-test";
    try {
      const payload = captureJson(() => {
        new CrmOpportunityCommands().move("crm_opp_1", "won", undefined, true);
      });
      expect(payload.status).toBe("moved");
      expect(lastOpportunityMoveInput).toMatchObject({ opportunityId: "crm_opp_1", stageRef: "won" });
    } finally {
      delete process.env.RAVI_AGENT_ID;
    }
  });

  it("exits 2 with acceptedFlags on invalid --value (USAGE_ERROR)", () => {
    process.env.RAVI_AGENT_ID = "crm-contract-test";
    try {
      const { payload, error } = captureJsonError(() => {
        new CrmOpportunityCommands().create(
          "Pilot",
          undefined,
          undefined,
          undefined,
          undefined,
          "abc",
          undefined,
          undefined,
          true,
        );
      });
      expect(error).toBeInstanceOf(CrmContractError);
      const contractError = error as InstanceType<typeof CrmContractError>;
      expect(contractError.code).toBe("USAGE_ERROR");
      expect(contractError.exitCode).toBe(2);
      const errorPayload = payload.error as Record<string, unknown>;
      expect(errorPayload.code).toBe("USAGE_ERROR");
      expect(errorPayload.acceptedFlags).toContain("--value");
      expect(errorPayload.acceptedFlags).not.toContain("--execute");
      expect(lastOpportunityCreateInput).toBeNull();
    } finally {
      delete process.env.RAVI_AGENT_ID;
    }
  });

  it("exits 2 with the usage envelope on an unknown crm flag", () => {
    process.env.RAVI_AGENT_ID = "crm-contract-test";
    try {
      const program = buildCrmProgram();
      const { payload, error } = captureJsonError(() => {
        program.parse(["crm", "board", "--flag-inexistente", "--json"], { from: "user" });
      });
      expect(error).toBeInstanceOf(CrmContractError);
      const contractError = error as InstanceType<typeof CrmContractError>;
      expect(contractError.code).toBe("USAGE_ERROR");
      expect(contractError.exitCode).toBe(2);
      expect(payload.success).toBe(false);
      expect(payload.op).toBe("crm board");
      const errorPayload = payload.error as Record<string, unknown>;
      expect(errorPayload.code).toBe("USAGE_ERROR");
      expect(errorPayload.message).toContain("unknown option '--flag-inexistente'");
      expect(errorPayload.retryable).toBe(false);
      expect(errorPayload.suggestedAction).toContain("ravi crm board");
      expect(errorPayload.usage).toBe("ravi crm board [options]");
      expect(errorPayload.acceptedFlags).toContain("--json");
      expect(errorPayload.acceptedFlags).toContain("--fields");
    } finally {
      delete process.env.RAVI_AGENT_ID;
    }
  });

  it("exits 2 with the usage envelope on a missing required crm argument", () => {
    process.env.RAVI_AGENT_ID = "crm-contract-test";
    try {
      const program = buildCrmProgram();
      const { payload, error } = captureJsonError(() => {
        program.parse(["crm", "opportunity", "show", "--json"], { from: "user" });
      });
      expect(error).toBeInstanceOf(CrmContractError);
      const contractError = error as InstanceType<typeof CrmContractError>;
      expect(contractError.code).toBe("USAGE_ERROR");
      expect(contractError.exitCode).toBe(2);
      expect(payload.success).toBe(false);
      expect(payload.op).toBe("crm opportunity show");
      const errorPayload = payload.error as Record<string, unknown>;
      expect(errorPayload.message).toContain("missing required argument 'opportunity'");
      expect(errorPayload.retryable).toBe(false);
      expect(errorPayload.usage).toBe("ravi crm opportunity show [options] <opportunity>");
      expect(errorPayload.acceptedFlags).toContain("--json");
      expect(errorPayload.acceptedPositionals).toEqual(["<opportunity>"]);
    } finally {
      delete process.env.RAVI_AGENT_ID;
    }
  });

  it("teaches the correct syntax on usage errors without --json", () => {
    process.env.RAVI_AGENT_ID = "crm-contract-test";
    const originalError = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const program = buildCrmProgram();
      expect(() => {
        program.parse(["crm", "opportunity", "show"], { from: "user" });
      }).toThrow(/missing required argument 'opportunity'/);
      const output = lines.join("\n");
      expect(output).toContain("usage: ravi crm opportunity show [options] <opportunity>");
      expect(output).toContain("accepted flags: --json");
    } finally {
      console.error = originalError;
      delete process.env.RAVI_AGENT_ID;
    }
  });

  it("supports --fields compact mode on listings", () => {
    const pipelinePayload = captureJson(() => {
      new CrmPipelineCommands().list(undefined, undefined, true, undefined, undefined, "id,name");
    });
    const pipeline = (pipelinePayload.pipelines as Array<Record<string, unknown>>)[0];
    expect(Object.keys(pipeline).sort()).toEqual(["id", "name"]);
    expect(pipeline.id).toBe("crm_pipeline_default");

    const boardPayload = captureJson(() => {
      new ACrmCommands().board(true, undefined, undefined, "opportunityId,title");
    });
    const boardOpportunity = (boardPayload.opportunities as Array<Record<string, unknown>>)[0];
    expect(Object.keys(boardOpportunity).sort()).toEqual(["opportunityId", "title"]);
  });

  it("rejects an invalid task status before querying the store", () => {
    const { payload, error } = captureJsonError(() => {
      new CrmTaskCommands().list(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "bogus",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
    });
    expect(error).toBeInstanceOf(CrmContractError);
    expect((error as InstanceType<typeof CrmContractError>).code).toBe("USAGE_ERROR");
    expect((payload.error as Record<string, unknown>).acceptedValues).toEqual([
      "open",
      "scheduled",
      "waiting",
      "done",
      "canceled",
      "snoozed",
    ]);
  });

  it("rejects an invalid date filter before querying next actions", () => {
    const { payload, error } = captureJsonError(() => {
      new ACrmCommands().next(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "not-a-date",
        undefined,
        undefined,
        true,
      );
    });
    expect(error).toBeInstanceOf(CrmContractError);
    expect((error as InstanceType<typeof CrmContractError>).code).toBe("USAGE_ERROR");
    expect((payload.error as Record<string, unknown>).parameter).toBe("--due-after");
  });

  it("rejects invalid list ranges and enum filters with usage errors", () => {
    const cases = [
      () => new ACrmCommands().contacts(undefined, undefined, "0", undefined, true),
      () => new ACrmCommands().board(true, undefined, undefined, undefined, "501", "0"),
      () => new CrmPipelineCommands().list("bogus", undefined, true),
      () => new CrmPipelineStageCommands().list("crm_pipeline_default", undefined, true, "abc", "0"),
      () => new CrmPipelineStageCommands().topics("crm_pipeline_default", "qualified", undefined, true, "1", "-1"),
      () => new ACrmCommands().contacts(undefined, "bot:sales", undefined, undefined, true),
    ];
    for (const run of cases) {
      const { error } = captureJsonError(run);
      expect(error).toBeInstanceOf(CrmContractError);
      expect((error as InstanceType<typeof CrmContractError>).code).toBe("USAGE_ERROR");
      expect((error as InstanceType<typeof CrmContractError>).exitCode).toBe(2);
    }
  });

  it("returns a typed error before a mutation targets a missing opportunity", () => {
    crmOpportunity = null;
    const { payload, error } = captureJsonError(() => {
      new CrmOpportunityCommands().move("crm_opp_missing", "won", undefined, true);
    });
    expect(error).toBeInstanceOf(CrmContractError);
    expect((error as InstanceType<typeof CrmContractError>).code).toBe("OPPORTUNITY_NOT_FOUND");
    expect(payload.error).not.toHaveProperty("suggestions");
    expect((payload.error as Record<string, unknown>).suggestedAction).toBe(
      "Check visible opportunities with: ravi crm board --json",
    );
  });

  it("paginates the opportunity board while preserving its legacy opportunities alias", () => {
    opportunityBoardRecords = [
      { opportunityId: "crm_opp_1", title: "First", pipelineId: "crm_pipeline_default", stageKey: "qualified" },
      { opportunityId: "crm_opp_2", title: "Second", pipelineId: "crm_pipeline_default", stageKey: "qualified" },
    ];
    const payload = captureJson(() => {
      new ACrmCommands().board(true, "crm_pipeline_default", true, undefined, "1", "0");
    });
    expect(payload.total).toBe(2);
    expect((payload.pagination as Record<string, unknown>).returned).toBe(1);
    expect(payload.items as Array<Record<string, unknown>>).toHaveLength(1);
    expect(payload.opportunities).toEqual(payload.items);
    expect((payload.stages as Array<Record<string, unknown>>)[0]?.opportunities as unknown[]).toHaveLength(1);
  });

  it("returns a usage envelope when pipeline validation has no target", () => {
    const { payload, error } = captureJsonError(() => {
      new CrmPipelineCommands().validate(undefined, true, false);
    });
    expect(error).toBeInstanceOf(CrmContractError);
    expect((error as InstanceType<typeof CrmContractError>).code).toBe("USAGE_ERROR");
    expect((payload.error as Record<string, unknown>).acceptedPositionals).toEqual(["<pipeline>"]);
  });

  it("publishes CRM lifecycle states for agent discovery", () => {
    const payload = captureJson(() => new CrmLifecycleCommands().show(true));
    expect(payload.enforcement).toBe("facade-only");
    expect(payload.legacyCommandsMayDiffer).toBe(true);
    expect((payload.task as Record<string, unknown>).states).toContain("done");
    expect((payload.fact as Record<string, unknown>).operations).toMatchObject({ confirm: expect.any(String) });
  });

  it("offers a machine-readable CRM discovery overview", () => {
    const payload = captureJson(() => new ACrmCommands().help(true));
    expect(payload.domain).toBe("crm");
    expect(payload.kind).toBe("quick-start");
    expect(payload.scope).toBe("curated-entry-points");
    expect(payload.commands as Array<Record<string, unknown>>).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "facade plan", mutates: true })]),
    );
  });

  it("does not reveal a hidden CRM target through facade planning", () => {
    scopeEnforced = true;
    crmTask = { contactId: "contact-hidden" };
    const { payload, error } = captureJsonError(() => {
      new CrmFacadeCommands().plan(
        "task.done",
        "crm_task_hidden",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
    });
    expect(error).toBeInstanceOf(CrmContractError);
    expect((error as InstanceType<typeof CrmContractError>).code).toBe("CRM_TASK_NOT_FOUND");
    expect(JSON.stringify(payload)).not.toContain("Follow up");
  });

  it("fails closed for uppercase primary-account before persisting a plan", () => {
    scopeEnforced = true;
    readableContactIds = new Set(["contact-1"]);
    crmAccount = { id: "crm_acc_hidden", lifecycle: "lead" };
    accountContactIds = ["contact-hidden"];

    const { payload, error } = captureJsonError(() =>
      planFacade({
        operation: "contact.set",
        target: "contact-1",
        field: "PRIMARY-ACCOUNT",
        value: "crm_acc_hidden",
      }),
    );

    expect(error).toBeInstanceOf(CrmContractError);
    expect((error as InstanceType<typeof CrmContractError>).code).toBe("CRM_ACCOUNT_NOT_FOUND");
    expect(payload).toMatchObject({ success: false, op: "crm facade plan" });
    expect(facadePlans.size).toBe(0);
  });

  it("fails closed for spaced primary-account before persisting a plan", () => {
    scopeEnforced = true;
    readableContactIds = new Set(["contact-1"]);
    crmAccount = { id: "crm_acc_hidden", lifecycle: "lead" };
    accountContactIds = ["contact-hidden"];

    const { payload, error } = captureJsonError(() =>
      planFacade({
        operation: "contact.set",
        target: "contact-1",
        field: " primary-account ",
        value: "crm_acc_hidden",
      }),
    );

    expect(error).toBeInstanceOf(CrmContractError);
    expect((error as InstanceType<typeof CrmContractError>).code).toBe("CRM_ACCOUNT_NOT_FOUND");
    expect(payload).toMatchObject({ success: false, op: "crm facade plan" });
    expect(facadePlans.size).toBe(0);
  });

  it("fails closed for uppercase primary-opportunity before persisting a plan", () => {
    scopeEnforced = true;
    readableContactIds = new Set(["contact-1"]);
    crmOpportunity = { id: "crm_opp_hidden", valueCents: 500_000 };
    opportunityContactRecords = [{ opportunityId: "crm_opp_hidden", contactId: "contact-hidden", role: "observer" }];

    const { payload, error } = captureJsonError(() =>
      planFacade({
        operation: "contact.set",
        target: "contact-1",
        field: "PRIMARY-OPPORTUNITY",
        value: "crm_opp_hidden",
      }),
    );

    expect(error).toBeInstanceOf(CrmContractError);
    expect((error as InstanceType<typeof CrmContractError>).code).toBe("OPPORTUNITY_NOT_FOUND");
    expect(payload).toMatchObject({ success: false, op: "crm facade plan" });
    expect(facadePlans.size).toBe(0);
  });

  it("fails closed for spaced primary-opportunity before persisting a plan", () => {
    scopeEnforced = true;
    readableContactIds = new Set(["contact-1"]);
    crmOpportunity = { id: "crm_opp_hidden", valueCents: 500_000 };
    opportunityContactRecords = [{ opportunityId: "crm_opp_hidden", contactId: "contact-hidden", role: "observer" }];

    const { payload, error } = captureJsonError(() =>
      planFacade({
        operation: "contact.set",
        target: "contact-1",
        field: " primary-opportunity ",
        value: "crm_opp_hidden",
      }),
    );

    expect(error).toBeInstanceOf(CrmContractError);
    expect((error as InstanceType<typeof CrmContractError>).code).toBe("OPPORTUNITY_NOT_FOUND");
    expect(payload).toMatchObject({ success: false, op: "crm facade plan" });
    expect(facadePlans.size).toBe(0);
  });

  for (const clearValue of ["-", "null", "NULL", " null "]) {
    it(`treats '${clearValue}' as a clear value without relational lookup`, () => {
      scopeEnforced = true;
      readableContactIds = new Set(["contact-1"]);
      crmAccount = { id: "crm_acc_hidden", lifecycle: "lead" };
      accountContactIds = ["contact-hidden"];

      const plan = captureJson(() =>
        planFacade({
          operation: "contact.set",
          target: "contact-1",
          field: " PRIMARY-ACCOUNT ",
          value: clearValue,
        }),
      ) as unknown as CrmFacadePlan;

      expect(plan.arguments).toMatchObject({ field: "primary-account", value: null });
      expect(facadePlans.size).toBe(1);
    });
  }

  it("blocks a persisted hidden relationship plan in verify, recover, approve, and apply", async () => {
    scopeEnforced = true;
    readableContactIds = new Set(["contact-1"]);
    crmAccount = { id: "crm_acc_hidden", lifecycle: "lead" };
    accountContactIds = ["contact-hidden"];

    const plan = buildCrmFacadePlan({
      operation: "contact.set",
      target: "contact-1",
      field: "primary-account",
      value: "crm_acc_hidden",
    });
    persistCrmFacadePlan(plan);

    const verify = captureJsonError(() => new CrmFacadeCommands().verify(plan.planId, true));
    expect(verify.error).toBeInstanceOf(CrmContractError);
    expect((verify.error as InstanceType<typeof CrmContractError>).code).toBe("CRM_ACCOUNT_NOT_FOUND");

    const recover = captureJsonError(() => new CrmFacadeCommands().recover(plan.planId, true));
    expect(recover.error).toBeInstanceOf(CrmContractError);
    expect((recover.error as InstanceType<typeof CrmContractError>).code).toBe("CRM_ACCOUNT_NOT_FOUND");

    const approve = await captureJsonErrorAsync(() => new CrmFacadeCommands().approve(plan.planId, true));
    expect(approve.error).toBeInstanceOf(CrmContractError);
    expect((approve.error as InstanceType<typeof CrmContractError>).code).toBe("CRM_ACCOUNT_NOT_FOUND");

    const apply = captureJsonError(() => new CrmFacadeCommands().apply(plan.planId, true));
    expect(apply.error).toBeInstanceOf(CrmContractError);
    expect((apply.error as InstanceType<typeof CrmContractError>).code).toBe("CRM_ACCOUNT_NOT_FOUND");
  });

  const hiddenFacadeCases: Array<{
    input: CrmFacadePlanInput;
    code: string;
    prepare: () => void;
  }> = [
    ...(["task.done", "task.cancel", "task.snooze"] as const).map((operation) => ({
      input: {
        operation,
        target: "crm_task_hidden",
        ...(operation === "task.snooze" ? { until: "2030-01-01T10:00:00Z" } : {}),
      } as CrmFacadePlanInput,
      code: "CRM_TASK_NOT_FOUND",
      prepare: () => {
        crmTask = { contactId: "contact-hidden" };
      },
    })),
    ...(["opportunity.move", "opportunity.link-contact"] as const).map((operation) => ({
      input: {
        operation,
        target: "crm_opp_hidden",
        ...(operation === "opportunity.move" ? { stage: "qualified" } : { contact: "contact-visible" }),
      } as CrmFacadePlanInput,
      code: "OPPORTUNITY_NOT_FOUND",
      prepare: () => {
        opportunityContactRecords = [{ opportunityId: "crm_opp_hidden", contactId: "contact-hidden" }];
      },
    })),
    ...(["fact.confirm", "fact.reject"] as const).map((operation) => ({
      input: { operation, target: "crm_fact_hidden" },
      code: "CRM_FACT_NOT_FOUND",
      prepare: () => {
        factRecords = [
          {
            id: "crm_fact_hidden",
            entityType: "contact",
            entityId: "contact-hidden",
            key: "budget",
            status: "proposed",
          },
        ];
      },
    })),
    {
      input: { operation: "contact.set", target: "contact-hidden", field: "priority", value: "high" },
      code: "CONTACT_NOT_FOUND",
      prepare: () => {},
    },
    {
      input: {
        operation: "account.link-contact",
        target: "crm_acc_hidden",
        contact: "contact-visible",
      },
      code: "CRM_ACCOUNT_NOT_FOUND",
      prepare: () => {
        accountContactIds = ["contact-hidden"];
      },
    },
  ];

  for (const scenario of hiddenFacadeCases) {
    it(`${scenario.input.operation} fails closed for a hidden target`, () => {
      scopeEnforced = true;
      readableContactIds = new Set(["contact-visible"]);
      scenario.prepare();

      const { payload, error } = captureJsonError(() => planFacade(scenario.input));

      expect(error).toBeInstanceOf(CrmContractError);
      expect((error as InstanceType<typeof CrmContractError>).code).toBe(scenario.code);
      const serialized = JSON.stringify(payload);
      if (scenario.input.operation === "contact.set") {
        expect(serialized).not.toContain("Alice");
        expect(serialized).not.toContain("relationshipHealth");
      } else {
        expect(serialized).not.toContain("contact-hidden");
      }
    });
  }

  it("hides accounts linked to any unreadable contact before facade resolution", () => {
    scopeEnforced = true;
    accountContactIds = ["contact-visible", "contact-hidden"];
    readableContactIds = new Set(["contact-visible"]);

    const { payload, error } = captureJsonError(() => {
      new CrmFacadeCommands().plan(
        "account.link-contact",
        "crm_acc_1",
        undefined,
        "contact-visible",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
    });

    expect(error).toBeInstanceOf(CrmContractError);
    expect((error as InstanceType<typeof CrmContractError>).code).toBe("CRM_ACCOUNT_NOT_FOUND");
    expect(JSON.stringify(payload)).not.toContain("contact-hidden");
  });

  it("hides opportunities when a secondary linked contact is unreadable", () => {
    scopeEnforced = true;
    readableContactIds = new Set(["contact-visible"]);
    opportunityContactRecords = [
      { opportunityId: "crm_opp_1", contactId: "contact-visible", role: "stakeholder" },
      { opportunityId: "crm_opp_1", contactId: "contact-hidden", role: "observer" },
    ];

    const { payload, error } = captureJsonError(() => {
      new CrmFacadeCommands().plan(
        "opportunity.move",
        "crm_opp_1",
        "qualified",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
    });

    expect(error).toBeInstanceOf(CrmContractError);
    expect((error as InstanceType<typeof CrmContractError>).code).toBe("OPPORTUNITY_NOT_FOUND");
    expect(JSON.stringify(payload)).not.toContain("contact-hidden");
  });

  it("shows the complete canonical change in every facade approval prompt", () => {
    const cases: Array<{
      operation: CrmFacadePlan["operation"];
      arguments: Record<string, unknown>;
    }> = [
      { operation: "task.done", arguments: { target: "crm_task_1" } },
      { operation: "task.cancel", arguments: { target: "crm_task_1", reason: "duplicate" } },
      {
        operation: "task.snooze",
        arguments: { target: "crm_task_1", until: "2026-08-21T12:00:00.000Z" },
      },
      { operation: "opportunity.move", arguments: { target: "crm_opp_1", stage: "crm_stage_won" } },
      { operation: "fact.confirm", arguments: { target: "crm_fact_1" } },
      { operation: "fact.reject", arguments: { target: "crm_fact_1", reason: "unsupported" } },
      {
        operation: "contact.set",
        arguments: { target: "contact-1", field: "priority", value: "high" },
      },
      {
        operation: "account.link-contact",
        arguments: { target: "crm_acc_1", contact: "contact-1", role: "buyer", primary: true },
      },
      {
        operation: "opportunity.link-contact",
        arguments: {
          target: "crm_opp_1",
          contact: "contact-1",
          account: "crm_acc_1",
          role: "decision-maker",
          primary: false,
        },
      },
    ];

    for (const entry of cases) {
      const plan: CrmFacadePlan = {
        schemaVersion: "crm.agent-first/v1",
        planId: `plan-${entry.operation}`,
        planHash: `hash-${entry.operation}`,
        state: "planned",
        operation: entry.operation,
        target: { type: "record", id: "target-1", label: "Visible target" },
        arguments: entry.arguments,
        effects: [{ effectId: "effect-1", operation: entry.operation, primary: true, retry: "never" }],
        approval: null,
        createdAt: "2026-08-20T12:00:00.000Z",
        expiresAt: "2026-08-20T12:15:00.000Z",
      };

      const text = formatCrmFacadeApprovalText(plan);
      const argumentsLine = text.split("\n").find((line) => line.startsWith("Arguments: "));
      const targetLine = text.split("\n").find((line) => line.startsWith("Target: "));

      expect(text).toContain(`Plan ID: ${plan.planId}`);
      expect(text).toContain(`Plan hash: ${plan.planHash}`);
      expect(text).toContain(`Operation: ${plan.operation}`);
      expect(text).toContain(`Expires at: ${plan.expiresAt}`);
      expect(JSON.parse(argumentsLine!.slice("Arguments: ".length))).toEqual(entry.arguments);
      expect(JSON.parse(targetLine!.slice("Target: ".length))).toEqual(plan.target);
    }
  });
});
