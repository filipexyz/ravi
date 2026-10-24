import { describe, expect, it, mock } from "bun:test";
import { RUNTIME_CONTROL_PROVIDER_TIMEOUT_MS, handleRuntimeControlRequest } from "./control-host.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeControlRequest, RuntimeControlResult } from "./types.js";
import {
  RUNTIME_CONTROL_DISABLED,
  RUNTIME_CONTROL_DISABLED_REASON,
  RUNTIME_CONTROL_FAILED,
  RUNTIME_CONTROL_TIMEOUT,
  RUNTIME_NO_ACTIVE_TURN,
  RUNTIME_OPERATION_UNSUPPORTED,
  RUNTIME_SESSION_NOT_ACTIVE,
} from "./runtime-control-errors.js";

async function* emptyEvents(): AsyncGenerator<never> {}

function createStreamingSession(
  control: (request: RuntimeControlRequest) => Promise<RuntimeControlResult>,
): RuntimeHostStreamingSession {
  return {
    agentId: "agent-a",
    queryHandle: {
      provider: "pi",
      events: emptyEvents(),
      interrupt: async () => {},
      control,
    },
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentModel: "test-model",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: true,
    onTurnComplete: null,
    compacting: false,
    currentToolSafety: null,
    pendingAbort: false,
  };
}

describe("runtime control host durable input gate", () => {
  for (const operation of ["turn.steer", "turn.follow_up"] as const) {
    it(`rejects ${operation} without calling the provider`, async () => {
      const providerControl = mock(
        async (request: RuntimeControlRequest): Promise<RuntimeControlResult> => ({
          ok: true,
          operation: request.operation,
        }),
      );
      const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
      const session = createStreamingSession(providerControl);

      await handleRuntimeControlRequest(
        {
          sessionName: "session-a",
          replyTopic: "ravi._reply.control",
          request: { operation, text: "new input" },
        },
        {
          streamingSessions: new Map([["session-a", session]]),
          safeEmit: async (topic, data) => {
            emitted.push({ topic, data });
          },
        },
      );

      const error = `Runtime control '${operation}' is disabled: durable prompt input journaling is not available yet.`;
      expect(providerControl).toHaveBeenCalledTimes(0);
      expect(emitted).toHaveLength(2);
      expect(emitted[0]).toEqual({
        topic: "ravi._reply.control",
        data: {
          result: {
            ok: false,
            operation,
            state: { provider: "pi", activeTurn: true },
            error,
            code: RUNTIME_CONTROL_DISABLED,
            retryable: false,
            disabledReason: RUNTIME_CONTROL_DISABLED_REASON,
            suggestedAction: expect.stringContaining("sessions send"),
          },
        },
      });
      expect(emitted[1]).toEqual({
        topic: "ravi.session.session-a.runtime",
        data: {
          type: "runtime.control",
          provider: "pi",
          operation,
          ok: false,
          error,
          code: RUNTIME_CONTROL_DISABLED,
          state: { provider: "pi", activeTurn: true },
          timestamp: expect.any(Number),
        },
      });
    });
  }

  it("passes turn.interrupt through to the provider", async () => {
    const providerControl = mock(
      async (request: RuntimeControlRequest): Promise<RuntimeControlResult> => ({
        ok: true,
        operation: request.operation,
        data: { interrupted: true },
        state: { provider: "pi", turnId: "turn-a", activeTurn: true },
      }),
    );
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const session = createStreamingSession(providerControl);
    const request: RuntimeControlRequest = { operation: "turn.interrupt", turnId: "turn-a" };

    await handleRuntimeControlRequest(
      {
        sessionName: "session-a",
        replyTopic: "ravi._reply.control",
        request,
      },
      {
        streamingSessions: new Map([["session-a", session]]),
        safeEmit: async (topic, data) => {
          emitted.push({ topic, data });
        },
      },
    );

    expect(providerControl).toHaveBeenCalledTimes(1);
    expect(providerControl).toHaveBeenCalledWith(request);
    expect(emitted[0]).toEqual({
      topic: "ravi._reply.control",
      data: {
        result: {
          ok: true,
          operation: "turn.interrupt",
          data: { interrupted: true },
          state: { provider: "pi", turnId: "turn-a", activeTurn: true },
        },
      },
    });
    expect(emitted[1]).toEqual({
      topic: "ravi.session.session-a.runtime",
      data: {
        type: "runtime.control",
        provider: "pi",
        operation: "turn.interrupt",
        ok: true,
        error: undefined,
        state: { provider: "pi", turnId: "turn-a", activeTurn: true },
        timestamp: expect.any(Number),
      },
    });
  });
});

