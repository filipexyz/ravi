import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { openHandoff } from "../../handoffs/store.js";
import { closeSessionStore, getOrCreateSession } from "../../router/sessions.js";
import { createRuntimeContext } from "../../runtime/context-registry.js";
import { recordSessionEvent, upsertSessionTurn } from "../../session-trace/session-trace-db.js";
import { recordTerminalTurnTrace } from "../../session-trace/runtime-trace.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { dbCreateTrigger } from "../../triggers/triggers-db.js";
import { reconcileSlackThreadLifecycle } from "./thread-lifecycle.js";
import { registerInboundSlackThread } from "./thread-lifecycle-store.js";
import {
  decideThreadParentReturn,
  getThreadReturnWatch,
  markThreadParentReturn,
  THREAD_RETURN_NUDGE_TIMEOUT_MS,
  THREAD_RETURN_WATCH_WINDOW_MS,
  type ThreadReturnInput,
  type ThreadReturnTurn,
  type ThreadReturnWatch,
} from "./thread-parent-return.js";

const NOW = 1_800_000_000_000;

function turn(overrides: Partial<ThreadReturnTurn> = {}): ThreadReturnTurn {
  return {
    turnId: "t1",
    status: "complete",
    startedAt: NOW - 5 * 60_000,
    completedAt: NOW - 60_000,
    outputState: "final",
    ...overrides,
  };
}

