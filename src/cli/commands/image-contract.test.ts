/**
 * Agent-first contract tests for the `image` CLI domain (Manual v2): image
 * generation without delivery runs immediately. Externally visible delivery
 * is braked before provider, artifact, worker and sender side effects. Uses the
 * group.test.ts pattern:
 * no-op decorator mocks + service mocks with spies + `hasContext: () => true`
 * so the contract helpers throw ContractError instead of exiting the process.
 *
 * The default async path spawns a real detached process, so provider-path
 * tests use `--sync` and do not leave the test process.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(() => mock.restore());

const generateImageCalls: Array<Record<string, unknown>> = [];
const createArtifactCalls: Array<Record<string, unknown>> = [];
const artifactEventCalls: Array<Record<string, unknown>> = [];
const imageSendCalls: Array<Record<string, unknown>> = [];
const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
let splitImageAtlasCalls = 0;
let artifactSequence = 0;
let forbidImageDryRunStateReads = false;
const imageStateReads: string[] = [];

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

mock.module("node:child_process", () => ({
  spawn: mock((command: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ command, args, options });
    return { pid: 4321, unref: () => {} };
  }),
}));

mock.module("../context.js", () => ({
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../image/generator.js", () => ({
  normalizeImageProvider: (value?: string) => (value === "openai" || value === "gemini" ? value : undefined),
  generateImage: mock(async (prompt: string, options: Record<string, unknown>) => {
    generateImageCalls.push({ prompt, ...options });
    return [
      {
        filePath: "/tmp/ravi-image-1.png",
        mimeType: "image/png",
        prompt,
        provider: "openai",
        model: "gpt-image-2",
        usage: { total_tokens: 100 },
      },
    ];
  }),
}));

mock.module("../../router/config.js", () => ({
  getAgent: () => {
    imageStateReads.push("agent");
    if (forbidImageDryRunStateReads) throw new Error("image dry-run read agent state");
    return undefined;
  },
}));

mock.module("../../router/router-db.js", () => ({
  dbGetInstance: () => {
    imageStateReads.push("instance");
    if (forbidImageDryRunStateReads) throw new Error("image dry-run read instance state");
    return undefined;
  },
  dbGetInstanceByInstanceId: () => {
    imageStateReads.push("instance-by-id");
    if (forbidImageDryRunStateReads) throw new Error("image dry-run read instance state");
    return undefined;
  },
  dbGetSetting: () => {
    imageStateReads.push("setting");
    if (forbidImageDryRunStateReads) throw new Error("image dry-run read setting state");
    return undefined;
  },
}));

mock.module("../../artifacts/store.js", () => ({
  createArtifact: (input: Record<string, unknown>) => {
    createArtifactCalls.push(input);
    artifactSequence += 1;
    return { id: `art-${artifactSequence}`, ...input };
  },
  updateArtifact: (id: string, input: Record<string, unknown>) => ({ id, ...input }),
  getArtifact: () => null,
  appendArtifactEvent: (id: string, input: Record<string, unknown>) => {
    artifactEventCalls.push({ id, ...input });
  },
  attachArtifact: () => {},
}));

mock.module("../../image/atlas.js", () => ({
  sanitizeAtlasCellName: (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, "-"),
  splitImageAtlas: () => {
    splitImageAtlasCalls += 1;
    throw new Error("not under test");
  },
}));

mock.module("../media-send.js", () => ({
  resolveMediaSendTarget: (target: Record<string, unknown> = {}) => {
    imageStateReads.push("delivery-target");
    if (forbidImageDryRunStateReads) throw new Error("image dry-run resolved delivery state");
    return {
      channel: target.channel ?? "whatsapp",
      accountId: target.accountId ?? "main",
      instanceId: "inst-1",
      chatId: target.chatId ?? "chat-1",
      ...(target.threadId ? { threadId: target.threadId } : {}),
    };
  },
  sendMediaWithOmniCli: mock(async (input: Record<string, unknown>) => {
    imageSendCalls.push(input);
    return {
      target: { channel: "whatsapp", accountId: "main", instanceId: "inst-1", chatId: "chat-1" },
      delivery: { transport: "omni-send", messageId: "msg-1", status: "sent" },
      filename: "ravi-image-1.png",
    };
  }),
}));

const { ImageAtlasCommands, ImageCommands } = await import("./image.js");
const { ContractError } = await import("../agent-contract.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

interface GenerateOverrides {
  provider?: string;
  source?: string;
  output?: string;
  caption?: string;
  asyncMode?: boolean;
  syncMode?: boolean;
  artifactId?: string;
  send?: boolean;
  asJson?: boolean;
  execute?: boolean;
}

function runGenerate(prompt: string, overrides: GenerateOverrides = {}) {
  // Positional signature: prompt, provider, model, mode, source, output,
  // aspect, size, quality, format, compression, background, send, caption,
  // asyncMode, syncMode, artifactId, asyncWorker, asJson, execute.
  return new ImageCommands().generate(
    prompt,
    overrides.provider,
    undefined, // model
    undefined, // mode
    overrides.source,
    overrides.output,
    undefined, // aspect
    undefined, // size
    undefined, // quality
    undefined, // format
    undefined, // compression
    undefined, // background
    overrides.send,
    overrides.caption,
    overrides.asyncMode,
    overrides.syncMode,
    overrides.artifactId,
    undefined,
    overrides.asJson,
    overrides.execute,
  );
}

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

beforeEach(() => {
  generateImageCalls.length = 0;
  createArtifactCalls.length = 0;
  artifactEventCalls.length = 0;
  imageSendCalls.length = 0;
  spawnCalls.length = 0;
  artifactSequence = 0;
  splitImageAtlasCalls = 0;
  forbidImageDryRunStateReads = false;
  imageStateReads.length = 0;
});

describe("image generate contract", () => {
  it("without delivery runs immediately without --execute", async () => {
    const { result } = await captureConsole(() =>
      runGenerate("gato roxo no espaço", { provider: "openai", syncMode: true, asJson: true }),
    );

    expect(generateImageCalls).toHaveLength(1);
    expect(createArtifactCalls).toHaveLength(1);
    expect(result).toMatchObject({
      success: true,
      options: { provider: "openai", mode: "fast" },
    });
  });

  it("with delivery in virgin state dry-runs before DB, provider, artifact and sender", async () => {
    const prompt = "PROMPT_SECRET_AT_START gato roxo PROMPT_SECRET_AT_END";
    const caption = "CAPTION_SECRET_8K2R";
    const testDir = mkdtempSync(join(tmpdir(), "ravi-image-generate-private-"));
    const sourcePath = join(testDir, "source.png");
    const outputDir = join(testDir, "private-output");
    writeFileSync(sourcePath, "fake image", "utf8");
    try {
      forbidImageDryRunStateReads = true;
      const error = await expectContractError(
        () =>
          runGenerate(prompt, {
            provider: "openai",
            source: sourcePath,
            output: outputDir,
            caption,
            send: true,
            asJson: true,
          }),
        "WRITE_REQUIRES_EXECUTE",
        3,
      );

      expect(error.details.dryRun).toBe(true);
      expect(error.details.plan).toEqual({
        promptChars: prompt.length,
        provider: "openai",
        model: null,
        mode: "fast",
        aspect: null,
        size: null,
        quality: null,
        format: null,
        compression: null,
        background: null,
        sourceName: expect.stringContaining("[REDACTED:content"),
        outputDirPresent: true,
        async: true,
        send: true,
        target: {
          channel: null,
          accountId: null,
          chatIdPresent: false,
          threadIdPresent: false,
        },
        captionPresent: true,
      });
      const serializedPlan = JSON.stringify(error.details.plan);
      expect(serializedPlan).not.toContain("PROMPT_SECRET_AT_START");
      expect(serializedPlan).not.toContain("PROMPT_SECRET_AT_END");
      expect(serializedPlan).not.toContain(caption);
      expect(serializedPlan).not.toContain(sourcePath);
      expect(serializedPlan).not.toContain(outputDir);
      expect(serializedPlan).not.toContain("chat-1");
      expect(serializedPlan).not.toContain("inst-1");
      expect(generateImageCalls).toHaveLength(0);
      expect(createArtifactCalls).toHaveLength(0);
      expect(artifactEventCalls).toHaveLength(0);
      expect(spawnCalls).toHaveLength(0);
      expect(imageSendCalls).toHaveLength(0);
      expect(imageStateReads).toEqual([]);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("resolves and validates the provider BEFORE the brake", async () => {
    await expect(runGenerate("gato", { asJson: true })).rejects.toThrow("No image provider configured");
    expect(generateImageCalls).toHaveLength(0);
    expect(createArtifactCalls).toHaveLength(0);
  });

  it("rejects an invalid explicit provider before the delivery brake", async () => {
    await expectContractError(
      () => runGenerate("gato", { provider: "private-provider", send: true, asJson: true }),
      "IMAGE_PROVIDER_NOT_CONFIGURED",
      1,
    );
    expect(imageStateReads).toEqual([]);
    expect(generateImageCalls).toHaveLength(0);
    expect(createArtifactCalls).toHaveLength(0);
  });

  it("rejects a caller-supplied worker artifact id before the delivery brake", async () => {
    await expect(
      runGenerate("gato", {
        provider: "openai",
        artifactId: "art_private_worker",
        send: true,
        asJson: true,
      }),
    ).rejects.toThrow("--artifact-id is reserved for internal image async workers");
    expect(imageStateReads).toEqual([]);
    expect(generateImageCalls).toHaveLength(0);
    expect(createArtifactCalls).toHaveLength(0);
  });

  it("rejects --async plus --sync BEFORE the brake", async () => {
    await expect(
      runGenerate("gato", { provider: "openai", asyncMode: true, syncMode: true, asJson: true }),
    ).rejects.toThrow("--async and --sync cannot be used together");
    expect(generateImageCalls).toHaveLength(0);
  });

  it("with --execute and --send calls the provider and returns the typed payload", async () => {
    const { result } = await captureConsole(() =>
      runGenerate("gato roxo", { provider: "openai", syncMode: true, send: true, asJson: true, execute: true }),
    );

    expect(generateImageCalls).toHaveLength(1);
    expect(generateImageCalls[0]).toMatchObject({ prompt: "gato roxo", provider: "openai", mode: "fast" });
    expect(result).toMatchObject({
      success: true,
      options: { provider: "openai", mode: "fast" },
    });
    const images = (result as { images: Array<Record<string, unknown>> }).images;
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      filePath: "/tmp/ravi-image-1.png",
      provider: "openai",
      model: "gpt-image-2",
      sendCommand: 'ravi media send "/tmp/ravi-image-1.png" --execute',
    });
    expect(imageSendCalls).toHaveLength(1);
  });
});

describe("image atlas split contract", () => {
  it("with --send but without --execute stops before local derivation, artifacts and delivery", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "ravi-image-atlas-contract-"));
    const inputPath = join(testDir, "atlas.png");
    writeFileSync(inputPath, "fake image", "utf8");
    const caption = "ATLAS_SECRET_AT_START Crop {name} ATLAS_SECRET_AT_END";
    try {
      const error = await expectContractError(
        () =>
          new ImageAtlasCommands().split(
            inputPath,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            caption,
            "main",
            "chat-1",
            "whatsapp",
            undefined,
            true,
          ),
        "WRITE_REQUIRES_EXECUTE",
        3,
      );

      expect(error.details.plan).toEqual({
        inputName: expect.stringContaining("[REDACTED:content"),
        outputDirMode: "generated",
        cols: 3,
        rows: 2,
        mode: "raw",
        send: true,
        target: {
          channel: "whatsapp",
          accountId: "main",
          chatIdPresent: true,
          threadIdPresent: false,
        },
        captionPresent: true,
      });
      const serializedPlan = JSON.stringify(error.details.plan);
      expect(serializedPlan).not.toContain("ATLAS_SECRET_AT_START");
      expect(serializedPlan).not.toContain("ATLAS_SECRET_AT_END");
      expect(serializedPlan).not.toContain(inputPath);
      expect(serializedPlan).not.toContain("chat-1");
      expect(serializedPlan).not.toContain("inst-1");
      expect(splitImageAtlasCalls).toBe(0);
      expect(createArtifactCalls).toHaveLength(0);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("rejects a missing input before the delivery brake", async () => {
    await expect(
      new ImageAtlasCommands().split(
        join(tmpdir(), "ravi-missing-atlas.png"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        "main",
        "chat-1",
        "whatsapp",
        undefined,
        true,
      ),
    ).rejects.toThrow("Input image not found");
    expect(splitImageAtlasCalls).toBe(0);
    expect(createArtifactCalls).toHaveLength(0);
  });
});
