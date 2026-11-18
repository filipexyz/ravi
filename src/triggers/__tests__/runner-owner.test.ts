import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { dbCreateAgent } from "../../router/router-db.js";
import { getRecentHistory, saveMessage } from "../../db.js";
import {
  deleteSession,
  getOrCreateSession,
  getSession,
  getSessionByName,
  renameSessionName,
  updateSessionName,
} from "../../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { SessionTarget } from "../types.js";

afterAll(() => mock.restore());

type BusEvent = { topic: string; data: unknown };

interface TopicChannel {
  push(event: BusEvent): void;
  close(): void;
}

const channels = new Map<string, TopicChannel>();
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
    subscribe: mock((topic: string) => createTopicStream(topic)),
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
const { dbCreateTrigger, dbDeleteTrigger, dbGetTrigger, dbUpdateTrigger } = await import("../triggers-db.js");

const TOPIC = "ravi.test.owner";

let stateDir: string | null = null;
let runner: InstanceType<typeof TriggerRunner> | null = null;

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function emit(data: unknown, topic = TOPIC): void {
  const channel = channels.get(topic);
  if (!channel) throw new Error(`Runner is not subscribed to ${topic}`);
  channel.push({ topic, data });
}

const AGENT_ID = "trigger-owner-agent";
const AGENT_CWD = "/tmp/trigger-owner-agent-real";

function createTrigger(
  ownerPrincipal?: string,
  overrides: { session?: SessionTarget; topic?: string; name?: string } = {},
) {
  return dbCreateTrigger({
    name: overrides.name ?? "owned",
    agentId: AGENT_ID,
    topic: overrides.topic ?? TOPIC,
    message: "row changed",
    session: overrides.session ?? "isolated",
    cooldownMs: 0,
    ...(ownerPrincipal ? { ownerPrincipal } : {}),
  });
}

async function fire(eventId: string): Promise<Record<string, unknown>> {
  return (await fireInto(eventId)).payload;
}

/** One fire, with the session the runner sent it to. */
async function fireInto(eventId: string): Promise<{ sessionName: string; payload: Record<string, unknown> }> {
  const before = publishCalls.length;
  emit({ eventId });
  await waitFor(() => publishCalls.length === before + 1);
  return publishCalls[before]!;
}

/** `ravi triggers test <id> --execute`, as the CLI publishes it. */
async function testFire(triggerId: string, initiator?: string): Promise<Record<string, unknown>> {
  const before = publishCalls.length;
  emit({ triggerId, ...(initiator ? { initiator } : {}) }, "ravi.triggers.test");
  await waitFor(() => publishCalls.length === before + 1);
  return publishCalls[before]!.payload;
}

/**
 * Tell the runner to reload, then fire until a turn shows the reload took
 * effect. The runner keeps its topic subscription across a reload, so the
 * fired prompt is the only place the reload shows.
 */
async function fireAfterRefresh(
  reloaded: (payload: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  emit({}, "ravi.triggers.refresh");
  for (let attempt = 0; attempt < 100; attempt++) {
    const payload = await fire(`evt-refresh-${attempt}`);
    if (reloaded(payload)) return payload;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The runner never reloaded the trigger");
}

/** The own session of an `isolated` trigger a person owns: only its fires run there. */
function ownSessionKey(triggerId: string): string {
  return `agent:${AGENT_ID}:trigger:${triggerId}:own`;
}

/** The plain one-per-trigger session of an `isolated` trigger nobody owns. */
function plainSessionKey(triggerId: string): string {
  return `agent:${AGENT_ID}:trigger:${triggerId}`;
}

/**
 * No owner admitted. Every trigger here runs `isolated` unless a test says
 * otherwise: in its own session while the stored trigger has an owner (`own`),
 * else in the plain session, which names no session of its own.
 */
function nobody(triggerId: string, own = true) {
  return {
    triggerId,
    ownerPrincipal: "unknown",
    ownerIsOperator: false,
    ownSessionKey: own ? ownSessionKey(triggerId) : null,
  };
}

/** Lets the runner handle what was emitted, then says how many fires were published since. */
async function publishedAfter(before: number, settleMs = 150): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  return publishCalls.length - before;
}

/** Stops the runner, changes the stored triggers, and (unless told not to) starts it again so it subscribes them. */
async function restartRunnerWith(change: () => unknown, options: { start?: boolean } = {}): Promise<void> {
  await runner?.stop();
  runner = null;
  for (const channel of channels.values()) channel.close();
  channels.clear();
  change();
  if (options.start !== false) await startRunner();
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-trigger-runner-owner-test-");
  dbCreateAgent({ id: AGENT_ID, cwd: AGENT_CWD });
  channels.clear();
  publishCalls.length = 0;
});

