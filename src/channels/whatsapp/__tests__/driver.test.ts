import { describe, expect, it, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import type { WASocket } from "baileys";
import type { ChannelConfig, InstanceConfig } from "../../../router/router-db.js";
import {
  NativeChannelDriverContractError,
  NativeChannelDriverManager,
  NativeChannelDriverRegistry,
  type NativeChannelDriverHost,
  type NativeChannelRuntimeHealth,
} from "../../native/driver.js";
import type { NativeChannelDriverHostLease } from "../../native/host.js";
import {
  WHATSAPP_RPC_PROTOCOL,
  WHATSAPP_RPC_QUEUE,
  WHATSAPP_RPC_SCHEMA_VERSION,
  whatsappRpcSubject,
  type WhatsAppRpcMethod,
} from "../contract.js";
import {
  createWhatsAppChannelDriver,
  resolveWhatsAppChannelBinding,
  whatsappChannelBindingKey,
  type WhatsAppDriverRuntime,
  type WhatsAppChannelDriverOptions,
  type WhatsAppRuntimeFactoryOptions,
} from "../driver.js";
import { type WhatsAppLibrary, whatsappLibrary } from "../runtime-library.js";
import { createFakeNats } from "./fake-nats.js";
import {
  OWNER_JID,
  createFakeJetStream,
  createFakeSocket,
  createMemoryAuthStorage,
  flush,
  silentLogger,
  uniqueInstanceId,
  type FakeSocket,
} from "./runtime-harness.js";

const UUID_A = "0b7d9d58-2d3c-4b8e-9a1f-1234567890ab";
const UUID_B = "1c8e0e69-3e4d-4c9f-8b20-234567890abc";

function channel(name: string, overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return { name, provider: "whatsapp", enabled: true, createdAt: 1, updatedAt: 1, ...overrides };
}

function instance(
  name: string,
  instanceId: string | undefined,
  overrides: Partial<InstanceConfig> = {},
): InstanceConfig {
  return {
    name,
    ...(instanceId ? { instanceId } : {}),
    channel: "whatsapp",
    dmPolicy: "open",
    groupPolicy: "open",
    contactIntakeMode: "pending",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function config(channels: ChannelConfig[], instances: InstanceConfig[]) {
  return {
    channels: Object.fromEntries(channels.map((entry) => [entry.name, entry])),
    instances: Object.fromEntries(instances.map((entry) => [entry.name, entry])),
    instanceToAccount: Object.fromEntries(
      instances.flatMap((entry) => (entry.instanceId ? [[entry.instanceId, entry.name]] : [])),
    ),
  };
}

const host = {} as NativeChannelDriverHost;

function fakeRuntime(health: NativeChannelRuntimeHealth = { status: "starting", reason: "pairing_required" }) {
  const call = mock(async (method: WhatsAppRpcMethod, _params: unknown) =>
    method === "connection.status" ? { state: "disconnected", isConnected: false, profileName: null } : {},
  );
  const runtime = {
    start: mock(() => {}),
    stop: mock(async () => {}),
    health: mock(() => health),
    call: call as unknown as WhatsAppDriverRuntime["call"],
  };
  return { runtime, call };
}

function driverWith(routerConfig: ReturnType<typeof config>, overrides: Partial<WhatsAppChannelDriverOptions> = {}) {
  const nats = createFakeNats();
  const created: WhatsAppRuntimeFactoryOptions[] = [];
  const runtimes: ReturnType<typeof fakeRuntime>[] = [];
  const driver = createWhatsAppChannelDriver({
    getConfig: () => routerConfig,
    connection: () => nats,
    jetstream: () => createFakeJetStream().js,
    loadLibrary: async () => whatsappLibrary,
    createRuntime: (options) => {
      created.push(options);
      const fake = fakeRuntime();
      runtimes.push(fake);
      return fake.runtime;
    },
    rpcDrainTimeoutMs: 50,
    ...overrides,
  });
  return { driver, nats, created, runtimes };
}

function rpcRequest(instanceId: string, method: string, params: unknown = {}) {
  return {
    protocol: WHATSAPP_RPC_PROTOCOL,
    schemaVersion: WHATSAPP_RPC_SCHEMA_VERSION,
    requestId: `req-${method}`,
    instanceId,
    method,
    params,
  };
}

async function expectContractFailure(promise: Promise<unknown>, reason: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(NativeChannelDriverContractError);
  expect((error as NativeChannelDriverContractError).reason).toBe(reason as never);
}

describe("WhatsApp native channel driver: descriptor and binding", () => {
  it("declares the ravi.whatsapp driver for provider whatsapp with only the inbound capability", () => {
    const { driver } = driverWith(config([], []));
    expect(driver.descriptor).toEqual({
      protocol: "ravi.channel.native-driver",
      schemaVersion: 1,
      driverId: "ravi.whatsapp",
      provider: "whatsapp",
      capabilities: ["inbound"],
    });
  });

  it("binds the instance with the channel name and uses channel.name as runtime ids", async () => {
    const { driver, created } = driverWith(config([channel("main")], [instance("main", UUID_A)]));

    const runtime = await driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host });

    expect(runtime.descriptor).toMatchObject({
      driverId: "ravi.whatsapp",
      provider: "whatsapp",
      runtimeId: "main",
      channelInstanceId: "main",
      capabilities: ["inbound"],
    });
    expect(runtime.delivery).toBeUndefined();
    expect(created[0]).toMatchObject({ instanceId: UUID_A, accountName: "main" });
    expect(typeof created[0]?.jetstream).toBe("function");
    expect(typeof created[0]?.loadLibrary).toBe("function");
  });

  it("binds defaults.instance when set and maps runtime defaults", async () => {
    const wa = channel("wa-native", {
      defaults: {
        instance: "vendas",
        readReceiptMode: "off",
        offlineIngestMode: "realtime",
        offlineStaleMs: 120_000,
        historyDownloadMedia: true,
        autoConnect: false,
        whatsapp: { markOnlineOnConnect: false },
      },
    });
    const { driver, created } = driverWith(config([wa], [instance("vendas", UUID_B)]));

    await driver.createRuntime({ channel: { name: "wa-native", provider: "whatsapp", defaults: wa.defaults }, host });

    expect(created[0]).toMatchObject({
      instanceId: UUID_B,
      accountName: "vendas",
      readReceiptMode: "off",
      offlineIngestMode: "realtime",
      offlineStaleMs: 120_000,
      historyDownloadMedia: true,
      autoConnect: false,
      socketOptions: { markOnlineOnConnect: false },
    });
  });

  it("leaves offline backlog age-aware by default (no offlineIngestMode / offlineStaleMs passed)", async () => {
    const { driver, created } = driverWith(config([channel("main")], [instance("main", UUID_A)]));
    await driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host });
    expect(created[0]?.offlineIngestMode).toBeUndefined();
    expect(created[0]?.offlineStaleMs).toBeUndefined();
  });

  it("fails invalid_channel_configuration when the instance is missing or has no transport id", async () => {
    const missing = driverWith(config([channel("main")], []));
    await expectContractFailure(
      Promise.resolve(missing.driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host })),
      "invalid_channel_configuration",
    );

    const noUuid = driverWith(config([channel("main")], [instance("main", undefined)]));
    await expectContractFailure(
      Promise.resolve(noUuid.driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host })),
      "invalid_channel_configuration",
    );

    const deleted = driverWith(config([channel("main")], [instance("main", UUID_A, { deletedAt: 5 })]));
    await expectContractFailure(
      Promise.resolve(deleted.driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host })),
      "invalid_channel_configuration",
    );
    expect(missing.created).toHaveLength(0);
  });

  it("fails invalid_channel_configuration for invalid defaults", async () => {
    const wa = channel("main", { defaults: { readReceiptMode: "sometimes" } });
    const { driver, created } = driverWith(config([wa], [instance("main", UUID_A)]));
    await expectContractFailure(
      Promise.resolve(
        driver.createRuntime({ channel: { name: "main", provider: "whatsapp", defaults: wa.defaults }, host }),
      ),
      "invalid_channel_configuration",
    );
    expect(created).toHaveLength(0);
  });

  it("lets only one channel own an instance until that runtime stops", async () => {
    const second = channel("second", { defaults: { instance: "main" } });
    const { driver } = driverWith(config([channel("main"), second], [instance("main", UUID_A)]));

    const first = await driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host });
    await expectContractFailure(
      Promise.resolve(
        driver.createRuntime({ channel: { name: "second", provider: "whatsapp", defaults: second.defaults }, host }),
      ),
      "invalid_channel_configuration",
    );

    await first.stop();
    const again = await driver.createRuntime({
      channel: { name: "second", provider: "whatsapp", defaults: second.defaults },
      host,
    });
    expect(again.descriptor.channelInstanceId).toBe("second");
  });

  it("derives a binding key that changes with the bound instance", () => {
    const before = config([channel("main")], [instance("main", UUID_A)]);
    const after = config([channel("main")], [instance("main", UUID_B)]);
    expect(resolveWhatsAppChannelBinding(before, "main")?.instanceId).toBe(UUID_A);
    expect(whatsappChannelBindingKey(before, "main")).toBe(`main:${UUID_A}`);
    expect(whatsappChannelBindingKey(after, "main")).toBe(`main:${UUID_B}`);
    expect(whatsappChannelBindingKey(config([channel("main")], []), "main")).toBe("unbound");
  });
});

