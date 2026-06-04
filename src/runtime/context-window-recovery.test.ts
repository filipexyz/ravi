import { describe, expect, it } from "bun:test";
import { buildRuntimeContextRecoveryPrompt, classifyRuntimeContextWindowFailure } from "./context-window-recovery.js";
import type { Message } from "../db.js";

describe("runtime context window recovery", () => {
  it("detects Codex context window exhaustion from the provider error", () => {
    const failure = classifyRuntimeContextWindowFailure({
      runtimeProvider: "codex",
      error:
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      rawEvent: { type: "turn.failed" },
    });

    expect(failure).toEqual({
      kind: "context_window_exhausted",
      confidence: "high",
      matched: "codex_context_window",
    });
  });

  it("builds a compact non-json prompt from local history", () => {
    const prompt = buildRuntimeContextRecoveryPrompt({
      sessionName: "main",
      runtimeProvider: "codex",
      model: "gpt-5.5",
      history: [
        message(1, "user", "[session surfaces] internal\n[WhatsApp x mid:3ABC] Luis: investiga <chat> chat_abc123"),
        message(2, "assistant", "Vou olhar."),
        message(3, "user", "continua de onde parou"),
      ],
      maxPromptChars: 3_000,
    });

    expect(prompt.prompt).toContain("# Runtime Context Recovery");
    expect(prompt.prompt).toContain("Latest User Request");
    expect(prompt.prompt).toContain("continua de onde parou");
    expect(prompt.prompt).toContain("Previous runtime: codex / gpt-5.5");
    expect(prompt.prompt).not.toContain("[session surfaces]");
    expect(prompt.prompt).not.toContain("chat_abc123");
    expect(prompt.prompt).not.toContain("mid:3ABC");
    expect(() => JSON.parse(prompt.prompt)).toThrow();
    expect(prompt.messageCount).toBe(3);
    expect(prompt.truncated).toBe(false);
  });

  it("bounds recovered history by prompt size", () => {
    const history = Array.from({ length: 20 }, (_, index) =>
      message(index + 1, index % 2 === 0 ? "user" : "assistant", `msg-${index} ${"x".repeat(500)}`),
    );

    const prompt = buildRuntimeContextRecoveryPrompt({
      sessionName: "main",
      history,
      maxMessages: 20,
      maxPromptChars: 2_500,
    });

    expect(prompt.prompt.length).toBeLessThanOrEqual(2_500);
    expect(prompt.truncated).toBe(true);
    expect(prompt.prompt).toContain("Older recovered messages were omitted");
  });
});

function message(id: number, role: Message["role"], content: string): Message {
  return {
    id,
    session_id: "main",
    role,
    content,
    sdk_session_id: null,
    created_at: `2026-05-31T19:${String(id).padStart(2, "0")}:00.000Z`,
  };
}
