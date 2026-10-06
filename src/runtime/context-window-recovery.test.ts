import { describe, expect, it } from "bun:test";
import {
  buildRuntimeContextRecoveryPrompt,
  classifyRuntimeContextWindowFailure,
  classifyRuntimeProviderSessionMissingFailure,
  classifyRuntimeSessionRecoveryFailure,
} from "./context-window-recovery.js";
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

  it("detects a missing Claude conversation from the provider error", () => {
    const failure = classifyRuntimeSessionRecoveryFailure({
      runtimeProvider: "claude",
      error: "No conversation found with session ID: b8714bf7-9907-4306-9f7c-1af04d0cd0b4",
    });

    expect(failure).toEqual({
      kind: "provider_session_missing",
      confidence: "high",
      matched: "conversation_not_found",
    });
  });

  it("detects a missing conversation reported only in the raw provider event", () => {
    expect(
      classifyRuntimeProviderSessionMissingFailure({
        runtimeProvider: "claude",
        error: "Claude turn failed",
        rawEvent: {
          type: "result",
          subtype: "error_during_execution",
          errors: ["No conversation found with session ID: x"],
        },
      }),
    ).toMatchObject({ kind: "provider_session_missing" });
  });

  it("does not classify unrelated failures as a missing conversation", () => {
    expect(
      classifyRuntimeProviderSessionMissingFailure({ runtimeProvider: "claude", error: "rate limited" }),
    ).toBeNull();
    expect(
      classifyRuntimeSessionRecoveryFailure({ runtimeProvider: "claude", error: "Prompt is too long" }),
    ).toMatchObject({ kind: "context_window_exhausted" });
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

  it("does not feed empty-join mashed assistant history as one blob", () => {
    const prompt = buildRuntimeContextRecoveryPrompt({
      sessionName: "main",
      history: [message(1, "user", "continua"), message(2, "assistant", "primeiro?Olá")],
    });

    expect(prompt.prompt).toContain("primeiro?");
    expect(prompt.prompt).toContain("Olá");
    expect(prompt.prompt).not.toContain("primeiro?Olá");
    expect(prompt.prompt.match(/Assistant /g)?.length).toBeGreaterThan(1);
  });

  it("explains a missing provider conversation without leaking the failed session id", () => {
    const prompt = buildRuntimeContextRecoveryPrompt({
      sessionName: "main",
      runtimeProvider: "claude",
      model: "claude-sonnet",
      recoveryKind: "provider_session_missing",
      error: "No conversation found with session ID: missing-session-id",
      history: [message(1, "user", "continua de onde parou")],
    });

    expect(prompt.prompt).toContain("could not find the previous conversation");
    expect(prompt.prompt).toContain("continua de onde parou");
    expect(prompt.prompt).not.toContain("exhausted its context window");
    expect(prompt.prompt).not.toContain("missing-session-id");
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