describe("WhatsApp native channel driver: lifecycle, RPC and health", () => {
  it("starts the runtime and its RPC server, and stops both", async () => {
    const { driver, nats, runtimes } = driverWith(config([channel("main")], [instance("main", UUID_A)]));
    const runtime = await driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host });
    const fake = runtimes[0]!;

    await runtime.start();
    expect(fake.runtime.start).toHaveBeenCalledTimes(1);
    expect(nats.subscriptions).toHaveLength(1);
    expect(nats.subscriptions[0]?.subject).toBe(whatsappRpcSubject(UUID_A));
    expect(nats.subscriptions[0]?.options).toEqual({ queue: WHATSAPP_RPC_QUEUE });

    await expect(nats.request(whatsappRpcSubject(UUID_A), rpcRequest(UUID_A, "connection.status"))).resolves.toEqual({
      ok: true,
      requestId: "req-connection.status",
      data: { state: "disconnected", isConnected: false, profileName: null },
    });
    expect(fake.call).toHaveBeenCalledWith("connection.status", {});

    await runtime.stop();
    expect(fake.runtime.stop).toHaveBeenCalledTimes(1);
    expect(nats.subscriptions[0]?.closed).toBe(true);
    await runtime.stop();
    expect(fake.runtime.stop).toHaveBeenCalledTimes(1);
  });

  it("passes runtime health through (starting + pairing_required before pairing)", async () => {
    const { driver } = driverWith(config([channel("main")], [instance("main", UUID_A)]));
    const runtime = await driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host });
    await runtime.start();
    await flush();
    expect(runtime.health()).toEqual({ status: "starting", reason: "pairing_required" });
    await runtime.stop();
  });

  it("reports failed + missing_dependency when baileys cannot be loaded", async () => {
    const { driver } = driverWith(config([channel("main")], [instance("main", UUID_A)]), {
      loadLibrary: async () => {
        throw new Error("Cannot find package 'baileys'");
      },
    });
    const runtime = await driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host });
    expect(runtime.health()).toEqual({ status: "starting", reason: "pairing_required" });

    await runtime.start();
    await flush();
    expect(runtime.health()).toEqual({ status: "failed", reason: "missing_dependency" });
    await runtime.stop();
  });

  it("shares one library load between the dependency probe and the runtime", async () => {
    const loadLibrary = mock(async () => whatsappLibrary);
    const { driver, created } = driverWith(config([channel("main")], [instance("main", UUID_A)]), { loadLibrary });
    const runtime = await driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host });
    await runtime.start();
    await created[0]?.loadLibrary?.();
    await created[0]?.loadLibrary?.();
    expect(loadLibrary).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it("does not start when the RPC connection is unavailable, so the manager can clean up", async () => {
    const { driver, runtimes } = driverWith(config([channel("main")], [instance("main", UUID_A)]), {
      connection: () => {
        throw new Error("NATS is not connected");
      },
    });
    const runtime = await driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host });
    expect(() => runtime.start()).toThrow("NATS is not connected");
    await runtime.stop();
    expect(runtimes[0]?.runtime.stop).toHaveBeenCalledTimes(1);
  });
});

