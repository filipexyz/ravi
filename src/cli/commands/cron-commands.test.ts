import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());
const actualRouterConfigModule = await import("../../router/config.js");
const actualRouterDbModule = await import("../../router/router-db.js");
const actualSessionsModule = await import("../../router/sessions.js");
const actualSessionKeyModule = await import("../../router/session-key.js");

const emitMock = mock(async () => {});

let cronJob: Record<string, unknown> | null = null;
let cronJobs: Record<string, unknown>[] = [];
let mockScopeContext: Record<string, unknown> | undefined;
let mockScopeEnforced = false;
// Cross-agent grants held by the mock caller, e.g. { permission: "view", objectType: "agent", objectId: "*" }.
let mockGrants: Array<{ permission: string; objectType: string; objectId: string }> = [];
let mockCliContext: Record<string, unknown> | undefined;
let creationIdempotency: unknown;
let recordedResourceDenials: Array<Record<string, unknown>> = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
  getGroupMetadata: () => undefined,
  getCommandsMetadata: () => [],
  getArgsMetadata: () => [],
  getOptionsMetadata: () => [],
  getScopeMetadata: () => new Map(),
  getCommandAccessMetadata: () => new Map(),
  getReturnsMetadata: () => new Map(),
  getReturnsBinaryMetadata: () => new Set(),
  getCliOnlyMetadata: () => new Set(),
}));

