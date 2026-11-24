import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRaviStateDir } from "../../utils/paths.js";

afterAll(() => mock.restore());
const actualRouterDbModule = await import("../../router/router-db.js");

const createdTriggers: Array<Record<string, unknown>> = [];
const updatedTriggers: Array<{ id: string; patch: Record<string, unknown> }> = [];
/** Who each update said was making it (`keepOwnerFor`), or null when it named nobody. */
const updateOwners: Array<string | null> = [];
/** The principal of the turn running the command, as the classifier would give it. */
let currentTurnOwner = "operator";
const { isOwnerNeutralTriggerUpdate } = await import("../../triggers/triggers-db.js");
const actualTriggerOwnership = await import("../../triggers/ownership.js");
// Taken before the module is mocked: the namespace itself follows the mock afterwards.
const realOwnerKeptOnEnable = actualTriggerOwnership.ownerKeptOnEnable;
const realTriggerOwnership = { ...actualTriggerOwnership };
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

let mockToolContext: unknown;
mock.module("../context.js", () => ({
  getContext: () => mockToolContext,
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
      ownerPrincipal: input.ownerPrincipal,
      enabled: true,
      fireCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
  },
  dbGetTrigger: () => triggerRecord,
  dbListTriggers: () => (triggerList.length > 0 ? triggerList : triggerRecord ? [triggerRecord] : []),
  dbUpdateTrigger: (id: string, patch: Record<string, unknown>, options: { keepOwnerFor?: string } = {}) => {
    updatedTriggers.push({ id, patch });
    updateOwners.push(options.keepOwnerFor ?? null);
    const before: Record<string, unknown> = {
      name: "trigger",
      topic: "ravi.external.topic",
      message: "hello",
      agentId: "agent-1",
      cooldownMs: 5000,
      enabled: true,
      session: "isolated",
      fireCount: 0,
      createdAt: 1,
      ...triggerRecord,
      id,
    };
    const next: Record<string, unknown> = { ...before, updatedAt: 2, ...patch };
    // The store's rule: only the owner's own change, or one that only paces the trigger, keeps the owner.
    const keepsOwner =
      isOwnerNeutralTriggerUpdate(patch) ||
      (options.keepOwnerFor !== undefined && options.keepOwnerFor === before.ownerPrincipal);
    if (!keepsOwner) delete next.ownerPrincipal;
    return next;
  },
  dbDeleteTrigger: (id: string) => {
    deletedTriggerIds.push(id);
    triggerRecord = null;
  },
}));

/**
 * The operator of these tests, with no contact linked to them: neither this
 * machine's `ravi login` nor its link cache is read to tell who is the operator.
 */
const TEST_OPERATOR = {
  activeUserId: "user_test_operator",
  activeOrgId: "org_test",
  ownerName: "Operator",
  getContactBinding: () => null,
};
/** Sessions that already exist, by name and by key: the sessions table of this machine is not read either. */
let existingSessions: Record<string, string> = {};

// The turn's principal comes from the daemon's record of the turn; here each test says who is asking.
mock.module("../../triggers/ownership.js", () => ({
  ...realTriggerOwnership,
  resolveTriggerOwnerForCurrentTurn: () => currentTurnOwner,
  ownerKeptOnEnable: (trigger: { ownerPrincipal?: string }) => realOwnerKeptOnEnable(trigger, currentTurnOwner),
  triggerOwnerActsAsOperator: (ownerPrincipal: string | null | undefined) =>
    realTriggerOwnership.triggerOwnerActsAsOperator(ownerPrincipal, TEST_OPERATOR),
  triggerRunsAsWarning: (trigger: Parameters<typeof realTriggerOwnership.triggerRunsAsWarning>[0]) =>
    realTriggerOwnership.triggerRunsAsWarning(trigger, TEST_OPERATOR),
  triggerSessionTargetError: (ref: string) =>
    realTriggerOwnership.triggerSessionTargetError(ref, {
      resolveSession: (name) => (name in existingSessions ? { sessionKey: existingSessions[name]! } : null),
    }),
  triggerIsolatedSessionName: (
    agentId: string,
    trigger: Parameters<typeof realTriggerOwnership.triggerIsolatedSessionName>[1],
  ) =>
    realTriggerOwnership.triggerIsolatedSessionName(agentId, trigger, {
      // Here a session's name is looked up by its key: the name it is listed under, else the key itself.
      getSession: (sessionKey) => {
        const name =
          Object.keys(existingSessions).find((ref) => existingSessions[ref] === sessionKey && ref !== sessionKey) ??
          (sessionKey in existingSessions ? sessionKey : undefined);
        return name ? { name } : null;
      },
    }),
}));

const { TriggersCommands } = await import("./triggers.js");
const { ContractError } = await import("../agent-contract.js");

