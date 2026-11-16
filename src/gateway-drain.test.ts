import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Gateway } from "./gateway.js";
import { nats } from "./nats.js";
import * as lifecycle from "./channels/slack/thread-lifecycle.js";
import * as outbox from "./channels/outbound-publish-outbox.js";
import * as readiness from "./channels/native-readiness.js";
import { configStore } from "./config-store.js";
import type { ResponseMessage } from "./runtime/message-types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

    it("allows a durably owned native outbox job to remain pending during drain", async () => {
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
        expect(await harness.gateway.requestDrain()).toMatchObject({ accepted: 1, completed: 1 });
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
