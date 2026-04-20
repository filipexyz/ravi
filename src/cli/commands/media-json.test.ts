import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(() => mock.restore());

const emittedEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];

const runtimeContext = {
  agentId: "dev",
  source: {
    channel: "whatsapp",
    accountId: "main",
    chatId: "5511999999999",
  },
};

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Scope: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => runtimeContext,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  nats: {
    emit: mock(async (topic: string, payload: Record<string, unknown>) => {
      emittedEvents.push({ topic, payload });
    }),
  },
}));

mock.module("../../audio/generator.js", () => ({
  generateAudio: mock(async () => ({
    filePath: "/tmp/ravi-audio.mp3",
    mimeType: "audio/mpeg",
  })),
}));

mock.module("../../router/config.js", () => ({
  getAgent: () => ({
    defaults: {
      tts_lang: "en",
    },
  }),
}));

const { AudioCommands } = await import("./audio.js");
const { MediaCommands } = await import("./media.js");
const { ReactCommands } = await import("./react.js");

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

describe("media/audio/react JSON output", () => {
  beforeEach(() => {
    emittedEvents.length = 0;
  });

  it("prints generated audio artifacts as typed JSON without human progress text", async () => {
    const { output, result } = await captureConsole(() =>
      new AudioCommands().generate(
        "hello",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        true,
      ),
    );
    const payload = JSON.parse(output);

    expect(output).not.toContain("Generating audio");
    expect(payload.success).toBe(true);
    expect(payload.audio).toMatchObject({
      filePath: "/tmp/ravi-audio.mp3",
      mimeType: "audio/mpeg",
      text: "hello",
    });
    expect(payload.options).toMatchObject({ lang: "en", voiceNote: false });
    expect(result).toEqual(payload);
    expect(emittedEvents).toHaveLength(0);
  });

  it("prints queued media send results as typed JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-json-"));
    const filePath = join(dir, "sample.png");
    writeFileSync(filePath, "png");
    try {
      const { output, result } = await captureConsole(() =>
        new MediaCommands().send(filePath, "caption", "whatsapp", "chat-1", "main", false, true),
      );
      const payload = JSON.parse(output);

      expect(payload).toMatchObject({
        success: true,
        topic: "ravi.media.send",
        media: {
          filePath,
          filename: "sample.png",
          mimeType: "image/png",
          type: "image",
          caption: "caption",
          voiceNote: false,
        },
        target: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "chat-1",
        },
      });
      expect(result).toEqual(payload);
      expect(emittedEvents).toEqual([
        expect.objectContaining({
          topic: "ravi.media.send",
          payload: expect.objectContaining({ filePath, filename: "sample.png", type: "image" }),
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints reaction send results as typed JSON", async () => {
    const { output, result } = await captureConsole(() => new ReactCommands().send("mid-1", "+1", true));
    const payload = JSON.parse(output);

    expect(payload).toMatchObject({
      success: true,
      topic: "ravi.outbound.reaction",
      reaction: {
        messageId: "mid-1",
        emoji: "+1",
      },
      target: runtimeContext.source,
    });
    expect(result).toEqual(payload);
    expect(emittedEvents).toEqual([
      {
        topic: "ravi.outbound.reaction",
        payload: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "5511999999999",
          messageId: "mid-1",
          emoji: "+1",
        },
      },
    ]);
  });
});
