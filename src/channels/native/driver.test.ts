import { describe, expect, it, mock } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ChannelConfig } from "../../router/router-db.js";
import {
  CHANNEL_BACKEND_PROTOCOL,
  CHANNEL_BACKEND_SCHEMA_VERSION,
  ChannelOutputEnvelopeSchema,
  channelOutputSinks,
  type ChannelIngressRequest,
  type ChannelIngressResult,
} from "../backend.js";
import {
  NATIVE_CHANNEL_DRIVER_MODULES_ENV,
  NATIVE_CHANNEL_DRIVER_PROTOCOL,
  NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
  NativeChannelDriverContractError,
  NativeChannelDriverDescriptorSchema,
  NativeChannelDriverManager,
  NativeChannelDriverModuleConfigSchema,
  NativeChannelDriverRegistry,
  NativeChannelRuntimeDescriptorSchema,
  loadNativeChannelDriverModules,
  parseNativeChannelDriverModuleConfigs,
  type NativeChannelDriver,
  type NativeChannelDriverCapability,
  type NativeChannelDriverDescriptor,
  type NativeChannelDriverHost,
  type NativeChannelDriverModuleConfig,
  type NativeInboundChannelActionRequest,
  type NativeChannelRuntimeDescriptor,
} from "./driver.js";
import { createNativeChannelDriverHostLease, type NativeChannelDriverHostLease } from "./host.js";

const generatedFixtureDirectory = new URL(
  "../../../packages/ravi-os-sdk/src/__tests__/fixtures/native-channel-driver/",
  import.meta.url,
);

async function generatedFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, generatedFixtureDirectory), "utf8")) as T;
}