mock.module("../context.js", () => ({
  getContext: () => mockCliContext,
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
    const relation = mode === "mutate" ? "modify" : "view";
    return mockGrants.some(
      (grant) =>
        grant.permission === relation &&
        grant.objectType === "agent" &&
        (grant.objectId === "*" || grant.objectId === resourceAgentId),
    );
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
    const ownerVisible = mockGrants.some(
      (grant) =>
        grant.permission === "view" &&
        grant.objectType === "agent" &&
        (grant.objectId === "*" || grant.objectId === input.resourceAgentId),
    );
    return ownerVisible
      ? {
          message: `Permission denied: agent:${input.ctx.agentId} cannot ${verb} ${input.resourceLabel} owned by agent:${input.resourceAgentId}; requires ${relation} on agent:${input.resourceAgentId}`,
          requiredCapability: `${relation}:agent:${input.resourceAgentId}`,
          denialId: 7,
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
  ...actualRouterConfigModule,
  getAgent: (id: string) => ({ id }),
  getAllAgents: () => [],
}));

mock.module("../../router/session-key.js", () => ({
  ...actualSessionKeyModule,
  deriveSourceFromSessionKey: () => undefined,
}));

mock.module("../../router/sessions.js", () => ({
  ...actualSessionsModule,
  resolveSession: () => null,
}));

mock.module("../../router/router-db.js", () => ({
  ...actualRouterDbModule,
  getDefaultTimezone: () => "UTC",
  getAccountForAgent: () => undefined,
  getDefaultAgentId: () => "main",
  dbGetSetting: () => null,
  dbSetSetting: () => {},
  dbDeleteSetting: () => false,
  dbListSettings: () => ({}),
  dbGetAgent: (id: string) => ({ id }),
  dbListAgents: () => [{ id: "main" }],
  DmScopeSchema: {
    options: ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"],
    safeParse: () => ({ success: true }),
  },
}));

mock.module("../../cron/index.js", () => ({
  createCronJobIdempotently: (input: Record<string, unknown>, idempotency?: unknown) => {
    creationIdempotency = idempotency;
    cronJob = {
      id: "cron-created",
      enabled: true,
      deleteAfterRun: Boolean(input.deleteAfterRun),
      sessionTarget: input.sessionTarget ?? "main",
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: 2,
      ...input,
    };
    return { created: true, targetId: "cron-created", job: cronJob };
  },
  dbGetCronJob: () => cronJob,
  dbListCronJobs: () => (cronJobs.length > 0 ? cronJobs : cronJob ? [cronJob] : []),
  dbUpdateCronJob: (_id: string, patch: Record<string, unknown>) => {
    cronJob = {
      ...cronJob,
      ...patch,
      updatedAt: 2,
    };
    return cronJob;
  },
  dbDeleteCronJob: () => {
    const deleted = Boolean(cronJob);
    cronJob = null;
    return deleted;
  },
  parseScheduleInput: () => ({ type: "at", at: 1 }),
  describeSchedule: (schedule: Record<string, unknown>) =>
    schedule.type === "every" ? "every 30m" : String(schedule.type),
  formatDurationMs: (ms: number) => `${Math.round(ms / 60000)}m`,
  parseDurationMs: (value: string) => {
    const match = value.match(/^(\d+)(s|m|h)$/);
    if (!match) return 1_800_000;
    const n = Number(match[1]);
    return match[2] === "s" ? n * 1000 : match[2] === "m" ? n * 60_000 : n * 3_600_000;
  },
  isValidCronExpression: () => true,
}));

const { CronCommands } = await import("./cron.js");
const { ContractError } = await import("../agent-contract.js");

beforeEach(() => {
  mockGrants = [];
  recordedResourceDenials = [];
});

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

describe("CronCommands --json", () => {
  beforeEach(() => {
    emitMock.mockClear();
    mockScopeContext = undefined;
    mockScopeEnforced = false;
    mockCliContext = undefined;
    creationIdempotency = undefined;
    cronJobs = [];
    cronJob = {
      id: "cron-1",
      name: "Daily",
      enabled: true,
      schedule: { type: "every", every: 1_800_000 },
      executionType: "agent",
      message: "hello",
      sessionTarget: "main",
      deleteAfterRun: false,
      fireCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
  });

  it("creates shell jobs without requiring an agent message", async () => {
    const payload = await captureJson(() =>
      new CronCommands().add(
        "Shell ETL",
        undefined,
        "30m",
        undefined,
        undefined,
        undefined,
        "python3 /tmp/etl.py",
        undefined,
        "notify-session:ops",
        "5m",
        "/tmp/job.env",
        undefined,
        undefined,
        undefined,
        undefined,
        "Run deterministic ETL",
        true,
      ),
    );

    expect(payload).toMatchObject({
      status: "created",
      target: { type: "cron", id: "cron-created" },
      job: {
        id: "cron-created",
        executionType: "shell",
        message: "",
        shellCommand: "python3 /tmp/etl.py",
        shellTimeoutMs: 300_000,
        shellEnvFile: "/tmp/job.env",
        onError: "notify-session:ops",
      },
    });
  });

  it("rejects shell jobs that also provide an agent message", async () => {
    await expect(
      new CronCommands().add("Bad", undefined, "30m", undefined, undefined, "hello", "echo no"),
    ).rejects.toThrow("--message cannot be combined with --shell/--exec");
  });

  it("derives durable creation idempotency from observer source turns", async () => {
    mockCliContext = {
      agentId: "observer",
      sessionKey: "obs:binding-1",
      context: {
        metadata: {
          observation: { ruleId: "proactive-followups", sourceTurnIds: ["turn-2", "turn-1", "turn-1"] },
        },
      },
    };

    await captureJson(() =>
      new CronCommands().add(
        "Proactive follow-up",
        undefined,
        undefined,
        "2026-07-21T09:00:00-03:00",
        undefined,
        "Check the source session",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );

    expect(creationIdempotency).toEqual({
      observer: { ruleId: "proactive-followups", sourceTurnIds: ["turn-1", "turn-2"] },
    });
  });

  it("lets an explicit idempotency key override observer-derived context", async () => {
    mockCliContext = {
      context: {
        metadata: { observation: { ruleId: "proactive-followups", sourceTurnIds: ["turn-1"] } },
      },
    };

    await captureJson(() =>
      new CronCommands().add(
        "Proactive follow-up",
        undefined,
        "30m",
        undefined,
        undefined,
        "Check the source session",
        undefined,
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
        "operator-key",
      ),
    );

    expect(creationIdempotency).toEqual({ explicitKey: "operator-key" });
  });

  it("returns updated cron job data for set --json", async () => {
    const payload = await captureJson(() => new CronCommands().set("cron-1", "name", "Renamed", true));

    expect(payload).toMatchObject({
      status: "updated",
      target: { type: "cron", id: "cron-1" },
      changedCount: 1,
      property: "name",
      value: "Renamed",
      job: {
        id: "cron-1",
        name: "Renamed",
        effectiveAgentId: "main",
        scheduleDescription: "every 30m",
        routing: { kind: "none" },
        targetResolution: { state: "ok", agentExists: true },
      },
    });
  });

  it("returns trigger dispatch metadata for run --json", async () => {
    // --execute required: without it, `cron run` is a dry-run (exit 3).
    const payload = await captureJson(() => new CronCommands().run("cron-1", true, true));

    expect(payload).toMatchObject({
      status: "triggered",
      target: { type: "cron", id: "cron-1" },
      changedCount: 0,
      job: {
        id: "cron-1",
      },
    });
    expect(emitMock).toHaveBeenCalledWith("ravi.cron.trigger", { jobId: "cron-1" });
  });

  it("returns deleted cron job data for rm --json", async () => {
    // --execute required: without it, `cron rm` is a dry-run (exit 3).
    const payload = await captureJson(() => new CronCommands().rm("cron-1", true, true));

    expect(payload).toMatchObject({
      status: "deleted",
      target: { type: "cron", id: "cron-1" },
      changedCount: 1,
      job: {
        id: "cron-1",
        name: "Daily",
      },
    });
    expect(cronJob).toBeNull();
  });
});

describe("CronCommands JSON list target resolution", () => {
  beforeEach(() => {
    emitMock.mockClear();
    mockScopeContext = undefined;
    mockScopeEnforced = false;
    cronJobs = [
      {
        id: "cron-agent",
        name: "Agent Job",
        enabled: true,
        schedule: { type: "every", every: 1_800_000 },
        executionType: "agent",
        agentId: "main",
        message: "hello",
        sessionTarget: "main",
        deleteAfterRun: false,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "cron-shell",
        name: "Shell Job",
        enabled: true,
        schedule: { type: "every", every: 3_600_000 },
        executionType: "shell",
        shellCommand: "echo ok",
        message: "",
        sessionTarget: "main",
        deleteAfterRun: false,
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    cronJob = cronJobs[0];
  });

  it("includes targetResolution on every item in JSON list", async () => {
    const payload = await captureJson(async () => new CronCommands().list(true));

    const items = payload.items as Array<Record<string, unknown>>;
    for (const item of items) {
      expect(item.targetResolution).toBeDefined();
      const tr = item.targetResolution as Record<string, unknown>;
      expect(["ok", "agent_missing", "reply_session_missing", "derived_key", "unresolved"]).toContain(
        tr.state as string,
      );
    }
  });

  it("items and jobs carry equivalent targetResolution", async () => {
    const payload = await captureJson(async () => new CronCommands().list(true));

    const items = payload.items as Array<Record<string, unknown>>;
    const jobs = payload.jobs as Array<Record<string, unknown>>;
    expect(items).toHaveLength(jobs.length);
    for (let i = 0; i < items.length; i++) {
      expect(items[i].targetResolution).toEqual(jobs[i].targetResolution);
    }
  });

  it("JSON list output is parseable by JSON.parse", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      new CronCommands().list(true);
    } finally {
      console.log = originalLog;
    }

    const raw = lines.join("\n");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("shell jobs without onError have targetResolution state=ok", async () => {
    const payload = await captureJson(async () => new CronCommands().list(true));

    const items = payload.items as Array<Record<string, unknown>>;
    const shellItem = items.find((i) => i.executionType === "shell");
    expect(shellItem).toBeDefined();
    const tr = shellItem!.targetResolution as Record<string, unknown>;
    expect(tr.state).toBe("ok");
  });
});

describe("CronCommands agent-scoped listing", () => {
  beforeEach(() => {
    emitMock.mockClear();
    mockScopeContext = undefined;
    mockScopeEnforced = false;
    cronJobs = [
      {
        id: "cron-own",
        name: "Own Job",
        enabled: true,
        schedule: { type: "every", every: 1_800_000 },
        executionType: "agent",
        agentId: "ravi-refinamento",
        message: "own task",
        sessionTarget: "main",
        deleteAfterRun: false,
        fireCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "cron-other",
        name: "Other Job",
        enabled: true,
        schedule: { type: "every", every: 3_600_000 },
        executionType: "agent",
        agentId: "ravi-dev",
        message: "other task",
        sessionTarget: "main",
        deleteAfterRun: false,
        fireCount: 0,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: "cron-default",
        name: "Default Agent Job",
        enabled: true,
        schedule: { type: "every", every: 900_000 },
        executionType: "agent",
        agentId: undefined,
        message: "default task",
        sessionTarget: "main",
        deleteAfterRun: false,
        fireCount: 0,
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    cronJob = cronJobs[0];
  });

  it("defaults to agent-scoped listing when agentId is present", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };

    const payload = await captureJson(async () => new CronCommands().list(true));

    const items = payload.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("cron-own");
    expect(payload.filters).toMatchObject({
      scope: "agent",
      agentId: "ravi-refinamento",
    });
  });

  it("excludes jobs from other agents in default scope", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };

    const payload = await captureJson(async () => new CronCommands().list(true));

    const items = payload.items as Array<Record<string, unknown>>;
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain("cron-other");
    expect(ids).not.toContain("cron-default");
  });

  it("includes default-agent jobs when caller is the default agent", async () => {
    mockScopeContext = { agentId: "main" };

    const payload = await captureJson(async () => new CronCommands().list(true));

    const items = payload.items as Array<Record<string, unknown>>;
    const ids = items.map((i) => i.id);
    expect(ids).toContain("cron-default");
    expect(ids).not.toContain("cron-own");
    expect(ids).not.toContain("cron-other");
  });

  it("returns all visible jobs with --all-agents", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };

    const payload = await captureJson(async () => new CronCommands().list(true, undefined, undefined, undefined, true));

    const items = payload.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(payload.filters).toMatchObject({ scope: "all-agents" });
  });

  it("--all-agents still applies REBAC when scope is enforced", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };
    mockScopeEnforced = true;

    const payload = await captureJson(async () => new CronCommands().list(true, undefined, undefined, undefined, true));

    const items = payload.items as Array<Record<string, unknown>>;
    // Without cross-agent grants only own jobs are visible when scope is enforced
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("cron-own");
    expect(payload.filters).toMatchObject({ scope: "all-agents", visibility: "scoped" });
  });

  it("--all-agents includes jobs of agents covered by view agent:<id>", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };
    mockScopeEnforced = true;
    mockGrants = [{ permission: "view", objectType: "agent", objectId: "ravi-dev" }];

    const payload = await captureJson(async () => new CronCommands().list(true, undefined, undefined, undefined, true));

    const ids = (payload.items as Array<Record<string, unknown>>).map((i) => i.id).sort();
    expect(ids).toEqual(["cron-other", "cron-own"]);
    expect(payload.filters).toMatchObject({ scope: "all-agents", visibility: "scoped" });
  });

  it("--all-agents with view agent:* lists every job, including default-agent jobs", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };
    mockScopeEnforced = true;
    mockGrants = [{ permission: "view", objectType: "agent", objectId: "*" }];

    const payload = await captureJson(async () => new CronCommands().list(true, undefined, undefined, undefined, true));

    const ids = (payload.items as Array<Record<string, unknown>>).map((i) => i.id).sort();
    expect(ids).toEqual(["cron-default", "cron-other", "cron-own"]);
    expect(payload.total).toBe(3);
  });

  it("treats unowned jobs as default-agent jobs for visibility", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };
    mockScopeEnforced = true;
    mockGrants = [{ permission: "view", objectType: "agent", objectId: "main" }];

    const payload = await captureJson(async () => new CronCommands().list(true, undefined, undefined, undefined, true));

    const ids = (payload.items as Array<Record<string, unknown>>).map((i) => i.id).sort();
    expect(ids).toEqual(["cron-default", "cron-own"]);
  });

  it("modify agent:<id> alone does not grant listing visibility", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };
    mockScopeEnforced = true;
    mockGrants = [{ permission: "modify", objectType: "agent", objectId: "*" }];

    const payload = await captureJson(async () => new CronCommands().list(true, undefined, undefined, undefined, true));

    const ids = (payload.items as Array<Record<string, unknown>>).map((i) => i.id);
    expect(ids).toEqual(["cron-own"]);
  });

  it("--agent <other> lists that agent's jobs once view agent:<other> is granted", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };
    mockScopeEnforced = true;

    const hidden = await captureJson(async () =>
      new CronCommands().list(true, undefined, undefined, undefined, undefined, "ravi-dev"),
    );
    expect(hidden.items).toEqual([]);

    mockGrants = [{ permission: "view", objectType: "agent", objectId: "ravi-dev" }];
    const visible = await captureJson(async () =>
      new CronCommands().list(true, undefined, undefined, undefined, undefined, "ravi-dev"),
    );
    const items = visible.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("cron-other");
    expect(visible.filters).toMatchObject({ scope: "agent", agentId: "ravi-dev", visibility: "scoped" });
  });

  it("reports visibility=full when scope is not enforced", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };
    mockScopeEnforced = false;

    const payload = await captureJson(async () => new CronCommands().list(true, undefined, undefined, undefined, true));

    expect(payload.total).toBe(3);
    expect(payload.filters).toMatchObject({ scope: "all-agents", visibility: "full" });
  });

  it("text --all-agents output tells a scoped caller that hidden jobs are omitted", () => {
    mockScopeContext = { agentId: "ravi-refinamento" };
    mockScopeEnforced = true;

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      new CronCommands().list(false, undefined, undefined, undefined, true);
    } finally {
      console.log = originalLog;
    }

    const output = lines.join("\n");
    expect(output).toContain("Visibility: scoped to your grants");
    expect(output).not.toContain("Other Job");
  });

  it("--agent filters to a specific agent", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };

    const payload = await captureJson(async () =>
      new CronCommands().list(true, undefined, undefined, undefined, undefined, "ravi-dev"),
    );

    const items = payload.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("cron-other");
    expect(payload.filters).toMatchObject({
      scope: "agent",
      agentId: "ravi-dev",
    });
  });

  it("no agent context lists all jobs with scope=all", async () => {
    mockScopeContext = undefined;

    const payload = await captureJson(async () => new CronCommands().list(true));

    const items = payload.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(payload.filters).toMatchObject({ scope: "all" });
  });

  it("preserves --tag and --limit with agent scope", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };

    const payload = await captureJson(async () => new CronCommands().list(true, undefined, "1", undefined));

    const items = payload.items as Array<Record<string, unknown>>;
    expect(items.length).toBeLessThanOrEqual(1);
    expect(payload.filters).toMatchObject({
      scope: "agent",
      agentId: "ravi-refinamento",
    });
  });

  it("preserves --limit and --offset with --all-agents", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };

    const payload = await captureJson(async () => new CronCommands().list(true, undefined, "2", "1", true));

    const items = payload.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(payload.filters).toMatchObject({ scope: "all-agents" });
  });

  it("next-page command preserves --all-agents flag", async () => {
    mockScopeContext = { agentId: "ravi-refinamento" };

    const payload = await captureJson(async () => new CronCommands().list(true, undefined, "1", undefined, true));

    const pagination = payload.pagination as Record<string, unknown>;
    if (pagination.nextCommand) {
      expect(pagination.nextCommand).toContain("--all-agents");
    }
  });
});

