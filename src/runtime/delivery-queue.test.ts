import { describe, expect, it } from "bun:test";
import { createQueuedRuntimeUserMessage, createRuntimeMessageGenerator } from "./delivery-queue.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeSessionHandle } from "./types.js";

function makeRuntimeSession(): RuntimeSessionHandle {
  return {
    provider: "codex",
    events: (async function* () {})(),
    interrupt: async () => {},
  };
}

function makeStreamingSession(overrides: Partial<RuntimeHostStreamingSession> = {}): RuntimeHostStreamingSession {
  return {
    agentId: "main",
    queryHandle: makeRuntimeSession(),
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentModel: "gpt-5.4",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: false,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    ...overrides,
  };
}

describe("runtime delivery queue", () => {
  it("refreshes lastActivity when a new turn starts on a reused session", async () => {
    const staleActivityAt = Date.now() - 15 * 60 * 1000;
    const queuedMessage = createQueuedRuntimeUserMessage({ prompt: "continua" });
    const session = makeStreamingSession({
      pendingMessages: [queuedMessage],
      lastActivity: staleActivityAt,
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    const result = await generator.next();

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: "user",
      message: { role: "user", content: "continua" },
    });
    expect(session.turnActive).toBe(true);
    expect(session.lastActivity).toBeGreaterThan(staleActivityAt);

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });
});
