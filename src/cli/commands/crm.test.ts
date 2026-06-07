import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

const actualCliContextModule = await import("../context.js");
const actualContactsModule = await import("../../contacts.js");

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
let lastAccountCreateInput: Record<string, unknown> | null = null;
let lastOpportunityCreateInput: Record<string, unknown> | null = null;
let lastTaskCreateInput: Record<string, unknown> | null = null;
let lastProfileUpdateInput: Record<string, unknown> | null = null;
let lastOpportunityContactInput: Record<string, unknown> | null = null;
let lastFactInput: Record<string, unknown> | null = null;
let lastPipelineCreateInput: Record<string, unknown> | null = null;
let lastPipelineUpdateInput: Record<string, unknown> | null = null;
let lastPipelineStageCreateInput: Record<string, unknown> | null = null;
let lastPipelineStageUpdateInput: Record<string, unknown> | null = null;
let lastPipelineTopicCreateInput: Record<string, unknown> | null = null;
let lastPipelineTopicUpdateInput: Record<string, unknown> | null = null;

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

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  fail: (message: string) => {
    throw new Error(message);
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
  listCrmNextActions: (options: { limit?: string; offset?: string }) => pageRecords(nextActionRecords, options),
  listCrmContactCards: (options: { limit?: string; offset?: string }) => pageRecords(contactCardRecords, options),
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
  createCrmAccount: (input: Record<string, unknown>) => {
    lastAccountCreateInput = input;
    return { id: "crm_acc_1", name: input.name, domain: input.domain ?? null };
  },
  linkCrmAccountContact: (input: Record<string, unknown>) => ({
    id: "crm_ac_1",
    accountId: input.accountId,
    contactId: input.contactRef,
    role: input.role ?? "member",
    isPrimary: input.isPrimary === true,
  }),
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
  createCrmOpportunity: (input: Record<string, unknown>) => {
    lastOpportunityCreateInput = input;
    return { id: "crm_opp_1", title: input.title, accountId: input.accountId ?? null };
  },
  moveCrmOpportunityStage: (input: Record<string, unknown>) => ({
    id: input.opportunityId,
    title: "Pilot",
    status: "open",
    stageId: input.stageRef,
  }),
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
  listCrmFacts: (options: { limit?: string; offset?: string }) => pageRecords(factRecords, options),
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
  confirmCrmFact: (input: Record<string, unknown>) => ({
    id: input.factId,
    key: "profile.role",
    status: "confirmed",
  }),
  rejectCrmFact: (input: Record<string, unknown>) => ({
    id: input.factId,
    key: "profile.role",
    status: "rejected",
  }),
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
  listCrmTasks: (options: { limit?: string; offset?: string }) => pageRecords(taskRecords, options),
  createCrmTask: (input: Record<string, unknown>) => {
    lastTaskCreateInput = input;
    return { id: "crm_task_1", title: input.title, contactId: input.contactRef ?? null };
  },
  completeCrmTask: (input: Record<string, unknown>) => ({
    id: input.taskId,
    title: "Follow up",
    status: "done",
  }),
  updateCrmContactProfile: (input: Record<string, unknown>) => {
    lastProfileUpdateInput = input;
    return {
      contactId: input.contactRef,
      lifecycle: input.lifecycle ?? "unknown",
      relationshipHealth: input.relationshipHealth ?? "unknown",
      priority: input.priority ?? "normal",
    };
  },
}));

const {
  ACrmCommands,
  CrmAccountCommands,
  CrmContactCommands,
  CrmFactCommands,
  CrmOpportunityCommands,
  CrmPipelineCommands,
  CrmPipelineStageCommands,
  CrmPipelineStageTopicCommands,
  CrmTaskCommands,
} = await import("./crm.js");

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

function silenceLogs(run: () => unknown): void {
  const original = console.log;
  console.log = () => {};
  try {
    run();
  } finally {
    console.log = original;
  }
}

describe("CRM commands", () => {
  beforeEach(() => {
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
    lastOpportunityCreateInput = null;
    lastTaskCreateInput = null;
    lastProfileUpdateInput = null;
    lastOpportunityContactInput = null;
    lastFactInput = null;
    lastPipelineCreateInput = null;
    lastPipelineUpdateInput = null;
    lastPipelineStageCreateInput = null;
    lastPipelineStageUpdateInput = null;
    lastPipelineTopicCreateInput = null;
    lastPipelineTopicUpdateInput = null;
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
        undefined,
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
    expect(lastOpportunityCreateInput).toMatchObject({ valueCents: 500000, ownerType: "agent", ownerId: "dev" });
    expect(lastTaskCreateInput).toMatchObject({ priority: "urgent", ownerType: "agent", ownerId: "dev" });
  });

  it("forwards --pipeline to the CRM opportunity service", () => {
    silenceLogs(() => {
      new CrmOpportunityCommands().create(
        "Smoke",
        "crm_acc_1",
        "contact-1",
        "sde-novo-contato",
        "1-primeiro-contato",
        undefined,
        undefined,
        undefined,
        true,
      );
    });

    expect(lastOpportunityCreateInput).toMatchObject({
      pipelineId: "sde-novo-contato",
      stageKey: "1-primeiro-contato",
    });
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
});
