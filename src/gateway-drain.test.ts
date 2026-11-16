import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Gateway } from "./gateway.js";
import { AsyncResource } from "node:async_hooks";
import type { TrackedWorkDrain } from "./runtime/work-drain.js";
import { nats } from "./nats.js";
import * as lifecycle from "./channels/slack/thread-lifecycle.js";
import * as outbox from "./channels/outbound-publish-outbox.js";
import * as readiness from "./channels/native-readiness.js";
import { configStore } from "./config-store.js";
import type { ResponseMediaAttachment, ResponseMessage } from "./runtime/message-types.js";
import * as slackMedia from "./channels/slack/media.js";
import * as slackText from "./channels/slack/text-send.js";
import * as accountResolution from "./channels/account-resolution.js";
import * as automaticMedia from "./channels/slack/automatic-media-output.js";
import * as tts from "./audio/tts.js";
import * as channelTrace from "./session-trace/channel-trace.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function gatewayHarness() {
  const gateway = new Gateway({ omniSender: {} as never, omniConsumer: {} as never });
  const internals = gateway as unknown as {
    running: boolean;
    subscribe(key: string, topics: string[], handler: () => Promise<void>): void;
    reconcileSlackThreads(): Promise<void>;
  };
  internals.running = true;
  return { gateway, internals };
}

function textResponseHarness(send: () => Promise<{ messageId?: string }> = async () => ({})) {
  const gateway = new Gateway({ omniSender: { send } as never, omniConsumer: {} as never });
  const internals = gateway as unknown as {
    running: boolean;
    subscribe(key: string, topics: string[], handler: () => Promise<void>): void;
    deliverResponseTextPart(
      sessionName: string,
      response: ResponseMessage,
      target: NonNullable<ResponseMessage["target"]>,
      text: string,
      partIndex: number,
      totalParts: number,
      knowledgeGuard: null,
    ): Promise<void>;
    prepareOutboundMentionMessage(input: { text: string }): Promise<{ text: string }>;
    saveOutboundMessageActorMetadata(): void;
    recordOutboundContactInteraction(): void;
    schedulePostDeliveryPresenceRenewal(): void;
    emitDeliveryEvent(sessionName: string, response: ResponseMessage, data: Record<string, unknown>): Promise<void>;
    emitTtsForResponse(
      sessionName: string,
      response: ResponseMessage,
      text: string,
      target: NonNullable<ResponseMessage["target"]>,
    ): Promise<void>;
  };
  internals.running = true;
  const releaseSubscription = deferred();
  const delivery = spyOn(internals, "emitDeliveryEvent").mockResolvedValue(undefined);
  const tts = spyOn(internals, "emitTtsForResponse").mockResolvedValue(undefined);
  const spies = [
    delivery,
    tts,
    spyOn(configStore, "resolveInstanceId").mockReturnValue("drain-instance"),
    spyOn(readiness, "warnIfNativeOutboundUndeliverable").mockReturnValue(null),
    spyOn(internals, "prepareOutboundMentionMessage").mockImplementation(async ({ text }) => ({ text })),
    spyOn(internals, "saveOutboundMessageActorMetadata").mockImplementation(() => {}),
    spyOn(internals, "recordOutboundContactInteraction").mockImplementation(() => {}),
    spyOn(internals, "schedulePostDeliveryPresenceRenewal").mockImplementation(() => {}),
    spyOn(nats, "subscribe").mockImplementation(
      () =>
        (async function* () {
          yield { topic: "test.response", data: {} };
          await releaseSubscription.promise;
        })() as never,
    ),
  ];
  return {
    gateway,
    delivery,
    tts,
    admit(channel = "matrix") {
      const completed = deferred();
      const target = { channel, accountId: "drain-account", chatId: "drain-chat" };
      const response = { _emitId: "drain-response", response: "accepted reply", target };
      internals.subscribe("response-test", ["test.response"], async () => {
        await internals.deliverResponseTextPart("drain-session", response, target, response.response, 0, 1, null);
        completed.resolve();
      });
      return completed.promise;
    },
    restore() {
      internals.running = false;
      releaseSubscription.resolve();
      for (const spy of spies) spy.mockRestore();
    },
  };
}

