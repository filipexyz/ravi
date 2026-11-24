import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { runChatCommand } from "../../chat-commands/engine.js";
import type { CliCommandAccessInput } from "../../cli/command-access.js";
import { getOrCreateSession } from "../../router/index.js";
import type { ContextCapability } from "../../router/router-db.js";
import type { RouterConfig, SessionEntry } from "../../router/types.js";
import type { RuntimeControlResult } from "../../runtime/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  type SlackCommandAudit,
  type SlackCommandDeps,
  slackChatCommandDeps,
  slackCommandChannel,
} from "./slash-command-handler.js";
import { SLACK_THREAD_CLOSE_ACTION_ID, SLACK_THREAD_STOP_ACTION_ID } from "./thread-card.js";
import {
  handleSlackThreadControlClick,
  parseSlackThreadControlClick,
  SLACK_THREAD_CONTROLS_QUEUE_GROUP,
  SLACK_THREAD_CONTROLS_TOPIC,
  startSlackThreadControls,
  stopSlackThreadControls,
} from "./thread-controls.js";
import { findSlackThreadForParent, findSlackThreadForParentInChat } from "./thread-lifecycle.js";
import { getSlackThreadLifecycle, registerInboundSlackThread } from "./thread-lifecycle-store.js";

const NOW = 1_800_000_000_000;
const ACCOUNT = "ravi-slack";
const INSTANCE = "slack-instance";
const CONTACT = "contact-ana";
/** The card of the thread: Slack keeps the root's ts as the thread's `thread_ts`. */
const CARD_TS = "1795189835.360089";
const PARENT_KEY = "agent:main:main";
const CHILD_KEY = "agent:main:main:thread:1795189835.360089";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-slack-thread-controls-");
});

afterEach(async () => {
  await stopSlackThreadControls();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function click(overrides: Record<string, unknown> = {}) {
  return {
    provider: "slack",
    source: "slack.socket_mode",
    accountId: ACCOUNT,
    instanceId: INSTANCE,
    routeAccountId: ACCOUNT,
    envelopeId: "env-1",
    interactionType: "block_actions",
    teamId: "T0TEAM",
    userId: "U0PERSON",
    channelId: "C0CHAN",
    messageTs: CARD_TS,
    threadTs: CARD_TS,
    actionId: SLACK_THREAD_CLOSE_ACTION_ID,
    blockId: "ravi_thread_controls",
    actionType: "button",
    value: "thread",
    responseUrlId: "handle-1",
    receivedAt: NOW,
    ...overrides,
  };
}

function session(): SessionEntry {
  return {
    sessionKey: PARENT_KEY,
    name: "main",
    agentId: "main",
    agentCwd: "/tmp/main",
    createdAt: 1,
    updatedAt: 1,
  } as SessionEntry;
}

function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId, source: "test" } as ContextCapability;
}

const READER: ContextCapability[] = [cap("access", "session", "main")];
const CONTROLLER: ContextCapability[] = [cap("access", "session", "main"), cap("modify", "session", "main")];

interface Harness {
  deps: SlackCommandDeps;
  replies: Array<Record<string, unknown>>;
  audits: SlackCommandAudit[];
  calls: { close: Array<[string, string]>; interrupted: string[]; access: CliCommandAccessInput[] };
}

/** The real thread store and the real session lookup; only the effects are faked. */
function harness(options: { capabilities?: ContextCapability[]; contact?: string | null } = {}): Harness {
  const replies: Array<Record<string, unknown>> = [];
  const audits: SlackCommandAudit[] = [];
  const calls: Harness["calls"] = { close: [], interrupted: [], access: [] };
  const deps: SlackCommandDeps = {
    now: () => NOW,
    routerConfig: () => ({}) as RouterConfig,
    respond: async ({ payload }) => {
      replies.push(payload);
    },
    contactForSlackUser: () => (options.contact === undefined ? CONTACT : options.contact),
    resolveSession: () => ({ kind: "session", session: session(), agentId: "main" }),
    capabilitiesFor: () => options.capabilities ?? CONTROLLER,
    inheritedAccess: async (operation) => ({
      group: operation === "interrupt" ? "sessions.runtime" : "sessions",
      command: operation,
      access: { kind: "mutate", resource: "sessions", action: operation, risk: "medium" },
    }),
    commandAccess: (input) => {
      calls.access.push(input);
      return { allowed: true, errorMessage: "", attempted: [] };
    },
    closeThread: async (parent, ref) => {
      calls.close.push([parent, ref]);
      return { kind: "closed", name: "main-t-card", changed: true };
    },
    interrupt: async (target) => {
      calls.interrupted.push(target.sessionKey);
      return { ok: true, operation: "turn.interrupt" } as RuntimeControlResult;
    },
    audit: (entry) => {
      audits.push(entry);
    },
  };
  return { deps, replies, audits, calls };
}

