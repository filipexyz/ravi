import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());
const actualRouterDbModule = await import("../../router/router-db.js");

const createdTriggers: Array<Record<string, unknown>> = [];
const updatedTriggers: Array<{ id: string; patch: Record<string, unknown> }> = [];
const deletedTriggerIds: string[] = [];
const emitMock = mock(async () => {});

function buildTriggerRecord(): Record<string, unknown> {
  return {
    id: "trg_1",
    name: "trigger",
    topic: "ravi.external.topic",
    message: "hello",
    agentId: "agent-1",
    cooldownMs: 5000,
    enabled: true,
    session: "isolated",
    fireCount: 0,
    createdAt: Date.now(),
  };
}

let triggerRecord: Record<string, unknown> | null = buildTriggerRecord();
let triggerList: Array<Record<string, unknown>> = [];
let mockScopeContext: Record<string, unknown> | undefined;
let mockScopeEnforced = false;
// Cross-agent grants held by the mock caller, e.g. { permission: "view", objectType: "agent", objectId: "*" }.
let mockGrants: Array<{ permission: string; objectType: string; objectId: string }> = [];
const recordedResourceDenials: Array<Record<string, unknown>> = [];

function mockHasGrant(relation: string, resourceAgentId: string): boolean {
  return mockGrants.some(
    (grant) =>
      grant.permission === relation &&
      grant.objectType === "agent" &&
      (grant.objectId === "*" || grant.objectId === resourceAgentId),
  );
}

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  connectNats: mock(async () => {}),
  closeNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  isExplicitConnect: () => false,
  publish: mock(async () => {}),
  subscribe: mock(() => (async function* () {})()),
  nats: {
    emit: emitMock,
    subscribe: mock(() => (async function* () {})()),
    close: mock(async () => {}),
  },
}));

mock.module("../../permissions/scope.js", () => ({
  getScopeContext: () => mockScopeContext,
  isScopeEnforced: () => mockScopeEnforced,
  canAccessSession: () => true,
  canModifySession: () => true,
  canAccessContact: () => true,
  // Mirrors the real check: operator/superadmin (scope not enforced) and own
  // resources always pass; other agents' resources need `view agent:<owner>`
  // for read and `modify agent:<owner>` for mutate.
  canAccessResource: (_ctx: unknown, resourceAgentId: string | undefined, mode: "read" | "mutate") => {
    if (!mockScopeEnforced || !mockScopeContext?.agentId) return true;
    if (!resourceAgentId) return false;
    if (mockScopeContext.agentId === resourceAgentId) return true;
    return mockHasGrant(mode === "mutate" ? "modify" : "view", resourceAgentId);
  },
  recordResourceAccessDenial: (input: {
    ctx: { agentId?: string };
    resourceAgentId: string;
    mode: "read" | "mutate";
    resourceLabel: string;
    command: string;
  }) => {
    recordedResourceDenials.push(input);
    const relation = input.mode === "mutate" ? "modify" : "view";
    const verb = input.mode === "mutate" ? "modify" : "read";
    return mockHasGrant("view", input.resourceAgentId)
      ? {
          message: `Permission denied: agent:${input.ctx.agentId} cannot ${verb} ${input.resourceLabel} owned by agent:${input.resourceAgentId}; requires ${relation} on agent:${input.resourceAgentId}`,
          requiredCapability: `${relation}:agent:${input.resourceAgentId}`,
        }
      : {
          message: `Permission denied: agent:${input.ctx.agentId} cannot ${verb} ${input.resourceLabel}; requires ${relation} authority on the owning agent`,
        };
  },
  canViewAgent: () => true,
  canWriteContacts: () => true,
  filterAccessibleSessions: <T>(_: unknown, sessions: T[]) => sessions,
  filterVisibleAgents: <T>(_: unknown, agents: T[]) => agents,
}));

