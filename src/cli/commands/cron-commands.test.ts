import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());
const actualRouterConfigModule = await import("../../router/config.js");
const actualRouterDbModule = await import("../../router/router-db.js");

const emitMock = mock(async () => {});

let cronJob: Record<string, unknown> | null = null;

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Scope: () => () => {},
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
    emit: emitMock,
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
  ...actualRouterConfigModule,
  getAgent: (id: string) => ({ id }),
  getAllAgents: () => [],
}));

mock.module("../../router/session-key.js", () => ({
  deriveSourceFromSessionKey: () => undefined,
}));

mock.module("../../router/sessions.js", () => ({
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
  dbCreateCronJob: () => {
    throw new Error("not used");
  },
  dbGetCronJob: () => cronJob,
  dbListCronJobs: () => (cronJob ? [cronJob] : []),
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
  parseDurationMs: () => 1_800_000,
  isValidCronExpression: () => true,
}));

const { CronCommands } = await import("./cron.js");

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
    cronJob = {
      id: "cron-1",
      name: "Daily",
      enabled: true,
      schedule: { type: "every", every: 1_800_000 },
      message: "hello",
      sessionTarget: "main",
      deleteAfterRun: false,
      fireCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
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
      },
    });
  });

  it("returns trigger dispatch metadata for run --json", async () => {
    const payload = await captureJson(() => new CronCommands().run("cron-1", true));

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
    const payload = await captureJson(() => new CronCommands().rm("cron-1", true));

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
