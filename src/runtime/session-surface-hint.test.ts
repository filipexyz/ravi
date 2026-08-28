import { describe, expect, it } from "bun:test";
import {
  buildSessionSurfaceHint,
  combineSessionSurfacePromptContents,
  withSessionSurfaceHint,
} from "./session-surface-hint.js";

describe("session surface hint", () => {
  it("describes the inbound channel without exposing routing state", () => {
    expect(
      buildSessionSurfaceHint({
        channel: "slack",
        accountId: "workspace",
        chatId: "C123",
      }),
    ).toBe("[session surface] This turn came from a Slack chat. A normal reply returns there.");
  });

  it("distinguishes a thread from its parent chat", () => {
    expect(
      buildSessionSurfaceHint({
        channel: "slack",
        accountId: "workspace",
        chatId: "C123",
        threadId: "123.456",
      }),
    ).toBe("[session surface] This turn came from a Slack thread. A normal reply returns there.");
  });

  it("uses the product name for WhatsApp adapters", () => {
    expect(
      buildSessionSurfaceHint({ channel: "whatsapp-baileys", accountId: "main", chatId: "5511@s.whatsapp.net" }),
    ).toContain("WhatsApp chat");
  });

  it("describes the source-less default without embedding mutable routing state", () => {
    expect(buildSessionSurfaceHint(undefined)).toBe(
      "[session surface] This turn has no inbound chat. A normal reply uses the session default, if available.",
    );
  });

  it("describes CLI-only turns as returning to the waiting CLI", () => {
    expect(buildSessionSurfaceHint(undefined, { cliDestination: true })).toBe(
      "[session surface] This turn came from the CLI. A normal reply returns to the waiting CLI.",
    );
    expect(
      withSessionSurfaceHint({
        prompt: "responde só: pong",
        _cliDestination: true,
      }).prompt,
    ).toBe("[session surface] This turn came from the CLI. A normal reply returns to the waiting CLI.\nresponde só: pong");
  });

  it("replaces legacy headers once and stays idempotent", () => {
    const decorated = withSessionSurfaceHint({
      prompt:
        "[session surfaces] session=main source_chat=chat-1\n" +
        "[session surfaces] chat-1 role=input speech=muted\n" +
        "hello",
      source: { channel: "whatsapp", accountId: "main", chatId: "5511" },
    });

    expect(decorated.prompt).toBe(
      "[session surface] This turn came from a WhatsApp chat. A normal reply returns there.\nhello",
    );
    expect(withSessionSurfaceHint(decorated)).toBe(decorated);
  });

  it("keeps one instruction when same-surface messages share a physical turn", () => {
    expect(
      combineSessionSurfacePromptContents([
        "[session surface] This turn came from a Slack chat. A normal reply returns there.\nfirst",
        "[session surface] This turn came from a Slack chat. A normal reply returns there.\nsecond",
      ]),
    ).toBe("[session surface] This turn came from a Slack chat. A normal reply returns there.\nfirst\n\nsecond");
  });
});