mock.module("../../router/config.js", () => ({
  getRaviDir: () => "/tmp/ravi",
  getAgent: () => ({ id: "agent-1" }),
  getAllAgents: () => [{ id: "agent-1" }],
  createAgent: () => {},
  updateAgent: () => {},
  deleteAgent: () => false,
  setAgentDebounce: () => {},
  checkAgentDirs: () => [],
  ensureAgentDirs: () => {},
  loadRouterConfig: () => ({ defaultAgent: "agent-1" }),
  setAgentSpecMode: () => {},
}));

mock.module("../../router/router-db.js", () => ({
  ...actualRouterDbModule,
  getAccountForAgent: () => undefined,
  getDefaultAgentId: () => "main",
}));

mock.module("../../cron/schedule.js", () => ({
  parseDurationMs: () => 5000,
  formatDurationMs: () => "5s",
}));

mock.module("../../triggers/index.js", () => ({
  dbCreateTrigger: (input: Record<string, unknown>) => {
    createdTriggers.push(input);
    return {
      id: "trg_1",
      name: input.name,
      topic: input.topic,
      message: input.message,
      executionType: input.executionType,
      shellCommand: input.shellCommand,
      shellTimeoutMs: input.shellTimeoutMs,
      shellEnvFile: input.shellEnvFile,
      onError: input.onError,
      agentId: input.agentId,
      accountId: input.accountId,
      cooldownMs: input.cooldownMs,
      session: input.session,
      filter: input.filter,
      enabled: true,
      fireCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
  },
  dbGetTrigger: () => triggerRecord,
  dbListTriggers: () => (triggerList.length > 0 ? triggerList : triggerRecord ? [triggerRecord] : []),
  dbUpdateTrigger: (id: string, patch: Record<string, unknown>) => {
    updatedTriggers.push({ id, patch });
    return {
      id,
      name: "trigger",
      topic: "ravi.external.topic",
      message: "hello",
      agentId: "agent-1",
      cooldownMs: 5000,
      enabled: true,
      session: "isolated",
      fireCount: 0,
      createdAt: 1,
      updatedAt: 2,
      ...patch,
    };
  },
  dbDeleteTrigger: (id: string) => {
    deletedTriggerIds.push(id);
    triggerRecord = null;
  },
}));

const { TriggersCommands } = await import("./triggers.js");
const { ContractError } = await import("../agent-contract.js");

beforeEach(() => {
  mockScopeContext = undefined;
  mockScopeEnforced = false;
  mockGrants = [];
  recordedResourceDenials.length = 0;
});

async function captureJson(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await run();
  } finally {
    console.log = originalLog;
  }

  return JSON.parse(lines.join("\n")) as Record<string, unknown>;
}

async function captureWarnings(run: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await run();
  } finally {
    console.warn = originalWarn;
  }

  return warnings;
}

