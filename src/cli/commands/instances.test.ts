/**
 * `ravi instances` transport tests: WhatsApp always goes through the `ravi channels`
 * runner; Telegram/Discord go through the legacy bridge (Omni), loaded on demand.
 *
 * Uses an isolated Ravi state (real router DB), a fake NATS RPC connection for the
 * WhatsApp runner, a fake legacy bridge client, and a fake pairing-event bus standing in
 * for the daemon's `ravi.whatsapp.*` / `ravi.bridge.*` relay.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { createWhatsAppClient } from "../../channels/whatsapp/client.js";
import {
  WhatsAppRpcRequestSchema,
  type WhatsAppRpcMethod,
  type WhatsAppRpcRequest,
} from "../../channels/whatsapp/contract.js";
import { ensureWhatsAppInstance } from "../../channels/whatsapp/provisioning.js";
import type { WhatsAppRpcConnection } from "../../channels/whatsapp/rpc-client.js";
import { loadRouterConfig } from "../../router/config.js";
import {
  dbDeleteInstance,
  dbGetAgent,
  dbGetChannel,
  dbGetInstance,
  dbListDeletedInstances,
  dbUpdateChannel,
  dbUpdateInstance,
  dbUpsertChannel,
  dbUpsertInstance,
} from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

// Manual v2 contract: hasContext() true makes the contract helpers throw
// ContractError instead of process.exit, which is what tests need.
const actualContext = await import("../context.js");
mock.module("../context.js", () => ({
  ...actualContext,
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { InstancesCommands, connectViaLegacyBridge, setInstancesTransportDependenciesForTests } = await import(
  "./instances.js"
);
const { ContractError, installUsageContract } = await import("../agent-contract.js");
const { registerCommands } = await import("../registry.js");

afterAll(() => mock.restore());

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type RpcHandler = (request: WhatsAppRpcRequest) => unknown;
type PairingEvent = { topic: string; data: Record<string, unknown> };
type Deps = NonNullable<Parameters<typeof setInstancesTransportDependenciesForTests>[0]>;
type LegacyClient = NonNullable<Awaited<ReturnType<NonNullable<Deps["legacy"]>>>>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NO_RESPONDERS = () => Object.assign(new Error("503"), { code: "503" });

function fakeRunner(handlers: Partial<Record<WhatsAppRpcMethod, RpcHandler>>) {
  const calls: Array<{ subject: string; request: WhatsAppRpcRequest; timeout: number }> = [];
  let unavailableFor = 0;
  const connection: WhatsAppRpcConnection = {
    async request(subject, data, options) {
      const request = WhatsAppRpcRequestSchema.parse(JSON.parse(new TextDecoder().decode(data)));
      calls.push({ subject, request, timeout: options.timeout });
      if (unavailableFor > 0) {
        unavailableFor -= 1;
        throw NO_RESPONDERS();
      }
      const handler = handlers[request.method];
      const response = handler
        ? { ok: true, requestId: request.requestId, data: handler(request) }
        : {
            ok: false,
            requestId: request.requestId,
            error: { status: 400, code: "INVALID_REQUEST", message: `no handler for ${request.method}` },
          };
      return { data: new TextEncoder().encode(JSON.stringify(response)) };
    },
  };
  return {
    connection,
    calls,
    methods: () => calls.map((call) => call.request.method),
    /** The next `n` requests get "no responders" (runner not up / channel not hot-added yet). */
    failNext(n: number) {
      unavailableFor = n;
    },
  };
}

function fakeBus() {
  const queue: PairingEvent[] = [];
  const subscriptions: string[][] = [];
  let wake: (() => void) | null = null;
  return {
    subscriptions,
    push(event: PairingEvent) {
      queue.push(event);
      wake?.();
    },
    subscribe(...topics: string[]): AsyncIterable<PairingEvent> {
      subscriptions.push(topics);
      return (async function* () {
        for (;;) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      })();
    },
  };
}

function fakeLegacy(overrides: Partial<LegacyClient> = {}) {
  const calls: string[] = [];
  const client: LegacyClient = {
    async list() {
      calls.push("list");
      return { items: [] };
    },
    async create(body) {
      calls.push(`create ${body.channel}`);
      return { id: "legacy-created" };
    },
    async status(id) {
      calls.push(`status ${id}`);
      return { state: "disconnected", isConnected: false, profileName: null };
    },
    async connect(id) {
      calls.push(`connect ${id}`);
      return { status: "connecting", message: "" };
    },
    async disconnect(id) {
      calls.push(`disconnect ${id}`);
    },
    ...overrides,
  };
  return { client, calls };
}

const OFFLINE_STATUS = { state: "disconnected", isConnected: false, profileName: null };
const CONNECTED_STATUS = { state: "connected", isConnected: true, profileName: "Ravi Bot" };

let stateDir: string | null = null;
let output: string[] = [];
let configChanged = 0;
let exitCodes: number[] = [];
let printedQrs: string[] = [];
let legacyLoads = 0;
let clearedAuth: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalFetch = globalThis.fetch;
const originalOmniUrl = process.env.OMNI_API_URL;
const originalOmniKey = process.env.OMNI_API_KEY;

