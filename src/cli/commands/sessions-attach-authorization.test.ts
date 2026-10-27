import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../context.js";
import { attachChatToSession, getOrCreateSession, listSessionSubscriptions } from "../../router/sessions.js";
import { dbUpsertChat } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { SessionCommands } from "./sessions.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sessions-attach-authz-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const BOOTSTRAP: ToolContext = {
  contextId: "ctx_crm",
  agentId: "crm",
  sessionKey: "agent:crm:main",
  sessionName: "agent:crm:main",
  context: {
    contextId: "ctx_crm",
    contextKey: "rctx_crm",
    kind: "agent-runtime",
    agentId: "crm",
    sessionKey: "agent:crm:main",
    sessionName: "agent:crm:main",
    capabilities: [{ permission: "execute", objectType: "group", objectId: "sessions", source: "test" }],
    createdAt: 0,
  },
};

function makeChat(suffix: string) {
  return dbUpsertChat({
    channel: "whatsapp",
    instanceId: "luis",
    platformChatId: `${suffix}@s.whatsapp.net`,
    chatType: "dm",
    title: `chat-${suffix}`,
  });
}

function expectNotFound(fn: () => unknown, message: string): void {
  expect(fn).toThrow(message);
}

describe("sessions attach/detach/subscriptions authorization", () => {
  it("refuses another agent's session as not found for a bootstrap-only agent", () => {
    getOrCreateSession("agent:crm:main", "crm", "/tmp/crm");
    const victim = getOrCreateSession("agent:main:main", "main", "/tmp/main");
    const victimChat = makeChat("5511900000001");
    attachChatToSession({ sessionKey: victim.sessionKey, chatId: victimChat.id, setOutputTarget: true });
    const attackerChat = makeChat("5511900000002");
    const commands = new SessionCommands();

    runWithContext(BOOTSTRAP, () => {
      expectNotFound(() => commands.attach(victim.sessionKey, attackerChat.id), "Session not found");
      expectNotFound(() => commands.detach(victim.sessionKey, victimChat.id), "Session not found");
      expectNotFound(() => commands.subscriptions(victim.sessionKey, true), "Session not found");
    });

    expect(listSessionSubscriptions(victim.sessionKey).map((s) => s.chatId)).toEqual([victimChat.id]);
  });

  it("refuses taking a chat owned by another agent's session into the caller's own session", () => {
    const own = getOrCreateSession("agent:crm:main", "crm", "/tmp/crm");
    const victim = getOrCreateSession("agent:main:main", "main", "/tmp/main");
    const victimChat = makeChat("5511900000003");
    attachChatToSession({ sessionKey: victim.sessionKey, chatId: victimChat.id, setOutputTarget: true });

    runWithContext(BOOTSTRAP, () => {
      expectNotFound(() => new SessionCommands().attach(own.sessionKey, victimChat.id), "Chat not found");
    });
    expect(listSessionSubscriptions(own.sessionKey)).toEqual([]);
  });

  it("records an agent's attach of an unowned chat to its own session as an agent attach", () => {
    const own = getOrCreateSession("agent:crm:main", "crm", "/tmp/crm");
    const freeChat = makeChat("5511900000004");

    runWithContext(BOOTSTRAP, () => new SessionCommands().attach(own.sessionKey, freeChat.id, undefined, true));
    const [sub] = listSessionSubscriptions(own.sessionKey);
    expect(sub).toMatchObject({ chatId: freeChat.id, attachedByType: "agent", attachedById: "crm" });
  });
});
