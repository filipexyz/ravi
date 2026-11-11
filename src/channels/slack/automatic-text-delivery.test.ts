import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configStore } from "../../config-store.js";
import { deleteGuardedSession, guardedSessionForChat, upsertGuardedSession } from "../../knowledge/egress/guard.js";
import { closeKnowledgeDb } from "../../knowledge/store/db.js";
import {
  closeRouterDb,
  dbAcceptChannelBackendIngress,
  dbCreateAgent,
  dbUpsertChannel,
  dbUpsertChat,
  dbUpsertChatMessage,
  getDb,
} from "../../router/router-db.js";
import type { MessageTarget, ResponseMediaAttachment } from "../../runtime/message-types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  processChannelOutboundJob,
  channelOutboundRequestFingerprint,
  type ChannelOutboundProcessingResult,
} from "../outbound-consumer.js";
import {
  getChannelOutboundReceipt,
  pruneExpiredChannelOutboundReceipts,
  sqliteChannelOutboundReceiptStore,
} from "../outbound-receipts.js";
import {
  getChannelOutboundPublishJob,
  publishChannelOutboundJobDurably,
  saveChannelOutboundPublishJob,
} from "../outbound-publish-outbox.js";
import { buildChannelTextOutboundJob, type ChannelOutboundJob } from "../outbound-stream.js";
import type { NativeTextDelivery, NativeTextDeliveryRequest } from "../native/types.js";
import {
  createChannelBackendAutomaticOutputOrigin,
  resolveSlackAutomaticOutputContextFromBinding,
} from "./automatic-output-origin.js";
import {
  freezeSlackAutomaticTerminalManifest,
  getSlackAutomaticTerminalManifest,
} from "./automatic-terminal-manifest.js";
import { getSlackAutomaticOutputDecision, reserveSlackAutomaticOutput } from "./automatic-output-circuit.js";
import { deliverSlackAutomaticMedia } from "./automatic-media-output.js";
import { SlackTextDelivery, slackClientMessageId } from "./socket-mode.js";

