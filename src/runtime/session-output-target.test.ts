/**
 * Tests for resolveSessionOutputTarget — the output target resolution
 * chain (explicit per-turn target > focus > inbound source > fail).
 *
 * See .ravi/specs/sessions/attach/SPEC.md
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  attachChatToSession,
  clearSessionFocus,
  detachChatFromSession,
  getOrCreateSession,
  setSessionFocus,
} from "../router/sessions.js";
import { dbUpsertChat } from "../router/router-db.js";
import { resolveSessionOutputTarget } from "./session-output-target.js";
import type { MessageTarget } from "./message-types.js";

let stateDir: string | null = null;

function makeChat(suffix: string, channel = "whatsapp") {
  return dbUpsertChat({
    channel,
    instanceId: "luis",
    platformChatId: `${suffix}@s.whatsapp.net`,
    chatType: "dm",
    title: `chat-${suffix}`,
  });
}

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

describe("resolveSessionOutputTarget", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-output-target-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("returns the fallback when no focus is set (inbound-source path)", () => {
    const session = getOrCreateSession("agent:dev:s1", "dev", "/tmp/dev");
    const fallback = makeFallback("5511999@s.whatsapp.net");
    const result = resolveSessionOutputTarget({ sessionKey: session.sessionKey, fallback });
    expect(result.source).toBe("inbound-source");
    expect(result.target).toEqual(fallback);
  });

  it("returns null (unresolved) when no focus and no fallback", () => {
    const session = getOrCreateSession("agent:dev:s2", "dev", "/tmp/dev");
    const result = resolveSessionOutputTarget({ sessionKey: session.sessionKey, fallback: undefined });
    expect(result.source).toBe("unresolved");
    expect(result.target).toBeNull();
  });

  it("returns the focus chat when focus is set and subscription is active", () => {
    const session = getOrCreateSession("agent:dev:s3", "dev", "/tmp/dev");
    const chat = makeChat("focused");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id });
    setSessionFocus({ sessionKey: session.sessionKey, chatId: chat.id });
    const fallback = makeFallback("inbound-source@s.whatsapp.net");
    const result = resolveSessionOutputTarget({ sessionKey: session.sessionKey, fallback });
    expect(result.source).toBe("focus");
    expect(result.target?.canonicalChatId).toBe(chat.id);
    expect(result.target?.chatId).toBe(chat.platformChatId);
    expect(result.target?.channel).toBe("whatsapp");
  });

  it("falls back to inbound source after focus is cleared", () => {
    const session = getOrCreateSession("agent:dev:s4", "dev", "/tmp/dev");
    const chat = makeChat("once-focused");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id });
    setSessionFocus({ sessionKey: session.sessionKey, chatId: chat.id });
    clearSessionFocus(session.sessionKey);
    const fallback = makeFallback("inbound-source@s.whatsapp.net");
    const result = resolveSessionOutputTarget({ sessionKey: session.sessionKey, fallback });
    expect(result.source).toBe("inbound-source");
    expect(result.target).toEqual(fallback);
  });

  it("falls back to inbound source when the focus chat has been detached", () => {
    const session = getOrCreateSession("agent:dev:s5", "dev", "/tmp/dev");
    const primary = makeChat("primary-c");
    const focused = makeChat("focused-c");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: primary.id, role: "primary" });
    attachChatToSession({ sessionKey: session.sessionKey, chatId: focused.id });
    setSessionFocus({ sessionKey: session.sessionKey, chatId: focused.id });
    // detachChatFromSession cascade clears focus. After detach + clear,
    // the session falls back to the inbound source.
    detachChatFromSession(session.sessionKey, focused.id);
    const fallback = makeFallback("inbound@s.whatsapp.net");
    const result = resolveSessionOutputTarget({ sessionKey: session.sessionKey, fallback });
    expect(result.source).toBe("inbound-source");
    expect(result.target).toEqual(fallback);
  });
});
