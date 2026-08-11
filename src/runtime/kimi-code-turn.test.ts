import { describe, expect, test } from "bun:test";
import {
  createKimiCodeCompletedTurnAccumulator,
  createKimiCodeToolResultViews,
  validateKimiCodeToolCalls,
} from "./kimi-code-turn.js";

describe("Kimi Code turn boundary", () => {
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
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }],
    });

    expect(accumulator.complete()).toEqual({
      text: "",
      reasoning: "private",
      toolCalls: [{ index: 0, id: "call-1", name: "lookup_order", arguments: "{}" }],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});