function text(reply: Record<string, unknown> | undefined): string {
  return String(reply?.text ?? "");
}

function registerCard(overrides: { providerThreadId?: string; parent?: string } = {}) {
  return registerInboundSlackThread({
    requestId: "req-card",
    parentSessionKey: overrides.parent ?? PARENT_KEY,
    parentSessionName: "main",
    childSessionKey: CHILD_KEY,
    childSessionName: "main-t-card",
    accountId: ACCOUNT,
    instanceId: INSTANCE,
    platformChatId: "C0CHAN",
    threadCanonicalChatId: "chat-card",
    providerThreadId: overrides.providerThreadId ?? CARD_TS,
    seenAt: NOW - 3_600_000,
  });
}

describe("which interactions are a click on a thread card", () => {
  it("reads Fechar and Parar, and the clicked card's own message as the thread", () => {
    expect(parseSlackThreadControlClick(click())).toEqual({
      action: "close",
      accountId: ACCOUNT,
      instanceId: INSTANCE,
      routeAccountId: ACCOUNT,
      channelId: "C0CHAN",
      userId: "U0PERSON",
      messageTs: CARD_TS,
      receivedAt: NOW,
      envelopeId: "env-1",
      responseUrlId: "handle-1",
    });
    expect(parseSlackThreadControlClick(click({ actionId: SLACK_THREAD_STOP_ACTION_ID }))).toMatchObject({
      action: "stop",
    });
  });

  it("falls back to the account for the route scope, and drops the optional ids", () => {
    const parsed = parseSlackThreadControlClick(
      click({ routeAccountId: undefined, envelopeId: undefined, responseUrlId: undefined }),
    );

    expect(parsed).toMatchObject({ routeAccountId: ACCOUNT });
    expect(parsed).not.toHaveProperty("envelopeId");
    expect(parsed).not.toHaveProperty("responseUrlId");
  });

  it("ignores everything else: other buttons, other interaction types, other providers, a card with no usable ts", () => {
    const refused = [
      click({ actionId: "approve:pgr_1" }),
      click({ actionId: undefined }),
      click({ interactionType: "message_action" }),
      click({ interactionType: "view_submission" }),
      click({ provider: "discord" }),
      click({ source: "other" }),
      click({ messageTs: undefined }),
      // Not the root of a thread: nothing here may become another word of the command.
      click({ messageTs: "main-t-1" }),
      click({ messageTs: "1795189835.360089 stop" }),
      click({ userId: "" }),
      click({ channelId: undefined }),
      // A click with no arrival time cannot be held to the freshness window.
      click({ receivedAt: undefined }),
      click({ receivedAt: Number.NaN }),
      null,
      "text",
      [],
    ];
    for (const data of refused) expect(parseSlackThreadControlClick(data)).toBeNull();
  });
});

