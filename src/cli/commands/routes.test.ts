import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { SessionEntry } from "../../router/types.js";

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
let writeCalls = 0;
let instanceNames = new Set<string>(["main"]);
let deleteInstanceCalls: string[] = [];
let contactStatuses = new Map<string, { status: string }>();
let allowContactCalls: string[] = [];
let liveWinner: { route?: { pattern?: string | null } | null; agentId: string } | null = null;
let matchRouteInputs: Array<Record<string, unknown>> = [];
let sessions: Array<Partial<SessionEntry> & Pick<SessionEntry, "sessionKey" | "agentId">> = [];
let deletedSessionKeys: string[] = [];
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
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  ...actualCliContextModule,
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
    emit: mock(async () => {
      writeCalls += 1;
    }),
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
  dbListInstances: () =>
    [...instanceNames].map((name) => ({
      name,
      channel: "whatsapp",
      agent: "main",
      dmPolicy: "open",
      groupPolicy: "open",
      contactIntakeMode: "off",
      enabled: true,
      instanceId: `omni-${name}`,
    })),
  dbUpsertInstance: () => {
    writeCalls += 1;
  },
  dbUpdateInstance: () => {
    writeCalls += 1;
  },
  dbDeleteInstance: (name: string) => {
    writeCalls += 1;
    deleteInstanceCalls.push(name);
    return instanceNames.delete(name);
  },
  dbRestoreInstance: () => {
    writeCalls += 1;
    return false;
  },
  dbListDeletedInstances: () => [],
  dbGetAgent: (id: string) => ({ id }),
  dbCreateAgent: () => {
    writeCalls += 1;
  },
  dbListAgents: () => [{ id: "main" }, { id: "sales" }],
  dbListChannels: () => [
    { name: "whatsapp", provider: "whatsapp", enabled: true, createdAt: 1, updatedAt: 1 },
    { name: "rbbt-slack", provider: "slack", enabled: true, createdAt: 1, updatedAt: 1 },
  ],
  dbGetRoute: (pattern: string, accountId: string) =>
    routes.find((route) => route.accountId === accountId && route.pattern === pattern) ?? null,
  dbListRoutes: (accountId?: string) => routes.filter((route) => (accountId ? route.accountId === accountId : true)),
  dbCreateRoute: (input: Record<string, unknown>) => {
    writeCalls += 1;
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
    writeCalls += 1;
    const route = routes.find((item) => item.accountId === accountId && item.pattern === pattern);
    if (!route) throw new Error("Route not found");
    Object.assign(route, updates);
    return route;
  },
  dbDeleteRoute: (pattern: string, accountId: string) => {
    writeCalls += 1;
    const before = routes.length;
    routes = routes.filter((route) => !(route.accountId === accountId && route.pattern === pattern));
    return routes.length !== before;
  },
  dbRestoreRoute: () => {
    writeCalls += 1;
    return true;
  },
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
  dbSetSetting: () => {
    writeCalls += 1;
  },
}));

mock.module("../../router/index.js", () => ({
  ...actualRouterIndexModule,
  loadRouterConfig: () => ({}),
  matchRoute: (_config: unknown, params: Record<string, unknown>) => {
    matchRouteInputs.push(params);
    return liveWinner;
  },
}));