function useDeps(options: {
  runner?: ReturnType<typeof fakeRunner>;
  bus?: ReturnType<typeof fakeBus>;
  /** A fake legacy bridge; `null` = not configured; `"default"` = the real dynamic-import loader. */
  legacy?: LegacyClient | null | "default";
  runnerRetryTimeoutMs?: number;
}) {
  const bus = options.bus ?? fakeBus();
  const runner = options.runner ?? fakeRunner({});
  const legacy = options.legacy ?? null;
  setInstancesTransportDependenciesForTests({
    whatsapp: () => createWhatsAppClient({ getConfig: () => loadRouterConfig(), connection: runner.connection }),
    ...(legacy === "default"
      ? {}
      : {
          legacy: async () => {
            legacyLoads += 1;
            return legacy;
          },
        }),
    provision: (name, provisionOptions) =>
      ensureWhatsAppInstance(name, { ...provisionOptions, refreshConfig: () => {} }),
    clearWhatsAppAuthState: async (instanceId) => {
      clearedAuth.push(instanceId);
      return 3;
    },
    subscribe: (...topics) => bus.subscribe(...topics),
    ensureNats: async () => undefined,
    emitConfigChanged: () => {
      configChanged += 1;
    },
    sleep: async () => undefined,
    printQr: (qr) => {
      printedQrs.push(qr);
    },
    exit: (code) => {
      exitCodes.push(code);
    },
    runnerRetryTimeoutMs: options.runnerRetryTimeoutMs ?? 1_000,
    runnerRetryIntervalMs: 1,
    pairingTimeoutMs: 2_000,
  });
  return bus;
}

function jsonOutput(): Record<string, unknown> {
  const text = output.join("\n");
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`no JSON output: ${text}`);
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

async function expectContractError(run: () => unknown, code: string) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ContractError);
  const error = caught as InstanceType<typeof ContractError>;
  expect(error.code).toBe(code);
  return error;
}

