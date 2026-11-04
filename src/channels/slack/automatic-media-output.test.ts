import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeRouterDb,
  getDb,
  type ChannelBackendIngressReceiptRecord,
  type ChatMessageRecord,
} from "../../router/router-db.js";
import type { ChannelBackendPromptMetadata, ResponseMediaAttachment } from "../../runtime/message-types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { getChannelOutboundReceipt, sqliteChannelOutboundReceiptStore } from "../outbound-receipts.js";
import { deliverSlackAutomaticMedia, type SlackAutomaticMediaInput } from "./automatic-media-output.js";
import { getSlackAutomaticOutputDecision, reserveSlackAutomaticOutput } from "./automatic-output-circuit.js";
import {
  createChannelBackendAutomaticOutputOrigin,
  resolveSlackAutomaticOutputContextFromBinding,
  type SlackAutomaticOutputOriginDependencies,
} from "./automatic-output-origin.js";
import {
  assertSlackAutomaticTerminalPart,
  freezeSlackAutomaticTerminalManifest,
} from "./automatic-terminal-manifest.js";
import { sendSlackMedia } from "./media.js";
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

describe("native bot automatic media terminal delivery", () => {
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

  it("rejects changed media bytes before upload even when its path and declared content-hash identity stay equal", async () => {
    const f = fixture();
    const deps = callbacks(f.originDependencies);
    const input = f.input();
    writeFileSync(input.media.filePath, "changed actual content, same file name and idempotency key");
    expect(await deliverSlackAutomaticMedia(input, deps)).toMatchObject({
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
    expect(getChannelOutboundReceipt(partId)).toMatchObject({
      state: "suppressed",
      suppressionReason: "slack_bot_reply_media_content_conflict",
    });
    expect(await deliverSlackAutomaticMedia(input, deps)).toMatchObject({ status: "suppressed" });
    expect(deps.send).toHaveBeenCalledTimes(0);
  });

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
