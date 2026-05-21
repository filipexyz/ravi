/**
 * Tests for resolveSessionOutputTarget — attached sessions emit to the
 * session's output attachment, or fail closed when none exists.
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

function makeChat(suffix: string) {
  return dbUpsertChat({
    channel: "whatsapp",
    instanceId: "luis",
    platformChatId: `${suffix}@s.whatsapp.net`,
    chatType: "dm",
    title: `chat-${suffix}`,
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

  it("returns the attached output target even when fallback is another chat", () => {
    const session = getOrCreateSession("agent:dev:s1", "dev", "/tmp/dev");
    const outputChat = makeChat("output");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: outputChat.id, setOutputTarget: true });
    const fallback = makeFallback("inbound@s.whatsapp.net");
    const result = resolveSessionOutputTarget({ sessionKey: session.sessionKey, fallback });
    expect(result.source).toBe("attached-output");
    expect(result.target).toMatchObject({
      channel: "whatsapp",
      accountId: "luis",
      instanceId: "luis",
      chatId: "output@s.whatsapp.net",
      canonicalChatId: outputChat.id,
    });
  });

  it("returns null when no output attachment exists, even with inbound fallback", () => {
    const session = getOrCreateSession("agent:dev:s2", "dev", "/tmp/dev");
    const fallback = makeFallback("inbound@s.whatsapp.net");
    const result = resolveSessionOutputTarget({ sessionKey: session.sessionKey, fallback });
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
