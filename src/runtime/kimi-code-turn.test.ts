import { describe, expect, it, test } from "bun:test";
import {
  addKimiCodeUsage,
  createKimiCodeCompletedTurnAccumulator,
  createKimiCodeToolResultViews,
  KIMI_CODE_MAX_TOOL_CALLS,
  validateKimiCodeToolCalls,
} from "./kimi-code-turn.js";

describe("Kimi Code turn boundary", () => {
  it("retains stop and tool_calls finish reasons in the completed turn", () => {
    const stop = createKimiCodeCompletedTurnAccumulator();
    expect(stop.accept({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })).toEqual({
      kind: "accepted",
      textDeltas: ["done"],
      reasoningDelta: false,
      finished: true,
    });
    expect(stop.complete().finishReason).toBe("stop");

    const toolCalls = createKimiCodeCompletedTurnAccumulator();
    expect(
      toolCalls.accept({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ).toMatchObject({ kind: "accepted", finished: true });
    expect(toolCalls.complete().finishReason).toBe("tool_calls");
  });

  it("rejects length and content_filter before any tool can be dispatched", () => {
    for (const finishReason of ["length", "content_filter"] as const) {
      const accumulator = createKimiCodeCompletedTurnAccumulator();
      expect(
        accumulator.accept({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{}" } }] },
              finish_reason: finishReason,
            },
          ],
        }),
      ).toEqual({ kind: "malformed", code: `terminal_${finishReason}` });
      expect(() => accumulator.complete()).toThrow("missing_finish_reason");
    }
  });

  it("rejects tool_calls finish reason without a complete tool call", () => {
    const accumulator = createKimiCodeCompletedTurnAccumulator();

    expect(
      accumulator.accept({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ).toEqual({ kind: "malformed", code: "incomplete_tool_call" });
    expect(() => accumulator.complete()).toThrow("missing_finish_reason");
  });

  it("rejects a complete tool call unless finish reason is tool_calls", () => {
    const accumulator = createKimiCodeCompletedTurnAccumulator();

    expect(
      accumulator.accept({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{}" } }] },
            finish_reason: "stop",
          },
        ],
      }),
    ).toEqual({ kind: "malformed", code: "inconsistent_finish_reason" });
    expect(() => accumulator.complete()).toThrow("missing_finish_reason");
  });

  it("rejects a negative or unsafe tool fragment index", () => {
    for (const index of [-1, 0.5, KIMI_CODE_MAX_TOOL_CALLS, Number.MAX_SAFE_INTEGER + 1]) {
      const accumulator = createKimiCodeCompletedTurnAccumulator();
      expect(
        accumulator.accept({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index, id: "call-1", function: { name: "lookup", arguments: "{}" } }] },
            },
          ],
        }),
      ).toEqual({ kind: "malformed", code: "invalid_tool_index" });
    }
  });

  it("rejects id or function-name mutation for an existing tool index", () => {
    const accumulator = createKimiCodeCompletedTurnAccumulator();
    expect(
      accumulator.accept({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{" } }] },
          },
        ],
      }),
    ).toMatchObject({ kind: "accepted" });

    expect(
      accumulator.accept({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call-2", function: { name: "replace", arguments: "}" } }] },
          },
        ],
      }),
    ).toEqual({ kind: "malformed", code: "tool_identity_mutation" });
    const nameOnly = createKimiCodeCompletedTurnAccumulator();
    expect(
      nameOnly.accept({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{" } }] },
          },
        ],
      }),
    ).toMatchObject({ kind: "accepted" });
    expect(
      nameOnly.accept({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "replace", arguments: "}" } }] },
          },
        ],
      }),
    ).toEqual({ kind: "malformed", code: "tool_identity_mutation" });
    expect(
      accumulator.accept({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ).toMatchObject({ kind: "accepted", finished: true });
    expect(accumulator.complete().toolCalls).toEqual([{ index: 0, id: "call-1", name: "lookup", arguments: "{}" }]);
  });

  it("rejects an event with no recognized native field", () => {
    const accumulator = createKimiCodeCompletedTurnAccumulator();

    expect(accumulator.accept({ synthetic: "ignored" })).toEqual({ kind: "malformed", code: "unrecognized_event" });
  });

  it("accepts additive unknown fields when a recognized field is valid", () => {
    const accumulator = createKimiCodeCompletedTurnAccumulator();

    expect(
      accumulator.accept({
        synthetic: "ignored",
        choices: [{ index: 0, delta: { content: "ok", synthetic_delta: true }, synthetic_choice: true }],
      }),
    ).toEqual({ kind: "accepted", textDeltas: ["ok"], reasoningDelta: false, finished: false });
  });

  it("rejects non-safe usage values and checked-addition overflow", () => {
    const accumulator = createKimiCodeCompletedTurnAccumulator();
    expect(accumulator.accept({ usage: { prompt_tokens: Number.MAX_SAFE_INTEGER + 1 } })).toEqual({
      kind: "malformed",
      code: "invalid_usage",
    });
    expect(() =>
      addKimiCodeUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }, { inputTokens: 1, outputTokens: 0 }),
    ).toThrow("invalid_usage");
  });

  it("projects structured provider errors without retaining message or body", () => {
    const sentinel = "PRIVATE_NATIVE_ERROR_SENTINEL";
    const accumulator = createKimiCodeCompletedTurnAccumulator();

    const result = accumulator.accept({
      error: {
        status: 429,
        code: "rate_limited",
        type: "rate_limit_error",
        request_id: "req-native-1",
        message: sentinel,
        body: sentinel,
        unknown: sentinel,
      },
      unknown: sentinel,
    });

    expect(result).toEqual({
      kind: "provider_error",
      nativeError: { status: 429, code: "rate_limited", type: "rate_limit_error", requestId: "req-native-1" },
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test("keeps host, native, and public tool-call values structurally separate", () => {
    const rawArguments = '{"apiKey":"sk-test_argument_secret_123456","orderId":42}';
    const calls = validateKimiCodeToolCalls(
      [{ index: 0, id: "call-secret", name: "lookup_order", arguments: rawArguments }],
      new Set(),
    );

    expect(calls).toEqual([
      {
        id: "call-secret",
        name: "lookup_order",
        arguments: { apiKey: "sk-test_argument_secret_123456", orderId: 42 },
        publicArguments: { apiKey: "[REDACTED]", orderId: 42 },
        rawArguments,
      },
    ]);
  });

  test("keeps provider and public tool-result text structurally separate", () => {
    expect(
      createKimiCodeToolResultViews({
        success: true,
        contentItems: [{ type: "inputText", text: "sk-test_result_secret_123456" }],
      }),
    ).toEqual({
      providerContent: "sk-test_result_secret_123456",
      publicContent: "[REDACTED:token]",
    });
  });

  test("retains the completed-turn accumulator boundary after extraction", () => {
    const accumulator = createKimiCodeCompletedTurnAccumulator();
    accumulator.accept({
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: "private",
            tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup_order", arguments: "{" } }],
          },
        },
      ],
    });
    accumulator.accept({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" },
      ],
    });

    expect(accumulator.complete()).toEqual({
      finishReason: "tool_calls",
      text: "",
      reasoning: "private",
      toolCalls: [{ index: 0, id: "call-1", name: "lookup_order", arguments: "{}" }],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  test("fails closed before accumulated response text exceeds its bound", () => {
    const accumulator = createKimiCodeCompletedTurnAccumulator();

    expect(
      accumulator.accept({
        choices: [{ index: 0, delta: { content: "x".repeat(2 * 1024 * 1024 + 1) } }],
      }),
    ).toEqual({ kind: "response_limit" });
    expect(() => accumulator.complete()).toThrow("missing_finish_reason");
  });

  test("fails closed before fragmented tool arguments exceed their bound", () => {
    const accumulator = createKimiCodeCompletedTurnAccumulator();

    expect(
      accumulator.accept({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-bounded",
                  function: { name: "bounded_tool", arguments: "x".repeat(1024 * 1024 + 1) },
                },
              ],
            },
          },
        ],
      }),
    ).toEqual({ kind: "tool_argument_limit" });
    expect(() => accumulator.complete()).toThrow("missing_finish_reason");
  });
});
