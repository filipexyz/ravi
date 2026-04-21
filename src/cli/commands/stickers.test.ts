import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSticker } from "../../stickers/catalog.js";

afterAll(() => mock.restore());

const emittedEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];
const runtimeContext = {
  agentId: "dev",
  source: {
    channel: "whatsapp-baileys",
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

const { StickerCommands } = await import("./stickers.js");

let stateDir: string | null = null;
let previousStateDir: string | undefined;

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

beforeEach(() => {
  previousStateDir = process.env.RAVI_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), "ravi-stickers-cli-"));
  process.env.RAVI_STATE_DIR = stateDir;
  runtimeContext.source = {
    channel: "whatsapp-baileys",
    accountId: "main",
    chatId: "5511999999999",
  };
  emittedEvents.length = 0;
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.RAVI_STATE_DIR;
  } else {
    process.env.RAVI_STATE_DIR = previousStateDir;
  }
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
});

function seedSticker(id = "wave") {
  const mediaPath = join(stateDir!, `${id}.webp`);
  writeFileSync(mediaPath, "webp");
  return addSticker({
    id,
    label: "Wave",
    description: "Use for a friendly hello.",
    channels: ["whatsapp"],
    agents: [],
    media: { kind: "file", path: mediaPath },
    enabled: true,
  });
}

describe("StickerCommands", () => {
  it("prints typed JSON for list/show/add/remove surfaces", async () => {
    const mediaPath = join(stateDir!, "thumbs.webp");
    writeFileSync(mediaPath, "webp");
    const commands = new StickerCommands();

    const { output: addOutput } = await captureConsole(() =>
      commands.add(
        "thumbs_up",
        mediaPath,
        "Thumbs up",
        "Use for quick approval.",
        "Avoid when a textual answer is needed.",
        "whatsapp",
        "main",
        false,
        false,
        true,
      ),
    );
    expect(JSON.parse(addOutput)).toMatchObject({
      success: true,
      action: "add",
      sticker: {
        id: "thumbs_up",
        channels: ["whatsapp"],
        agents: ["main"],
      },
    });

    const { output: listOutput } = await captureConsole(() => commands.list(true));
    expect(JSON.parse(listOutput)).toMatchObject({ total: 1 });

    const { output: showOutput } = await captureConsole(() => commands.show("thumbs_up", true));
    expect(JSON.parse(showOutput).sticker.id).toBe("thumbs_up");

    const { output: removeOutput } = await captureConsole(() => commands.remove("thumbs_up", true));
    expect(JSON.parse(removeOutput)).toEqual({
      success: true,
      action: "remove",
      stickerId: "thumbs_up",
    });
  });

  it("queues WhatsApp sticker sends as JSON without sending media content through the prompt", async () => {
    const sticker = seedSticker();

    const { output, result } = await captureConsole(() =>
      new StickerCommands().send("wave", undefined, undefined, undefined, undefined, true),
    );
    const payload = JSON.parse(output);

    expect(payload).toMatchObject({
      success: true,
      topic: "ravi.stickers.send",
      sticker: {
        id: "wave",
        label: "Wave",
      },
      target: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "5511999999999",
      },
    });
    expect(result).toEqual(payload);
    expect(emittedEvents).toEqual([
      {
        topic: "ravi.stickers.send",
        payload: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "5511999999999",
          stickerId: "wave",
          label: "Wave",
          filePath: sticker.media.path,
          mimeType: "image/webp",
          filename: "wave.webp",
        },
      },
    ]);
  });

  it("rejects sticker sends on channels without sticker capability", async () => {
    seedSticker();
    runtimeContext.source = {
      channel: "matrix",
      accountId: "matrix-main",
      chatId: "!room",
    };

    await expect(new StickerCommands().send("wave", undefined, undefined, undefined, undefined, true)).rejects.toThrow(
      "Stickers are not supported on channel",
    );
    expect(emittedEvents).toHaveLength(0);
  });
});