mock.module("../../router/routes-readonly.js", () => ({
  readRoutesSnapshot: () => {
    const instances = [...instanceNames].map((name) => ({
      name,
      channel: "whatsapp",
      dmPolicy: "open",
      groupPolicy: "open",
      contactIntakeMode: "off",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }));
    const channels = [
      { name: "whatsapp", provider: "whatsapp", enabled: true, createdAt: 1, updatedAt: 1 },
      { name: "rbbt-slack", provider: "slack", enabled: true, createdAt: 1, updatedAt: 1 },
    ];
    return {
      dbPath: "/state/ravi.db",
      databaseExists: true,
      routes: routes.map((route) => ({ priority: 0, ...route })),
      instances,
      channels,
      tags: [],
      routerConfig: {
        agents: {
          main: { id: "main", cwd: "/tmp/main" },
          sales: { id: "sales", cwd: "/tmp/sales" },
        },
        routes: routes.map(({ id: _id, ...route }) => route),
        defaultAgent: "main",
        defaultDmScope: "per-peer",
        accountAgents: {},
        instanceToAccount: {},
        instances: Object.fromEntries(instances.map((instance) => [instance.name, instance])),
        channels: Object.fromEntries(channels.map((channel) => [channel.name, channel])),
      },
    };
  },
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
    writeCalls += 1;
    const before = pendingEntries.length;
    pendingEntries = pendingEntries.filter((entry) => !(entry.accountId === accountId && entry.phone === phone));
    return pendingEntries.length !== before;
  },
  allowContact: (contact: string) => {
    writeCalls += 1;
    allowContactCalls.push(contact);
  },
}));

mock.module("../../router/sessions.js", () => ({
  ...actualRouterSessionsModule,
  listSessions: () => sessions as SessionEntry[],
  deleteSession: (sessionKey: string) => {
    writeCalls += 1;
    deletedSessionKeys.push(sessionKey);
    sessions = sessions.filter((session) => session.sessionKey !== sessionKey);
  },
}));

mock.module("../runtime-target.js", () => ({
  inspectCliRuntimeTarget: (name: string) => ({
    name,
    instance: { exists: instanceNames.has(name) },
  }),
  inspectCliRuntimeTargetSnapshot: (name: string) => ({
    name,
    instance: { exists: instanceNames.has(name) },
  }),
  formatCliRuntimeTarget: (summary: { name: string }) => [`Target instance: ${summary.name}`],
  getCliRuntimeMismatchMessage: () => null,
}));

const { InstancesCommands, RoutesCommands, InstancesRoutesCommands, InstancesPendingCommands } = await import(
  "./instances.js"
);
const { ContractError } = await import("../agent-contract.js");
const { routeShowReturnSchema, routesListReturnSchema } = await import("./operational-return-schemas.js");

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

function captureThrown(run: () => unknown): unknown {
  const originalLog = console.log;
  console.log = () => {};
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  } finally {
    console.log = originalLog;
  }
  return thrown;
}

describe("routes public return schemas", () => {
  const pagination = {
    limit: 50,
    offset: 0,
    returned: 1,
    total: 1,
    hasMore: false,
    nextOffset: null,
    nextCommand: null,
  };

  it("accepts a typed compact projection and rejects an empty route item", () => {
    const base = {
      instance: null,
      filter: { tagSlug: null },
      total: 1,
      pagination,
    };

    expect(
      routesListReturnSchema.safeParse({ ...base, items: [{ pattern: "5511*" }], routes: [{ pattern: "5511*" }] })
        .success,
    ).toBe(true);
    expect(routesListReturnSchema.safeParse({ ...base, items: [{}], routes: [{}] }).success).toBe(false);
  });

  it("rejects undeclared fields from route details", () => {
    const route = {
      id: 1,
      pattern: "5511*",
      accountId: "main",
      agent: "sales",
      priority: 7,
      tags: [],
    };

    expect(routeShowReturnSchema.safeParse({ instance: "main", pattern: "5511*", route }).success).toBe(true);
    expect(
      routeShowReturnSchema.safeParse({ instance: "main", pattern: "5511*", route: { ...route, secret: true } })
        .success,
    ).toBe(false);
  });
});