describe("a click becomes the same command, with the authority of the person who clicked", () => {
  it("Fechar closes the thread of the card, found by its own ts, and says so privately", async () => {
    const h = harness();

    const outcome = await handleSlackThreadControlClick(click(), h.deps);

    expect(outcome).toEqual({ decision: "allowed", code: "ok" });
    expect(h.calls.close).toEqual([[PARENT_KEY, CARD_TS]]);
    expect(h.calls.access).toMatchObject([
      {
        source: "channel-command",
        subject: { type: "contact", id: CONTACT },
        group: "sessions",
        command: "close-thread",
      },
    ]);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]?.response_type).toBe("ephemeral");
    expect(text(h.replies[0])).toContain("Closed thread `main-t-card`");
    expect(h.audits).toMatchObject([
      {
        type: "chat_command",
        channel: "slack",
        surface: "button",
        chatId: "C0CHAN",
        actorId: "U0PERSON",
        contactId: CONTACT,
        subcommand: "close",
        decision: "allowed",
        requestId: "env-1",
      },
    ]);
  });

  it("Parar interrupts the turn of the thread's own session, not the chat's", async () => {
    registerCard();
    const child = getOrCreateSession(CHILD_KEY, "main", "/tmp/main", { name: "main-t-card" });
    const h = harness();
    // The real thread store finds the card by its ts; only the interrupt is faked.
    const outcome = await handleSlackThreadControlClick(click({ actionId: SLACK_THREAD_STOP_ACTION_ID }), h.deps);

    expect(outcome).toEqual({ decision: "allowed", code: "ok" });
    expect(h.calls.interrupted).toEqual([child.sessionKey]);
    expect(text(h.replies[0])).toContain("Interrupted the turn running in `main-t-card`");
    expect(h.audits).toMatchObject([{ surface: "button", subcommand: "stop", decision: "allowed" }]);
  });

  it("refuses a Slack user nobody linked to a contact, and runs nothing", async () => {
    const h = harness({ contact: null });

    for (const actionId of [SLACK_THREAD_CLOSE_ACTION_ID, SLACK_THREAD_STOP_ACTION_ID]) {
      expect(await handleSlackThreadControlClick(click({ actionId }), h.deps)).toEqual({
        decision: "denied",
        code: "unknown_user",
      });
    }
    expect(h.calls.close).toEqual([]);
    expect(h.calls.interrupted).toEqual([]);
    expect(text(h.replies[0])).toContain("I don't recognize you");
  });

  it("refuses a person who can read the session but not change it, and runs nothing", async () => {
    registerCard();
    getOrCreateSession(CHILD_KEY, "main", "/tmp/main", { name: "main-t-card" });
    const h = harness({ capabilities: READER });

    for (const actionId of [SLACK_THREAD_CLOSE_ACTION_ID, SLACK_THREAD_STOP_ACTION_ID]) {
      expect(await handleSlackThreadControlClick(click({ actionId }), h.deps)).toEqual({
        decision: "denied",
        code: "not_authorized_modify",
      });
    }
    expect(h.calls.close).toEqual([]);
    expect(h.calls.interrupted).toEqual([]);
    expect(text(h.replies[0])).toContain("You are not allowed to change session `main`");
  });

  describe("a click names the thread of its own chat, not another chat's of the same session (review N2 of #941)", () => {
    const OTHER_CHAT_CHILD_KEY = "agent:main:main:thread:1795189835.360089#other";

    function registerInOtherChat(seenAt: number) {
      // The same root ts in another channel of the same parent session, and the newer of the two.
      return registerInboundSlackThread({
        requestId: "req-other-chat",
        parentSessionKey: PARENT_KEY,
        parentSessionName: "main",
        childSessionKey: OTHER_CHAT_CHILD_KEY,
        childSessionName: "main-t-other-chat",
        accountId: ACCOUNT,
        instanceId: INSTANCE,
        platformChatId: "C0OTHER",
        threadCanonicalChatId: "chat-other",
        providerThreadId: CARD_TS,
        seenAt,
      });
    }

    it("stops the thread of the clicked chat, whichever of the two was updated last", async () => {
      registerCard();
      registerInOtherChat(NOW - 60_000);
      const own = getOrCreateSession(CHILD_KEY, "main", "/tmp/main", { name: "main-t-card" });
      getOrCreateSession(OTHER_CHAT_CHILD_KEY, "main", "/tmp/main", { name: "main-t-other-chat" });
      const h = harness();

      const outcome = await handleSlackThreadControlClick(click({ actionId: SLACK_THREAD_STOP_ACTION_ID }), h.deps);

      expect(outcome).toEqual({ decision: "allowed", code: "ok" });
      expect(h.calls.interrupted).toEqual([own.sessionKey]);
    });

    it("picks the clicked chat's record when both threads share one child session, as the real derivation makes them", () => {
      // The child session key is the parent's and the root ts, with no channel in it: two threads of one parent
      // with the same root share one child session, so `stop` reaches it either way and the record is what differs.
      registerCard();
      registerInboundSlackThread({
        requestId: "req-other-chat",
        parentSessionKey: PARENT_KEY,
        parentSessionName: "main",
        childSessionKey: CHILD_KEY,
        childSessionName: "main-t-card",
        accountId: ACCOUNT,
        instanceId: INSTANCE,
        platformChatId: "C0OTHER",
        threadCanonicalChatId: "chat-other",
        providerThreadId: CARD_TS,
        seenAt: NOW - 60_000,
      });

      expect(findSlackThreadForParentInChat(PARENT_KEY, "C0CHAN", CARD_TS)?.requestId).toBe("req-card");
      expect(findSlackThreadForParentInChat(PARENT_KEY, "C0OTHER", CARD_TS)?.requestId).toBe("req-other-chat");
      expect(findSlackThreadForParentInChat(PARENT_KEY, "C0THIRD", CARD_TS)).toBeNull();
      // What a typed command gets: the lookup by any name takes the one updated last, whichever chat typed it.
      expect(findSlackThreadForParent(PARENT_KEY, CARD_TS)?.requestId).toBe("req-other-chat");
    });

    it("finds nothing for a chat that has no thread with that root, though another chat of the session has", async () => {
      registerInOtherChat(NOW - 60_000);
      getOrCreateSession(OTHER_CHAT_CHILD_KEY, "main", "/tmp/main", { name: "main-t-other-chat" });
      const h = harness();

      expect(await handleSlackThreadControlClick(click({ actionId: SLACK_THREAD_STOP_ACTION_ID }), h.deps)).toEqual({
        decision: "info",
        code: "thread_not_found",
      });
      expect(h.calls.interrupted).toEqual([]);
    });

    it("closes the thread of the clicked chat through the real close, and leaves the other chat's open (review N2 of #945)", async () => {
      registerCard();
      registerInOtherChat(NOW - 60_000);
      const h = harness();

      const outcome = await handleSlackThreadControlClick(click(), { ...h.deps, closeThread: undefined });

      expect(outcome).toEqual({ decision: "allowed", code: "ok" });
      expect(getSlackThreadLifecycle("req-card")?.status).toBe("closed");
      expect(getSlackThreadLifecycle("req-other-chat")?.status).not.toBe("closed");
    });

    it("closes under the clicked chat too: the lookup is asked for that chat", async () => {
      const asked: Array<[string, string, string | undefined]> = [];
      const h = harness();
      const deps: SlackCommandDeps = {
        ...h.deps,
        closeThread: async (parent, ref, chatId) => {
          asked.push([parent, ref, chatId]);
          return { kind: "closed", name: "main-t-card", changed: true };
        },
      };

      await handleSlackThreadControlClick(click(), deps);

      expect(asked).toEqual([[PARENT_KEY, CARD_TS, "C0CHAN"]]);
    });

    it("keeps a typed command free to name any thread of the session: no chat is asked for", async () => {
      const asked: Array<[string, string, string | undefined]> = [];
      const h = harness();
      const deps: SlackCommandDeps = {
        ...h.deps,
        closeThread: async (parent, ref, chatId) => {
          asked.push([parent, ref, chatId]);
          return { kind: "closed", name: "main-t-card", changed: true };
        },
      };
      const channel = slackCommandChannel(
        {
          accountId: ACCOUNT,
          instanceId: INSTANCE,
          routeAccountId: ACCOUNT,
          channelId: "C0CHAN",
          userId: "U0PERSON",
          text: "close main-t-card",
          receivedAt: NOW,
          command: "/ravi",
          surface: "command",
        },
        deps,
      );

      await runChatCommand(channel, slackChatCommandDeps(deps));

      expect(asked).toEqual([[PARENT_KEY, "main-t-card", undefined]]);
    });
  });

  it("does not let a card name a thread of another chat's session", async () => {
    // The thread belongs to a session other than the one this chat resolves to.
    registerCard({ parent: "agent:other:main" });
    getOrCreateSession(CHILD_KEY, "main", "/tmp/main", { name: "main-t-card" });
    const h = harness();

    const outcome = await handleSlackThreadControlClick(
      click({ actionId: SLACK_THREAD_STOP_ACTION_ID }),
      // The real lookup, scoped to the chat's own session.
      { ...h.deps, findThread: undefined },
    );

    expect(outcome).toEqual({ decision: "info", code: "thread_not_found" });
    expect(h.calls.interrupted).toEqual([]);
  });

  describe("a chat that resolves to a thread's own session (review N2 of #937)", () => {
    const CHILD_CONTROLLER: ContextCapability[] = [
      cap("access", "session", "main-t-card"),
      cap("modify", "session", "main-t-card"),
    ];

    function withChildSession(h: Harness): SlackCommandDeps {
      const child = getOrCreateSession(CHILD_KEY, "main", "/tmp/main", { name: "main-t-card" });
      return {
        ...h.deps,
        // The chat is attached to the thread's own session, whose key carries the `:thread:` suffix.
        resolveSession: () => ({ kind: "session", session: child, agentId: "main" }),
      };
    }

    it("finds the thread under its parent with the real lookup, not under the session key it was handed", async () => {
      registerCard();
      const h = harness({ capabilities: CHILD_CONTROLLER });

      const outcome = await handleSlackThreadControlClick(
        click({ actionId: SLACK_THREAD_STOP_ACTION_ID }),
        withChildSession(h),
      );

      expect(outcome).toEqual({ decision: "allowed", code: "ok" });
      expect(h.calls.interrupted).toEqual([CHILD_KEY]);
    });

    it("closes under the parent, so the thread of the card is the one the close is asked of", async () => {
      const h = harness({ capabilities: CHILD_CONTROLLER });

      await handleSlackThreadControlClick(click(), withChildSession(h));

      expect(h.calls.close).toEqual([[PARENT_KEY, CARD_TS]]);
    });

    it("still keeps another session's thread out, from that chat too", async () => {
      registerCard({ parent: "agent:other:main" });
      const h = harness({ capabilities: CHILD_CONTROLLER });

      const outcome = await handleSlackThreadControlClick(
        click({ actionId: SLACK_THREAD_STOP_ACTION_ID }),
        withChildSession(h),
      );

      expect(outcome).toEqual({ decision: "info", code: "thread_not_found" });
      expect(h.calls.interrupted).toEqual([]);
    });
  });

  it("finds a thread older than the newest 500 of its parent, by its root ts", async () => {
    // The lookup asks the table itself: a page of the newest threads, closed ones included, is not where it looks.
    registerCard();
    const child = getOrCreateSession(CHILD_KEY, "main", "/tmp/main", { name: "main-t-card" });
    for (let index = 0; index < 501; index += 1) {
      const ts = `1795300${String(index).padStart(3, "0")}.000100`;
      registerInboundSlackThread({
        requestId: `req-newer-${index}`,
        parentSessionKey: PARENT_KEY,
        parentSessionName: "main",
        childSessionKey: `${PARENT_KEY}:thread:${ts}`,
        childSessionName: `main-t-newer-${index}`,
        accountId: ACCOUNT,
        instanceId: INSTANCE,
        platformChatId: "C0CHAN",
        threadCanonicalChatId: `chat-newer-${index}`,
        providerThreadId: ts,
        seenAt: NOW - index * 1000 - 1,
      });
    }
    const h = harness();

    const outcome = await handleSlackThreadControlClick(click({ actionId: SLACK_THREAD_STOP_ACTION_ID }), h.deps);

    expect(outcome).toEqual({ decision: "allowed", code: "ok" });
    expect(h.calls.interrupted).toEqual([child.sessionKey]);
  });

  it("does not run a click that arrived late, and says so", async () => {
    const h = harness();

    expect(await handleSlackThreadControlClick(click({ receivedAt: NOW - 61_000 }), h.deps)).toEqual({
      decision: "denied",
      code: "stale",
    });
    expect(h.calls.close).toEqual([]);
    expect(text(h.replies[0])).toContain("arrived late");
  });

  it("is not an interaction of ours: returns null and answers nothing", async () => {
    const h = harness();

    expect(await handleSlackThreadControlClick(click({ actionId: "approve:pgr_1" }), h.deps)).toBeNull();
    expect(h.replies).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});

