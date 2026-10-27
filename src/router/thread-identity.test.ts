import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeSlackThreadLifecycle, registerInboundSlackThread } from "../channels/slack/thread-lifecycle-store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { deleteSession, getOrCreateSession, renameSessionName, resolveSession } from "./sessions.js";
import { assessSessionThreadIdentity, findOpenThreadIdentity } from "./thread-identity.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-thread-identity-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const PARENT_KEY = "agent:dev:slack:slack-main:group:C0ABC123";
const CHILD_KEY = `${PARENT_KEY}:thread:1712345678.123456`;

function registerThread() {
  return registerInboundSlackThread({
    parentSessionKey: PARENT_KEY,
    parentSessionName: "dev-channel",
    childSessionKey: CHILD_KEY,
    childSessionName: "dev-channel-thread",
    accountId: "slack-main",
    instanceId: "slack-main",
    platformChatId: "C0ABC123",
    threadCanonicalChatId: "chat-thread",
    providerThreadId: "1712345678.123456",
  });
}

describe("channel thread identity", () => {
  it("finds an open thread by its child session name or key", () => {
    const record = registerThread();
    expect(findOpenThreadIdentity("dev-channel-thread")).toMatchObject({
      requestId: record.requestId,
      childSessionKey: CHILD_KEY,
      parentSessionName: "dev-channel",
    });
    expect(findOpenThreadIdentity(CHILD_KEY)?.requestId).toBe(record.requestId);
    expect(findOpenThreadIdentity("someone-else")).toBeNull();
    expect(findOpenThreadIdentity("  ")).toBeNull();
  });

  it("ignores closed threads", () => {
    registerThread();
    closeSlackThreadLifecycle({ childSessionKey: CHILD_KEY });
    expect(findOpenThreadIdentity("dev-channel-thread")).toBeNull();
  });

  it("tells a missing child and a session under another key apart from the thread's own session", () => {
    registerThread();
    expect(assessSessionThreadIdentity("free-name", null)).toEqual({ kind: "none" });
    expect(assessSessionThreadIdentity("dev-channel-thread", null).kind).toBe("child_missing");
    expect(assessSessionThreadIdentity("dev-channel-thread", { sessionKey: "dev-channel-thread" })).toMatchObject({
      kind: "key_mismatch",
      sessionKey: "dev-channel-thread",
    });
    expect(assessSessionThreadIdentity("dev-channel-thread", { sessionKey: CHILD_KEY }).kind).toBe("ok");
  });

  it("follows a renamed thread child, so the new name stays protected after the session is deleted", () => {
    registerThread();
    getOrCreateSession(PARENT_KEY, "dev", "/tmp/dev", { name: "dev-channel" });
    getOrCreateSession(CHILD_KEY, "dev", "/tmp/dev", { name: "dev-channel-thread" });

    renameSessionName(CHILD_KEY, "renamed-thread");
    renameSessionName(PARENT_KEY, "renamed-channel");
    deleteSession(CHILD_KEY);

    expect(assessSessionThreadIdentity("renamed-thread", resolveSession("renamed-thread"))).toMatchObject({
      kind: "child_missing",
      thread: { parentSessionName: "renamed-channel" },
    });
    expect(assessSessionThreadIdentity("dev-channel-thread", null)).toEqual({ kind: "none" });
  });
});
