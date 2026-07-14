import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { configStore } from "../config-store.js";
import { nats } from "../nats.js";
import { dbUpdateAgent, dbUpsertChat, dbUpsertDaemonRestartEpoch } from "../router/router-db.js";
import { attachChatToSession, getOrCreateSession, getSession, updateRuntimeProviderState } from "../router/sessions.js";
import type { AgentConfig } from "../router/types.js";
import { listSessionEvents } from "../session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateTask, dbDispatchTask, dbGetTask } from "../tasks/task-db.js";
import { RuntimeSessionDispatcher } from "./session-dispatcher.js";
import { createCodexRuntimeProvider } from "./codex-provider.js";
import { createRuntimeCredential } from "./credential-store.js";
import { formatUserFacingTurnFailure } from "./host-event-loop.js";
import { readLearningLoopCadenceState } from "./learning-loop-cadence.js";
import { registerRuntimeProvider, unregisterRuntimeProvider } from "./provider-registry.js";
import { reconstructRuntimeTargetTurnState } from "./target-policy-trace.js";
import type { RuntimeCapabilities, RuntimeEvent, RuntimeStartRequest, SessionRuntimeProvider } from "./types.js";

const primary = "e2e-failing-primary";
const secondary = "e2e-working-secondary";
const tertiary = "e2e-failing-tertiary";
let stateDir: string | null = null;

describe("runtime target failure redaction", () => {
  it("redacts provider credentials before emitting a user-facing failure", () => {
    expect(formatUserFacingTurnFailure("Incorrect API key provided: sk-proj-SYNTHETICSECRET123456789")).toBe(
      "Error: Incorrect API key provided: [REDACTED]",
    );
    expect(formatUserFacingTurnFailure("Authorization: Bearer SYNTHETICTOKEN123456789")).toBe(
      "Error: Authorization: [REDACTED]",
    );
  });
});

function readTracePayloadString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

const capabilities: RuntimeCapabilities = {
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "none" },
  execution: { mode: "sdk" },
  sessionState: { mode: "none" },
  usage: { semantics: "terminal-event" },
  tools: { permissionMode: "ravi-host", accessRequirement: "tool_and_executable", supportsParallelCalls: false },
  systemPrompt: { mode: "append" },
  terminalEvents: { guarantee: "adapter" },
  skillVisibility: { availability: "none", loadedState: "none" },
  supportsSessionResume: false,
  supportsSessionFork: false,
  supportsPartialText: true,
  supportsToolHooks: true,
  supportsHostSessionHooks: false,
  supportsPlugins: false,
  supportsMcpServers: false,
  supportsRemoteSpawn: false,
};

const resumableCapabilities: RuntimeCapabilities = {
  ...capabilities,
  sessionState: { mode: "provider-session-id" },
  supportsSessionResume: true,
};

function grantRuntimeTargets(agent: AgentConfig): void {
  agent.defaults = {
    ...(agent.defaults ?? {}),
    runtimePermissions: {
      profile: "full-access",
      capabilities: [{ permission: "use", objectType: "runtime.target", objectId: "*" }],
    },
  };
  dbUpdateAgent(agent.id, { defaults: agent.defaults });
}

function provider(
  id: string,
  eventsForTurn:
    | RuntimeEvent[]
    | ((input: { request: RuntimeStartRequest; prompt: string }) => RuntimeEvent[] | Promise<RuntimeEvent[]>),
  onStart?: (request: RuntimeStartRequest) => void,
  providerCapabilities: RuntimeCapabilities = capabilities,
): SessionRuntimeProvider {
  return {
    id,
    getCapabilities: () => providerCapabilities,
    startSession: (request: RuntimeStartRequest) => {
      onStart?.(request);
      return {
        provider: id,
        events: (async function* () {
          const next = await request.prompt.next();
          const prompt = next.value?.message.content ?? "";
          const events = typeof eventsForTurn === "function" ? await eventsForTurn({ request, prompt }) : eventsForTurn;
          for (const event of events) yield event;
        })(),
        interrupt: async () => {},
      };
    },
  };
}