function actionHarness() {
  const emit = mock(async (_topic: string, _payload: Record<string, unknown>) => {});
  const failedSend = mock(async () => {
    throw new Error("provider rejected accepted work");
  });
  const gateway = new Gateway({
    omniSender: {
      send: failedSend,
      sendReaction: failedSend,
      editMessage: failedSend,
      deleteMessage: failedSend,
      sendMedia: failedSend,
      sendSticker: failedSend,
    } as never,
    omniConsumer: {} as never,
    emitEvent: emit,
  });
  const internals = gateway as unknown as {
    running: boolean;
    subscribe(key: string, topics: string[], handler: () => Promise<void>): void;
    subscribeToTts(): void;
    subscribeToStickerSend(): void;
    deliverResponseMediaPart(
      sessionName: string,
      response: ResponseMessage,
      target: NonNullable<ResponseMessage["target"]>,
      media: ResponseMediaAttachment,
      partIndex: number,
    ): Promise<ResponseMediaAttachment | undefined>;
    handleDirectSendEvent(data: Record<string, unknown>): Promise<void>;
    handleMediaSendEvent(data: Record<string, unknown>): Promise<void>;
    handleReactionEvent(data: Record<string, unknown>): Promise<void>;
    handleMessageDeleteEvent(data: Record<string, unknown>): Promise<void>;
    handleMessageEditEvent(data: Record<string, unknown>): Promise<void>;
    handleApprovalFinalizationEvent(data: Record<string, unknown>): Promise<void>;
    recordResponseTrace(sessionName: string, response: ResponseMessage): void;
    recordOutboundContactInteraction(): void;
    schedulePostDeliveryPresenceRenewal(): void;
  };
  internals.running = true;
  const release = deferred();
  const subscribed = spyOn(nats, "subscribe").mockImplementation(
    () =>
      (async function* () {
        yield {
          topic: "test.action",
          data: { channel: "whatsapp", accountId: "account", chatId: "chat", filePath: "file" },
        };
        await release.promise;
      })() as never,
  );
  const account = spyOn(accountResolution, "resolveOutboundAccount").mockReturnValue({
    kind: "omni",
    accountId: "account",
    instanceId: "instance",
  });
  const contact = spyOn(internals, "recordOutboundContactInteraction").mockImplementation(() => {});
  const presence = spyOn(internals, "schedulePostDeliveryPresenceRenewal").mockImplementation(() => {});
  return {
    gateway,
    internals,
    emit,
    account,
    failedSend,
    async admit(work: () => unknown) {
      await new Promise<void>((resolve, reject) => {
        internals.subscribe("action-test", ["test.action"], async () => {
          try {
            await work();
            resolve();
          } catch (error) {
            reject(error);
            throw error;
          }
        });
      });
    },
    native() {
      account.mockReturnValue({
        kind: "native",
        accountId: "account",
        instanceId: "instance",
        provider: "slack",
        channelName: "slack",
        credentialConfigured: true,
        channel: {} as never,
      });
    },
    restore() {
      internals.running = false;
      release.resolve();
      for (const spy of [subscribed, account, contact, presence]) spy.mockRestore();
    },
  };
}

