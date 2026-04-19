import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

const actualRouterIndexModule = await import("../router/index.js");
const actualContactsModule = await import("../contacts.js");
const { logger } = await import("../utils/logger.js");

const publishCalls: Array<[string, Record<string, unknown>]> = [];
const warnCalls: Array<[string, Record<string, unknown> | undefined]> = [];
const infoCalls: Array<[string, Record<string, unknown> | undefined]> = [];
const debugCalls: Array<[string, Record<string, unknown> | undefined]> = [];
const errorCalls: Array<[string, Record<string, unknown> | undefined]> = [];

let configValue = {
  instanceToAccount: {} as Record<string, string>,
  instances: {} as Record<string, Record<string, unknown>>,
  agents: {},
  routes: [],
  defaultAgent: "main",
  defaultDmScope: "per-peer",
  accountAgents: {},
  ignoredOmniInstanceIds: [] as string[],
};

const publishMock = mock(async (topic: string, payload: Record<string, unknown>) => {
  publishCalls.push([topic, payload]);
});

mock.module("../nats.js", () => ({
  getNats: () => {
    throw new Error("not used in this test");
  },
  publish: publishMock,
  nats: {
    emit: mock(async () => {}),
    subscribe: async function* () {},
  },
}));

mock.module("./session-stream.js", () => ({
  publishSessionPrompt: mock(async () => {}),
}));

mock.module("../slash/index.js", () => ({
  handleSlashCommand: mock(async () => false),
}));

mock.module("../router/index.js", () => ({
  ...actualRouterIndexModule,
  expandHome: (cwd: string) => cwd,
  resolveRoute: () => null,
}));

mock.module("../config-store.js", () => ({
  configStore: {
    getConfig: () => configValue,
  },
}));

mock.module("../contacts.js", () => ({
  ...actualContactsModule,
  isContactAllowedForAgent: () => true,
  saveAccountPending: () => false,
  getContactName: () => undefined,
  getContact: () => null,
}));

const capturedLogger = {
  info: (message: string, meta?: Record<string, unknown>) => {
    infoCalls.push([message, meta]);
  },
  error: (message: string, meta?: Record<string, unknown>) => {
    errorCalls.push([message, meta]);
  },
  warn: (message: string, meta?: Record<string, unknown>) => {
    warnCalls.push([message, meta]);
  },
  debug: (message: string, meta?: Record<string, unknown>) => {
    debugCalls.push([message, meta]);
  },
};

const loggerChildSpy = spyOn(logger, "child").mockImplementation(() => capturedLogger as never);

mock.module("../utils/media.js", () => ({
  fetchOmniMedia: mock(async () => null),
  saveToAgentAttachments: mock(async () => null),
  MAX_AUDIO_BYTES: 16 * 1024 * 1024,
}));

mock.module("../transcribe/openai.js", () => ({
  transcribeAudio: mock(async () => ""),
}));

const { OmniConsumer } = await import("./consumer.js");

afterAll(() => {
  loggerChildSpy.mockRestore();
  mock.restore();
});

function makeEvent(instanceId: string) {
  return {
    id: `evt-${instanceId}`,
    type: "message.received",
    payload: {
      externalId: "msg-1",
      chatId: "5511999999999@s.whatsapp.net",
      from: "5511999999999@s.whatsapp.net",
      content: {
        type: "text",
        text: "oi",
      },
    },
    metadata: {
      instanceId,
      channelType: "whatsapp-baileys",
    },
    timestamp: Date.now(),
  };
}

