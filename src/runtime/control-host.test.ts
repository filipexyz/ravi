import { describe, expect, it, mock } from "bun:test";
import { handleRuntimeControlRequest } from "./control-host.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeControlRequest, RuntimeControlResult } from "./types.js";

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
