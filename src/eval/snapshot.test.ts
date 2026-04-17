import { describe, expect, it } from "bun:test";
import { extractNormalizedTranscriptMessages } from "./snapshot.js";

describe("extractNormalizedTranscriptMessages", () => {
  it("parses codex response_item message entries", () => {
    const raw = [
      JSON.stringify({
        timestamp: "2026-04-07T17:34:30.755Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Responda exatamente com EVAL_OK" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-07T17:34:36.553Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "EVAL_OK" }],
        },
      }),
    ].join("\n");

    expect(extractNormalizedTranscriptMessages(raw)).toEqual([
      {
        role: "user",
        text: "Responda exatamente com EVAL_OK",
        time: "2026-04-07T17:34:30.755Z",
      },
      {
        role: "assistant",
        text: "EVAL_OK",
        time: "2026-04-07T17:34:36.553Z",
      },
    ]);
  });
});
