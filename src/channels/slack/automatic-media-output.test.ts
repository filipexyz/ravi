import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configStore } from "../../config-store.js";
import * as natsModule from "../../nats.js";
import {
  closeRouterDb,
  dbAcceptChannelBackendIngress,
  dbCreateAgent,
  dbUpsertChannel,
  dbUpsertChat,
  dbUpsertChatMessage,
  getDb,
  type ChannelBackendIngressReceiptRecord,
  type ChatMessageRecord,
} from "../../router/router-db.js";
import type { ChannelBackendPromptMetadata, ResponseMediaAttachment } from "../../runtime/message-types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { getChannelOutboundReceipt, sqliteChannelOutboundReceiptStore } from "../outbound-receipts.js";
import { deliverSlackAutomaticMedia, type SlackAutomaticMediaInput } from "./automatic-media-output.js";
import { getSlackAutomaticOutputDecision, reserveSlackAutomaticOutput } from "./automatic-output-circuit.js";
import * as automaticOutputCircuit from "./automatic-output-circuit.js";
import {
  createChannelBackendAutomaticOutputOrigin,
  resolveSlackAutomaticOutputContextFromBinding,
  type SlackAutomaticOutputOriginDependencies,
} from "./automatic-output-origin.js";
import {
  assertSlackAutomaticTerminalPart,
  freezeSlackAutomaticTerminalManifest,
  getSlackAutomaticTerminalManifest,
} from "./automatic-terminal-manifest.js";
import { sendSlackMedia } from "./media.js";
import * as slackMedia from "./media.js";
import * as automaticMediaOutput from "./automatic-media-output.js";
import type { ResponseMessage } from "../../runtime/message-types.js";

const WINDOW_MS = 300_000;
let stateDir: string | null = null;
let time = 10_000;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("slack-automatic-media-");
  time = 10_000;
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

/**
 * Combines mutable ingress/message doubles with real temporary media files and
 * a persisted terminal manifest for resolved bot origins. The suite supplies
 * and cleans isolated state; distinct indexes separate synthetic turns.
 * Duplicate media retains separate ordinals, while unavailable media is removed
 * before freezing. Human provenance leaves the manifest absent. input(part)
 * preserves the selected descriptor and ordinal; ingress itself is not persisted.
 */
function fixture(index = 1, senderKind: "bot" | "user" = "bot", duplicateMedia = false, unavailableMedia = false) {
  const binding: ChannelBackendPromptMetadata["binding"] = {
    channelInstanceId: "local",
    agentId: "agent-a",
    chatId: "chat-a",
    messageId: `input-${index}`,
    sessionId: "session-a",
    turnId: `turn-${index}`,
  };
  const receipt: ChannelBackendIngressReceiptRecord = {
    id: `ingress-${index}`,
    channelInstanceId: "local",
    idempotencyKey: `ingress-key-${index}`,
    requestFingerprint: `input-fingerprint-${index}`,
    initialRequestId: `request-${index}`,
    localActorId: "unlinked",
    agentId: binding.agentId,
    chatId: binding.chatId,
    messageId: binding.messageId,
    sessionKey: "agent:agent-a:slack:local:group:C123",
    sessionName: binding.sessionId,
    turnId: binding.turnId,
    external: {
      channelKind: "slack",
      connectionId: "local",
      conversationId: "C123~1.000001",
      senderId: "BEXTERNAL",
      messageId: `1.00000${index}`,
    },
    state: "published",
    acceptedAt: time,
    updatedAt: time,
  };
  const message: ChatMessageRecord = {
    id: binding.messageId,
    chatId: binding.chatId,
    channel: "slack",
    instanceId: "local",
    providerMessageId: receipt.external.messageId,
    rawChatId: "C123",
    actorType: "unknown",
    rawProvenance: { source: "slack.socket_mode", senderKind },
    ingestedAt: time,
    createdAt: time,
    updatedAt: time,
  };
  const originDependencies: SlackAutomaticOutputOriginDependencies = {
    getReceipt: (turnId) => (turnId === binding.turnId ? receipt : null),
    getMessage: (messageId) => (messageId === binding.messageId ? message : null),
    resolveAccount: (accountId) => ({
      kind: "native",
      accountId,
      instanceId: accountId === "other" ? "other" : "local",
      provider: "slack",
      channelName: accountId === "other" ? "other" : "local",
      credentialConfigured: true,
      channel: {
        name: accountId === "other" ? "other" : "local",
        provider: "slack",
        credentialConnection: accountId === "other" ? "installation-b" : "installation-a",
        createdAt: 1,
        updatedAt: 1,
      },
    }),
  };
  const target = {
    channel: "slack",
    accountId: "local",
    instanceId: "local",
    chatId: "C123",
    threadId: "1.000001",
    canonicalChatId: "chat-a",
  };
  const media: ResponseMediaAttachment[] = ["a", "b"].map((name) => ({
    type: "image",
    filePath: join(stateDir!, `${index}-${name}.png`),
    filename: `${name}.png`,
    caption: `Original ${name}`,
    idempotencyKey: `${index}-${name}`,
    source: "runtime.generated_media",
  }));
  for (const part of media) writeFileSync(part.filePath, `Original bytes ${part.filename}`);
  if (duplicateMedia) media[1] = { ...media[0]! };
  if (unavailableMedia) unlinkSync(media[0]!.filePath);
  const origin = resolveSlackAutomaticOutputContextFromBinding(binding, originDependencies);
  const manifest = origin
    ? freezeSlackAutomaticTerminalManifest({ ...origin, kind: "final_answer", text: "Complete final", media })
    : undefined;
  const input = (part = 0): SlackAutomaticMediaInput => ({
    sessionName: binding.sessionId,
    response: {
      _automaticOutputOrigin: createChannelBackendAutomaticOutputOrigin(binding),
      ...(manifest ? { _automaticTerminalResponseId: manifest.responseId } : {}),
    },
    target,
    media: media[part]!,
    originalMedia: media[part]!,
    mediaIndex: part,
  });
  return { input, manifest, media, originDependencies, receipt, message };
}