describe("TriggersCommands topic guidance", () => {
  beforeEach(() => {
    createdTriggers.length = 0;
    updatedTriggers.length = 0;
    deletedTriggerIds.length = 0;
    emitMock.mockClear();
    triggerRecord = buildTriggerRecord();
    triggerList = [];
  });

  it("allows ravi.session topics on add but prints an internal topic warning", async () => {
    const commands = new TriggersCommands();

    const warnings = await captureWarnings(() => commands.add("loop", "ravi.session.agent-main.prompt", "hello"));

    expect(createdTriggers).toContainEqual(
      expect.objectContaining({
        name: "loop",
        topic: "ravi.session.agent-main.prompt",
      }),
    );
    expect(warnings.join("\n")).toContain("runner skips ravi.session.*");
  });

  it("allows channel reaction aliases with canonical topic warning", async () => {
    const commands = new TriggersCommands();

    const warnings = await captureWarnings(() => commands.add("reaction", "whatsapp.*.reaction", "hello"));

    expect(createdTriggers).toContainEqual(
      expect.objectContaining({
        name: "reaction",
        topic: "whatsapp.*.reaction",
      }),
    );
    expect(warnings.join("\n")).toContain("ravi.inbound.reaction");
  });

  it("allows session CLI topics", async () => {
    const commands = new TriggersCommands();

    await commands.add("cli", "ravi.*.cli.contacts.*", "hello");

    expect(createdTriggers).toContainEqual(
      expect.objectContaining({
        name: "cli",
        topic: "ravi.*.cli.contacts.*",
      }),
    );
  });

  it("uses the catalog default message template when --message is omitted", async () => {
    const commands = new TriggersCommands();

    const payload = await captureJson(() =>
      commands.add(
        "local mail watcher",
        "ravi.inbox.mail.received",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );

    expect(createdTriggers).toContainEqual(
      expect.objectContaining({
        name: "local mail watcher",
        topic: "ravi.inbox.mail.received",
        message: expect.stringContaining("ravi mail messages read {{data.mail.messageId}}"),
        messageSource: "catalog",
        messageTemplateId: "mail-inbox-default",
      }),
    );
    expect(payload).toMatchObject({
      status: "created",
      messageTemplate: {
        source: "catalog_default",
        topicId: "inbox.mail.received",
        templateId: "mail-inbox-default",
      },
    });
  });

  it("still requires --message for custom topics without a catalog template", async () => {
    const commands = new TriggersCommands();

    await expect(commands.add("custom", "custom.mail.received")).rejects.toThrow("--message is required");
    expect(createdTriggers).toEqual([]);
  });

  it("creates shell triggers without a prompt message", async () => {
    const commands = new TriggersCommands();

    const payload = await captureJson(() =>
      commands.add(
        "ticket shell",
        "ravi.inbound.interaction",
        undefined,
        undefined,
        undefined,
        "1s",
        undefined,
        'data.provider == "slack"',
        undefined,
        true,
        "printf ok",
        undefined,
        "30",
        "/tmp/ticket.env",
        "notify-session:ravi-channels",
      ),
    );

    expect(createdTriggers).toContainEqual(
      expect.objectContaining({
        name: "ticket shell",
        topic: "ravi.inbound.interaction",
        message: "",
        executionType: "shell",
        shellCommand: "printf ok",
        shellTimeoutMs: 30_000,
        shellEnvFile: "/tmp/ticket.env",
        onError: "notify-session:ravi-channels",
        filter: 'data.provider == "slack"',
      }),
    );
    expect(payload).toMatchObject({
      status: "created",
      trigger: {
        id: "trg_1",
        name: "ticket shell",
        executionType: "shell",
      },
    });
  });

  it("rejects shell triggers that also pass --message", async () => {
    const commands = new TriggersCommands();

    await expect(
      commands.add(
        "bad shell",
        "ravi.inbound.interaction",
        "hello",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "printf ok",
      ),
    ).rejects.toThrow("--message cannot be combined");
    expect(createdTriggers).toEqual([]);
  });

  it("accepts composed boolean filters on add", async () => {
    const commands = new TriggersCommands();

    await commands.add(
      "filtered",
      "ravi.inbound.reaction",
      "hello",
      undefined,
      undefined,
      undefined,
      undefined,
      `data.chatId == "120363424@g.us" && (data.emoji == "👍" || data.emoji == "👍🏻")`,
    );

    expect(createdTriggers).toContainEqual(
      expect.objectContaining({
        name: "filtered",
        filter: `data.chatId == "120363424@g.us" && (data.emoji == "👍" || data.emoji == "👍🏻")`,
      }),
    );
  });

  it("rejects invalid filters on add before persisting", async () => {
    const commands = new TriggersCommands();

    await expect(
      commands.add(
        "bad",
        "ravi.inbound.reaction",
        "hello",
        undefined,
        undefined,
        undefined,
        undefined,
        "data.ok == true",
      ),
    ).rejects.toThrow("Invalid filter");
    expect(createdTriggers).toEqual([]);
  });

  it("allows ravi.session topics on set but prints an internal topic warning", async () => {
    const commands = new TriggersCommands();

    const warnings = await captureWarnings(() => commands.set("trg_1", "topic", "ravi.session.agent-main.runtime"));

    expect(updatedTriggers).toContainEqual({
      id: "trg_1",
      patch: { topic: "ravi.session.agent-main.runtime" },
    });
    expect(warnings.join("\n")).toContain("runner skips ravi.session.*");
  });

  it("prints created trigger data in --json mode", async () => {
    const commands = new TriggersCommands();

    const payload = await captureJson(() =>
      commands.add(
        "json trigger",
        "ravi.external.topic",
        "hello",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );

    expect(payload).toMatchObject({
      status: "created",
      target: { type: "trigger", id: "trg_1" },
      changedCount: 1,
      warnings: [expect.stringContaining("custom NATS subject")],
      trigger: {
        id: "trg_1",
        name: "json trigger",
        effectiveAgentId: "main",
        cooldownDescription: "5s",
      },
    });
  });

  it("prints trigger topic catalog in --json mode", async () => {
    const commands = new TriggersCommands();

    const payload = await captureJson(async () => commands.topics(true));

    expect(payload).toMatchObject({
      topics: expect.arrayContaining([
        expect.objectContaining({
          pattern: "ravi.inbound.reaction",
          payload: "{ targetMessageId, emoji, senderId }",
        }),
        expect.objectContaining({
          pattern: "ravi.*.cli.*.*",
        }),
        expect.objectContaining({
          pattern: "ravi._cli.cli.*.*",
        }),
      ]),
    });
  });

  it("prints updated trigger data in --json mode", async () => {
    const commands = new TriggersCommands();

    const payload = await captureJson(() => commands.set("trg_1", "filter", `data.ok == "true"`, true));

    expect(payload).toMatchObject({
      status: "updated",
      target: { type: "trigger", id: "trg_1" },
      changedCount: 1,
      property: "filter",
      value: `data.ok == "true"`,
      trigger: {
        id: "trg_1",
        filter: `data.ok == "true"`,
      },
    });
  });

  it("rejects invalid filters on set before updating", async () => {
    const commands = new TriggersCommands();

    await expect(commands.set("trg_1", "filter", `data.ok == "true" &&`)).rejects.toThrow("Invalid filter");
    expect(updatedTriggers).toEqual([]);
  });

  it("captures --reply-session override on add", async () => {
    const commands = new TriggersCommands();

    await commands.add(
      "override",
      "ravi.external.topic",
      "hello",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "target-session-name",
    );

    expect(createdTriggers).toContainEqual(
      expect.objectContaining({
        name: "override",
        replySession: "target-session-name",
      }),
    );
  });

  it("sets replySession on existing trigger", async () => {
    const commands = new TriggersCommands();

    const payload = await captureJson(() => commands.set("trg_1", "replySession", "gest-o-financeira-sde", true));

    expect(updatedTriggers).toContainEqual({
      id: "trg_1",
      patch: { replySession: "gest-o-financeira-sde" },
    });
    expect(payload).toMatchObject({
      status: "updated",
      property: "replySession",
      value: "gest-o-financeira-sde",
    });
  });

  it("sets shell execution on existing trigger", async () => {
    const commands = new TriggersCommands();

    const payload = await captureJson(() => commands.set("trg_1", "shell", "printf ok", true));

    expect(updatedTriggers).toContainEqual({
      id: "trg_1",
      patch: {
        executionType: "shell",
        shellCommand: "printf ok",
        message: "",
        messageSource: "manual",
        messageTemplateId: null,
      },
    });
    expect(payload).toMatchObject({
      status: "updated",
      property: "shell",
    });
  });

  it("switches back to agent execution when message is set", async () => {
    const commands = new TriggersCommands();

    await commands.set("trg_1", "message", "agent prompt");

    expect(updatedTriggers).toContainEqual({
      id: "trg_1",
      patch: {
        message: "agent prompt",
        executionType: "agent",
        shellCommand: null,
        shellTimeoutMs: null,
        shellEnvFile: null,
        onError: null,
        messageSource: "manual",
        messageTemplateId: null,
      },
    });
  });

  it("clears replySession when value is null", async () => {
    const commands = new TriggersCommands();

    await commands.set("trg_1", "replySession", "null");

    expect(updatedTriggers).toContainEqual({
      id: "trg_1",
      patch: { replySession: null },
    });
  });
});

describe("triggers agent-first contract", () => {
  beforeEach(() => {
    createdTriggers.length = 0;
    updatedTriggers.length = 0;
    deletedTriggerIds.length = 0;
    emitMock.mockClear();
    triggerRecord = buildTriggerRecord();
    triggerList = [];
  });

  it("blocks triggers rm without --execute (dry-run, exit 3, no delete)", async () => {
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      await new TriggersCommands().rm("trg_1", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("triggers rm");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    const plan = envelope.error.plan as Record<string, unknown>;
    expect(plan).toEqual({
      triggerId: "trg_1",
      executionType: "agent",
      enabled: true,
    });
    expect(JSON.stringify(plan)).not.toContain("ravi.external.topic");
    expect(deletedTriggerIds).toEqual([]);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("deletes the trigger with --execute", async () => {
    const payload = await captureJson(() => new TriggersCommands().rm("trg_1", true, true));

    expect(payload).toMatchObject({
      status: "deleted",
      target: { type: "trigger", id: "trg_1" },
      changedCount: 1,
    });
    expect(deletedTriggerIds).toEqual(["trg_1"]);
    expect(emitMock).toHaveBeenCalledWith("ravi.triggers.refresh", {});
  });

  it("blocks triggers test without --execute after resolving the trigger (dry-run, exit 3, no NATS emission)", async () => {
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      await new TriggersCommands().test("trg_1", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("triggers test");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.plan).toEqual({
      triggerId: "trg_1",
      executionType: "agent",
    });
    expect(JSON.stringify(envelope.error.plan)).not.toContain("ravi.external.topic");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("validates the trigger before applying the triggers test brake", async () => {
    triggerRecord = null;
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      await new TriggersCommands().test("missing", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    expect((thrown as InstanceType<typeof ContractError>).exitCode).toBe(1);
    expect((thrown as InstanceType<typeof ContractError>).code).toBe("TRIGGER_NOT_FOUND");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("emits the synthetic trigger event with --execute", async () => {
    const payload = await captureJson(() => new TriggersCommands().test("trg_1", true, true));

    expect(payload).toMatchObject({
      status: "test_emitted",
      target: { type: "trigger", id: "trg_1" },
      changedCount: 0,
    });
    expect(emitMock).toHaveBeenCalledWith("ravi.triggers.test", { triggerId: "trg_1" });
  });

  it("emits TRIGGER_NOT_FOUND envelope with suggestions on --json (exit 1)", () => {
    triggerRecord = null;
    triggerList = [
      { id: "trg_mail", name: "Mail watcher", topic: "ravi.inbox.mail.received", agentId: "agent-1", enabled: true },
      { id: "trg_audit", name: "Audit alert", topic: "ravi.audit.denied", agentId: "agent-1", enabled: true },
    ];

    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      new TriggersCommands().show("trg_mial", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("triggers show");
    expect(envelope.error.code).toBe("TRIGGER_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("trg_mail");
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
  });

  it("supports --fields compact mode on triggers list", async () => {
    const payload = await captureJson(async () =>
      new TriggersCommands().list(true, undefined, undefined, undefined, "id,name"),
    );

    const items = payload.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual(["id", "name"]);
    const triggers = payload.triggers as Array<Record<string, unknown>>;
    expect(Object.keys(triggers[0]).sort()).toEqual(["id", "name"]);
  });
});

describe("triggers cross-agent access", () => {
  const OWNER_NAME = "SENTINEL_OWNER_TRIGGER_NAME_7X1Q";

  async function captureContractError(run: () => unknown): Promise<InstanceType<typeof ContractError>> {
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    let thrown: unknown;
    try {
      await run();
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    return thrown as InstanceType<typeof ContractError>;
  }

  beforeEach(() => {
    updatedTriggers.length = 0;
    deletedTriggerIds.length = 0;
    emitMock.mockClear();
    // Caller is `viewer`; the trigger under test belongs to `owner`.
    mockScopeContext = { agentId: "viewer" };
    mockScopeEnforced = true;
    triggerRecord = { ...buildTriggerRecord(), id: "trg_owner", name: OWNER_NAME, agentId: "owner" };
    triggerList = [
      triggerRecord,
      { ...buildTriggerRecord(), id: "trg_viewer", name: "viewer trigger", agentId: "viewer" },
      { ...buildTriggerRecord(), id: "trg_default", name: "default trigger", agentId: undefined },
    ];
  });

  it("list shows other agents' triggers only through view agent:<owner>", async () => {
    const own = await captureJson(async () => new TriggersCommands().list(true));
    expect((own.items as Array<Record<string, unknown>>).map((t) => t.id)).toEqual(["trg_viewer"]);

    mockGrants = [{ permission: "view", objectType: "agent", objectId: "*" }];
    const all = await captureJson(async () => new TriggersCommands().list(true));
    expect((all.items as Array<Record<string, unknown>>).map((t) => t.id).sort()).toEqual([
      "trg_default",
      "trg_owner",
      "trg_viewer",
    ]);
  });

  it("show keeps an unauthorized existing trigger indistinguishable from a missing one", async () => {
    const error = await captureContractError(() => new TriggersCommands().show("trg_owner", true));

    const envelope = error.envelope();
    expect(envelope.error.code).toBe("TRIGGER_NOT_FOUND");
    expect(envelope.error.suggestions).not.toContain("trg_owner");
    expect(JSON.stringify(envelope)).not.toContain(OWNER_NAME);
  });

  it.each([
    ["enable", (c: InstanceType<typeof TriggersCommands>) => c.enable("trg_owner", true)],
    ["disable", (c: InstanceType<typeof TriggersCommands>) => c.disable("trg_owner", true)],
    ["set", (c: InstanceType<typeof TriggersCommands>) => c.set("trg_owner", "name", "Renamed", true)],
    ["test", (c: InstanceType<typeof TriggersCommands>) => c.test("trg_owner", true, true)],
    ["rm", (c: InstanceType<typeof TriggersCommands>) => c.rm("trg_owner", true, true)],
  ])("triggers %s on another agent's trigger is PERMISSION_DENIED, not 'Trigger not found'", async (op, invoke) => {
    const error = await captureContractError(() => invoke(new TriggersCommands()));

    expect(error.exitCode).toBe(1);
    const envelope = error.envelope();
    expect(envelope.op).toBe(`triggers ${op}`);
    expect(envelope.error.code).toBe("PERMISSION_DENIED");
    expect(envelope.error.message).toContain("Permission denied: agent:viewer cannot modify trigger trg_owner");
    expect(JSON.stringify(envelope)).not.toContain(OWNER_NAME);
    expect(updatedTriggers).toEqual([]);
    expect(deletedTriggerIds).toEqual([]);
    expect(emitMock).not.toHaveBeenCalled();
    expect(recordedResourceDenials).toEqual([
      expect.objectContaining({ resourceAgentId: "owner", mode: "mutate", command: `triggers ${op}` }),
    ]);
  });

  it("disable succeeds across agents with modify agent:<owner>", async () => {
    mockGrants = [{ permission: "modify", objectType: "agent", objectId: "owner" }];

    const payload = await captureJson(() => new TriggersCommands().disable("trg_owner", true));

    expect(payload).toMatchObject({ status: "disabled", target: { type: "trigger", id: "trg_owner" } });
    expect(updatedTriggers).toEqual([{ id: "trg_owner", patch: { enabled: false } }]);
    expect(emitMock).toHaveBeenCalledWith("ravi.triggers.refresh", {});
  });
});