function channel(name = "example-channel-a", provider = "example"): ChannelConfig {
  return {
    name,
    provider,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function ingressRequest(): ChannelIngressRequest {
  return {
    protocol: CHANNEL_BACKEND_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
    requestId: "request-1",
    idempotencyKey: "idempotency-1",
    localActorId: "actor-1",
    channelInstanceId: "example-channel-a",
    agentId: "agent-1",
    external: {
      channelKind: "example",
      connectionId: "connection-1",
      conversationId: "conversation-1",
      senderId: "sender-1",
      messageId: "external-message-1",
    },
    content: [{ type: "text", text: "hello" }],
    receivedAt: "2026-07-24T18:00:00.000Z",
  };
}

function ingressResult(request = ingressRequest()): ChannelIngressResult {
  return {
    protocol: CHANNEL_BACKEND_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
    requestId: request.requestId,
    disposition: "accepted",
    binding: {
      channelInstanceId: request.channelInstanceId,
      agentId: request.agentId,
      chatId: "chat-1",
      messageId: "message-1",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    acceptedAt: "2026-07-24T18:00:00.000Z",
  };
}

function hostLease(overrides: Partial<NativeChannelDriverHost> = {}): NativeChannelDriverHostLease {
  const host: NativeChannelDriverHost = {
    ingress: mock(async (request) => ingressResult(request)),
    interrupt: mock(async (request) => ({
      protocol: "ravi.channel.runtime-events" as const,
      schemaVersion: 1 as const,
      requestId: request.requestId,
      disposition: "requested" as const,
      acceptedAt: request.requestedAt,
    })),
    readback: mock(async (request) => ({
      protocol: "ravi.channel.runtime-events" as const,
      schemaVersion: 1 as const,
      requestId: request.requestId,
      binding: request.binding,
      state: "running" as const,
      lastSequence: 1,
      observedAt: "2026-07-24T18:00:00.000Z",
    })),
    registerOutputSink: mock(() => () => {}),
    registerRuntimeEventSink: mock(() => () => {}),
    ...overrides,
  };
  return { host, dispose: mock(() => {}) };
}

function fullDriver(
  options: {
    health?: () => unknown;
    runtimeProvider?: string;
    runtimeCapabilities?: NativeChannelDriverCapability[];
  } = {},
): NativeChannelDriver {
  const delivery = {
    channelId: "example",
    supports: mock(() => true),
    deliverText: mock(async () => ({ provider: "example", platformMessageId: "outbound-1" })),
  };
  const actions = {
    channelId: "example",
    supports: mock(() => true),
    executeChatAction: mock(async () => ({ provider: "example", platformMessageId: "outbound-1" })),
  };
  const presence = {
    channelId: "example",
    supports: mock(() => true),
    sendPresence: mock(async () => ({ provider: "example", status: "active" as const })),
  };
  return {
    descriptor: {
      protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
      schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
      driverId: "example.native",
      provider: "example",
      capabilities: ["inbound", "text_delivery", "chat_actions", "presence"],
    },
    createRuntime(context) {
      return {
        descriptor: {
          protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
          schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
          driverId: "example.native",
          provider: options.runtimeProvider ?? "example",
          runtimeId: "example-runtime-a",
          channelInstanceId: context.channel.name,
          capabilities: options.runtimeCapabilities ?? ["inbound", "text_delivery", "chat_actions", "presence"],
        },
        delivery,
        actions,
        presence,
        async start() {
          await context.host.ingress(ingressRequest());
        },
        stop: mock(async () => {}),
        health: (options.health ?? (() => ({ status: "connected", connectedAt: 1 }))) as () => never,
      };
    },
  };
}

function inboundActionDriver(
  options: { includeHandler?: boolean; supports?: boolean; driverActions?: string[]; runtimeActions?: string[] } = {},
): NativeChannelDriver {
  const base = fullDriver();
  const driverActions = options.driverActions ?? ["account.connect"];
  const runtimeActions = options.runtimeActions ?? driverActions;
  return {
    descriptor: {
      ...base.descriptor,
      capabilities: [...base.descriptor.capabilities, "inbound_actions"],
      inboundActions: driverActions,
    },
    async createRuntime(context) {
      const runtime = await base.createRuntime(context);
      return {
        ...runtime,
        descriptor: {
          ...runtime.descriptor,
          capabilities: [...runtime.descriptor.capabilities, "inbound_actions"],
          inboundActions: runtimeActions,
        },
        ...(options.includeHandler === false
          ? {}
          : {
              inboundActions: {
                supports: mock(() => options.supports ?? true),
                handle: mock(async (request: NativeInboundChannelActionRequest) => ({
                  protocol: request.protocol,
                  schemaVersion: request.schemaVersion,
                  requestId: request.requestId,
                  disposition: "handled" as const,
                  text: "Action completed.",
                  completedAt: "2026-07-24T18:00:02.000Z",
                })),
              },
            }),
      };
    },
  };
}

describe("native channel driver contract", () => {
  it("parses the generated module, driver, and runtime descriptors", async () => {
    const moduleConfig = await generatedFixture<NativeChannelDriverModuleConfig>("module-config.json");
    const driverDescriptor = await generatedFixture<NativeChannelDriverDescriptor>("driver-descriptor.json");
    const runtimeDescriptor = await generatedFixture<NativeChannelRuntimeDescriptor>("runtime-descriptor.json");

    expect(NativeChannelDriverModuleConfigSchema.parse(moduleConfig)).toEqual(moduleConfig);
    expect(NativeChannelDriverDescriptorSchema.parse(driverDescriptor)).toEqual(driverDescriptor);
    expect(NativeChannelRuntimeDescriptorSchema.parse(runtimeDescriptor)).toEqual(runtimeDescriptor);
  });

  it("loads only an explicitly declared local module with the named export", async () => {
    const moduleSpecifier = new URL("./__fixtures__/example-driver.ts", import.meta.url).href;
    const configs = parseNativeChannelDriverModuleConfigs(
      JSON.stringify([
        {
          protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
          schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
          provider: "example",
          moduleSpecifier,
        },
      ]),
    );
    const registry = new NativeChannelDriverRegistry();

    const loaded = await loadNativeChannelDriverModules(configs, registry);

    expect(loaded).toEqual({ loadedProviders: ["example"], failures: [] });
    expect(registry.get("example")?.descriptor.driverId).toBe("example.native");
    expect(NATIVE_CHANNEL_DRIVER_MODULES_ENV).toBe("RAVI_NATIVE_CHANNEL_DRIVERS");
  });

  it("requires module, driver, and runtime action declarations to agree", async () => {
    const driver = inboundActionDriver();
    const matchingRegistry = new NativeChannelDriverRegistry();
    const matching = await loadNativeChannelDriverModules(
      [
        {
          protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
          schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
          provider: "example",
          moduleSpecifier: "@example/driver",
          inboundActions: ["account.connect"],
        },
      ],
      matchingRegistry,
      async () => ({ nativeChannelDriver: driver }),
    );
    expect(matching).toEqual({ loadedProviders: ["example"], failures: [] });

    const mismatchedRegistry = new NativeChannelDriverRegistry();
    const mismatched = await loadNativeChannelDriverModules(
      [
        {
          protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
          schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
          provider: "example",
          moduleSpecifier: "@example/driver",
        },
      ],
      mismatchedRegistry,
      async () => ({ nativeChannelDriver: driver }),
    );
    expect(mismatched).toEqual({
      loadedProviders: [],
      failures: [{ provider: "example", reason: "invalid_module_export" }],
    });
  });

  it("rejects remote, inferred, duplicate, and incompatible module declarations", async () => {
    expect(() =>
      parseNativeChannelDriverModuleConfigs(
        JSON.stringify([
          {
            protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
            schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
            provider: "example",
            moduleSpecifier: "https://example.test/driver.js",
          },
        ]),
      ),
    ).toThrow("invalid_driver_configuration");
    expect(() =>
      parseNativeChannelDriverModuleConfigs(
        JSON.stringify([
          {
            protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
            schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
            provider: "example",
            moduleSpecifier: "@example/driver",
          },
          {
            protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
            schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
            provider: "example",
            moduleSpecifier: "@example/other-driver",
          },
        ]),
      ),
    ).toThrow("duplicate_provider");

    const importer = mock(async () => ({
      nativeChannelDriver: {
        descriptor: {
          protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
          schemaVersion: 2,
          driverId: "example.native",
          provider: "example",
          capabilities: ["inbound"],
        },
        createRuntime() {},
      },
    }));
    const registry = new NativeChannelDriverRegistry();
    const result = await loadNativeChannelDriverModules(
      [
        {
          protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
          schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
          provider: "example",
          moduleSpecifier: "@example/driver",
        },
      ],
      registry,
      importer,
    );
    expect(result.failures).toEqual([{ provider: "example", reason: "incompatible_abi" }]);
    expect(registry.get("example")).toBeUndefined();
  });

  it("does not derive or import a module for an unregistered provider", async () => {
    const registry = new NativeChannelDriverRegistry();
    const lease = hostLease();
    const manager = new NativeChannelDriverManager({
      channels: { "example-channel-a": channel() },
      registry,
      createHostLease: () => lease,
    });

    await manager.start();

    expect(manager.health()).toEqual([
      {
        id: "example:example-channel-a",
        channelId: "example",
        status: "failed",
        reason: "driver_not_registered",
      },
    ]);
    expect(lease.dispose).not.toHaveBeenCalled();
  });

  it("runs ingress, delivery, lifecycle, and content-free health through one provider-neutral manager", async () => {
    const registry = new NativeChannelDriverRegistry();
    const driver = fullDriver();
    registry.register(driver);
    const lease = hostLease();
    const manager = new NativeChannelDriverManager({
      channels: { "example-channel-a": channel() },
      registry,
      createHostLease: () => lease,
    });

    await manager.start();

    expect(lease.host.ingress).toHaveBeenCalledWith(ingressRequest());
    expect(manager.deliveries()).toHaveLength(1);
    await expect(
      manager.deliveries()[0]!.deliverText({
        sessionName: "agent:example:main",
        idempotencyKey: "outbound-key-1",
        target: {
          channel: "example",
          accountId: "example-channel-a",
          chatId: "conversation-1",
        },
        text: "world",
      }),
    ).resolves.toMatchObject({ provider: "example", platformMessageId: "outbound-1" });
    expect(manager.actionDeliveries()).toHaveLength(1);
    expect(manager.presenceDeliveries()).toHaveLength(1);
    expect(manager.health()).toEqual([
      {
        id: "example:example-channel-a:example-runtime-a",
        channelId: "example",
        status: "connected",
        connectedAt: 1,
      },
    ]);

    await manager.stop();
    expect(lease.dispose).toHaveBeenCalledTimes(1);
    expect(manager.health()).toEqual([
      {
        id: "example:example-channel-a:example-runtime-a",
        channelId: "example",
        status: "disconnected",
      },
    ]);
  });

  it("exposes only validated native inbound action handlers", async () => {
    const registry = new NativeChannelDriverRegistry();
    registry.register(inboundActionDriver());
    const manager = new NativeChannelDriverManager({
      channels: { "example-channel-a": channel() },
      registry,
      createHostLease: () => hostLease(),
    });

    await manager.start();

    expect(manager.inboundActionHandlers()).toHaveLength(1);
    expect(manager.health()[0]).toMatchObject({ status: "connected" });
    await manager.stop();
  });

  it("fails closed on missing, unsupported, and mismatched inbound action surfaces", async () => {
    const cases: Array<{ driver: NativeChannelDriver; reason: string }> = [
      {
        driver: inboundActionDriver({ includeHandler: false }),
        reason: "runtime_surface_mismatch",
      },
      {
        driver: inboundActionDriver({ supports: false }),
        reason: "runtime_surface_mismatch",
      },
      {
        driver: inboundActionDriver({ runtimeActions: ["workspace.open"] }),
        reason: "runtime_capability_mismatch",
      },
    ];

    for (const testCase of cases) {
      const registry = new NativeChannelDriverRegistry();
      registry.register(testCase.driver);
      const manager = new NativeChannelDriverManager({
        channels: { "example-channel-a": channel() },
        registry,
        createHostLease: () => hostLease(),
      });

      await manager.start();

      expect(manager.inboundActionHandlers()).toEqual([]);
      expect(manager.health()[0]).toMatchObject({
        status: "failed",
        reason: testCase.reason,
      });
    }
  });

  it("fails closed on provider, capability, surface, and health mismatches", async () => {
    const cases: Array<{ driver: NativeChannelDriver; reason: string }> = [
      { driver: fullDriver({ runtimeProvider: "other" }), reason: "runtime_descriptor_invalid" },
      {
        driver: fullDriver({ runtimeCapabilities: ["inbound", "text_delivery"] }),
        reason: "runtime_surface_mismatch",
      },
    ];
    for (const testCase of cases) {
      const registry = new NativeChannelDriverRegistry();
      registry.register(testCase.driver);
      const manager = new NativeChannelDriverManager({
        channels: { "example-channel-a": channel() },
        registry,
        createHostLease: () => hostLease(),
      });
      await manager.start();
      expect(manager.health()[0]).toMatchObject({ status: "failed", reason: testCase.reason });
    }

    const registry = new NativeChannelDriverRegistry();
    registry.register(
      fullDriver({
        health: () => ({
          status: "failed",
          reason: "sensitive runtime detail",
          payload: "sensitive-runtime-detail",
        }),
      }),
    );
    const manager = new NativeChannelDriverManager({
      channels: { "example-channel-a": channel() },
      registry,
      createHostLease: () => hostLease(),
    });
    await manager.start();
    expect(manager.health()[0]).toMatchObject({ status: "failed", reason: "health_invalid" });
    expect(JSON.stringify(manager.health())).not.toContain("sensitive-runtime-detail");
  });

  it("keeps module loader failures stable and free of thrown details", async () => {
    const registry = new NativeChannelDriverRegistry();
    const result = await loadNativeChannelDriverModules(
      [
        {
          protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
          schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
          provider: "example",
          moduleSpecifier: "@example/driver",
        },
      ],
      registry,
      async () => {
        throw new Error("sensitive-module-detail");
      },
    );

    expect(result).toEqual({
      loadedProviders: [],
      failures: [{ provider: "example", reason: "module_load_failed" }],
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-module-detail");
  });

  it("stops runtimes in reverse order and cleans up a partially started runtime", async () => {
    const lifecycle: string[] = [];
    const registry = new NativeChannelDriverRegistry();
    registry.register({
      descriptor: {
        protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
        driverId: "example.native",
        provider: "example",
        capabilities: ["inbound"],
      },
      createRuntime(context) {
        return {
          descriptor: {
            protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
            schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
            driverId: "example.native",
            provider: "example",
            runtimeId: context.channel.name,
            channelInstanceId: context.channel.name,
            capabilities: ["inbound"],
          },
          start() {
            lifecycle.push(`start:${context.channel.name}`);
            if (context.channel.name === "example-c") {
              throw new Error("sensitive-startup-detail");
            }
          },
          stop() {
            lifecycle.push(`stop:${context.channel.name}`);
          },
          health: () => ({ status: "connected" }),
        };
      },
    });
    const failedLease = hostLease();
    const manager = new NativeChannelDriverManager({
      channels: {
        "example-a": channel("example-a"),
        "example-b": channel("example-b"),
        "example-c": channel("example-c"),
      },
      registry,
      createHostLease: (configured) => (configured.name === "example-c" ? failedLease : hostLease()),
    });

    await manager.start();
    expect(manager.health()).toContainEqual({
      id: "example:example-c",
      channelId: "example",
      status: "failed",
      reason: "startup_failed",
    });
    expect(JSON.stringify(manager.health())).not.toContain("sensitive-startup-detail");
    expect(lifecycle).toEqual(["start:example-a", "start:example-b", "start:example-c", "stop:example-c"]);
    expect(failedLease.dispose).toHaveBeenCalledTimes(1);

    await manager.stop();
    expect(lifecycle).toEqual([
      "start:example-a",
      "start:example-b",
      "start:example-c",
      "stop:example-c",
      "stop:example-b",
      "stop:example-a",
    ]);
  });

  it("scopes registered sinks to the provider and disposes them with the runtime lease", async () => {
    const lease = createNativeChannelDriverHostLease({
      channel: channel(),
      provider: "example",
    });
    const emit = mock(async () => {});
    lease.host.registerOutputSink({ channelKind: "example", connectionId: "connection-1" }, { emit });
    const envelope = ChannelOutputEnvelopeSchema.parse({
      protocol: CHANNEL_BACKEND_PROTOCOL,
      schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
      outputId: "output-1",
      correlationId: "correlation-1",
      binding: ingressResult().binding,
      target: {
        channelKind: "example",
        connectionId: "connection-1",
        conversationId: "conversation-1",
      },
      kind: "assistant_message",
      content: [{ type: "text", text: "hello" }],
      emittedAt: "2026-07-24T18:00:01.000Z",
    });

    await channelOutputSinks.emit(envelope);
    expect(emit).toHaveBeenCalledWith(envelope);
    expect(() =>
      lease.host.registerOutputSink({ channelKind: "other", connectionId: "connection-2" }, { emit }),
    ).toThrow("scope_mismatch");

    lease.dispose();
    await expect(channelOutputSinks.emit(envelope)).rejects.toThrow("unavailable");
  });

  it("rejects duplicate driver ownership without replacing the registered driver", () => {
    const registry = new NativeChannelDriverRegistry();
    const first = fullDriver();
    registry.register(first);

    expect(() => registry.register(fullDriver())).toThrow(NativeChannelDriverContractError);
    expect(registry.get("example")).toBe(first);
  });
});

function lifecycleDriver(
  options: { failStart?: (name: string) => boolean; failStop?: (name: string) => boolean; withDelivery?: boolean } = {},
) {
  const lifecycle: string[] = [];
  const driver: NativeChannelDriver = {
    descriptor: {
      protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
      schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
      driverId: "example.native",
      provider: "example",
      capabilities: options.withDelivery ? ["inbound", "text_delivery"] : ["inbound"],
    },
    createRuntime(context) {
      const name = context.channel.name;
      const marker = JSON.stringify(context.channel.defaults ?? {});
      lifecycle.push(`create:${name}:${marker}`);
      return {
        descriptor: {
          protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
          schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
          driverId: "example.native",
          provider: "example",
          runtimeId: name,
          channelInstanceId: name,
          capabilities: options.withDelivery ? ["inbound", "text_delivery"] : ["inbound"],
        },
        ...(options.withDelivery
          ? {
              delivery: {
                channelId: "example",
                supports: (target: { accountId?: string }) => target.accountId === name,
                deliverText: async () => ({ provider: "example", platformMessageId: name }),
              },
            }
          : {}),
        start() {
          lifecycle.push(`start:${name}`);
          if (options.failStart?.(name)) throw new Error("start failed");
        },
        stop() {
          lifecycle.push(`stop:${name}`);
          if (options.failStop?.(name)) throw new Error("stop failed");
        },
        health: () => ({ status: "connected" as const }),
      };
    },
  };
  return { driver, lifecycle };
}

function lifecycleManager(
  driver: NativeChannelDriver,
  channels: Record<string, ChannelConfig>,
  extra: { bindingKey?: (channel: ChannelConfig) => string | undefined; skipProviders?: string[] } = {},
) {
  const registry = new NativeChannelDriverRegistry();
  registry.register(driver);
  return new NativeChannelDriverManager({
    channels,
    registry,
    createHostLease: () => hostLease(),
    ...extra,
  });
}

function channels(...entries: ChannelConfig[]): Record<string, ChannelConfig> {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry]));
}

describe("native channel driver manager reconcile", () => {
  it("starts added channels, stops removed ones, and leaves unchanged runtimes running", async () => {
    const { driver, lifecycle } = lifecycleDriver({ withDelivery: true });
    const manager = lifecycleManager(driver, channels(channel("example-a"), channel("example-b")));
    await manager.start();
    expect(manager.deliveries().map((delivery) => delivery.channelId)).toHaveLength(2);
    lifecycle.length = 0;

    const result = await manager.reconcile(channels(channel("example-a"), channel("example-c")));

    expect(result).toEqual({ started: ["example-c"], stopped: ["example-b"], inactive: [] });
    expect(lifecycle).toEqual(["stop:example-b", "create:example-c:{}", "start:example-c"]);
    expect(manager.health().map((entry) => entry.id)).toEqual([
      "example:example-a:example-a",
      "example:example-c:example-c",
    ]);
    const supported = manager
      .deliveries()
      .filter((delivery) => delivery.supports({ channel: "example", accountId: "example-c", chatId: "x" }));
    expect(supported).toHaveLength(1);
    await manager.stop();
  });

  it("stops disabled or deleted channels and starts them again when re-enabled", async () => {
    const { driver, lifecycle } = lifecycleDriver();
    const manager = lifecycleManager(driver, channels(channel("example-a"), channel("example-b")));
    await manager.start();
    lifecycle.length = 0;

    await manager.reconcile(
      channels({ ...channel("example-a"), enabled: false }, { ...channel("example-b"), deletedAt: 10 }),
    );
    expect(lifecycle).toEqual(["stop:example-b", "stop:example-a"]);
    expect(manager.health()).toEqual([]);

    await manager.reconcile(channels(channel("example-a")));
    expect(lifecycle.slice(2)).toEqual(["create:example-a:{}", "start:example-a"]);
    await manager.stop();
  });

  it("restarts a runtime whose channel configuration or binding key changed", async () => {
    const { driver, lifecycle } = lifecycleDriver();
    let binding = "instance-1";
    const manager = lifecycleManager(driver, channels(channel("example-a")), { bindingKey: () => binding });
    await manager.start();
    lifecycle.length = 0;

    // Only timestamps changed: no restart.
    await manager.reconcile(channels({ ...channel("example-a"), updatedAt: 99 }));
    expect(lifecycle).toEqual([]);

    await manager.reconcile(channels({ ...channel("example-a"), defaults: { mode: "x", level: 1 } }));
    expect(lifecycle).toEqual(["stop:example-a", 'create:example-a:{"mode":"x","level":1}', "start:example-a"]);

    // Same defaults with keys in a different order: no restart.
    lifecycle.length = 0;
    await manager.reconcile(channels({ ...channel("example-a"), defaults: { level: 1, mode: "x" } }));
    expect(lifecycle).toEqual([]);

    binding = "instance-2";
    await manager.reconcile(channels({ ...channel("example-a"), defaults: { level: 1, mode: "x" } }));
    expect(lifecycle).toEqual(["stop:example-a", 'create:example-a:{"level":1,"mode":"x"}', "start:example-a"]);
    await manager.stop();
  });

  it("retries failed channels on demand and clears their failure once they start", async () => {
    let broken = true;
    const { driver, lifecycle } = lifecycleDriver({ failStart: () => broken });
    const manager = lifecycleManager(driver, channels(channel("example-a")));
    await manager.start();
    expect(manager.health()).toEqual([
      { id: "example:example-a", channelId: "example", status: "failed", reason: "startup_failed" },
    ]);
    lifecycle.length = 0;

    const skipped = await manager.reconcile(channels(channel("example-a")), { retryFailed: false });
    expect(skipped).toEqual({ started: [], stopped: [], inactive: ["example-a"] });
    expect(lifecycle).toEqual([]);

    broken = false;
    const retried = await manager.reconcile(channels(channel("example-a")));
    expect(retried).toEqual({ started: ["example-a"], stopped: [], inactive: [] });
    expect(manager.health()).toEqual([
      { id: "example:example-a:example-a", channelId: "example", status: "connected" },
    ]);
    await manager.stop();
  });

  it("drops the failure status of a channel that was removed", async () => {
    const { driver } = lifecycleDriver({ failStart: () => true });
    const manager = lifecycleManager(driver, channels(channel("example-a")));
    await manager.start();
    expect(manager.health()).toHaveLength(1);

    await manager.reconcile({}, { retryFailed: false });
    expect(manager.health()).toEqual([]);
    await manager.stop();
  });

  it("reports stop_failed for a removed runtime that failed to stop", async () => {
    const { driver } = lifecycleDriver({ failStop: (name) => name === "example-b" });
    const manager = lifecycleManager(driver, channels(channel("example-a"), channel("example-b")));
    await manager.start();

    const result = await manager.reconcile(channels(channel("example-a")));
    expect(result.stopped).toEqual(["example-b"]);
    expect(manager.health()).toContainEqual({
      id: "example:example-b:example-b",
      channelId: "example",
      status: "failed",
      reason: "stop_failed",
    });
    await manager.stop();
  });

  it("is a no-op before start and after stop, and serializes with stop", async () => {
    const { driver, lifecycle } = lifecycleDriver();
    const manager = lifecycleManager(driver, channels(channel("example-a")));
    expect(await manager.reconcile(channels(channel("example-b")))).toEqual({
      started: [],
      stopped: [],
      inactive: [],
    });
    expect(lifecycle).toEqual([]);

    await manager.start();
    const reconciling = manager.reconcile(channels(channel("example-a"), channel("example-b")));
    const stopping = manager.stop();
    await Promise.all([reconciling, stopping]);
    // The reconcile ran first; stop then stopped both runtimes, newest first.
    expect(lifecycle).toEqual([
      "create:example-a:{}",
      "start:example-a",
      "create:example-b:{}",
      "start:example-b",
      "stop:example-b",
      "stop:example-a",
    ]);

    lifecycle.length = 0;
    await manager.reconcile(channels(channel("example-c")));
    expect(lifecycle).toEqual([]);
  });

  it("reports skipped providers as disabled without creating a runtime", async () => {
    const { driver, lifecycle } = lifecycleDriver();
    const manager = lifecycleManager(driver, channels(channel("example-a")), { skipProviders: ["example"] });
    await manager.start();
    expect(lifecycle).toEqual([]);
    expect(manager.health()).toEqual([
      { id: "example:example-a", channelId: "example", status: "disabled", reason: "skipped" },
    ]);

    await manager.reconcile(channels(channel("example-a"), channel("example-b")));
    expect(lifecycle).toEqual([]);
    expect(manager.health().map((entry) => entry.reason)).toEqual(["skipped", "skipped"]);
    await manager.stop();
  });

  it("resolves a channel whose provider is an alias of a registered provider", async () => {
    const registry = new NativeChannelDriverRegistry();
    const created: string[] = [];
    registry.register({
      descriptor: {
        protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
        driverId: "example.whatsapp",
        provider: "whatsapp",
        capabilities: ["inbound"],
      },
      createRuntime(context) {
        created.push(`${context.channel.name}:${context.channel.provider}`);
        return {
          descriptor: {
            protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
            schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
            driverId: "example.whatsapp",
            provider: "whatsapp",
            runtimeId: context.channel.name,
            channelInstanceId: context.channel.name,
            capabilities: ["inbound"],
          },
          start() {},
          stop() {},
          health: () => ({ status: "connected" as const }),
        };
      },
    });
    const leases: string[] = [];
    const manager = new NativeChannelDriverManager({
      channels: channels(channel("wa-legacy", "whatsapp-baileys")),
      registry,
      createHostLease: (_channel, provider) => {
        leases.push(provider);
        return hostLease();
      },
    });

    await manager.start();

    expect(created).toEqual(["wa-legacy:whatsapp"]);
    expect(leases).toEqual(["whatsapp"]);
    expect(manager.health()).toEqual([
      { id: "whatsapp:wa-legacy:wa-legacy", channelId: "whatsapp", status: "connected" },
    ]);
    await manager.stop();
  });
});