async function runControl(
  sessions: Map<string, RuntimeHostStreamingSession>,
  request: RuntimeControlRequest,
  sessionName = "session-a",
): Promise<RuntimeControlResult | undefined> {
  const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
  await handleRuntimeControlRequest(
    { sessionName, replyTopic: "ravi._reply.control", request },
    {
      streamingSessions: sessions,
      safeEmit: async (topic, data) => {
        emitted.push({ topic, data });
      },
    },
  );
  return emitted.find((entry) => entry.topic === "ravi._reply.control")?.data.result as
    | RuntimeControlResult
    | undefined;
}

describe("runtime control host typed refusals", () => {
  it("answers a session without a live runtime with RUNTIME_SESSION_NOT_ACTIVE", async () => {
    const result = await runControl(new Map(), { operation: "turn.interrupt" }, "missing-session");

    expect(result).toMatchObject({
      ok: false,
      operation: "turn.interrupt",
      code: RUNTIME_SESSION_NOT_ACTIVE,
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain("missing-session");
  });

  it("answers a provider without control with RUNTIME_OPERATION_UNSUPPORTED", async () => {
    const session = createStreamingSession(async (request) => ({ ok: true, operation: request.operation }));
    session.queryHandle.control = undefined;

    const result = await runControl(new Map([["session-a", session]]), { operation: "thread.list" });

    expect(result).toMatchObject({ ok: false, code: RUNTIME_OPERATION_UNSUPPORTED });
  });

  it("keeps a provider's own code", async () => {
    const session = createStreamingSession(async (request) => ({
      ok: false,
      operation: request.operation,
      error: "Pi runtime does not support thread.fork",
      code: RUNTIME_OPERATION_UNSUPPORTED,
    }));

    const result = await runControl(new Map([["session-a", session]]), { operation: "thread.fork" });

    expect(result).toMatchObject({ ok: false, code: RUNTIME_OPERATION_UNSUPPORTED });
  });

  it("types a turn control refused while no turn is active as RUNTIME_NO_ACTIVE_TURN", async () => {
    const session = createStreamingSession(async () => {
      throw new Error("turn.interrupt requires an active Codex turn.");
    });
    session.turnActive = false;

    const result = await runControl(new Map([["session-a", session]]), { operation: "turn.interrupt" });

    expect(result).toMatchObject({
      ok: false,
      code: RUNTIME_NO_ACTIVE_TURN,
      error: "turn.interrupt requires an active Codex turn.",
      state: { provider: "pi", activeTurn: false },
    });
  });

  it("types any other provider failure as RUNTIME_CONTROL_FAILED", async () => {
    const session = createStreamingSession(async (request) => ({
      ok: false,
      operation: request.operation,
      error: "thread not found",
    }));

    const result = await runControl(new Map([["session-a", session]]), { operation: "thread.read" });

    expect(result).toMatchObject({ ok: false, code: RUNTIME_CONTROL_FAILED, error: "thread not found" });
  });

  it("removes host-disabled operations from the reported supported operations", async () => {
    const session = createStreamingSession(async (request) => ({
      ok: true,
      operation: request.operation,
      data: {},
      state: {
        provider: "codex",
        supportedOperations: ["thread.read", "turn.steer", "turn.interrupt"],
      },
    }));

    const result = await runControl(new Map([["session-a", session]]), { operation: "thread.read" });

    expect(result?.state).toEqual({
      provider: "codex",
      supportedOperations: ["thread.read", "turn.interrupt"],
      disabledOperations: ["turn.steer"],
    });
  });

  it("answers RUNTIME_CONTROL_TIMEOUT when the provider never answers", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return originalSetTimeout(fn, 0);
    }) as typeof setTimeout;
    try {
      const session = createStreamingSession(() => new Promise<RuntimeControlResult>(() => {}));

      const result = await runControl(new Map([["session-a", session]]), { operation: "thread.list" });

      expect(delays).toContain(RUNTIME_CONTROL_PROVIDER_TIMEOUT_MS);
      expect(result).toMatchObject({ ok: false, code: RUNTIME_CONTROL_TIMEOUT, retryable: true });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
