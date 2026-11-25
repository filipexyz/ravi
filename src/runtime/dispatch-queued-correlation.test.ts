import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as pricing from "../costs/pricing-catalog.js";
import { nats } from "../nats.js";
import { dbCreateAgent } from "../router/router-db.js";
import { getOrCreateSession, resolveSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import { RuntimeSessionDispatcher } from "./session-dispatcher.js";

/**
 * 25/11 (voice call on session `main`): the voice door waits on the whole
 * session's runtime topic. Every prompt that queues there emits
 * `dispatch.queued`, so the door could not tell its own queued prompt from a
 * Slack message queued after it. The dispatcher now echoes the prompt's
 * `_correlationId` on that event.
 */

let stateDir: string | null = null;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-dispatch-queued-correlation-");
  dbCreateAgent({ id: "agent-a", name: "Agent A", cwd: stateDir });
  const emit = spyOn(nats, "emit").mockImplementation(async () => {});
  const prewarm = spyOn(pricing, "prewarmPricingCatalog").mockImplementation(() => {});
  cleanups.push(
    () => emit.mockRestore(),
    () => prewarm.mockRestore(),
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function busyFixture() {
  const sessionKey = "agent:agent-a:main";
  getOrCreateSession(sessionKey, "agent-a", stateDir!, { name: "main" });
  const session = resolveSession(sessionKey)!;
  const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
  const dispatcher = new RuntimeSessionDispatcher({
    instanceId: "dispatch-queued-correlation-test",
    maxConcurrentSessions: 4,
    interactiveReservedSessions: 0,
    safeEmit: async (topic: string, data: Record<string, unknown>) => {
      emitted.push({ topic, data });
    },
    notifyRuntimeRecoveryExhausted: async () => {},
    getConfigModel: () => "test-model",
    crashRecovery: { acceptingDeliveries: true } as unknown as RuntimeCrashRecoveryCoordinator,
  });
  const source = { channel: "slack", accountId: "local", instanceId: "local", chatId: "D123" };
  // A turn is in flight (responding, no tool): an after-response prompt queues behind it.
  const streaming: RuntimeHostStreamingSession = {
    sessionKey,
    agentId: "agent-a",
    queryHandle: { provider: "claude", events: (async function* () {})(), async interrupt() {} },
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentSource: source,
    currentModel: "test-model",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: true,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    agentMode: "active",
  };
  dispatcher.streamingSessions.set(session.name!, streaming);
  const queuedEvents = () =>
    emitted.filter((event) => event.topic === "ravi.session.main.runtime" && event.data.type === "dispatch.queued");
  return { dispatcher, session, queuedEvents };
}

describe("dispatch.queued correlation", () => {
  it("echoes the waiting producer's correlation id, and null for a prompt without one", async () => {
    const { dispatcher, session, queuedEvents } = busyFixture();

    await dispatcher.handlePromptImmediate(session.name!, {
      prompt: "oi",
      _agentId: "agent-a",
      _cliDestination: true,
      _correlationId: "vt_voice",
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
    });
    await dispatcher.handlePromptImmediate(session.name!, {
      prompt: "mensagem do slack",
      _agentId: "agent-a",
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
    });

    const events = queuedEvents();
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toMatchObject({ correlationId: "vt_voice", reason: "response" });
    expect(events[1]?.data).toMatchObject({ correlationId: null, reason: "response" });
  });
});
