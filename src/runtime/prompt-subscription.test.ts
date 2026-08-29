import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const consumeCalls: Array<Record<string, unknown>> = [];
const ensureInfrastructureMock = mock(async () => {});
const emitCalls: Array<{ topic: string; payload: Record<string, unknown> }> = [];

let running = false;
let consumedMessages: FakePromptMessage[] = [];

interface FakePromptMessage {
  data: Uint8Array;
  subject: string;
  ack: ReturnType<typeof mock>;
  nak: ReturnType<typeof mock>;
  working: ReturnType<typeof mock>;
}

const fakeConsumer = {
  consume: mock(async (options: Record<string, unknown>) => {
    consumeCalls.push(options);
    const messages = [...consumedMessages];
    return (async function* () {
      try {
        yield* messages;
      } finally {
        running = false;
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
    await waitUntil(() => message.ack.mock.calls.length === 1);

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
    await waitUntil(() => message.nak.mock.calls.length === 1);

    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(message.nak).toHaveBeenCalledWith(5_000);
    expect(message.ack).not.toHaveBeenCalled();
    expect(subscription.promptsReceived).toBe(0);
  });

  it("does not let a blocked background session stall prompts for another session", async () => {
    const background = makePromptMessage("ravi.session.obs:blocked.prompt", { prompt: "background" });
    const interactive = makePromptMessage("ravi.session.main.prompt", { prompt: "interactive" });
    consumedMessages = [background, interactive];

    let releaseBackground!: () => void;
    const backgroundAccepted = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    const handlePrompt = mock(async (sessionName: string) => {
      if (sessionName === "obs:blocked") {
        await backgroundAccepted;
      }
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
    const interactiveBypassedBlockedBackground = await waitUntil(() => interactive.ack.mock.calls.length === 1, 100)
      .then(() => true)
      .catch(() => false);

    releaseBackground();
    await waitUntil(() => background.ack.mock.calls.length === 1 && interactive.ack.mock.calls.length === 1);

    expect(interactiveBypassedBlockedBackground).toBe(true);
    expect(handlePrompt).toHaveBeenCalledWith("main", { prompt: "interactive" });
    expect(background.nak).not.toHaveBeenCalled();
    expect(interactive.nak).not.toHaveBeenCalled();
  });

  it("preserves prompt order within the same session while dispatch is blocked", async () => {
    const first = makePromptMessage("ravi.session.main.prompt", { prompt: "first" });
    const second = makePromptMessage("ravi.session.main.prompt", { prompt: "second" });
    consumedMessages = [first, second];

    let releaseFirst!: () => void;
    const firstAccepted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handledPrompts: string[] = [];
    const handlePrompt = mock(async (_sessionName: string, prompt: { prompt: string }) => {
      handledPrompts.push(prompt.prompt);
      if (prompt.prompt === "first") {
        await firstAccepted;
      }
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
    await waitUntil(() => handledPrompts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(handledPrompts).toEqual(["first"]);
    expect(second.ack).not.toHaveBeenCalled();

    releaseFirst();
    await waitUntil(() => first.ack.mock.calls.length === 1 && second.ack.mock.calls.length === 1);

    expect(handledPrompts).toEqual(["first", "second"]);
  });

  it("renews the JetStream ACK deadline while dispatcher admission is pending", async () => {
    const message = makePromptMessage("ravi.session.obs:blocked.prompt", { prompt: "background" });
    consumedMessages = [message];

    let acceptPrompt!: () => void;
    const accepted = new Promise<void>((resolve) => {
      acceptPrompt = resolve;
    });
    const subscription = new RuntimePromptSubscription({
      isRunning: () => running,
      canAcceptPrompt: () => true,
      getStreamingSessionCount: () => 0,
      ensurePromptInfrastructure: ensureInfrastructureMock,
      promptAckProgressIntervalMs: 5,
      markConsumerReady: mock(() => {}),
      handlePrompt: async () => accepted,
    });

    subscription.subscribe();
    await waitUntil(() => message.working.mock.calls.length > 0);

    expect(message.ack).not.toHaveBeenCalled();
    acceptPrompt();
    await waitUntil(() => message.ack.mock.calls.length === 1);
    const renewalsAfterAck = message.working.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(message.working).toHaveBeenCalledTimes(renewalsAfterAck);
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
});

function makePromptMessage(subject: string, prompt: Record<string, unknown>): FakePromptMessage {
  return {
    subject,
    data: new TextEncoder().encode(JSON.stringify(prompt)),
    ack: mock(() => {}),
    nak: mock(() => {}),
    working: mock(() => {}),
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
