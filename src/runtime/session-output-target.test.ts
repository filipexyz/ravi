/**
 * Tests for resolveSessionOutputTarget — attached sessions emit to the
 * source chat for inbound turns, otherwise to the default output
 * attachment for source-less turns, or fail closed when none exists.
 *
 * See .ravi/specs/sessions/attach/SPEC.md
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { attachChatToSession, detachChatFromSession, getOrCreateSession } from "../router/sessions.js";
import { dbUpsertChat } from "../router/router-db.js";
import { resolveSessionOutputTarget } from "./session-output-target.js";
import type { MessageTarget } from "./message-types.js";

let stateDir: string | null = null;

function makeFallback(chatId: string): MessageTarget {
  return {
    channel: "whatsapp",
    accountId: "luis",
    instanceId: "luis",
    chatId,
    canonicalChatId: chatId,
    actorType: "contact",
  };
}

function makeFallbackForChat(chat: ReturnType<typeof makeChat>): MessageTarget {
  return {
    channel: chat.channel,
    accountId: chat.instanceId ?? "luis",
    instanceId: chat.instanceId ?? undefined,
    chatId: chat.platformChatId,
    canonicalChatId: chat.id,
    actorType: "contact",
  };
}

function makeChat(suffix: string) {
  return dbUpsertChat({
    channel: "whatsapp",
    instanceId: "luis",
    platformChatId: `${suffix}@s.whatsapp.net`,
    chatType: "dm",
    title: `chat-${suffix}`,
  });
}

function makeSlackThreadChat() {
  return dbUpsertChat({
    channel: "slack",
    instanceId: "ravi-rbbt-slack",
    platformChatId: "D0BAFQ90A78#1781574894.010449",
    chatType: "thread",
    title: "luis",
  });
}

describe("resolveSessionOutputTarget", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-output-target-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("fails closed instead of leaking an unattached inbound turn to the default", () => {
    const session = getOrCreateSession("agent:dev:s1", "dev", "/tmp/dev");
    const outputChat = makeChat("output");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: outputChat.id, setOutputTarget: true });
    const fallback = makeFallback("inbound@s.whatsapp.net");
    const result = resolveSessionOutputTarget({ sessionKey: session.sessionKey, fallback });
    expect(result.source).toBe("unresolved");
    expect(result.target).toBeNull();
  });

  it("returns the attached source chat", () => {
    const session = getOrCreateSession("agent:dev:s-source-speak", "dev", "/tmp/dev");
    const outputChat = makeChat("source-default-output");
    const sourceChat = makeChat("source-speak");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: outputChat.id, setOutputTarget: true });
    attachChatToSession({
      sessionKey: session.sessionKey,
      chatId: sourceChat.id,
      setOutputTarget: false,
    });

    const result = resolveSessionOutputTarget({
      sessionKey: session.sessionKey,
      fallback: makeFallbackForChat(sourceChat),
    });

    expect(result.source).toBe("source-chat");
    expect(result.target).toMatchObject({
      chatId: "source-speak@s.whatsapp.net",
      canonicalChatId: sourceChat.id,
    });
  });

  it("splits Slack thread chats into channel and thread targets", () => {
    const session = getOrCreateSession("agent:dev:s-slack-thread-output", "dev", "/tmp/dev");
    const outputChat = makeSlackThreadChat();
    attachChatToSession({ sessionKey: session.sessionKey, chatId: outputChat.id, setOutputTarget: true });

    const result = resolveSessionOutputTarget({
      sessionKey: session.sessionKey,
      fallback: undefined,
    });

    expect(result.source).toBe("attached-output");
    expect(result.target).toMatchObject({
      channel: "slack",
      accountId: "ravi-rbbt-slack",
      instanceId: "ravi-rbbt-slack",
      chatId: "D0BAFQ90A78",
      threadId: "1781574894.010449",
      canonicalChatId: outputChat.id,
    });
  });

  it("returns the default output for a source-less turn", () => {
    const session = getOrCreateSession("agent:dev:s-default", "dev", "/tmp/dev");
    const outputChat = makeChat("default-output");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: outputChat.id, setOutputTarget: true });

    const result = resolveSessionOutputTarget({
      sessionKey: session.sessionKey,
      fallback: undefined,
    });

    expect(result.source).toBe("attached-output");
    expect(result.target).toMatchObject({
      chatId: "default-output@s.whatsapp.net",
      canonicalChatId: outputChat.id,
    });
  });

  it("fails closed when an inbound source is not attached", () => {
    const session = getOrCreateSession("agent:dev:s-unattached", "dev", "/tmp/dev");
    const sourceChat = makeChat("unattached-source");
    attachChatToSession({
      sessionKey: session.sessionKey,
      chatId: makeChat("unattached-default").id,
      setOutputTarget: true,
    });

    const result = resolveSessionOutputTarget({
      sessionKey: session.sessionKey,
      fallback: makeFallbackForChat(sourceChat),
    });

    expect(result.source).toBe("unresolved");
    expect(result.target).toBeNull();
  });

  it("returns null when no output attachment exists", () => {
    const session = getOrCreateSession("agent:dev:s2", "dev", "/tmp/dev");
    const result = resolveSessionOutputTarget({ sessionKey: session.sessionKey, fallback: undefined });
    expect(result.source).toBe("unresolved");
    expect(result.target).toBeNull();
  });

  it("returns null after detaching the only primary output attachment", () => {
    const session = getOrCreateSession("agent:dev:s3", "dev", "/tmp/dev");
    const outputChat = makeChat("primary-output");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: outputChat.id, role: "primary" });
    detachChatFromSession(session.sessionKey, outputChat.id);
    const result = resolveSessionOutputTarget({ sessionKey: session.sessionKey, fallback: undefined });
    expect(result.source).toBe("unresolved");
    expect(result.target).toBeNull();
  });
});
