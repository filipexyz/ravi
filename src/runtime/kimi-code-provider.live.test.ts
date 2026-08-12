import { expect, it } from "bun:test";
import {
  buildKimiCodeLiveRequestEnv,
  isKimiCodeLiveOptedIn,
  reduceKimiCodeLiveEvidence,
  withIsolatedKimiCodeLiveState,
  type KimiCodeLiveEvidence,
  type KimiCodeLiveState,
} from "./kimi-code-live-harness.js";
import { createKimiCodeRuntimeProvider } from "./kimi-code-provider.js";
import type {
  RuntimeDynamicToolCallHandler,
  RuntimeDynamicToolSpec,
  RuntimeEvent,
  RuntimePromptMessage,
  RuntimeProviderStateLifecycle,
  RuntimeSessionHandle,
  RuntimeStartRequest,
} from "./types.js";

const LIVE_TIMEOUT_MS = 180_000;
const liveIt = isKimiCodeLiveOptedIn(process.env) ? it : it.skip;
let reservationSequence = 0;

function prompt(...messages: string[]): AsyncGenerator<RuntimePromptMessage> {
  return (async function* () {
    for (const content of messages) {
      yield {
        type: "user",
        message: { role: "user", content },
        session_id: "",
        parent_tool_use_id: null,
      };
    }
  })();
}

function liveLifecycle(): RuntimeProviderStateLifecycle {
  return {
    reservePreparedState() {
      reservationSequence += 1;
      return {
        reservationId: `live-reservation-${reservationSequence}`,
        ownerAttemptId: `live-attempt-${reservationSequence}`,
      };
    },
    cancelPreparedState() {
      return false;
    },
    publishPreparedState(input) {
      input.publish();
      return { reservationId: input.reservationId };
    },
  };
}

function request(
  state: KimiCodeLiveState,
  input: {
    messages: string[];
    model: "k3" | "k3-256k";
    effort?: "max";
    abortController?: AbortController;
    dynamicTools?: RuntimeDynamicToolSpec[];
    handleRuntimeToolCall?: RuntimeDynamicToolCallHandler;
  },
): RuntimeStartRequest {
  return {
    prompt: prompt(...input.messages),
    model: input.model,
    ...(input.effort ? { effort: input.effort } : {}),
    cwd: state.cwd,
    abortController: input.abortController ?? new AbortController(),
    systemPromptAppend: "This is a private structural integration gate. Follow the request exactly.",
    env: buildKimiCodeLiveRequestEnv(process.env, state.stateDir),
    settingSources: [],
    providerStateLifecycle: liveLifecycle(),
    ...(input.dynamicTools ? { dynamicTools: input.dynamicTools } : {}),
    ...(input.handleRuntimeToolCall ? { handleRuntimeToolCall: input.handleRuntimeToolCall } : {}),
  };
}

function terminalCount(evidence: KimiCodeLiveEvidence): number {
  return evidence.turnCompleteCount + evidence.turnFailedCount + evidence.turnInterruptedCount;
}

async function collectAndClose(session: RuntimeSessionHandle): Promise<KimiCodeLiveEvidence> {
  try {
    return await reduceKimiCodeLiveEvidence(session.events);
  } finally {
    await session.close?.();
  }
}

function interruptOnTurn(
  events: AsyncIterable<RuntimeEvent>,
  abortController: AbortController,
  targetTurn: number,
): AsyncIterable<RuntimeEvent> {
  return (async function* () {
    let turnsStarted = 0;
    for await (const event of events) {
      if (event.type === "turn.started") {
        turnsStarted += 1;
        if (turnsStarted === targetTurn) abortController.abort();
      }
      yield event;
    }
  })();
}

