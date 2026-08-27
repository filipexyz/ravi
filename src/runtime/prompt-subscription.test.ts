import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const consumeCalls: Array<Record<string, unknown>> = [];
const ensureInfrastructureMock = mock(async () => {});
const emitCalls: Array<{ topic: string; payload: Record<string, unknown> }> = [];

let running = false;
let consumedMessages: FakePromptMessage[] = [];
let stopRunningAfterConsume = true;

interface FakePromptMessage {
  data: Uint8Array;
  subject: string;
  ack: ReturnType<typeof mock>;
  nak: ReturnType<typeof mock>;
}

const fakeConsumer = {
  consume: mock(async (options: Record<string, unknown>) => {
    consumeCalls.push(options);
    const messages = [...consumedMessages];
    consumedMessages = [];
    return (async function* () {
      try {
        yield* messages;
      } finally {
        if (stopRunningAfterConsume) {
          running = false;
        }
      }
    })();
  }),
};

const fakeJetStream = {
  consumers: {
    get: mock(async () => fakeConsumer),
  },
};

mock.module("../nats.js", () => ({
  ensureConnected: mock(async () => ({
    jetstream: () => fakeJetStream,
  })),
  getNats: mock(() => ({
    jetstream: () => fakeJetStream,
  })),
  publish: mock(async (topic: string, payload: Record<string, unknown>) => {
    emitCalls.push({ topic, payload });
  }),
  subscribe: mock(async function* () {}),
  closeNats: mock(async () => {}),
  nats: {
    emit: mock(async (topic: string, payload: Record<string, unknown>) => {
      emitCalls.push({ topic, payload });
    }),
    subscribe: mock(async function* () {}),
    close: mock(async () => {}),
  },
}));

const { RuntimePromptSubscription } = await import("./prompt-subscription.js");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  running = true;
  stopRunningAfterConsume = true;
  consumedMessages = [];
  consumeCalls.length = 0;
  emitCalls.length = 0;
  ensureInfrastructureMock.mockClear();
  fakeConsumer.consume.mockClear();
  fakeJetStream.consumers.get.mockClear();
});

