import { describe, expect, it } from "bun:test";
import {
  buildEvalTranscriptRun,
  extractNormalizedTranscriptMessages,
  findEvalPromptIndex,
  type EvalSnapshotTranscriptMessage,
} from "./snapshot.js";

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

describe("eval transcript run scope", () => {
  const prompt = "Reply with exactly EVAL_OK";
  const hinted = `[session surface] This turn came from the CLI. A normal reply returns to the waiting CLI.\n${prompt}`;
  const messages: EvalSnapshotTranscriptMessage[] = [
    { role: "user", text: hinted, time: "t1" },
    { role: "assistant", text: "EVAL_OK", time: "t2" },
    { role: "user", text: "Write a long essay", time: "t3" },
    { role: "assistant", text: "Essay ... LATE", time: "t4" },
    { role: "user", text: hinted, time: "t5" },
    { role: "assistant", text: "EVAL_OK again", time: "t6" },
  ];

  it("finds the prompt only at or after the before snapshot", () => {
    expect(findEvalPromptIndex(messages, prompt, 0)).toBe(4);
    expect(findEvalPromptIndex(messages, prompt, 2)).toBe(4);
    expect(findEvalPromptIndex(messages.slice(0, 4), prompt, 2)).toBe(-1);
  });

  it("keeps only what followed this run's prompt", () => {
    // An earlier run of the same prompt and a turn still in flight when the
    // eval started both sit before the prompt and must not count.
    const run = buildEvalTranscriptRun(messages, { prompt, sinceMessageCount: 2 });
    expect(run.promptIndex).toBe(4);
    expect(run.messageCount).toBe(1);
    expect(run.combinedText).toBe("EVAL_OK again");
    expect(run.assistantText).toBe("EVAL_OK again");
  });

  it("is empty when the prompt never reached the transcript", () => {
    const run = buildEvalTranscriptRun(messages.slice(0, 4), { prompt, sinceMessageCount: 4 });
    expect(run).toEqual({ promptIndex: -1, messageCount: 0, combinedText: "", assistantText: "" });
  });
});
