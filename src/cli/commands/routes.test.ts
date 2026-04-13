import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

const actualCliContextModule = await import("../context.js");
const actualRouterIndexModule = await import("../../router/index.js");
const actualRouterDbModule = await import("../../router/router-db.js");
const actualContactsModule = await import("../../contacts.js");
const actualRouterSessionsModule = await import("../../router/sessions.js");

type RouteRecord = {
  id: number;
  accountId: string;
  pattern: string;
  agent: string;
  priority?: number | null;
  policy?: string | null;
  session?: string | null;
  channel?: string | null;
  dmScope?: string | null;
};

let routes: RouteRecord[] = [];
let instanceNames = new Set<string>(["main"]);
let contactStatuses = new Map<string, { status: string }>();
let liveWinner: { route?: { pattern?: string | null } | null; agentId: string } | null = null;

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  getContext: () => undefined,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  nats: {
    emit: mock(async () => {}),
  },
}));

mock.module("@omni/sdk", () => ({
  createOmniClient: () => ({
    instances: {
      list: async () => ({ items: [] }),
      status: async () => ({}),
      disconnect: async () => {},
      connect: async () => ({}),
    },
  }),
}));

mock.module("qrcode-terminal", () => ({
  default: {
    generate: () => {},
  },
}));

mock.module("../../router/router-db.js", () => ({
  ...actualRouterDbModule,
  dbGetInstance: (name: string) =>
    instanceNames.has(name)
      ? {
          name,
          channel: "whatsapp",
          agent: "main",
          dmPolicy: "open",
          groupPolicy: "open",
          enabled: true,
          instanceId: `omni-${name}`,
        }
      : null,
  dbGetInstanceByInstanceId: () => null,
  dbListInstances: () => [],
  dbUpsertInstance: () => {},
  dbUpdateInstance: () => {},
  dbDeleteInstance: () => false,
  dbRestoreInstance: () => false,
  dbListDeletedInstances: () => [],
  dbGetAgent: (id: string) => ({ id }),
  dbCreateAgent: () => {},
  dbListAgents: () => [{ id: "main" }, { id: "sales" }],
  dbGetRoute: (pattern: string, accountId: string) =>
    routes.find((route) => route.accountId === accountId && route.pattern === pattern) ?? null,
  dbListRoutes: (accountId?: string) => routes.filter((route) => (accountId ? route.accountId === accountId : true)),
  dbCreateRoute: () => {},
  dbUpdateRoute: () => {},
  dbDeleteRoute: () => false,
  dbRestoreRoute: () => false,
  dbListDeletedRoutes: () => [],
  DmScopeSchema: {
    options: ["main", "per-peer"],
    safeParse: (value: string) => ({ success: ["main", "per-peer"].includes(value) }),
  },
  DmPolicySchema: {
    options: ["open", "pairing", "closed"],
    safeParse: (value: string) => ({ success: ["open", "pairing", "closed"].includes(value) }),
  },
  GroupPolicySchema: {
    options: ["open", "allowlist", "closed"],
    safeParse: (value: string) => ({ success: ["open", "allowlist", "closed"].includes(value) }),
  },
  dbGetSetting: () => null,
  dbSetSetting: () => {},
}));

mock.module("../../router/index.js", () => ({
  ...actualRouterIndexModule,
  loadRouterConfig: () => ({}),
  matchRoute: () => liveWinner,
}));

mock.module("../../router/omni-ignore.js", () => ({
  IGNORED_OMNI_INSTANCE_IDS_SETTING: "ignoredOmniInstanceIds",
  parseIgnoredOmniInstanceIds: () => [],
  serializeIgnoredOmniInstanceIds: () => "",
}));

mock.module("../../omni-config.js", () => ({
  resolveOmniConnection: () => ({
    apiUrl: "http://127.0.0.1:8882",
    apiKey: "test-key",
  }),
}));

