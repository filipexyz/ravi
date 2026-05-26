import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

const actualCliContextModule = await import("../context.js");
const actualContactsModule = await import("../../contacts.js");

let crmContactProfile: Record<string, unknown> | null = null;
let crmAccount: Record<string, unknown> | null = null;
let crmOpportunity: Record<string, unknown> | null = null;
let crmTask: Record<string, unknown> | null = null;
let nextActionRecords: Array<Record<string, unknown>> = [];
let contactCardRecords: Array<Record<string, unknown>> = [];
let opportunityBoardRecords: Array<Record<string, unknown>> = [];
let opportunityContactRecords: Array<Record<string, unknown>> = [];
let factRecords: Array<Record<string, unknown>> = [];
let lastAccountCreateInput: Record<string, unknown> | null = null;
let lastOpportunityCreateInput: Record<string, unknown> | null = null;
let lastTaskCreateInput: Record<string, unknown> | null = null;
let lastProfileUpdateInput: Record<string, unknown> | null = null;
let lastOpportunityContactInput: Record<string, unknown> | null = null;
let lastFactInput: Record<string, unknown> | null = null;

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
  listCrmOpportunityBoard: () => opportunityBoardRecords,
  listCrmOpportunityContacts: () => opportunityContactRecords,
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
    if (input.pipelineRef === "archived-pipeline") throw new Error("CRM pipeline is archived: archived-pipeline");
    if (input.pipelineRef === "ambiguous-pipeline")
      throw new Error("Ambiguous pipeline name: ambiguous-pipeline — use pipeline ID to disambiguate");
    if (input.pipelineRef === "sde-cobranca" && input.stageKey === "stage-other-pipeline")
      throw new Error("Stage stage-other-pipeline does not belong to pipeline sde-cobranca");
    return {
      id: "crm_opp_1",
      title: input.title,
      accountId: input.accountId ?? null,
      pipelineRef: input.pipelineRef ?? null,
    };
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
    opportunityBoardRecords = [{ opportunityId: "crm_opp_1", title: "Pilot", stageKey: "qualified" }];
    opportunityContactRecords = [{ opportunityId: "crm_opp_1", contactId: "contact-1", role: "stakeholder" }];
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
  });

  it("lists CRM next actions as a paginated JSON surface", () => {
    const payload = captureJson(() => {
      new ACrmCommands().next("agent:dev", undefined, undefined, undefined, "10", "0", true);
    });

    expect(payload.total).toBe(1);
    expect((payload.pagination as Record<string, unknown>).returned).toBe(1);
    expect((payload.items as Array<Record<string, unknown>>)[0]?.taskId).toBe("crm_task_1");
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
        true,
      );
    });

    expect(lastProfileUpdateInput).toMatchObject({ ownerType: "agent", ownerId: "dev", source: "test" });
    expect(lastAccountCreateInput).toMatchObject({ name: "Acme", ownerType: "team", ownerId: "sales" });
    expect(lastOpportunityCreateInput).toMatchObject({ valueCents: 500000, ownerType: "agent", ownerId: "dev" });
    expect(lastTaskCreateInput).toMatchObject({ priority: "urgent", ownerType: "agent", ownerId: "dev" });
  });

  it("fails CRM CLI commands on invalid input or missing CRM records", () => {
    expect(() => {
      new ACrmCommands().next("agent", undefined, undefined, undefined, undefined, undefined, true);
    }).toThrow(/--owner must use <type:id>/);

    crmContactProfile = null;

    expect(() => {
      new CrmContactCommands().show("missing-contact", true);
    }).toThrow(/Contact not found: missing-contact/);
  });

  // AC1: --pipeline without --stage uses pipeline's first stage
  it("AC1: --pipeline sde-cobranca without --stage passes pipelineRef to service", () => {
    silenceLogs(() => {
      new CrmOpportunityCommands().create(
        "X",
        undefined,
        "contact-1",
        undefined,
        "100000",
        undefined,
        undefined,
        true,
        undefined,
        "sde-cobranca",
      );
    });
    expect(lastOpportunityCreateInput).toMatchObject({ pipelineRef: "sde-cobranca", stageKey: undefined });
  });

  // AC2: --pipeline + --stage both forwarded to service
  it("AC2: --pipeline sde-cobranca --stage 1-a-contactar passes both to service", () => {
    silenceLogs(() => {
      new CrmOpportunityCommands().create(
        "X",
        undefined,
        "contact-1",
        "1-a-contactar",
        "100000",
        undefined,
        undefined,
        true,
        undefined,
        "sde-cobranca",
      );
    });
    expect(lastOpportunityCreateInput).toMatchObject({ pipelineRef: "sde-cobranca", stageKey: "1-a-contactar" });
  });

  // AC3: --stage without --pipeline preserves backward compat (no pipelineRef)
  it("AC3: --stage without --pipeline sends no pipelineRef (backward compat)", () => {
    silenceLogs(() => {
      new CrmOpportunityCommands().create(
        "X",
        undefined,
        "contact-1",
        "1-a-contactar",
        "100000",
        undefined,
        undefined,
        true,
      );
    });
    expect(lastOpportunityCreateInput).toMatchObject({ stageKey: "1-a-contactar" });
    expect(lastOpportunityCreateInput?.pipelineRef).toBeUndefined();
  });

  // AC4: no --pipeline no --stage still works (backward compat)
  it("AC4: no --pipeline no --stage creates on default pipeline (backward compat)", () => {
    silenceLogs(() => {
      new CrmOpportunityCommands().create("X", undefined, "contact-1", undefined, "100000", undefined, undefined, true);
    });
    expect(lastOpportunityCreateInput?.pipelineRef).toBeUndefined();
    expect(lastOpportunityCreateInput?.stageKey).toBeUndefined();
  });

  // AC5: archived pipeline rejected by service
  it("AC5: --pipeline archived-pipeline throws archived error", () => {
    expect(() => {
      new CrmOpportunityCommands().create(
        "X",
        undefined,
        "contact-1",
        undefined,
        "100000",
        undefined,
        undefined,
        true,
        undefined,
        "archived-pipeline",
      );
    }).toThrow(/CRM pipeline is archived/);
  });

  // AC6: stage from wrong pipeline rejected by service
  it("AC6: --pipeline sde-cobranca --stage from other pipeline throws mismatch error", () => {
    expect(() => {
      new CrmOpportunityCommands().create(
        "X",
        undefined,
        "contact-1",
        "stage-other-pipeline",
        "100000",
        undefined,
        undefined,
        true,
        undefined,
        "sde-cobranca",
      );
    }).toThrow(/does not belong to pipeline/);
  });

  // AC7: ambiguous pipeline name rejected by service
  it("AC7: --pipeline ambiguous-pipeline throws disambiguation error", () => {
    expect(() => {
      new CrmOpportunityCommands().create(
        "X",
        undefined,
        "contact-1",
        undefined,
        "100000",
        undefined,
        undefined,
        true,
        undefined,
        "ambiguous-pipeline",
      );
    }).toThrow(/Ambiguous pipeline name/);
  });
});