beforeEach(() => {
  mockScopeContext = undefined;
  mockScopeEnforced = false;
  mockGrants = [];
  recordedResourceDenials.length = 0;
  updateOwners.length = 0;
  currentTurnOwner = "operator";
  existingSessions = {};
  mockToolContext = undefined;
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
    // A shell trigger is created only from a request the daemon verified.
    mockToolContext = { transport: "gateway" };

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

  it("refuses a shell trigger from a turn that does not act as the operator", async () => {
    const commands = new TriggersCommands();
    mockToolContext = { transport: "gateway" };

    for (const owner of ["contact:c_ana", "unknown"]) {
      currentTurnOwner = owner;
      await expect(
        commands.add(
          "contact shell",
          "ravi.inbound.interaction",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          "printf ok",
        ),
      ).rejects.toMatchObject({
        code: "TRIGGER_SHELL_NOT_OPERATOR",
        message: expect.stringContaining("not the operator"),
      });
    }
    expect(createdTriggers).toEqual([]);
  });

  it("refuses to create or change a shell trigger from a local ravi with no runtime context", async () => {
    const commands = new TriggersCommands();
    // The operator's owner principal, but no daemon-verified transport: any local process could claim it.
    mockToolContext = undefined;
    currentTurnOwner = "operator";
    await expect(
      commands.add(
        "local shell",
        "ravi.inbound.interaction",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        "printf ok",
      ),
    ).rejects.toMatchObject({ code: "TRIGGER_SHELL_NOT_OPERATOR", message: expect.stringContaining("local ravi") });
    triggerRecord = {
      ...buildTriggerRecord(),
      ownerPrincipal: "operator",
      executionType: "shell",
      shellCommand: "true",
    };
    await expect(commands.disable("trg_1", true)).rejects.toMatchObject({ code: "TRIGGER_SHELL_NOT_OPERATOR" });
    expect(createdTriggers).toEqual([]);
    expect(updatedTriggers).toEqual([]);
  });

  it("refuses an env file inside the Ravi state dir", async () => {
    const commands = new TriggersCommands();
    mockToolContext = { transport: "gateway" };
    const daemonEnvFile = join(getRaviStateDir(), ".env");
    await expect(
      commands.add(
        "secrets shell",
        "ravi.inbound.interaction",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        "printf ok",
        undefined,
        undefined,
        daemonEnvFile,
      ),
    ).rejects.toMatchObject({ code: "TRIGGER_SHELL_ENV_FILE_IN_STATE_DIR" });
    triggerRecord = {
      ...buildTriggerRecord(),
      ownerPrincipal: "operator",
      executionType: "shell",
      shellCommand: "true",
    };
    await expect(commands.set("trg_1", "env-file", daemonEnvFile, true)).rejects.toMatchObject({
      code: "TRIGGER_SHELL_ENV_FILE_IN_STATE_DIR",
    });
    // A hard link has its own path outside the state dir; it is refused for having more than one link.
    const outside = mkdtempSync(join(tmpdir(), "ravi-trigger-env-link-"));
    try {
      writeFileSync(join(outside, "own.env"), "TICKET_QUEUE=ops\n");
      linkSync(join(outside, "own.env"), join(outside, "linked.env"));
      await expect(commands.set("trg_1", "env-file", join(outside, "linked.env"), true)).rejects.toMatchObject({
        code: "TRIGGER_SHELL_ENV_FILE_HARD_LINK",
      });
      // A directory is refused for what it is, not as a hard link (its link count is above one).
      await expect(commands.set("trg_1", "env-file", outside, true)).rejects.toMatchObject({
        code: "TRIGGER_SHELL_ENV_FILE_NOT_REGULAR",
      });
      // A regular file over the loader's limit is refused when saved, not left to fail on every event.
      writeFileSync(join(outside, "big.env"), `A=${"x".repeat(1024 * 1024)}\n`);
      await expect(commands.set("trg_1", "env-file", join(outside, "big.env"), true)).rejects.toMatchObject({
        code: "TRIGGER_SHELL_ENV_FILE_TOO_LARGE",
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(createdTriggers).toEqual([]);
    expect(updatedTriggers).toEqual([]);
  });

  it("refuses an env file its group or others can write, or that another user owns", async () => {
    const commands = new TriggersCommands();
    mockToolContext = { transport: "gateway" };
    triggerRecord = {
      ...buildTriggerRecord(),
      ownerPrincipal: "operator",
      executionType: "shell",
      shellCommand: "true",
    };
    const outside = mkdtempSync(join(tmpdir(), "ravi-trigger-env-mode-"));
    try {
      const envFile = join(outside, "ticket.env");
      writeFileSync(envFile, "TICKET_QUEUE=ops\n", { mode: 0o600 });
      chmodSync(envFile, 0o666);
      await expect(commands.set("trg_1", "env-file", envFile, true)).rejects.toMatchObject({
        code: "TRIGGER_SHELL_ENV_FILE_WRITABLE_BY_OTHERS",
      });
      // A file another user owns, when this machine has one (not when the tests run as root).
      const foreign = ["/etc/hosts", "/etc/passwd"].find((path) => {
        const stats = statSync(path, { throwIfNoEntry: false });
        return stats?.isFile() && stats.nlink === 1 && stats.uid !== process.getuid?.() && (stats.mode & 0o022) === 0;
      });
      if (foreign) {
        await expect(commands.set("trg_1", "env-file", foreign, true)).rejects.toMatchObject({
          code: "TRIGGER_SHELL_ENV_FILE_NOT_OWNED",
        });
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(updatedTriggers).toEqual([]);
  });

  it("refuses an env file it cannot check with a code, not a raw ELOOP", async () => {
    const commands = new TriggersCommands();
    mockToolContext = { transport: "gateway" };
    triggerRecord = {
      ...buildTriggerRecord(),
      ownerPrincipal: "operator",
      executionType: "shell",
      shellCommand: "true",
    };
    const outside = mkdtempSync(join(tmpdir(), "ravi-trigger-env-loop-"));
    try {
      symlinkSync(join(outside, "b.env"), join(outside, "a.env"));
      symlinkSync(join(outside, "a.env"), join(outside, "b.env"));
      await expect(commands.set("trg_1", "env-file", join(outside, "a.env"), true)).rejects.toMatchObject({
        code: "TRIGGER_SHELL_ENV_FILE_UNVERIFIABLE",
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(updatedTriggers).toEqual([]);
  });

  it("refuses to turn someone else's shell trigger on or off", async () => {
    const commands = new TriggersCommands();
    mockToolContext = { transport: "gateway" };
    currentTurnOwner = "operator";
    triggerRecord = {
      ...buildTriggerRecord(),
      ownerPrincipal: "contact:c_ana",
      executionType: "shell",
      shellCommand: "true",
    };
    await expect(commands.enable("trg_1", true)).rejects.toMatchObject({ code: "TRIGGER_SHELL_NOT_OPERATOR" });
    await expect(commands.disable("trg_1", true)).rejects.toMatchObject({
      code: "TRIGGER_SHELL_NOT_OPERATOR",
      message: expect.stringContaining("only its owner changes a shell trigger"),
    });
    expect(updatedTriggers).toEqual([]);
  });

  it("refuses to change a trigger's shell command or env file from a non-operator turn", async () => {
    const commands = new TriggersCommands();
    mockToolContext = { transport: "gateway" };
    currentTurnOwner = "contact:c_ana";

    await expect(commands.set("trg_1", "shell", "printf ok", true)).rejects.toMatchObject({
      code: "TRIGGER_SHELL_NOT_OPERATOR",
    });
    triggerRecord = { ...buildTriggerRecord(), executionType: "shell", shellCommand: "true" };
    await expect(commands.set("trg_1", "env-file", "/tmp/other.env", true)).rejects.toMatchObject({
      code: "TRIGGER_SHELL_NOT_OPERATOR",
    });
    expect(updatedTriggers).toEqual([]);
  });

  it("refuses an operator edit that would leave a shell trigger with no owner", async () => {
    const commands = new TriggersCommands();
    mockToolContext = { transport: "gateway" };
    currentTurnOwner = "operator";

    for (const ownerPrincipal of ["contact:c_ana", undefined]) {
      triggerRecord = { ...buildTriggerRecord(), ...(ownerPrincipal ? { ownerPrincipal } : {}) };
      await expect(commands.set("trg_1", "shell", "printf ok", true)).rejects.toMatchObject({
        code: "TRIGGER_SHELL_NOT_OPERATOR",
      });
    }
    triggerRecord = { ...buildTriggerRecord(), ownerPrincipal: "contact:c_ana", executionType: "shell" };
    await expect(commands.set("trg_1", "env-file", "/tmp/other.env", true)).rejects.toMatchObject({
      code: "TRIGGER_SHELL_NOT_OPERATOR",
    });
    expect(updatedTriggers).toEqual([]);
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
        // Created from the terminal: the operator owns it, with no runs-as warning.
        ownerPrincipal: "operator",
        runsAsOperator: true,
      },
    });
    expect(payload.warnings).toHaveLength(1);
    expect(createdTriggers.at(-1)).toMatchObject({ ownerPrincipal: "operator" });
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
    // The operator's own trigger: the edit keeps its owner, so the shell trigger can run.
    triggerRecord = { ...buildTriggerRecord(), ownerPrincipal: "operator" };
    mockToolContext = { transport: "gateway" };

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
    // The test names who asked, so the fire acts as the owner only for the owner's own test.
    expect(emitMock).toHaveBeenCalledWith("ravi.triggers.test", { triggerId: "trg_1", initiator: "operator" });

    currentTurnOwner = "contact:c_ana";
    await captureJson(() => new TriggersCommands().test("trg_1", true, true));
    expect(emitMock).toHaveBeenLastCalledWith("ravi.triggers.test", { triggerId: "trg_1", initiator: "contact:c_ana" });
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

  it("triggers add cannot aim a trigger at another agent without modify agent:<target>", async () => {
    const error = await captureContractError(() =>
      new TriggersCommands().add("aimed", "ravi.external.topic", "hello", "owner"),
    );
    expect(error.envelope().error.code).toBe("PERMISSION_DENIED");
    expect(recordedResourceDenials[0]).toMatchObject({ resourceAgentId: "owner", command: "triggers add" });
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("triggers set cannot retarget an own trigger to another agent", async () => {
    triggerRecord = { ...buildTriggerRecord(), id: "trg_viewer", name: "viewer trigger", agentId: "viewer" };
    const error = await captureContractError(() => new TriggersCommands().set("trg_viewer", "agent", "owner", true));
    expect(error.envelope().error.code).toBe("PERMISSION_DENIED");
    expect(recordedResourceDenials[0]).toMatchObject({ resourceAgentId: "owner", command: "triggers set" });
    expect(updatedTriggers).toEqual([]);
  });

  it.each([
    ["set", (c: InstanceType<typeof TriggersCommands>) => c.set("trg_viewer", "message", "new prompt", true)],
    ["enable", (c: InstanceType<typeof TriggersCommands>) => c.enable("trg_viewer", true)],
    ["test", (c: InstanceType<typeof TriggersCommands>) => c.test("trg_viewer", true, true)],
  ])("triggers %s on an own trigger is refused in a contact-narrowed turn", async (_op, invoke) => {
    triggerRecord = { ...buildTriggerRecord(), id: "trg_viewer", name: "viewer trigger", agentId: "viewer" };
    mockToolContext = { agentId: "viewer", context: { metadata: { actorAuthorizationMode: "user-overlay" } } };
    try {
      await expect(invoke(new TriggersCommands())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    } finally {
      mockToolContext = undefined;
    }
    expect(updatedTriggers).toEqual([]);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("disable succeeds across agents with modify agent:<owner>", async () => {
    mockGrants = [{ permission: "modify", objectType: "agent", objectId: "owner" }];

    const payload = await captureJson(() => new TriggersCommands().disable("trg_owner", true));

    expect(payload).toMatchObject({ status: "disabled", target: { type: "trigger", id: "trg_owner" } });
    expect(updatedTriggers).toEqual([{ id: "trg_owner", patch: { enabled: false } }]);
    expect(emitMock).toHaveBeenCalledWith("ravi.triggers.refresh", {});
  });
});

describe("triggers invalid filter visibility", () => {
  const LEGACY_FILTER = `data.payload.repository == "o/r" && data.payload.number == 7`;

  function invalidShellTrigger(): Record<string, unknown> {
    return {
      ...buildTriggerRecord(),
      id: "trg_bad",
      name: "legacy shell",
      topic: "ravi.watch.github.*",
      executionType: "shell",
      shellCommand: "bun scripts/open-ticket.ts",
      filter: LEGACY_FILTER,
      // Only its owner, the operator, changes a shell trigger.
      ownerPrincipal: "operator",
    };
  }

  function validTrigger(): Record<string, unknown> {
    return { ...buildTriggerRecord(), id: "trg_ok", name: "valid", filter: `data.provider == "slack"` };
  }

  async function captureOutput(run: () => unknown): Promise<{ log: string; warn: string }> {
    const logs: string[] = [];
    const warns: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
    try {
      await run();
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    return { log: logs.join("\n"), warn: warns.join("\n") };
  }

  beforeEach(() => {
    createdTriggers.length = 0;
    updatedTriggers.length = 0;
    deletedTriggerIds.length = 0;
    emitMock.mockClear();
    triggerRecord = invalidShellTrigger();
    triggerList = [validTrigger(), invalidShellTrigger()];
    // A shell trigger is changed only from a request the daemon verified.
    mockToolContext = { transport: "gateway" };
  });

  it("list --json marks the invalid filter as inactive and leaves valid triggers active", async () => {
    const payload = await captureJson(async () => new TriggersCommands().list(true));

    const items = payload.items as Array<Record<string, unknown>>;
    expect(items.find((item) => item.id === "trg_ok")).toMatchObject({
      enabled: true,
      filterStatus: "valid",
      runtimeState: "active",
    });
    expect(items.find((item) => item.id === "trg_ok")).not.toHaveProperty("filterError");

    const bad = items.find((item) => item.id === "trg_bad");
    expect(bad).toMatchObject({
      enabled: true,
      executionType: "shell",
      filterStatus: "invalid",
      runtimeState: "invalid_filter",
    });
    expect(String(bad?.filterError)).toContain("Expected quoted string value");
    expect(String(bad?.runtimeStateReason)).toContain("will not activate");

    expect(payload.warnings).toEqual([expect.stringContaining("Trigger trg_bad has an invalid filter")]);
    expect((payload.warnings as string[])[0]).toContain("ravi triggers set trg_bad filter");
  });

  it("list --fields compact mode still reports invalid filters at the top level", async () => {
    const payload = await captureJson(async () =>
      new TriggersCommands().list(true, undefined, undefined, undefined, "id,name"),
    );

    expect(Object.keys((payload.items as Array<Record<string, unknown>>)[0]).sort()).toEqual(["id", "name"]);
    expect(payload.warnings).toEqual([expect.stringContaining("trg_bad")]);
  });

  it("list text output shows a STATE column and warns about the invalid filter", async () => {
    const output = await captureOutput(() => new TriggersCommands().list());

    expect(output.log).toContain("STATE");
    const badRow = output.log.split("\n").find((line) => line.includes("trg_bad"));
    const okRow = output.log.split("\n").find((line) => line.includes("trg_ok"));
    expect(badRow).toContain("invalid_filter");
    expect(okRow).toContain("active");
    expect(output.warn).toContain("Warning: Trigger trg_bad has an invalid filter");
  });

  it("list omits warnings when every filter is valid", async () => {
    triggerList = [validTrigger()];
    const payload = await captureJson(async () => new TriggersCommands().list(true));

    expect(payload).not.toHaveProperty("warnings");
  });

  it("show surfaces the invalid state, parse error, and fix command", async () => {
    const payload = await captureJson(async () => new TriggersCommands().show("trg_bad", true));
    expect(payload.trigger).toMatchObject({
      id: "trg_bad",
      filterStatus: "invalid",
      runtimeState: "invalid_filter",
    });

    const output = await captureOutput(() => new TriggersCommands().show("trg_bad"));
    expect(output.log).toMatch(/State:\s+invalid_filter/);
    expect(output.log).toMatch(/Filter error:\s+Expected quoted string value/);
    expect(output.log).toContain("ravi triggers set trg_bad filter");
  });

  it("enable warns that an invalid-filter trigger will still not fire", async () => {
    triggerRecord = { ...invalidShellTrigger(), enabled: false };

    const payload = await captureJson(() => new TriggersCommands().enable("trg_bad", true));
    expect(payload).toMatchObject({
      status: "enabled",
      trigger: { enabled: true, runtimeState: "invalid_filter" },
      warnings: [expect.stringContaining("will not fire")],
    });

    const output = await captureOutput(() => new TriggersCommands().enable("trg_bad"));
    expect(output.log).toContain("Enabled trigger: trg_bad");
    expect(output.warn).toContain("Warning: Trigger trg_bad has an invalid filter");
  });

  it("enable on a valid trigger reports it active without warnings", async () => {
    triggerRecord = { ...validTrigger(), enabled: false };

    const payload = await captureJson(() => new TriggersCommands().enable("trg_ok", true));
    expect(payload).toMatchObject({ status: "enabled", trigger: { runtimeState: "active" } });
    expect(payload).not.toHaveProperty("warnings");
  });

  it("fixing the filter with set clears the invalid state", async () => {
    const payload = await captureJson(() =>
      new TriggersCommands().set("trg_bad", "filter", `data.payload.number == "7"`, true),
    );

    expect(payload.trigger).toMatchObject({
      filter: `data.payload.number == "7"`,
      filterStatus: "valid",
      runtimeState: "active",
    });
    expect(payload.trigger).not.toHaveProperty("filterError");
    expect(emitMock).toHaveBeenCalledWith("ravi.triggers.refresh", {});
  });

  it("clearing the filter with set - persists a null filter and reactivates the trigger", async () => {
    const payload = await captureJson(() => new TriggersCommands().set("trg_bad", "filter", "-", true));

    expect(updatedTriggers).toEqual([{ id: "trg_bad", patch: { filter: null } }]);
    expect(payload).toMatchObject({ value: null });
    expect(payload.trigger).toMatchObject({ filterStatus: "none", runtimeState: "active" });
    expect(emitMock).toHaveBeenCalledWith("ravi.triggers.refresh", {});
  });
});

// parseDurationMs is mocked to 5000 in this file; real parsing (and rejection of
// bad values) is covered by src/triggers/__tests__/debounce.test.ts.
describe("triggers cooldown and debounce flags", () => {
  beforeEach(() => {
    createdTriggers.length = 0;
    updatedTriggers.length = 0;
    triggerRecord = buildTriggerRecord();
  });

  // add(name, topic, message, agent, account, cooldown, session, filter, replySession, json,
  //     shell, exec, timeout, envFile, onError, debounce)
  const addWith = (cooldown?: string, debounce?: string) =>
    new TriggersCommands().add(
      "bus",
      "ravi.inbound.reaction",
      "hello",
      undefined,
      undefined,
      cooldown,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      debounce,
    );

  it("keeps the 5s cooldown default and no debounce", async () => {
    await addWith();
    expect(createdTriggers).toContainEqual(expect.objectContaining({ cooldownMs: 5000, debounceMs: 0 }));
  });

  it("accepts off to disable cooldown and a debounce window", async () => {
    await addWith("off", "2s");
    expect(createdTriggers).toContainEqual(expect.objectContaining({ cooldownMs: 0, debounceMs: 5000 }));
  });

  it("sets debounce and turns cooldown off on an existing trigger", async () => {
    const commands = new TriggersCommands();
    await commands.set("trg_1", "debounce", "1m");
    await commands.set("trg_1", "cooldown", "off");
    expect(updatedTriggers).toContainEqual({ id: "trg_1", patch: { debounceMs: 5000 } });
    expect(updatedTriggers).toContainEqual({ id: "trg_1", patch: { cooldownMs: 0 } });
  });
});

describe("TriggersCommands owner", () => {
  beforeEach(() => {
    createdTriggers.length = 0;
    updatedTriggers.length = 0;
    deletedTriggerIds.length = 0;
    emitMock.mockClear();
    triggerRecord = { ...buildTriggerRecord(), ownerPrincipal: "operator" };
    triggerList = [];
  });

  async function captureText(run: () => Promise<unknown> | unknown): Promise<string> {
    const lines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => void lines.push(args.map((arg) => String(arg)).join(" "));
    console.warn = (...args: unknown[]) => void lines.push(args.map((arg) => String(arg)).join(" "));
    try {
      await run();
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    return lines.join("\n");
  }

  const addArgs = (asJson?: boolean) =>
    [
      "owned",
      "ravi.console.inbox.item",
      "hello",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      asJson,
    ] as const;

  describe("add", () => {
    it("records the turn that creates the trigger as its owner", async () => {
      const payload = await captureJson(() => new TriggersCommands().add(...addArgs(true)));

      expect(createdTriggers.at(-1)).toMatchObject({ ownerPrincipal: "operator" });
      expect(payload).toMatchObject({ trigger: { ownerPrincipal: "operator", runsAsOperator: true } });
      expect(payload).not.toHaveProperty("warnings");
    });

    it("warns, once and in both outputs, when the trigger will not act as the operator", async () => {
      currentTurnOwner = "contact:c_ana";
      const payload = await captureJson(() => new TriggersCommands().add(...addArgs(true)));
      expect(createdTriggers.at(-1)).toMatchObject({ ownerPrincipal: "contact:c_ana" });
      expect(payload).toMatchObject({ trigger: { ownerPrincipal: "contact:c_ana", runsAsOperator: false } });
      expect(payload.warnings).toEqual([
        expect.stringContaining("Trigger trg_1 runs as contact:c_ana, not the operator"),
      ]);

      const text = await captureText(() => new TriggersCommands().add(...addArgs()));
      expect(text.match(/runs as contact:c_ana, not the operator/g)).toHaveLength(1);
      expect(text).toContain("Runs as:    contact:c_ana (not the operator)");
    });

    it("says a trigger created from a turn Ravi cannot attribute has no owner", async () => {
      currentTurnOwner = "unknown";
      const payload = await captureJson(() => new TriggersCommands().add(...addArgs(true)));
      expect(payload).toMatchObject({ trigger: { runsAsOperator: false } });
      expect(payload.warnings).toEqual([expect.stringContaining("Bases refuses its turns (ACTOR_UNKNOWN)")]);
    });
  });

  describe("set", () => {
    it("keeps the owner when the owner makes the change, with no warning", async () => {
      const payload = await captureJson(() => new TriggersCommands().set("trg_1", "message", "new prompt", true));

      expect(updatedTriggers[0]?.patch).not.toHaveProperty("ownerPrincipal");
      expect(updateOwners).toEqual(["operator"]);
      expect(payload).toMatchObject({ trigger: { ownerPrincipal: "operator", runsAsOperator: true } });
      expect(payload).not.toHaveProperty("warnings");
    });

    it("takes the owner away when anyone else changes the trigger, and says so once", async () => {
      currentTurnOwner = "contact:c_ana";
      for (const [key, value] of [
        ["message", "their prompt"],
        ["filter", 'data.kind == "x"'],
        ["name", "renamed"],
        ["topic", "ravi.other.topic"],
        ["session", "elsewhere"],
        ["replySession", "their-chat"],
        ["debounce", "2s"],
      ] as const) {
        updateOwners.length = 0;
        const payload = await captureJson(() => new TriggersCommands().set("trg_1", key, value, true));
        expect(updateOwners).toEqual(["contact:c_ana"]);
        expect(payload).toMatchObject({ trigger: { ownerPrincipal: "unknown", runsAsOperator: false } });
        expect(payload.warnings).toContainEqual(expect.stringContaining("Trigger trg_1 no longer runs as operator"));
      }

      const text = await captureText(() => new TriggersCommands().set("trg_1", "name", "renamed again"));
      expect(text.match(/no longer runs as operator/g)).toHaveLength(1);
    });

    it("never gives a trigger an owner: the operator editing someone else's does not take it over", async () => {
      triggerRecord = { ...buildTriggerRecord(), ownerPrincipal: "contact:c_ana" };
      const payload = await captureJson(() => new TriggersCommands().set("trg_1", "message", "operator prompt", true));

      expect(updatedTriggers[0]?.patch).not.toHaveProperty("ownerPrincipal");
      expect(payload).toMatchObject({ trigger: { ownerPrincipal: "unknown", runsAsOperator: false } });
      expect(payload.warnings).toContainEqual(expect.stringContaining("no longer runs as contact:c_ana"));

      // A trigger with no owner stays without one, and there is nothing to warn about.
      triggerRecord = buildTriggerRecord();
      const ownerless = await captureJson(() => new TriggersCommands().set("trg_1", "message", "again", true));
      expect(ownerless).toMatchObject({ trigger: { ownerPrincipal: "unknown", runsAsOperator: false } });
      expect(ownerless).not.toHaveProperty("warnings");
    });

    it("leaves the owner alone, without asking who is setting, for the keys that only pace the trigger", async () => {
      currentTurnOwner = "contact:c_ana";
      const cooldown = await captureJson(() => new TriggersCommands().set("trg_1", "cooldown", "30s", true));
      expect(updateOwners).toEqual([null]);
      expect(cooldown).toMatchObject({ trigger: { ownerPrincipal: "operator", runsAsOperator: true } });
      expect(cooldown).not.toHaveProperty("warnings");

      // A shell trigger is the exception: nobody but its owner changes it, not even its pace.
      triggerRecord = { ...buildTriggerRecord(), ownerPrincipal: "operator", executionType: "shell" };
      mockToolContext = { transport: "gateway" };
      updateOwners.length = 0;
      await expect(new TriggersCommands().set("trg_1", "timeout", "60", true)).rejects.toMatchObject({
        code: "TRIGGER_SHELL_NOT_OPERATOR",
      });
      expect(updateOwners).toEqual([]);
    });
  });

  describe("enable and disable", () => {
    it("keeps the owner when the owner turns the trigger on", async () => {
      const payload = await captureJson(() => new TriggersCommands().enable("trg_1", true));
      expect(updateOwners).toEqual(["operator"]);
      expect(payload).toMatchObject({
        status: "enabled",
        trigger: { ownerPrincipal: "operator", runsAsOperator: true },
      });
      expect(payload).not.toHaveProperty("warnings");
    });

    it("keeps someone else's owner when the operator turns their draft on", async () => {
      // A contact drafted it from their chat; the operator arms it. It still acts as the contact.
      triggerRecord = { ...buildTriggerRecord(), ownerPrincipal: "contact:c_ana", enabled: false };
      const payload = await captureJson(() => new TriggersCommands().enable("trg_1", true));

      expect(updateOwners).toEqual(["contact:c_ana"]);
      expect(payload).toMatchObject({
        status: "enabled",
        trigger: { ownerPrincipal: "contact:c_ana", runsAsOperator: false, enabled: true },
      });
      expect(payload).not.toHaveProperty("warnings");

      // The operator turning on a trigger nobody owns gives it no owner.
      triggerRecord = { ...buildTriggerRecord(), enabled: false };
      updateOwners.length = 0;
      const ownerless = await captureJson(() => new TriggersCommands().enable("trg_1", true));
      expect(updateOwners).toEqual([null]);
      expect(ownerless).toMatchObject({ trigger: { ownerPrincipal: "unknown", runsAsOperator: false } });
    });

    it("takes the owner away when someone else turns it on", async () => {
      currentTurnOwner = "agent:helper";
      const payload = await captureJson(() => new TriggersCommands().enable("trg_1", true));
      expect(payload).toMatchObject({
        status: "enabled",
        trigger: { ownerPrincipal: "unknown", runsAsOperator: false },
      });
      expect(payload.warnings).toEqual([expect.stringContaining("Trigger trg_1 no longer runs as operator")]);

      const text = await captureText(() => new TriggersCommands().enable("trg_1"));
      expect(text.match(/no longer runs as operator/g)).toHaveLength(1);
    });

    it("lets anyone turn a trigger off without touching its owner", async () => {
      currentTurnOwner = "contact:c_ana";
      const payload = await captureJson(() => new TriggersCommands().disable("trg_1", true));
      expect(updateOwners).toEqual([null]);
      expect(payload).toMatchObject({ status: "disabled", trigger: { ownerPrincipal: "operator", enabled: false } });
    });
  });

  describe("a session that is another trigger's own", () => {
    // A trigger's own session goes by its key: one string is both its name and its key.
    const OWN_KEY = "agent:agent-1:trigger:aaaa1111:own";
    const OWN = { name: OWN_KEY, key: OWN_KEY };
    const addInto = (session?: string) =>
      new TriggersCommands().add("guest", "ravi.console.inbox.item", "hello", undefined, undefined, undefined, session);

    beforeEach(() => {
      existingSessions = { [OWN.key]: OWN.key, "requests-queue": "agent:agent-1:whatsapp:dm:1" };
    });

    it("cannot be given to a new trigger", async () => {
      await expect(captureJson(async () => addInto(OWN.name))).rejects.toThrow(
        `Session ${OWN.name} is the own session of trigger aaaa1111: only that trigger's fires run there`,
      );
      expect(createdTriggers).toHaveLength(0);
      // Any other session is a target as before.
      await captureText(() => addInto("requests-queue"));
      expect(createdTriggers.at(-1)).toMatchObject({ session: "requests-queue" });
    });

    it("cannot be given before it exists either: the name alone says whose session it will be", async () => {
      const unfired = "agent:agent-1:trigger:bbbb2222:own";
      await expect(captureJson(async () => addInto(unfired))).rejects.toThrow(
        `Session ${unfired} is the own session of trigger bbbb2222`,
      );
      await expect(captureText(() => new TriggersCommands().set("trg_1", "session", unfired))).rejects.toThrow(
        "is the own session of trigger bbbb2222",
      );
      expect(createdTriggers).toHaveLength(0);
      expect(updatedTriggers).toHaveLength(0);
    });

    it("cannot be given to an existing trigger either", async () => {
      await expect(captureText(() => new TriggersCommands().set("trg_1", "session", OWN.name))).rejects.toThrow(
        "is the own session of trigger aaaa1111",
      );
      expect(updatedTriggers).toHaveLength(0);
    });

    it("cannot be where a shell trigger reports its failures", async () => {
      mockToolContext = { ...((mockToolContext as Record<string, unknown> | undefined) ?? {}), transport: "gateway" };
      const addShell = (onError: string) =>
        new TriggersCommands().add(
          "ticket shell",
          "ravi.inbound.interaction",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "printf ok",
          undefined,
          undefined,
          undefined,
          onError,
        );
      await expect(captureText(() => addShell(`notify-session:${OWN.name}`))).rejects.toThrow(
        "is the own session of trigger aaaa1111",
      );
      expect(createdTriggers).toHaveLength(0);
      // Any other session takes the notice as before.
      await captureText(() => addShell("notify-session:requests-queue"));
      expect(createdTriggers.at(-1)).toMatchObject({ onError: "notify-session:requests-queue" });
    });

    it("is not what a trigger created during one of its turns defaults to", async () => {
      // The agent creates a trigger while running a turn in a trigger's own session.
      mockToolContext = { agentId: "agent-1", sessionName: OWN.name, sessionKey: OWN.key };
      await captureText(() => addInto());
      expect(createdTriggers.at(-1)).toMatchObject({ session: "main" });

      // In any other session the current session is still the default.
      mockToolContext = { agentId: "agent-1", sessionName: "luis-dm", sessionKey: "agent:agent-1:whatsapp:dm:2" };
      await captureText(() => addInto());
      expect(createdTriggers.at(-1)).toMatchObject({ session: "luis-dm" });
    });
  });

  describe("show", () => {
    it("says who the trigger runs as, and when that is not the operator", async () => {
      const commands = new TriggersCommands();
      expect(await captureJson(async () => commands.show("trg_1", true))).toMatchObject({
        trigger: { ownerPrincipal: "operator", runsAsOperator: true },
      });
      expect(await captureText(() => commands.show("trg_1"))).toMatch(/Runs as: +operator\n/);

      triggerRecord = { ...buildTriggerRecord(), ownerPrincipal: "contact:c_ana" };
      expect(await captureJson(async () => commands.show("trg_1", true))).toMatchObject({
        trigger: { ownerPrincipal: "contact:c_ana", runsAsOperator: false },
      });
      expect(await captureText(() => commands.show("trg_1"))).toContain("contact:c_ana (not the operator)");

      triggerRecord = buildTriggerRecord();
      expect(await captureJson(async () => commands.show("trg_1", true))).toMatchObject({
        trigger: { ownerPrincipal: "unknown", runsAsOperator: false },
      });
      expect(await captureText(() => commands.show("trg_1"))).toContain("unknown (not the operator)");
    });

    it("says whether the trigger runs in its own session, which Bases requires", async () => {
      const commands = new TriggersCommands();
      const show = async (record: Record<string, unknown>) => {
        triggerRecord = { ...buildTriggerRecord(), ...record };
        const payload = await captureJson(async () => commands.show("trg_1", true));
        return { payload, text: await captureText(() => commands.show("trg_1")) };
      };

      // `isolated` is the trigger's own session: nothing is flagged.
      const isolated = await show({ ownerPrincipal: "operator", session: "isolated" });
      expect(isolated.payload).toMatchObject({ trigger: { ownsSession: true, isolatedSessionName: null } });
      expect(isolated.text).toMatch(/Session: +isolated\n/);

      // Once it has fired, its session exists and `show` says which: the own session, which
      // goes by its key, for an owned trigger, and the plain one for a trigger nobody owns.
      existingSessions = {
        "agent:agent-1:trigger:trg_1:own": "agent:agent-1:trigger:trg_1:own",
        "agent-1-trigger-rows": "agent:agent-1:trigger:trg_1",
      };
      const fired = await show({ ownerPrincipal: "operator", session: "isolated" });
      expect(fired.payload).toMatchObject({ trigger: { isolatedSessionName: "agent:agent-1:trigger:trg_1:own" } });
      expect(fired.text).toMatch(/Session: +isolated \(agent:agent-1:trigger:trg_1:own\)\n/);
      const legacy = await show({ session: "isolated" });
      expect(legacy.payload).toMatchObject({ trigger: { isolatedSessionName: "agent-1-trigger-rows" } });
      existingSessions = {};

      // A session anyone can name: the agent's main one, a named one, a templated one.
      for (const session of ["main", "requests-queue", "bases-{{data.payload.rowId}}"]) {
        const shared = await show({ ownerPrincipal: "operator", session });
        expect(shared.payload).toMatchObject({ trigger: { ownsSession: false } });
        expect(shared.text).toContain(
          `${session} (not the trigger's own session: its turns cannot use Bases; isolated can)`,
        );
      }
      expect((await show({ ownerPrincipal: "contact:c_ana", session: "main" })).text).toContain(
        "not the trigger's own session",
      );

      // A trigger nobody owns is refused everywhere, which `Runs as` already says,
      // and a shell trigger's turns are not held to an owner: neither is flagged.
      const ownerless = await show({ session: "main" });
      expect(ownerless.payload).toMatchObject({ trigger: { ownsSession: false } });
      expect(ownerless.text).toMatch(/Session: +main\n/);
      const shell = await show({
        ownerPrincipal: "operator",
        session: "main",
        executionType: "shell",
        shellCommand: "true",
      });
      expect(shell.text).toMatch(/Session: +main\n/);
    });

    it("says a shell trigger that does not act as the operator does not run", async () => {
      triggerRecord = {
        ...buildTriggerRecord(),
        ownerPrincipal: "contact:c_ana",
        executionType: "shell",
        shellCommand: "true",
      };
      expect(await captureText(() => new TriggersCommands().show("trg_1"))).toContain(
        "contact:c_ana (not the operator: a shell trigger does not run)",
      );
    });
  });
});

describe("TriggersCommands --thread", () => {
  const add = (opts: { session?: string; thread?: boolean; reportTo?: string }) =>
    new TriggersCommands().add(
      "watch",
      "ravi.test.thread",
      "hello",
      undefined,
      undefined,
      undefined,
      opts.session,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      opts.thread,
      opts.reportTo,
    );

  beforeEach(() => {
    createdTriggers.length = 0;
    mockToolContext = undefined;
  });

  it("refuses --thread with --session, --report-to without --thread, and --session thread", async () => {
    await expect(add({ thread: true, session: "named" })).rejects.toThrow(/cannot be combined/);
    await expect(add({ reportTo: "named" })).rejects.toThrow("--report-to only applies with --thread");
    await expect(add({ session: "thread" })).rejects.toThrow(/Use --thread/);
    expect(createdTriggers).toHaveLength(0);
  });

  it("warns that --session isolated is deprecated, naming the Bases exception", async () => {
    const warnings = await captureWarnings(() => add({ session: "isolated" }));

    expect(createdTriggers).toContainEqual(expect.objectContaining({ session: "isolated" }));
    expect(warnings.join("\n")).toContain("--session isolated is deprecated");
    expect(warnings.join("\n")).toContain("reads Bases as its owner");
  });

  it("refuses --reply-session with --thread", async () => {
    const withReplySession = () =>
      new TriggersCommands().add(
        "watch",
        "ravi.test.thread",
        "hello",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "some-session",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
    await expect(withReplySession()).rejects.toThrow(/--reply-session does not apply with --thread/);
    expect(createdTriggers).toHaveLength(0);
  });

  it("keeps a thread trigger runnable on set: no report-to of another agent", async () => {
    const { getOrCreateSession } = await import("../../router/sessions.js");
    getOrCreateSession("agent:main:slack:dm:set-parent", "main", "/tmp/main", { name: "set-parent" });
    getOrCreateSession("agent:other:slack:dm:set-other", "other", "/tmp/other", { name: "set-other" });

    triggerRecord = {
      ...buildTriggerRecord(),
      executionType: "agent",
      agentId: "main",
      session: "thread",
      replySession: "agent:main:slack:dm:set-parent",
    };
    await expect(new TriggersCommands().set("trg_1", "replySession", "set-other", true)).rejects.toThrow(
      /belongs to other/,
    );
    triggerRecord = buildTriggerRecord();
  });

  it("stores thread mode reporting to a lasting session of the trigger's agent", async () => {
    const { getOrCreateSession } = await import("../../router/sessions.js");
    getOrCreateSession("agent:main:slack:dm:thread-parent", "main", "/tmp/main", { name: "thread-parent" });
    getOrCreateSession("agent:other:slack:dm:other-parent", "other", "/tmp/other", { name: "other-parent" });

    await add({ thread: true, reportTo: "thread-parent" });
    expect(createdTriggers).toContainEqual(
      expect.objectContaining({ session: "thread", replySession: "agent:main:slack:dm:thread-parent" }),
    );

    await expect(add({ thread: true, reportTo: "other-parent" })).rejects.toThrow(/belongs to other/);
  });
});
