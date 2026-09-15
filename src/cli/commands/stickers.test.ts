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
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => runtimeContext,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
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
const { ContractError } = await import("../agent-contract.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

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

function seedSticker(id = "wave", label = "Wave") {
  const mediaPath = join(stateDir!, `${id}.webp`);
  writeFileSync(mediaPath, "webp");
  return addSticker({
    id,
    label,
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

    const { output: removeOutput } = await captureConsole(() => commands.remove("thumbs_up", true, true));
    expect(JSON.parse(removeOutput)).toEqual({
      success: true,
      action: "remove",
      stickerId: "thumbs_up",
    });
  });

  it("queues WhatsApp sticker sends as JSON without sending media content through the prompt", async () => {
    const sticker = seedSticker();

    const { output, result } = await captureConsole(() =>
      new StickerCommands().send("wave", undefined, undefined, undefined, undefined, true, true),
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

    // Capability validation runs BEFORE the write brake: no --execute needed to
    // observe the rejection, and nothing is emitted.
    await expect(new StickerCommands().send("wave", undefined, undefined, undefined, undefined, true)).rejects.toThrow(
      "Stickers are not supported on channel",
    );
    expect(emittedEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stickers — agent-first contract (write brake, not-found envelope, --fields)
// ---------------------------------------------------------------------------

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<ContractErrorInstance> {
  let caught: unknown;
  await captureConsole(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as ContractErrorInstance;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

describe("stickers contract", () => {
  it("send without --execute is a dry-run: exit 3 and NO NATS emit", async () => {
    const label = "PRIVATE_LABEL_8K2R";
    const chatId = "PRIVATE_CHAT_8K2R";
    seedSticker("wave", label);
    runtimeContext.source.chatId = chatId;

    const error = await expectContractError(
      () => new StickerCommands().send("wave", undefined, undefined, undefined, undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toEqual({
      sticker: { id: "wave", labelPresent: true },
      target: {
        channel: "whatsapp",
        accountId: "main",
        chatIdPresent: true,
        threadIdPresent: false,
      },
      fileName: "[REDACTED:content length=9]",
      mimeType: "image/webp",
    });
    const serializedPlan = JSON.stringify(error.details.plan);
    expect(serializedPlan).not.toContain(label);
    expect(serializedPlan).not.toContain(chatId);
    expect(emittedEvents).toHaveLength(0);
  });

  it("send on an unknown sticker exits 1 with STICKER_NOT_FOUND and catalog suggestions", async () => {
    seedSticker();

    const error = await expectContractError(
      () => new StickerCommands().send("wav", undefined, undefined, undefined, undefined, true, true),
      "STICKER_NOT_FOUND",
      1,
    );

    expect(error.details.suggestions).toContain("wave");
    expect(error.details.suggestedAction).toContain("ravi stickers list");
    expect(emittedEvents).toHaveLength(0);
  });

  it("does not expose the local media path when sticker media is missing", async () => {
    const privatePath = join(stateDir!, "PRIVATE_CUSTOMER_STICKER_8K2R.webp");
    writeFileSync(privatePath, "webp");
    addSticker({
      id: "missing-media",
      label: "Missing media",
      description: "Missing file fixture.",
      channels: ["whatsapp"],
      agents: [],
      media: { kind: "file", path: privatePath },
      enabled: true,
    });
    rmSync(privatePath);

    const error = await expectContractError(
      () => new StickerCommands().send("missing-media", undefined, undefined, undefined, undefined, true, true),
      "STICKER_MEDIA_NOT_FOUND",
      1,
    );

    expect(error.message).toBe("Sticker media file is unavailable.");
    expect(error.details).toMatchObject({
      mediaPathPresent: true,
      suggestedAction: "Re-add the sticker media and retry the command",
    });
    expect(JSON.stringify(error.envelope())).not.toContain(privatePath);
    expect(JSON.stringify(error.envelope())).not.toContain("PRIVATE_CUSTOMER_STICKER_8K2R");
    expect(emittedEvents).toHaveLength(0);
  });

  it("show on an unknown sticker exits 1 with STICKER_NOT_FOUND", async () => {
    seedSticker();

    const error = await expectContractError(() => new StickerCommands().show("waev", true), "STICKER_NOT_FOUND", 1);

    expect(error.details.suggestions).toContain("wave");
  });

  it("remove without --execute is a dry-run: exit 3 and the sticker stays in the catalog", async () => {
    const label = "PRIVATE_LABEL_8K2R";
    const sticker = seedSticker("wave", label);
    const commands = new StickerCommands();

    const error = await expectContractError(
      () => commands.remove("wave", true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({
      stickerId: "wave",
      labelPresent: true,
      media: { kind: "file", name: "wave.webp" },
      enabled: true,
    });
    const serializedPlan = JSON.stringify(error.details.plan);
    expect(serializedPlan).not.toContain(label);
    expect(serializedPlan).not.toContain(sticker.media.path);
    const { output } = await captureConsole(() => commands.show("wave", true));
    expect(JSON.parse(output).sticker.id).toBe("wave");
  });

  it("remove on an unknown sticker exits 1 with STICKER_NOT_FOUND before the brake", async () => {
    seedSticker();

    const error = await expectContractError(
      () => new StickerCommands().remove("wav", true, undefined),
      "STICKER_NOT_FOUND",
      1,
    );

    expect(error.details.suggestions).toContain("wave");
  });

  it("list --fields narrows each item to the requested fields", async () => {
    seedSticker("wave");
    seedSticker("thumbs");

    const { result } = await captureConsole(() => new StickerCommands().list(true, undefined, undefined, "id,enabled"));

    const payload = result as { items: Array<Record<string, unknown>>; stickers: Array<Record<string, unknown>> };
    expect(payload.items).toHaveLength(2);
    for (const item of payload.items) {
      expect(Object.keys(item).sort()).toEqual(["enabled", "id"]);
    }
    for (const item of payload.stickers) {
      expect(Object.keys(item).sort()).toEqual(["enabled", "id"]);
    }
  });
});
