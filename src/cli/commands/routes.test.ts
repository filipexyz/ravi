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
let allowContactCalls: string[] = [];
let liveWinner: { route?: { pattern?: string | null } | null; agentId: string } | null = null;
let pendingEntries: Array<{
  accountId: string;
  phone: string;
  name: string | null;
  chatId: string | null;
  isGroup: boolean;
  createdAt: number;
  updatedAt: number;
}> = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
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

mock.module("../../omni/client.js", () => ({
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
  dbCreateRoute: (input: Record<string, unknown>) => {
    const route = {
      id: routes.length + 1,
      accountId: input.accountId as string,
      pattern: input.pattern as string,
      agent: input.agent as string,
      priority: (input.priority as number | undefined) ?? 0,
      policy: (input.policy as string | undefined) ?? null,
      session: (input.session as string | undefined) ?? null,
      channel: (input.channel as string | undefined) ?? null,
      dmScope: (input.dmScope as string | undefined) ?? null,
    };
    routes.push(route);
    return route;
  },
  dbUpdateRoute: (pattern: string, updates: Record<string, unknown>, accountId: string) => {
    const route = routes.find((item) => item.accountId === accountId && item.pattern === pattern);
    if (!route) throw new Error("Route not found");
    Object.assign(route, updates);
    return route;
  },
  dbDeleteRoute: (pattern: string, accountId: string) => {
    const before = routes.length;
    routes = routes.filter((route) => !(route.accountId === accountId && route.pattern === pattern));
    return routes.length !== before;
  },
  dbRestoreRoute: () => true,
  dbListDeletedRoutes: () => [],
  DmScopeSchema: {
    options: ["main", "per-peer"],
    safeParse: (value: string) => ({ success: ["main", "per-peer"].includes(value) }),
    parse: (value: string) => value,
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
  listAccountPending: (accountId?: string) =>
    pendingEntries
      .filter((entry) => !accountId || entry.accountId === accountId)
      .map((entry) => ({
        ...entry,
        pendingKind: entry.isGroup ? "chat" : "contact",
        chatType: entry.isGroup ? "group" : "dm",
      })),
  removeAccountPending: (accountId: string, phone: string) => {
    const before = pendingEntries.length;
    pendingEntries = pendingEntries.filter((entry) => !(entry.accountId === accountId && entry.phone === phone));
    return pendingEntries.length !== before;
  },
  allowContact: (contact: string) => {
    allowContactCalls.push(contact);
  },
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

const { RoutesCommands, InstancesRoutesCommands, InstancesPendingCommands } = await import("./instances.js");

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

function captureJson(run: () => void): Record<string, unknown> {
  return JSON.parse(captureLogs(run)) as Record<string, unknown>;
}

describe("RoutesCommands", () => {
  beforeEach(() => {
    routes = [];
    instanceNames = new Set(["main"]);
    contactStatuses = new Map();
    allowContactCalls = [];
    liveWinner = null;
    pendingEntries = [];
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

  it("lists route entities in --json mode", () => {
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
    ];

    const payload = captureJson(() => {
      new RoutesCommands().list(undefined, true);
    });

    expect(payload.total).toBe(1);
    const payloadRoutes = payload.routes as Array<Record<string, unknown>>;
    expect(payloadRoutes[0].pattern).toBe("5511999999999");
    expect(payloadRoutes[0].agent).toBe("sales");
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

  it("explains configured routes as typed JSON", () => {
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

    const payload = captureJson(() => {
      new RoutesCommands().explain("main", "5511999999999", "whatsapp", true);
    });

    expect((payload.configuredRoute as Record<string, unknown>).agent).toBe("sales");
    expect((payload.liveEffect as Record<string, unknown>).status).toBe("verified");
  });

  it("prints route mutation results in --json mode", () => {
    pendingEntries = [
      {
        accountId: "main",
        phone: "5511999999999",
        name: "Alice",
        chatId: "5511999999999",
        isGroup: false,
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    liveWinner = {
      route: { pattern: "5511999999999" },
      agentId: "sales",
    };

    const payload = captureJson(() => {
      new InstancesRoutesCommands().add(
        "main",
        "5511999999999",
        "sales",
        "7",
        "open",
        undefined,
        undefined,
        "whatsapp",
        undefined,
        true,
      );
    });

    expect(payload.status).toBe("added");
    expect(payload.removedPending).toBe(true);
    expect((payload.route as Record<string, unknown>).priority).toBe(7);
    expect((payload.liveEffect as Record<string, unknown>).status).toBe("verified");
  });

  it("prints pending entries in --json mode", () => {
    pendingEntries = [
      {
        accountId: "main",
        phone: "group:123",
        name: "Launch",
        chatId: "group:123",
        isGroup: true,
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    const payload = captureJson(() => {
      new InstancesPendingCommands().list("main", true);
    });

    expect(payload.total).toBe(1);
    expect((payload.counts as Record<string, unknown>).chats).toBe(1);
    expect((payload.counts as Record<string, unknown>).contacts).toBe(0);
    const pending = payload.pending as Array<Record<string, unknown>>;
    const chats = payload.chats as Array<Record<string, unknown>>;
    expect(pending[0].type).toBe("group");
    expect(chats[0].routePattern).toBe("group:123");
  });

  it("approves pending chats by creating a route without approving a contact", () => {
    pendingEntries = [
      {
        accountId: "main",
        phone: "123@g.us",
        name: "Launch",
        chatId: "123@g.us",
        isGroup: true,
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    const payload = captureJson(() => {
      new InstancesPendingCommands().approve("main", "123@g.us", "sales", true);
    });

    expect(payload.reviewKind).toBe("chat");
    expect(payload.routePattern).toBe("group:123");
    expect(payload.removedPending).toBe(true);
    expect(allowContactCalls).toEqual([]);
    expect(routes).toContainEqual(expect.objectContaining({ pattern: "group:123", agent: "sales" }));
  });
});