describe("RuntimePromptSubscription", () => {
  it("aborts the pull loop when SESSION_PROMPTS resources disappear", async () => {
    const subscription = new RuntimePromptSubscription({
      isRunning: () => running,
      canAcceptPrompt: () => true,
      getStreamingSessionCount: () => 0,
      ensurePromptInfrastructure: ensureInfrastructureMock,
      markConsumerReady: mock(() => {}),
      handlePrompt: mock(async () => {}),
    });

    subscription.subscribe();

    await waitUntil(() => consumeCalls.length === 1 && !subscription.active);

    expect(ensureInfrastructureMock).toHaveBeenCalledWith({ force: true });
    expect(fakeJetStream.consumers.get).toHaveBeenCalledWith("SESSION_PROMPTS", "ravi-prompts");
    expect(consumeCalls[0]).toMatchObject({
      expires: 2000,
      abort_on_missing_resource: true,
    });
  });

  it("ACKs a prompt only after the intake fence and dispatch both accept it", async () => {
    const message = makePromptMessage("ravi.session.dev.prompt", { prompt: "continue" });
    consumedMessages = [message];
    const canAcceptPrompt = mock(() => true);
    const callOrder: string[] = [];
    message.ack = mock(() => callOrder.push("ack"));
    const handlePrompt = mock(async () => {
      callOrder.push("dispatch");
    });
    const subscription = new RuntimePromptSubscription({
      isRunning: () => running,
      canAcceptPrompt,
      getStreamingSessionCount: () => 0,
      ensurePromptInfrastructure: ensureInfrastructureMock,
      markConsumerReady: mock(() => {}),
      handlePrompt,
    });

    subscription.subscribe();
    await waitUntil(() => !subscription.active);

    expect(canAcceptPrompt).toHaveBeenCalledWith("dev");
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.nak).not.toHaveBeenCalled();
    expect(handlePrompt).toHaveBeenCalledWith("dev", { prompt: "continue" });
    expect(callOrder).toEqual(["dispatch", "ack"]);
    expect(subscription.promptsReceived).toBe(1);
  });

  it("delays redelivery without ACKing or counting a prompt when dispatch fails", async () => {
    const message = makePromptMessage("ravi.session.dev.prompt", { prompt: "retry me" });
    consumedMessages = [message];
    const handlePrompt = mock(async () => {
      throw new Error("dispatch failed");
    });
    const subscription = new RuntimePromptSubscription({
      isRunning: () => running,
      canAcceptPrompt: () => true,
      getStreamingSessionCount: () => 0,
      ensurePromptInfrastructure: ensureInfrastructureMock,
      markConsumerReady: mock(() => {}),
      handlePrompt,
    });

    subscription.subscribe();
    await waitUntil(() => !subscription.active);

    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(message.nak).toHaveBeenCalledWith(5_000);
    expect(message.ack).not.toHaveBeenCalled();
    expect(subscription.promptsReceived).toBe(0);
  });

  it("NAKs and stops the pull before ACK or dispatch when intake is fenced", async () => {
    const message = makePromptMessage("ravi.session.dev.prompt", { prompt: "must remain durable" });
    consumedMessages = [message];
    const canAcceptPrompt = mock(() => false);
    const handlePrompt = mock(async () => {});
    const subscription = new RuntimePromptSubscription({
      isRunning: () => running,
      canAcceptPrompt,
      getStreamingSessionCount: () => 0,
      ensurePromptInfrastructure: ensureInfrastructureMock,
      markConsumerReady: mock(() => {}),
      handlePrompt,
    });

    subscription.subscribe();
    await waitUntil(() => !subscription.active);

    expect(canAcceptPrompt).toHaveBeenCalledWith("dev");
    expect(message.nak).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(handlePrompt).not.toHaveBeenCalled();
    expect(subscription.promptsReceived).toBe(0);
  });

  it("records onIntakeFenced when crash-recovery intake is closed", async () => {
    const message = makePromptMessage("ravi.session.main.prompt", { prompt: "stored after fence" });
    consumedMessages = [message];
    const onIntakeFenced = mock(() => {});
    const subscription = new RuntimePromptSubscription({
      isRunning: () => running,
      canAcceptPrompt: () => false,
      getStreamingSessionCount: () => 0,
      ensurePromptInfrastructure: ensureInfrastructureMock,
      markConsumerReady: mock(() => {}),
      handlePrompt: mock(async () => {}),
      onIntakeFenced,
    });

    subscription.subscribe();
    await waitUntil(() => !subscription.active);

    expect(onIntakeFenced).toHaveBeenCalledWith({
      sessionName: "main",
      subject: "ravi.session.main.prompt",
      reason: "crash_recovery_not_accepting",
    });
    expect(message.nak).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("resubscribes after a transient fence and dispatches Slack-sourced inbound", async () => {
    stopRunningAfterConsume = false;
    const fenced = makePromptMessage("ravi.session.main.prompt", { prompt: "held during fence" });
    const slack = makePromptMessage("ravi.session.main.prompt", {
      prompt: "@ravi ping",
      source: { channel: "slack", accountId: "ravi-slack", chatId: "C123" },
    });
    consumedMessages = [fenced];
    let accept = false;
    const handlePrompt = mock(async () => {
      running = false;
    });
    const subscription = new RuntimePromptSubscription({
      isRunning: () => running,
      canAcceptPrompt: () => accept,
      getStreamingSessionCount: () => 0,
      ensurePromptInfrastructure: ensureInfrastructureMock,
      markConsumerReady: mock(() => {}),
      handlePrompt,
      intakeFenceRetryMs: 20,
    });

    subscription.subscribe();
    await waitUntil(() => fenced.nak.mock.calls.length === 1 && consumeCalls.length === 1);

    accept = true;
    consumedMessages = [slack];
    await waitUntil(() => handlePrompt.mock.calls.length === 1);

    expect(handlePrompt).toHaveBeenCalledWith("main", {
      prompt: "@ravi ping",
      source: { channel: "slack", accountId: "ravi-slack", chatId: "C123" },
    });
    expect(slack.ack).toHaveBeenCalledTimes(1);
    expect(fenced.ack).not.toHaveBeenCalled();
  });
});

function makePromptMessage(subject: string, prompt: Record<string, unknown>): FakePromptMessage {
  return {
    subject,
    data: new TextEncoder().encode(JSON.stringify(prompt)),
    ack: mock(() => {}),
    nak: mock(() => {}),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