describe("gateway drain", () => {
  it("waits for an admitted callback and refuses a reply arriving after admission closes", async () => {
    const entered = deferred();
    const finish = deferred();
    const secondEvent = deferred();
    const subscription = spyOn(nats, "subscribe").mockImplementation(
      () =>
        (async function* () {
          yield { topic: "test.callback", data: {} };
          await secondEvent.promise;
          yield { topic: "test.reply", data: {} };
        })() as never,
    );
    try {
      const { gateway, internals } = gatewayHarness();
      let calls = 0;
      internals.subscribe("test", ["test.*"], async () => {
        calls += 1;
        entered.resolve();
        await finish.promise;
      });
      await entered.promise;
      const draining = gateway.requestDrain();
      secondEvent.resolve();
      await Promise.resolve();
      expect(gateway.drainStatus()).toMatchObject({ phase: "draining", pending: 1 });
      expect(calls).toBe(1);
      finish.resolve();
      expect(await draining).toMatchObject({ accepted: 1, completed: 1 });
    } finally {
      subscription.mockRestore();
    }
  });

  for (const timerKind of ["interrupted-stop", "post-delivery-renew"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      it(`waits for in-flight ${timerKind} and ${outcome === "failure" ? "rejects its late failure" : "certifies only after completion"}`, async () => {
        const gateway = new Gateway({ omniSender: {} as never, omniConsumer: {} as never });
        const internals = gateway as unknown as {
          running: boolean;
          workDrain: TrackedWorkDrain;
          activeRuntimeSessions: Set<string>;
          runtimeActivitySequences: Map<string, number>;
          scheduleInterruptedPresenceStop(session: string, target: NonNullable<ResponseMessage["target"]>): void;
          schedulePostDeliveryPresenceRenewal(
            session: string,
            target: NonNullable<ResponseMessage["target"]>,
            reason: string,
          ): void;
          stopPresenceForSession(): Promise<void>;
          forceRenewTyping(): Promise<void>;
        };
        internals.running = true;
        const session = "presence-drain-session";
        const target = { channel: "slack", accountId: "presence-account", chatId: "presence-chat" };
        internals.activeRuntimeSessions.add(session);
        internals.runtimeActivitySequences.set(session, 1);
        const finish = deferred();
        const method = timerKind === "interrupted-stop" ? "stopPresenceForSession" : "forceRenewTyping";
        const action = spyOn(internals, method).mockImplementation(() => finish.promise);
        let fire: (() => void) | undefined;
        let scheduledDelay: number | undefined;
        const timer = spyOn(globalThis, "setTimeout").mockImplementation((callback, delay) => {
          if (typeof callback !== "function") throw new Error("Expected a function timer");
          // Retain the scheduling handler's ALS context, then fire after that
          // handler completes: the timer must become its own tracked work.
          fire = AsyncResource.bind(callback as () => void);
          scheduledDelay = delay;
          return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
        });
        try {
          await internals.workDrain.run("presence-parent", () => {
            if (timerKind === "interrupted-stop") internals.scheduleInterruptedPresenceStop(session, target);
            else internals.schedulePostDeliveryPresenceRenewal(session, target, "test-renew");
          });
          expect(gateway.drainStatus()).toMatchObject({ accepted: 1, completed: 1, pending: 0 });
          expect(scheduledDelay).toBe(timerKind === "interrupted-stop" ? 15_000 : 1_000);
          internals.runtimeActivitySequences.set(session, 2);
          if (!fire) throw new Error("Presence timer was not scheduled");
          fire();
          timer.mockRestore();
          expect(action).toHaveBeenCalledTimes(1);
          expect(action.mock.calls[0]).toEqual(
            timerKind === "interrupted-stop" ? [session, target] : [session, target, "test-renew"],
          );
          let settled = false;
          const draining = gateway.requestDrain();
          void draining.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(settled).toBe(false);
          expect(gateway.drainStatus()).toMatchObject({ phase: "draining", accepted: 2, completed: 1, pending: 1 });
          if (outcome === "failure") {
            finish.reject(new Error("late presence failure"));
            await expect(draining).rejects.toThrow("WORK_DRAIN_UNPROVEN");
            expect(gateway.drainStatus().failures).toContain(
              timerKind === "interrupted-stop" ? "presence-interrupted-cleanup" : "presence-post-delivery-renew",
            );
          } else {
            finish.resolve();
            expect(await draining).toMatchObject({ accepted: 2, completed: 2 });
            expect(gateway.drainStatus()).toMatchObject({ phase: "drained", pending: 0, failures: [] });
          }
        } finally {
          finish.resolve();
          internals.running = false;
          timer.mockRestore();
          action.mockRestore();
        }
      });
    }
  }

  it("awaits active Slack reconciliation instead of certifying timer cancellation", async () => {
    const finish = deferred();
    const reconcile = spyOn(lifecycle, "reconcileSlackThreadLifecycle").mockImplementation(async () => {
      await finish.promise;
      return { creations: 1, parentReturns: 0, failures: 0 };
    });
    try {
      const { gateway, internals } = gatewayHarness();
      const active = internals.reconcileSlackThreads();
      const draining = gateway.requestDrain();
      expect(gateway.drainStatus()).toMatchObject({ phase: "draining", pending: 1 });
      finish.resolve();
      await active;
      expect(await draining).toMatchObject({ accepted: 1, completed: 1 });
    } finally {
      reconcile.mockRestore();
    }
  });

  it("blocks on a reconciliation failure even after its promise resolves", async () => {
    const reconcile = spyOn(lifecycle, "reconcileSlackThreadLifecycle").mockResolvedValue({
      creations: 0,
      parentReturns: 0,
      failures: 1,
    });
    try {
      const { gateway, internals } = gatewayHarness();
      await internals.reconcileSlackThreads();
      expect(gateway.drainStatus().pending).toBe(0);
      await expect(gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
    } finally {
      reconcile.mockRestore();
    }
  });

  describe("accepted response work", () => {
    let stateDir: string | null = null;

    beforeEach(async () => {
      stateDir = await createIsolatedRaviState("ravi-gateway-response-drain-");
    });

    afterEach(async () => {
      await cleanupIsolatedRaviState(stateDir);
      stateDir = null;
    });

    it.each([
      ["image", "Slack upload failed"],
      ["document", "fallback file read failed"],
    ] as const)("media rejects (%s: %s) and the latch blocks drain after the handler resolves", async (type, error) => {
      const harness = actionHarness();
      const mediaSend = spyOn(slackMedia, "sendSlackMedia").mockRejectedValue(new Error(error));
      const target = { channel: "slack", accountId: "account", chatId: "chat" };
      try {
        await harness.admit(() =>
          harness.internals.deliverResponseMediaPart(
            "drain-media",
            { _emitId: "media-event", response: "", target },
            target,
            { type, filePath: "/isolated/upload", filename: "upload", mimeType: "application/octet-stream" },
            0,
          ),
        );
        expect(mediaSend).toHaveBeenCalledTimes(1);
        expect(harness.emit).toHaveBeenCalledWith(
          "ravi.session.drain-media.delivery",
          expect.objectContaining({
            status: "failed",
            reason: "send_error",
            contentType: "media",
            error,
          }),
        );
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.gateway.drainStatus()).toMatchObject({ accepted: 1, completed: 1, pending: 0 });
        expect(harness.gateway.drainStatus().failures).toContain("response-media-send");
      } finally {
        mediaSend.mockRestore();
        harness.restore();
      }
    });

    it.each(["failed", "unknown"])("automatic media returning %s without rejecting blocks drain", async (status) => {
      const harness = actionHarness();
      const automatic = spyOn(automaticMedia, "deliverSlackAutomaticMedia").mockResolvedValue({
        handled: true,
        status,
        reason: "captured upload or receipt failure",
        retryable: false,
      });
      const target = { channel: "slack", accountId: "account", chatId: "chat" };
      try {
        await harness.admit(() =>
          harness.internals.deliverResponseMediaPart(
            "drain-media",
            { _emitId: "media-event", _automaticTerminalResponseId: "terminal", response: "", target },
            target,
            {
              type: "document",
              filePath: "/isolated/upload",
              filename: "upload",
              mimeType: "application/octet-stream",
            },
            0,
          ),
        );
        expect(automatic).toHaveBeenCalledTimes(1);
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.gateway.drainStatus().failures).toContain("response-media-send");
      } finally {
        automatic.mockRestore();
        harness.restore();
      }
    });

    it.each(["omni", "native", "private"])(
      "direct send fails (%s) and the latch blocks drain without changing the error reply",
      async (transport) => {
        const harness = actionHarness();
        const nativeSend = spyOn(slackText, "sendSlackText").mockRejectedValue(new Error("native send rejected"));
        const privateSend = spyOn(slackText, "sendSlackPrivateCards").mockRejectedValue(
          new Error("native send rejected"),
        );
        if (transport !== "omni") harness.native();
        try {
          await harness.admit(() =>
            harness.internals.handleDirectSendEvent({
              channel: transport !== "omni" ? "slack" : "matrix",
              accountId: "account",
              to: "chat",
              text: "accepted work",
              replyTopic: "test.reply",
              ...(transport === "private" ? { privateTo: ["U1"] } : {}),
            }),
          );
          expect(harness.emit).toHaveBeenCalledWith("test.reply", {
            success: false,
            error: transport !== "omni" ? "native send rejected" : "Error: provider rejected accepted work",
          });
          expect(
            transport === "private" ? privateSend : transport === "native" ? nativeSend : harness.failedSend,
          ).toHaveBeenCalledTimes(1);
          await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
          expect(harness.gateway.drainStatus().failures).toContain(
            transport === "private"
              ? "native-private-send"
              : transport === "native"
                ? "native-direct-send"
                : "direct-send",
          );
        } finally {
          privateSend.mockRestore();
          nativeSend.mockRestore();
          harness.restore();
        }
      },
    );

    it.each(["text", "private"])(
      "recovered %s fallback still latches without changing the successful direct-send reply",
      async (kind) => {
        const harness = actionHarness();
        harness.native();
        const textSend = spyOn(slackText, "sendSlackText").mockImplementation(async (_input, dependencies) => {
          dependencies?.onFailure?.();
          return {
            transport: "slack-native",
            provider: "slack",
            success: true,
            status: "sent",
            messageId: "1.1",
            raw: { ok: true },
          };
        });
        const privateSend = spyOn(slackText, "sendSlackPrivateCards").mockImplementation(
          async (_input, dependencies) => {
            dependencies?.onFailure?.();
            return { deliveries: [{ userId: "U1", kind: "dm", chatId: "D1", messageId: "1.1" }], failures: [] };
          },
        );
        try {
          await harness.admit(() =>
            harness.internals.handleDirectSendEvent({
              channel: "slack",
              accountId: "account",
              to: "chat",
              text: "accepted work",
              replyTopic: "test.reply",
              ...(kind === "private" ? { privateTo: ["U1"] } : {}),
            }),
          );
          expect(harness.emit).toHaveBeenCalledWith(
            "test.reply",
            expect.objectContaining({ success: true, messageId: "1.1" }),
          );
          await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
          expect(harness.gateway.drainStatus().failures).toContain(
            kind === "private" ? "native-private-send" : "native-direct-send",
          );
        } finally {
          textSend.mockRestore();
          privateSend.mockRestore();
          harness.restore();
        }
      },
    );

    it("captured automatic-media failure still latches when its existing retry result remains pending", async () => {
      const harness = actionHarness();
      const automatic = spyOn(automaticMedia, "deliverSlackAutomaticMedia").mockImplementation(
        async (_input, dependencies) => {
          dependencies.onFailure?.();
          return { handled: true, status: "pending", reason: "slack_media_claim_busy", retryable: true };
        },
      );
      const target = { channel: "slack", accountId: "account", chatId: "chat" };
      try {
        await harness.admit(() =>
          harness.internals.deliverResponseMediaPart(
            "drain-media",
            { _emitId: "media-event", _automaticTerminalResponseId: "terminal", response: "", target },
            target,
            {
              type: "document",
              filePath: "/isolated/upload",
              filename: "upload",
              mimeType: "application/octet-stream",
            },
            0,
          ),
        );
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.gateway.drainStatus().failures).toContain("response-media-send");
      } finally {
        automatic.mockRestore();
        harness.restore();
      }
    });

    it("partial private-card failure blocks drain while preserving successful deliveries and reply", async () => {
      const harness = actionHarness();
      harness.native();
      const deliveries = [{ userId: "U1", kind: "dm" as const, chatId: "D1", messageId: "1.1" }];
      const failures = [{ userId: "U2", error: "failed" }];
      const send = spyOn(slackText, "sendSlackPrivateCards").mockResolvedValue({ deliveries, failures });
      try {
        await harness.admit(() =>
          harness.internals.handleDirectSendEvent({
            channel: "slack",
            accountId: "account",
            to: "chat",
            text: "accepted work",
            privateTo: ["U1", "U2"],
            replyTopic: "test.reply",
          }),
        );
        expect(harness.emit).toHaveBeenCalledWith("test.reply", {
          success: true,
          messageId: "1.1",
          deliveries,
          failures,
        });
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.gateway.drainStatus().failures).toContain("native-private-send");
      } finally {
        send.mockRestore();
        harness.restore();
      }
    });

    it.each([
      ["handleReactionEvent", "reaction-send"],
      ["handleMessageEditEvent", "message-edit"],
      ["handleMessageDeleteEvent", "message-delete"],
      ["handleMediaSendEvent", "media-send"],
      ["handleApprovalFinalizationEvent", "approval-finalization"],
    ] as const)("caught %s failure blocks drain", async (method, label) => {
      const harness = actionHarness();
      try {
        await harness.admit(() =>
          harness.internals[method]({
            channel: "matrix",
            accountId: "account",
            chatId: "chat",
            messageId: "1.1",
            text: "edit",
            emoji: "ok",
            filePath: "/isolated/upload",
            filename: "upload",
            type: "document",
            replyTopic: "test.reply",
          }),
        );
        if (method === "handleMessageEditEvent" || method === "handleMessageDeleteEvent") {
          expect(harness.emit).toHaveBeenCalledWith("test.reply", {
            success: false,
            messageId: "1.1",
            canonicalMessageId: undefined,
            error: "provider rejected accepted work",
          });
        }
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.gateway.drainStatus().failures).toContain(label);
      } finally {
        harness.restore();
      }
    });

    it("sticker subscription captures failure but cannot return clean drain proof", async () => {
      const harness = actionHarness();
      try {
        harness.internals.subscribeToStickerSend();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.failedSend).toHaveBeenCalledTimes(1);
        expect(harness.gateway.drainStatus().failures).toContain("sticker-send");
      } finally {
        harness.restore();
      }
    });

    it("TTS helper returning failed instead of rejecting blocks subscription drain", async () => {
      const harness = actionHarness();
      const generate = spyOn(tts, "handleRaviTtsRequest").mockResolvedValue({
        id: "tts",
        requestId: "tts",
        status: "failed",
        createdAt: 1,
        text: "text",
        textPreview: "text",
        playback: { target: "extension", autoplay: true },
        voice: { provider: "elevenlabs", modelId: "model", lang: "pt-br", outputFormat: "mp3" },
        error: "generation failed",
      });
      try {
        harness.internals.subscribeToTts();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(generate).toHaveBeenCalledTimes(1);
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.gateway.drainStatus().failures).toContain("tts-generation");
      } finally {
        generate.mockRestore();
        harness.restore();
      }
    });

    it("a caught response trace persistence failure cannot certify drain", async () => {
      const harness = actionHarness();
      const trace = spyOn(channelTrace, "recordResponseEmittedTrace").mockImplementation(() => {
        throw new Error("trace write failed");
      });
      try {
        await harness.admit(() => harness.internals.recordResponseTrace("drain-trace", { response: "text" }));
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.gateway.drainStatus().failures).toContain("response-trace");
      } finally {
        trace.mockRestore();
        harness.restore();
      }
    });

    it("caught send failure latches and prevents drain after the response handler resolves", async () => {
      const send = mock(async () => {
        throw new Error("accepted response send failed");
      });
      const harness = textResponseHarness(send);
      try {
        await harness.admit();
        expect(send).toHaveBeenCalledTimes(1);
        expect(harness.delivery).toHaveBeenCalledWith(
          "drain-session",
          expect.anything(),
          expect.objectContaining({ status: "failed", reason: "send_error" }),
        );
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.gateway.drainStatus().failures).toContain("response-text-send");
      } finally {
        harness.restore();
      }
    });

    it("caught native outbox failure latches and prevents drain", async () => {
      const publish = spyOn(outbox, "publishChannelOutboundJobDurably").mockRejectedValue(
        new Error("local outbox persistence failed"),
      );
      const harness = textResponseHarness();
      try {
        await harness.admit("slack");
        expect(publish).toHaveBeenCalledTimes(1);
        expect(harness.delivery).toHaveBeenCalledWith(
          "drain-session",
          expect.anything(),
          expect.objectContaining({ status: "failed", reason: "local_outbox_error" }),
        );
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.gateway.drainStatus().failures).toContain("response-native-outbox");
      } finally {
        publish.mockRestore();
        harness.restore();
      }
    });

    it("retryable native publication failure blocks drain while preserving the durable pending job", async () => {
      const publish = spyOn(outbox, "publishChannelOutboundJobDurably").mockImplementation(async (job) => {
        const record = outbox.saveChannelOutboundPublishJob(job, 100);
        if (record.status !== "pending") throw new Error("Expected a fresh pending outbox job");
        return {
          ok: false,
          disposition: "deferred",
          record,
          error: new Error("broker unavailable"),
          nextAttemptAt: 1_000,
        };
      });
      const harness = textResponseHarness();
      try {
        await harness.admit("slack");
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.gateway.drainStatus().failures).toContain("response-native-outbox");
        const job = publish.mock.calls[0]![0];
        expect(outbox.getChannelOutboundPublishJob(job.request.idempotencyKey)?.status).toBe("pending");
        expect(harness.delivery).toHaveBeenCalledWith(
          "drain-session",
          expect.anything(),
          expect.objectContaining({
            status: "failed",
            reason: "queue_error",
            retryable: true,
            nextAttemptAt: 1_000,
          }),
        );
      } finally {
        publish.mockRestore();
        harness.restore();
      }
    });

    it("a queued native job with no publication failure permits drain before platform delivery", async () => {
      const publish = spyOn(outbox, "publishChannelOutboundJobDurably").mockImplementation(async (job) => {
        outbox.saveChannelOutboundPublishJob(job, 100);
        const record = outbox.markChannelOutboundPublishJobPublished(job.request.idempotencyKey, 101);
        if (record.status !== "published") throw new Error("Expected a published outbox job");
        return { ok: true, disposition: "published", record, publishedNow: true };
      });
      const harness = textResponseHarness();
      try {
        await harness.admit("slack");
        expect(await harness.gateway.requestDrain()).toMatchObject({ accepted: 1, completed: 1 });
        expect(harness.delivery).toHaveBeenCalledWith(
          "drain-session",
          expect.anything(),
          expect.objectContaining({ status: "queued" }),
        );
      } finally {
        publish.mockRestore();
        harness.restore();
      }
    });

    it("retryable native chat-action publication failure blocks drain while preserving its queued reply", async () => {
      const publish = spyOn(outbox, "publishChannelOutboundJobDurably").mockImplementation(async (job) => {
        const record = outbox.saveChannelOutboundPublishJob(job, 100);
        if (record.status !== "pending") throw new Error("Expected a fresh pending outbox job");
        return {
          ok: false,
          disposition: "deferred",
          record,
          error: new Error("broker unavailable"),
          nextAttemptAt: 1_000,
        };
      });
      const harness = actionHarness();
      harness.native();
      try {
        await harness.admit(() =>
          harness.internals.handleMessageDeleteEvent({
            channel: "slack",
            accountId: "account",
            chatId: "chat",
            messageId: "1.1",
            replyTopic: "test.reply",
          }),
        );
        expect(harness.emit).toHaveBeenCalledWith(
          "test.reply",
          expect.objectContaining({ success: true, queued: true, publishPending: true, nextAttemptAt: 1_000 }),
        );
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.gateway.drainStatus().failures).toContain("native-chat-action-publication");
        const job = publish.mock.calls[0]![0];
        expect(outbox.getChannelOutboundPublishJob(job.request.idempotencyKey)?.status).toBe("pending");
      } finally {
        publish.mockRestore();
        harness.restore();
      }
    });

    it("pending TTS publication holds drain without delaying its admitted response handler", async () => {
      const sendEntered = deferred();
      const finishSend = deferred();
      const ttsEntered = deferred();
      const finishTts = deferred();
      const harness = textResponseHarness(async () => {
        sendEntered.resolve();
        await finishSend.promise;
        return {};
      });
      harness.tts.mockImplementation(async () => {
        ttsEntered.resolve();
        await finishTts.promise;
      });
      try {
        const handled = harness.admit();
        await sendEntered.promise;
        const draining = harness.gateway.requestDrain();
        finishSend.resolve();
        await ttsEntered.promise;
        await handled;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(harness.gateway.drainStatus()).toMatchObject({
          phase: "draining",
          accepted: 2,
          completed: 1,
          pending: 1,
        });
        expect(harness.delivery).toHaveBeenCalledTimes(1);
        expect(harness.tts).toHaveBeenCalledTimes(1);
        finishTts.resolve();
        expect(await draining).toMatchObject({ accepted: 2, completed: 2 });
      } finally {
        finishSend.resolve();
        finishTts.resolve();
        harness.restore();
      }
    });

    it("caught TTS publication failure remains unproven without changing delivered text telemetry", async () => {
      const harness = textResponseHarness();
      harness.tts.mockRejectedValue(new Error("TTS publication failed"));
      try {
        await harness.admit();
        await expect(harness.gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
        expect(harness.gateway.drainStatus().failures).toContain("response-tts-publication");
        expect(harness.delivery).toHaveBeenCalledTimes(1);
        expect(harness.delivery).toHaveBeenCalledWith(
          "drain-session",
          expect.anything(),
          expect.objectContaining({ status: "delivered" }),
        );
      } finally {
        harness.restore();
      }
    });
  });
});