describe("WhatsApp native channel driver: real runtime", () => {
  function fakeLibrary(sockets: FakeSocket[]): WhatsAppLibrary {
    return {
      ...whatsappLibrary,
      createSocket: mock(async () => {
        const created = createFakeSocket();
        sockets.push(created);
        return created.sock;
      }),
      closeSocket: mock(async (sock: WASocket) => {
        sock.end(undefined);
      }),
      createStorageAuthState: mock(async () => {
        const state = { creds: { me: { id: OWNER_JID }, registered: true }, keys: {} };
        return {
          state,
          saveCreds: async () => {},
          flush: async () => true,
          discard: async () => {},
          pendingWrites: () => 0,
        } as unknown as Awaited<ReturnType<WhatsAppLibrary["createStorageAuthState"]>>;
      }),
    };
  }

  it("connects a paired instance in the background and serves RPC through the default factory", async () => {
    const instanceId = uniqueInstanceId("drv");
    const sockets: FakeSocket[] = [];
    const library = fakeLibrary(sockets);
    const jetstream = createFakeJetStream();
    const nats = createFakeNats();
    const driver = createWhatsAppChannelDriver({
      getConfig: () => config([channel("main")], [instance("main", instanceId)]),
      connection: () => nats,
      jetstream: () => jetstream.js,
      loadLibrary: async () => library,
      rpcDrainTimeoutMs: 50,
      runtimeOptions: {
        authStorage: createMemoryAuthStorage({ registered: true }).storage,
        ensureInboundStream: async () => {},
        logger: silentLogger,
        env: {},
        sleep: async () => {},
      },
    });
    const runtime = await driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host });
    const subject = whatsappRpcSubject(instanceId);

    await runtime.start();
    expect(runtime.health().status).toBe("starting");
    await flush();
    expect(sockets).toHaveLength(1);

    // Not connected yet: sends are 503 NOT_CONNECTED (the sender retries it: certainly unsent).
    await expect(
      nats.request(
        subject,
        rpcRequest(instanceId, "messages.sendText", { to: "5511988887777@s.whatsapp.net", text: "oi" }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { status: 503, code: "NOT_CONNECTED" } });

    sockets[0]?.emit("connection.update", { connection: "open" });
    await flush();
    expect(runtime.health()).toMatchObject({ status: "connected" });
    await expect(nats.request(subject, rpcRequest(instanceId, "connection.status"))).resolves.toMatchObject({
      ok: true,
      data: { state: "connected", isConnected: true },
    });
    expect(jetstream.published.map((record) => record.event.type)).toContain("connection.connected");

    await runtime.stop();
    expect(runtime.health()).toEqual({ status: "disconnected", reason: "stopped" });
    expect(nats.subscriptions[0]?.closed).toBe(true);
  });

  it("starts unpaired instances as starting + pairing_required without loading a socket", async () => {
    const instanceId = uniqueInstanceId("drv");
    const sockets: FakeSocket[] = [];
    const nats = createFakeNats();
    const driver = createWhatsAppChannelDriver({
      getConfig: () => config([channel("main")], [instance("main", instanceId)]),
      connection: () => nats,
      jetstream: () => createFakeJetStream().js,
      loadLibrary: async () => fakeLibrary(sockets),
      runtimeOptions: {
        authStorage: createMemoryAuthStorage({ registered: false }).storage,
        ensureInboundStream: async () => {},
        logger: silentLogger,
        env: {},
      },
    });
    const runtime = await driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host });
    await runtime.start();
    await flush();
    expect(runtime.health()).toEqual({ status: "starting", reason: "pairing_required" });
    expect(sockets).toHaveLength(0);
    await expect(
      nats.request(whatsappRpcSubject(instanceId), rpcRequest(instanceId, "connection.status")),
    ).resolves.toMatchObject({ ok: true, data: { state: "disconnected", isConnected: false, profileName: null } });
    await runtime.stop();
  });

  it("retries a failed baileys load on the next connect instead of staying failed", async () => {
    const instanceId = uniqueInstanceId("drv");
    const sockets: FakeSocket[] = [];
    const library = fakeLibrary(sockets);
    const nats = createFakeNats();
    let loads = 0;
    const loadLibrary = mock(async () => {
      loads++;
      if (loads === 1) throw new Error("Cannot find module '/opt/ravi/dist/vendor/baileys.js'");
      return library;
    });
    const driver = createWhatsAppChannelDriver({
      getConfig: () => config([channel("main")], [instance("main", instanceId)]),
      connection: () => nats,
      jetstream: () => createFakeJetStream().js,
      loadLibrary,
      rpcDrainTimeoutMs: 50,
      runtimeOptions: {
        authStorage: createMemoryAuthStorage({ registered: true }).storage,
        ensureInboundStream: async () => {},
        logger: silentLogger,
        env: {},
        sleep: async () => {},
      },
    });
    const runtime = await driver.createRuntime({ channel: { name: "main", provider: "whatsapp" }, host });

    await runtime.start();
    await flush();
    expect(runtime.health()).toEqual({ status: "failed", reason: "missing_dependency" });
    expect(sockets).toHaveLength(0);
    expect(loadLibrary).toHaveBeenCalledTimes(1);

    await expect(
      nats.request(whatsappRpcSubject(instanceId), rpcRequest(instanceId, "connection.connect")),
    ).resolves.toMatchObject({ ok: true, data: { status: "connecting" } });
    await flush();
    expect(loadLibrary).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    expect(runtime.health().status).toBe("starting");

    sockets[0]?.emit("connection.update", { connection: "open" });
    await flush();
    expect(runtime.health()).toMatchObject({ status: "connected" });
    await runtime.stop();
  });

  it("rejects invalid socket options from channel defaults", async () => {
    const wa = channel("main", { defaults: { whatsapp: { connectTimeoutMs: -1 } } });
    const driver = createWhatsAppChannelDriver({
      getConfig: () => config([wa], [instance("main", UUID_A)]),
      connection: () => createFakeNats(),
      jetstream: () => createFakeJetStream().js,
    });
    await expectContractFailure(
      Promise.resolve(
        driver.createRuntime({ channel: { name: "main", provider: "whatsapp", defaults: wa.defaults }, host }),
      ),
      "invalid_channel_configuration",
    );
  });
});

