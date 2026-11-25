// Acceptance test for filipexyz/ravi#987 review B2 (adapted from the reviewer's probe,
// reviews/probe-ravi-987-b3da4d9-nonlive-snapshots.test.ts). Prompts that wait without a live
// runtime (stashed, debounced, starting, deferred after a task) are only durable through the
// restart snapshot: after a graceful restart they must still be redelivered, with their text.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbListEligibleDaemonRestartSessionSnapshots, dbUpsertDaemonRestartEpoch } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { deliverDaemonRestartSessionEvent, RESTART_TURN_AUTHORITY_METADATA_KEY } from "./daemon-restart-resume.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import type { RuntimeUserMessage } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { RuntimeSessionDispatcher } from "./session-dispatcher.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-restart-snapshot-redelivery-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

type Kind = "stashed" | "debounce" | "inFlightStart" | "deferredAfterTask";

function queueWithoutRuntime(dispatcher: RuntimeSessionDispatcher, kind: Kind, sessionName: string, prompt: object) {
  const internals = dispatcher as unknown as {
    debounceStates: Map<string, unknown>;
    inFlightStartPrompts: Map<string, unknown>;
    deferredAfterTaskStarts: Map<string, unknown>;
  };
  if (kind === "stashed") {
    dispatcher.stashedMessages.set(sessionName, [createQueuedRuntimeUserMessage(prompt as never)]);
  } else if (kind === "debounce") {
    internals.debounceStates.set(sessionName, { messages: [prompt] });
  } else if (kind === "inFlightStart") {
    internals.inFlightStartPrompts.set(sessionName, prompt);
  } else {
    internals.deferredAfterTaskStarts.set(sessionName, [prompt]);
  }
}

function hydrate(dispatcher: RuntimeSessionDispatcher, sessionName: string, payload: RuntimeLaunchPrompt) {
  return (
    dispatcher as unknown as {
      prepareDaemonRestartResumePrompt(
        requestedSessionName: string,
        prompt: RuntimeLaunchPrompt,
        sessionEntry: null,
      ): { prompt: RuntimeLaunchPrompt; messages: RuntimeUserMessage[] } | null;
    }
  ).prepareDaemonRestartResumePrompt(sessionName, payload, null);
}

describe("snapshots of sessions without a live runtime survive a graceful restart", () => {
  for (const kind of ["stashed", "debounce", "inFlightStart", "deferredAfterTask"] as const) {
    it(`${kind}: the queued message is redelivered`, async () => {
      const now = Date.now();
      const sessionKey = `agent:dev:test:nonlive-${kind}`;
      const sessionName = `nonlive-${kind}`;
      const restartEpoch = `epoch-${kind}`;
      getOrCreateSession(sessionKey, "dev", stateDir!, { name: sessionName });
      dbUpsertDaemonRestartEpoch({ restartEpoch, reason: "test", createdAt: now });
      const dispatcher = new RuntimeSessionDispatcher({
        instanceId: "test",
        maxConcurrentSessions: 10,
        interactiveReservedSessions: 0,
        safeEmit: async () => {},
        notifyRuntimeRecoveryExhausted: async () => {},
        getConfigModel: () => "test-model",
        crashRecovery: { acceptingDeliveries: true } as never,
      });
      const text = `user message waiting in ${kind}`;
      queueWithoutRuntime(dispatcher, kind, sessionName, {
        prompt: text,
        source: { channel: "whatsapp", accountId: "main", chatId: "1@g.us", actorType: "contact", contactId: "c1" },
      });

      dispatcher.recordDaemonRestartSnapshot({ restartEpoch, reason: "test", stoppedAt: now });
      const snapshot = dbListEligibleDaemonRestartSessionSnapshots({ restartEpoch, now: now + 1_000 }).find(
        (candidate) => candidate.sessionName === sessionName,
      );
      expect(snapshot?.metadata?.[RESTART_TURN_AUTHORITY_METADATA_KEY]).toEqual({ v: 1 });

      const published: RuntimeLaunchPrompt[] = [];
      const outcome = await deliverDaemonRestartSessionEvent(
        { restartEpoch, reason: "supervised_restart", sessionName, sessionKey, kind: "active", snapshot },
        {
          hasDelivery: () => false,
          markDelivered: () => undefined,
          isTerminalTaskSession: () => false,
          publish: async (_sessionName, payload) => {
            published.push(payload);
          },
          resolveSource: () => undefined,
        },
      );

      expect(outcome).toMatchObject({ status: "delivered", deliveryKind: "resume", decision: { mode: "continue" } });
      expect(published[0]?._daemonRestartResume?.noticeOnly).toBeUndefined();
      expect(String(published[0]?.prompt ?? "")).toContain("Continue de onde parou");
      const hydrated = hydrate(dispatcher, sessionName, published[0]!);
      expect(hydrated?.messages.map((message) => message.message.content)).toContain(text);
    });
  }

  it("redelivers the queued messages of a snapshot recorded without an envelope, without continuing", async () => {
    const now = Date.now();
    const sessionKey = "agent:dev:test:legacy-snapshot";
    const sessionName = "legacy-snapshot";
    const restartEpoch = "epoch-legacy";
    getOrCreateSession(sessionKey, "dev", stateDir!, { name: sessionName });
    dbUpsertDaemonRestartEpoch({ restartEpoch, reason: "test", createdAt: now });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "test",
      maxConcurrentSessions: 10,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      notifyRuntimeRecoveryExhausted: async () => {},
      getConfigModel: () => "test-model",
      crashRecovery: { acceptingDeliveries: true } as never,
    });
    const text = "message queued before the upgrade";
    queueWithoutRuntime(dispatcher, "stashed", sessionName, { prompt: text });
    dispatcher.recordDaemonRestartSnapshot({ restartEpoch, reason: "test", stoppedAt: now });
    const recorded = dbListEligibleDaemonRestartSessionSnapshots({ restartEpoch, now: now + 1_000 }).find(
      (candidate) => candidate.sessionName === sessionName,
    )!;
    // What the daemon before this release recorded: no authority key at all.
    const { [RESTART_TURN_AUTHORITY_METADATA_KEY]: _dropped, ...legacyMetadata } = recorded.metadata ?? {};

    const published: RuntimeLaunchPrompt[] = [];
    const outcome = await deliverDaemonRestartSessionEvent(
      {
        restartEpoch,
        reason: "supervised_restart",
        sessionName,
        sessionKey,
        kind: "active",
        snapshot: { ...recorded, metadata: legacyMetadata },
      },
      {
        hasDelivery: () => false,
        markDelivered: () => undefined,
        isTerminalTaskSession: () => false,
        publish: async (_sessionName, payload) => {
          published.push(payload);
        },
        resolveSource: () => undefined,
      },
    );

    expect(outcome).toMatchObject({ deliveryKind: "resume", decision: { mode: "pending_only" } });
    expect(published[0]?._daemonRestartResume?.pendingOnly).toBe(true);
    const hydrated = hydrate(dispatcher, sessionName, published[0]!);
    expect(hydrated?.messages.map((message) => message.message.content)).toEqual([text]);
  });
});
