import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { admitThreadAttention } from "../channels/slack/thread-attention-admission.js";
import { reconcileSlackThreadLifecycle } from "../channels/slack/thread-lifecycle.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import type { RuntimeLaunchPrompt } from "../runtime/message-types.js";
import { recordSessionEvent, upsertSessionTurn } from "../session-trace/session-trace-db.js";
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
  it("never admits a frozen attention to a replacement using the original parent name", async () => {
    getOrCreateSession(PARENT_KEY, "main", "/tmp", { name: "dev-channel" });
    getOrCreateSession(CHILD_KEY, "main", "/tmp", { name: "dev-channel-thread" });
    registerThread();
    const startedAt = Date.now() - 20 * 60_000;
    const turnId = "parent-replaced-turn";
    const caller = createRuntimeContext({
      kind: "turn-runtime",
      agentId: "main",
      sessionKey: CHILD_KEY,
      capabilities: [],
    });
    upsertSessionTurn({ turnId, sessionKey: CHILD_KEY, startedAt, updatedAt: startedAt, status: "running" });
    recordSessionEvent({
      sessionKey: CHILD_KEY,
      turnId,
      eventType: "adapter.request",
      eventGroup: "runtime",
      timestamp: startedAt,
      payloadJson: { context_id: caller.contextId },
    });
    let captured: RuntimeLaunchPrompt | undefined;
    const result = await reconcileSlackThreadLifecycle({
      publishEvent: async () => {},
      publishPrompt: async (_name, payload) => {
        captured = payload as unknown as RuntimeLaunchPrompt;
      },
    });
    expect(result.failures).toBe(0);
    expect(captured?._slackThreadLifecycle?.parentSessionKey).toBe(PARENT_KEY);
    renameSessionName(PARENT_KEY, "renamed-parent");
    getOrCreateSession("replacement-parent", "main", "/tmp", { name: "dev-channel" });
    const handle = mock(async () => {});
    await expect(admitThreadAttention("dev-channel", captured!, handle)).rejects.toThrow("target differs");
    expect(handle).not.toHaveBeenCalled();
    expect(resolveSession("dev-channel")?.sessionKey).toBe("replacement-parent");
  });

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

  it("refuses to rename another session to a name an open thread still owns, even with its child gone", () => {
    registerThread();
    getOrCreateSession(PARENT_KEY, "dev", "/tmp/dev", { name: "dev-channel" });
    getOrCreateSession("agent:dev:main", "dev", "/tmp/dev", { name: "dev-main" });

    expect(() => renameSessionName("agent:dev:main", "dev-channel-thread")).toThrow(
      "Session name is reserved by an open channel thread: dev-channel-thread",
    );
    expect(resolveSession("dev-main")?.sessionKey).toBe("agent:dev:main");

    getOrCreateSession(CHILD_KEY, "dev", "/tmp/dev", { name: "dev-channel-thread" });
    expect(renameSessionName(CHILD_KEY, "dev-channel-thread").changed).toBe(false);
  });
});