describe("WhatsApp native channel driver: manager integration", () => {
  function lease(): NativeChannelDriverHostLease {
    return { host, dispose: mock(() => {}) };
  }

  it("runs through the provider-neutral manager and reports binding failures without details", async () => {
    const routerConfig = config(
      [channel("main"), channel("orphan"), channel("legacy", { provider: "whatsapp-baileys" })],
      [instance("main", UUID_A), instance("legacy", UUID_B)],
    );
    const { driver, runtimes } = driverWith(routerConfig);
    const registry = new NativeChannelDriverRegistry();
    registry.register(driver);
    const manager = new NativeChannelDriverManager({
      channels: routerConfig.channels,
      registry,
      createHostLease: lease,
    });

    await manager.start();

    expect(runtimes).toHaveLength(2);
    expect(manager.health()).toEqual([
      { id: "whatsapp:legacy:legacy", channelId: "whatsapp", status: "starting", reason: "pairing_required" },
      { id: "whatsapp:main:main", channelId: "whatsapp", status: "starting", reason: "pairing_required" },
      { id: "whatsapp:orphan", channelId: "whatsapp", status: "failed", reason: "invalid_channel_configuration" },
    ]);
    await manager.stop();
    expect(runtimes.every((fake) => fake.runtime.stop.mock.calls.length === 1)).toBe(true);
  });

  it("skips WhatsApp channels entirely when the provider is skipped (channels probe)", async () => {
    const routerConfig = config([channel("main")], [instance("main", UUID_A)]);
    const { driver, created, nats } = driverWith(routerConfig);
    const registry = new NativeChannelDriverRegistry();
    registry.register(driver);
    const manager = new NativeChannelDriverManager({
      channels: routerConfig.channels,
      registry,
      createHostLease: lease,
      skipProviders: ["whatsapp"],
    });

    await manager.start();

    expect(created).toHaveLength(0);
    expect(nats.subscriptions).toHaveLength(0);
    expect(manager.health()).toEqual([
      { id: "whatsapp:main", channelId: "whatsapp", status: "disabled", reason: "skipped" },
    ]);
    await manager.stop();
  });
});

describe("WhatsApp native channel driver: lazy loading", () => {
  it("importing the driver and the runner never loads baileys or sharp", () => {
    const script = [
      'await import("./src/channels/whatsapp/driver.ts");',
      'await import("./src/channels/runner.ts");',
      "const loaded = Object.keys(require.cache).filter((path) => /node_modules\\/(baileys|sharp)\\//.test(path));",
      "console.log(JSON.stringify(loaded));",
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: new URL("../../../../", import.meta.url).pathname,
      encoding: "utf8",
      env: { ...process.env, RAVI_LOG_LEVEL: "error" },
    });
    expect(result.status).toBe(0);
    const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
    expect(JSON.parse(lastLine)).toEqual([]);
  });
});