describe("CronCommands cross-agent access", () => {
  const OWNER_NAME = "SENTINEL_OWNER_JOB_NAME_4Q9Z";
  const OWNER_MESSAGE = "SENTINEL_OWNER_PROMPT_4Q9Z";

  beforeEach(() => {
    emitMock.mockClear();
    mockCliContext = undefined;
    // Caller is `viewer`; the job under test belongs to `owner`.
    mockScopeContext = { agentId: "viewer" };
    mockScopeEnforced = true;
    cronJob = {
      id: "cron-owner",
      name: OWNER_NAME,
      enabled: true,
      schedule: { type: "every", every: 1_800_000 },
      executionType: "agent",
      agentId: "owner",
      message: OWNER_MESSAGE,
      sessionTarget: "main",
      deleteAfterRun: false,
      fireCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    cronJobs = [
      cronJob,
      {
        id: "cron-viewer",
        name: "Viewer digest",
        enabled: true,
        schedule: { type: "every", every: 900_000 },
        executionType: "agent",
        agentId: "viewer",
        message: "viewer prompt",
        sessionTarget: "main",
        deleteAfterRun: false,
        fireCount: 0,
        createdAt: 2,
        updatedAt: 2,
      },
    ];
  });

  it("show keeps an unauthorized existing job indistinguishable from a missing one", async () => {
    const error = await captureContractError(() => new CronCommands().show("cron-owner", true));

    expect(error.exitCode).toBe(1);
    const envelope = error.envelope();
    expect(envelope.error.code).toBe("CRON_JOB_NOT_FOUND");
    // Suggestions only draw from jobs the caller can read.
    expect(envelope.error.suggestions).toEqual(["cron-viewer", "Viewer digest"]);
    expect(JSON.stringify(envelope)).not.toContain(OWNER_NAME);
    expect(JSON.stringify(envelope)).not.toContain("agent:owner");
  });

  it("show succeeds across agents with view agent:<owner>", async () => {
    mockGrants = [{ permission: "view", objectType: "agent", objectId: "owner" }];

    const payload = await captureJson(async () => new CronCommands().show("cron-owner", true));

    expect(payload.job).toMatchObject({ id: "cron-owner", name: OWNER_NAME, agentId: "owner" });
  });

  it.each([
    ["enable", (c: InstanceType<typeof CronCommands>) => c.enable("cron-owner", true)],
    ["disable", (c: InstanceType<typeof CronCommands>) => c.disable("cron-owner", true)],
    ["set", (c: InstanceType<typeof CronCommands>) => c.set("cron-owner", "name", "Renamed", true)],
    ["run", (c: InstanceType<typeof CronCommands>) => c.run("cron-owner", true, true)],
    ["rm", (c: InstanceType<typeof CronCommands>) => c.rm("cron-owner", true, true)],
  ])("cron %s on another agent's job is PERMISSION_DENIED, not 'Job not found'", async (op, invoke) => {
    const before = { ...cronJob };

    const error = await captureContractError(() => invoke(new CronCommands()));

    expect(error.exitCode).toBe(1);
    const envelope = error.envelope();
    expect(envelope.op).toBe(`cron ${op}`);
    expect(envelope.error.code).toBe("PERMISSION_DENIED");
    expect(envelope.error.message).toContain("Permission denied: agent:viewer cannot modify cron job cron-owner");
    expect(envelope.error.message).not.toContain("Job not found");
    // Nothing about the job itself leaks, and nothing was written or emitted.
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(OWNER_NAME);
    expect(serialized).not.toContain(OWNER_MESSAGE);
    expect(cronJob).toEqual(before);
    expect(emitMock).not.toHaveBeenCalled();
    expect(recordedResourceDenials).toEqual([
      expect.objectContaining({
        resourceAgentId: "owner",
        mode: "mutate",
        command: `cron ${op}`,
        resourceLabel: "cron job cron-owner",
      }),
    ]);
  });

  it("denial does not disclose the owning agent when the caller cannot view it", async () => {
    const error = await captureContractError(() => new CronCommands().disable("cron-owner", true));

    const envelope = error.envelope();
    expect(envelope.error.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(envelope)).not.toContain("agent:owner");
    expect(envelope.error.requiredCapability).toBeUndefined();
    expect(envelope.error.suggestedAction).toContain("modify authority on the owning agent");
  });

  it("view-only callers are told exactly which grant is missing", async () => {
    mockGrants = [{ permission: "view", objectType: "agent", objectId: "owner" }];

    const error = await captureContractError(() => new CronCommands().disable("cron-owner", true));

    const envelope = error.envelope();
    expect(envelope.error.code).toBe("PERMISSION_DENIED");
    expect(envelope.error.message).toContain("requires modify on agent:owner");
    expect(envelope.error.requiredCapability).toBe("modify:agent:owner");
    expect(envelope.error.suggestedAction).toBe("Request modify:agent:owner from an operator and retry 'cron disable'");
    expect(JSON.stringify(envelope)).not.toContain(OWNER_NAME);
    expect(cronJob?.enabled).toBe(true);
  });

  it("disable succeeds across agents with modify agent:<owner>", async () => {
    mockGrants = [{ permission: "modify", objectType: "agent", objectId: "owner" }];

    const payload = await captureJson(() => new CronCommands().disable("cron-owner", true));

    expect(payload).toMatchObject({ status: "disabled", target: { type: "cron", id: "cron-owner" }, changedCount: 1 });
    expect(cronJob?.enabled).toBe(false);
    expect(emitMock).toHaveBeenCalledWith("ravi.cron.refresh", {});
  });

  it("superadmin (scope not enforced) disables across agents", async () => {
    mockScopeEnforced = false;

    const payload = await captureJson(() => new CronCommands().disable("cron-owner", true));

    expect(payload).toMatchObject({ status: "disabled", changedCount: 1 });
    expect(cronJob?.enabled).toBe(false);
  });

  it("unowned jobs are mutable by whoever may modify the default agent", async () => {
    cronJob = { ...cronJob, agentId: undefined };

    const denied = await captureContractError(() => new CronCommands().disable("cron-owner", true));
    expect(denied.envelope().error.code).toBe("PERMISSION_DENIED");
    expect(recordedResourceDenials[0]).toMatchObject({ resourceAgentId: "main" });

    mockGrants = [{ permission: "modify", objectType: "agent", objectId: "main" }];
    const payload = await captureJson(() => new CronCommands().disable("cron-owner", true));
    expect(payload).toMatchObject({ status: "disabled" });
  });

  it("a genuinely missing id is still CRON_JOB_NOT_FOUND", async () => {
    cronJob = null;

    const error = await captureContractError(() => new CronCommands().disable("cron-nope", true));

    expect(error.envelope().error.code).toBe("CRON_JOB_NOT_FOUND");
    expect(recordedResourceDenials).toEqual([]);
  });
});

describe("cron agent-first contract", () => {
  beforeEach(() => {
    emitMock.mockClear();
    mockScopeContext = undefined;
    mockScopeEnforced = false;
    mockCliContext = undefined;
    cronJobs = [];
    cronJob = {
      id: "cron-1",
      name: "SENTINEL_CRON_NAME_8K2R",
      enabled: true,
      schedule: { type: "every", every: 1_800_000 },
      executionType: "agent",
      message: "PRIVATE_CRON_MESSAGE_8K2R",
      sessionTarget: "main",
      deleteAfterRun: false,
      fireCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
  });

  it("blocks cron rm without --execute (dry-run, exit 3, no delete)", async () => {
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      await new CronCommands().rm("cron-1", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("cron rm");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    expect(envelope.error.plan).toEqual({
      jobId: "cron-1",
      executionType: "agent",
      scheduleType: "every",
      enabled: true,
    });
    expect(JSON.stringify(envelope.error.plan)).not.toContain("SENTINEL_CRON_NAME_8K2R");
    expect(cronJob).not.toBeNull();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("blocks cron run without --execute (dry-run, exit 3, no trigger emitted)", async () => {
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      await new CronCommands().run("cron-1", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("cron run");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    const plan = envelope.error.plan as Record<string, unknown>;
    expect(plan).toEqual({
      jobId: "cron-1",
      executionType: "agent",
      scheduleType: "every",
      messageChars: "PRIVATE_CRON_MESSAGE_8K2R".length,
      agentId: "main",
      sessionTarget: "main",
    });
    expect(JSON.stringify(plan)).not.toContain("SENTINEL_CRON_NAME_8K2R");
    expect(JSON.stringify(plan)).not.toContain("PRIVATE_CRON_MESSAGE_8K2R");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("cron run dry-run never exposes a shell command", async () => {
    const sentinel = "SENTINEL_CRON_SHELL_COMMAND_DO_NOT_LEAK";
    cronJob = {
      id: "cron-shell",
      name: "Shell job",
      enabled: true,
      schedule: { type: "every", every: 60_000 },
      executionType: "shell",
      shellCommand: sentinel,
      message: "",
      sessionTarget: "main",
      deleteAfterRun: false,
      fireCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      await new CronCommands().run("cron-shell", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    const plan = (thrown as InstanceType<typeof ContractError>).details.plan as Record<string, unknown>;
    expect(plan).toEqual({
      jobId: "cron-shell",
      executionType: "shell",
      scheduleType: "every",
      shellCommandPresent: true,
      shellCommandChars: sentinel.length,
    });
    expect(JSON.stringify(plan)).not.toContain(sentinel);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("performs the write with --execute (rm deletes, run emits the trigger)", async () => {
    await captureJson(() => new CronCommands().run("cron-1", true, true));
    expect(emitMock).toHaveBeenCalledWith("ravi.cron.trigger", { jobId: "cron-1" });

    emitMock.mockClear();
    await captureJson(() => new CronCommands().rm("cron-1", true, true));
    expect(cronJob).toBeNull();
    expect(emitMock).toHaveBeenCalledWith("ravi.cron.refresh", {});
  });

  it("emits CRON_JOB_NOT_FOUND envelope with suggestions on --json (exit 1)", () => {
    cronJob = null;
    cronJobs = [
      {
        id: "cron-report",
        name: "Daily Report",
        enabled: true,
        schedule: { type: "every", every: 1_800_000 },
        executionType: "agent",
        agentId: "main",
        message: "report",
        sessionTarget: "main",
        deleteAfterRun: false,
        fireCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "cron-etl",
        name: "Nightly ETL",
        enabled: true,
        schedule: { type: "every", every: 3_600_000 },
        executionType: "shell",
        shellCommand: "echo ok",
        message: "",
        sessionTarget: "main",
        deleteAfterRun: false,
        fireCount: 0,
        createdAt: 2,
        updatedAt: 2,
      },
    ];

    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      new CronCommands().show("cron-reprot", true);
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
    expect(envelope.op).toBe("cron show");
    expect(envelope.error.code).toBe("CRON_JOB_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("cron-report");
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
  });

  it("supports --fields compact mode on cron list", async () => {
    const payload = await captureJson(async () =>
      new CronCommands().list(true, undefined, undefined, undefined, undefined, undefined, "id,name"),
    );

    const items = payload.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual(["id", "name"]);
    const jobs = payload.jobs as Array<Record<string, unknown>>;
    expect(Object.keys(jobs[0]).sort()).toEqual(["id", "name"]);
  });
});