function callbacks(originDependencies: SlackAutomaticOutputOriginDependencies) {
  return {
    originDependencies,
    now: () => time,
    send: mock(async ({ media }: { media: ResponseMediaAttachment }) => ({
      fileId: `F-${media.idempotencyKey}`,
      messageId: "1.123456",
    })),
    emitDelivery: mock(async (_data: Record<string, unknown>) => {}),
    flushTelemetry: mock(async () => {}),
  };
}

/**
 * Persists canonical bot ingress and freezes a media manifest using real origin
 * resolution in the suite's isolated state. Requires its agent/channel setup;
 * failed admission or unresolved bot origin throws immediately.
 * index separates turns and count defines media ordinals. unavailable removes
 * the first file before freezing and therefore requires count > 0. Returns
 * ordinal-based inputs and part keys; suite teardown owns files and state.
 */
function gatewayFixture(index = 1, count = 1, unavailable = false) {
  const chat = dbUpsertChat({ channel: "slack", instanceId: "local", platformChatId: "C123", chatType: "group" });
  const message = dbUpsertChatMessage({
    chatId: chat.id,
    channel: "slack",
    instanceId: "local",
    providerMessageId: `1.${String(index).padStart(6, "0")}`,
    rawChatId: "C123",
    actorType: "unknown",
    rawProvenance: { source: "slack.socket_mode", senderKind: "bot" },
  });
  const ingress = dbAcceptChannelBackendIngress({
    channelInstanceId: "local",
    idempotencyKey: `input-${index}`,
    requestFingerprint: `request-${index}`,
    requestId: `request-${index}`,
    localActorId: "unlinked",
    agentId: "agent-a",
    clientMessageId: `client-${index}`,
    sessionKey: "agent:agent-a:slack:local:group:C123",
    sessionName: "session-a",
    turnId: `turn-${index}`,
    external: {
      channelKind: "slack",
      connectionId: "local",
      conversationId: "C123~1.000001",
      senderId: "BEXTERNAL",
      messageId: `1.${String(index).padStart(6, "0")}`,
    },
    content: {},
    receivedAt: time,
    acceptedAt: time,
    canonical: { chatId: chat.id, messageId: message.canonicalMessageId },
  });
  if (ingress.status !== "accepted") throw new Error("Test ingress was not accepted");
  const binding = {
    channelInstanceId: ingress.receipt.channelInstanceId,
    agentId: ingress.receipt.agentId,
    chatId: ingress.receipt.chatId,
    messageId: ingress.receipt.messageId,
    sessionId: ingress.receipt.sessionName,
    turnId: ingress.receipt.turnId,
  };
  const context = resolveSlackAutomaticOutputContextFromBinding(binding);
  if (!context) throw new Error("Test bot origin was not resolved");
  const media: ResponseMediaAttachment[] = Array.from({ length: count }, (_, ordinal) => ({
    type: "image",
    filePath: join(stateDir!, `gateway-${index}-${ordinal}.png`),
    filename: `gateway-${index}-${ordinal}.png`,
    idempotencyKey: `gateway-media-${index}-${ordinal}`,
    source: "runtime.generated_media",
  }));
  for (const part of media) writeFileSync(part.filePath, `Original bytes ${part.filename}`);
  if (unavailable) unlinkSync(media[0]!.filePath);
  const manifest = freezeSlackAutomaticTerminalManifest({ ...context, kind: "final_answer", text: "", media });
  const response: ResponseMessage = {
    _emitId: `gateway-wrapper-${index}`,
    _automaticOutputOrigin: createChannelBackendAutomaticOutputOrigin(binding),
    _automaticTerminalResponseId: manifest.responseId,
    target: context.target,
    content: media.map((part) => ({ type: "media", media: part })),
  };
  const input = (ordinal = 0): SlackAutomaticMediaInput => ({
    sessionName: binding.sessionId,
    response,
    target: context.target,
    media: media[ordinal]!,
    originalMedia: media[ordinal]!,
    mediaIndex: ordinal,
  });
  const key = (ordinal = 0) =>
    assertSlackAutomaticTerminalPart(manifest, { type: "media", index: ordinal, media: media[ordinal]! });
  return { manifest, media, response, input, key };
}

async function realGateway() {
  const { Gateway } = await import("../../gateway.js");
  const events: Array<Record<string, unknown>> = [];
  const gateway = new Gateway({
    omniSender: {} as never,
    omniConsumer: {} as never,
    emitEvent: async (_topic, data) => {
      events.push(data as Record<string, unknown>);
    },
  });
  const handle = (response: ResponseMessage) =>
    (
      gateway as unknown as { handleResponseEvent(sessionName: string, response: ResponseMessage): Promise<void> }
    ).handleResponseEvent("session-a", response);
  return { events, handle };
}

