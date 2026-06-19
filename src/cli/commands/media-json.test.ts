import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

afterAll(() => mock.restore());

const emittedEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];
const mediaSendCalls: Array<Record<string, unknown>> = [];

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
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
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
  listElevenLabsVoices: mock(async () => []),
}));

mock.module("../../router/config.js", () => ({
  getAgent: () => ({
    defaults: {
      tts_lang: "en",
    },
  }),
}));

mock.module("../media-send.js", () => ({
  sendMediaWithOmniCli: mock(async (input: Record<string, unknown>) => {
    mediaSendCalls.push(input);
    const filePath = String(input.filePath ?? "/tmp/unknown.bin");
    const type = String(input.type ?? (filePath.endsWith(".png") ? "image" : "audio"));
    return {
      filePath,
      filename: String(input.filename ?? basename(filePath)),
      mimeType: type === "image" ? "image/png" : "audio/mpeg",
      type,
      target: {
        channel: "whatsapp",
        accountId: "main",
        instanceId: "inst-1",
        chatId: "chat-1",
      },
      delivery: {
        transport: "omni-send",
        args: ["send"],
        success: true,
        message: "Media sent",
        messageId: "msg-1",
        status: "sent",
        raw: { messageId: "msg-1", status: "sent" },
      },
    };
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
    mediaSendCalls.length = 0;
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

  it("generates audio from a relative markdown text file", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".ravi-audio-text-file-"));
    const filePath = join(dir, "prompt.md");
    const textFile = relative(process.cwd(), filePath);
    writeFileSync(filePath, "bonjour depuis un fichier\n");
    try {
      const { output, result } = await captureConsole(() =>
        new AudioCommands().generate(
          undefined,
          undefined,
          undefined,
          undefined,
          "fr",
          undefined,
          undefined,
          false,
          undefined,
          true,
          textFile,
        ),
      );
      const payload = JSON.parse(output);

      expect(payload.audio).toMatchObject({
        text: "bonjour depuis un fichier",
      });
      expect(payload.options).toMatchObject({ lang: "fr", voiceNote: false });
      expect(result).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe audio text file paths", async () => {
    const commands = new AudioCommands();
    await expect(
      commands.generate(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        true,
        "../x.txt",
      ),
    ).rejects.toThrow("--text-file must not contain '..' path segments.");
    await expect(
      commands.generate(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        true,
        "/tmp/x.txt",
      ),
    ).rejects.toThrow("--text-file must be a relative path inside the current working directory.");
    await expect(
      commands.generate(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        true,
        "x.pdf",
      ),
    ).rejects.toThrow("--text-file must point to a .md or .txt file.");
  });

  it("prints delivered media send results as typed JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-json-"));
    const filePath = join(dir, "sample.png");
    writeFileSync(filePath, "png");
    try {
      const { output, result } = await captureConsole(() =>
        new MediaCommands().send(filePath, "caption", "whatsapp", "chat-1", "main", undefined, false, true),
      );
      const payload = JSON.parse(output);

      expect(payload).toMatchObject({
        success: true,
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
          instanceId: "inst-1",
          chatId: "chat-1",
        },
        delivery: {
          transport: "omni-send",
          messageId: "msg-1",
          status: "sent",
        },
      });
      expect(result).toEqual(payload);
      expect(emittedEvents).toHaveLength(0);
      expect(mediaSendCalls).toEqual([
        expect.objectContaining({
          filePath,
          caption: "caption",
          voiceNote: false,
          target: {
            channel: "whatsapp",
            accountId: "main",
            chatId: "chat-1",
          },
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the direct media sender when audio generate runs with --send", async () => {
    const { output, result } = await captureConsole(() =>
      new AudioCommands().generate(
        "hello",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        true,
      ),
    );
    const payload = JSON.parse(output);

    expect(payload.sent).toMatchObject({
      transport: "omni-send",
      channel: "whatsapp",
      accountId: "main",
      instanceId: "inst-1",
      chatId: "chat-1",
      filename: "ravi-audio.mp3",
      voiceNote: true,
      messageId: "msg-1",
      status: "sent",
    });
    expect(result).toEqual(payload);
    expect(mediaSendCalls).toEqual([
      expect.objectContaining({
        filePath: "/tmp/ravi-audio.mp3",
        caption: "hello",
        type: "audio",
        filename: "ravi-audio.mp3",
        voiceNote: true,
      }),
    ]);
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