describe("RoutesCommands", () => {
  beforeEach(() => {
    routes = [];
    writeCalls = 0;
    instanceNames = new Set(["main"]);
    deleteInstanceCalls = [];
    contactStatuses = new Map();
    allowContactCalls = [];
    liveWinner = null;
    matchRouteInputs = [];
    sessions = [];
    deletedSessionKeys = [];
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
    expect(output).toContain('Explain config simulation: ravi routes explain main "5511999999999"');
    expect(output).toContain('Mutate config:        ravi instances routes set main "5511999999999" <key> <value>');
  });

  it("explains configured routes as an honest persisted-config simulation", () => {
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
    expect(output).toContain("Evaluation:    persisted config simulation");
    expect(output).toContain("Daemon state:  not observed");
    expect(output).toContain("Config route:    5511999999999 → sales");
    expect(output).toContain("Simulation:      verified");
    expect(output).toContain("Winning route:   5511999999999");
    expect(output).toContain("Winning agent:   sales");
    expect(output).toContain('Route details: ravi routes show main "5511999999999"');
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
    expect(payload.origin).toEqual({
      kind: "config_simulation",
      source: "router-config-db",
      freshness: "persisted-at-read-time",
      daemonObserved: false,
      limitation: "This result does not inspect the daemon's in-memory router.",
    });
  });

  it("normalizes equivalent group formats through the router canonicalizer", () => {
    routes = [{ id: 1, accountId: "main", pattern: "123456789@g.us", agent: "sales", channel: "whatsapp" }];
    liveWinner = { route: { pattern: "123456789@g.us" }, agentId: "sales" };

    const payload = captureJson(() => {
      new RoutesCommands().explain("main", "group:123456789", "whatsapp", true);
    });

    expect((payload.configuredRoute as Record<string, unknown>).pattern).toBe("123456789@g.us");
    expect(payload.resolution).toEqual({
      matchedBy: "equivalent",
      canonicalPattern: "group:123456789",
      targetKind: "group",
    });
    expect((payload.liveEffect as Record<string, unknown>).status).toBe("verified");
    expect(matchRouteInputs[0]).toEqual(
      expect.objectContaining({ phone: "123456789", groupId: "123456789", isGroup: true, accountId: "main" }),
    );
  });

  it("normalizes phone-prefixed concrete formats without treating them as broad", () => {
    routes = [{ id: 1, accountId: "main", pattern: "5511999999999", agent: "sales", channel: "whatsapp" }];
    liveWinner = { route: { pattern: "5511999999999" }, agentId: "sales" };

    const payload = captureJson(() => {
      new RoutesCommands().explain("main", "phone:+55 (11) 99999-9999", "whatsapp", true);
    });

    expect((payload.configuredRoute as Record<string, unknown>).pattern).toBe("5511999999999");
    expect((payload.resolution as Record<string, unknown>).canonicalPattern).toBe("5511999999999");
    expect((payload.liveEffect as Record<string, unknown>).status).toBe("verified");
  });

  it("rejects an unknown channel with a typed usage error before simulation", () => {
    routes = [{ id: 1, accountId: "main", pattern: "5511999999999", agent: "sales" }];

    const thrown = captureThrown(() => new RoutesCommands().explain("main", "5511999999999", "bogus", true));

    expect(thrown).toBeInstanceOf(ContractError);
    const error = thrown as InstanceType<typeof ContractError>;
    expect(error.code).toBe("USAGE_ERROR");
    expect(error.exitCode).toBe(2);
    expect(error.details.acceptedChannels).toEqual(["rbbt-slack", "slack", "whatsapp"]);
    expect(matchRouteInputs).toHaveLength(0);
  });

  it("requires exact channel spelling when configured variants collide by case", () => {
    routes = [
      { id: 1, accountId: "main", pattern: "5511999999999", agent: "sales", channel: "whatsapp" },
      { id: 2, accountId: "main", pattern: "group:other", agent: "main", channel: "WhatsApp" },
    ];

    const thrown = captureThrown(() => new RoutesCommands().explain("main", "5511999999999", "WHATSAPP", true));

    expect(thrown).toBeInstanceOf(ContractError);
    const error = thrown as InstanceType<typeof ContractError>;
    expect(error.code).toBe("ROUTE_CHANNEL_AMBIGUOUS");
    expect(error.exitCode).toBe(2);
    expect(error.details.suggestions).toEqual(["WhatsApp", "whatsapp"]);
    expect(matchRouteInputs).toHaveLength(0);
  });

  it("uses the exact configured channel spelling when case variants coexist", () => {
    routes = [
      { id: 1, accountId: "main", pattern: "5511999999999", agent: "sales", channel: "whatsapp" },
      { id: 2, accountId: "main", pattern: "group:other", agent: "main", channel: "WhatsApp" },
    ];
    liveWinner = { route: { pattern: "5511999999999" }, agentId: "sales" };

    const payload = captureJson(() => {
      new RoutesCommands().explain("main", "5511999999999", "whatsapp", true);
    });

    expect(payload.channel).toBe("whatsapp");
    expect(matchRouteInputs[0]).toEqual(expect.objectContaining({ channel: "whatsapp" }));
  });

  it("fails closed when equivalent configured patterns are ambiguous", () => {
    routes = [
      { id: 1, accountId: "main", pattern: "123@g.us", agent: "sales" },
      { id: 2, accountId: "main", pattern: "group:123", agent: "main" },
    ];

    const thrown = captureThrown(() => new RoutesCommands().explain("main", "GROUP:123", undefined, true));

    expect(thrown).toBeInstanceOf(ContractError);
    const error = thrown as InstanceType<typeof ContractError>;
    expect(error.code).toBe("ROUTE_PATTERN_AMBIGUOUS");
    expect(error.exitCode).toBe(1);
    expect(error.details.suggestions).toEqual(["123@g.us", "group:123"]);
    expect(matchRouteInputs).toHaveLength(0);
  });

  it("keeps list, show, and explain deterministic and read-only", () => {
    routes = [{ id: 1, accountId: "main", pattern: "5511999999999", agent: "sales", channel: "whatsapp" }];
    liveWinner = { route: { pattern: "5511999999999" }, agentId: "sales" };
    const before = JSON.stringify(routes);

    const first = captureLogs(() => {
      new RoutesCommands().list("main", true);
      new RoutesCommands().show("main", "5511999999999", true);
      new RoutesCommands().explain("main", "5511999999999", "whatsapp", true);
    });
    const second = captureLogs(() => {
      new RoutesCommands().list("main", true);
      new RoutesCommands().show("main", "5511999999999", true);
      new RoutesCommands().explain("main", "5511999999999", "whatsapp", true);
    });

    expect(second).toBe(first);
    expect(JSON.stringify(routes)).toBe(before);
    expect(deleteInstanceCalls).toEqual([]);
    expect(allowContactCalls).toEqual([]);
    expect(deletedSessionKeys).toEqual([]);
    expect(writeCalls).toBe(0);
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

  it("cleans conflicting sessions only inside the mutated instance", () => {
    instanceNames = new Set(["main", "hana-zap"]);
    routes = [
      {
        id: 1,
        accountId: "hana-zap",
        pattern: "group:120363424772797713",
        agent: "dev",
        priority: 0,
      },
    ];
    sessions = [
      {
        sessionKey: "agent:dev:whatsapp:main:group:120363424772797713",
        agentId: "dev",
        accountId: "main",
        lastAccountId: "main",
      },
      {
        sessionKey: "agent:dev:whatsapp:hana-zap:group:120363424772797713",
        agentId: "dev",
        accountId: "hana-zap",
        lastAccountId: "hana-zap",
      },
    ];

    const payload = captureJson(() => {
      new InstancesRoutesCommands().set("hana-zap", "group:120363424772797713", "agent", "hana-zap", undefined, true);
    });

    expect(payload.cleanedSessions).toBe(1);
    expect(deletedSessionKeys).toEqual(["agent:dev:whatsapp:hana-zap:group:120363424772797713"]);
    expect(sessions.map((session) => session.sessionKey)).toEqual(["agent:dev:whatsapp:main:group:120363424772797713"]);
  });

  it("cleans Slack channel sessions case-insensitively", () => {
    instanceNames = new Set(["ravi-rbbt-slack"]);
    routes = [
      {
        id: 1,
        accountId: "ravi-rbbt-slack",
        pattern: "group:c0bg33zuwjc",
        agent: "ravi-rbbt-slack",
        priority: 0,
        channel: "slack",
      },
    ];
    sessions = [
      {
        sessionKey: "agent:ravi-rbbt-slack:slack:ravi-rbbt-slack:group:C0BG33ZUWJC",
        agentId: "ravi-rbbt-slack",
        accountId: "ravi-rbbt-slack",
        lastAccountId: "ravi-rbbt-slack",
      },
    ];

    const payload = captureJson(() => {
      new InstancesRoutesCommands().set(
        "ravi-rbbt-slack",
        "group:c0bg33zuwjc",
        "agent",
        "ravi-channels-migration",
        undefined,
        true,
      );
    });

    expect(payload.cleanedSessions).toBe(1);
    expect(deletedSessionKeys).toEqual(["agent:ravi-rbbt-slack:slack:ravi-rbbt-slack:group:C0BG33ZUWJC"]);
    expect(sessions).toEqual([]);
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

describe("instances/routes agent-first contract", () => {
  beforeEach(() => {
    routes = [];
    writeCalls = 0;
    instanceNames = new Set(["main"]);
    deleteInstanceCalls = [];
    contactStatuses = new Map();
    allowContactCalls = [];
    liveWinner = null;
    matchRouteInputs = [];
    sessions = [];
    deletedSessionKeys = [];
    pendingEntries = [];
  });

  it("soft-deletes the instance immediately without --execute", () => {
    const payload = captureJson(() => {
      new InstancesCommands().delete("main", true);
    });

    expect(payload.status).toBe("deleted");
    expect(deleteInstanceCalls).toEqual(["main"]);
    expect(instanceNames.has("main")).toBe(false);
  });

  it("emits INSTANCE_CONNECT_TIMEOUT when an instance connection times out", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    const originalSetTimeout = globalThis.setTimeout;
    const timeoutDelays: number[] = [];
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      timeoutDelays.push(delay ?? 0);
      queueMicrotask(() => callback(...args));
      return 1;
    }) as unknown as typeof setTimeout;
    try {
      const result = new InstancesCommands().connect("main", undefined, undefined, true).then(
        () => undefined,
        (error: unknown) => error,
      );
      const caught = await result;

      expect(timeoutDelays).toEqual([120_000]);
      expect(caught).toBeInstanceOf(ContractError);
      const contractError = caught as InstanceType<typeof ContractError>;
      expect(contractError.code).toBe("INSTANCE_CONNECT_TIMEOUT");
      expect(contractError.exitCode).toBe(1);
      expect(contractError.details.retryable).toBe(true);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        success: false,
        op: "instances connect",
        error: { code: "INSTANCE_CONNECT_TIMEOUT", retryable: true },
      });
    } finally {
      console.log = originalLog;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("emits INSTANCE_NOT_FOUND envelope with suggestions on --json (exit 1)", () => {
    instanceNames = new Set(["main", "vendas"]);

    const thrown = captureThrown(() => new InstancesCommands().delete("mainn", true));

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("instances delete");
    expect(envelope.error.code).toBe("INSTANCE_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("main");
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
    expect(deleteInstanceCalls).toHaveLength(0);
  });

  it("emits ROUTE_NOT_FOUND envelope with pattern suggestions on --json (exit 1)", () => {
    routes = [{ id: 1, accountId: "main", pattern: "5511999*", agent: "sales" }];

    const thrown = captureThrown(() => new InstancesRoutesCommands().remove("main", "5511*", undefined, true));

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("instances routes remove");
    expect(envelope.error.code).toBe("ROUTE_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("5511999*");
    expect(routes).toHaveLength(1);
  });

  it("soft-deletes an instance route immediately without --execute", () => {
    routes = [{ id: 1, accountId: "main", pattern: "5511*", agent: "sales", priority: 7, channel: "whatsapp" }];

    const payload = captureJson(() => {
      new InstancesRoutesCommands().remove("main", "5511*", undefined, true);
    });

    expect(payload.status).toBe("removed");
    expect(routes).toHaveLength(0);
  });

  it("minimizes pending reject to instance, kind, and presence flags", () => {
    pendingEntries = [
      {
        accountId: "main",
        phone: "+5511999997777",
        name: "PRIVATE_MESSAGE_8K2R",
        chatId: "PRIVATE_MESSAGE_8K2R",
        isGroup: false,
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    const thrown = captureThrown(() => new InstancesPendingCommands().reject("main", "+5511999997777", true));

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("instances pending reject");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.plan).toEqual({
      instance: "main",
      contactPresent: true,
      pendingFound: true,
      kind: "contact",
      phonePresent: true,
      chatIdPresent: true,
      namePresent: true,
    });
    const serialized = JSON.stringify(envelope.error.plan);
    expect(serialized).not.toContain("+5511999997777");
    expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(pendingEntries).toHaveLength(1);
  });

  it("rejects the pending entry with --execute", () => {
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

    const payload = captureJson(() => {
      new InstancesPendingCommands().reject("main", "5511999999999", true, true);
    });

    expect(payload.status).toBe("rejected");
    expect(pendingEntries).toHaveLength(0);
  });

  it("supports --fields compact mode on routes list", () => {
    routes = [{ id: 1, accountId: "main", pattern: "5511*", agent: "sales", priority: 7, channel: "whatsapp" }];

    const payload = captureJson(() => {
      new RoutesCommands().list(undefined, true, undefined, undefined, undefined, "pattern,agent");
    });

    const items = payload.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual(["agent", "pattern"]);
  });

  it("rejects unknown --fields even when the routes page is empty", () => {
    const thrown = captureThrown(() =>
      new RoutesCommands().list(undefined, true, undefined, undefined, undefined, "bogus"),
    );

    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
    expect((thrown as { exitCode?: number }).exitCode).toBe(2);
    expect((thrown as { details?: { acceptedFields?: string[] } }).details?.acceptedFields).toEqual([
      "id",
      "accountId",
      "pattern",
      "agent",
      "priority",
      "policy",
      "session",
      "channel",
      "dmScope",
      "tags",
    ]);
  });

  it("returns typed pagination causes and preserves the next-page command", () => {
    routes = [
      { id: 1, accountId: "main", pattern: "1", agent: "main" },
      { id: 2, accountId: "main", pattern: "2", agent: "sales" },
    ];

    const invalid = captureThrown(() => new RoutesCommands().list("main", true, undefined, "abc"));
    expect((invalid as { code?: string }).code).toBe("USAGE_ERROR");
    expect((invalid as Error).message).toContain("--limit must be an integer");

    const excessive = captureThrown(() => new RoutesCommands().list("main", true, undefined, "501"));
    expect((excessive as { code?: string }).code).toBe("USAGE_ERROR");
    expect((excessive as { details?: { maximum?: number } }).details?.maximum).toBe(500);

    const payload = captureJson(() => new RoutesCommands().list("main", true, undefined, "1", "0", "pattern"));
    const pagination = payload.pagination as Record<string, unknown>;
    expect(pagination.hasMore).toBe(true);
    expect(pagination.nextOffset).toBe(1);
    expect(pagination.nextCommand).toBe("ravi routes list main --json --limit 1 --offset 1 --fields pattern");
  });

  it("supports --fields compact mode on instances list", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      await new InstancesCommands().list(true, undefined, undefined, undefined, "name,channel");
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines.join("\n")) as Record<string, unknown>;
    const items = payload.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual(["channel", "name"]);
  });
});