let stateDir: string | null = null;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("slack-canonical-text-");
  dbCreateAgent({ id: "agent-a", name: "Agent A", cwd: stateDir });
  dbUpsertChannel({ name: "local", provider: "slack", credentialConnection: "installation-a" });
  configStore.refresh();
});
afterEach(async () => {
  closeKnowledgeDb();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

/**
 * Persists canonical ingress in the suite's prepared sandbox and optionally
 * freezes a bot terminal response. job(wrapper) varies transport identities
 * while retaining the canonical turn and destination; human provenance has
 * no automatic bot context. For bot origins, freezeManifest() supports a later
 * freeze but never replaces the captured manifest: an initially unfrozen
 * fixture keeps omitting automaticTerminalResponseId from subsequent jobs.
 */
function fixture(
  turn = "turn-a",
  freeze = true,
  threadId: string | undefined = "1.000001",
  media: ResponseMediaAttachment[] = [],
  text = "Complete answer",
  senderKind: "bot" | "user" = "bot",
) {
  const chat = dbUpsertChat({ channel: "slack", instanceId: "local", platformChatId: "C123", chatType: "group" });
  const message = dbUpsertChatMessage({
    chatId: chat.id,
    channel: "slack",
    instanceId: "local",
    providerMessageId: turn,
    rawChatId: "C123",
    actorType: "unknown",
    rawProvenance: { source: "slack.socket_mode", senderKind },
  });
  dbAcceptChannelBackendIngress({
    channelInstanceId: "local",
    idempotencyKey: turn,
    requestFingerprint: turn,
    requestId: turn,
    localActorId: "bot",
    agentId: "agent-a",
    clientMessageId: turn,
    sessionKey: "agent:agent-a:slack:local:group:C123",
    sessionName: "session-a",
    turnId: turn,
    external: {
      channelKind: "slack",
      connectionId: "local",
      conversationId: threadId ? `C123~${threadId}` : "C123",
      senderId: "B123",
      messageId: turn,
    },
    content: {},
    receivedAt: 1,
    acceptedAt: 100,
    canonical: { chatId: chat.id, messageId: message.canonicalMessageId },
  });
  const binding = {
    channelInstanceId: "local",
    agentId: "agent-a",
    chatId: chat.id,
    messageId: message.canonicalMessageId,
    sessionId: "session-a",
    turnId: turn,
  };
  const context = resolveSlackAutomaticOutputContextFromBinding(binding)!;
  const freezeManifest = () => freezeSlackAutomaticTerminalManifest({ ...context, kind: "final_answer", text, media });
  const manifest = freeze && context ? freezeManifest() : undefined;
  const job = (wrapper: string) =>
    buildChannelTextOutboundJob({
      requestId: wrapper,
      sessionName: "session-a",
      emitId: wrapper,
      idempotencyKey: wrapper,
      target: context?.target ?? {
        channel: "slack",
        accountId: "local",
        instanceId: "local",
        chatId: "C123",
        threadId,
        canonicalChatId: chat.id,
      },
      text,
      format: "markdown",
      responsePhase: "final_answer",
      automatic: createChannelBackendAutomaticOutputOrigin(binding),
      ...(manifest ? { automaticTerminalResponseId: manifest.responseId } : {}),
    });
  return { binding, context, manifest, freezeManifest, job };
}

/**
 * Creates a delivery double that records each attempt before awaiting send.
 * The optional hook can hold a claim in flight or reject; a synthetic Slack
 * receipt is returned only after it resolves. Callers must release any barrier
 * they install, and recorded requests represent attempts rather than real sends.
 */
function delivery(send?: (request: NativeTextDeliveryRequest) => Promise<void>) {
  const requests: NativeTextDeliveryRequest[] = [];
  const adapter: NativeTextDelivery = {
    channelId: "slack",
    supports: () => true,
    deliverText: mock(async (request) => {
      requests.push(request);
      await send?.(request);
      return { provider: "slack", platformMessageId: "1.000009" };
    }),
  };
  return { adapter, requests };
}
const baseOptions = {
  emitEvent: async () => {},
  flushNats: async () => {},
  recordDeliveryTrace: () => null,
  persistDeliveredMessage: () => ({}),
  knowledgeGuard: () => null,
  now: () => 101,
};

describe("frozen Slack text with a late egress guard", () => {
  const text = "Complete answer: https://synthetic-integrity.ravi.page/unmarked\nSecond line intact.";
  const conflict = "slack_bot_reply_egress_content_conflict";
  const failed = { disposition: "ack", status: "failed", retryable: false, phase: "policy", error: conflict };
  function guard() {
    upsertGuardedSession({
      sessionName: "synthetic-guard",
      agentId: "agent-a",
      instanceId: "local",
      channel: "slack",
      chatId: "C123",
      normalizedChatId: "C123",
      contactId: "synthetic-contact",
      guardedUntil: Date.now() + 60_000,
    });
    closeKnowledgeDb();
    expect(guardedSessionForChat("slack", "C123")).not.toBeNull();
  }
  function unguard() {
    deleteGuardedSession("synthetic-guard");
    closeKnowledgeDb();
  }
  /**
   * Pairs the real Slack text adapter with a fake HTTP client and restores the
   * consumer's real knowledge guard by overriding the base bypass with undefined.
   * Captures HTTP posts, emitted events and would-be persisted text separately.
   * Consumer time stays fixed; NATS, tracing and message persistence are doubles.
   * Guard installation/removal and isolated-state cleanup remain test-owned.
   */
  function transport() {
    const posts: unknown[] = [];
    const events: Record<string, unknown>[] = [];
    const texts: string[] = [];
    const adapter = new SlackTextDelivery(
      {
        postMessage: async (request: unknown) => {
          posts.push(request);
          return { ok: true, ts: "1.000009", messageId: "synthetic-message", raw: {} };
        },
      } as never,
      { subscriptionScope: "thread", threadReplyMode: "same_thread", rootReplyMode: "channel_root" },
    );
    return {
      posts,
      events,
      texts,
      options: {
        ...baseOptions,
        knowledgeGuard: undefined,
        deliveries: [adapter],
        emitEvent: async (_topic: string, event: Record<string, unknown>) => {
          events.push(event);
        },
        persistDeliveredMessage: (_job: unknown, _result: unknown, value: string) => {
          texts.push(value);
          return {};
        },
      },
    };
  }

  it("fails before sending changed frozen bytes and remains failed across wrappers, guard removal and DB reopen", async () => {
    const f = fixture("egress", true, "1.000001", [], text);
    guard();
    const t = transport();
    const key = `${f.manifest!.responseId}:text`;
    for (const wrapper of ["guarded", "guard-removed", "db-reopened"]) {
      const job = f.job(wrapper);
      saveChannelOutboundPublishJob(job, 100);
      expect(await processChannelOutboundJob(job, t.options)).toMatchObject(failed);
      expect(getChannelOutboundPublishJob(wrapper)?.status).toBe("pending");
      expect(getChannelOutboundReceipt(key)).toMatchObject({
        state: "suppressed",
        suppressionReason: conflict,
        retainIdentity: true,
      });
      expect(getChannelOutboundReceipt(key)?.sentAt).toBeUndefined();
      expect(getSlackAutomaticTerminalManifest(f.manifest!.responseId)).toEqual(f.manifest!);
      unguard();
      closeRouterDb();
    }
    expect(t.posts).toHaveLength(0);
    expect(t.texts).toHaveLength(0);
    expect(getSlackAutomaticOutputDecision(f.manifest!.responseId)).toBeNull();
    expect(t.events).toHaveLength(3);
    for (const event of t.events) {
      expect(event).toMatchObject({ status: "failed", reason: conflict, retryable: false, idempotencyKey: key });
      expect(event.policyDisposition).toBeUndefined();
    }
    const future = Date.now() + 60 * 24 * 60 * 60 * 1_000;
    expect(pruneExpiredChannelOutboundReceipts(future, future)).toBe(0);
    expect(await processChannelOutboundJob(f.job("after-prune"), t.options)).toMatchObject(failed);
    expect(t.posts).toHaveLength(0);
  });

  it("keeps the failure when claim finds a terminal receipt after a stale read", async () => {
    const f = fixture("claim-readback", true, "1.000001", [], text);
    guard();
    const t = transport();
    expect(await processChannelOutboundJob(f.job("initial"), t.options)).toMatchObject(failed);
    unguard();
    expect(
      await processChannelOutboundJob(f.job("stale-read"), {
        ...t.options,
        receiptStore: { ...sqliteChannelOutboundReceiptStore, get: () => null },
      }),
    ).toMatchObject(failed);
    expect(t.posts).toHaveLength(0);
    expect(t.events.every((event) => event.status === "failed" && event.policyDisposition === undefined)).toBe(true);
  });

  it("keeps publication success separate from terminal delivery failure on outbox replay", async () => {
    const f = fixture("outbox-egress", true, "1.000001", [], text);
    guard();
    const t = transport();
    const job = f.job("published-wrapper");
    const publisher = mock(async (published: ChannelOutboundJob) => {
      expect(await processChannelOutboundJob(published, t.options)).toMatchObject(failed);
    });
    expect(await publishChannelOutboundJobDurably(job, { publisher })).toMatchObject({
      ok: true,
      disposition: "published",
      publishedNow: true,
    });
    expect(getChannelOutboundPublishJob(job.request.idempotencyKey)?.status).toBe("published");
    unguard();
    closeRouterDb();
    expect(await publishChannelOutboundJobDurably(job, { publisher })).toMatchObject({
      ok: true,
      disposition: "published",
      publishedNow: false,
    });
    expect(publisher).toHaveBeenCalledTimes(1);
    expect(await processChannelOutboundJob(job, t.options)).toMatchObject(failed);
    expect(t.posts).toHaveLength(0);
    expect(t.events.every((event) => event.status === "failed" && !event.policyDisposition)).toBe(true);
  });

  it("keeps the publication receipt readback a failure without a policy outbox tombstone", async () => {
    const f = fixture("wrapper-readback", true, "1.000001", [], text);
    guard();
    const t = transport();
    expect(await processChannelOutboundJob(f.job("initial"), t.options)).toMatchObject(failed);
    const terminal = getChannelOutboundReceipt(`${f.manifest!.responseId}:text`)!;
    const job = f.job("wrapper-readback");
    saveChannelOutboundPublishJob(job, 100);
    // Exercise the legacy wrapper terminal readback without changing the ledger schema.
    expect(
      await processChannelOutboundJob(job, {
        ...t.options,
        receiptStore: {
          ...sqliteChannelOutboundReceiptStore,
          get: (key) =>
            key === job.request.idempotencyKey
              ? {
                  ...terminal,
                  idempotencyKey: key,
                  requestFingerprint: channelOutboundRequestFingerprint(job),
                }
              : sqliteChannelOutboundReceiptStore.get(key),
        },
      }),
    ).toMatchObject(failed);
    expect(getChannelOutboundPublishJob(job.request.idempotencyKey)?.status).toBe("pending");
    expect(t.posts).toHaveLength(0);
  });

  it("retries failed telemetry without reopening the content failure after guard removal", async () => {
    const f = fixture("telemetry", true, "1.000001", [], text);
    guard();
    const t = transport();
    expect(
      await processChannelOutboundJob(f.job("first"), {
        ...t.options,
        flushNats: async () => {
          throw new Error("synthetic telemetry unavailable");
        },
      }),
    ).toMatchObject({
      disposition: "nak",
      status: "failed",
      retryable: false,
      nakDelayMs: 2000,
      phase: "telemetry_emit",
    });
    unguard();
    closeRouterDb();
    expect(await processChannelOutboundJob(f.job("replay"), t.options)).toMatchObject(failed);
    expect(t.posts).toHaveLength(0);
    expect(
      t.events.every((event) => event.status === "failed" && event.retryable === false && !event.policyDisposition),
    ).toBe(true);
  });

  it("never sends different bytes under the same token after ambiguous provider acceptance", async () => {
    const f = fixture("ambiguous-egress", true, "1.000001", [], text);
    const t = transport();
    expect(
      await processChannelOutboundJob(f.job("accepted"), {
        ...t.options,
        claimLeaseMs: 10,
        receiptStore: {
          ...sqliteChannelOutboundReceiptStore,
          recordSent: () => {
            throw new Error("synthetic storage failure after provider acceptance");
          },
        },
      }),
    ).toMatchObject({ disposition: "nak", phase: "receipt_write" });
    expect(t.posts).toHaveLength(1);
    guard();
    expect(await processChannelOutboundJob(f.job("guarded-retry"), { ...t.options, now: () => 112 })).toMatchObject(
      failed,
    );
    unguard();
    closeRouterDb();
    expect(await processChannelOutboundJob(f.job("unguarded-retry"), { ...t.options, now: () => 123 })).toMatchObject(
      failed,
    );
    expect(t.posts).toHaveLength(1); // Acceptance of the first send remains ambiguous; no remote rollback claimed.
    expect(t.texts).toHaveLength(0);
  });

  it("resumes bookkeeping for observed original bytes without resending when the guard later changes", async () => {
    const f = fixture("sent-egress", true, "1.000001", [], text);
    const t = transport();
    expect(
      await processChannelOutboundJob(f.job("sent"), {
        ...t.options,
        persistDeliveredMessage: () => {
          throw new Error("synthetic canonical persist unavailable");
        },
      }),
    ).toMatchObject({ disposition: "nak", phase: "canonical_persist" });
    expect(getChannelOutboundReceipt(`${f.manifest!.responseId}:text`)?.state).toBe("sent");
    guard();
    closeRouterDb();
    expect(await processChannelOutboundJob(f.job("bookkeeping"), t.options)).toMatchObject({
      disposition: "ack",
      status: "delivered",
    });
    expect(t.posts).toHaveLength(1);
    expect(t.texts).toEqual([text]);
  });

  it("preserves complete safe text when the real guard is a no-op", async () => {
    const safe = "Complete safe response\nAll details preserved.";
    const f = fixture("safe-egress", true, "1.000001", [], safe);
    guard();
    const t = transport();
    expect(await processChannelOutboundJob(f.job("safe"), t.options)).toMatchObject({
      disposition: "ack",
      status: "delivered",
    });
    expect(await processChannelOutboundJob(f.job("safe-replay"), t.options)).toMatchObject({
      disposition: "ack",
      status: "delivered",
    });
    expect(t.posts).toHaveLength(1);
    expect(t.texts).toEqual([safe]);
  });

  it("still sanitizes ordinary non-frozen text with the mandatory guard", async () => {
    const job = buildChannelTextOutboundJob({
      requestId: "ordinary",
      idempotencyKey: "ordinary",
      sessionName: "session-a",
      emitId: "ordinary",
      target: { channel: "slack", instanceId: "local", accountId: "local", chatId: "C123" },
      text,
      format: "markdown",
      responsePhase: "final_answer",
    });
    guard();
    const t = transport();
    expect(await processChannelOutboundJob(job, t.options)).toMatchObject({ disposition: "ack", status: "delivered" });
    expect(t.texts).toEqual(["Complete answer: [link removido]\nSecond line intact."]);
    expect(JSON.stringify(t.posts)).not.toContain("synthetic-integrity.ravi.page");
  });

  it("preserves guarded human backend delivery without adding a bot manifest or failure", async () => {
    const f = fixture("human-egress", false, "1.000001", [], text, "user");
    expect(f.manifest).toBeUndefined();
    guard();
    const t = transport();
    expect(await processChannelOutboundJob(f.job("human"), t.options)).toMatchObject({
      disposition: "ack",
      status: "delivered",
    });
    expect(await processChannelOutboundJob(f.job("human"), t.options)).toMatchObject({
      disposition: "ack",
      status: "delivered",
    });
    expect(t.posts).toHaveLength(1);
    expect(t.texts).toEqual(["Complete answer: [link removido]\nSecond line intact."]);
    expect(JSON.stringify(t.posts)).not.toContain("synthetic-integrity.ravi.page");
  });
});

describe("canonical Slack terminal text delivery", () => {
  it("sends one text part once across different wrapper IDs and fresh consumer invocations", async () => {
    const f = fixture();
    const d = delivery();
    for (const wrapper of ["output-a", "output-b", "output-c"]) {
      const result = await processChannelOutboundJob(f.job(wrapper), { ...baseOptions, deliveries: [d.adapter] });
      expect(result.disposition).toBe("ack");
    }
    expect(d.requests).toHaveLength(1);
    expect(d.requests[0]?.idempotencyKey).toBe(`${f.manifest!.responseId}:text`);
    expect(getChannelOutboundReceipt(`${f.manifest!.responseId}:text`)?.state).toBe("complete");
    expect(getChannelOutboundReceipt("output-a")).toBeNull();
    const future = Date.now() + 60 * 24 * 60 * 60 * 1_000;
    expect(pruneExpiredChannelOutboundReceipts(future, future)).toBe(0);
    closeRouterDb();
    await processChannelOutboundJob(f.job("after-restart-and-prune"), { ...baseOptions, deliveries: [d.adapter] });
    expect(d.requests).toHaveLength(1);
  });

  it("shares a send claim when different wrappers race and resumes bookkeeping without another send", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const d = delivery(async () => gate);
    const first = processChannelOutboundJob(f.job("first"), { ...baseOptions, deliveries: [d.adapter] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await processChannelOutboundJob(f.job("second"), { ...baseOptions, deliveries: [d.adapter] });
    expect(second).toMatchObject({ disposition: "nak", phase: "receipt_claim" });
    release();
    await first;
    await processChannelOutboundJob(f.job("second"), { ...baseOptions, deliveries: [d.adapter] });
    expect(d.requests).toHaveLength(1);
  });

  it("shares one canonical send claim and Slack token across two worker processes", async () => {
    if (!stateDir) throw new Error("isolated state missing");
    const f = fixture();
    const raced = await raceTextProcesses(stateDir, [f.job("worker-a"), f.job("worker-b")]);
    expect(new Set(raced.pids).size).toBe(2);
    expect(raced.pids).not.toContain(process.pid);
    expect(raced.results).toContainEqual({ disposition: "ack", status: "delivered", retryable: false });
    expect(raced.results.find((result) => result.disposition === "nak")).toMatchObject({ phase: "receipt_claim" });
    expect(raced.posts).toHaveLength(1);
    expect(raced.posts[0]).toMatchObject({
      channel: "C123",
      threadTs: "1.000001",
      clientMsgId: slackClientMessageId(`${f.manifest!.responseId}:text`),
    });
    expect(getChannelOutboundReceipt(`${f.manifest!.responseId}:text`)).toMatchObject({
      state: "complete",
      retainIdentity: true,
    });
    for (const wrapper of ["worker-a", "worker-b"]) expect(getChannelOutboundReceipt(wrapper)).toBeNull();
    const future = Date.now() + 60 * 24 * 60 * 60 * 1_000;
    expect(pruneExpiredChannelOutboundReceipts(future, future)).toBe(0);
    closeRouterDb();
    const d = delivery();
    await processChannelOutboundJob(f.job("after-workers-exit"), { ...baseOptions, deliveries: [d.adapter] });
    expect(d.requests).toHaveLength(0);
  }, 30_000);

  it("reuses the Slack token after provider success before receipt persistence without claiming exactly-once", async () => {
    const f = fixture();
    const post = mock(async (_request: unknown) => ({ ok: true, ts: "1.000009", messageId: "message", raw: {} }));
    const adapter = new SlackTextDelivery(
      { postMessage: post } as never,
      { subscriptionScope: "thread", threadReplyMode: "same_thread", rootReplyMode: "channel_root" },
      undefined,
      { isKnowledgeGuardedChat: () => false },
    );
    const first = await processChannelOutboundJob(f.job("accepted-before-receipt"), {
      ...baseOptions,
      deliveries: [adapter],
      claimLeaseMs: 10,
      receiptStore: {
        ...sqliteChannelOutboundReceiptStore,
        recordSent: () => {
          throw new Error("receipt storage unavailable after provider success");
        },
      },
    });
    expect(first).toMatchObject({ disposition: "nak", phase: "receipt_write" });
    expect(getChannelOutboundReceipt(`${f.manifest!.responseId}:text`)?.state).toBe("claimed");
    closeRouterDb();
    const second = await processChannelOutboundJob(f.job("ambiguous-retry"), {
      ...baseOptions,
      deliveries: [adapter],
      now: () => 112,
    });
    expect(second).toMatchObject({ disposition: "ack", status: "delivered" });
    // Slack's acceptance-before-receipt window can produce a second call. Only
    // the stable provider token is guaranteed here, not remote exactly-once.
    expect(post).toHaveBeenCalledTimes(2);
    for (const [request] of post.mock.calls) {
      expect(request).toMatchObject({ clientMsgId: slackClientMessageId(`${f.manifest!.responseId}:text`) });
    }
  });

  it("keeps publication suppression keyed by the original wrapper while sharing the terminal receipt", async () => {
    const f = fixture();
    for (let i = 0; i < 4; i++)
      reserveSlackAutomaticOutput({
        idempotencyKey: `previous-${i}`,
        requestFingerprint: `previous-${i}`,
        scope: f.context.scope,
        sourceId: `input-${i}`,
        sourceReceivedAt: 1,
        now: 100,
      });
    const d = delivery();
    for (const wrapper of ["suppressed-a", "suppressed-b"]) {
      const job = f.job(wrapper);
      const savedPublication = saveChannelOutboundPublishJob(job, 100);
      const result = await processChannelOutboundJob(job, { ...baseOptions, deliveries: [d.adapter] });
      expect(result).toMatchObject({ disposition: "ack", status: "dropped" });
      expect(getChannelOutboundPublishJob(wrapper)).toMatchObject({
        status: "suppressed",
        requestFingerprint: savedPublication.requestFingerprint,
      });
    }
    expect(getChannelOutboundReceipt(`${f.manifest!.responseId}:text`)?.state).toBe("suppressed");
    expect(getChannelOutboundReceipt(`${f.manifest!.responseId}:text`)?.requestFingerprint).not.toBe(
      channelOutboundRequestFingerprint(f.job("suppressed-a")),
    );
    expect(d.requests).toHaveLength(0);
  });

  it("does not revive a wrapper suppressed before a manifest existed", async () => {
    const f = fixture("late-manifest", false);
    const job = f.job("early-output");
    const d = delivery();
    expect(await processChannelOutboundJob(job, { ...baseOptions, deliveries: [d.adapter] })).toMatchObject({
      status: "dropped",
    });
    f.freezeManifest();
    expect(await processChannelOutboundJob(job, { ...baseOptions, deliveries: [d.adapter] })).toMatchObject({
      status: "dropped",
    });
    expect(d.requests).toHaveLength(0);
  });

  it("honors the frozen thread after the replacement adapter switches to channel_root", async () => {
    const f = fixture();
    const post = mock(async (_request: unknown) => ({ ok: true, ts: "1.000009", messageId: "message", raw: {} }));
    const adapter = new SlackTextDelivery(
      { postMessage: post } as never,
      { subscriptionScope: "thread", threadReplyMode: "channel_root", rootReplyMode: "channel_root" },
      undefined,
      { isKnowledgeGuardedChat: () => false },
    );
    await processChannelOutboundJob(f.job("thread-output"), { ...baseOptions, deliveries: [adapter] });
    expect(post.mock.calls[0]?.[0]).toMatchObject({ channel: "C123", threadTs: "1.000001" });
    const explicit = f.job("explicit");
    delete explicit.request.origin.automatic;
    delete explicit.request.origin.automaticTerminalResponseId;
    explicit.request.policyHints = { _trustedFrozenTarget: true };
    (explicit.request as unknown as Record<string, unknown>)._trustedFrozenTarget = true;
    explicit.request.target = { ...explicit.request.target, ...{ _trustedFrozenTarget: true } };
    await processChannelOutboundJob(explicit, { ...baseOptions, deliveries: [adapter] });
    expect((post.mock.calls[1]?.[0] as { threadTs?: string })?.threadTs).toBeUndefined();
  });

  it("keeps a frozen root destination on a replacement same_thread adapter", async () => {
    const f = fixture("root-turn", true, "");
    const post = mock(async (_request: unknown) => ({ ok: true, ts: "1.000009", messageId: "message", raw: {} }));
    const adapter = new SlackTextDelivery(
      { postMessage: post } as never,
      { subscriptionScope: "thread", threadReplyMode: "same_thread", rootReplyMode: "new_thread" },
      undefined,
      { isKnowledgeGuardedChat: () => false },
    );
    await processChannelOutboundJob(f.job("root-output"), { ...baseOptions, deliveries: [adapter] });
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0]?.[0] as { threadTs?: string })?.threadTs).toBeUndefined();
    const changed = f.job("forged-thread");
    changed.request.target = { ...changed.request.target, threadId: "9.999999" };
    changed.request.targetThreadId = "9.999999";
    (changed.request as unknown as Record<string, unknown>)._trustedFrozenTarget = true;
    expect(await processChannelOutboundJob(changed, { ...baseOptions, deliveries: [adapter] })).toMatchObject({
      status: "dropped",
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  for (const frozenThread of ["1.000001", ""]) {
    for (const order of ["text-first", "media-first"] as const) {
      it(`keeps text and media at the frozen ${frozenThread ? "thread" : "root"} after database reopen and reply-policy change (${order})`, async () => {
        if (!stateDir) throw new Error("isolated state missing");
        const turn = `mixed-${frozenThread ? "thread" : "root"}-${order}`;
        const multipart = Boolean(frozenThread) && order === "media-first";
        const paragraphs = multipart
          ? Array.from({ length: 450 }, (_, index) => `Response paragraph ${index}: ${"full content ".repeat(20)}`)
          : ["Complete answer"];
        const media: ResponseMediaAttachment[] = Array.from({ length: multipart ? 2 : 1 }, (_, index) => ({
          type: "document",
          filePath: join(stateDir!, `${turn}-${index}.txt`),
          filename: `${turn}-${index}.txt`,
          caption: `Complete attachment ${index}`,
          source: "runtime.generated_media",
        }));
        for (const part of media) writeFileSync(part.filePath, `Complete attachment bytes for ${part.filename}`);
        const f = fixture(turn, true, frozenThread, media, paragraphs.join("\n\n"));
        const manifest = f.manifest!;
        expect(getSlackAutomaticOutputDecision(manifest.responseId)).toBeNull();
        const originalDb = getDb();
        closeRouterDb();
        expect(getDb()).not.toBe(originalDb);
        configStore.refresh();
        expect(getSlackAutomaticTerminalManifest(manifest.responseId)?.target).toEqual(manifest.target);

        const observed: Array<{ kind: "text" | "media"; channel: string; thread?: string }> = [];
        const post = mock(
          async (request: { channel: string; threadTs?: string; blocks?: Array<{ text?: string }> }) => {
            observed.push({ kind: "text", channel: request.channel, thread: request.threadTs });
            return { ok: true, ts: "1.000009", messageId: "message", raw: {} };
          },
        );
        const sendText = async () => {
          // The persisted ingress/manifest contains the old effective policy.
          // The replacement adapter now applies the opposite reply policy.
          const adapter = new SlackTextDelivery(
            { postMessage: post } as never,
            frozenThread
              ? { subscriptionScope: "thread", threadReplyMode: "channel_root", rootReplyMode: "channel_root" }
              : { subscriptionScope: "thread", threadReplyMode: "same_thread", rootReplyMode: "new_thread" },
            undefined,
            { isKnowledgeGuardedChat: () => false },
          );
          expect(
            await processChannelOutboundJob(f.job(`${turn}-text`), {
              ...baseOptions,
              deliveries: [adapter],
            }),
          ).toMatchObject({ disposition: "ack", status: "delivered" });
        };
        const send = mock(
          async ({
            target,
            media: part,
            fileBytes,
          }: {
            target: MessageTarget;
            media: ResponseMediaAttachment;
            fileBytes: Buffer;
          }) => {
            expect(target).toEqual(manifest.target);
            expect(fileBytes).toEqual(Buffer.from(`Complete attachment bytes for ${part.filename}`));
            observed.push({ kind: "media", channel: target.chatId, thread: target.threadId });
            return { fileId: `F-${part.filename}`, messageId: "1.000010" };
          },
        );
        const sendMedia = async () => {
          for (const [mediaIndex, part] of media.entries()) {
            expect(
              await deliverSlackAutomaticMedia(
                {
                  sessionName: "session-a",
                  response: {
                    _automaticOutputOrigin: createChannelBackendAutomaticOutputOrigin(f.binding),
                    _automaticTerminalResponseId: manifest.responseId,
                  },
                  target: manifest.target,
                  media: part,
                  originalMedia: part,
                  mediaIndex,
                },
                {
                  send,
                  emitDelivery: async () => {},
                  flushTelemetry: async () => {},
                  now: () => 101,
                },
              ),
            ).toMatchObject({
              handled: true,
              status: "delivered",
              idempotencyKey: `${manifest.responseId}:media:${mediaIndex}`,
            });
          }
        };
        const assertOneTerminalDecision = () => {
          expect(getSlackAutomaticOutputDecision(manifest.responseId)).toEqual({ status: "allowed", decidedAt: 101 });
          expect(
            getDb()
              .prepare("SELECT idempotency_key, status FROM slack_automatic_output_decisions WHERE scope = ?")
              .all(manifest.scope),
          ).toEqual([{ idempotency_key: manifest.responseId, status: "allowed" }]);
        };
        const steps = order === "text-first" ? [sendText, sendMedia] : [sendMedia, sendText];
        await steps[0]!();
        assertOneTerminalDecision();
        closeRouterDb();
        configStore.refresh();
        await steps[1]!();
        assertOneTerminalDecision();
        const textPostCount = post.mock.calls.length;
        if (multipart) expect(textPostCount).toBeGreaterThan(4);
        else expect(textPostCount).toBe(1);
        const deliveredBody = post.mock.calls
          .flatMap(([request]) => request.blocks ?? [])
          .map((block) => block.text)
          .join("\n\n");
        for (const paragraph of paragraphs) expect(deliveredBody).toContain(paragraph.trim());
        const textParts = Array.from({ length: textPostCount }, () => "text" as const);
        const mediaParts = media.map(() => "media" as const);
        expect(observed).toEqual(
          (order === "text-first" ? [...textParts, ...mediaParts] : [...mediaParts, ...textParts]).map((kind) => ({
            kind,
            channel: "C123",
            thread: frozenThread || undefined,
          })),
        );
        for (const part of ["text", ...media.map((_, index) => `media:${index}`)]) {
          expect(getChannelOutboundReceipt(`${manifest.responseId}:${part}`)?.state).toBe("complete");
        }
        closeRouterDb();
        await sendText();
        await sendMedia();
        assertOneTerminalDecision();
        expect(post).toHaveBeenCalledTimes(textPostCount);
        expect(send).toHaveBeenCalledTimes(media.length);
      });
    }
  }

  it("resumes failed telemetry under another wrapper without resending the retained part", async () => {
    const f = fixture();
    const d = delivery();
    const first = await processChannelOutboundJob(f.job("first-telemetry"), {
      ...baseOptions,
      deliveries: [d.adapter],
      emitEvent: async () => {
        throw new Error("Disconnected");
      },
    });
    expect(first).toMatchObject({ disposition: "nak", phase: "telemetry_emit" });
    closeRouterDb();
    const emitEvent = mock(async (_topic: string, _payload: unknown) => {});
    const second = await processChannelOutboundJob(f.job("next-telemetry"), {
      ...baseOptions,
      deliveries: [d.adapter],
      emitEvent,
    });
    expect(second).toMatchObject({ disposition: "ack", status: "delivered" });
    expect(d.requests).toHaveLength(1);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        idempotencyKey: `${f.manifest!.responseId}:text`,
        publicationIdempotencyKey: "next-telemetry",
        jobId: "next-telemetry",
      }),
    );
  });

  it("rejects a different source session or canonical chat without poisoning the real part", async () => {
    const f = fixture();
    const d = delivery();
    const otherSession = f.job("wrong-session");
    otherSession.request.origin.sessionName = "another-session";
    const otherChat = f.job("wrong-canonical-chat");
    otherChat.request.target = { ...otherChat.request.target, canonicalChatId: "another-canonical-chat" };
    for (const job of [otherSession, otherChat]) {
      expect(await processChannelOutboundJob(job, { ...baseOptions, deliveries: [d.adapter] })).toMatchObject({
        status: "dropped",
      });
    }
    expect(d.requests).toHaveLength(0);
    await processChannelOutboundJob(f.job("valid"), { ...baseOptions, deliveries: [d.adapter] });
    expect(d.requests).toHaveLength(1);
  });
});

/**
 * Runs real consumers and Slack text adapters in separate Bun processes against
 * caller-owned isolated state, using a fixed consumer clock and fake HTTP.
 * Requires an unused worker directory. Readiness and transport barriers expose
 * overlapping claims before releasing simulated posts; their waits are bounded.
 * Returns worker PIDs, results and captured posts. Finally kills and awaits
 * remaining children; shared-state teardown belongs to the caller.
 */
async function raceTextProcesses(stateDir: string, jobs: ChannelOutboundJob[]) {
  const runDir = join(stateDir, "canonical-text-workers");
  const isolatedHome = join(runDir, "home");
  mkdirSync(isolatedHome, { recursive: true });
  const fixturePath = join(runDir, "worker.test.ts");
  const preload = fileURLToPath(new URL("../../test/isolated-runtime-preload.ts", import.meta.url));
  writeFileSync(
    fixturePath,
    `import { test, expect, mock } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
const config = JSON.parse(process.env.TEST_CANONICAL_TEXT_WORKER);
const actualOs = { ...(await import("node:os")) };
mock.module("node:os", () => ({ ...actualOs, homedir: () => config.home }));
process.env.RAVI_STATE_DIR = config.stateDir;
async function waitFor(path) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(existsSync(path)).toBe(true);
}
test("deliver from a separate consumer process", async () => {
  const { processChannelOutboundJob } = await import(${JSON.stringify(new URL("../outbound-consumer.ts", import.meta.url).href)});
  const { SlackTextDelivery } = await import(${JSON.stringify(new URL("./socket-mode.ts", import.meta.url).href)});
  const { configStore } = await import(${JSON.stringify(new URL("../../config-store.ts", import.meta.url).href)});
  const router = await import(${JSON.stringify(new URL("../../router/router-db.ts", import.meta.url).href)});
  try {
    configStore.refresh();
    const adapter = new SlackTextDelivery({ postMessage: async (request) => {
      writeFileSync(config.sent, JSON.stringify(request));
      await waitFor(config.release);
      return { ok: true, ts: "1.000009", messageId: "message", raw: {} };
    } }, { subscriptionScope: "thread", threadReplyMode: "same_thread", rootReplyMode: "channel_root" },
      undefined, { isKnowledgeGuardedChat: () => false });
    writeFileSync(config.ready, String(process.pid));
    await waitFor(config.start);
    const result = await processChannelOutboundJob(config.job, {
      deliveries: [adapter], emitEvent: async () => {}, flushNats: async () => {},
      recordDeliveryTrace: () => null, persistDeliveredMessage: () => ({}),
      knowledgeGuard: () => null, now: () => 101,
    });
    writeFileSync(config.result, JSON.stringify(result));
  } finally { router.closeRouterDb(); }
}, 20000);
`,
  );
  const start = join(runDir, "start");
  const release = join(runDir, "release");
  const workers = jobs.map((job, index) => {
    const ready = join(runDir, `ready-${index}`);
    const sent = join(runDir, `sent-${index}.json`);
    const result = join(runDir, `result-${index}.json`);
    const child = spawn(process.execPath, ["test", "--preload", preload, fixturePath], {
      env: {
        ...process.env,
        TEST_CANONICAL_TEXT_WORKER: JSON.stringify({
          stateDir,
          home: isolatedHome,
          ready,
          sent,
          result,
          start,
          release,
          job,
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (chunk) => {
      log += chunk;
    });
    child.stderr.on("data", (chunk) => {
      log += chunk;
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Text worker failed (${code}): ${log}`))));
    });
    void exited.catch(() => {});
    return { child, ready, sent, result, exited };
  });
  const waitUntil = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!predicate() && Date.now() < deadline) {
      for (const worker of workers) if (worker.child.exitCode !== null) await worker.exited;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(predicate()).toBe(true);
  };
  try {
    await waitUntil(() => workers.every((worker) => existsSync(worker.ready)));
    writeFileSync(start, "start");
    // Keep the successful provider call open until the other process has either
    // returned its claim result or exposed an erroneous second provider call.
    await waitUntil(() => workers.every((worker) => existsSync(worker.sent) || existsSync(worker.result)));
    writeFileSync(release, "release");
    await Promise.all(workers.map((worker) => worker.exited));
    return {
      pids: workers.map((worker) => Number(readFileSync(worker.ready, "utf8"))),
      results: workers.map(
        (worker) => JSON.parse(readFileSync(worker.result, "utf8")) as ChannelOutboundProcessingResult,
      ),
      posts: workers
        .filter((worker) => existsSync(worker.sent))
        .map((worker) => JSON.parse(readFileSync(worker.sent, "utf8")) as { clientMsgId?: string }),
    };
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
    await Promise.allSettled(workers.map((worker) => worker.exited));
  }
}