function fakeOmniFetch(routes: Record<string, unknown>) {
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname.replace(/^\/api\/v2/, "")}`;
    requests.push(key);
    if (key in routes) return Response.json(routes[key]);
    return Response.json({ error: { message: `unexpected ${key}` } }, { status: 500 });
  }) as unknown as typeof fetch;
  return { requests };
}

/** An instance already bound to a WhatsApp channel. */
function seedWhatsAppInstance(name = "wa-main", instanceId = "11111111-1111-4111-8111-111111111111") {
  dbUpsertInstance({ name, instanceId, channel: "whatsapp" });
  dbUpsertChannel({ name, provider: "whatsapp" });
  return instanceId;
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-instances-cli-");
  output = [];
  configChanged = 0;
  exitCodes = [];
  printedQrs = [];
  legacyLoads = 0;
  clearedAuth = [];
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  console.error = () => {};
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  globalThis.fetch = originalFetch;
  if (originalOmniUrl === undefined) delete process.env.OMNI_API_URL;
  else process.env.OMNI_API_URL = originalOmniUrl;
  if (originalOmniKey === undefined) delete process.env.OMNI_API_KEY;
  else process.env.OMNI_API_KEY = originalOmniKey;
  setInstancesTransportDependenciesForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

// ---------------------------------------------------------------------------
// connect: WhatsApp
// ---------------------------------------------------------------------------

describe("instances connect (WhatsApp)", () => {
  it("whatsapp connect always uses the runner, even with the legacy bridge configured", async () => {
    const bus = fakeBus();
    const runner = fakeRunner({
      "connection.status": () => OFFLINE_STATUS,
      "connection.connect": (request) => {
        // The runner starts a socket; the daemon relays the QR code it publishes.
        bus.push({ topic: `ravi.whatsapp.qr.${request.instanceId}`, data: { type: "qr", qr: "QR-DATA" } });
        return { status: "connecting", message: "Waiting for QR code" };
      },
    });
    const legacy = fakeLegacy();
    useDeps({ runner, bus, legacy: legacy.client });

    await new InstancesCommands().connect("wa-test", undefined, undefined, true);

    const instance = dbGetInstance("wa-test");
    expect(instance?.channel).toBe("whatsapp");
    expect(instance?.instanceId).toMatch(UUID_RE);
    const instanceId = instance?.instanceId as string;
    expect(dbGetChannel("wa-test")?.provider).toBe("whatsapp");
    expect(configChanged).toBeGreaterThan(0);

    expect(runner.methods()).toEqual(["connection.status", "connection.connect"]);
    expect(runner.calls.every((call) => call.subject === `_RAVI.channels.whatsapp.rpc.${instanceId}`)).toBe(true);
    expect(runner.calls[1]?.request.params).toEqual({ whatsapp: { syncFullHistory: false } });
    expect(bus.subscriptions).toEqual([[`ravi.whatsapp.qr.${instanceId}`, `ravi.whatsapp.connected.${instanceId}`]]);
    expect(legacyLoads).toBe(0);
    expect(legacy.calls).toEqual([]);

    const json = jsonOutput();
    expect(json).toMatchObject({
      status: "qr_required",
      instanceId,
      channel: "whatsapp",
      qr: "QR-DATA",
      transport: "whatsapp",
      channelName: "wa-test",
      createdInstance: true,
      createdChannel: true,
      mintedInstanceId: true,
      changedCount: 1,
    });
    expect(json).not.toHaveProperty("createdOmniInstance");
  });

  it("keeps an existing instance UUID and agent and reports the connected event", async () => {
    const existingId = "22222222-2222-4222-8222-222222222222";
    dbUpsertInstance({ name: "wa-migrate", instanceId: existingId, channel: "whatsapp-baileys", agent: "main" });
    const bus = fakeBus();
    const runner = fakeRunner({
      "connection.status": () => OFFLINE_STATUS,
      "connection.connect": () => {
        bus.push({
          topic: `ravi.whatsapp.connected.${existingId}`,
          data: { type: "connected", profileName: "Ravi Bot", ownerIdentifier: "5511999@s.whatsapp.net" },
        });
        return { status: "connecting", message: "Reconnecting with saved credentials" };
      },
    });
    useDeps({ runner, bus });

    await new InstancesCommands().connect("wa-migrate", undefined, undefined, true);

    expect(dbGetInstance("wa-migrate")?.instanceId).toBe(existingId);
    expect(dbGetInstance("wa-migrate")?.agent).toBe("main");
    expect(jsonOutput()).toMatchObject({
      status: "connected",
      instanceId: existingId,
      live: { type: "connected", profileName: "Ravi Bot" },
      transport: "whatsapp",
      createdInstance: false,
      createdChannel: true,
      mintedInstanceId: false,
    });
  });

  it("prints QR codes in text mode and exits once the connected event arrives", async () => {
    const bus = fakeBus();
    const runner = fakeRunner({
      "connection.status": () => OFFLINE_STATUS,
      "connection.connect": (request) => {
        bus.push({ topic: `ravi.whatsapp.qr.${request.instanceId}`, data: { type: "qr", qr: "QR-1" } });
        bus.push({
          topic: `ravi.whatsapp.connected.${request.instanceId}`,
          data: { type: "connected", profileName: "Bot" },
        });
        return { status: "connecting", message: "" };
      },
    });
    useDeps({ runner, bus });

    await new InstancesCommands().connect("wa-text", undefined, undefined, false);

    expect(printedQrs).toEqual(["QR-1"]);
    expect(output.join("\n")).toContain("✓ Connected as Bot");
    expect(exitCodes).toEqual([0]);
  });

  it("reports an already connected instance without asking for a new socket", async () => {
    const instanceId = seedWhatsAppInstance();
    const runner = fakeRunner({ "connection.status": () => CONNECTED_STATUS });
    const bus = useDeps({ runner });

    await new InstancesCommands().connect("wa-main", undefined, undefined, true);

    expect(runner.methods()).toEqual(["connection.status"]);
    expect(bus.subscriptions).toEqual([]);
    expect(jsonOutput()).toMatchObject({
      status: "connected",
      instanceId,
      live: CONNECTED_STATUS,
      transport: "whatsapp",
      createdChannel: false,
    });
  });

  it("retries while the runner hot-adds the new channel", async () => {
    const runner = fakeRunner({ "connection.status": () => ({ ...CONNECTED_STATUS, profileName: null }) });
    runner.failNext(2);
    useDeps({ runner });

    await new InstancesCommands().connect("wa-hot", undefined, undefined, true);

    expect(runner.methods()).toEqual(["connection.status", "connection.status", "connection.status"]);
    expect(jsonOutput()).toMatchObject({ status: "connected", transport: "whatsapp" });
  });

  it("tells the user to start the channel runner when nobody answers the RPC", async () => {
    const runner = fakeRunner({});
    runner.failNext(Number.MAX_SAFE_INTEGER);
    const bus = useDeps({ runner, runnerRetryTimeoutMs: 0 });

    const error = await expectContractError(
      () => new InstancesCommands().connect("wa-down", undefined, undefined, true),
      "WHATSAPP_RUNNER_UNAVAILABLE",
    );

    expect(error.message).toContain("ravi channels start");
    expect(String(error.details.suggestedAction)).toContain("ravi channels restart");
    expect(String(error.details.suggestedAction)).not.toContain("--transport");
    expect(bus.subscriptions).toEqual([]);
    // The instance and channel stay provisioned, so a retry after `ravi channels start` just connects.
    expect(dbGetChannel("wa-down")?.provider).toBe("whatsapp");
  });

  it("creates a missing --agent before pointing the instance at it", async () => {
    const runner = fakeRunner({ "connection.status": () => CONNECTED_STATUS });
    useDeps({ runner });

    await new InstancesCommands().connect("wa-agent", undefined, "wa-new-agent", true);

    expect(dbGetAgent("wa-new-agent")).toBeTruthy();
    expect(dbGetInstance("wa-agent")?.agent).toBe("wa-new-agent");
    expect(jsonOutput()).toMatchObject({ status: "connected", createdAgent: { id: "wa-new-agent" } });
  });

  it("refuses a soft-deleted instance name with a usage error and writes nothing", async () => {
    dbUpsertInstance({ name: "wa-gone", instanceId: "33333333-3333-4333-8333-333333333333", channel: "whatsapp" });
    dbDeleteInstance("wa-gone");
    const runner = fakeRunner({});
    useDeps({ runner });

    const error = await expectContractError(
      () => new InstancesCommands().connect("wa-gone", undefined, undefined, true),
      "USAGE_ERROR",
    );

    expect(error.exitCode).toBe(2);
    expect(String(error.details.suggestedAction)).toContain("ravi instances restore wa-gone");
    expect(runner.calls).toEqual([]);
    expect(dbGetChannel("wa-gone")).toBeNull();
    expect(dbListDeletedInstances().find((inst) => inst.name === "wa-gone")?.instanceId).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it("refuses a same-named WhatsApp channel bound to another instance", async () => {
    seedWhatsAppInstance("wa-other", "44444444-4444-4444-8444-444444444444");
    dbUpsertChannel({ name: "wa-clash", provider: "whatsapp", defaults: { instance: "wa-other" } });
    const runner = fakeRunner({});
    useDeps({ runner });

    await expectContractError(
      () => new InstancesCommands().connect("wa-clash", undefined, undefined, true),
      "WHATSAPP_INSTANCE_CONFLICT",
    );

    expect(runner.calls).toEqual([]);
    expect(dbGetInstance("wa-clash")).toBeNull();
  });

  it("`--transport` is rejected as an unknown option (usage error, exit 2)", async () => {
    const runner = fakeRunner({});
    useDeps({ runner });
    const program = new CommanderCommand();
    program.name("ravi");
    registerCommands(program, [InstancesCommands]);
    installUsageContract(program, "instances");

    const error = await expectContractError(
      () =>
        program.parseAsync(["instances", "connect", "wa-flag", "--transport", "native", "--json"], { from: "user" }),
      "USAGE_ERROR",
    );

    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("--transport");
    expect(runner.calls).toEqual([]);
    expect(dbGetInstance("wa-flag")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// connect / create: unsupported WhatsApp-family channels
// ---------------------------------------------------------------------------

describe("unsupported WhatsApp-family channels", () => {
  it("connect/create with twilio-whatsapp → USAGE_ERROR, no RPC, no bridge import, nothing written", async () => {
    const runner = fakeRunner({});
    useDeps({ runner, legacy: fakeLegacy().client });

    const connectError = await expectContractError(
      () => new InstancesCommands().connect("wa-twilio", "twilio-whatsapp", undefined, true),
      "USAGE_ERROR",
    );
    expect(connectError.exitCode).toBe(2);
    expect(connectError.message).toBe(
      'Channel "twilio-whatsapp" is not supported. WhatsApp runs natively in ravi: use --channel whatsapp.',
    );

    const createError = await expectContractError(
      () => new InstancesCommands().create("wa-gupshup", "gupshup", undefined, undefined, undefined, undefined, true),
      "USAGE_ERROR",
    );
    expect(createError.exitCode).toBe(2);

    expect(runner.calls).toEqual([]);
    expect(legacyLoads).toBe(0);
    expect(dbGetInstance("wa-twilio")).toBeNull();
    expect(dbGetInstance("wa-gupshup")).toBeNull();
    expect(configChanged).toBe(0);
  });

  it("an existing twilio-whatsapp instance is refused too", async () => {
    dbUpsertInstance({
      name: "wa-legacy-twilio",
      instanceId: "55555555-5555-4555-8555-555555555555",
      channel: "twilio-whatsapp",
    });
    const runner = fakeRunner({});
    useDeps({ runner, legacy: fakeLegacy().client });

    await expectContractError(
      () => new InstancesCommands().connect("wa-legacy-twilio", undefined, undefined, true),
      "USAGE_ERROR",
    );
    expect(runner.calls).toEqual([]);
    expect(legacyLoads).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// connect: legacy bridge
// ---------------------------------------------------------------------------

describe("instances connect (legacy bridge)", () => {
  it("telegram uses the legacy bridge via dynamic import and waits on ravi.bridge.*", async () => {
    process.env.OMNI_API_URL = "http://omni.local";
    process.env.OMNI_API_KEY = "k";
    const omni = fakeOmniFetch({
      "GET /instances": { items: [] },
      "POST /instances": { data: { id: "tg-uuid" } },
      "GET /instances/tg-uuid/status": { data: { state: "disconnected", isConnected: false } },
      "POST /instances/tg-uuid/connect": { data: { status: "connecting" } },
    });
    const bus = fakeBus();
    bus.push({ topic: "ravi.bridge.qr.tg-uuid", data: { type: "qr", qr: "TG-QR" } });
    const runner = fakeRunner({});
    useDeps({ runner, bus, legacy: "default" });

    await new InstancesCommands().connect("tg-main", "telegram", undefined, true);

    expect(omni.requests).toEqual([
      "GET /instances",
      "POST /instances",
      "GET /instances/tg-uuid/status",
      "POST /instances/tg-uuid/connect",
    ]);
    expect(bus.subscriptions).toEqual([["ravi.bridge.qr.tg-uuid", "ravi.bridge.connected.tg-uuid"]]);
    expect(runner.calls).toEqual([]);
    expect(dbGetInstance("tg-main")).toMatchObject({ instanceId: "tg-uuid", channel: "telegram" });
    expect(dbGetChannel("tg-main")).toBeNull();
    expect(jsonOutput()).toMatchObject({
      status: "qr_required",
      instanceId: "tg-uuid",
      channel: "telegram",
      qr: "TG-QR",
      transport: "omni",
      createdOmniInstance: true,
    });
  });

  it("telegram without a configured bridge fails clearly", async () => {
    useDeps({ legacy: null });

    await expect(new InstancesCommands().connect("tg-none", "telegram", undefined, true)).rejects.toThrow(
      "Legacy bridge (Omni) not configured",
    );
    expect(dbGetInstance("tg-none")).toBeNull();
  });

  it("connectViaLegacyBridge refuses whatsapp before touching the bridge", async () => {
    const legacy = fakeLegacy();
    useDeps({ legacy: legacy.client });

    for (const channel of ["whatsapp", "whatsapp-baileys", "twilio-whatsapp"]) {
      const error = await expectContractError(
        () =>
          connectViaLegacyBridge("wa-bridge", channel, undefined, true, {
            ...({} as Deps),
            legacy: async () => {
              legacyLoads += 1;
              return legacy.client;
            },
          } as Parameters<typeof connectViaLegacyBridge>[4]),
        "USAGE_ERROR",
      );
      expect(error.exitCode).toBe(2);
    }
    expect(legacyLoads).toBe(0);
    expect(legacy.calls).toEqual([]);
    expect(dbGetInstance("wa-bridge")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("instances create", () => {
  it("create provisions UUID + channel row", async () => {
    useDeps({});

    const payload = new InstancesCommands().create("vendas", undefined, "main", "closed", undefined, undefined, true);

    const instance = dbGetInstance("vendas");
    expect(instance).toMatchObject({ channel: "whatsapp", agent: "main", dmPolicy: "closed" });
    expect(instance?.instanceId).toMatch(UUID_RE);
    expect(dbGetChannel("vendas")).toMatchObject({ provider: "whatsapp", enabled: true });
    expect(payload).toMatchObject({
      status: "created",
      instanceId: instance?.instanceId,
      transport: "whatsapp",
      channel: { name: "vendas", created: true },
      changedCount: 2,
    });
    expect(configChanged).toBe(1);
  });

  it("create uses a sanitized channel name + defaults.instance for an invalid name", async () => {
    useDeps({});

    const payload = new InstancesCommands().create(
      "Loja São Paulo",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(payload).toMatchObject({ status: "created", channel: { name: "Loja-Sao-Paulo", created: true } });
    expect(dbGetChannel("Loja-Sao-Paulo")).toMatchObject({
      provider: "whatsapp",
      defaults: { instance: "Loja São Paulo" },
    });
    expect(dbGetInstance("Loja São Paulo")?.instanceId).toMatch(UUID_RE);
  });

  it("create telegram stays a plain instance row (no UUID, no channel row)", async () => {
    useDeps({});

    const payload = new InstancesCommands().create("tg", "telegram", undefined, undefined, undefined, undefined, true);

    expect(payload).toMatchObject({ status: "created", changedCount: 1 });
    expect(dbGetInstance("tg")).toMatchObject({ channel: "telegram" });
    expect(dbGetInstance("tg")?.instanceId).toBeUndefined();
    expect(dbGetChannel("tg")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// status / show / list / disconnect
// ---------------------------------------------------------------------------

describe("instances live status", () => {
  it("status reads the WhatsApp runner", async () => {
    const instanceId = seedWhatsAppInstance();
    const runner = fakeRunner({ "connection.status": () => CONNECTED_STATUS });
    useDeps({ runner });

    const payload = await new InstancesCommands().status("wa-main", true);

    expect(runner.calls[0]?.subject).toBe(`_RAVI.channels.whatsapp.rpc.${instanceId}`);
    expect(payload).toMatchObject({ status: "connected", transport: "whatsapp", live: CONNECTED_STATUS });
    expect(legacyLoads).toBe(0);
  });

  it("status explains a stopped runner", async () => {
    seedWhatsAppInstance();
    const runner = fakeRunner({});
    runner.failNext(1);
    useDeps({ runner });

    await expect(new InstancesCommands().status("wa-main", true)).rejects.toThrow("ravi channels start");
  });

  it("status no_instance_id", async () => {
    dbUpsertInstance({ name: "wa-bare", channel: "whatsapp" });
    const runner = fakeRunner({});
    useDeps({ runner });

    const payload = await new InstancesCommands().status("wa-bare", true);

    expect(payload).toMatchObject({ status: "no_instance_id", live: null, transport: "whatsapp" });
    expect(runner.calls).toEqual([]);
  });

  it("status of a telegram instance asks the legacy bridge", async () => {
    dbUpsertInstance({ name: "tg", instanceId: "tg-uuid", channel: "telegram" });
    const legacy = fakeLegacy({
      async status() {
        return { state: "connected", isConnected: true, profileName: "TG Bot" };
      },
    });
    useDeps({ legacy: legacy.client });

    const payload = await new InstancesCommands().status("tg", true);

    expect(payload).toMatchObject({ status: "connected", transport: "omni", live: { profileName: "TG Bot" } });
  });

  it("status of a telegram instance without the bridge says it is not configured", async () => {
    dbUpsertInstance({ name: "tg", instanceId: "tg-uuid", channel: "telegram" });
    useDeps({ legacy: null });

    await expect(new InstancesCommands().status("tg", true)).rejects.toThrow("Legacy bridge (Omni) not configured");
  });

  it("show includes the WhatsApp live status and transport", async () => {
    seedWhatsAppInstance();
    const runner = fakeRunner({ "connection.status": () => ({ state: "qr", isConnected: false, profileName: null }) });
    useDeps({ runner });

    const payload = await new InstancesCommands().show("wa-main", true);

    expect(payload).toMatchObject({ transport: "whatsapp", live: { state: "qr", isConnected: false } });
  });

  it("list asks the runner for WhatsApp rows, the bridge for the others, and drops Omni WhatsApp-family items", async () => {
    const waId = seedWhatsAppInstance();
    dbUpsertInstance({ name: "tg", instanceId: "tg-uuid", channel: "telegram" });
    dbUpsertInstance({ name: "dc", instanceId: "dc-uuid", channel: "discord" });
    dbUpsertInstance({ name: "tw", instanceId: "tw-uuid", channel: "twilio-whatsapp" });
    const legacy = fakeLegacy({
      async list() {
        return {
          items: [
            { id: "tg-uuid", name: "tg", channel: "telegram", isActive: true, profileName: "TG Bot" },
            // A stale Omni WhatsApp record that happens to share a ravi instance id: ignored.
            { id: "dc-uuid", name: "dc", channel: "whatsapp-baileys", isActive: true, profileName: "Omni WA" },
            { id: waId, name: "wa-main", channel: "whatsapp-baileys", isActive: false, profileName: "Omni WA" },
          ],
        };
      },
    });
    const runner = fakeRunner({ "connection.status": () => CONNECTED_STATUS });
    useDeps({ runner, legacy: legacy.client });

    const payload = (await new InstancesCommands().list(true)) as {
      items: Array<{ name: string; transport: string | null; live: Record<string, unknown> | null }>;
    };

    const byName = Object.fromEntries(payload.items.map((item) => [item.name, item]));
    expect(byName["wa-main"]).toMatchObject({
      transport: "whatsapp",
      live: { isConnected: true, profileName: "Ravi Bot", state: "connected" },
    });
    expect(byName.tg?.transport).toBe("omni");
    expect(byName.tg?.live).toEqual({ isConnected: true, profileName: "TG Bot" });
    expect(byName.dc).toMatchObject({ transport: "omni", live: null });
    expect(byName.tw).toMatchObject({ transport: null, live: null });
    expect(runner.calls.map((call) => call.subject)).toEqual([`_RAVI.channels.whatsapp.rpc.${waId}`]);
    expect(runner.calls[0]?.timeout).toBe(2_500);
    expect(legacyLoads).toBe(1);
  });

  it("list reports a stopped runner as disconnected and never loads the bridge for WhatsApp-only pages", async () => {
    seedWhatsAppInstance();
    const runner = fakeRunner({});
    runner.failNext(1);
    useDeps({ runner, legacy: fakeLegacy().client });

    const payload = (await new InstancesCommands().list(true)) as {
      items: Array<{ name: string; transport: string | null; live: Record<string, unknown> | null }>;
    };

    expect(payload.items[0]).toMatchObject({
      name: "wa-main",
      transport: "whatsapp",
      live: { isConnected: false, state: "disconnected" },
    });
    expect(legacyLoads).toBe(0);
  });

  it("list text labels: no-instance-id and unsupported, no [native] suffix", async () => {
    seedWhatsAppInstance();
    dbUpsertInstance({ name: "wa-bare", channel: "whatsapp" });
    dbUpsertInstance({ name: "tw", instanceId: "tw-uuid", channel: "twilio-whatsapp" });
    const runner = fakeRunner({ "connection.status": () => CONNECTED_STATUS });
    useDeps({ runner });

    await new InstancesCommands().list(false);

    const text = output.join("\n");
    expect(text).toContain("connected (Ravi Bot)");
    expect(text).toContain("no-instance-id");
    expect(text).toContain("unsupported");
    expect(text).not.toContain("[native]");
    expect(text).not.toContain("no-omni-id");
  });

  it("disconnect sends the WhatsApp disconnect RPC", async () => {
    seedWhatsAppInstance();
    const runner = fakeRunner({ "connection.disconnect": () => ({}) });
    useDeps({ runner });

    const payload = await new InstancesCommands().disconnect("wa-main", true);

    expect(runner.methods()).toEqual(["connection.disconnect"]);
    expect(payload).toMatchObject({ status: "disconnected", transport: "whatsapp" });
    expect(legacyLoads).toBe(0);
  });

  it("disconnect text says a WhatsApp instance stays disconnected until connect (R4)", async () => {
    seedWhatsAppInstance();
    useDeps({ runner: fakeRunner({ "connection.disconnect": () => ({}) }) });

    await new InstancesCommands().disconnect("wa-main", false);

    const text = output.join("\n");
    expect(text).toContain("✓ Disconnected: wa-main");
    expect(text).toContain("Stays disconnected across runner restarts. Reconnect with: ravi instances connect wa-main");
  });

  it("disconnect of a telegram instance goes to the legacy bridge", async () => {
    dbUpsertInstance({ name: "tg", instanceId: "tg-uuid", channel: "telegram" });
    const legacy = fakeLegacy();
    const runner = fakeRunner({});
    useDeps({ runner, legacy: legacy.client });

    const payload = await new InstancesCommands().disconnect("tg", true);

    expect(legacy.calls).toEqual(["disconnect tg-uuid"]);
    expect(runner.calls).toEqual([]);
    expect(payload).toMatchObject({ status: "disconnected", transport: "omni" });
  });
});

// ---------------------------------------------------------------------------
// enable / disable (D18)
// ---------------------------------------------------------------------------

describe("instances enable/disable", () => {
  it("enable/disable a WhatsApp instance toggles the channel row too (D18)", () => {
    seedWhatsAppInstance();
    useDeps({});
    const commands = new InstancesCommands();

    const disabled = commands.disable("wa-main", true);
    expect(disabled).toMatchObject({
      status: "disabled",
      channel: { name: "wa-main", enabled: false, changed: true },
      changedCount: 2,
    });
    expect(dbGetInstance("wa-main")?.enabled).toBe(false);
    expect(dbGetChannel("wa-main")?.enabled).toBe(false);

    const enabled = commands.enable("11111111-1111-4111-8111-111111111111", true);
    expect(enabled).toMatchObject({
      status: "enabled",
      channel: { name: "wa-main", enabled: true, changed: true },
      changedCount: 2,
    });
    expect(dbGetInstance("wa-main")?.enabled).toBe(true);
    expect(dbGetChannel("wa-main")?.enabled).toBe(true);
  });

  it("an already-consistent pair is unchanged", () => {
    seedWhatsAppInstance();
    useDeps({});

    const payload = new InstancesCommands().enable("wa-main", true);

    expect(payload).toMatchObject({
      status: "unchanged",
      channel: { name: "wa-main", enabled: true, changed: false },
      changedCount: 0,
    });
  });

  it("repairs a drifted channel row even when the instance already has the requested state", () => {
    seedWhatsAppInstance();
    dbUpdateInstance("wa-main", { enabled: false });
    useDeps({});

    const payload = new InstancesCommands().disable("wa-main", true);

    expect(payload).toMatchObject({ status: "disabled", channel: { changed: true }, changedCount: 1 });
    expect(dbGetChannel("wa-main")?.enabled).toBe(false);
  });

  it("follows a sanitized channel bound through defaults.instance", () => {
    dbUpsertInstance({
      name: "Loja São Paulo",
      instanceId: "66666666-6666-4666-8666-666666666666",
      channel: "whatsapp",
    });
    dbUpsertChannel({ name: "Loja-Sao-Paulo", provider: "whatsapp", defaults: { instance: "Loja São Paulo" } });
    dbUpdateChannel("Loja-Sao-Paulo", { enabled: false });
    dbUpdateInstance("Loja São Paulo", { enabled: false });
    useDeps({});

    const payload = new InstancesCommands().enable("Loja São Paulo", true);

    expect(payload).toMatchObject({
      channel: { name: "Loja-Sao-Paulo", enabled: true, changed: true },
      changedCount: 2,
    });
    expect(dbGetChannel("Loja-Sao-Paulo")?.enabled).toBe(true);
  });

  it("telegram toggles only the instance", () => {
    dbUpsertInstance({ name: "tg", instanceId: "tg-uuid", channel: "telegram" });
    useDeps({});

    const payload = new InstancesCommands().disable("tg", true);

    expect(payload).toMatchObject({ status: "disabled", channel: null, changedCount: 1 });
    expect(dbGetInstance("tg")?.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// logout / delete (R10)
// ---------------------------------------------------------------------------

describe("instances logout", () => {
  it("is a dry-run without --execute (exit 3, no RPC)", async () => {
    seedWhatsAppInstance();
    const runner = fakeRunner({ "connection.logout": () => ({}) });
    useDeps({ runner });

    const error = await expectContractError(
      () => new InstancesCommands().logout("wa-main", true),
      "WRITE_REQUIRES_EXECUTE",
    );

    expect(error.exitCode).toBe(3);
    expect(error.details.plan).toMatchObject({ instance: "wa-main", transport: "whatsapp" });
    expect(runner.calls).toEqual([]);
    expect(clearedAuth).toEqual([]);
  });

  it("asks the runner to log out with --execute", async () => {
    const instanceId = seedWhatsAppInstance();
    const runner = fakeRunner({ "connection.logout": () => ({ unlinked: true }) });
    useDeps({ runner });

    const payload = await new InstancesCommands().logout("wa-main", true, true);

    expect(runner.methods()).toEqual(["connection.logout"]);
    expect(payload).toMatchObject({
      status: "logged_out",
      instanceId,
      logout: { via: "runner", unlinked: true },
      changedCount: 1,
    });
    expect(clearedAuth).toEqual([]);
  });

  it("says the device was unlinked only when the runner unlinked it", async () => {
    seedWhatsAppInstance();
    useDeps({ runner: fakeRunner({ "connection.logout": () => ({ unlinked: true }) }) });

    await new InstancesCommands().logout("wa-main", false, true);

    const text = output.join("\n");
    expect(text).toContain("device unlinked, credentials wiped");
    expect(text).not.toContain("Linked devices");
  });

  it("tells the user to remove the linked device when the runner was not connected", async () => {
    seedWhatsAppInstance();
    useDeps({ runner: fakeRunner({ "connection.logout": () => ({ unlinked: false }) }) });

    const payload = await new InstancesCommands().logout("wa-main", false, true);

    expect(payload).toMatchObject({ logout: { via: "runner", unlinked: false } });
    const text = output.join("\n");
    expect(text).not.toContain("device unlinked");
    expect(text).toContain("the device was not unlinked");
    expect(text).toContain("Remove the linked device on the phone: WhatsApp > Linked devices.");
  });

  it("treats a runner reply without `unlinked` (older runner) as not unlinked", async () => {
    seedWhatsAppInstance();
    useDeps({ runner: fakeRunner({ "connection.logout": () => ({}) }) });

    const payload = await new InstancesCommands().logout("wa-main", true, true);

    expect(payload).toMatchObject({ logout: { via: "runner", unlinked: false } });
  });

  it("wipes the saved credentials locally when the runner does not answer", async () => {
    const instanceId = seedWhatsAppInstance();
    const runner = fakeRunner({});
    runner.failNext(1);
    useDeps({ runner });

    const payload = await new InstancesCommands().logout("wa-main", false, true);

    expect(payload).toMatchObject({ logout: { via: "auth-store", unlinked: false, clearedKeys: 3 } });
    expect(clearedAuth).toEqual([instanceId]);
    expect(output.join("\n")).toContain("Linked devices");
  });

  it("wipes locally when the channel is disabled (instance not bound)", async () => {
    const instanceId = seedWhatsAppInstance();
    dbUpdateChannel("wa-main", { enabled: false });
    const runner = fakeRunner({});
    useDeps({ runner });

    const payload = await new InstancesCommands().logout("wa-main", true, true);

    expect(payload).toMatchObject({ logout: { via: "auth-store" } });
    expect(runner.calls).toEqual([]);
    expect(clearedAuth).toEqual([instanceId]);
  });

  it("refuses a non-WhatsApp instance", async () => {
    dbUpsertInstance({ name: "tg", instanceId: "tg-uuid", channel: "telegram" });
    useDeps({});

    const error = await expectContractError(() => new InstancesCommands().logout("tg", true, true), "USAGE_ERROR");
    expect(error.exitCode).toBe(2);
  });
});

describe("instances delete", () => {
  it("logs a WhatsApp instance out through the runner before the soft delete", async () => {
    seedWhatsAppInstance();
    const runner = fakeRunner({ "connection.logout": () => ({}) });
    useDeps({ runner });

    const payload = await new InstancesCommands().delete("wa-main", true);

    expect(runner.methods()).toEqual(["connection.logout"]);
    expect(payload).toMatchObject({ status: "deleted", whatsappLogout: { via: "runner" } });
    expect(dbGetInstance("wa-main")).toBeNull();
    expect(clearedAuth).toEqual([]);
  });

  it("text mode claims an unlinked device only when the runner unlinked it", async () => {
    seedWhatsAppInstance("wa-main");
    seedWhatsAppInstance("wa-idle", "22222222-2222-4222-8222-222222222222");
    const runner = fakeRunner({
      "connection.logout": (request) => ({ unlinked: request.instanceId === "11111111-1111-4111-8111-111111111111" }),
    });
    useDeps({ runner });

    await new InstancesCommands().delete("wa-main", false);
    expect(output.join("\n")).toContain("device unlinked, credentials wiped");
    expect(output.join("\n")).not.toContain("Linked devices");

    output = [];
    const payload = await new InstancesCommands().delete("wa-idle", false);
    expect(payload).toMatchObject({ whatsappLogout: { via: "runner", unlinked: false } });
    expect(output.join("\n")).not.toContain("device unlinked");
    expect(output.join("\n")).toContain("Remove the linked device on the phone: WhatsApp > Linked devices.");
  });

  it("disables the instance's WhatsApp channel so the runner stops it instead of failing an unbound start", async () => {
    seedWhatsAppInstance();
    const runner = fakeRunner({ "connection.logout": () => ({}) });
    useDeps({ runner });

    const payload = await new InstancesCommands().delete("wa-main", true);

    expect(payload).toMatchObject({
      status: "deleted",
      channel: { name: "wa-main", enabled: false, changed: true },
      changedCount: 2,
    });
    expect(dbGetChannel("wa-main")).toMatchObject({ enabled: false });
    expect(dbGetChannel("wa-main")?.deletedAt).toBeFalsy();
  });

  it("prints the channel change in text mode", async () => {
    seedWhatsAppInstance();
    useDeps({ runner: fakeRunner({ "connection.logout": () => ({}) }) });

    await new InstancesCommands().delete("wa-main", false);

    expect(output.join("\n")).toContain("WhatsApp channel disabled: wa-main");
  });

  it("restore re-enables the channel of an enabled instance", async () => {
    seedWhatsAppInstance();
    useDeps({ runner: fakeRunner({ "connection.logout": () => ({}) }) });
    await new InstancesCommands().delete("wa-main", true);
    output = [];

    const payload = new InstancesCommands().restore("wa-main", false);

    expect(payload).toMatchObject({
      status: "restored",
      channel: { name: "wa-main", enabled: true, changed: true },
      changedCount: 2,
    });
    expect(dbGetInstance("wa-main")).toMatchObject({ name: "wa-main" });
    expect(dbGetChannel("wa-main")).toMatchObject({ enabled: true });
    expect(output.join("\n")).toContain("WhatsApp channel enabled: wa-main");
    expect(output.join("\n")).toContain("ravi instances connect wa-main");
  });

  it("restore leaves the channel of a disabled instance disabled", async () => {
    seedWhatsAppInstance();
    useDeps({ runner: fakeRunner({}) });
    new InstancesCommands().disable("wa-main", true);
    await new InstancesCommands().delete("wa-main", true);

    const payload = new InstancesCommands().restore("wa-main", true);

    expect(payload).toMatchObject({
      status: "restored",
      channel: { name: "wa-main", enabled: false, changed: false },
      changedCount: 1,
    });
    expect(dbGetInstance("wa-main")).toMatchObject({ enabled: false });
    expect(dbGetChannel("wa-main")).toMatchObject({ enabled: false });
  });

  it("clears the credentials through the auth store when the runner does not log out", async () => {
    const instanceId = seedWhatsAppInstance();
    const runner = fakeRunner({});
    useDeps({ runner });

    const payload = await new InstancesCommands().delete("wa-main", true);

    expect(payload).toMatchObject({ status: "deleted", whatsappLogout: { via: "auth-store", clearedKeys: 3 } });
    expect(clearedAuth).toEqual([instanceId]);
    expect(dbGetInstance("wa-main")).toBeNull();
  });

  it("does not touch WhatsApp credentials for a telegram instance", async () => {
    dbUpsertInstance({ name: "tg", instanceId: "tg-uuid", channel: "telegram" });
    const runner = fakeRunner({});
    useDeps({ runner });

    const payload = await new InstancesCommands().delete("tg", true);

    expect(payload).toMatchObject({ status: "deleted", whatsappLogout: null, channel: null, changedCount: 1 });
    expect(runner.calls).toEqual([]);
    expect(clearedAuth).toEqual([]);
  });
});