describe("OmniConsumer instance gating", () => {
  beforeEach(() => {
    configValue = {
      instanceToAccount: {},
      instances: {},
      agents: {},
      routes: [],
      defaultAgent: "main",
      defaultDmScope: "per-peer",
      accountAgents: {},
      ignoredOmniInstanceIds: [],
    };
    publishCalls.length = 0;
    warnCalls.length = 0;
    infoCalls.length = 0;
    debugCalls.length = 0;
    errorCalls.length = 0;
    publishMock.mockClear();
  });

  it("silences registered instances that are disabled in ravi", async () => {
    configValue = {
      ...configValue,
      instanceToAccount: { "disabled-instance": "ops" },
      instances: {
        ops: {
          name: "ops",
          channel: "whatsapp",
          dmPolicy: "open",
          groupPolicy: "open",
          enabled: false,
        },
      },
      ignoredOmniInstanceIds: [],
    };

    const consumer = new OmniConsumer({} as never, "http://omni.local", "test-key");

    await consumer["handleMessageEvent"](
      "message.received.whatsapp-baileys.disabled-instance",
      makeEvent("disabled-instance"),
    );

    expect(publishCalls).toHaveLength(0);
    expect(warnCalls).toHaveLength(0);
    expect(infoCalls).toEqual([
      [
        "Instance disabled in ravi, ignoring inbound",
        { instanceId: "disabled-instance", accountId: "ops", channelType: "whatsapp-baileys" },
      ],
    ]);
  });

  it("still warns and emits for unknown unregistered instances", async () => {
    const consumer = new OmniConsumer({} as never, "http://omni.local", "test-key");

    await consumer["handleMessageEvent"](
      "message.received.whatsapp-baileys.unregistered-instance",
      makeEvent("unregistered-instance"),
    );

    expect(infoCalls).toHaveLength(0);
    expect(warnCalls).toEqual([
      [
        "Unknown instanceId — not registered in ravi, skipping",
        { instanceId: "unregistered-instance", channelType: "whatsapp-baileys" },
      ],
    ]);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]).toEqual([
      "ravi.instances.unregistered",
      expect.objectContaining({
        instanceId: "unregistered-instance",
        channelType: "whatsapp-baileys",
        subject: "message.received.whatsapp-baileys.unregistered-instance",
      }),
    ]);
  });

  it("silences unknown unregistered instances explicitly ignored in ravi", async () => {
    configValue = {
      ...configValue,
      ignoredOmniInstanceIds: ["ignored-instance"],
    };
    const consumer = new OmniConsumer({} as never, "http://omni.local", "test-key");

    await consumer["handleMessageEvent"](
      "message.received.whatsapp-baileys.ignored-instance",
      makeEvent("ignored-instance"),
    );

    expect(publishCalls).toHaveLength(0);
    expect(warnCalls).toHaveLength(0);
    expect(infoCalls).toHaveLength(0);
    expect(debugCalls).toEqual([
      [
        "Ignoring unknown omni instanceId configured in ravi",
        { instanceId: "ignored-instance", channelType: "whatsapp-baileys" },
      ],
    ]);
  });

  it("times out cleanly without touching consumer APIs when the stream is still missing", async () => {
    const consumer = new OmniConsumer({} as never, "http://omni.local", "test-key");
    consumer["running"] = true;
    consumer["delay"] = async () => {};

    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => {
      const value = now;
      now += 1_000;
      return value;
    };

    const consumersInfo = mock(async () => ({}));
    const consumersAdd = mock(async () => ({}));
    const jsm = {
      streams: {
        info: mock(async () => {
          throw new Error("stream not found");
        }),
      },
      consumers: {
        info: consumersInfo,
        add: consumersAdd,
      },
    } as never;

    try {
      const ready = await consumer["ensureConsumer"](jsm, "MESSAGE", "ravi-messages", "message.received.>", 1_500);
      expect(ready).toBe(false);
    } finally {
      Date.now = originalNow;
    }

    expect(consumersInfo).not.toHaveBeenCalled();
    expect(consumersAdd).not.toHaveBeenCalled();
    expect(errorCalls).toContainEqual([
      "Timed out waiting for JetStream stream to appear",
      { stream: "MESSAGE", name: "ravi-messages" },
    ]);
  });

  it("does not call consumers.get when ensureConsumer says the stream is not ready", async () => {
    const consumer = new OmniConsumer({} as never, "http://omni.local", "test-key");
    consumer["running"] = true;
    consumer["jsm"] = {} as never;
    consumer["ensureConsumer"] = mock(async () => {
      consumer["running"] = false;
      return false;
    });
    consumer["delay"] = async () => {};

    const getConsumer = mock(async () => ({
      consume: async function* () {},
    }));
    const js = {
      consumers: {
        get: getConsumer,
      },
    } as never;

    await consumer["consumeLoop"](js, "MESSAGE", "ravi-messages", "message.received.>", async () => {});

    expect(getConsumer).not.toHaveBeenCalled();
  });
});
