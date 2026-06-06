import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());
const actualRouterDbModule = await import("../../router/router-db.js");

const createdTriggers: Array<Record<string, unknown>> = [];
const updatedTriggers: Array<{ id: string; patch: Record<string, unknown> }> = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => undefined,
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
    emit: mock(async () => {}),
    subscribe: mock(() => (async function* () {})()),
    close: mock(async () => {}),
  },
}));

mock.module("../../permissions/scope.js", () => ({
  getScopeContext: () => undefined,
  isScopeEnforced: () => false,
  canAccessSession: () => true,
  canModifySession: () => true,
  canAccessContact: () => true,
  canAccessResource: () => true,
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
  dbGetTrigger: () => ({
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
  }),
  dbListTriggers: () => [],
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
  dbDeleteTrigger: () => {},
}));

const { TriggersCommands } = await import("./triggers.js");

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
});