function watch(overrides: Partial<ThreadReturnWatch> = {}): ThreadReturnWatch {
  return {
    requestId: "r1",
    lastReturnAt: null,
    turnId: "t1",
    turnStartedAt: NOW - 5 * 60_000,
    stage: "nudged",
    nudgeEventId: "e1",
    nudgedAt: NOW - 30_000,
    followupTurnId: null,
    resolvedAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<ThreadReturnInput> = {}): ThreadReturnInput {
  return {
    now: NOW,
    threadOpen: true,
    turn: turn(),
    turnOrigin: "agent",
    turnReplied: true,
    watch: null,
    openDecision: false,
    returnedSince: () => false,
    ...overrides,
  };
}

describe("decideThreadParentReturn", () => {
  it("asks the thread for a return when a delegated turn replied without one", () => {
    expect(decideThreadParentReturn(input())).toEqual({ kind: "nudge", turnId: "t1", turnStartedAt: NOW - 5 * 60_000 });
    expect(decideThreadParentReturn(input({ turnOrigin: "system" })).kind).toBe("nudge");
  });

  it("does nothing when the turn already returned: report, close --return or decision", () => {
    const since: number[] = [];
    const action = decideThreadParentReturn(
      input({
        returnedSince: (at) => {
          since.push(at);
          return true;
        },
      }),
    );
    expect(action.kind).toBe("none");
    expect(since).toEqual([NOW - 5 * 60_000]);
    expect(decideThreadParentReturn(input({ openDecision: true })).kind).toBe("none");
  });

  it("leaves a person conversing in the thread alone, and turns without provenance", () => {
    expect(decideThreadParentReturn(input({ turnOrigin: "human" })).kind).toBe("none");
    expect(decideThreadParentReturn(input({ turnOrigin: "unknown" })).kind).toBe("none");
    expect(decideThreadParentReturn(input({ turnOrigin: null })).kind).toBe("none");
  });

  it("ignores silent, unreplied, unfinished, closed and backlog turns", () => {
    expect(decideThreadParentReturn(input({ turn: turn({ outputState: "silent" }) })).kind).toBe("none");
    expect(decideThreadParentReturn(input({ turn: turn({ outputState: null }), turnReplied: false })).kind).toBe(
      "none",
    );
    expect(decideThreadParentReturn(input({ turn: turn({ status: "running", completedAt: null }) })).kind).toBe("none");
    expect(decideThreadParentReturn(input({ threadOpen: false })).kind).toBe("none");
    const old = turn({ completedAt: NOW - THREAD_RETURN_WATCH_WINDOW_MS - 1 });
    expect(decideThreadParentReturn(input({ turn: old })).kind).toBe("none");
  });

  it("asks once per turn: the watched turn and its follow-up are never asked again", () => {
    expect(decideThreadParentReturn(input({ watch: watch({ stage: "informed" }) })).kind).toBe("none");
    const followup = turn({ turnId: "t2", startedAt: NOW - 20_000, completedAt: NOW - 10_000 });
    expect(
      decideThreadParentReturn(input({ turn: followup, watch: watch({ stage: "informed", followupTurnId: "t2" }) }))
        .kind,
    ).toBe("none");
  });

  it("waits for the follow-up, then settles or informs the parent", () => {
    // Follow-up not started yet, or still running.
    expect(decideThreadParentReturn(input({ watch: watch() })).kind).toBe("none");
    const running = turn({ turnId: "t2", startedAt: NOW - 20_000, completedAt: null, status: "running" });
    expect(decideThreadParentReturn(input({ turn: running, watch: watch() })).kind).toBe("none");

    // The follow-up returned.
    const done = turn({ turnId: "t2", startedAt: NOW - 20_000, completedAt: NOW - 5_000, outputState: "silent" });
    expect(decideThreadParentReturn(input({ turn: done, watch: watch(), returnedSince: () => true }))).toEqual({
      kind: "settle",
      turnId: "t1",
      stage: "returned",
      followupTurnId: "t2",
    });

    // Silent follow-up without return: the thread waits on a person in it.
    expect(decideThreadParentReturn(input({ turn: done, watch: watch() }))).toEqual({
      kind: "settle",
      turnId: "t1",
      stage: "skipped",
      followupTurnId: "t2",
    });

    // The follow-up replied in the thread but still sent nothing.
    const replied = { ...done, outputState: "final" as const };
    expect(decideThreadParentReturn(input({ turn: replied, watch: watch() }))).toEqual({
      kind: "inform",
      turnId: "t1",
      followupTurnId: "t2",
      reason: "followup_without_return",
    });

    const failed = { ...done, status: "failed" as const, outputState: null };
    expect(decideThreadParentReturn(input({ turn: failed, watch: watch() }))).toMatchObject({
      kind: "inform",
      reason: "followup_failed",
    });

    // The follow-up never ran.
    const stale = watch({ nudgedAt: NOW - THREAD_RETURN_NUDGE_TIMEOUT_MS });
    expect(decideThreadParentReturn(input({ watch: stale }))).toEqual({
      kind: "inform",
      turnId: "t1",
      followupTurnId: null,
      reason: "nudge_unanswered",
    });
  });
});

describe("decideThreadParentReturn: a silent PR follow wake", () => {
  const silent = turn({ outputState: "silent" });
  const ciInput = (overrides: Partial<ThreadReturnInput> = {}) =>
    input({ turn: silent, turnOrigin: "trigger", turnReplied: false, turnCiWake: true, ...overrides });

  it("asks the thread for a return, and says why", () => {
    expect(decideThreadParentReturn(ciInput())).toEqual({
      kind: "nudge",
      turnId: "t1",
      turnStartedAt: NOW - 5 * 60_000,
      silentCiWake: true,
    });
  });

  it("leaves every other silent turn alone", () => {
    // Not a PR follow wake: silence stays a valid answer.
    expect(decideThreadParentReturn(ciInput({ turnCiWake: false })).kind).toBe("none");
    expect(decideThreadParentReturn(ciInput({ turnCiWake: undefined })).kind).toBe("none");
    // A PR follow wake that did reply keeps the ordinary nudge, without the CI wording.
    const replied = decideThreadParentReturn(
      ciInput({ turn: turn({ outputState: "final" }), turnReplied: true, turnCiWake: false }),
    );
    expect(replied).toEqual({ kind: "nudge", turnId: "t1", turnStartedAt: NOW - 5 * 60_000 });
  });

  it("does nothing when the thread already said where the PR is", () => {
    expect(decideThreadParentReturn(ciInput({ returnedSince: () => true })).kind).toBe("none");
    expect(decideThreadParentReturn(ciInput({ openDecision: true })).kind).toBe("none");
    expect(decideThreadParentReturn(ciInput({ openHandoff: true })).kind).toBe("none");
  });

  it("still ignores a closed thread, an unfinished turn and backlog", () => {
    expect(decideThreadParentReturn(ciInput({ threadOpen: false })).kind).toBe("none");
    expect(
      decideThreadParentReturn(ciInput({ turn: turn({ outputState: "silent", completedAt: null, status: "running" }) }))
        .kind,
    ).toBe("none");
    const old = turn({ outputState: "silent", completedAt: NOW - THREAD_RETURN_WATCH_WINDOW_MS - 1 });
    expect(decideThreadParentReturn(ciInput({ turn: old })).kind).toBe("none");
  });

  it("tells the parent when the follow-up is silent too, instead of reading it as waiting on a person", () => {
    const followup = turn({ turnId: "t2", startedAt: NOW - 20_000, completedAt: NOW - 5_000, outputState: "silent" });
    expect(decideThreadParentReturn(input({ turn: followup, watch: watch(), watchedTurnCiWake: true }))).toEqual({
      kind: "inform",
      turnId: "t1",
      followupTurnId: "t2",
      reason: "ci_wake_silent",
    });
    // Same silent follow-up for an ordinary nudge keeps meaning "waiting on a person".
    expect(decideThreadParentReturn(input({ turn: followup, watch: watch() })).kind).toBe("settle");
    // A follow-up that reports still settles.
    expect(
      decideThreadParentReturn(
        input({ turn: followup, watch: watch(), watchedTurnCiWake: true, returnedSince: () => true }),
      ),
    ).toMatchObject({ kind: "settle", stage: "returned" });
  });
});

// The rule reads only Ravi's own turn records, so the same sequence must hold for any provider runtime.
describe.each(["claude", "codex", "pi"])("thread parent return through the gateway reconciliation (%s)", (provider) => {
  let stateDir: string | null = null;
  const parentKey = "return-parent";
  const childKey = "return-parent:thread:1713000000.000200";
  const childName = "return-child";
  const requestId = "return-thread";
  let now: number;
  let publishPrompt: ReturnType<typeof mock>;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-thread-parent-return-");
    now = Date.now();
    getOrCreateSession(parentKey, "main", "/tmp/ravi", { name: parentKey });
    getOrCreateSession(childKey, "main", "/tmp/ravi", { name: childName });
    registerInboundSlackThread({
      requestId,
      parentSessionKey: parentKey,
      parentSessionName: parentKey,
      childSessionKey: childKey,
      childSessionName: childName,
      accountId: "test-slack",
      instanceId: "test-slack",
      platformChatId: "C_TEST",
      threadCanonicalChatId: "chat-thread-return",
      providerThreadId: "1713000000.000200",
      seenAt: now - 60 * 60_000,
    });
    publishPrompt = mock(async () => {});
  });
  afterEach(async () => {
    closeSessionStore();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function seedTurn(input: {
    turnId: string;
    startedAt: number;
    completedAt: number;
    origin: string;
    automationId?: string;
    reply: string | null;
    outputState: "final" | "silent";
  }) {
    upsertSessionTurn({
      turnId: input.turnId,
      sessionKey: childKey,
      sessionName: childName,
      runId: `run-${input.turnId}`,
      provider,
      status: "running",
      startedAt: input.startedAt,
      updatedAt: input.startedAt,
    });
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId: "main",
      sessionKey: childKey,
      sessionName: childName,
      capabilities: [],
      metadata: { actorAuthorizationMode: "invoke-only" },
    });
    recordSessionEvent({
      sessionKey: childKey,
      sessionName: childName,
      turnId: input.turnId,
      eventType: "adapter.request",
      eventGroup: "runtime",
      timestamp: input.startedAt,
      payloadJson: {
        context_id: context.contextId,
        provider,
        turn_provenance: { origin: input.origin, ...(input.automationId ? { automationId: input.automationId } : {}) },
      },
    });
    if (input.reply) {
      recordSessionEvent({
        sessionKey: childKey,
        sessionName: childName,
        turnId: input.turnId,
        eventType: "response.emitted",
        eventGroup: "response",
        timestamp: input.completedAt - 1,
        payloadJson: { textLen: input.reply.length, mediaCount: 0, hasError: false },
        preview: input.reply,
      });
    }
    recordTerminalTurnTrace({
      sessionKey: childKey,
      sessionName: childName,
      turnId: input.turnId,
      status: "complete",
      eventType: "turn.complete",
      outputState: input.outputState,
      completedAt: input.completedAt,
    });
  }

  async function tick(at = now) {
    const result = await reconcileSlackThreadLifecycle({
      publishPrompt,
      publishEvent: mock(async () => {}),
      now: () => at,
    });
    expect(result.failures).toBe(0);
  }

  function calls(): Array<{ session: string; payload: Record<string, any>; options: { messageId?: string } }> {
    return publishPrompt.mock.calls.map(([session, payload, options]) => ({
      session: session as string,
      payload: payload as Record<string, any>,
      options: (options ?? {}) as { messageId?: string },
    }));
  }

  it("asks the thread once, then informs the parent with the thread's last message", async () => {
    seedTurn({
      turnId: "w1",
      startedAt: now - 10 * 60_000,
      completedAt: now - 2 * 60_000,
      origin: "agent",
      reply: "Resultado completo: thread em pausa aguardando a decisão do main.",
      outputState: "final",
    });

    await tick();
    expect(calls()).toHaveLength(1);
    const nudge = calls()[0]!;
    expect(nudge.session).toBe(childName);
    expect(nudge.payload._slackThreadLifecycle).toMatchObject({ eventType: "thread.return_nudge", turnId: "w1" });
    expect(nudge.payload.prompt).toContain("ravi sessions report");
    expect(nudge.payload.prompt).toContain("@@SILENT@@");
    expect(nudge.options.messageId).toBe(`slack-thread-return-nudge:${requestId}:w1`);

    // Idempotent: further ticks on the same turn do not ask again.
    await tick();
    await tick(now + 60_000);
    expect(calls()).toHaveLength(1);

    // The follow-up turn replies in the thread but sends nothing to the parent.
    seedTurn({
      turnId: "f1",
      startedAt: now + 61_000,
      completedAt: now + 90_000,
      origin: "agent",
      reply: "Ok, continuo aguardando.",
      outputState: "final",
    });
    await tick(now + 120_000);
    expect(calls()).toHaveLength(2);
    const inform = calls()[1]!;
    expect(inform.session).toBe(parentKey);
    expect(inform.payload._slackThreadLifecycle).toMatchObject({
      eventType: "thread.unreturned",
      turnId: "w1",
      followupTurnId: "f1",
      reason: "followup_without_return",
    });
    expect(inform.payload.prompt).toContain("[System] Inform:");
    expect(inform.payload.prompt).toContain("Ok, continuo aguardando.");
    expect(getThreadReturnWatch(requestId)).toMatchObject({ stage: "informed", turnId: "w1", followupTurnId: "f1" });

    // No loop: the follow-up turn is never asked for a return, and the Inform is not repeated.
    await tick(now + 180_000);
    await tick(now + 240_000);
    expect(calls()).toHaveLength(2);
  });

  it("does nothing when the turn reported to its parent", async () => {
    seedTurn({
      turnId: "w2",
      startedAt: now - 10 * 60_000,
      completedAt: now - 2 * 60_000,
      origin: "agent",
      reply: "Feito.",
      outputState: "final",
    });
    markThreadParentReturn(requestId, now - 3 * 60_000);
    await tick();
    expect(calls()).toHaveLength(0);
  });

  it("settles without an Inform when the follow-up reports", async () => {
    seedTurn({
      turnId: "w3",
      startedAt: now - 10 * 60_000,
      completedAt: now - 2 * 60_000,
      origin: "system",
      reply: "Resultado.",
      outputState: "final",
    });
    await tick();
    expect(calls()).toHaveLength(1);
    seedTurn({
      turnId: "f3",
      startedAt: now + 61_000,
      completedAt: now + 90_000,
      origin: "agent",
      reply: null,
      outputState: "silent",
    });
    markThreadParentReturn(requestId, now + 80_000);
    await tick(now + 120_000);
    expect(calls()).toHaveLength(1);
    expect(getThreadReturnWatch(requestId)).toMatchObject({ stage: "returned", followupTurnId: "f3" });
  });

  it("does not ask a thread whose turn answered a person writing in it", async () => {
    seedTurn({
      turnId: "w4",
      startedAt: now - 10 * 60_000,
      completedAt: now - 2 * 60_000,
      origin: "human",
      reply: "Respondendo você aqui.",
      outputState: "final",
    });
    await tick();
    expect(calls()).toHaveLength(0);
  });
  function ghFollowWake(turnId: string, outputState: "final" | "silent" = "silent") {
    const trigger = dbCreateTrigger({
      name: "gh-follow:filipexyz/ravi#1013",
      topic: "ravi.github.pull_request",
      message: "ci",
    });
    seedTurn({
      turnId,
      startedAt: now - 10 * 60_000,
      completedAt: now - 2 * 60_000,
      origin: "trigger",
      automationId: `trigger:${trigger.id}`,
      reply: null,
      outputState,
    });
    return trigger;
  }

  it("asks a thread whose PR follow wake ended silent, once per wake", async () => {
    ghFollowWake("ci1");
    await tick();
    expect(calls()).toHaveLength(1);
    const nudge = calls()[0]!;
    expect(nudge.session).toBe(childName);
    expect(nudge.payload._slackThreadLifecycle).toMatchObject({ eventType: "thread.return_nudge", turnId: "ci1" });
    expect(nudge.payload.prompt).toContain("A PR/CI event woke you");
    expect(nudge.payload.prompt).not.toContain("do nothing");
    expect(nudge.options.messageId).toBe(`slack-thread-return-nudge:${requestId}:ci1`);
    await tick();
    await tick(now + 60_000);
    expect(calls()).toHaveLength(1);
  });

  it("tells the parent when the thread is silent again after being asked", async () => {
    ghFollowWake("ci2");
    await tick();
    seedTurn({
      turnId: "ci2-f",
      startedAt: now + 61_000,
      completedAt: now + 90_000,
      origin: "system",
      reply: null,
      outputState: "silent",
    });
    await tick(now + 120_000);
    expect(calls()).toHaveLength(2);
    const inform = calls()[1]!;
    expect(inform.session).toBe(parentKey);
    expect(inform.payload._slackThreadLifecycle).toMatchObject({
      eventType: "thread.unreturned",
      turnId: "ci2",
      followupTurnId: "ci2-f",
      reason: "ci_wake_silent",
    });
    expect(inform.payload.prompt).toContain("evento de PR/CI");
    expect(getThreadReturnWatch(requestId)).toMatchObject({ stage: "informed", turnId: "ci2" });
    await tick(now + 180_000);
    expect(calls()).toHaveLength(2);
  });

  it("settles without an Inform when the follow-up reports where the PR is", async () => {
    ghFollowWake("ci3");
    await tick();
    seedTurn({
      turnId: "ci3-f",
      startedAt: now + 61_000,
      completedAt: now + 90_000,
      origin: "system",
      reply: null,
      outputState: "silent",
    });
    markThreadParentReturn(requestId, now + 80_000);
    await tick(now + 120_000);
    expect(calls()).toHaveLength(1);
    expect(getThreadReturnWatch(requestId)).toMatchObject({ stage: "returned", followupTurnId: "ci3-f" });
  });

  it("does not ask when the silent wake was reported, or the thread waits on the parent with --awaiting", async () => {
    ghFollowWake("ci4");
    markThreadParentReturn(requestId, now - 3 * 60_000);
    await tick();
    expect(calls()).toHaveLength(0);
  });

  it("does not ask while a handoff is open", async () => {
    ghFollowWake("ci5");
    openHandoff({
      childSessionKey: childKey,
      parentSessionKey: parentKey,
      kind: "merge",
      ref: "filipexyz/ravi#1013",
      now: now - 9 * 60_000,
    });
    await tick();
    expect(calls()).toHaveLength(0);
  });

  it("keeps silence valid for triggers that are not PR follows", async () => {
    const other = dbCreateTrigger({ name: "page-comments:xyz", topic: "ravi.pages.comment", message: "c" });
    seedTurn({
      turnId: "ci6",
      startedAt: now - 10 * 60_000,
      completedAt: now - 2 * 60_000,
      origin: "trigger",
      automationId: `trigger:${other.id}`,
      reply: null,
      outputState: "silent",
    });
    await tick();
    expect(calls()).toHaveLength(0);
  });

  it("only a turn whose recorded origin is trigger counts as a PR follow wake", async () => {
    const follow = dbCreateTrigger({
      name: "gh-follow:filipexyz/ravi#1013",
      topic: "ravi.github.pull_request",
      message: "ci",
    });
    seedTurn({
      turnId: "ci8",
      startedAt: now - 10 * 60_000,
      completedAt: now - 2 * 60_000,
      origin: "system",
      automationId: `trigger:${follow.id}`,
      reply: null,
      outputState: "silent",
    });
    await tick();
    expect(calls()).toHaveLength(0);
  });

  it("does not read a deleted trigger or a bare trigger origin as a PR follow", async () => {
    seedTurn({
      turnId: "ci7",
      startedAt: now - 10 * 60_000,
      completedAt: now - 2 * 60_000,
      origin: "trigger",
      automationId: "trigger:gone0000",
      reply: null,
      outputState: "silent",
    });
    await tick();
    expect(calls()).toHaveLength(0);
  });
});
