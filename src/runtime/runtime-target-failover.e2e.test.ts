import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { configStore } from "../config-store.js";
import { nats } from "../nats.js";
import { dbUpsertChat } from "../router/router-db.js";
import { attachChatToSession, getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { RuntimeSessionDispatcher } from "./session-dispatcher.js";
import { registerRuntimeProvider, unregisterRuntimeProvider } from "./provider-registry.js";
import type { RuntimeCapabilities, RuntimeEvent, RuntimeStartRequest, SessionRuntimeProvider } from "./types.js";

const primary = "e2e-failing-primary";
const secondary = "e2e-working-secondary";
const tertiary = "e2e-failing-tertiary";
let stateDir: string | null = null;

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

function provider(
  id: string,
  eventsForTurn: RuntimeEvent[],
  onStart?: (request: RuntimeStartRequest) => void,
): SessionRuntimeProvider {
  return {
    id,
    getCapabilities: () => capabilities,
    startSession: (request: RuntimeStartRequest) => {
      onStart?.(request);
      return {
        provider: id,
        events: (async function* () {
          await request.prompt.next();
          for (const event of eventsForTurn) yield event;
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

  it("fails primary, completes on secondary and emits exactly one final response", async () => {
    let secondaryRequest: RuntimeStartRequest | undefined;
    registerRuntimeProvider(primary, () =>
      provider(primary, [{ type: "turn.failed", error: "synthetic primary outage", recoverable: true }]),
    );
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
      ),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
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
      expect(secondaryRequest?.resume).toBeUndefined();
      expect(
        emitted.filter(
          (event) => event.topic === "ravi.session.target-e2e.runtime" && event.data.type === "turn.failed",
        ),
      ).toHaveLength(0);
    } finally {
      dispatcher.shutdownAll();
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

  it("advances across multiple recoverable failures and terminates once", async () => {
    const startedProviders: string[] = [];
    registerRuntimeProvider(primary, () =>
      provider(primary, [{ type: "turn.failed", error: "primary outage", recoverable: true }], () =>
        startedProviders.push(primary),
      ),
    );
    registerRuntimeProvider(secondary, () =>
      provider(secondary, [{ type: "turn.failed", error: "secondary outage", recoverable: true }], () =>
        startedProviders.push(secondary),
      ),
    );
    registerRuntimeProvider(tertiary, () =>
      provider(tertiary, [{ type: "turn.failed", error: "tertiary terminal", recoverable: false }], () =>
        startedProviders.push(tertiary),
      ),
    );
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    agent.defaults = {
      ...(agent.defaults ?? {}),
      runtimeTargetPolicy: {
        id: "exhaustion-policy",
        strategy: "ordered",
        maxAttemptsPerTarget: 1,
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
        if (
          emitted.some(
            (event) => event.topic === "ravi.session.target-exhaustion.runtime" && event.data.type === "turn.failed",
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(startedProviders).toEqual([primary, secondary, tertiary]);
      expect(emitted.filter((event) => event.topic === "ravi.session.target-exhaustion.response")).toHaveLength(1);
    } finally {
      dispatcher.shutdownAll();
      emitSpy.mockRestore();
    }
  });
});