afterEach(async () => {
  await runner?.stop();
  runner = null;
  for (const channel of channels.values()) channel.close();
  channels.clear();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

async function startRunner(): Promise<void> {
  runner = new TriggerRunner();
  await runner.start();
  await waitFor(() => channels.has(TOPIC));
}

describe("TriggerRunner carries the trigger's owner with the turn it fires", () => {
  it("snapshots an operator owner as the operator", async () => {
    const trigger = createTrigger("operator");
    await startRunner();

    const payload = await fire("evt-1");
    expect(payload).toMatchObject({
      _trigger: true,
      _triggerId: trigger.id,
      _triggerAuthority: {
        triggerId: trigger.id,
        ownerPrincipal: "operator",
        ownerIsOperator: true,
        ownSessionKey: ownSessionKey(trigger.id),
      },
    });
  });

  it("snapshots a contact owner as that contact, never as the operator", async () => {
    const trigger = createTrigger("contact:c_ana");
    await startRunner();

    expect((await fire("evt-1"))._triggerAuthority).toEqual({
      triggerId: trigger.id,
      ownerPrincipal: "contact:c_ana",
      ownerIsOperator: false,
      ownSessionKey: ownSessionKey(trigger.id),
    });
  });

  it("gives a trigger with no recorded owner nobody's authority", async () => {
    const trigger = createTrigger();
    await startRunner();

    expect((await fire("evt-1"))._triggerAuthority).toEqual(nobody(trigger.id, false));
  });

  it("admits nobody while an edit the runner has not reloaded is pending, even one the owner made", async () => {
    const trigger = createTrigger("operator");
    await startRunner();
    expect((await fire("evt-1"))._triggerAuthority).toMatchObject({ ownerPrincipal: "operator" });

    // The owner rewrote the message and the runner still holds the old one:
    // the old prompt must not run under the row's owner.
    dbUpdateTrigger(trigger.id, { message: "a new prompt" }, { keepOwnerFor: "operator" });
    expect(dbGetTrigger(trigger.id)?.ownerPrincipal).toBe("operator");
    const stale = await fire("evt-2");
    expect(String(stale.prompt)).toContain("row changed");
    // Not its owner's fire: it also stays out of the trigger's own session.
    expect(stale._triggerAuthority).toEqual(nobody(trigger.id, false));

    // Once reloaded, the new prompt runs as the owner again.
    const fresh = await fireAfterRefresh((payload) => String(payload.prompt).includes("a new prompt"));
    expect(fresh._triggerAuthority).toEqual({
      triggerId: trigger.id,
      ownerPrincipal: "operator",
      ownerIsOperator: true,
      ownSessionKey: ownSessionKey(trigger.id),
    });
  });

  it("admits nobody once someone else changed the trigger, before and after the runner reloads", async () => {
    const trigger = createTrigger("operator");
    await startRunner();

    // Someone else renamed it: the name is part of every prompt it fires.
    dbUpdateTrigger(trigger.id, { name: "renamed by someone else" }, { keepOwnerFor: "contact:c_ana" });
    expect(dbGetTrigger(trigger.id)?.ownerPrincipal).toBeUndefined();
    expect((await fire("evt-1"))._triggerAuthority).toEqual(nobody(trigger.id, false));

    const reloaded = await fireAfterRefresh((payload) => String(payload.prompt).includes("renamed by someone else"));
    expect(reloaded._triggerAuthority).toEqual(nobody(trigger.id, false));
  });

  it("gives a turn fired for a row that is already gone no owner", async () => {
    const trigger = createTrigger("operator");
    await startRunner();

    // Deleted without a refresh: the subscription's copy still says `operator`.
    dbDeleteTrigger(trigger.id);
    const gone = await fireInto("evt-gone");
    expect(gone.payload._triggerAuthority).toEqual(nobody(trigger.id, false));
    expect(gone.sessionName).not.toBe(ownSessionKey(trigger.id));
  });
});

describe("TriggerRunner runs an owned isolated trigger in a session of its own", () => {
  const OPERATOR = { ownerPrincipal: "operator", ownerIsOperator: true };

  it("creates the own session under the trigger's own key, and it goes by that key", async () => {
    const trigger = createTrigger("operator");
    await startRunner();

    const first = await fireInto("evt-1");
    expect(first.payload._triggerAuthority).toMatchObject({ ...OPERATOR, ownSessionKey: ownSessionKey(trigger.id) });
    // Its name is its key: a name the session store gives to no other session.
    expect(first.sessionName).toBe(ownSessionKey(trigger.id));
    expect(getSession(ownSessionKey(trigger.id))?.name).toBe(ownSessionKey(trigger.id));

    // The next fire finds it by its key and runs in the same session.
    const second = await fireInto("evt-2");
    expect(second.sessionName).toBe(first.sessionName);
    expect(second.payload._triggerAuthority).toMatchObject({ ...OPERATOR, ownSessionKey: ownSessionKey(trigger.id) });
  });

  it("starts after whatever the journal already holds under its name", async () => {
    const trigger = createTrigger("operator");
    // Written under the name before the session exists (a hook action could, by the raw name).
    saveMessage(ownSessionKey(trigger.id), "user", "planted before the session existed");
    const planted = getRecentHistory(ownSessionKey(trigger.id), 1).at(-1)!.id;
    await startRunner();

    await fireInto("evt-1");
    // The runtime restates only what comes after this mark when the session starts cold.
    expect(getSession(ownSessionKey(trigger.id))?.historyResetAfterId).toBe(planted);
  });

  it("gets the mark before its first turn when its row was left without one", async () => {
    const trigger = createTrigger("operator");
    // The row exists but the fire that created it never got to mark it.
    getOrCreateSession(ownSessionKey(trigger.id), AGENT_ID, AGENT_CWD, undefined, { triggerRunner: true });
    saveMessage(ownSessionKey(trigger.id), "user", "stored under the name before the first turn");
    const stored = getRecentHistory(ownSessionKey(trigger.id), 1).at(-1)!.id;
    expect(getSession(ownSessionKey(trigger.id))?.historyResetAfterId).toBeUndefined();
    await startRunner();

    await fireInto("evt-1");
    expect(getSession(ownSessionKey(trigger.id))?.historyResetAfterId).toBe(stored);

    // Once marked it is left alone: later turns keep what the session journaled.
    saveMessage(ownSessionKey(trigger.id), "assistant", "the first turn's answer");
    await fireInto("evt-2");
    expect(getSession(ownSessionKey(trigger.id))?.historyResetAfterId).toBe(stored);
  });

  it("goes by a name that is one subject token when the agent id has a dot or a space", async () => {
    const dotted = "acme.support team";
    dbCreateAgent({ id: dotted, cwd: AGENT_CWD });
    const trigger = dbCreateTrigger({
      name: "payroll",
      agentId: dotted,
      topic: TOPIC,
      message: "row changed",
      session: "isolated",
      cooldownMs: 0,
      ownerPrincipal: "operator",
    });
    const key = `agent:${dotted}:trigger:${trigger.id}:own`;
    await startRunner();

    const fired = await fireInto("evt-1");
    expect(fired.sessionName).toBe(`agent:acme~2E~support~20~team:trigger:${trigger.id}:own`);
    expect(fired.sessionName).not.toMatch(/[.\s*>]/);
    // The session's key is untouched, and it is what the snapshot names.
    expect(getSessionByName(fired.sessionName)?.sessionKey).toBe(key);
    expect(fired.payload._triggerAuthority).toMatchObject({ ...OPERATOR, ownSessionKey: key });
    expect((await fireInto("evt-2")).sessionName).toBe(fired.sessionName);
  });

  it("keeps its name for itself after it is deleted, so nobody inherits what it stored", async () => {
    const trigger = createTrigger("operator");
    await startRunner();
    const first = await fireInto("evt-1");
    // What the runtime journals for the owner's turn.
    saveMessage(first.sessionName, "assistant", "Row 7 of payroll: salary 9100.");
    const journaled = getRecentHistory(first.sessionName, 1).at(-1)!.id;

    // The row goes away: the runtime's reset on an over-long prompt, or someone's delete.
    expect(deleteSession(ownSessionKey(trigger.id))).toBe(true);

    // The name is not free: no session can be created under it, with it, or renamed to it.
    const chatKey = `agent:${AGENT_ID}:whatsapp:dm:5511888888888`;
    expect(() => getOrCreateSession(first.sessionName, AGENT_ID, AGENT_CWD)).toThrow("reserved for the trigger");
    expect(() => getOrCreateSession(chatKey, AGENT_ID, AGENT_CWD, { name: first.sessionName })).toThrow(
      "reserved for the trigger's session",
    );
    const chat = getOrCreateSession(chatKey, AGENT_ID, AGENT_CWD, { name: "ana-chat" });
    expect(() => updateSessionName(chat.sessionKey, first.sessionName)).toThrow("reserved for the trigger's session");
    expect(() => renameSessionName(chat.sessionKey, first.sessionName)).toThrow("reserved for the trigger's session");

    // Only the trigger's next fire takes it again, and starts after what the deleted session journaled.
    const second = await fireInto("evt-2");
    expect(second.sessionName).toBe(first.sessionName);
    expect(getSession(ownSessionKey(trigger.id))?.historyResetAfterId).toBe(journaled);
  });

  it("never goes by another name", async () => {
    const trigger = createTrigger("operator");
    await startRunner();
    await fireInto("evt-1");

    // A renamed session would leave what it stores under a name that is free once it is deleted.
    expect(() => renameSessionName(ownSessionKey(trigger.id), "payroll-sync")).toThrow("goes by its own name only");
    expect(() => updateSessionName(ownSessionKey(trigger.id), "payroll-sync")).toThrow("goes by its own name only");
    expect(getSession(ownSessionKey(trigger.id))?.name).toBe(ownSessionKey(trigger.id));
  });

  it("keeps the plain one-per-trigger session, under its plain name, for a trigger nobody owns", async () => {
    const trigger = createTrigger();
    await startRunner();

    const fired = await fireInto("evt-1");
    expect(fired.sessionName).toBe(`${AGENT_ID}-trigger-owned`);
    expect(getSessionByName(fired.sessionName)?.sessionKey).toBe(plainSessionKey(trigger.id));
    expect(fired.payload._triggerAuthority).toEqual(nobody(trigger.id, false));
  });

  it("names no session of its own in the agent's main session", async () => {
    createTrigger("operator", { session: "main" });
    await startRunner();

    expect((await fire("evt-1"))._triggerAuthority).toMatchObject({ ...OPERATOR, ownSessionKey: null });
  });

  it("names no session of its own in a named session, the one it creates included", async () => {
    // A name anyone could have used first: whatever was keyed to it comes along, so it lends nothing.
    const trigger = createTrigger("operator", { session: "requests-queue" });
    await startRunner();

    const fired = await fireInto("evt-1");
    expect(fired.sessionName).toBe("requests-queue");
    expect(getSessionByName("requests-queue")?.sessionKey).toMatch(
      new RegExp(`^agent:${AGENT_ID}:trigger:${trigger.id}:key:[0-9a-f]{24}$`),
    );
    expect(fired.payload._triggerAuthority).toMatchObject({ ...OPERATOR, ownSessionKey: null });
  });

  it("is not captured by a session that asks to go by the own key as its name", async () => {
    const trigger = createTrigger("operator");
    const chatKey = `agent:${AGENT_ID}:whatsapp:dm:5511888888888`;
    // A name spelled like a trigger's session key is only ever that session's
    // own key: no session can be created or renamed to stand in for the own one.
    expect(() => getOrCreateSession(chatKey, AGENT_ID, AGENT_CWD, { name: ownSessionKey(trigger.id) })).toThrow(
      "reserved for the trigger's session",
    );
    const squatter = getOrCreateSession(chatKey, AGENT_ID, AGENT_CWD, { name: "ana-chat" });
    expect(() => updateSessionName(squatter.sessionKey, ownSessionKey(trigger.id))).toThrow(
      "reserved for the trigger's session",
    );
    await startRunner();

    const fired = await fireInto("evt-1");
    expect(fired.sessionName).toBe(ownSessionKey(trigger.id));
    expect(getSessionByName(fired.sessionName)?.sessionKey).toBe(ownSessionKey(trigger.id));
    expect(fired.payload._triggerAuthority).toMatchObject({ ...OPERATOR, ownSessionKey: ownSessionKey(trigger.id) });
  });

  it("moves to the plain session once the trigger loses its owner, and never enters the own one again", async () => {
    const trigger = createTrigger("operator");
    await startRunner();
    const owned = await fireInto("evt-1");
    expect(getSessionByName(owned.sessionName)?.sessionKey).toBe(ownSessionKey(trigger.id));

    // Someone else rewrites the message: the trigger has no owner now, and its
    // text is no longer its owner's.
    dbUpdateTrigger(trigger.id, { message: "someone else's text" }, { keepOwnerFor: "contact:c_ana" });
    expect(dbGetTrigger(trigger.id)?.ownerPrincipal).toBeUndefined();

    // Before the runner reloads: the old text, with nobody's authority, already outside the own session.
    const stale = await fireInto("evt-2");
    expect(stale.sessionName).not.toBe(owned.sessionName);
    expect(getSessionByName(stale.sessionName)?.sessionKey).toBe(plainSessionKey(trigger.id));
    expect(stale.payload._triggerAuthority).toEqual(nobody(trigger.id, false));

    // After it reloads: the new text, in the same plain session.
    const before = publishCalls.length;
    const reloaded = await fireAfterRefresh((payload) => String(payload.prompt).includes("someone else's text"));
    expect(reloaded._triggerAuthority).toEqual(nobody(trigger.id, false));
    expect(publishCalls.slice(before).every((call) => call.sessionName === stale.sessionName)).toBe(true);
    expect(publishCalls.filter((call) => call.sessionName === owned.sessionName)).toHaveLength(1);
  });
});

describe("TriggerRunner keeps every other fire out of a trigger's own session", () => {
  /** An owned trigger that fired once, so its own session exists; the runner is stopped again. */
  async function ownedTriggerWithSession() {
    const trigger = createTrigger("operator");
    await startRunner();
    const first = await fireInto("evt-own");
    await restartRunnerWith(() => undefined, { start: false });
    return { trigger, sessionName: first.sessionName, sessionKey: ownSessionKey(trigger.id) };
  }

  it("skips another trigger pointed at it by name, by key or by a value from the event", async () => {
    const own = await ownedTriggerWithSession();
    // Someone else's triggers, and the operator's own other trigger: nothing but
    // the trigger itself runs there.
    createTrigger("contact:c_ana", { session: own.sessionName, name: "by-name" });
    createTrigger("contact:c_ana", { session: own.sessionKey, name: "by-key" });
    createTrigger(undefined, { session: "{{data.target}}", name: "by-template" });
    createTrigger("operator", { session: own.sessionName, name: "same-owner" });
    await startRunner();

    const before = publishCalls.length;
    emit({ eventId: "evt-foreign", target: own.sessionName });
    await waitFor(() => publishCalls.length > before);
    // Only the trigger's own fire is published, into its own session.
    expect(await publishedAfter(before)).toBe(1);
    expect(publishCalls[before]).toMatchObject({
      sessionName: own.sessionName,
      payload: { _triggerId: own.trigger.id },
    });

    // The same value addressed by key resolves there too, and is skipped too.
    const again = publishCalls.length;
    emit({ eventId: "evt-foreign-key", target: own.sessionKey });
    await waitFor(() => publishCalls.length > again);
    expect(await publishedAfter(again)).toBe(1);
    expect(publishCalls[again]?.payload._triggerId).toBe(own.trigger.id);
  });

  it("runs a main-session trigger in the main session when its reply session is a trigger's own", async () => {
    const own = await ownedTriggerWithSession();
    dbDeleteTrigger(own.trigger.id);
    // What a follow generated during one of the trigger's turns looks like.
    const follow = dbCreateTrigger({
      name: "follow",
      agentId: AGENT_ID,
      topic: TOPIC,
      message: "a comment arrived",
      session: "main",
      replySession: own.sessionName,
      cooldownMs: 0,
    });
    await startRunner();

    const fired = await fireInto("evt-follow");
    expect(fired.payload._triggerId).toBe(follow.id);
    expect(fired.sessionName).not.toBe(own.sessionName);
    expect(getSessionByName(fired.sessionName)?.sessionKey).toBe(`agent:${AGENT_ID}:main`);
    expect(fired.payload._triggerAuthority).toEqual(nobody(follow.id, false));
  });

  it("skips a fire pointed at an own session that does not exist yet, without creating a stand-in", async () => {
    // The owned trigger has not fired: its own session is only a name so far.
    const unfired = createTrigger("operator", { topic: "ravi.test.unfired", name: "unfired" });
    createTrigger("contact:c_ana", { session: ownSessionKey(unfired.id), name: "guest" });
    await startRunner();

    const before = publishCalls.length;
    emit({ eventId: "evt-early" });
    expect(await publishedAfter(before)).toBe(0);
    expect(getSession(ownSessionKey(unfired.id))).toBeNull();
  });

  it("still lets a trigger run in the plain session of a trigger nobody owns, as before", async () => {
    const legacy = createTrigger(undefined, { name: "legacy" });
    await startRunner();
    const first = await fireInto("evt-legacy");
    expect(getSessionByName(first.sessionName)?.sessionKey).toBe(plainSessionKey(legacy.id));
    await restartRunnerWith(() => createTrigger("contact:c_ana", { session: first.sessionName, name: "guest" }));

    const before = publishCalls.length;
    emit({ eventId: "evt-shared" });
    await waitFor(() => publishCalls.length >= before + 2);
    expect(publishCalls.slice(before).map((call) => call.sessionName)).toEqual([first.sessionName, first.sessionName]);
  });
});

describe("a test fire", () => {
  it("acts as the trigger's owner only when the owner asked for it", async () => {
    const trigger = createTrigger("operator");
    await startRunner();

    expect((await testFire(trigger.id, "operator"))._triggerAuthority).toEqual({
      triggerId: trigger.id,
      ownerPrincipal: "operator",
      ownerIsOperator: true,
      ownSessionKey: ownSessionKey(trigger.id),
    });
    // Someone else's test, or one that does not say who asked, runs with
    // nobody's authority, outside the trigger's own session.
    expect((await testFire(trigger.id, "contact:c_ana"))._triggerAuthority).toEqual(nobody(trigger.id, false));
    expect((await testFire(trigger.id))._triggerAuthority).toEqual(nobody(trigger.id, false));
  });

  it("non_owner_test_fire_does_not_touch_owner_session", async () => {
    const trigger = createTrigger("contact:c_luis");
    await startRunner();
    const own = ownSessionKey(trigger.id);

    // The owner's fire runs in the trigger's own session and leaves a turn there.
    const owners = await fireInto("evt-1");
    expect(owners.sessionName).toBe(own);
    saveMessage(own, "assistant", "what the owner's turn read in Bases", "provider-session-1");
    const ownerSession = getSession(own);
    const ownerHistory = getRecentHistory(own, 10);
    expect(ownerHistory).toHaveLength(1);

    // Someone else tests the trigger, and so does a test that names nobody.
    const before = publishCalls.length;
    emit({ triggerId: trigger.id, initiator: "contact:c_ana" }, "ravi.triggers.test");
    await waitFor(() => publishCalls.length === before + 1);
    emit({ triggerId: trigger.id }, "ravi.triggers.test");
    await waitFor(() => publishCalls.length === before + 2);
    const tests = publishCalls.slice(before);

    for (const test of tests) {
      // Not one prompt reaches the owner's session, under its name or its key...
      expect(test.sessionName).not.toBe(own);
      expect(getSessionByName(test.sessionName)?.sessionKey).toBe(plainSessionKey(trigger.id));
      // ...and the turn names no session of the trigger's own and no owner.
      expect(test.payload._triggerAuthority).toEqual(nobody(trigger.id, false));
    }
    // Both tests share the plain session; the owner's is exactly as it was.
    expect(tests[1]!.sessionName).toBe(tests[0]!.sessionName);
    expect(getSession(own)).toEqual(ownerSession);
    expect(getRecentHistory(own, 10)).toEqual(ownerHistory);

    // The owner's own test still runs there, as the owner.
    const ownersTest = publishCalls.length;
    emit({ triggerId: trigger.id, initiator: "contact:c_luis" }, "ravi.triggers.test");
    await waitFor(() => publishCalls.length === ownersTest + 1);
    expect(publishCalls[ownersTest]!.sessionName).toBe(own);
    expect(publishCalls[ownersTest]!.payload._triggerAuthority).toMatchObject({
      ownerPrincipal: "contact:c_luis",
      ownSessionKey: own,
    });
  });

  it("never gives an ownerless trigger an owner, whoever tests it", async () => {
    const trigger = createTrigger();
    await startRunner();

    expect((await testFire(trigger.id, "operator"))._triggerAuthority).toEqual(nobody(trigger.id, false));
    expect((await testFire(trigger.id, "unknown"))._triggerAuthority).toEqual(nobody(trigger.id, false));
  });
});

describe("a trigger on a wildcard topic", () => {
  const WILDCARD = "ravi.>";

  it("never fires on what the bus carries for itself: a session's stream, a request's reply, a worker's pipe", async () => {
    createTrigger("operator", { topic: WILDCARD, name: "listener" });
    runner = new TriggerRunner();
    await runner.start();
    await waitFor(() => channels.has(WILDCARD));
    const wildcard = channels.get(WILDCARD)!;
    const before = publishCalls.length;

    // What the broker delivers to `ravi.>`: each event under its own subject.
    wildcard.push({ topic: "ravi.session.payroll.stream", data: { chunk: "Row 7 of payroll: salary 9100." } });
    wildcard.push({ topic: "ravi.session.payroll.runtime", data: { type: "turn.complete" } });
    wildcard.push({ topic: "ravi._reply.6f1c2a", data: { rows: [{ salary: 9100 }] } });
    wildcard.push({ topic: "ravi.worker.w1.s1.out", data: { line: "Row 7 of payroll: salary 9100." } });
    expect(await publishedAfter(before)).toBe(0);

    // Any other subject still fires it.
    wildcard.push({ topic: "ravi.test.payroll", data: { eventId: "evt-ordinary" } });
    await waitFor(() => publishCalls.length === before + 1);
    expect(String(publishCalls[before]!.payload.prompt)).toContain("Event: ravi.test.payroll");
    expect(await publishedAfter(before + 1)).toBe(0);
  });
});

describe("a shell trigger's failure notice", () => {
  const SHELL_TOPIC = "ravi.test.shell";

  function shellTrigger(name: string, onError: string) {
    return dbCreateTrigger({
      name,
      agentId: AGENT_ID,
      topic: SHELL_TOPIC,
      message: "",
      executionType: "shell",
      shellCommand: "exit 3",
      onError,
      cooldownMs: 0,
      ownerPrincipal: "operator",
    });
  }

  it("goes to the session it names, never into a trigger's own session", async () => {
    createTrigger("operator");
    await startRunner();
    const own = await fireInto("evt-1");
    getOrCreateSession(`agent:${AGENT_ID}:ops`, AGENT_ID, AGENT_CWD, { name: "ops" });

    await restartRunnerWith(() => {
      shellTrigger("to-own", `notify-session:${own.sessionName}`);
      shellTrigger("to-ops", "notify-session:ops");
    });
    await waitFor(() => channels.has(SHELL_TOPIC));
    const before = publishCalls.length;
    emit({ eventId: "evt-shell" }, SHELL_TOPIC);

    // Both commands fail; only the notice for an ordinary session is sent.
    await waitFor(() => publishCalls.length === before + 1, 15_000);
    expect(publishCalls[before]).toMatchObject({ sessionName: "ops", payload: { _triggerOnError: true } });
    expect(await publishedAfter(before + 1, 1_000)).toBe(0);
  }, 30_000);
});
