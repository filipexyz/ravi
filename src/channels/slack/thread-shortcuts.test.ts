import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { CliCommandAccessInput } from "../../cli/command-access.js";
import { getOrCreateSession } from "../../router/index.js";
import type { ContextCapability } from "../../router/router-db.js";
import type { RouterConfig, SessionEntry } from "../../router/types.js";
import type { RuntimeControlResult } from "../../runtime/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { SlackPrivateCard, SlackPrivateCardTarget } from "./private-card.js";
import type { SlackCommandAudit, SlackCommandDeps } from "./slash-command-handler.js";
import { registerInboundSlackThread } from "./thread-lifecycle-store.js";
import {
  buildSlackThreadConfirmCard,
  handleSlackThreadShortcut,
  parseSlackThreadShortcutEvent,
  SLACK_THREAD_CANCEL_ACTION_ID,
  SLACK_THREAD_CLOSE_SHORTCUT_ID,
  SLACK_THREAD_CONFIRM_CLOSE_ACTION_ID,
  SLACK_THREAD_CONFIRM_MAX_AGE_MS,
  SLACK_THREAD_CONFIRM_STOP_ACTION_ID,
  SLACK_THREAD_SHORTCUTS_QUEUE_GROUP,
  SLACK_THREAD_SHORTCUTS_TOPIC,
  SLACK_THREAD_STATUS_SHORTCUT_ID,
  SLACK_THREAD_STOP_SHORTCUT_ID,
  startSlackThreadShortcuts,
  stopSlackThreadShortcuts,
} from "./thread-shortcuts.js";

const NOW = 1_800_000_000_000;
const ACCOUNT = "ravi-slack";
const INSTANCE = "slack-instance";
const CONTACT = "contact-ana";
/** The root of the thread: Slack keeps it as the `thread_ts` of every message in it. */
const ROOT_TS = "1795189835.360089";
/** A reply in that thread, the message a person picks the shortcut on. */
const REPLY_TS = "1795189999.000200";
const PARENT_KEY = "agent:main:main";
const CHILD_KEY = "agent:main:main:thread:1795189835.360089";
const ASKED_AT_SECONDS = Math.floor((NOW - 30_000) / 1000);

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-slack-thread-shortcuts-");
});

