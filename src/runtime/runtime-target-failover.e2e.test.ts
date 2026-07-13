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

function provider(id: string, eventsForTurn: RuntimeEvent[]): SessionRuntimeProvider {
  return {
    id,
    getCapabilities: () => capabilities,
    startSession: (request: RuntimeStartRequest) => ({
      provider: id,
      events: (async function* () {
        await request.prompt.next();
        for (const event of eventsForTurn) yield event;
      })(),
      interrupt: async () => {},
    }),
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
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("fails primary, completes on secondary and emits exactly one final response", async () => {
    registerRuntimeProvider(primary, () =>
      provider(primary, [{ type: "turn.failed", error: "synthetic primary outage", recoverable: true }]),
    );
    registerRuntimeProvider(secondary, () =>
      provider(secondary, [
        { type: "assistant.message", text: "completed by secondary" },
        { type: "turn.complete", providerSessionId: "secondary-session", usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
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
});
