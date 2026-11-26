import { afterEach, beforeEach, describe, expect, it } from "bun:test";

// The CLI reaches the gateway from inside an agent turn with the console muted (`suppressCliOutput`): what the
// caller reads is the value the handler returns, and a handler that only prints answers `{}`. On 26/11 a turn ran
// `ravi sessions detach` and `ravi sessions subscriptions` that way, read `{}` as "no chat attached", and the
// session had 22. Each test here runs the real handler in that context WITHOUT `--json` and expects the payload.
process.env.NATS_URL = "nats://127.0.0.1:1";

const { attachChatToSession, getOrCreateSession, listSessionSubscriptions } = await import("../../router/sessions.js");
const { dbUpsertChat } = await import("../../router/router-db.js");
const { cleanupIsolatedRaviState, createIsolatedRaviState } = await import("../../test/ravi-state.js");
const { runWithContext } = await import("../context.js");
const { SessionCommands } = await import("./sessions.js");

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sessions-structured-return-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

/** The context the gateway builds for a CLI call from an agent turn: console muted, no `--json`. */
const gateway = <T>(fn: () => T): T => runWithContext({ suppressCliOutput: true, transport: "gateway" }, fn);

async function captureTerminal<T>(fn: () => T | Promise<T>): Promise<{ value: T; output: string }> {
  const run = fn;
  fn = () => runWithContext({ transport: "gateway" }, run);
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

function makeSession(name = "target") {
  return getOrCreateSession(`agent:${name}:main`, name, `/tmp/${name}`, { name });
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

describe("sessions chat attachments answer with their payload inside a gateway turn", () => {
  it("subscriptions lists the attached chats instead of {}", async () => {
    const session = makeSession();
    const one = makeChat("5511900000001");
    const two = makeChat("5511900000002");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: one.id, role: "input" });
    attachChatToSession({ sessionKey: session.sessionKey, chatId: two.id, role: "input" });

    const payload = (await gateway(() => new SessionCommands().subscriptions("target"))) as Record<string, any>;

    expect(payload).toBeDefined();
    expect(payload.sessionKey).toBe("agent:target:main");
    expect(payload.subscriptions.map((s: { chatId: string }) => s.chatId).sort()).toEqual([one.id, two.id].sort());
    expect(payload.subscriptions[0].chat).toMatchObject({ channel: "whatsapp" });
  });

  it("detach answers whether the chat was detached, and the detach still happens", async () => {
    const session = makeSession();
    const chat = makeChat("5511900000003");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id, role: "input" });

    const payload = (await gateway(() => new SessionCommands().detach("target", chat.id))) as Record<string, any>;

    expect(payload).toBeDefined();
    expect(payload.detached).toBe(true);
    expect(listSessionSubscriptions(session.sessionKey)).toHaveLength(0);

    const again = (await gateway(() => new SessionCommands().detach("target", chat.id))) as Record<string, any>;
    expect(again.detached).toBe(false);
  });

  it("attach answers with the subscription and the detach hint", async () => {
    const session = makeSession();
    const chat = makeChat("5511900000004");

    const payload = (await gateway(() => new SessionCommands().attach("target", chat.id))) as Record<string, any>;

    expect(payload).toBeDefined();
    expect(payload.created).toBe(true);
    expect(payload.chat.id).toBe(chat.id);
    expect(payload.hints.detach).toBe(`ravi sessions detach target --chat ${chat.id}`);
    expect(listSessionSubscriptions(session.sessionKey).map((s) => s.chatId)).toEqual([chat.id]);
  });

  it("attach hands a conflict back as data only for an explicit --json, and still fails without it", async () => {
    const owner = makeSession("owner");
    makeSession("other");
    const chat = makeChat("5511900000005");
    attachChatToSession({ sessionKey: owner.sessionKey, chatId: chat.id, role: "primary", setOutputTarget: true });

    const asData = (await gateway(() => new SessionCommands().attach("other", chat.id, undefined, true))) as Record<
      string,
      any
    >;
    expect(asData.error).toBeDefined();
    expect(asData.chatId).toBe(chat.id);

    expect(() => gateway(() => new SessionCommands().attach("other", chat.id))).toThrow();
  });
});

describe("sessions mutations answer with their payload inside a gateway turn", () => {
  it("rename", async () => {
    makeSession();
    const payload = (await gateway(() => new SessionCommands().rename("target", "renamed"))) as Record<string, any>;
    expect(payload).toBeDefined();
    expect(payload.newName).toBe("renamed");
    expect(payload.changed).toBe(true);
  });

  it("set-ttl, extend and keep", async () => {
    makeSession();
    const ttl = (await gateway(() => new SessionCommands().setTtl("target", "2h"))) as Record<string, any>;
    expect(ttl).toBeDefined();
    expect(ttl.duration).toBe("2h");

    const extended = (await gateway(() => new SessionCommands().extend("target", "1h"))) as Record<string, any>;
    expect(extended).toBeDefined();
    expect(extended.duration).toBe("1h");

    const kept = (await gateway(() => new SessionCommands().keep("target"))) as Record<string, any>;
    expect(kept).toBeDefined();
    expect(kept.changed).toBe(true);

    const keptAgain = (await gateway(() => new SessionCommands().keep("target"))) as Record<string, any>;
    expect(keptAgain).toBeDefined();
    expect(keptAgain.reason).toBe("already_permanent");
  });

  it("reset and delete, with --execute", async () => {
    makeSession();
    const reset = (await gateway(() => new SessionCommands().reset("target", undefined, true))) as Record<string, any>;
    expect(reset).toBeDefined();
    expect(reset.action ?? reset.op ?? reset.nextMessageStartsFreshConversation).toBeDefined();

    const deleted = (await gateway(() => new SessionCommands().delete("target", undefined, true))) as Record<
      string,
      any
    >;
    expect(deleted).toBeDefined();
    expect(deleted.changed).toBe(true);
  });
});

describe("the terminal does not change", () => {
  it("subscriptions, detach and attach print the human text and leave the return value alone", async () => {
    const session = makeSession();
    const chat = makeChat("5511900000006");

    const attached = await captureTerminal(() => new SessionCommands().attach("target", chat.id));
    expect(attached.output).toContain(`Attached chat ${chat.id}`);
    expect(attached.output).not.toContain('"hints"');
    expect(attached.value).toBeUndefined();

    const listed = await captureTerminal(() => new SessionCommands().subscriptions("target"));
    expect(listed.output).toContain(`Subscriptions for target:`);
    expect(listed.value).toBeUndefined();

    const detached = await captureTerminal(() => new SessionCommands().detach("target", chat.id));
    expect(detached.output).toContain(`Detached chat ${chat.id}`);
    expect(detached.value).toBeUndefined();
    expect(listSessionSubscriptions(session.sessionKey)).toHaveLength(0);
  });

  it("--json still prints the payload and returns it", async () => {
    makeSession();
    const chat = makeChat("5511900000007");
    attachChatToSession({ sessionKey: "agent:target:main", chatId: chat.id, role: "input" });

    const { value, output } = await captureTerminal(() => new SessionCommands().subscriptions("target", true));

    expect(JSON.parse(output)).toMatchObject({ sessionKey: "agent:target:main" });
    expect((value as Record<string, any>).subscriptions).toHaveLength(1);
  });
});
