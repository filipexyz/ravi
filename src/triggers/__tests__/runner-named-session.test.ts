import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbCreateAgent, dbUpsertInstance } from "../../router/router-db.js";
import { buildSessionKey } from "../../router/session-key.js";
import { deleteSession, getOrCreateSession, listSessions, updateSessionSource } from "../../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { WatchRecord } from "../../watch/types.js";
import type { SessionTarget, TriggerInput } from "../types.js";

afterAll(() => mock.restore());

type BusEvent = { topic: string; data: unknown };

interface TopicChannel {
  push(event: BusEvent): void;
  close(): void;
}

const channels = new Map<string, TopicChannel>();
const subscribedTopics: string[] = [];
const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

function createTopicStream(topic: string): AsyncIterableIterator<BusEvent> {
  const queue: BusEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  channels.set(topic, {
    push(event) {
      queue.push(event);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
  });
  const stream: AsyncIterableIterator<BusEvent> = {
    async next() {
      while (!closed && queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const value = queue.shift();
      return value ? { value, done: false } : { value: undefined, done: true };
    },
    async return() {
      closed = true;
      notify();
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() {
      return stream;
    },
  };
  return stream;
}

const actualNatsModule = await import("../../nats.js");
const actualSessionStreamModule = await import("../../omni/session-stream.js");

mock.module("../../nats.js", () => ({
  ...actualNatsModule,
  publish: mock(async () => {}),
  nats: {
    emit: mock(async () => {}),
    subscribe: mock((topic: string) => {
      subscribedTopics.push(topic);
      return createTopicStream(topic);
    }),
    close: mock(async () => {}),
  },
}));

mock.module("../../omni/session-stream.js", () => ({
  ...actualSessionStreamModule,
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    publishCalls.push({ sessionName, payload });
  }),
}));

const { TriggerRunner } = await import("../runner.js");
const { dbCreateTrigger, dbGetTrigger, dbUpdateTrigger } = await import("../triggers-db.js");

let stateDir: string | null = null;
let markerDir: string | null = null;
let runner: InstanceType<typeof TriggerRunner> | null = null;

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function emit(topic: string, data: unknown): void {
  const channel = channels.get(topic);
  if (!channel) throw new Error(`Runner is not subscribed to ${topic}`);
  channel.push({ topic, data });
}

function createTrigger(input: { name: string; topic: string; session: SessionTarget; cooldownMs?: number }) {
  return dbCreateTrigger({
    name: input.name,
    agentId: "trigger-test-agent",
    topic: input.topic,
    message: `agent prompt for ${input.name}`,
    session: input.session,
    cooldownMs: input.cooldownMs ?? 0,
  });
}

async function startRunner(): Promise<InstanceType<typeof TriggerRunner>> {
  runner = new TriggerRunner();
  await runner.start();
  return runner;
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-trigger-runner-named-test-");
  dbCreateAgent({ id: "trigger-test-agent", cwd: "/tmp/trigger-test-agent-real" });
  markerDir = mkdtempSync(join(tmpdir(), "ravi-trigger-shell-marker-"));
  channels.clear();
  subscribedTopics.length = 0;
  publishCalls.length = 0;
});