describe("the lookup keeps another parent's threads out, whatever the ref names them (review N1 of #941)", () => {
  const OTHER_PARENT = "agent:other:main";

  it("finds a thread by its child name or key under its own parent, and under no other", () => {
    registerCard({ parent: OTHER_PARENT });

    expect(findSlackThreadForParent(OTHER_PARENT, "main-t-card")?.childSessionName).toBe("main-t-card");
    expect(findSlackThreadForParent(OTHER_PARENT, CHILD_KEY)?.childSessionKey).toBe(CHILD_KEY);
    // The name and the key are unique rows of the table, so only the parent comparison stands between
    // another session's thread and the engine, which interrupts the session the lookup hands it.
    expect(findSlackThreadForParent(PARENT_KEY, "main-t-card")).toBeNull();
    expect(findSlackThreadForParent(PARENT_KEY, CHILD_KEY)).toBeNull();
  });

  it("gives the engine nothing for another parent's thread named by its child, so stop and close cannot reach it", async () => {
    registerCard({ parent: OTHER_PARENT });
    getOrCreateSession(CHILD_KEY, "main", "/tmp/main", { name: "main-t-card" });
    const h = harness();
    const asked = (text: string) =>
      slackCommandChannel(
        {
          accountId: ACCOUNT,
          instanceId: INSTANCE,
          routeAccountId: ACCOUNT,
          channelId: "C0CHAN",
          userId: "U0PERSON",
          text,
          receivedAt: NOW,
          command: "/ravi",
          surface: "command",
        },
        // The real lookup, scoped to the session of this chat.
        { ...h.deps, findThread: undefined },
      );

    expect(asked("stop main-t-card").findThread?.(session(), "main-t-card")).toBeNull();
    for (const ref of ["main-t-card", CHILD_KEY]) {
      const outcome = await runChatCommand(asked(`stop ${ref}`), slackChatCommandDeps(h.deps));
      expect(outcome).toEqual({ decision: "info", code: "thread_not_found" });
    }
    expect(h.calls.interrupted).toEqual([]);
  });
});

