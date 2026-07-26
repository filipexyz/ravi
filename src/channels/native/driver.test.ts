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
    readInstallationCredential: mock(async () => null),
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
      requiredHostCapabilities: ["installation_credentials"],
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

  it("fails closed before runtime creation when a required host capability is absent", async () => {
    const registry = new NativeChannelDriverRegistry();
    const driver = fullDriver();
    const createRuntime = mock(driver.createRuntime.bind(driver));
    registry.register({ ...driver, createRuntime });
    const lease = hostLease();
    const incompleteHost = {
      ...lease.host,
      readInstallationCredential: undefined,
    } as unknown as NativeChannelDriverHost;
    const manager = new NativeChannelDriverManager({
      channels: { "example-channel-a": channel() },
      registry,
      createHostLease: () => ({
        host: incompleteHost,
        dispose: lease.dispose,
      }),
    });

    await manager.start();

    expect(createRuntime).not.toHaveBeenCalled();
    expect(manager.health()).toEqual([
      {
        id: "example:example-channel-a",
        channelId: "example",
        status: "failed",
        reason: "host_capability_missing",
      },
    ]);
    expect(lease.dispose).toHaveBeenCalledTimes(1);
  });

  it("fails closed when local agent reconciliation is required but absent", async () => {
    const registry = new NativeChannelDriverRegistry();
    const driver = fullDriver();
    const createRuntime = mock(driver.createRuntime.bind(driver));
    registry.register({
      ...driver,
      descriptor: {
        ...driver.descriptor,
        requiredHostCapabilities: ["installation_credentials", "local_agent_reconciliation"],
      },
      createRuntime,
    });
    const lease = hostLease();
    const incompleteHost = {
      ...lease.host,
      reconcileLocalAgent: undefined,
    } as unknown as NativeChannelDriverHost;
    const manager = new NativeChannelDriverManager({
      channels: { "example-channel-a": channel() },
      registry,
      createHostLease: () => ({
        host: incompleteHost,
        dispose: lease.dispose,
      }),
    });

    await manager.start();

    expect(createRuntime).not.toHaveBeenCalled();
    expect(manager.health()).toEqual([
      {
        id: "example:example-channel-a",
        channelId: "example",
        status: "failed",
        reason: "host_capability_missing",
      },
    ]);
    expect(lease.dispose).toHaveBeenCalledTimes(1);
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

  it("binds installation credential access to the configured provider and connection", async () => {
    const resolveInstallationCredential = mock(async () => ({
      provider: "example",
      credentialId: "credential-1",
      material: { privateKey: "opaque-private-material" },
    }));
    const lease = createNativeChannelDriverHostLease({
      channel: {
        ...channel(),
        credentialConnection: "https://remote.example",
      },
      provider: "example",
      resolveInstallationCredential,
    });

    await expect(lease.host.readInstallationCredential()).resolves.toEqual({
      provider: "example",
      credentialId: "credential-1",
      material: { privateKey: "opaque-private-material" },
    });
    expect(resolveInstallationCredential).toHaveBeenCalledWith({
      provider: "example",
      connection: "https://remote.example",
    });

    const wrongProvider = createNativeChannelDriverHostLease({
      channel: channel(),
      provider: "example",
      resolveInstallationCredential: async () => ({
        provider: "other",
        credentialId: "credential-2",
        material: {},
      }),
    });
    await expect(wrongProvider.host.readInstallationCredential()).rejects.toThrow("scope_mismatch");

    lease.dispose();
    await expect(lease.host.readInstallationCredential()).rejects.toThrow("host_disposed");
    wrongProvider.dispose();
  });

  it("binds local agent reconciliation to the configured channel instance", async () => {
    const reconcileLocalAgent = mock(async (request) => ({
      protocol: "ravi.agent.local-reconciliation" as const,
      schemaVersion: 1 as const,
      requestId: request.requestId,
      disposition: "unchanged" as const,
      state: "ready" as const,
      agentId: "native-channel-example",
      appliedRevision: request.revision,
      grantedCapabilities: [],
      observedAt: "2026-07-26T00:00:00.000Z",
    }));
    const lease = createNativeChannelDriverHostLease({
      channel: channel(),
      provider: "example",
      reconcileLocalAgent,
    });
    const request = {
      protocol: "ravi.agent.local-reconciliation" as const,
      schemaVersion: 1 as const,
      requestId: "request-local-agent-1",
      idempotencyKey: "idempotency-local-agent-1",
      sourceId: "example-channel-a",
      agentKey: "agent-key-1",
      templateId: "native-channel-default",
      revision: "a".repeat(64),
      requestedCapabilities: [],
    };

    await expect(lease.host.reconcileLocalAgent?.(request)).resolves.toMatchObject({
      state: "ready",
      agentId: "native-channel-example",
    });
    expect(reconcileLocalAgent).toHaveBeenCalledWith(request);
    await expect(
      lease.host.reconcileLocalAgent?.({
        ...request,
        requestId: "request-local-agent-2",
        sourceId: "other-channel",
      }),
    ).rejects.toThrow("scope_mismatch");
    expect(reconcileLocalAgent).toHaveBeenCalledTimes(1);

    lease.dispose();
    await expect(lease.host.reconcileLocalAgent?.(request)).rejects.toThrow("host_disposed");
  });

  it("rejects duplicate driver ownership without replacing the registered driver", () => {
    const registry = new NativeChannelDriverRegistry();
    const first = fullDriver();
    registry.register(first);

    expect(() => registry.register(fullDriver())).toThrow(NativeChannelDriverContractError);
    expect(registry.get("example")).toBe(first);
  });
});
