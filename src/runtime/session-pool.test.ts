import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import {
  DEFAULT_RUNTIME_INTERACTIVE_RESERVED_SLOTS,
  DEFAULT_RUNTIME_SESSION_POOL_MAX,
  buildRuntimeSessionPoolSnapshot,
  classifyRuntimeSessionStartLane,
  resolveRuntimeInteractiveReservedSlots,
  resolveRuntimeSessionPoolMax,
  resolveRuntimeStreamingSession,
} from "./session-pool.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-runtime-session-pool-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function createStreamingSession(agentId: string, overrides: Partial<RuntimeHostStreamingSession> = {}) {
  return {
    agentId,
    queryHandle: { provider: "codex", events: (async function* () {})(), interrupt: async () => {} },
    abortController: new AbortController(),
    pendingMessages: [],
    currentModel: "test-model",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    starting: false,
    compacting: false,
    interrupted: false,
    turnActive: false,
    pushMessage: null,
    pendingWake: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    ...overrides,
  } as RuntimeHostStreamingSession;
}

describe("runtime session pool", () => {
  it("resolves the pool limit from env-compatible values", () => {
    expect(resolveRuntimeSessionPoolMax("72")).toBe(72);
    expect(resolveRuntimeSessionPoolMax("0")).toBe(DEFAULT_RUNTIME_SESSION_POOL_MAX);
    expect(resolveRuntimeSessionPoolMax("nope")).toBe(DEFAULT_RUNTIME_SESSION_POOL_MAX);
  });

  it("resolves interactive reserved slots within the pool limit", () => {
    expect(resolveRuntimeInteractiveReservedSlots(undefined, 60)).toBe(DEFAULT_RUNTIME_INTERACTIVE_RESERVED_SLOTS);
    expect(resolveRuntimeInteractiveReservedSlots("2", 60)).toBe(2);
    expect(resolveRuntimeInteractiveReservedSlots("999", 5)).toBe(4);
    expect(resolveRuntimeInteractiveReservedSlots("0", 5)).toBe(0);
    expect(resolveRuntimeInteractiveReservedSlots("-1", 5)).toBe(4);
    expect(resolveRuntimeInteractiveReservedSlots(undefined, 1)).toBe(0);
  });

  it("classifies runtime starts into interactive and background lanes", () => {
    expect(classifyRuntimeSessionStartLane("main:group:123", { prompt: "hello" })).toBe("interactive");
    expect(classifyRuntimeSessionStartLane("task-123-work", { prompt: "work" })).toBe("background");
    expect(
      classifyRuntimeSessionStartLane("main", {
        prompt: "observe",
        _observation: {
          sourceSessionKey: "agent:main:main",
          sourceSessionName: "main",
          bindingId: "binding-1",
          ruleId: "rule-1",
          role: "observer",
          mode: "observe",
          eventIds: [],
        },
      }),
    ).toBe("background");
    expect(classifyRuntimeSessionStartLane("main", { prompt: "task", taskBarrierTaskId: "task-1" })).toBe("background");
    expect(
      classifyRuntimeSessionStartLane("main", {
        prompt: "system",
        source: { channel: "cli", accountId: "local", chatId: "system", actorType: "system" },
      }),
    ).toBe("background");
  });

  it("resolves a live runtime session by session key even when the map is keyed by name", () => {
    getOrCreateSession("agent:dev:test:session-pool", "dev", stateDir ?? "/tmp", {
      name: "session-pool-work",
    });
    const streamingSessions = new Map<string, RuntimeHostStreamingSession>([
      ["session-pool-work", createStreamingSession("dev")],
    ]);

    const resolved = resolveRuntimeStreamingSession(streamingSessions, {
      sessionKey: "agent:dev:test:session-pool",
    });

    expect(resolved?.name).toBe("session-pool-work");
    expect(resolved?.session.agentId).toBe("dev");
  });

  it("builds an operational gauge grouped by agent and runtime session class", () => {
    const streamingSessions = new Map<string, RuntimeHostStreamingSession>([
      ["task-123-work", createStreamingSession("knowledge-engineer-sonnet", { currentTaskBarrierTaskId: "task-123" })],
      ["main:group:123", createStreamingSession("main")],
    ]);

    const snapshot = buildRuntimeSessionPoolSnapshot(streamingSessions, {
      limit: 2,
      pendingStarts: 3,
    });

    expect(snapshot).toMatchObject({
      type: "runtime.session_pool.gauge",
      active: 2,
      limit: 2,
      pendingStarts: 3,
      interactiveReserved: 0,
      backgroundLimit: 2,
      saturated: true,
      byAgent: {
        "knowledge-engineer-sonnet": 1,
        main: 1,
      },
      byClass: {
        task: 1,
        group: 1,
        dm: 0,
        other: 0,
      },
    });
  });
});