describe("native bot automatic media terminal delivery", () => {
  /** Exhausts response admission without sending any media. */
  function exhaustAdmission(scope: string) {
    for (let index = 0; index < 4; index++) {
      reserveSlackAutomaticOutput({
        idempotencyKey: `prior-${index}`,
        requestFingerprint: `prior-${index}`,
        scope,
        sourceId: `source-${index}`,
        sourceReceivedAt: time,
        now: time,
      });
    }
  }

  /** A real SQLite fault leaves the durable no-send decision and claimed receipt intact. */
  function rejectSuppressionWrites() {
    sqliteChannelOutboundReceiptStore.get("initialize-schema");
    getDb().exec(`CREATE TRIGGER reject_media_suppression
      BEFORE UPDATE OF state ON channel_outbound_receipts
      WHEN NEW.state = 'suppressed'
      BEGIN SELECT RAISE(ABORT, 'temporary suppression write failure'); END;`);
  }

  for (const reopen of [false, true]) {
    for (const staleRead of [false, true]) {
      it(`recovers no-send suppression after ${reopen ? "expiry and SQLite reopen" : "immediate retry"} through ${staleRead ? "a stale read" : "receipt lookup"}`, async () => {
        const f = fixture();
        const deps = callbacks(f.originDependencies);
        const bytes = f.media.map((media) => readFileSync(media.filePath));
        exhaustAdmission(f.manifest!.scope);
        expect(await deliverSlackAutomaticMedia(f.input(1), deps)).toMatchObject({ status: "suppressed" });
        const siblingKey = assertSlackAutomaticTerminalPart(f.manifest!, {
          type: "media",
          index: 1,
          media: f.media[1]!,
        });
        const sibling = getChannelOutboundReceipt(siblingKey);
        rejectSuppressionWrites();
        const first = await deliverSlackAutomaticMedia(f.input(), deps);
        expect(first).toMatchObject({ status: "failed", reason: "slack_media_suppression_persist", retryable: true });
        if (!first.handled || !first.idempotencyKey) throw new Error("Missing media identity");
        const receipt = getChannelOutboundReceipt(first.idempotencyKey)!;
        const decision = getSlackAutomaticOutputDecision(f.manifest!.responseId);
        expect(receipt).toMatchObject({ state: "claimed", resendProhibited: true });
        expect(decision?.status).toBe("suppressed");
        getDb().exec("DROP TRIGGER reject_media_suppression");
        if (reopen) {
          time += WINDOW_MS * 2 + 1;
          closeRouterDb();
        }
        const recovered = await deliverSlackAutomaticMedia(f.input(), {
          ...deps,
          ...(staleRead ? { receiptStore: { ...sqliteChannelOutboundReceiptStore, get: () => null } } : {}),
        });
        expect(recovered).toMatchObject({
          status: "suppressed",
          reason: "slack_bot_reply_cooldown",
          retryable: false,
          idempotencyKey: first.idempotencyKey,
        });
        const tombstone = getChannelOutboundReceipt(first.idempotencyKey)!;
        expect(tombstone).toMatchObject({
          state: "suppressed",
          suppressionReason: "slack_bot_reply_cooldown",
          resendProhibited: true,
          idempotencyKey: receipt.idempotencyKey,
          requestFingerprint: receipt.requestFingerprint,
          jobId: receipt.jobId,
          requestId: receipt.requestId,
          createdAt: receipt.createdAt,
        });
        expect(tombstone.claimOwner).toBeUndefined();
        expect(tombstone.claimExpiresAt).toBeUndefined();
        expect(tombstone.sentAt).toBeUndefined();
        expect(tombstone.deliveryMessageId).toBeUndefined();
        expect(tombstone.persistedAt).toBeUndefined();
        expect(getChannelOutboundReceipt(siblingKey)).toEqual(sibling);
        expect(getSlackAutomaticOutputDecision(f.manifest!.responseId)).toEqual(decision);
        expect(getSlackAutomaticTerminalManifest(f.manifest!.responseId)).toEqual(f.manifest!);
        expect(f.media.map((media) => readFileSync(media.filePath))).toEqual(bytes);
        expect(deps.send).toHaveBeenCalledTimes(0);
        closeRouterDb();
        expect(await deliverSlackAutomaticMedia(f.input(), deps)).toEqual(recovered);
        expect(getChannelOutboundReceipt(first.idempotencyKey)).toEqual(tombstone);
      });
    }
  }

  it("keeps no-send suppression retryable through persistent SQLite faults without losing its owner", async () => {
    const f = fixture();
    const deps = callbacks(f.originDependencies);
    exhaustAdmission(f.manifest!.scope);
    rejectSuppressionWrites();
    const first = await deliverSlackAutomaticMedia(f.input(), deps);
    expect(first).toMatchObject({ status: "failed", reason: "slack_media_suppression_persist", retryable: true });
    if (!first.handled || !first.idempotencyKey) throw new Error("Missing media identity");
    const receipt = getChannelOutboundReceipt(first.idempotencyKey);
    for (const reopen of [false, true]) {
      if (reopen) {
        time += WINDOW_MS * 2 + 1;
        closeRouterDb();
      }
      expect(await deliverSlackAutomaticMedia(f.input(), deps)).toEqual(first);
      expect(getChannelOutboundReceipt(first.idempotencyKey)).toEqual(receipt);
    }
    getDb().exec("DROP TRIGGER reject_media_suppression");
    expect(await deliverSlackAutomaticMedia(f.input(), deps)).toMatchObject({ status: "suppressed" });
    expect(deps.send).toHaveBeenCalledTimes(0);
  });

  for (const lookup of ["getSlackAutomaticOutputDecision", "reserveSlackAutomaticOutput"] as const) {
    it(`retains pending or unknown when no-send proof fails at ${lookup}`, async () => {
      const f = fixture();
      const deps = callbacks(f.originDependencies);
      exhaustAdmission(f.manifest!.scope);
      rejectSuppressionWrites();
      const first = await deliverSlackAutomaticMedia(f.input(), deps);
      if (!first.handled || !first.idempotencyKey) throw new Error("Missing media identity");
      getDb().exec("DROP TRIGGER reject_media_suppression");
      const receipt = getChannelOutboundReceipt(first.idempotencyKey);
      for (const reopen of [false, true]) {
        if (reopen) {
          time += WINDOW_MS * 2 + 1;
          closeRouterDb();
        }
        const unavailable = spyOn(automaticOutputCircuit, lookup).mockImplementation(() => {
          throw new Error("durable admission unavailable");
        });
        try {
          expect(await deliverSlackAutomaticMedia(f.input(), deps)).toMatchObject({
            status: reopen ? "unknown" : "pending",
            retryable: !reopen,
          });
          expect(getChannelOutboundReceipt(first.idempotencyKey)).toEqual(receipt);
        } finally {
          unavailable.mockRestore();
        }
      }
      expect(await deliverSlackAutomaticMedia(f.input(), deps)).toMatchObject({ status: "suppressed" });
      expect(deps.send).toHaveBeenCalledTimes(0);
    });
  }

  it("does not overwrite a changed owner while recovering no-send suppression", async () => {
    const f = fixture();
    const deps = callbacks(f.originDependencies);
    exhaustAdmission(f.manifest!.scope);
    rejectSuppressionWrites();
    const first = await deliverSlackAutomaticMedia(f.input(), deps);
    if (!first.handled || !first.idempotencyKey) throw new Error("Missing media identity");
    getDb().exec("DROP TRIGGER reject_media_suppression");
    const markSuppressed = mock((input: Parameters<typeof sqliteChannelOutboundReceiptStore.markSuppressed>[0]) => {
      getDb()
        .prepare("UPDATE channel_outbound_receipts SET claim_owner = ? WHERE idempotency_key = ?")
        .run("replacement-owner", input.idempotencyKey);
      return sqliteChannelOutboundReceiptStore.markSuppressed(input);
    });
    expect(
      await deliverSlackAutomaticMedia(f.input(), {
        ...deps,
        receiptStore: { ...sqliteChannelOutboundReceiptStore, markSuppressed },
      }),
    ).toMatchObject({ status: "failed", reason: "slack_media_suppression_persist", retryable: true });
    expect(markSuppressed).toHaveBeenCalledTimes(1);
    expect(getChannelOutboundReceipt(first.idempotencyKey)).toMatchObject({
      state: "claimed",
      claimOwner: "replacement-owner",
    });
    expect(await deliverSlackAutomaticMedia(f.input(), deps)).toMatchObject({ status: "suppressed" });
    expect(deps.send).toHaveBeenCalledTimes(0);
  });

  for (const phase of ["send", "receipt_write"] as const) {
    it(`never reconciles an ambiguous ${phase} claim as no-send suppression`, async () => {
      const f = fixture();
      const deps = callbacks(f.originDependencies);
      exhaustAdmission(f.manifest!.scope);
      rejectSuppressionWrites();
      const first = await deliverSlackAutomaticMedia(f.input(), deps);
      if (!first.handled || !first.idempotencyKey) throw new Error("Missing media identity");
      getDb().exec("DROP TRIGGER reject_media_suppression");
      sqliteChannelOutboundReceiptStore.recordError(first.idempotencyKey, phase, "ambiguous send evidence", time);
      const receipt = getChannelOutboundReceipt(first.idempotencyKey);
      for (const reopen of [false, true]) {
        if (reopen) {
          time += WINDOW_MS * 2 + 1;
          closeRouterDb();
        }
        expect(await deliverSlackAutomaticMedia(f.input(), deps)).toMatchObject({
          status: "unknown",
          reason: "slack_media_delivery_unknown",
          retryable: false,
        });
        expect(getChannelOutboundReceipt(first.idempotencyKey)).toEqual(receipt);
      }
      expect(deps.send).toHaveBeenCalledTimes(0);
    });
  }

  it("rejects a conflicting durable decision before reconciling no-send suppression", async () => {
    const f = fixture();
    const deps = callbacks(f.originDependencies);
    exhaustAdmission(f.manifest!.scope);
    rejectSuppressionWrites();
    const first = await deliverSlackAutomaticMedia(f.input(), deps);
    if (!first.handled || !first.idempotencyKey) throw new Error("Missing media identity");
    getDb().exec("DROP TRIGGER reject_media_suppression");
    // The key-only decision lookup is not proof that this manifest owns it.
    getDb()
      .prepare("UPDATE slack_automatic_output_decisions SET request_fingerprint = ? WHERE idempotency_key = ?")
      .run("another-manifest", f.manifest!.responseId);
    const receipt = getChannelOutboundReceipt(first.idempotencyKey);
    expect(await deliverSlackAutomaticMedia(f.input(), deps)).toMatchObject({
      status: "failed",
      reason: "slack_bot_reply_identity_conflict",
      retryable: false,
    });
    expect(getChannelOutboundReceipt(first.idempotencyKey)).toEqual(receipt);
    expect(deps.send).toHaveBeenCalledTimes(0);
  });

  it("reports a frozen unavailable member as terminal failed while sending valid siblings, without revival", async () => {
    const f = fixture(1, "bot", false, true);
    const deps = callbacks(f.originDependencies);
    expect(await deliverSlackAutomaticMedia(f.input(0), deps)).toMatchObject({
      status: "failed",
      reason: "slack_bot_reply_media_unavailable",
      retryable: false,
    });
    expect(deps.send).toHaveBeenCalledTimes(0);
    expect(await deliverSlackAutomaticMedia(f.input(1), deps)).toMatchObject({ status: "delivered" });
    expect(deps.send).toHaveBeenCalledTimes(1);
    writeFileSync(f.media[0]!.filePath, "the missing member reappeared");
    closeRouterDb();
    expect(await deliverSlackAutomaticMedia(f.input(0), deps)).toMatchObject({
      status: "failed",
      reason: "slack_bot_reply_media_unavailable",
      retryable: false,
    });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.emitDelivery.mock.calls.filter(([event]) => event.status === "delivered")).toHaveLength(1);
  });

  it("gateway keeps a shared source file until every declared media ordinal has completed", async () => {
    const f = fixture(1, "bot", true);
    const observedOrdinals: number[] = [];
    const spy = spyOn(automaticMediaOutput, "deliverSlackAutomaticMedia").mockImplementation(async (input) => {
      expect(existsSync(input.originalMedia.filePath)).toBe(true);
      expect(input.originalMedia.voiceNote).toBe(false);
      observedOrdinals.push(input.mediaIndex);
      return { handled: true, status: "delivered", newlySent: false, retryable: false };
    });
    try {
      const { Gateway } = await import("../../gateway.js");
      const gateway = new Gateway({ omniSender: {} as never, omniConsumer: {} as never, emitEvent: async () => {} });
      const response: ResponseMessage = {
        ...f.input().response,
        _emitId: "frozen-bundle",
        target: f.input().target,
        content: f.media.map((media) => ({ type: "media", media: { ...media, voiceNote: false } })),
      };
      await (
        gateway as unknown as { handleResponseEvent(session: string, response: ResponseMessage): Promise<void> }
      ).handleResponseEvent("missing-test-session", response);
      expect(observedOrdinals).toEqual([0, 1]);
      expect(existsSync(f.media[0]!.filePath)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  for (const receiptPath of ["read", "claim"] as const) {
    it(`keeps changed media bytes failed across ${receiptPath} replay and SQLite reopen without revival`, async () => {
      const f = fixture();
      const deps = callbacks(f.originDependencies);
      const input = f.input();
      const originalBytes = readFileSync(input.media.filePath);
      writeFileSync(input.media.filePath, "changed actual content, same file name and idempotency key");
      const first = await deliverSlackAutomaticMedia(input, deps);
      expect(first).toMatchObject({
        status: "failed",
        reason: "slack_bot_reply_media_content_conflict",
        retryable: false,
      });
      expect(deps.send).toHaveBeenCalledTimes(0);
      const partId = assertSlackAutomaticTerminalPart(f.manifest!, {
        type: "media",
        index: 0,
        media: input.originalMedia,
      });
      const receipt = getChannelOutboundReceipt(partId);
      expect(receipt).toMatchObject({
        state: "suppressed",
        suppressionReason: "slack_bot_reply_media_content_conflict",
      });
      expect(receipt?.sentAt).toBeUndefined();
      expect(receipt?.deliveryMessageId).toBeUndefined();
      // A stale pre-claim read must preserve the same terminal outcome as a
      // direct receipt read; the real SQLite claim still finds the tombstone.
      const replayDeps = {
        ...deps,
        ...(receiptPath === "claim" ? { receiptStore: { ...sqliteChannelOutboundReceiptStore, get: () => null } } : {}),
      };
      expect(await deliverSlackAutomaticMedia(input, replayDeps)).toEqual(first);
      expect(getChannelOutboundReceipt(partId)).toEqual(receipt);
      closeRouterDb();
      time += WINDOW_MS * 2 + 1;
      writeFileSync(input.media.filePath, originalBytes);
      expect(await deliverSlackAutomaticMedia(input, replayDeps)).toEqual(first);
      expect(getChannelOutboundReceipt(partId)).toEqual(receipt);
      expect(deps.emitDelivery).toHaveBeenCalledTimes(3);
      for (const [event] of deps.emitDelivery.mock.calls) {
        expect(event).toMatchObject({
          status: "failed",
          reason: "slack_bot_reply_media_content_conflict",
          retryable: false,
          idempotencyKey: partId,
        });
        expect(event.policyDisposition).toBeUndefined();
      }
      for (const phase of ["emitDelivery", "flushTelemetry"] as const) {
        expect(
          await deliverSlackAutomaticMedia(input, {
            ...replayDeps,
            [phase]: async () => {
              throw new Error("telemetry unavailable");
            },
          }),
        ).toEqual(first);
        expect(getChannelOutboundReceipt(partId)).toEqual(receipt);
      }
      expect(existsSync(input.media.filePath)).toBe(true);
      expect(deps.send).toHaveBeenCalledTimes(0);
    });
  }

  it("delivers identical descriptors at distinct ordinals and retries each canonical part independently", async () => {
    const f = fixture(1, "bot", true);
    const deps = callbacks(f.originDependencies);
    const results = await Promise.all([
      deliverSlackAutomaticMedia(f.input(0), deps),
      deliverSlackAutomaticMedia(f.input(1), deps),
    ]);
    expect(results.every((result) => result.handled && result.status === "delivered")).toBe(true);
    expect(new Set(results.map((result) => (result.handled ? result.idempotencyKey : undefined))).size).toBe(2);
    expect(deps.send).toHaveBeenCalledTimes(2);
    closeRouterDb();
    unlinkSync(f.media[0]!.filePath);
    for (const part of [0, 1])
      expect(await deliverSlackAutomaticMedia(f.input(part), deps)).toMatchObject({
        status: "delivered",
        newlySent: false,
      });
    expect(deps.send).toHaveBeenCalledTimes(2);
    expect(
      (getDb().prepare("SELECT COUNT(*) AS count FROM slack_automatic_output_decisions").get() as { count: number })
        .count,
    ).toBe(1);
  });

  it("passes the exact verified buffer to Slack even if the source path changes after verification", async () => {
    const f = fixture();
    const uploaded: Uint8Array[] = [];
    const deps = {
      ...callbacks(f.originDependencies),
      /**
       * Changes the source file after verification, then passes the verified buffer
       * to the real Slack uploader. The fetch double simulates allocation, upload and
       * completion and checks upload-body identity against that buffer, exposing any
       * late path reread without making an external Slack request.
       */
      send: async ({ media, fileBytes }: { media: ResponseMediaAttachment; fileBytes: Buffer }) => {
        writeFileSync(media.filePath, "changed between verification and transport");
        return sendSlackMedia(
          { accountId: "local", chatId: "C123", filePath: media.filePath, fileBytes, filename: media.filename },
          {
            channels: {
              local: { name: "local", provider: "slack", credentialConnection: "local", createdAt: 1, updatedAt: 1 },
            },
            resolveSecret: async () => ({
              secret: JSON.stringify({ appToken: "xapp-fixture", botToken: "xoxb-fixture" }),
            }),
            fetchImpl: (async (url, init) => {
              if (String(url).endsWith("files.getUploadURLExternal"))
                return Response.json({ ok: true, upload_url: "https://upload.test/file", file_id: "FVERIFIED" });
              if (String(url) === "https://upload.test/file") {
                uploaded.push(init!.body as Uint8Array);
                expect(init!.body).toBe(fileBytes);
                return new Response("ok");
              }
              return Response.json({ ok: true, files: [{ id: "FVERIFIED" }] });
            }) as typeof fetch,
          },
        );
      },
    };
    expect(await deliverSlackAutomaticMedia(f.input(), deps)).toMatchObject({ status: "delivered" });
    expect(uploaded).toHaveLength(1);
    expect(Buffer.from(uploaded[0]!).toString()).toBe("Original bytes a.png");
  });

  it("shares each text response's single decision across every attachment without a per-file debit", async () => {
    let uploads = 0;
    for (let index = 1; index <= 5; index++) {
      const f = fixture(index);
      const deps = callbacks(f.originDependencies);
      // This is the same decision the real terminal text consumer reserves.
      const terminal = reserveSlackAutomaticOutput({
        idempotencyKey: f.manifest!.responseId,
        requestFingerprint: f.manifest!.requestFingerprint,
        scope: f.manifest!.scope,
        sourceId: f.manifest!.sourceId,
        sourceReceivedAt: f.manifest!.sourceReceivedAt,
        now: time,
      });
      const parts = await Promise.all([
        deliverSlackAutomaticMedia(f.input(0), deps),
        deliverSlackAutomaticMedia(f.input(1), deps),
      ]);
      const allowed = index <= 4;
      expect(terminal.status).toBe(allowed ? "allowed" : "suppressed");
      expect(parts).toEqual([
        expect.objectContaining({ handled: true, status: allowed ? "delivered" : "suppressed" }),
        expect.objectContaining({ handled: true, status: allowed ? "delivered" : "suppressed" }),
      ]);
      expect(deps.send).toHaveBeenCalledTimes(allowed ? 2 : 0);
      for (const [event] of deps.emitDelivery.mock.calls) {
        expect(event.status).toBe(allowed ? "delivered" : "dropped");
        if (!allowed) expect(event.fileId).toBeUndefined();
      }
      uploads += deps.send.mock.calls.length;
      expect(getSlackAutomaticOutputDecision(f.manifest!.responseId)).toEqual(terminal);
    }
    expect(uploads).toBe(8);
    expect(
      (getDb().prepare("SELECT COUNT(*) AS count FROM slack_automatic_output_decisions").get() as { count: number })
        .count,
    ).toBe(5);
  });

  it("serializes duplicate media across workers and resumes completed receipts after reopening SQLite", async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = {
      ...callbacks(f.originDependencies),
      send: mock(async () => {
        await pending;
        return { fileId: "FONCE" };
      }),
    };
    const first = deliverSlackAutomaticMedia(f.input(), deps);
    const second = await deliverSlackAutomaticMedia(f.input(), deps);
    expect(second).toMatchObject({ handled: true, status: "pending", retryable: true });
    expect(deps.send).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toMatchObject({ status: "delivered", newlySent: true });
    closeRouterDb();
    expect(await deliverSlackAutomaticMedia(f.input(), deps)).toMatchObject({ status: "delivered", newlySent: false });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.emitDelivery.mock.calls.filter(([event]) => event.status === "delivered")).toHaveLength(1);
  });

  it("persists the provider file before telemetry and resumes failed bookkeeping without uploading again", async () => {
    const f = fixture();
    const partId = assertSlackAutomaticTerminalPart(f.manifest!, { type: "media", index: 0, media: f.media[0]! });
    let failTelemetry = true;
    const deps = {
      ...callbacks(f.originDependencies),
      emitDelivery: mock(async () => {
        expect(getChannelOutboundReceipt(partId)).toMatchObject({ state: "persisted", deliveryMessageId: "F-1-a" });
        if (failTelemetry) throw new Error("telemetry unavailable");
      }),
    };
    expect(await deliverSlackAutomaticMedia(f.input(), deps)).toMatchObject({
      status: "failed",
      reason: "slack_media_bookkeeping",
      retryable: true,
    });
    closeRouterDb();
    unlinkSync(f.media[0]!.filePath);
    failTelemetry = false;
    expect(await deliverSlackAutomaticMedia(f.input(), deps)).toMatchObject({ status: "delivered", newlySent: false });
    expect(getChannelOutboundReceipt(partId)?.state).toBe("complete");
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it("never takes over an expired in-flight upload, while allowing its original owner to record success", async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = {
      ...callbacks(f.originDependencies),
      send: mock(async () => {
        await pending;
        return { fileId: "FLATE" };
      }),
    };
    const first = deliverSlackAutomaticMedia(f.input(), deps);
    time += WINDOW_MS + 1;
    // Simulate a different worker whose pre-transaction read was stale. The
    // atomic claim must refuse takeover independently of the helper's read.
    const repeated = await deliverSlackAutomaticMedia(f.input(), {
      ...deps,
      send: mock(async () => ({ fileId: "FMUSTNOTUPLOAD" })),
      receiptStore: { ...sqliteChannelOutboundReceiptStore, get: () => null },
    });
    expect(repeated).toMatchObject({ status: "unknown", reason: "slack_media_delivery_unknown", retryable: false });
    expect(deps.send).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toMatchObject({ status: "delivered" });
    expect(await deliverSlackAutomaticMedia(f.input(), deps)).toMatchObject({ status: "delivered", newlySent: false });
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  for (const fault of ["upload", "receipt"] as const) {
    it(`keeps ${fault} ambiguity durable across immediate retry, expiry and restart`, async () => {
      const f = fixture();
      const base = callbacks(f.originDependencies);
      const deps = {
        ...base,
        send: mock(async () => {
          if (fault === "upload") throw new Error("connection lost");
          return { fileId: "FSENT" };
        }),
        ...(fault === "receipt"
          ? {
              receiptStore: {
                ...sqliteChannelOutboundReceiptStore,
                recordSent: () => {
                  throw new Error("SQLite write failed");
                },
              },
            }
          : {}),
      };
      expect(await deliverSlackAutomaticMedia(f.input(), deps)).toMatchObject({ status: "unknown", retryable: false });
      expect(
        await deliverSlackAutomaticMedia(f.input(), { ...deps, receiptStore: sqliteChannelOutboundReceiptStore }),
      ).toMatchObject({ status: "unknown", retryable: false });
      time += WINDOW_MS + 1;
      closeRouterDb();
      expect(
        await deliverSlackAutomaticMedia(f.input(), { ...deps, receiptStore: sqliteChannelOutboundReceiptStore }),
      ).toMatchObject({ status: "unknown", retryable: false });
      expect(deps.send).toHaveBeenCalledTimes(1);
      const partId = assertSlackAutomaticTerminalPart(f.manifest!, { type: "media", index: 0, media: f.media[0]! });
      expect(getChannelOutboundReceipt(partId)).toMatchObject({
        state: "claimed",
        lastErrorPhase: fault === "upload" ? "send" : "receipt_write",
      });
    });
  }

  it("never revives suppressed old attachments and permits new work after the fixed cooldown", async () => {
    for (let i = 1; i <= 4; i++) {
      const f = fixture(i);
      await deliverSlackAutomaticMedia(f.input(), callbacks(f.originDependencies));
    }
    const f = fixture(5);
    const deps = callbacks(f.originDependencies);
    expect(await deliverSlackAutomaticMedia(f.input(0), deps)).toMatchObject({ status: "suppressed" });
    const decision = getSlackAutomaticOutputDecision(f.manifest!.responseId)!;
    time += 30_000;
    expect(await deliverSlackAutomaticMedia(f.input(1), deps)).toMatchObject({ status: "suppressed" });
    expect(getSlackAutomaticOutputDecision(f.manifest!.responseId)).toEqual(decision);
    closeRouterDb();
    time = decision.recoverAt! + 1;
    for (const part of [0, 1])
      expect(await deliverSlackAutomaticMedia(f.input(part), deps)).toMatchObject({ status: "suppressed" });
    expect(deps.send).toHaveBeenCalledTimes(0);
    const fresh = fixture(6);
    const freshDeps = callbacks(fresh.originDependencies);
    expect(await deliverSlackAutomaticMedia(fresh.input(), freshDeps)).toMatchObject({ status: "delivered" });
    expect(freshDeps.send).toHaveBeenCalledTimes(1);
  });

  it("validates the original frozen descriptor before a caption redaction and rejects escaped destinations or appended files", async () => {
    const f = fixture();
    const deps = callbacks(f.originDependencies);
    const input = f.input();
    for (const target of [
      { ...input.target, chatId: "COTHER" },
      { ...input.target, threadId: "2.000001" },
      { ...input.target, accountId: "other", instanceId: "other" },
    ])
      expect(await deliverSlackAutomaticMedia({ ...input, target }, deps)).toMatchObject({ status: "failed" });
    const appended = { ...input.media, filePath: "/generated/new.png" };
    expect(
      await deliverSlackAutomaticMedia({ ...input, media: appended, originalMedia: appended }, deps),
    ).toMatchObject({ status: "failed" });
    expect(await deliverSlackAutomaticMedia({ ...input, media: appended }, deps)).toMatchObject({ status: "failed" });
    expect(
      await deliverSlackAutomaticMedia(
        { ...input, response: { ...input.response, _automaticTerminalResponseId: "different" } },
        deps,
      ),
    ).toMatchObject({ status: "failed" });
    expect(deps.send).toHaveBeenCalledTimes(0);
    expect(
      await deliverSlackAutomaticMedia({ ...input, media: { ...input.media, caption: "[redacted]" } }, deps),
    ).toMatchObject({ status: "delivered" });
    expect(deps.send.mock.calls[0]?.[0].media.caption).toBe("[redacted]");
  });

  it("leaves explicit sends and unknown human media on their existing authority and delivery paths", async () => {
    const bot = fixture();
    const deps = callbacks(bot.originDependencies);
    expect(await deliverSlackAutomaticMedia({ ...bot.input(), response: {} }, deps)).toEqual({ handled: false });
    const human = fixture(2, "user");
    const humanDeps = callbacks(human.originDependencies);
    expect(await deliverSlackAutomaticMedia(human.input(), humanDeps)).toEqual({ handled: false });
    expect(deps.send).toHaveBeenCalledTimes(0);
    expect(humanDeps.send).toHaveBeenCalledTimes(0);
  });
});

describe("native bot automatic media through the real gateway", () => {
  let sendSpy: ReturnType<typeof spyOn>;
  let flushSpy: ReturnType<typeof spyOn>;
  const uploads: Array<{ filename: string | undefined; bytes: Buffer }> = [];

  beforeEach(() => {
    time = Date.now();
    uploads.length = 0;
    dbCreateAgent({ id: "agent-a", name: "Test agent", cwd: stateDir! });
    dbUpsertChannel({ name: "local", provider: "slack", credentialConnection: "test-installation" });
    configStore.refresh();
    flushSpy = spyOn(natsModule, "flushNats").mockResolvedValue(undefined);
    sendSpy = spyOn(slackMedia, "sendSlackMedia").mockImplementation(async (input, dependencies) => {
      expect(dependencies).toEqual({ authority: { kind: "internal-service", service: "slack-delivery" } });
      if (!input.fileBytes) throw new Error("Expected the verified buffer at the Slack boundary");
      uploads.push({ filename: input.filename, bytes: Buffer.from(input.fileBytes) });
      return {
        transport: "slack-native",
        provider: "slack",
        success: true,
        status: "sent",
        fileId: `F-GATEWAY-${uploads.length}`,
        messageId: "1.123456",
        raw: { ok: true },
      };
    });
  });
  afterEach(() => {
    sendSpy.mockRestore();
    flushSpy.mockRestore();
  });

  it("retains a conflicted bundle across replay and SQLite reopen without resending its valid sibling", async () => {
    const f = gatewayFixture(1, 2);
    const originalBytes = f.media.map((part) => readFileSync(part.filePath));
    writeFileSync(f.media[0]!.filePath, "Changed bytes under the frozen descriptor");
    const first = await realGateway();
    await first.handle(f.response);
    expect(first.events.map((event) => event.status)).toEqual(["failed", "delivered"]);
    expect(first.events[0]).toMatchObject({
      status: "failed",
      reason: "slack_bot_reply_media_content_conflict",
      retryable: false,
      idempotencyKey: f.key(),
    });
    expect(first.events[0]!.policyDisposition).toBeUndefined();
    expect(f.media.map((part) => existsSync(part.filePath))).toEqual([true, true]);
    expect(uploads).toEqual([{ filename: f.media[1]!.filename, bytes: originalBytes[1] }]);
    const receipts = f.media.map((_, ordinal) => getChannelOutboundReceipt(f.key(ordinal)));
    expect(receipts[0]).toMatchObject({
      state: "suppressed",
      suppressionReason: "slack_bot_reply_media_content_conflict",
    });
    expect(receipts[0]?.sentAt).toBeUndefined();
    expect(receipts[0]?.deliveryMessageId).toBeUndefined();
    expect(receipts[1]?.state).toBe("complete");

    // Replay the same wrapper, then a new wrapper after SQLite reopen. Neither
    // restoring original bytes nor completed sibling receipts may erase failure.
    for (const reopen of [false, true]) {
      if (reopen) {
        closeRouterDb();
        writeFileSync(f.media[0]!.filePath, originalBytes[0]!);
      }
      const repeated = await realGateway();
      await repeated.handle({ ...f.response, ...(reopen ? { _emitId: "gateway-conflict-replay" } : {}) });
      expect(repeated.events).toHaveLength(1);
      expect(repeated.events[0]).toMatchObject({
        status: "failed",
        reason: "slack_bot_reply_media_content_conflict",
        retryable: false,
        idempotencyKey: f.key(),
      });
      expect(repeated.events[0]!.policyDisposition).toBeUndefined();
      expect(f.media.map((part) => existsSync(part.filePath))).toEqual([true, true]);
      expect(f.media.map((_, ordinal) => getChannelOutboundReceipt(f.key(ordinal)))).toEqual(receipts);
    }
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("replays a completed receipt after gateway cleanup without requiring the source file or uploading again", async () => {
    const f = gatewayFixture();
    const originalBytes = readFileSync(f.media[0]!.filePath);
    const first = await realGateway();
    await first.handle(f.response);
    expect(first.events.map((event) => event.status)).toEqual(["delivered"]);
    expect(uploads).toEqual([{ filename: f.media[0]!.filename, bytes: originalBytes }]);
    expect(existsSync(f.media[0]!.filePath)).toBe(false);
    const receipt = getChannelOutboundReceipt(f.key());
    expect(receipt?.state).toBe("complete");
    closeRouterDb();
    const repeated = await realGateway();
    await repeated.handle({ ...f.response, _emitId: "gateway-complete-replay" });
    expect(repeated.events).toHaveLength(0);
    expect(getChannelOutboundReceipt(f.key())).toEqual(receipt);
    const send = mock(async () => ({ fileId: "FMUSTNOTUPLOAD" }));
    expect(
      await deliverSlackAutomaticMedia(f.input(), {
        send,
        emitDelivery: async () => {},
        now: () => time + WINDOW_MS * 2,
      }),
    ).toMatchObject({ status: "delivered", newlySent: false, retryable: false });
    expect(send).toHaveBeenCalledTimes(0);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps unavailable-at-freeze media failed when its source file later appears", async () => {
    const f = gatewayFixture(1, 1, true);
    const first = await realGateway();
    await first.handle(f.response);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      status: "failed",
      reason: "slack_bot_reply_media_unavailable",
      retryable: false,
    });
    expect(first.events[0]!.policyDisposition).toBeUndefined();
    writeFileSync(f.media[0]!.filePath, "File appeared after freeze");
    closeRouterDb();
    const repeated = await realGateway();
    await repeated.handle({ ...f.response, _emitId: "gateway-unavailable-replay" });
    expect(repeated.events).toHaveLength(1);
    expect(repeated.events[0]).toMatchObject({
      status: "failed",
      reason: "slack_bot_reply_media_unavailable",
      retryable: false,
    });
    expect(repeated.events[0]!.policyDisposition).toBeUndefined();
    expect(existsSync(f.media[0]!.filePath)).toBe(true);
    expect(getChannelOutboundReceipt(f.key())).toBeNull();
    expect(sendSpy).toHaveBeenCalledTimes(0);
  });

  it("preserves legitimate cooldown suppression across gateway cleanup and SQLite reopen", async () => {
    for (let index = 1; index <= 4; index++) {
      const { manifest } = gatewayFixture(index);
      expect(
        reserveSlackAutomaticOutput({
          idempotencyKey: manifest.responseId,
          requestFingerprint: manifest.requestFingerprint,
          scope: manifest.scope,
          sourceId: manifest.sourceId,
          sourceReceivedAt: manifest.sourceReceivedAt,
          now: time,
        }).status,
      ).toBe("allowed");
    }
    const f = gatewayFixture(5);
    const first = await realGateway();
    await first.handle(f.response);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      status: "dropped",
      reason: "slack_bot_reply_cooldown",
      policyDisposition: "suppressed",
      retryable: false,
    });
    expect(existsSync(f.media[0]!.filePath)).toBe(false);
    const receipt = getChannelOutboundReceipt(f.key());
    expect(receipt).toMatchObject({ state: "suppressed", suppressionReason: "slack_bot_reply_cooldown" });
    closeRouterDb();
    const repeated = await realGateway();
    await repeated.handle({ ...f.response, _emitId: "gateway-cooldown-replay" });
    expect(repeated.events).toHaveLength(1);
    expect(repeated.events[0]).toMatchObject({
      status: "dropped",
      reason: "slack_bot_reply_cooldown",
      policyDisposition: "suppressed",
      retryable: false,
    });
    const send = mock(async () => ({ fileId: "FMUSTNOTUPLOAD" }));
    expect(
      await deliverSlackAutomaticMedia(f.input(), {
        send,
        emitDelivery: async () => {},
        now: () => time + WINDOW_MS * 2,
      }),
    ).toMatchObject({ status: "suppressed", reason: "slack_bot_reply_cooldown", retryable: false });
    expect(getChannelOutboundReceipt(f.key())).toEqual(receipt);
    expect(getSlackAutomaticOutputDecision(f.manifest.responseId)?.status).toBe("suppressed");
    expect(send).toHaveBeenCalledTimes(0);
    expect(sendSpy).toHaveBeenCalledTimes(0);
  });
});