afterEach(async () => {
  await stopSlackThreadShortcuts();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function shortcut(overrides: Record<string, unknown> = {}) {
  return {
    provider: "slack",
    source: "slack.socket_mode",
    accountId: ACCOUNT,
    instanceId: INSTANCE,
    routeAccountId: ACCOUNT,
    envelopeId: "env-1",
    interactionType: "message_action",
    callbackId: SLACK_THREAD_STATUS_SHORTCUT_ID,
    teamId: "T0TEAM",
    userId: "U0PERSON",
    channelId: "C0CHAN",
    messageTs: REPLY_TS,
    threadTs: ROOT_TS,
    triggerId: "trigger-1",
    responseUrlId: "handle-1",
    responseUrlPresent: true,
    receivedAt: NOW,
    ...overrides,
  };
}

function confirmation(overrides: Record<string, unknown> = {}) {
  return {
    provider: "slack",
    source: "slack.socket_mode",
    accountId: ACCOUNT,
    instanceId: INSTANCE,
    routeAccountId: ACCOUNT,
    envelopeId: "env-2",
    interactionType: "block_actions",
    teamId: "T0TEAM",
    userId: "U0PERSON",
    channelId: "C0CHAN",
    // The ephemeral card itself, not the thread: the thread is what the button's value carries.
    messageTs: "1795190100.000900",
    actionId: SLACK_THREAD_CONFIRM_CLOSE_ACTION_ID,
    blockId: "ravi_thread_confirm",
    actionType: "button",
    value: `C0CHAN|${ROOT_TS}|${ASKED_AT_SECONDS}`,
    responseUrlId: "handle-2",
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
  /** What went out through the response handle of the interaction. */
  replies: Array<Record<string, unknown>>;
  /** The private cards: where they were sent and what they said. */
  cards: Array<{ target: SlackPrivateCardTarget; card: SlackPrivateCard }>;
  audits: SlackCommandAudit[];
  calls: { close: Array<[string, string]>; interrupted: string[]; access: CliCommandAccessInput[] };
}

/** The real thread store and the real session lookup; only the effects are faked. */
function harness(
  options: { capabilities?: ContextCapability[]; contact?: string | null; cardFails?: boolean } = {},
): Harness {
  const replies: Array<Record<string, unknown>> = [];
  const cards: Harness["cards"] = [];
  const audits: SlackCommandAudit[] = [];
  const calls: Harness["calls"] = { close: [], interrupted: [], access: [] };
  const deps: SlackCommandDeps = {
    now: () => NOW,
    routerConfig: () => ({}) as RouterConfig,
    respond: async ({ payload }) => {
      replies.push(payload);
    },
    deliverPrivate: async (target, card) => {
      if (options.cardFails) throw new Error("Slack did not confirm the private card");
      cards.push({ target, card });
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
    activity: () => ({ busy: false, lastActivityAt: NOW - 12 * 60_000 }),
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
  return { deps, replies, cards, audits, calls };
}

function text(value: { text?: unknown } | undefined): string {
  return String(value?.text ?? "");
}

function registerThread(overrides: { parent?: string } = {}) {
  const child = getOrCreateSession(CHILD_KEY, "main", "/tmp/main", { name: "main-t-card" });
  registerInboundSlackThread({
    requestId: "req-card",
    parentSessionKey: overrides.parent ?? PARENT_KEY,
    parentSessionName: "main",
    childSessionKey: CHILD_KEY,
    childSessionName: "main-t-card",
    accountId: ACCOUNT,
    instanceId: INSTANCE,
    platformChatId: "C0CHAN",
    threadCanonicalChatId: "chat-card",
    providerThreadId: ROOT_TS,
    seenAt: NOW - 3_600_000,
  });
  return child;
}

describe("which interactions are a thread shortcut, a confirmation or a cancellation", () => {
  it("reads the three shortcuts and names the thread by its root, wherever in it the message is", () => {
    const status = parseSlackThreadShortcutEvent(shortcut());
    expect(status).toEqual({
      kind: "shortcut",
      action: "status",
      threadTs: ROOT_TS,
      accountId: ACCOUNT,
      instanceId: INSTANCE,
      routeAccountId: ACCOUNT,
      channelId: "C0CHAN",
      userId: "U0PERSON",
      receivedAt: NOW,
      envelopeId: "env-1",
      responseUrlId: "handle-1",
    });
    expect(parseSlackThreadShortcutEvent(shortcut({ callbackId: SLACK_THREAD_CLOSE_SHORTCUT_ID }))).toMatchObject({
      action: "close",
    });
    expect(parseSlackThreadShortcutEvent(shortcut({ callbackId: SLACK_THREAD_STOP_SHORTCUT_ID }))).toMatchObject({
      action: "stop",
    });
  });

  it("takes the message itself as the root when it starts the thread and has no thread_ts of its own", () => {
    expect(parseSlackThreadShortcutEvent(shortcut({ threadTs: undefined, messageTs: ROOT_TS }))).toMatchObject({
      threadTs: ROOT_TS,
    });
  });

  it("ignores everything else: other shortcuts, other interaction types, other providers, a message with no usable ts", () => {
    const refused = [
      shortcut({ callbackId: "someone_elses_shortcut" }),
      shortcut({ callbackId: undefined }),
      // A global shortcut has no message, and a click is not a shortcut.
      shortcut({ interactionType: "shortcut" }),
      shortcut({ interactionType: "view_submission" }),
      shortcut({ provider: "discord" }),
      shortcut({ source: "other" }),
      shortcut({ threadTs: undefined, messageTs: undefined }),
      // Not a Slack timestamp: nothing here may become another word of the command.
      shortcut({ threadTs: "main-t-1" }),
      shortcut({ threadTs: "1795189835.360089 stop" }),
      shortcut({ userId: "" }),
      shortcut({ channelId: undefined }),
      shortcut({ accountId: undefined }),
      // A tap with no arrival time cannot be held to the freshness window.
      shortcut({ receivedAt: undefined }),
      shortcut({ receivedAt: Number.NaN }),
      null,
      "text",
      [],
    ];
    for (const data of refused) expect(parseSlackThreadShortcutEvent(data)).toBeNull();
  });

  it("reads the confirmation with the thread and the time the card was asked, and a cancellation", () => {
    expect(parseSlackThreadShortcutEvent(confirmation())).toMatchObject({
      kind: "confirm",
      action: "close",
      threadTs: ROOT_TS,
      askedAt: ASKED_AT_SECONDS * 1000,
      userId: "U0PERSON",
      responseUrlId: "handle-2",
    });
    expect(
      parseSlackThreadShortcutEvent(confirmation({ actionId: SLACK_THREAD_CONFIRM_STOP_ACTION_ID })),
    ).toMatchObject({ kind: "confirm", action: "stop" });
    expect(
      parseSlackThreadShortcutEvent(confirmation({ actionId: SLACK_THREAD_CANCEL_ACTION_ID, value: "cancel" })),
    ).toMatchObject({ kind: "cancel", userId: "U0PERSON" });
  });

  it("reads a confirmation only from the chat of its card or from a DM with the app (review N4 of #941)", () => {
    // Same chat as the card: read. A DM with the app, where Slack puts the card when it will not show it in the chat: read.
    expect(parseSlackThreadShortcutEvent(confirmation({ channelId: "C0CHAN" }))).toMatchObject({ kind: "confirm" });
    expect(parseSlackThreadShortcutEvent(confirmation({ channelId: "D0DMAPP" }))).toMatchObject({
      kind: "confirm",
      channelId: "C0CHAN",
    });
    // Any other conversation is not where this card was sent.
    expect(parseSlackThreadShortcutEvent(confirmation({ channelId: "C0OTHER" }))).toBeNull();
    expect(parseSlackThreadShortcutEvent(confirmation({ channelId: "G0GROUPDM" }))).toBeNull();
    // A cancellation changes nothing, so it has no chat to hold.
    expect(
      parseSlackThreadShortcutEvent(
        confirmation({ channelId: "C0OTHER", actionId: SLACK_THREAD_CANCEL_ACTION_ID, value: "cancel" }),
      ),
    ).toMatchObject({ kind: "cancel" });
  });

  it("does not read a confirmation whose value is not a thread and a time, whoever sent it", () => {
    const refused = [
      confirmation({ value: undefined }),
      confirmation({ value: ROOT_TS }),
      confirmation({ value: `C0CHAN||${ASKED_AT_SECONDS}` }),
      confirmation({ value: `C0CHAN|main-t-1|${ASKED_AT_SECONDS}` }),
      // No chat, or a chat that is not a Slack conversation id.
      confirmation({ value: `${ROOT_TS}|${ASKED_AT_SECONDS}` }),
      confirmation({ value: `|${ROOT_TS}|${ASKED_AT_SECONDS}` }),
      confirmation({ value: `c0chan|${ROOT_TS}|${ASKED_AT_SECONDS}` }),
      confirmation({ value: `C0CHAN stop|${ROOT_TS}|${ASKED_AT_SECONDS}` }),
      // Nothing may trail the three parts.
      confirmation({ value: `C0CHAN|${ROOT_TS}|${ASKED_AT_SECONDS}|extra` }),
      // Nothing after the thread may ride along as another word of the command.
      confirmation({ value: `C0CHAN|${ROOT_TS} stop|${ASKED_AT_SECONDS}` }),
      confirmation({ value: `C0CHAN|${ROOT_TS}|soon` }),
      confirmation({ value: `C0CHAN|${ROOT_TS}|12` }),
      confirmation({ receivedAt: undefined }),
      confirmation({ actionId: "approve:pgr_1" }),
      confirmation({ interactionType: "message_action" }),
    ];
    for (const data of refused) expect(parseSlackThreadShortcutEvent(data)).toBeNull();
  });
});

describe("the confirmation card", () => {
  it("asks first, and carries only the thread and the time it was asked", () => {
    const close = buildSlackThreadConfirmCard("close", "C0CHAN", ROOT_TS, NOW);
    const stop = buildSlackThreadConfirmCard("stop", "C0CHAN", ROOT_TS, NOW);

    const buttons = (card: SlackPrivateCard) =>
      (card.blocks.find((block) => block.type === "actions") as { elements: Array<Record<string, unknown>> }).elements;
    expect(buttons(close).map((button) => button.action_id)).toEqual([
      SLACK_THREAD_CONFIRM_CLOSE_ACTION_ID,
      SLACK_THREAD_CANCEL_ACTION_ID,
    ]);
    expect(buttons(stop).map((button) => button.action_id)).toEqual([
      SLACK_THREAD_CONFIRM_STOP_ACTION_ID,
      SLACK_THREAD_CANCEL_ACTION_ID,
    ]);
    expect(buttons(close)[0]?.value).toBe(`C0CHAN|${ROOT_TS}|${Math.floor(NOW / 1000)}`);
    expect(buttons(stop)[0]).toMatchObject({
      style: "danger",
      value: `C0CHAN|${ROOT_TS}|${Math.floor(NOW / 1000)}`,
    });
    expect(buttons(close)[0]).not.toHaveProperty("style");
    expect(close.text).toBe("Fechar esta thread?");
    expect(stop.text).toBe("Parar o turno em andamento?");
    // The card says what it will do, and a person is never named on it.
    expect(JSON.stringify(close.blocks)).not.toContain("U0PERSON");
  });
});

describe("a shortcut becomes the same command, with the authority of the person who picked it", () => {
  it("status answers privately in the thread, with that thread's state, and runs nothing that changes", async () => {
    registerThread();
    const h = harness({ capabilities: READER });

    const result = await handleSlackThreadShortcut(shortcut(), h.deps);

    expect(result).toEqual({ kind: "ran", outcome: { decision: "allowed", code: "ok" } });
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]?.target).toEqual({
      accountId: ACCOUNT,
      chatId: "C0CHAN",
      userId: "U0PERSON",
      threadTs: ROOT_TS,
    });
    expect(text(h.cards[0]?.card)).toContain("*Thread* `main-t-card`");
    expect(text(h.cards[0]?.card)).toContain("*Last activity*: 12 min ago");
    // The answer is the private card in the thread, not a post at channel level.
    expect(h.replies).toEqual([]);
    // A read: the capability of the CLI is not asked, and nothing is closed or interrupted.
    expect(h.calls.access).toEqual([]);
    expect(h.calls.close).toEqual([]);
    expect(h.calls.interrupted).toEqual([]);
    expect(h.audits).toMatchObject([
      {
        type: "chat_command",
        channel: "slack",
        surface: "shortcut",
        chatId: "C0CHAN",
        actorId: "U0PERSON",
        contactId: CONTACT,
        subcommand: "status",
        decision: "allowed",
        requestId: "env-1",
      },
    ]);
  });

  it("status answers with the response handle, to the same person, when the private card could not be sent", async () => {
    registerThread();
    const h = harness({ cardFails: true });

    const result = await handleSlackThreadShortcut(shortcut(), h.deps);

    expect(result).toEqual({ kind: "ran", outcome: { decision: "allowed", code: "ok" } });
    expect(h.cards).toEqual([]);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]?.response_type).toBe("ephemeral");
    expect(text(h.replies[0])).toContain("*Thread* `main-t-card`");
  });

  it("status refuses a Slack user nobody linked to a contact, and says so privately", async () => {
    const h = harness({ contact: null });

    expect(await handleSlackThreadShortcut(shortcut(), h.deps)).toEqual({
      kind: "ran",
      outcome: { decision: "denied", code: "unknown_user" },
    });
    expect(text(h.cards[0]?.card)).toContain("I don't recognize you");
  });

  it("status of a message in a thread of another chat's session finds nothing", async () => {
    registerThread({ parent: "agent:other:main" });
    const h = harness();

    expect(await handleSlackThreadShortcut(shortcut(), h.deps)).toEqual({
      kind: "ran",
      outcome: { decision: "info", code: "thread_not_found" },
    });
    expect(text(h.cards[0]?.card)).toContain("I could not find thread");
  });

  it("close and stop only ask: a private card in the thread, and nothing has changed yet", async () => {
    for (const [callbackId, action] of [
      [SLACK_THREAD_CLOSE_SHORTCUT_ID, "close"],
      [SLACK_THREAD_STOP_SHORTCUT_ID, "stop"],
    ] as const) {
      const h = harness();

      const result = await handleSlackThreadShortcut(shortcut({ callbackId }), h.deps);

      expect(result).toEqual({ kind: "card_sent" });
      expect(h.cards).toHaveLength(1);
      expect(h.cards[0]?.target).toEqual({
        accountId: ACCOUNT,
        chatId: "C0CHAN",
        userId: "U0PERSON",
        threadTs: ROOT_TS,
      });
      expect(h.cards[0]?.card).toEqual(buildSlackThreadConfirmCard(action, "C0CHAN", ROOT_TS, NOW));
      expect(h.calls.close).toEqual([]);
      expect(h.calls.interrupted).toEqual([]);
      expect(h.audits).toEqual([]);
    }
  });

  it("does not ask for a shortcut that arrived long after it was picked", async () => {
    const h = harness();

    expect(
      await handleSlackThreadShortcut(
        shortcut({ callbackId: SLACK_THREAD_CLOSE_SHORTCUT_ID, receivedAt: NOW - 61_000 }),
        h.deps,
      ),
    ).toEqual({ kind: "stale" });
    expect(h.cards).toEqual([]);
  });

  it("asks on the response handle, to the same person, when the confirmation card could not be sent", async () => {
    const h = harness({ cardFails: true });

    expect(await handleSlackThreadShortcut(shortcut({ callbackId: SLACK_THREAD_STOP_SHORTCUT_ID }), h.deps)).toEqual({
      kind: "card_sent",
    });
    expect(h.cards).toEqual([]);
    expect(h.replies).toEqual([
      {
        response_type: "ephemeral",
        text: "Parar o turno em andamento?",
        blocks: buildSlackThreadConfirmCard("stop", "C0CHAN", ROOT_TS, NOW).blocks,
      },
    ]);
    // Still only a question: nothing was interrupted.
    expect(h.calls.interrupted).toEqual([]);
  });

  it("says nothing was asked when neither the card nor the response handle could be used", async () => {
    const h = harness({ cardFails: true });

    expect(
      await handleSlackThreadShortcut(
        shortcut({ callbackId: SLACK_THREAD_STOP_SHORTCUT_ID, responseUrlId: undefined }),
        h.deps,
      ),
    ).toEqual({ kind: "card_not_sent" });

    const refused: SlackCommandDeps = {
      ...h.deps,
      respond: async () => {
        throw new Error("Slack refused the handle");
      },
    };
    expect(await handleSlackThreadShortcut(shortcut({ callbackId: SLACK_THREAD_STOP_SHORTCUT_ID }), refused)).toEqual({
      kind: "card_not_sent",
    });
    expect(h.calls.interrupted).toEqual([]);
  });

  it("is not an interaction of ours: returns null and answers nothing", async () => {
    const h = harness();

    expect(await handleSlackThreadShortcut(shortcut({ callbackId: "other" }), h.deps)).toBeNull();
    expect(await handleSlackThreadShortcut(confirmation({ actionId: "approve:pgr_1" }), h.deps)).toBeNull();
    expect(h.cards).toEqual([]);
    expect(h.replies).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});

describe("a confirmation runs the command, and the card becomes its answer", () => {
  it("Fechar closes the thread named on the card and replaces the card with what it came to", async () => {
    const h = harness();

    const result = await handleSlackThreadShortcut(confirmation(), h.deps);

    expect(result).toEqual({ kind: "ran", outcome: { decision: "allowed", code: "ok" } });
    expect(h.calls.close).toEqual([[PARENT_KEY, ROOT_TS]]);
    expect(h.calls.access).toMatchObject([
      {
        source: "channel-command",
        subject: { type: "contact", id: CONTACT },
        group: "sessions",
        command: "close-thread",
      },
    ]);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]).toMatchObject({ response_type: "ephemeral", replace_original: true });
    expect(text(h.replies[0])).toContain("Closed thread `main-t-card`");
    expect(h.cards).toEqual([]);
    expect(h.audits).toMatchObject([
      {
        surface: "shortcut",
        subcommand: "close",
        actorId: "U0PERSON",
        contactId: CONTACT,
        decision: "allowed",
        requestId: "env-2",
      },
    ]);
  });

  it("Parar interrupts the turn of the thread's own session", async () => {
    const child = registerThread();
    const h = harness();

    const result = await handleSlackThreadShortcut(
      confirmation({ actionId: SLACK_THREAD_CONFIRM_STOP_ACTION_ID }),
      h.deps,
    );

    expect(result).toEqual({ kind: "ran", outcome: { decision: "allowed", code: "ok" } });
    expect(h.calls.interrupted).toEqual([child.sessionKey]);
    expect(h.replies[0]).toMatchObject({ replace_original: true });
    expect(text(h.replies[0])).toContain("Interrupted the turn running in `main-t-card`");
    expect(h.audits).toMatchObject([{ surface: "shortcut", subcommand: "stop" }]);
  });

  it("reads the authority at the confirmation: a reader who taps Fechar is refused, and nothing runs", async () => {
    registerThread();
    const h = harness({ capabilities: READER });

    expect(await handleSlackThreadShortcut(confirmation(), h.deps)).toEqual({
      kind: "ran",
      outcome: { decision: "denied", code: "not_authorized_modify" },
    });
    expect(h.calls.close).toEqual([]);
    expect(text(h.replies[0])).toContain("You are not allowed to change session `main`");
    expect(h.replies[0]).toMatchObject({ replace_original: true });
  });

  it("refuses a Slack user nobody linked to a contact, and runs nothing", async () => {
    const h = harness({ contact: null });

    expect(await handleSlackThreadShortcut(confirmation(), h.deps)).toEqual({
      kind: "ran",
      outcome: { decision: "denied", code: "unknown_user" },
    });
    expect(h.calls.close).toEqual([]);
  });

  it("runs in the chat the card was asked in when Slack put the card in the person's DM", async () => {
    // The click comes from the DM with the app; the command still belongs to the channel it was asked in.
    registerThread();
    const h = harness();
    const resolved: string[] = [];
    const deps: SlackCommandDeps = {
      ...h.deps,
      resolveSession: (where) => {
        resolved.push(where.channelId);
        return { kind: "session", session: session(), agentId: "main" };
      },
    };

    const result = await handleSlackThreadShortcut(
      confirmation({ channelId: "D0DMAPP", actionId: SLACK_THREAD_CONFIRM_STOP_ACTION_ID }),
      deps,
    );

    expect(result).toMatchObject({ kind: "ran", outcome: { decision: "allowed" } });
    expect(resolved).toEqual(["C0CHAN"]);
    expect(h.audits).toMatchObject([{ chatId: "C0CHAN", actorId: "U0PERSON", surface: "shortcut" }]);
    // The person is still the one who clicked.
    expect(h.calls.interrupted).toHaveLength(1);
  });

  it("does not let a card name a thread of another chat's session", async () => {
    registerThread({ parent: "agent:other:main" });
    const h = harness();

    expect(
      await handleSlackThreadShortcut(confirmation({ actionId: SLACK_THREAD_CONFIRM_STOP_ACTION_ID }), h.deps),
    ).toEqual({ kind: "ran", outcome: { decision: "info", code: "thread_not_found" } });
    expect(h.calls.interrupted).toEqual([]);
  });

  it("does not run a confirmation that arrived late, and says so on the card", async () => {
    const h = harness();

    expect(await handleSlackThreadShortcut(confirmation({ receivedAt: NOW - 61_000 }), h.deps)).toEqual({
      kind: "ran",
      outcome: { decision: "denied", code: "stale" },
    });
    expect(h.calls.close).toEqual([]);
    expect(text(h.replies[0])).toContain("arrived late");
  });

  it("does not run a confirmation asked more than ten minutes ago, and says so on the card", async () => {
    const h = harness();
    const asked = (ageMs: number) => `C0CHAN|${ROOT_TS}|${Math.floor((NOW - ageMs) / 1000)}`;

    expect(
      await handleSlackThreadShortcut(confirmation({ value: asked(SLACK_THREAD_CONFIRM_MAX_AGE_MS + 5_000) }), h.deps),
    ).toEqual({ kind: "expired" });
    expect(h.calls.close).toEqual([]);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]).toMatchObject({ response_type: "ephemeral", replace_original: true });
    expect(text(h.replies[0])).toContain("expirou");
    expect(h.audits).toEqual([]);

    // Inside the window it still runs.
    expect(
      await handleSlackThreadShortcut(confirmation({ value: asked(SLACK_THREAD_CONFIRM_MAX_AGE_MS - 5_000) }), h.deps),
    ).toMatchObject({ kind: "ran" });
    expect(h.calls.close).toEqual([[PARENT_KEY, ROOT_TS]]);
  });

  it("holds the card's age again when the command is about to run, not only when the tap arrived", async () => {
    // The tap arrived inside the window, and the daemon got to it half a minute later: the card is now past ten minutes.
    const h = harness();
    const late: SlackCommandDeps = { ...h.deps, now: () => NOW + 30_000 };
    const askedSecondsAgo = (SLACK_THREAD_CONFIRM_MAX_AGE_MS - 5_000) / 1000;

    expect(
      await handleSlackThreadShortcut(
        confirmation({ value: `C0CHAN|${ROOT_TS}|${Math.floor(NOW / 1000) - askedSecondsAgo}` }),
        late,
      ),
    ).toEqual({ kind: "expired" });
    expect(h.calls.close).toEqual([]);
    expect(text(h.replies[0])).toContain("expirou");
  });

  it("does not trust a card asked in the future either", async () => {
    const h = harness();

    expect(
      await handleSlackThreadShortcut(
        confirmation({ value: `C0CHAN|${ROOT_TS}|${Math.floor((NOW + 120_000) / 1000)}` }),
        h.deps,
      ),
    ).toEqual({ kind: "expired" });
    expect(h.calls.close).toEqual([]);
  });

  it("Cancelar replaces the card and runs nothing", async () => {
    const h = harness();

    const result = await handleSlackThreadShortcut(
      confirmation({ actionId: SLACK_THREAD_CANCEL_ACTION_ID, value: "cancel" }),
      h.deps,
    );

    expect(result).toEqual({ kind: "cancelled" });
    expect(h.replies).toEqual([{ response_type: "ephemeral", replace_original: true, text: "Cancelado." }]);
    expect(h.calls.close).toEqual([]);
    expect(h.calls.interrupted).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});

describe("the daemon consumer", () => {
  function stream(events: unknown[]) {
    return {
      iterator: {
        async *[Symbol.asyncIterator]() {
          for (const data of events) yield { data };
        },
        return: async () => ({ done: true, value: undefined }),
      },
    };
  }

  it("reads the interaction topic in its own queue group", async () => {
    const subscribed: Array<[string, unknown]> = [];
    await startSlackThreadShortcuts(
      {
        subscribe: (topic: string, options?: unknown) => {
          subscribed.push([topic, options]);
          return stream([]).iterator as never;
        },
      } as never,
      harness().deps,
    );

    expect(subscribed).toEqual([[SLACK_THREAD_SHORTCUTS_TOPIC, { queue: SLACK_THREAD_SHORTCUTS_QUEUE_GROUP }]]);
    expect(SLACK_THREAD_SHORTCUTS_TOPIC).toBe("ravi.inbound.interaction");
    expect(SLACK_THREAD_SHORTCUTS_QUEUE_GROUP).toBe("ravi-slack-thread-shortcuts");
  });

  it("answers a tap once even when Slack delivers the same envelope again, and skips what is not ours", async () => {
    const h = harness();
    const events = stream([
      confirmation(),
      confirmation(),
      confirmation({ envelopeId: "env-3" }),
      { provider: "slack", type: "x" },
      shortcut({ callbackId: "other" }),
    ]);

    await startSlackThreadShortcuts({ subscribe: () => events.iterator as never } as never, h.deps);
    for (let attempt = 0; attempt < 50 && h.audits.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(h.calls.close).toHaveLength(2);
    expect(h.audits.map((entry) => entry.requestId)).toEqual(["env-2", "env-3"]);
  });
});
