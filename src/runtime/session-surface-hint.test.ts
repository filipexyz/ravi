import { describe, expect, it } from "bun:test";
import { buildSessionRelayTurnOrigin } from "./turn-origin.js";
import {
  buildSessionSurfaceHint,
  CLI_SURFACE_HINT,
  combineSessionSurfacePromptContents,
  persistSessionSurfaceHintOnUserRow,
  resolvePersistedUserText,
  resolveRuntimePromptText,
  SOURCELESS_SURFACE_HINT,
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

  it("keeps source-less and CLI hint builders for the model-facing header", () => {
    expect(buildSessionSurfaceHint(undefined)).toBe(SOURCELESS_SURFACE_HINT);
    expect(buildSessionSurfaceHint(undefined, { cliDestination: true })).toBe(CLI_SURFACE_HINT);
  });

  it("keeps operator CLI-only user rows raw and puts the CLI header on the runtime prompt", () => {
    const cliOnly = withSessionSurfaceHint({
      prompt: "responde só: pong",
      _cliDestination: true,
    });
    expect(resolvePersistedUserText(cliOnly)).toBe("responde só: pong");
    expect(cliOnly.prompt).not.toContain("[session surface]");
    expect(cliOnly._sessionSurfaceHintText).toBe(CLI_SURFACE_HINT);
    expect(resolveRuntimePromptText(cliOnly)).toBe(`${CLI_SURFACE_HINT}\nresponde só: pong`);
    expect(persistSessionSurfaceHintOnUserRow({ prompt: "responde só: pong", _cliDestination: true })).toBe(false);
  });

  it("keeps HTTP session-relay user rows raw and still sends a sourceless header to the model", () => {
    const httpOperator = withSessionSurfaceHint({
      prompt: "hello from gateway",
      _turnOrigin: buildSessionRelayTurnOrigin("send"),
    });
    expect(resolvePersistedUserText(httpOperator)).toBe("hello from gateway");
    expect(httpOperator.prompt).not.toContain("waiting CLI");
    expect(httpOperator.prompt).not.toContain("no inbound chat");
    expect(httpOperator._sessionSurfaceHintText).toBe(SOURCELESS_SURFACE_HINT);
    expect(resolveRuntimePromptText(httpOperator)).toBe(`${SOURCELESS_SURFACE_HINT}\nhello from gateway`);
    expect(
      persistSessionSurfaceHintOnUserRow({
        prompt: "hello from gateway",
        _turnOrigin: buildSessionRelayTurnOrigin("send"),
      }),
    ).toBe(false);
  });

  it("does not treat leftover lastChannel source on sessions.send as inbound chat", () => {
    const decorated = withSessionSurfaceHint({
      prompt: "operator text",
      source: { channel: "slack", accountId: "main", chatId: "C123" },
      _turnOrigin: buildSessionRelayTurnOrigin("send"),
    });
    expect(resolvePersistedUserText(decorated)).toBe("operator text");
    expect(decorated.prompt).not.toContain("[session surface]");
    expect(decorated._sessionSurfaceHintText).toBe(SOURCELESS_SURFACE_HINT);
    expect(resolveRuntimePromptText(decorated)).toBe(`${SOURCELESS_SURFACE_HINT}\noperator text`);
    expect(resolveRuntimePromptText(decorated)).not.toContain("Slack chat");
  });

  it("prefixes inbound WhatsApp and Slack turns and stays idempotent", () => {
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
    expect(resolveRuntimePromptText(decorated)).toBe(decorated.prompt);
    expect(decorated._runtimePrompt).toBeUndefined();
    expect(withSessionSurfaceHint(decorated)).toBe(decorated);
    expect(
      persistSessionSurfaceHintOnUserRow({
        prompt: "hello",
        source: { channel: "slack", accountId: "workspace", chatId: "C123" },
      }),
    ).toBe(true);
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