afterEach(async () => {
  await runner?.stop();
  runner = null;
  for (const channel of channels.values()) channel.close();
  channels.clear();
  if (markerDir) rmSync(markerDir, { recursive: true, force: true });
  markerDir = null;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("thread follow handoff delivery", () => {
  it.each(["after publication", "during publication"])(
    "delivers API-published CI to the parent after child closure and pruning %s",
    async (timing) => {
      const { publishGhPr, verifyPublicationFollow } = await import("../../hooks/gh-pr-publish.js");
      const { handOffClosingThreadFollows } = await import("../follow-owner.js");
      const { registerInboundSlackThread, closeSlackThreadLifecycle, getSlackThreadLifecycle } = await import(
        "../../channels/slack/thread-lifecycle-store.js"
      );
      const parent = getOrCreateSession("api-parent", "trigger-test-agent", "/tmp/trigger-test-agent-real", {
        name: "api-parent",
      });
      const child = getOrCreateSession("api-parent:thread:1.2", "trigger-test-agent", "/tmp/trigger-test-agent-real", {
        name: "api-child",
      });
      const source = { channel: "slack", accountId: "slack-account", chatId: "C123" };
      updateSessionSource(parent.sessionKey, source);
      const record = registerInboundSlackThread({
        parentSessionKey: parent.sessionKey,
        parentSessionName: parent.name!,
        childSessionKey: child.sessionKey,
        childSessionName: child.name!,
        accountId: source.accountId,
        instanceId: "slack-instance",
        platformChatId: source.chatId,
        threadCanonicalChatId: "api-thread-chat",
        providerThreadId: "1.2",
      });
      const closeAndPrune = () => {
        expect(closeSlackThreadLifecycle({ childSessionKey: child.sessionKey }).changed).toBe(true);
        expect(deleteSession(child.sessionKey)).toBe(true);
      };
      const pr = {
        number: 9,
        node_id: "PR_9",
        html_url: "https://github.com/o/r/pull/9",
        state: "open",
        draft: false,
        head: { ref: "fix/publish", sha: "a".repeat(40), repo: { full_name: "o/r" } },
        base: { ref: "dev", repo: { full_name: "o/r" } },
      };
      const watches: WatchRecord[] = [];
      const result = await publishGhPr(
        {
          repo: "o/r",
          head: pr.head.ref,
          base: pr.base.ref,
          sha: pr.head.sha,
          title: "Fix",
          body: "Fix follow",
          context: {
            agentId: "trigger-test-agent",
            sessionName: child.name!,
            sessionKey: child.sessionKey,
            source: { ...source, threadId: "1.2" },
          },
        },
        {
          request: (endpoint, method) => {
            if (endpoint.includes("/git/ref/")) return { object: { sha: pr.head.sha } };
            if (endpoint.includes("/pulls?")) return [];
            if (endpoint === "repos/o/r/pulls" && method === "POST") {
              if (timing === "during publication") closeAndPrune();
              return pr;
            }
            if (endpoint === "repos/o/r/pulls/9" && method === "GET") return pr;
            throw new Error(`Unexpected publication request: ${method} ${endpoint}`);
          },
          follow: {
            listWatches: () => ({ items: watches }) as never,
            createWatch: async (input) => {
              const watch = { ...input, id: `api-${input.placement ?? "console"}`, status: "active" } as WatchRecord;
              watches.push(watch);
              return { watch, createdRemote: false };
            },
            emitTriggersRefresh: async () => {},
          },
          verifyFollow: (input, follow, number) =>
            verifyPublicationFollow(input, follow, number, {
              watch: (id) => watches.find((watch) => watch.id === id) ?? null,
              runtime: async () => {}, // Transport is mocked; actual TriggerRunner delivery is asserted below.
            }),
        },
      );
      expect(result.ready).toBe(true);
      let trigger = dbGetTrigger(result.follow.triggerId!)!;
      if (timing === "after publication") {
        // The open thread that published owns the follow, in that thread. Closing it hands the follow to the parent.
        expect(trigger).toMatchObject({
          replySession: "api-child",
          replySource: { ...source, threadId: "1.2" },
          enabled: true,
        });
        expect(() => closeSlackThreadLifecycle({ childSessionKey: child.sessionKey })).toThrow(
          "Thread still receives active triggers",
        );
        expect(
          handOffClosingThreadFollows({ childSessionKey: child.sessionKey, childSessionName: child.name! }),
        ).toEqual([trigger.id]);
        closeAndPrune();
        trigger = dbGetTrigger(trigger.id)!;
      }
      // A thread that closed during the publication never owned the follow: it was registered on the parent.
      expect(trigger).toMatchObject({ replySession: "api-parent", replySource: source, enabled: true });
      expect(trigger.replySource?.threadId).toBeUndefined();
      await startRunner();
      emit(trigger.topic, { payload: { repository: "o/r", number: 9, conclusion: "success" } });
      await waitFor(() => publishCalls.length === 1);
      expect(publishCalls[0]).toMatchObject({
        sessionName: "api-parent",
        payload: { source, _triggerId: trigger.id },
      });
      expect(dbGetTrigger(trigger.id)?.fireCount).toBe(1);
      expect(getSlackThreadLifecycle(record.requestId)?.status).toBe("closed");
      expect(listSessions().some((session) => session.sessionKey === child.sessionKey)).toBe(false);
    },
  );

  it("delivers a child-owned follow into the child's own thread, not the channel root", async () => {
    const { registerInboundSlackThread } = await import("../../channels/slack/thread-lifecycle-store.js");
    const parent = getOrCreateSession("parent-key", "trigger-test-agent", "/tmp/trigger-test-agent-real", {
      name: "parent",
    });
    const child = getOrCreateSession("parent-key:thread:1.2", "trigger-test-agent", "/tmp/trigger-test-agent-real", {
      name: "child",
    });
    // A programmatic child remembers the channel root as its last chat, and the thread's timestamp apart from it.
    updateSessionSource(child.sessionKey, { channel: "slack", accountId: "slack-account", chatId: "C123" });
    registerInboundSlackThread({
      parentSessionKey: parent.sessionKey,
      parentSessionName: parent.name!,
      childSessionKey: child.sessionKey,
      childSessionName: child.name!,
      accountId: "slack-account",
      instanceId: "slack-instance",
      platformChatId: "C123",
      threadCanonicalChatId: "thread-chat",
      providerThreadId: "1.2",
    });
    const topic = "ravi.watch.github.ci";
    const base = { topic, session: "main", agentId: "trigger-test-agent", replySession: "child", cooldownMs: 0 };
    const follow = dbCreateTrigger({
      ...base,
      name: "gh-follow:o/r#7",
      message: "CI completed",
      replySource: { channel: "slack", accountId: "slack-account", chatId: "C123", threadId: "1.2" },
    });
    const plain = dbCreateTrigger({
      ...base,
      name: "custom-review",
      message: "plain",
      replySource: { channel: "slack", accountId: "slack-account", chatId: "C123" },
    });
    await startRunner();
    emit(topic, { payload: { repository: "o/r", number: 7, conclusion: "success" } });
    await waitFor(() => publishCalls.length === 2);

    const sourceOf = (triggerId: string) =>
      publishCalls.find((call) => (call.payload as { _triggerId?: string })._triggerId === triggerId)?.payload.source;
    // The thread's chat, canonical id and timestamp: the address `thread-send` uses, which a reply can be matched to.
    expect(sourceOf(follow.id)).toEqual({
      channel: "slack",
      accountId: "slack-account",
      instanceId: "slack-instance",
      chatId: "C123",
      canonicalChatId: "thread-chat",
      threadId: "1.2",
    });
    // A trigger that did not ask for a thread keeps the session's last chat.
    expect(sourceOf(plain.id)).toEqual({ channel: "slack", accountId: "slack-account", chatId: "C123" });
    expect(publishCalls.every((call) => call.sessionName === "child")).toBe(true);
  });

  it("refuses close, then delivers a CI event to the parent after repoint and close", async () => {
    const { registerInboundSlackThread, closeSlackThreadLifecycle, getSlackThreadLifecycle } = await import(
      "../../channels/slack/thread-lifecycle-store.js"
    );
    const parent = getOrCreateSession("parent-key", "trigger-test-agent", "/tmp/trigger-test-agent-real", {
      name: "parent",
    });
    const child = getOrCreateSession("parent-key:thread:1.2", "trigger-test-agent", "/tmp/trigger-test-agent-real", {
      name: "child",
    });
    updateSessionSource(parent.sessionKey, { channel: "slack", accountId: "slack-account", chatId: "C123" });
    const record = registerInboundSlackThread({
      parentSessionKey: parent.sessionKey,
      parentSessionName: parent.name!,
      childSessionKey: child.sessionKey,
      childSessionName: child.name!,
      accountId: "slack-account",
      instanceId: "slack-instance",
      platformChatId: "C123",
      threadCanonicalChatId: "thread-chat",
      providerThreadId: "1.2",
    });
    const topic = "ravi.watch.github.ci";
    const trigger = dbCreateTrigger({
      name: "gh-follow:o/r#7",
      topic,
      message: "CI completed",
      session: "main",
      agentId: "trigger-test-agent",
      replySession: "child",
      cooldownMs: 0,
    });
    await startRunner();
    expect(() => closeSlackThreadLifecycle({ childSessionKey: child.sessionKey })).toThrow(
      "Thread still receives active triggers",
    );
    dbUpdateTrigger(trigger.id, { replySession: "parent" });
    // The CLI emits this after triggers set; exercise the live reload too.
    emit("ravi.triggers.refresh", {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    closeSlackThreadLifecycle({ childSessionKey: child.sessionKey });
    emit(topic, { payload: { repository: "o/r", number: 7, conclusion: "success" } });
    await waitFor(() => publishCalls.length === 1);
    expect(publishCalls[0]).toMatchObject({
      sessionName: "parent",
      payload: { source: { channel: "slack", accountId: "slack-account", chatId: "C123" }, _triggerId: trigger.id },
    });
    expect(dbGetTrigger(trigger.id)?.fireCount).toBe(1);
    expect(getSlackThreadLifecycle(record.requestId)?.status).toBe("closed");
  });
});

describe("reply account follows the destination", () => {
  const topic = "ravi.watch.console.page.comment.created";
  const comment = { payload: { routePath: "/blog/post", body: "looks good", url: "https://x.ravi.page/blog/post" } };
  const whatsappDm = { channel: "whatsapp", accountId: "wa-main", chatId: "5511999990000@s.whatsapp.net" };

  beforeEach(() => {
    // The channel an account delivers on is its instance's.
    dbUpsertInstance({ name: "slack-account", channel: "slack" });
    dbUpsertInstance({ name: "slack-other", channel: "slack" });
    dbUpsertInstance({ name: "wa-main", channel: "whatsapp" });
    dbUpsertInstance({ name: "wa-explicit", channel: "whatsapp" });
    dbUpsertInstance({ name: "main", channel: "whatsapp" });
  });

  // What a follow armed from a Slack thread stores once it belongs to the thread's
  // durable parent: the thread's account, and the Slack root chat as frozen source.
  const handedOffFollow = (overrides: Partial<TriggerInput> = {}) =>
    dbCreateTrigger({
      name: "page-comment:site:/blog/post",
      topic,
      message: "A comment was added on {{data.payload.routePath}}: {{data.payload.body}}",
      session: "main",
      agentId: "trigger-test-agent",
      accountId: "slack-account",
      replySession: "parent",
      replySource: { channel: "slack", accountId: "slack-account", chatId: "C123" },
      cooldownMs: 0,
      ...overrides,
    });

  const parentLastTalkedOn = (source: { channel: string; accountId: string; chatId: string }) => {
    const parent = getOrCreateSession("parent-key", "trigger-test-agent", "/tmp/trigger-test-agent-real", {
      name: "parent",
    });
    updateSessionSource(parent.sessionKey, source);
  };

  async function fireComment(): Promise<{ sessionName: string; payload: Record<string, unknown> }> {
    await startRunner();
    emit(topic, comment);
    await waitFor(() => publishCalls.length === 1);
    return publishCalls[0]!;
  }

  it("delivers a follow handed to a parent that last talked on another channel through that channel's own account", async () => {
    parentLastTalkedOn(whatsappDm);
    const trigger = handedOffFollow();

    const fired = await fireComment();

    expect(fired).toMatchObject({ sessionName: "parent", payload: { _triggerId: trigger.id } });
    // The channel and chat are the parent's WhatsApp conversation: the account is
    // too, never the Slack thread's account on a WhatsApp chat.
    expect(fired.payload.source).toEqual(whatsappDm);
    expect(dbGetTrigger(trigger.id)?.fireCount).toBe(1);
  });

  it("keeps the parent's own account when it last talked on the same channel through another account", async () => {
    // Two Slack workspaces: the chat belongs to the account the parent reached it through.
    parentLastTalkedOn({ channel: "slack", accountId: "slack-other", chatId: "C999" });
    handedOffFollow();

    const fired = await fireComment();

    expect(fired.payload.source).toEqual({ channel: "slack", accountId: "slack-other", chatId: "C999" });
  });

  it("uses the account the follow took from its source when the parent carries none", async () => {
    parentLastTalkedOn({ channel: "slack", accountId: "", chatId: "C999" });
    handedOffFollow();

    const fired = await fireComment();

    expect(fired.payload.source).toEqual({ channel: "slack", accountId: "slack-account", chatId: "C999" });
  });

  it("applies an account set on its own on the channel it belongs to", async () => {
    parentLastTalkedOn(whatsappDm);
    // `--account` is not the frozen source's account: it is asked for, so it replaces the parent's.
    handedOffFollow({ accountId: "wa-explicit" });

    const fired = await fireComment();

    expect(fired.payload.source).toEqual({ ...whatsappDm, accountId: "wa-explicit" });
  });

  it("reads the Omni name of a channel as the channel", async () => {
    // Sessions record `whatsapp-baileys`; the instance of the account is `whatsapp`.
    const omniDm = { ...whatsappDm, channel: "whatsapp-baileys" };
    parentLastTalkedOn(omniDm);
    handedOffFollow({ accountId: "wa-explicit" });

    const fired = await fireComment();

    expect(fired.payload.source).toEqual({ ...omniDm, accountId: "wa-explicit" });
  });

  it("does not send an account set on its own to a destination on another channel", async () => {
    // The shape of three triggers of the main session: `main` is a WhatsApp instance, the
    // session they reply in last talked on Slack, and the reply was lost on a Slack chat.
    const slackDm = { channel: "slack", accountId: "slack-account", chatId: "D0C8BEV8QUR" };
    parentLastTalkedOn(slackDm);
    const trigger = handedOffFollow({ accountId: "main", replySource: undefined });

    const fired = await fireComment();

    expect(fired.payload.source).toEqual(slackDm);
    expect(dbGetTrigger(trigger.id)?.fireCount).toBe(1);
  });

  it("keeps the account of a source rebuilt from the session key when the trigger's account is for another channel", async () => {
    // The reply session is gone, so the destination is derived from its key.
    const key = buildSessionKey({
      agentId: "trigger-test-agent",
      channel: "whatsapp",
      accountId: "wa-main",
      peerKind: "dm",
      peerId: "5511999990000",
      dmScope: "per-account-channel-peer",
    });
    handedOffFollow({ replySession: key });

    const fired = await fireComment();

    expect(fired.payload.source).toEqual({ channel: "whatsapp", accountId: "wa-main", chatId: "5511999990000" });
  });

  it("keeps the frozen source's account when an account set on its own is another channel's", async () => {
    // No reply session: the creator's chat is the destination, and `wa-explicit` is no Slack credential.
    handedOffFollow({ replySession: undefined, accountId: "wa-explicit" });

    const fired = await fireComment();

    expect(fired.payload.source).toEqual({ channel: "slack", accountId: "slack-account", chatId: "C123" });
  });
});

describe("TriggerRunner named sessions", () => {
  const topic = "ravi.console.inbox.item";
  const commentEvent = (rowId: string, topicId: string | null) => ({
    eventType: "bases.row.created",
    payload: { rowId, row: { rowId, values: topicId === null ? {} : { topic_id: [topicId] } } },
  });

  it("runs every event in the persistent session of its resolved key, one session per key", async () => {
    const trigger = createTrigger({
      name: "forum",
      topic,
      session: "issue-{{data.payload.row.values.topic_id.0}}",
    });
    await startRunner();

    emit(topic, commentEvent("c1", "topic-a"));
    emit(topic, commentEvent("c2", "topic-b"));
    emit(topic, commentEvent("c3", "topic-a"));
    await waitFor(() => publishCalls.length >= 3);

    const [first, second, third] = publishCalls.map((call) => call.sessionName);
    expect(first).toBe(third!);
    expect(first).not.toBe(second!);
    expect(first).toBe("issue-topic-a");
    expect(second).toBe("issue-topic-b");
    const keyed = listSessions().filter((session) =>
      session.sessionKey.startsWith(`agent:trigger-test-agent:trigger:${trigger.id}:key:`),
    );
    expect(keyed).toHaveLength(2);
  });

  it("skips an event whose key does not resolve instead of using a shared session", async () => {
    const trigger = createTrigger({
      name: "forum-skip",
      topic,
      session: "issue-{{data.payload.row.values.topic_id.0}}",
      // Unresolved events must not consume the cooldown of later ones.
      cooldownMs: 60_000,
    });
    await startRunner();

    emit(topic, commentEvent("c1", null));
    emit(topic, commentEvent("c2", "topic-a"));
    await waitFor(() => publishCalls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]!.sessionName).toContain("issue-topic-a");
    expect(dbGetTrigger(trigger.id)?.fireCount).toBe(1);
  });

  it("applies the cooldown per key, so a busy key does not swallow other keys' events", async () => {
    createTrigger({
      name: "forum-cooldown",
      topic,
      session: "issue-{{data.payload.row.values.topic_id.0}}",
      cooldownMs: 60_000,
    });
    await startRunner();

    emit(topic, commentEvent("c1", "topic-a"));
    emit(topic, commentEvent("c2", "topic-a"));
    emit(topic, commentEvent("c3", "topic-b"));
    await waitFor(() => publishCalls.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(publishCalls.map((call) => call.sessionName)).toEqual([
      expect.stringContaining("issue-topic-a"),
      expect.stringContaining("issue-topic-b"),
    ]);
  });

  it("reuses an existing session by name and replies where it last talked", async () => {
    getOrCreateSession("agent:trigger-test-agent:dm:5511", "trigger-test-agent", "/tmp/trigger-test-agent-real", {
      name: "support-desk",
    });
    updateSessionSource("agent:trigger-test-agent:dm:5511", {
      channel: "whatsapp",
      accountId: "acc-1",
      chatId: "5511@s.whatsapp.net",
    });
    createTrigger({ name: "fixed", topic, session: "support-desk" });
    await startRunner();

    emit(topic, commentEvent("c1", "topic-a"));
    await waitFor(() => publishCalls.length >= 1);

    expect(publishCalls[0]!.sessionName).toBe("support-desk");
    expect(publishCalls[0]!.payload.source).toEqual({
      channel: "whatsapp",
      accountId: "acc-1",
      chatId: "5511@s.whatsapp.net",
    });
  });
  it("never routes an event-derived name into another agent's session", async () => {
    dbCreateAgent({ id: "other-agent", cwd: "/tmp/other-agent-real" });
    getOrCreateSession("agent:other-agent:dm:5522", "other-agent", "/tmp/other-agent-real", {
      name: "issue-topic-x",
    });
    createTrigger({ name: "forum-foreign", topic, session: "issue-{{data.payload.row.values.topic_id.0}}" });
    await startRunner();

    emit(topic, commentEvent("c1", "topic-x"));
    emit(topic, commentEvent("c2", "topic-a"));
    await waitFor(() => publishCalls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(publishCalls.map((call) => call.sessionName)).toEqual(["issue-topic-a"]);
  });
  it("reuses an unnamed session targeted by its key", async () => {
    getOrCreateSession("agent:trigger-test-agent:dm:5533", "trigger-test-agent", "/tmp/trigger-test-agent-real");
    createTrigger({ name: "by-key", topic, session: "agent:trigger-test-agent:dm:5533" });
    await startRunner();

    emit(topic, commentEvent("c1", "topic-a"));
    await waitFor(() => publishCalls.length >= 1);

    const named = listSessions().find((session) => session.sessionKey === "agent:trigger-test-agent:dm:5533");
    expect(named?.name).toBeTruthy();
    expect(publishCalls[0]!.sessionName).toBe(named!.name!);
    expect(listSessions().filter((session) => session.sessionKey.includes(":trigger:"))).toHaveLength(0);
  });
});
