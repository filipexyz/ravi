import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../context.js";
import { attachChatToSession, getOrCreateSession, listSessionSubscriptions } from "../../router/sessions.js";
import { dbCreateAgent, dbGetAgent, dbSetSetting, dbUpsertChat } from "../../router/router-db.js";
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

describe("sessions set-provider/set-model --propagate", () => {
  it("needs the authority of agents set, and changes nothing without it", () => {
    dbCreateAgent({ id: "crm", cwd: "/tmp/crm", model: "gpt-5" });
    const own = getOrCreateSession("agent:crm:main", "crm", "/tmp/crm");
    const before = dbGetAgent("crm");
    const commands = new SessionCommands();

    runWithContext(BOOTSTRAP, () => {
      expect(() => commands.setProvider(own.sessionKey, "claude", true, true)).toThrow("--propagate");
      expect(() => commands.setModel(own.sessionKey, "gpt-5-mini", true, true)).toThrow("--propagate");
    });
    expect(dbGetAgent("crm")).toEqual(before);
    expect(getOrCreateSession("agent:crm:main", "crm", "/tmp/crm").runtimeProviderOverride ?? null).toBeNull();
  });
});

describe("sessions set-provider", () => {
  it("needs the authority of agents set to move an agent's session to another provider", () => {
    dbCreateAgent({ id: "crm", cwd: "/tmp/crm", provider: "claude" });
    const own = getOrCreateSession("agent:crm:main", "crm", "/tmp/crm");
    const commands = new SessionCommands();

    runWithContext(BOOTSTRAP, () => {
      expect(() => commands.setProvider(own.sessionKey, "codex", true)).toThrow("tool gate");
      commands.setProvider(own.sessionKey, "claude", true);
      commands.setProvider(own.sessionKey, "clear", true);
    });
    expect(getOrCreateSession("agent:crm:main", "crm", "/tmp/crm").runtimeProviderOverride ?? null).not.toBe("codex");
  });
});

describe("sessions set-provider with no agent provider", () => {
  it("treats the runtime.defaultProvider setting as the agent's own provider", () => {
    dbCreateAgent({ id: "crm", cwd: "/tmp/crm" });
    dbSetSetting("runtime.defaultProvider", "claude");
    const own = getOrCreateSession("agent:crm:main", "crm", "/tmp/crm");
    const commands = new SessionCommands();

    runWithContext(BOOTSTRAP, () => {
      commands.setProvider(own.sessionKey, "claude", true);
      expect(() => commands.setProvider(own.sessionKey, "codex", true)).toThrow("tool gate");
    });
  });
});

describe("sessions relay delivery override", () => {
  it("refuses --channel/--to naming a chat the target session is not attached to", async () => {
    const own = getOrCreateSession("agent:crm:worker", "crm", "/tmp/crm");
    const send = new SessionCommands().send as (...values: unknown[]) => Promise<unknown>;
    const args: unknown[] = [own.name ?? own.sessionKey, "hello"];
    args[5] = "whatsapp"; // --channel
    args[6] = "5511900009999@s.whatsapp.net"; // --to
    args[15] = true; // --json
    const caller: ToolContext = {
      ...BOOTSTRAP,
      context: {
        ...BOOTSTRAP.context!,
        capabilities: [
          ...BOOTSTRAP.context!.capabilities,
          { permission: "access", objectType: "session", objectId: own.name ?? own.sessionKey, source: "test" },
        ],
      },
    };
    const error = await runWithContext(caller, () => send.apply(new SessionCommands(), args)).then(
      () => null,
      (err: unknown) => err as { code?: string },
    );
    expect(error?.code).toBe("PERMISSION_DENIED");
    expect(getOrCreateSession("agent:crm:worker", "crm", "/tmp/crm").lastTo ?? null).toBeNull();
  });
});

describe("sessions send --thread", () => {
  it("needs the threads brief and comment authority", async () => {
    const own = getOrCreateSession("agent:crm:worker", "crm", "/tmp/crm");
    const send = new SessionCommands().send as (...values: unknown[]) => Promise<unknown>;
    const args: unknown[] = [own.name ?? own.sessionKey, "hello"];
    args[7] = "thr_foreign"; // --thread
    args[15] = true; // --json
    const caller: ToolContext = {
      ...BOOTSTRAP,
      context: {
        ...BOOTSTRAP.context!,
        capabilities: [
          ...BOOTSTRAP.context!.capabilities,
          { permission: "access", objectType: "session", objectId: own.name ?? own.sessionKey, source: "test" },
        ],
      },
    };
    const error = await runWithContext(caller, () => send.apply(new SessionCommands(), args)).then(
      () => null,
      (err: unknown) => err as { envelope?: () => { error: { code: string } } },
    );
    expect(error?.envelope?.().error.code).toBe("PERMISSION_DENIED");
  });
});