describe("the daemon consumer", () => {
  function stream(events: unknown[]) {
    let stopped = false;
    return {
      stopped: () => stopped,
      iterator: {
        async *[Symbol.asyncIterator]() {
          for (const data of events) yield { data };
        },
        return: async () => {
          stopped = true;
          return { done: true, value: undefined };
        },
      },
    };
  }

  it("reads the interaction topic in its own queue group", async () => {
    const subscribed: Array<[string, unknown]> = [];
    const empty = stream([]);
    await startSlackThreadControls(
      {
        subscribe: (topic: string, options?: unknown) => {
          subscribed.push([topic, options]);
          return empty.iterator as never;
        },
      } as never,
      harness().deps,
    );

    expect(subscribed).toEqual([[SLACK_THREAD_CONTROLS_TOPIC, { queue: SLACK_THREAD_CONTROLS_QUEUE_GROUP }]]);
    expect(SLACK_THREAD_CONTROLS_TOPIC).toBe("ravi.inbound.interaction");
    expect(SLACK_THREAD_CONTROLS_QUEUE_GROUP).toBe("ravi-slack-thread-controls");
  });

  it("answers a click once even when Slack delivers the same envelope again", async () => {
    const h = harness();
    const events = stream([click(), click(), click({ envelopeId: "env-2" }), { provider: "slack", type: "x" }]);

    await startSlackThreadControls({ subscribe: () => events.iterator as never } as never, h.deps);
    // Let the loop drain the four events; the consumer is stopped in afterEach.
    for (let attempt = 0; attempt < 50 && h.audits.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(h.calls.close).toHaveLength(2);
    expect(h.audits.map((entry) => entry.requestId)).toEqual(["env-1", "env-2"]);
  });
});