mock.module("../../contacts.js", () => ({
  ...actualContactsModule,
  getContact: (pattern: string) => contactStatuses.get(pattern) ?? null,
  listAccountPending: () => [],
  removeAccountPending: () => false,
  allowContact: () => {},
}));

mock.module("../../router/sessions.js", () => ({
  ...actualRouterSessionsModule,
  listSessions: () => [],
  deleteSession: () => {},
}));

mock.module("../runtime-target.js", () => ({
  inspectCliRuntimeTarget: (name: string) => ({
    name,
    instance: { exists: instanceNames.has(name) },
  }),
  formatCliRuntimeTarget: (summary: { name: string }) => [`Target instance: ${summary.name}`],
  getCliRuntimeMismatchMessage: () => null,
}));

const { RoutesCommands } = await import("./instances.js");

function captureLogs(run: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    run();
  } finally {
    console.log = originalLog;
  }

  return lines.join("\n");
}

describe("RoutesCommands", () => {
  beforeEach(() => {
    routes = [];
    instanceNames = new Set(["main"]);
    contactStatuses = new Map();
    liveWinner = null;
  });

  it("lists routes across all instances with discovery and mutation follow-ups", () => {
    routes = [
      {
        id: 1,
        accountId: "main",
        pattern: "5511999999999",
        agent: "sales",
        priority: 10,
        policy: "open",
        session: "vip",
      },
      {
        id: 2,
        accountId: "ops",
        pattern: "group:board",
        agent: "main",
        priority: 5,
        channel: "whatsapp",
      },
    ];
    contactStatuses.set("5511999999999", { status: "allowed" });

    const output = captureLogs(() => {
      new RoutesCommands().list();
    });

    expect(output).toContain("Routes across all instances:");
    expect(output).toContain("INSTANCE");
    expect(output).toContain("main");
    expect(output).toContain("ops");
    expect(output).toContain('Show one: ravi routes show <instance> "<pattern>"');
    expect(output).toContain('Explain:  ravi routes explain <instance> "<pattern>"');
    expect(output).toContain("Mutate:   ravi instances routes add <instance> <pattern> <agent>");
  });

  it("shows route details with next steps", () => {
    routes = [
      {
        id: 1,
        accountId: "main",
        pattern: "5511999999999",
        agent: "sales",
        priority: 3,
        policy: "pairing",
        dmScope: "per-peer",
        session: "vip",
        channel: "whatsapp",
      },
    ];

    const output = captureLogs(() => {
      new RoutesCommands().show("main", "5511999999999");
    });

    expect(output).toContain("Route: 5511999999999 (instance: main)");
    expect(output).toContain("Agent:     sales");
    expect(output).toContain("Priority:  3");
    expect(output).toContain("Policy:    pairing");
    expect(output).toContain("DM Scope:  per-peer");
    expect(output).toContain("Session:   vip");
    expect(output).toContain("Channel:   whatsapp");
    expect(output).toContain('Explain live routing: ravi routes explain main "5511999999999"');
    expect(output).toContain('Mutate config:        ravi instances routes set main "5511999999999" <key> <value>');
  });

  it("explains configured routes against the live winner", () => {
    routes = [
      {
        id: 1,
        accountId: "main",
        pattern: "5511999999999",
        agent: "sales",
        channel: "whatsapp",
      },
    ];
    liveWinner = {
      route: { pattern: "5511999999999" },
      agentId: "sales",
    };

    const output = captureLogs(() => {
      new RoutesCommands().explain("main", "5511999999999", "whatsapp");
    });

    expect(output).toContain("Target instance: main");
    expect(output).toContain("Config route:  5511999999999 → sales");
    expect(output).toContain("Live effect:   verified");
    expect(output).toContain("Winning route: 5511999999999");
    expect(output).toContain("Winning agent: sales");
    expect(output).toContain('Route details: ravi routes show main "5511999999999"');
    expect(output).toContain('Mutate config: ravi instances routes set main "5511999999999" <key> <value>');
  });
});