liveIt(
  "L-01 streams text with usage and exactly one terminal on k3-256k",
  async () => {
    await withIsolatedKimiCodeLiveState(async (state) => {
      const session = createKimiCodeRuntimeProvider().startSession(
        request(state, { model: "k3-256k", messages: ["Reply with one short sentence."] }),
      );
      const evidence = await collectAndClose(session);

      expect(evidence.textDeltaCount).toBeGreaterThan(0);
      expect(evidence.usageObserved).toBe(true);
      expect(evidence.turnCompleteCount).toBe(1);
      expect(terminalCount(evidence)).toBe(1);
      expect(evidence.failureClassifications).toEqual([]);
    });
  },
  LIVE_TIMEOUT_MS,
);

liveIt(
  "L-02 observes reasoning structurally for k3 at max without retaining its content",
  async () => {
    await withIsolatedKimiCodeLiveState(async (state) => {
      const session = createKimiCodeRuntimeProvider().startSession(
        request(state, {
          model: "k3",
          effort: "max",
          messages: ["Solve mentally: what is 17 multiplied by 19? Reply with only the result."],
        }),
      );
      const evidence = await collectAndClose(session);

      expect(evidence.reasoningObserved).toBe(true);
      expect(evidence.turnCompleteCount).toBe(1);
      expect(terminalCount(evidence)).toBe(1);
      expect(evidence.failureClassifications).toEqual([]);
    });
  },
  LIVE_TIMEOUT_MS,
);

liveIt(
  "L-03 executes one harmless synthetic tool exactly once and completes the continuation",
  async () => {
    await withIsolatedKimiCodeLiveState(async (state) => {
      let executions = 0;
      const session = createKimiCodeRuntimeProvider().startSession(
        request(state, {
          model: "k3",
          effort: "max",
          messages: ["Call synthetic_probe exactly once with value 7, then reply with the returned result."],
          dynamicTools: [
            {
              name: "synthetic_probe",
              description: "Returns a harmless fixed result for a private structural integration gate.",
              inputSchema: {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
          handleRuntimeToolCall: async () => {
            executions += 1;
            return { success: true, contentItems: [{ type: "inputText", text: "synthetic-result" }] };
          },
        }),
      );
      const evidence = await collectAndClose(session);

      expect(executions).toBe(1);
      expect(evidence.toolStartedCount).toBe(1);
      expect(evidence.toolCompletedCount).toBe(1);
      expect(evidence.toolResultDeliveredCount).toBe(1);
      expect(evidence.toolCompletionAfterStart).toBe(true);
      expect(evidence.toolResultAfterStart).toBe(true);
      expect(evidence.toolCompletionIdMatchesStart).toBe(true);
      expect(evidence.toolResultIdMatchesStart).toBe(true);
      expect(evidence.toolIdPreservedAcrossLifecycle).toBe(true);
      expect(evidence.turnCompleteCount).toBe(1);
      expect(terminalCount(evidence)).toBe(1);
      expect(evidence.failureClassifications).toEqual([]);
    });
  },
  LIVE_TIMEOUT_MS,
);

liveIt(
  "L-04 emits one abort terminal and classifies only naturally observed failures",
  async () => {
    await withIsolatedKimiCodeLiveState(async (state) => {
      const abortController = new AbortController();
      const session = createKimiCodeRuntimeProvider().startSession(
        request(state, {
          model: "k3-256k",
          abortController,
          messages: [
            "Reply with one word.",
            "Write several paragraphs about a harmless fictional lighthouse.",
          ],
        }),
      );
      try {
        const evidence = await reduceKimiCodeLiveEvidence(interruptOnTurn(session.events, abortController, 2));

        expect(evidence.turnInterruptedCount).toBe(1);
        expect(evidence.turnStartedCount).toBe(2);
        expect(terminalCount(evidence)).toBe(2);
        expect(evidence.turnCompleteCount + evidence.turnFailedCount).toBe(1);
        expect(
          evidence.failureClassifications.every((classification) =>
            ["rate_limited", "quota_exhausted"].includes(classification),
          ),
        ).toBe(true);
      } finally {
        await session.close?.();
      }
    });
  },
  LIVE_TIMEOUT_MS,
);
