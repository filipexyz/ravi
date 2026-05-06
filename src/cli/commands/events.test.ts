import { afterAll, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../../nats.js", () => ({
  connectNats: mock(async () => {}),
  closeNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  isExplicitConnect: () => false,
  publish: mock(async () => {}),
  subscribe: mock(() => (async function* () {})()),
  nats: {
    subscribe: () => (async function* () {})(),
    emit: mock(async () => {}),
    close: mock(async () => {}),
  },
}));

const { formatData, formatLiveEventJsonRecord, matchesReplayFilters, parseReplayTime } = await import("./events.js");

describe("formatData", () => {
  it("includes runtime failure details", () => {
    const text = formatData(
      { type: "turn.failed", error: "permission denied for codex" },
      "ravi.session.agent-main.runtime",
    );

    expect(text).toContain("turn.failed");
    expect(text).toContain("permission denied for codex");
  });

  it("includes runtime interruption details from nested error objects", () => {
    const text = formatData(
      { type: "turn.interrupted", error: { message: "user interrupted" } },
      "ravi.session.agent-main.runtime",
    );

    expect(text).toContain("turn.interrupted");
    expect(text).toContain("user interrupted");
  });

  it("formats native codex provider raw metadata", () => {
    const text = formatData(
      {
        type: "provider.raw",
        provider: "codex",
        nativeEvent: "turn.completed",
        model: "gpt-5.5",
        modelProvider: "openai",
        threadId: "thread_1234567890",
        turnId: "turn_abcdef123456",
      },
      "ravi.session.dev.runtime",
    );

    expect(text).toContain("turn.completed");
    expect(text).toContain("model=gpt-5.5");
    expect(text).toContain("provider=openai");
    expect(text).toContain("thread=thread_1…");
    expect(text).toContain("turn=turn_abc…");
  });

  it("formats runtime turn completion execution model", () => {
    const text = formatData(
      {
        type: "turn.complete",
        execution: { model: "gpt-5.5", provider: "openai" },
        usage: { inputTokens: 10, outputTokens: 4 },
      },
      "ravi.session.dev.runtime",
    );

    expect(text).toContain("turn.complete");
    expect(text).toContain("model=gpt-5.5");
    expect(text).toContain("provider=openai");
    expect(text).toContain("in=10");
    expect(text).toContain("out=4");
  });

  it("formats channel message events compactly", () => {
    const text = formatData(
      {
        type: "message.received",
        payload: {
          chatId: "120@g.us",
          from: "5511999",
          content: { type: "text", text: "hello from channel" },
        },
      },
      "message.received.whatsapp-baileys.main",
    );

    expect(text).toContain("message.received");
    expect(text).toContain("hello from channel");
    expect(text).toContain("chat=120@g.us");
  });
});

describe("event replay filters", () => {
  it("matches subject, contains, type and where filters", () => {
    const event = {
      subject: "message.received.whatsapp-baileys.main",
      raw: JSON.stringify({
        type: "message.received",
        payload: {
          chatId: "120@g.us",
          content: { type: "text", text: "context lost" },
        },
      }),
      data: {
        type: "message.received",
        payload: {
          chatId: "120@g.us",
          content: { type: "text", text: "context lost" },
        },
      },
    };

    expect(
      matchesReplayFilters(event, {
        subject: "message.received.>",
        contains: ["context"],
        type: "message.received",
        session: { input: "main-dm", needles: ["main-dm", "120@g.us"] },
        where: [{ path: "payload.content.text", op: "~=", expected: "lost" }],
      }),
    ).toBe(true);

    expect(
      matchesReplayFilters(event, {
        where: [{ path: "payload.chatId", op: "=", expected: "other@g.us" }],
      }),
    ).toBe(false);
  });

  it("parses ISO and epoch replay times", () => {
    expect(parseReplayTime("2026-04-19T12:00:00.000Z").toISOString()).toBe("2026-04-19T12:00:00.000Z");
    expect(parseReplayTime("1776598847376").toISOString()).toBe("2026-04-19T11:40:47.376Z");
  });
});

describe("event stream JSONL records", () => {
  it("formats live stream events as structured JSON records", () => {
    const record = formatLiveEventJsonRecord({
      count: 3,
      topic: "ravi.session.agent-main.runtime",
      data: { type: "turn.done", sessionName: "main" },
      now: new Date("2026-04-19T12:00:00.000Z"),
    });

    expect(record).toEqual({
      type: "event",
      count: 3,
      topic: "ravi.session.agent-main.runtime",
      shortTopic: "session.agent-main.runtime",
      timestamp: "2026-04-19T12:00:00.000Z",
      data: { type: "turn.done", sessionName: "main" },
    });
  });
});