describe("runtime target failover E2E", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-target-e2e-");
    configStore.refresh();
  });

  afterEach(async () => {
    unregisterRuntimeProvider(primary);
    unregisterRuntimeProvider(secondary);
    unregisterRuntimeProvider(tertiary);
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("fails primary, starts an incompatible secondary without stale resume state, and emits exactly one response", async () => {
    let primaryRequest: RuntimeStartRequest | undefined;
    let secondaryRequest: RuntimeStartRequest | undefined;
    const codexProvider = createCodexRuntimeProvider({
      defaultModel: "gpt-5",
      transport: {
        startTurn: () => ({
          events: (async function* () {
            yield { type: "thread.started", thread_id: "primary-session" };
            yield { type: "turn.started", turn_id: "primary-turn" };
          })(),
          result: Promise.resolve({
            exitCode: null,
            signal: "SIGTERM",
            stderr: "Codex process terminated unexpectedly",
          }),
          interrupt: () => {},
        }),
      } as any,
    });
    registerRuntimeProvider(primary, () => ({
      ...codexProvider,
      id: primary,
      startSession: (request) => {
        primaryRequest = request;
        const session = codexProvider.startSession(request);
        return { ...session, provider: primary };
      },
    }));
    registerRuntimeProvider(secondary, () =>
      provider(
        secondary,
        [
          { type: "assistant.message", text: "completed by secondary" },
          { type: "turn.complete", providerSessionId: "secondary-session", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        (request) => {
          secondaryRequest = request;
        },
        resumableCapabilities,
      ),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "e2e-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        targets: [
          { id: "primary", runtimeProvider: primary, model: "primary-model" },
          { id: "secondary", runtimeProvider: secondary, model: "secondary-model" },
        ],
      },
    };
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "e2e",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    getOrCreateSession("target-e2e", "main", stateDir ?? "/tmp", { name: "target-e2e" });
    updateRuntimeProviderState("target-e2e", primary, { providerSessionId: "primary-session" });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "e2e-chat@s.whatsapp.net",
      chatType: "dm",
      title: "target failover e2e",
    });
    attachChatToSession({ sessionKey: "target-e2e", chatId: chat.id, setOutputTarget: true });

    try {
      await dispatcher.startStreamingSession("target-e2e", {
        prompt: "finish this logical turn",
        _agentId: "main",
        source: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "e2e-chat@s.whatsapp.net",
          canonicalChatId: chat.id,
        },
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.some((event) => event.topic === "ravi.session.target-e2e.response")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const responses = emitted.filter((event) => event.topic === "ravi.session.target-e2e.response");
      expect(responses).toHaveLength(1);
      expect(responses[0]?.data.response).toBe("completed by secondary");
      expect(primaryRequest?.resume).toBe("primary-session");
      expect(secondaryRequest?.resume).toBeUndefined();
      expect(
        emitted.filter(
          (event) => event.topic === "ravi.session.target-e2e.runtime" && event.data.type === "turn.failed",
        ),
      ).toHaveLength(0);
      const targetEvents = listSessionEvents("target-e2e");
      expect(targetEvents.filter((event) => event.eventType === "runtime.target.selected")).toHaveLength(2);
      expect(targetEvents.some((event) => event.eventType === "runtime.target.considered")).toBe(true);
      expect(
        targetEvents.some(
          (event) =>
            event.eventType === "runtime.target.rejected" &&
            readTracePayloadString(event.payloadJson, "targetId") === "primary" &&
            readTracePayloadString(event.payloadJson, "reason") === "attempts_exhausted",
        ),
      ).toBe(true);
      expect(readLearningLoopCadenceState(getSession("target-e2e")?.runtimeSessionParams)?.terminalTurnCount).toBe(1);
    } finally {
      dispatcher.shutdownAll();
      emitSpy.mockRestore();
    }
  });

  it("keeps a task active when structured quota recovers through target policy", async () => {
    const credentialSecretEnv = "RAVI_TEST_TARGET_QUOTA_KEY";
    const previousCredentialSecret = process.env[credentialSecretEnv];
    process.env[credentialSecretEnv] = "sk-test_target_quota_secret";
    createRuntimeCredential({
      id: "rcred_target_quota_primary",
      label: "Target quota primary",
      runtimeProvider: primary,
      priority: 100,
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "SYNTHETIC_API_KEY",
          secretRef: `env:${credentialSecretEnv}`,
          sourceHint: credentialSecretEnv,
          sensitive: true,
          remoteForward: false,
        },
      ],
    });
    let primaryExecutions = 0;
    let secondaryExecutions = 0;
    registerRuntimeProvider(primary, () =>
      provider(primary, () => {
        primaryExecutions++;
        return [
          {
            type: "turn.failed",
            error: "Exceeded your current quota",
            recoverable: true,
            rawEvent: { status: 429 },
          },
        ];
      }),
    );
    registerRuntimeProvider(secondary, () =>
      provider(secondary, () => {
        secondaryExecutions++;
        return [
          { type: "assistant.message", text: "quota recovered by secondary" },
          { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
        ];
      }),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "task-quota-recovery-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        maxCredentialRecoveryAttemptsPerTarget: 1,
        targets: [
          {
            id: "primary",
            runtimeProvider: primary,
            model: "primary-model",
            credentialRequirements: { requireManaged: true, credentialIds: ["rcred_target_quota_primary"] },
          },
          { id: "secondary", runtimeProvider: secondary, model: "secondary-model" },
        ],
      },
    };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });
    const sessionName = "target-task-quota-recovery";
    const created = dbCreateTask({
      title: "Target policy quota recovery",
      instructions: "Remain runnable while target policy recovers structured quota.",
      createdBy: "test",
    });
    dbDispatchTask(created.task.id, {
      agentId: "main",
      sessionName,
      assignedBy: "test",
    });
    getOrCreateSession(sessionName, "main", stateDir ?? "/tmp", { name: sessionName });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "task-quota-recovery@s.whatsapp.net",
      chatType: "dm",
      title: "runtime target quota recovery",
    });
    attachChatToSession({ sessionKey: sessionName, chatId: chat.id, setOutputTarget: true });
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "task-quota-recovery",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    try {
      await dispatcher.startStreamingSession(sessionName, {
        prompt: "finish despite primary quota",
        _agentId: "main",
        taskBarrierTaskId: created.task.id,
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.some((event) => event.topic === `ravi.session.${sessionName}.response`)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(primaryExecutions).toBe(1);
      expect(secondaryExecutions).toBe(1);
      expect(emitted.filter((event) => event.topic === `ravi.session.${sessionName}.response`)).toHaveLength(1);
      expect(dbGetTask(created.task.id)?.status).toBe("in_progress");
      expect(readLearningLoopCadenceState(getSession(sessionName)?.runtimeSessionParams)?.terminalTurnCount).toBe(1);
    } finally {
      dispatcher.shutdownAll();
      emitSpy.mockRestore();
      if (previousCredentialSecret === undefined) delete process.env[credentialSecretEnv];
      else process.env[credentialSecretEnv] = previousCredentialSecret;
    }
  });

  it("preserves startup quota through exhaustion and clears it after successful failover", async () => {
    const credentialSecretEnv = "RAVI_TEST_STARTUP_QUOTA_KEY";
    const previousCredentialSecret = process.env[credentialSecretEnv];
    process.env[credentialSecretEnv] = "sk-test_startup_quota_secret";
    createRuntimeCredential({
      id: "rcred_startup_quota_primary",
      label: "Startup quota primary",
      runtimeProvider: primary,
      priority: 100,
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "SYNTHETIC_API_KEY",
          secretRef: `env:${credentialSecretEnv}`,
          sourceHint: credentialSecretEnv,
          sensitive: true,
          remoteForward: false,
        },
      ],
    });
    let primaryStarts = 0;
    let secondaryStarts = 0;
    registerRuntimeProvider(primary, () => ({
      id: primary,
      getCapabilities: () => capabilities,
      startSession: () => {
        primaryStarts++;
        throw Object.assign(new Error("Exceeded your current quota during startup"), { status: 429 });
      },
    }));
    registerRuntimeProvider(secondary, () => ({
      id: secondary,
      getCapabilities: () => capabilities,
      startSession: () => {
        secondaryStarts++;
        throw Object.assign(new Error("secondary startup outage"), { status: 503 });
      },
    }));
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "startup-quota-exhaustion-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        maxCredentialRecoveryAttemptsPerTarget: 0,
        targets: [
          {
            id: "primary",
            runtimeProvider: primary,
            model: "primary-model",
            credentialRequirements: { requireManaged: true, credentialIds: ["rcred_startup_quota_primary"] },
          },
          { id: "secondary", runtimeProvider: secondary, model: "secondary-model" },
        ],
      },
    };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });
    const sessionName = "target-startup-quota-exhaustion";
    const created = dbCreateTask({
      title: "Startup quota target exhaustion",
      instructions: "Block only after target policy exhausts.",
      createdBy: "test",
    });
    dbDispatchTask(created.task.id, {
      agentId: "main",
      sessionName,
      assignedBy: "test",
    });
    getOrCreateSession(sessionName, "main", stateDir ?? "/tmp", { name: sessionName });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "startup-quota-exhaustion",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    try {
      await dispatcher.startStreamingSession(sessionName, {
        prompt: "exhaust startup quota policy",
        _agentId: "main",
        taskBarrierTaskId: created.task.id,
      });
      for (let attempt = 0; attempt < 200; attempt++) {
        if (dbGetTask(created.task.id)?.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(primaryStarts).toBe(1);
      expect(secondaryStarts).toBe(1);
      expect(dbGetTask(created.task.id)?.status).toBe("blocked");
      expect(readLearningLoopCadenceState(getSession(sessionName)?.runtimeSessionParams)?.terminalTurnCount).toBe(1);

      primaryStarts = 0;
      secondaryStarts = 0;
      registerRuntimeProvider(secondary, () =>
        provider(
          secondary,
          [
            { type: "assistant.message", text: "startup quota recovered" },
            { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
          ],
          () => {
            secondaryStarts++;
          },
        ),
      );
      const recoveredSessionName = "target-startup-quota-recovered";
      const recovered = dbCreateTask({
        title: "Startup quota target recovery",
        instructions: "Remain active when the fallback target succeeds.",
        createdBy: "test",
      });
      dbDispatchTask(recovered.task.id, {
        agentId: "main",
        sessionName: recoveredSessionName,
        assignedBy: "test",
      });
      getOrCreateSession(recoveredSessionName, "main", stateDir ?? "/tmp", { name: recoveredSessionName });
      await dispatcher.startStreamingSession(recoveredSessionName, {
        prompt: "recover startup quota policy",
        _agentId: "main",
        taskBarrierTaskId: recovered.task.id,
      });
      for (let attempt = 0; attempt < 200; attempt++) {
        const cadence = readLearningLoopCadenceState(getSession(recoveredSessionName)?.runtimeSessionParams);
        if (cadence?.terminalTurnCount === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(primaryStarts).toBe(1);
      expect(secondaryStarts).toBe(1);
      expect(dbGetTask(recovered.task.id)?.status).toBe("in_progress");
      expect(
        readLearningLoopCadenceState(getSession(recoveredSessionName)?.runtimeSessionParams)?.terminalTurnCount,
      ).toBe(1);

      const noPolicyDefaults = { ...(agent.defaults ?? {}) };
      delete noPolicyDefaults.runtimeTargetPolicy;
      agent.defaults = noPolicyDefaults;
      dbUpdateAgent(agent.id, { defaults: agent.defaults });
      primaryStarts = 0;
      const noPolicySessionName = "startup-quota-without-policy";
      const noPolicyTask = dbCreateTask({
        title: "Startup quota without target policy",
        instructions: "Block immediately because there is no recovery policy.",
        createdBy: "test",
      });
      dbDispatchTask(noPolicyTask.task.id, {
        agentId: "main",
        sessionName: noPolicySessionName,
        assignedBy: "test",
      });
      getOrCreateSession(noPolicySessionName, "main", stateDir ?? "/tmp", { name: noPolicySessionName });
      await dispatcher.startStreamingSession(noPolicySessionName, {
        prompt: "block startup quota immediately",
        _agentId: "main",
        _runtimeProviderId: primary,
        taskBarrierTaskId: noPolicyTask.task.id,
      });
      for (let attempt = 0; attempt < 200; attempt++) {
        if (dbGetTask(noPolicyTask.task.id)?.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(primaryStarts).toBe(1);
      expect(dbGetTask(noPolicyTask.task.id)?.status).toBe("blocked");
    } finally {
      dispatcher.shutdownAll();
      if (previousCredentialSecret === undefined) delete process.env[credentialSecretEnv];
      else process.env[credentialSecretEnv] = previousCredentialSecret;
    }
  });

  it("buffers a target response until success so a later failure cannot emit twice", async () => {
    registerRuntimeProvider(primary, () =>
      provider(primary, [
        { type: "assistant.message", text: "primary response must be discarded" },
        {
          type: "turn.failed",
          error: "primary provider unavailable after responding",
          recoverable: true,
          metadata: { failureScope: "target" },
        },
      ]),
    );
    registerRuntimeProvider(secondary, () =>
      provider(secondary, [
        { type: "assistant.message", text: "secondary is authoritative" },
        { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "response-buffer-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        targets: [
          { id: "primary", runtimeProvider: primary, model: "primary-model" },
          { id: "secondary", runtimeProvider: secondary, model: "secondary-model" },
        ],
      },
    };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });
    const sessionName = "target-response-buffer";
    getOrCreateSession(sessionName, "main", stateDir ?? "/tmp", { name: sessionName });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "response-buffer@s.whatsapp.net",
      chatType: "dm",
      title: "runtime target response buffer",
    });
    attachChatToSession({ sessionKey: sessionName, chatId: chat.id, setOutputTarget: true });
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "response-buffer",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    try {
      await dispatcher.startStreamingSession(sessionName, { prompt: "respond exactly once", _agentId: "main" });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.some((event) => event.topic === `ravi.session.${sessionName}.response`)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      const responses = emitted.filter((event) => event.topic === `ravi.session.${sessionName}.response`);
      expect(responses).toHaveLength(1);
      expect(responses[0]?.data.response).toBe("secondary is authoritative");
      expect(readLearningLoopCadenceState(getSession(sessionName)?.runtimeSessionParams)?.terminalTurnCount).toBe(1);
    } finally {
      dispatcher.shutdownAll();
      emitSpy.mockRestore();
    }
  });

  it("switches targets when a provider fails before its event stream starts", async () => {
    let primaryStarts = 0;
    let secondaryStarts = 0;
    registerRuntimeProvider(primary, () => ({
      id: primary,
      getCapabilities: () => capabilities,
      startSession: () => {
        primaryStarts++;
        throw Object.assign(new Error("synthetic provider startup outage"), { status: 503 });
      },
    }));
    registerRuntimeProvider(secondary, () =>
      provider(
        secondary,
        [
          { type: "assistant.message", text: "secondary survived startup failure" },
          { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        () => {
          secondaryStarts++;
        },
      ),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "startup-failure-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        targets: [
          { id: "primary", runtimeProvider: primary, model: "primary-model" },
          { id: "secondary", runtimeProvider: secondary, model: "secondary-model" },
        ],
      },
    };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });
    const sessionName = "target-startup-failure";
    getOrCreateSession(sessionName, "main", stateDir ?? "/tmp", { name: sessionName });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "startup-failure@s.whatsapp.net",
      chatType: "dm",
      title: "runtime target startup failure e2e",
    });
    attachChatToSession({ sessionKey: sessionName, chatId: chat.id, setOutputTarget: true });
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "startup-failure",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    try {
      await dispatcher.startStreamingSession(sessionName, {
        prompt: "survive provider startup failure",
        _agentId: "main",
        source: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "startup-failure@s.whatsapp.net",
          canonicalChatId: chat.id,
        },
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.some((event) => event.topic === `ravi.session.${sessionName}.response`)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(primaryStarts).toBe(1);
      expect(secondaryStarts).toBe(1);
      const responses = emitted.filter((event) => event.topic === `ravi.session.${sessionName}.response`);
      expect(responses).toHaveLength(1);
      expect(responses[0]?.data.response).toBe("secondary survived startup failure");
      expect(readLearningLoopCadenceState(getSession(sessionName)?.runtimeSessionParams)?.terminalTurnCount).toBe(1);
    } finally {
      dispatcher.shutdownAll();
      emitSpy.mockRestore();
    }
  });

  it("fails closed on startup exceptions instead of replaying on another target", async () => {
    let primaryStarts = 0;
    let secondaryStarts = 0;
    const failures: unknown[] = [
      new Error("Invalid API key"),
      Object.assign(new Error("token expired"), { name: "InternalStateError" }),
      "credential unavailable",
    ];
    registerRuntimeProvider(primary, () => ({
      id: primary,
      getCapabilities: () => capabilities,
      startSession: () => {
        const failure = failures[primaryStarts];
        primaryStarts++;
        throw failure;
      },
    }));
    registerRuntimeProvider(secondary, () =>
      provider(
        secondary,
        [
          { type: "assistant.message", text: "must never run" },
          { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        () => {
          secondaryStarts++;
        },
      ),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "startup-programmer-error-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        targets: [
          { id: "primary", runtimeProvider: primary, model: "primary-model" },
          { id: "secondary", runtimeProvider: secondary, model: "secondary-model" },
        ],
      },
    };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    try {
      for (let index = 0; index < failures.length; index++) {
        const sessionName = `target-startup-exception-${index}`;
        getOrCreateSession(sessionName, "main", stateDir ?? "/tmp", { name: sessionName });
        const dispatcher = new RuntimeSessionDispatcher({
          instanceId: `startup-exception-${index}`,
          maxConcurrentSessions: 2,
          interactiveReservedSessions: 0,
          safeEmit: async () => {},
          getConfigModel: () => "fallback-model",
        });
        try {
          await dispatcher.startStreamingSession(sessionName, {
            prompt: "do not replay internal errors",
            _agentId: "main",
          });
          expect(primaryStarts).toBe(index + 1);
          expect(secondaryStarts).toBe(0);
          expect(emitted.filter((event) => event.topic === `ravi.session.${sessionName}.response`)).toHaveLength(0);
          expect(readLearningLoopCadenceState(getSession(sessionName)?.runtimeSessionParams)?.terminalTurnCount).toBe(
            1,
          );
        } finally {
          dispatcher.shutdownAll();
        }
      }
    } finally {
      emitSpy.mockRestore();
    }
  });

  it("honors the credential recovery budget when startup fails before switching targets", async () => {
    let primaryStarts = 0;
    let secondaryStarts = 0;
    registerRuntimeProvider(primary, () => ({
      id: primary,
      getCapabilities: () => capabilities,
      startSession: () => {
        primaryStarts++;
        throw Object.assign(new Error("runtime credential expired during startup"), { status: 401 });
      },
    }));
    registerRuntimeProvider(secondary, () =>
      provider(
        secondary,
        [
          { type: "assistant.message", text: "credential startup budget respected" },
          { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        () => {
          secondaryStarts++;
        },
      ),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "startup-credential-budget-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        maxCredentialRecoveryAttemptsPerTarget: 1,
        targets: [
          { id: "primary", runtimeProvider: primary, model: "primary-model" },
          { id: "secondary", runtimeProvider: secondary, model: "secondary-model" },
        ],
      },
    };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });
    const sessionName = "target-startup-credential-budget";
    getOrCreateSession(sessionName, "main", stateDir ?? "/tmp", { name: sessionName });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "startup-credential-budget@s.whatsapp.net",
      chatType: "dm",
      title: "runtime target startup credential budget",
    });
    attachChatToSession({ sessionKey: sessionName, chatId: chat.id, setOutputTarget: true });
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "startup-credential-budget",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    try {
      await dispatcher.startStreamingSession(sessionName, { prompt: "respect startup budget", _agentId: "main" });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.some((event) => event.topic === `ravi.session.${sessionName}.response`)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(primaryStarts).toBe(2);
      expect(secondaryStarts).toBe(1);
      expect(emitted.filter((event) => event.topic === `ravi.session.${sessionName}.response`)).toHaveLength(1);
    } finally {
      dispatcher.shutdownAll();
      emitSpy.mockRestore();
    }
  });

  it("uses credential requirements as a target gate and advances when none can satisfy them", async () => {
    let primaryStarts = 0;
    let secondaryStarts = 0;
    registerRuntimeProvider(primary, () =>
      provider(primary, [], () => {
        primaryStarts++;
      }),
    );
    registerRuntimeProvider(secondary, () =>
      provider(
        secondary,
        [
          { type: "assistant.message", text: "credential-gated target skipped safely" },
          { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        () => {
          secondaryStarts++;
        },
      ),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "credential-requirement-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        targets: [
          {
            id: "primary",
            runtimeProvider: primary,
            model: "primary-model",
            credentialRequirements: { requireManaged: true, credentialIds: ["missing-credential"] },
          },
          { id: "secondary", runtimeProvider: secondary, model: "secondary-model" },
        ],
      },
    };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });
    const sessionName = "target-credential-requirement";
    getOrCreateSession(sessionName, "main", stateDir ?? "/tmp", { name: sessionName });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "credential-requirement@s.whatsapp.net",
      chatType: "dm",
      title: "runtime target credential requirement e2e",
    });
    attachChatToSession({ sessionKey: sessionName, chatId: chat.id, setOutputTarget: true });
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "credential-requirement",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    try {
      await dispatcher.startStreamingSession(sessionName, {
        prompt: "use only an eligible credential target",
        _agentId: "main",
        source: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "credential-requirement@s.whatsapp.net",
          canonicalChatId: chat.id,
        },
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.some((event) => event.topic === `ravi.session.${sessionName}.response`)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(primaryStarts).toBe(0);
      expect(secondaryStarts).toBe(1);
      const responses = emitted.filter((event) => event.topic === `ravi.session.${sessionName}.response`);
      expect(responses).toHaveLength(1);
      expect(responses[0]?.data.response).toBe("credential-gated target skipped safely");
    } finally {
      dispatcher.shutdownAll();
      emitSpy.mockRestore();
    }
  });

  it("persists an unfinished turn and consumes it once in a fresh dispatcher after daemon restart", async () => {
    let primaryStarts = 0;
    let secondaryStarts = 0;
    let tertiaryStarts = 0;
    let secondaryInterrupted: (() => void) | undefined;
    const consumedPrompts: string[] = [];
    registerRuntimeProvider(primary, () =>
      provider(primary, () => {
        primaryStarts++;
        return [
          {
            type: "turn.failed",
            error: "primary provider unavailable before restart",
            recoverable: true,
            metadata: { failureScope: "target" },
          },
        ];
      }),
    );
    registerRuntimeProvider(secondary, () => ({
      id: secondary,
      getCapabilities: () => capabilities,
      startSession: (request) => {
        return {
          provider: secondary,
          events: (async function* () {
            const next = await request.prompt.next();
            secondaryStarts++;
            consumedPrompts.push(next.value?.message.content ?? "");
            await new Promise<void>((resolve) => {
              secondaryInterrupted = resolve;
            });
          })(),
          interrupt: async () => secondaryInterrupted?.(),
        };
      },
    }));
    registerRuntimeProvider(tertiary, () =>
      provider(tertiary, ({ prompt }) => {
        tertiaryStarts++;
        consumedPrompts.push(prompt);
        return [
          { type: "assistant.message", text: "resumed once after restart" },
          { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
        ];
      }),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "restart-e2e-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        targets: [
          { id: "primary", runtimeProvider: primary, model: "primary-model" },
          { id: "secondary", runtimeProvider: secondary, model: "secondary-model" },
          { id: "tertiary", runtimeProvider: tertiary, model: "tertiary-model" },
        ],
      },
    };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });
    const sessionKey = "target-restart-e2e";
    const sessionName = "target-restart-e2e";
    getOrCreateSession(sessionKey, "main", stateDir ?? "/tmp", { name: sessionName });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "restart-e2e@s.whatsapp.net",
      chatType: "dm",
      title: "restart failover e2e",
    });
    attachChatToSession({ sessionKey, chatId: chat.id, setOutputTarget: true });
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    const firstDispatcher = new RuntimeSessionDispatcher({
      instanceId: "before-restart-e2e",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    const restartedDispatcher = new RuntimeSessionDispatcher({
      instanceId: "restart-e2e",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    try {
      await firstDispatcher.startStreamingSession(sessionName, {
        prompt: "logical work must survive restart exactly once",
        _agentId: "main",
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (secondaryStarts === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(primaryStarts).toBe(1);
      expect(secondaryStarts).toBe(1);
      expect(
        reconstructRuntimeTargetTurnState(sessionKey, "restart-e2e-policy")?.attempts.map(
          (attempt) => attempt.targetId,
        ),
      ).toEqual(["primary", "secondary"]);
      dbUpsertDaemonRestartEpoch({ restartEpoch: "restart-target-e2e", reason: "test", createdAt: Date.now() });
      expect(
        firstDispatcher.recordDaemonRestartSnapshot({
          restartEpoch: "restart-target-e2e",
          reason: "test",
        }),
      ).toBe(1);
      firstDispatcher.shutdownAll();

      await restartedDispatcher.handlePromptImmediate(sessionName, {
        prompt: "[System] Daemon restarted. Continue pending work.",
        _agentId: "main",
        _daemonRestartResume: { restartEpoch: "restart-target-e2e", sessionKey },
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.some((event) => event.topic === `ravi.session.${sessionName}.response`)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(primaryStarts).toBe(1);
      expect(secondaryStarts).toBe(1);
      expect(tertiaryStarts).toBe(1);
      const responses = emitted.filter((event) => event.topic === `ravi.session.${sessionName}.response`);
      expect(responses).toHaveLength(1);
      expect(responses[0]?.data.response).toBe("resumed once after restart");
      expect(
        consumedPrompts.filter((prompt) => prompt.includes("logical work must survive restart exactly once")),
      ).toHaveLength(2);
      expect(consumedPrompts[1]?.match(/logical work must survive restart exactly once/g)).toHaveLength(1);
    } finally {
      firstDispatcher.shutdownAll();
      restartedDispatcher.shutdownAll();
      emitSpy.mockRestore();
    }
  });

  it("does not replay after a tool execution boundary", async () => {
    let secondaryStarts = 0;
    registerRuntimeProvider(primary, () =>
      provider(primary, [
        { type: "tool.started", toolUse: { id: "side-effect", name: "write", input: {} } },
        { type: "turn.failed", error: "target unavailable after tool", recoverable: true },
      ]),
    );
    registerRuntimeProvider(secondary, () =>
      provider(secondary, [], () => {
        secondaryStarts++;
      }),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "post-tool-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        targets: [
          { id: "primary", runtimeProvider: primary, model: "primary-model" },
          { id: "secondary", runtimeProvider: secondary, model: "secondary-model" },
        ],
      },
    };
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "post-tool",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    getOrCreateSession("target-post-tool", "main", stateDir ?? "/tmp", { name: "target-post-tool" });
    const postToolChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "post-tool@s.whatsapp.net",
      chatType: "dm",
      title: "post tool",
    });
    attachChatToSession({ sessionKey: "target-post-tool", chatId: postToolChat.id, setOutputTarget: true });
    try {
      await dispatcher.startStreamingSession("target-post-tool", { prompt: "do work", _agentId: "main" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(secondaryStarts).toBe(0);
      expect(emitted.filter((event) => event.topic === "ravi.session.target-post-tool.response")).toHaveLength(1);
    } finally {
      dispatcher.shutdownAll();
      emitSpy.mockRestore();
    }
  });

  it("recovers a credential on the same target without consuming failover budget", async () => {
    let executions = 0;
    registerRuntimeProvider(primary, () =>
      provider(primary, () => {
        executions++;
        return executions === 1
          ? [
              {
                type: "turn.failed",
                error: "credential expired and requires refresh",
                recoverable: true,
                metadata: { failureScope: "credential" },
              },
            ]
          : [
              { type: "assistant.message", text: "credential recovered" },
              { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
            ];
      }),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "credential-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        targets: [{ id: "primary", runtimeProvider: primary, model: "primary-model" }],
      },
    };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "credential",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    getOrCreateSession("target-credential", "main", stateDir ?? "/tmp", { name: "target-credential" });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "credential@s.whatsapp.net",
      chatType: "dm",
      title: "credential",
    });
    attachChatToSession({ sessionKey: "target-credential", chatId: chat.id, setOutputTarget: true });
    try {
      await dispatcher.startStreamingSession("target-credential", { prompt: "retry credential", _agentId: "main" });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.some((event) => event.topic === "ravi.session.target-credential.response")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(executions).toBe(2);
      expect(emitted.filter((event) => event.topic === "ravi.session.target-credential.response")).toHaveLength(1);
      expect(emitted.find((event) => event.topic === "ravi.session.target-credential.response")?.data.response).toBe(
        "credential recovered",
      );
    } finally {
      dispatcher.shutdownAll();
      emitSpy.mockRestore();
    }
  });

  it("does not replay a caught host exception from credential-like text", async () => {
    let secondaryStarts = 0;
    registerRuntimeProvider(primary, () =>
      provider(primary, [
        {
          type: "turn.failed",
          error: "Invalid API key",
          caughtException: true,
          recoverable: true,
        },
      ]),
    );
    registerRuntimeProvider(secondary, () =>
      provider(secondary, [], () => {
        secondaryStarts++;
      }),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "caught-exception-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        targets: [
          { id: "primary", runtimeProvider: primary, model: "primary-model" },
          { id: "secondary", runtimeProvider: secondary, model: "secondary-model" },
        ],
      },
    };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });
    const sessionName = "target-caught-exception";
    getOrCreateSession(sessionName, "main", stateDir ?? "/tmp", { name: sessionName });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "caught-exception",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    try {
      await dispatcher.startStreamingSession(sessionName, { prompt: "do not replay", _agentId: "main" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(secondaryStarts).toBe(0);
      const trace = listSessionEvents(sessionName);
      expect(trace.some((event) => event.eventType === "runtime.target.replay_blocked")).toBe(true);
    } finally {
      dispatcher.shutdownAll();
    }
  });

  it("limits repeated credential recovery and terminates exactly once", async () => {
    let executions = 0;
    registerRuntimeProvider(primary, () =>
      provider(primary, () => {
        executions++;
        return [
          {
            type: "turn.failed",
            error: "credential remains invalid",
            recoverable: true,
            metadata: { failureScope: "credential" },
          },
        ];
      }),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "credential-budget-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        maxCredentialRecoveryAttemptsPerTarget: 1,
        targets: [{ id: "primary", runtimeProvider: primary, model: "primary-model" }],
      },
    };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "credential-budget",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    getOrCreateSession("target-credential-budget", "main", stateDir ?? "/tmp", { name: "target-credential-budget" });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "credential-budget@s.whatsapp.net",
      chatType: "dm",
      title: "credential budget",
    });
    attachChatToSession({ sessionKey: "target-credential-budget", chatId: chat.id, setOutputTarget: true });
    try {
      await dispatcher.startStreamingSession("target-credential-budget", {
        prompt: "credential must stop",
        _agentId: "main",
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.some((event) => event.topic === "ravi.session.target-credential-budget.response")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(executions).toBe(2);
      expect(emitted.filter((event) => event.topic === "ravi.session.target-credential-budget.response")).toHaveLength(
        1,
      );
    } finally {
      dispatcher.shutdownAll();
      emitSpy.mockRestore();
    }
  });

  it("advances across failures, terminates once, and never replays the exhausted turn with the next prompt", async () => {
    const startedProviders: string[] = [];
    const primaryPrompts: string[] = [];
    registerRuntimeProvider(primary, () =>
      provider(primary, ({ prompt }) => {
        startedProviders.push(primary);
        primaryPrompts.push(prompt);
        return prompt === "fresh independent turn"
          ? [
              { type: "assistant.message", text: "fresh turn completed" },
              { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
            ]
          : [{ type: "turn.failed", error: "primary outage", recoverable: true }];
      }),
    );
    registerRuntimeProvider(secondary, () =>
      provider(secondary, () => {
        startedProviders.push(secondary);
        return [{ type: "turn.failed", error: "secondary outage", recoverable: true }];
      }),
    );
    registerRuntimeProvider(tertiary, () =>
      provider(tertiary, () => {
        startedProviders.push(tertiary);
        return [{ type: "turn.failed", error: "tertiary outage", recoverable: true }];
      }),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "exhaustion-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        cooldownMs: 0,
        targets: [primary, secondary, tertiary].map((runtimeProvider, index) => ({
          id: `target-${index}`,
          runtimeProvider,
          model: `model-${index}`,
        })),
      },
    };
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "exhaustion",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    getOrCreateSession("target-exhaustion", "main", stateDir ?? "/tmp", { name: "target-exhaustion" });
    const exhaustionChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "exhaustion@s.whatsapp.net",
      chatType: "dm",
      title: "exhaustion",
    });
    attachChatToSession({ sessionKey: "target-exhaustion", chatId: exhaustionChat.id, setOutputTarget: true });
    try {
      await dispatcher.startStreamingSession("target-exhaustion", { prompt: "exhaust targets", _agentId: "main" });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.some((event) => event.topic === "ravi.session.target-exhaustion.response")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(startedProviders).toEqual([primary, secondary, tertiary]);
      expect(emitted.filter((event) => event.topic === "ravi.session.target-exhaustion.response")).toHaveLength(1);
      expect(
        readLearningLoopCadenceState(getSession("target-exhaustion")?.runtimeSessionParams)?.terminalTurnCount,
      ).toBe(1);

      await dispatcher.startStreamingSession("target-exhaustion", {
        prompt: "fresh independent turn",
        _agentId: "main",
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.filter((event) => event.topic === "ravi.session.target-exhaustion.response").length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const responses = emitted.filter((event) => event.topic === "ravi.session.target-exhaustion.response");
      expect(primaryPrompts[1]).toBe("fresh independent turn");
      expect(responses).toHaveLength(2);
      expect(responses[1]?.data.response).toBe("fresh turn completed");
      expect(startedProviders).toEqual([primary, secondary, tertiary, primary]);
      expect(primaryPrompts).toEqual(["exhaust targets", "fresh independent turn"]);
      expect(
        readLearningLoopCadenceState(getSession("target-exhaustion")?.runtimeSessionParams)?.terminalTurnCount,
      ).toBe(2);
    } finally {
      dispatcher.shutdownAll();
      emitSpy.mockRestore();
    }
  });

  it("isolates target state by restarting the policy runtime after every successful logical turn", async () => {
    let starts = 0;
    const logicalPrompts: string[] = [];
    registerRuntimeProvider(primary, () => ({
      id: primary,
      getCapabilities: () => capabilities,
      startSession: (request) => {
        starts++;
        return {
          provider: primary,
          events: (async function* () {
            while (true) {
              const next = await request.prompt.next();
              if (next.done) return;
              const text = next.value.message.content;
              logicalPrompts.push(text);
              yield { type: "assistant.message", text: `completed: ${text}` } as RuntimeEvent;
              yield { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } } as RuntimeEvent;
            }
          })(),
          interrupt: async () => {},
        };
      },
    }));
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    grantRuntimeTargets(agent);
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "turn-isolation-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
        cooldownMs: 0,
        targets: [{ id: "primary", runtimeProvider: primary, model: "primary-model" }],
      },
    };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });
    const sessionName = "target-turn-isolation";
    getOrCreateSession(sessionName, "main", stateDir ?? "/tmp", { name: sessionName });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "turn-isolation@s.whatsapp.net",
      chatType: "dm",
      title: "runtime target turn isolation",
    });
    attachChatToSession({ sessionKey: sessionName, chatId: chat.id, setOutputTarget: true });
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      emitted.push({ topic, data: data as Record<string, unknown> });
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "turn-isolation",
      maxConcurrentSessions: 2,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      getConfigModel: () => "fallback-model",
    });
    try {
      await dispatcher.startStreamingSession(sessionName, { prompt: "first turn", _agentId: "main" });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.filter((event) => event.topic === `ravi.session.${sessionName}.response`).length === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        if (listSessionEvents(sessionName).some((event) => event.eventType === "turn.complete")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      await dispatcher.startStreamingSession(sessionName, { prompt: "second turn", _agentId: "main" });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (emitted.filter((event) => event.topic === `ravi.session.${sessionName}.response`).length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(starts).toBe(2);
      expect(logicalPrompts).toEqual(["first turn", "second turn"]);
      const logicalTurnIds = listSessionEvents(sessionName)
        .filter((event) => event.eventType === "runtime.target.selected")
        .map((event) => readTracePayloadString(event.payloadJson, "logicalTurnId"));
      expect(new Set(logicalTurnIds).size).toBe(2);
    } finally {
      dispatcher.shutdownAll();
      emitSpy.mockRestore();
    }
  });
});
