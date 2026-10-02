import { describe, expect, it, mock } from "bun:test";
import { AckPolicy, DeliverPolicy, StringCodec } from "nats";
import { ensureDurableConsumer, runDurablePullLoop, type DurablePullSubscription } from "./jetstream-source.js";

const sc = StringCodec();
const SUBSCRIPTION: DurablePullSubscription = {
  stream: "CHANNEL_INBOUND",
  durable: "ravi-whatsapp-messages",
  filterSubject: "ravi.channel.inbound.whatsapp.message.>",
};

function silentLog() {
  return { debug: mock(() => {}), info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) };
}

interface FakeMsg {
  subject: string;
  data: Uint8Array;
  ack: ReturnType<typeof mock>;
  nak: ReturnType<typeof mock>;
}

function fakeMsg(subject: string, body: unknown): FakeMsg {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return { subject, data: sc.encode(raw), ack: mock(() => {}), nak: mock(() => {}) };
}

/** Fake JetStream: `existing` streams exist up front; a durable yields its queued messages once, then idles. */
function fakeJetStream(input: { existing: string[]; messages?: FakeMsg[]; existingConsumers?: string[] }) {
  const streams = new Set(input.existing);
  const consumers = new Set(input.existingConsumers ?? []);
  const adds: Array<{ stream: string; config: Record<string, unknown> }> = [];
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let consumed = false;

  const jsm = {
    streams: {
      info: mock(async (stream: string) => {
        if (!streams.has(stream)) throw new Error("stream not found");
        return { config: { name: stream } };
      }),
    },
    consumers: {
      info: mock(async (stream: string, name: string) => {
        if (!consumers.has(`${stream}/${name}`)) throw new Error("consumer not found");
        return {};
      }),
      add: mock(async (stream: string, config: Record<string, unknown>) => {
        consumers.add(`${stream}/${String(config.durable_name)}`);
        adds.push({ stream, config });
        return config;
      }),
    },
  };
  const js = {
    consumers: {
      get: mock(async () => ({
        consume: async () =>
          (async function* () {
            if (!consumed) {
              consumed = true;
              for (const msg of input.messages ?? []) yield msg;
            }
            await released;
          })(),
      })),
    },
  };
  const ensureStream = mock(async () => {
    streams.add("CHANNEL_INBOUND");
  });
  return { jsm, js, adds, ensureStream, release: () => release() };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("runDurablePullLoop", () => {
  it("creates the stream and the durable, acks before handling and naks undecodable payloads", async () => {
    const good = fakeMsg("ravi.channel.inbound.whatsapp.message.i1", { id: "evt-1" });
    const broken = fakeMsg("ravi.channel.inbound.whatsapp.message.i1", "{not json");
    const fake = fakeJetStream({ existing: [], messages: [good, broken] });
    const handled: Array<[string, unknown, boolean]> = [];
    let running = true;

    await runDurablePullLoop({
      js: fake.js as never,
      jsm: fake.jsm as never,
      subscription: SUBSCRIPTION,
      ensureStream: fake.ensureStream,
      handle: async (subject, data) => {
        handled.push([subject, data, good.ack.mock.calls.length === 1]);
      },
      isRunning: () => running,
      log: silentLog(),
    });
    await flush();
    running = false;
    fake.release();

    expect(fake.ensureStream).toHaveBeenCalledTimes(1);
    expect(fake.adds).toEqual([
      {
        stream: "CHANNEL_INBOUND",
        config: {
          durable_name: "ravi-whatsapp-messages",
          filter_subject: "ravi.channel.inbound.whatsapp.message.>",
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.New,
        },
      },
    ]);
    expect(handled).toEqual([["ravi.channel.inbound.whatsapp.message.i1", { id: "evt-1" }, true]]);
    expect(good.ack).toHaveBeenCalledTimes(1);
    expect(good.nak).not.toHaveBeenCalled();
    expect(broken.nak).toHaveBeenCalledTimes(1);
    expect(broken.ack).not.toHaveBeenCalled();
  });

  it("reuses an existing durable and never waits for a slow or failing handler", async () => {
    const first = fakeMsg("message.received.telegram.i1", { id: "a" });
    const second = fakeMsg("message.received.telegram.i1", { id: "b" });
    const fake = fakeJetStream({
      existing: ["MESSAGE"],
      existingConsumers: ["MESSAGE/ravi-messages"],
      messages: [first, second],
    });
    const log = silentLog();
    let running = true;
    const seen: unknown[] = [];

    await runDurablePullLoop({
      js: fake.js as never,
      jsm: fake.jsm as never,
      subscription: { stream: "MESSAGE", durable: "ravi-messages", filterSubject: "message.received.>" },
      handle: async (_subject, data) => {
        seen.push(data);
        if ((data as { id: string }).id === "a") {
          await new Promise(() => {}); // never settles
        }
        throw new Error("handler failed");
      },
      isRunning: () => running,
      log,
    });
    await flush();
    running = false;
    fake.release();

    expect(fake.adds).toHaveLength(0);
    expect(seen).toEqual([{ id: "a" }, { id: "b" }]);
    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith("Error handling event", expect.objectContaining({ stream: "MESSAGE" }));
  });

  it("unblocks start after the ready fallback while the stream is still missing", async () => {
    const fake = fakeJetStream({ existing: [] });
    const log = silentLog();
    let running = true;

    await runDurablePullLoop({
      js: fake.js as never,
      jsm: fake.jsm as never,
      subscription: { stream: "MESSAGE", durable: "ravi-messages", filterSubject: "message.received.>" },
      handle: async () => {},
      isRunning: () => running,
      log,
      readyTimeoutMs: 20,
      retryDelayMs: 5,
    });
    running = false;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(log.warn).toHaveBeenCalledWith(
      "Consumer ready timeout — unblocking start(), will keep retrying in background",
      { stream: "MESSAGE" },
    );
    expect(fake.js.consumers.get).not.toHaveBeenCalled();
  });

  it("does not call consumers.get when the consumer is not ready and the loop stops", async () => {
    let running = true;
    const jsm = {
      streams: {
        info: mock(async () => {
          running = false;
          throw new Error("stream not found");
        }),
      },
      consumers: { info: mock(async () => ({})), add: mock(async () => ({})) },
    };
    const getConsumer = mock(async () => ({ consume: async function* () {} }));

    await runDurablePullLoop({
      js: { consumers: { get: getConsumer } } as never,
      jsm: jsm as never,
      subscription: { stream: "MESSAGE", durable: "ravi-messages", filterSubject: "message.received.>" },
      handle: async () => {},
      isRunning: () => running,
      log: silentLog(),
      sleep: async () => {},
    });

    expect(getConsumer).not.toHaveBeenCalled();
  });
});

describe("ensureDurableConsumer", () => {
  it("times out cleanly without touching consumer APIs when the stream is still missing", async () => {
    let now = 1_000;
    const consumersInfo = mock(async () => ({}));
    const consumersAdd = mock(async () => ({}));
    const jsm = {
      streams: {
        info: mock(async () => {
          throw new Error("stream not found");
        }),
      },
      consumers: { info: consumersInfo, add: consumersAdd },
    };

    const ready = await ensureDurableConsumer({
      jsm: jsm as never,
      subscription: { stream: "MESSAGE", durable: "ravi-messages", filterSubject: "message.received.>" },
      isRunning: () => true,
      log: silentLog(),
      timeoutMs: 1_500,
      sleep: async () => {},
      now: () => {
        const value = now;
        now += 1_000;
        return value;
      },
    });

    expect(ready).toBe(false);
    expect(consumersInfo).not.toHaveBeenCalled();
    expect(consumersAdd).not.toHaveBeenCalled();
  });

  it("retries ensureStream after a failure, then creates the durable", async () => {
    const fake = fakeJetStream({ existing: [] });
    let attempts = 0;
    const ensureStream = mock(async (jsm: unknown) => {
      attempts++;
      if (attempts === 1) throw new Error("nats down");
      await fake.ensureStream();
      return jsm as never;
    });
    const log = silentLog();

    const ready = await ensureDurableConsumer({
      jsm: fake.jsm as never,
      subscription: SUBSCRIPTION,
      ensureStream: async (jsm) => {
        await ensureStream(jsm);
      },
      isRunning: () => true,
      log,
      sleep: async () => {},
    });

    expect(ready).toBe(true);
    expect(ensureStream).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      "Failed to create JetStream stream, retrying in 2s",
      expect.objectContaining({ stream: "CHANNEL_INBOUND" }),
    );
    expect(fake.adds.map((add) => add.config.durable_name)).toEqual(["ravi-whatsapp-messages"]);
  });
});
