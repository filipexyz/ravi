import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

const actualRouterIndexModule = await import("../../router/index.js");
const actualContactsModule = await import("../../contacts.js");
const actualSessionStreamModule = await import("../../session-prompts/stream.js");
// Cópia: o namespace é mutado in-place por mock.module.
const actualNatsModule = { ...(await import("../../nats.js")) };
const actualMediaModule = { ...(await import("../../utils/media.js")) };
const { logger } = await import("../../utils/logger.js");

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

mock.module("../../nats.js", () => ({
  getNats: () => {
    throw new Error("not used in this test");
  },
  isExplicitConnect: () => false,
  publish: publishMock,
  nats: {
    emit: mock(async () => {}),
    subscribe: async function* () {},
    close: mock(async () => {}),
  },
}));

mock.module("../../session-prompts/stream.js", () => ({
  ...actualSessionStreamModule,
  publishSessionPrompt: mock(async () => {}),
}));

mock.module("../../slash/index.js", () => ({
  handleSlashCommand: mock(async () => false),
}));

mock.module("../../router/index.js", () => ({
  ...actualRouterIndexModule,
  expandHome: (cwd: string) => cwd,
  resolveRoute: () => null,
}));

mock.module("../../config-store.js", () => ({
  configStore: {
    getConfig: () => configValue,
  },
}));

mock.module("../../contacts.js", () => ({
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

mock.module("../../utils/media.js", () => ({
  ...actualMediaModule,
  saveToAgentAttachments: mock(async () => null),
  MAX_AUDIO_BYTES: 16 * 1024 * 1024,
}));

mock.module("../../transcribe/openai.js", () => ({
  transcribeAudio: mock(async () => ""),
}));

const { ChannelInboundPipeline } = await import("./pipeline.js");
const { inboundEventFromSubject, noopHooks } = await import("./__tests__/fixtures.js");

afterAll(() => {
  loggerChildSpy.mockRestore();
  mock.restore();
  // mock.restore() não desfaz mock.module: sem isso o `nats` fake vaza para
  // outros arquivos, e um spyOn(nats, "emit") + mockRestore() posterior zera o
  // mock() de emit (passa a retornar undefined e quebra `nats.emit(...).catch`).
  mock.module("../../nats.js", () => actualNatsModule);
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

describe("ChannelInboundPipeline instance gating", () => {
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

    const consumer = new ChannelInboundPipeline({} as never);

    await consumer.handle(
      inboundEventFromSubject("message.received.whatsapp-baileys.disabled-instance", makeEvent("disabled-instance")),
      noopHooks(),
    );

    expect(publishCalls).toHaveLength(0);
  });

  it("still warns and emits for unknown unregistered instances", async () => {
    const consumer = new ChannelInboundPipeline({} as never);

    await consumer.handle(
      inboundEventFromSubject(
        "message.received.whatsapp-baileys.unregistered-instance",
        makeEvent("unregistered-instance"),
      ),
      noopHooks(),
    );

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

  it("silences unknown unregistered instances the source's hook ignores", async () => {
    const consumer = new ChannelInboundPipeline({} as never);
    const isIgnoredInstance = mock((instanceId: string) => instanceId === "ignored-instance");

    await consumer.handle(
      inboundEventFromSubject("message.received.whatsapp-baileys.ignored-instance", makeEvent("ignored-instance")),
      noopHooks({ isIgnoredInstance }),
    );

    expect(publishCalls).toHaveLength(0);
    expect(isIgnoredInstance).toHaveBeenCalledWith("ignored-instance");
  });

  it("emits ravi.instances.unregistered once per cooldown when the ignore hook does not match", async () => {
    const consumer = new ChannelInboundPipeline({} as never);
    const isIgnoredInstance = mock(() => false);
    const event = () =>
      inboundEventFromSubject("message.received.whatsapp-baileys.cooldown-instance", makeEvent("cooldown-instance"));

    await consumer.handle(event(), noopHooks({ isIgnoredInstance }));
    await consumer.handle(event(), noopHooks({ isIgnoredInstance }));

    expect(isIgnoredInstance).toHaveBeenCalledTimes(2);
    expect(publishCalls.filter(([topic]) => topic === "ravi.instances.unregistered")).toHaveLength(1);
  });
});
