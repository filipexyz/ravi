import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
  buildKimiCodeLiveRequestEnv,
  reduceKimiCodeLiveEvidence,
  runKimiCodeLiveGate,
  withIsolatedKimiCodeLiveState,
} from "./kimi-code-live-harness.js";
import type { RuntimeEvent } from "./types.js";

describe("Kimi Code private-live harness", () => {
  it("passes only the credential, provider opt-in, and isolated state directory to the runtime", () => {
    expect(
      buildKimiCodeLiveRequestEnv(
        {
          KIMI_API_KEY: "fresh-live-value",
          RAVI_KIMI_CODE_ENABLED: "1",
          RAVI_LIVE_TESTS: "1",
          UNRELATED_VALUE: "must-not-cross-the-boundary",
        },
        "C:/synthetic-state",
      ),
    ).toEqual({
      KIMI_API_KEY: "fresh-live-value",
      RAVI_KIMI_CODE_ENABLED: "1",
      RAVI_STATE_DIR: "C:/synthetic-state",
    });
  });

  it("skips before invoking a network-capable callback when opt-in is incomplete", async () => {
    let invocations = 0;
    const incompleteEnvironments = [
      {},
      { RAVI_LIVE_TESTS: "1" },
      { RAVI_LIVE_TESTS: "1", RAVI_KIMI_CODE_ENABLED: "1" },
    ];
    for (const env of incompleteEnvironments) {
      const result = await runKimiCodeLiveGate(env, async () => {
        invocations += 1;
        return { terminalCount: 1 };
      });
      expect(result).toEqual({ status: "skipped" });
    }
    expect(invocations).toBe(0);
  });

  it("removes the isolated state root even when a live gate fails", async () => {
    let root = "";
    await expect(
      withIsolatedKimiCodeLiveState(async (state) => {
        root = state.root;
        expect(existsSync(state.cwd)).toBe(true);
        throw new Error("synthetic gate failure");
      }),
    ).rejects.toThrow("synthetic gate failure");

    expect(root).not.toBe("");
    expect(existsSync(root)).toBe(false);
  });

  it("reduces raw events to counts, booleans, and an allowlisted host classification", async () => {
    const events: RuntimeEvent[] = [
      { type: "thread.started", thread: { id: "private-thread" } },
      { type: "turn.started", turn: { id: "private-turn" } },
      { type: "status", status: "thinking", rawEvent: { reasoning: "private chain" } },
      { type: "text.delta", text: "private response" },
      { type: "tool.started", toolUse: { id: "private-call", name: "synthetic_probe" } },
      { type: "tool.completed", toolUseId: "private-call", toolName: "synthetic_probe", content: "private result" },
      { type: "tool.result_delivered", toolCallId: "private-call" },
      {
        type: "turn.complete",
        providerSessionId: "private-session",
        usage: { inputTokens: 2, outputTokens: 3 },
      },
      {
        type: "turn.failed",
        error: "receiving too many requests with private detail",
        rawEvent: { status: 429, code: "rate_limited", requestId: "private-request" },
      },
      { type: "turn.interrupted", rawEvent: { path: "C:/private/path" } },
    ];

    const evidence = await reduceKimiCodeLiveEvidence(
      (async function* () {
        yield* events;
      })(),
    );

    expect(evidence).toEqual({
      eventCount: 10,
      threadStartedCount: 1,
      turnStartedCount: 1,
      textDeltaCount: 1,
      reasoningObserved: true,
      toolStartedCount: 1,
      toolCompletedCount: 1,
      toolResultDeliveredCount: 1,
      toolCompletionAfterStart: true,
      toolResultAfterStart: true,
      turnCompleteCount: 1,
      turnFailedCount: 1,
      turnInterruptedCount: 1,
      usageObserved: true,
      failureClassifications: ["rate_limited"],
    });
    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      "private-thread",
      "private-turn",
      "private chain",
      "private response",
      "private-call",
      "private result",
      "private-session",
      "private detail",
      "private-request",
      "C:/private/path",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
