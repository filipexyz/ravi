/**
 * Agent-first contract tests for the `image` CLI domain (Manual v2): image
 * generation spends EXTERNAL API money, so `image generate` is braked —
 * dry-run + exit 3 by default BEFORE any artifact record is created or worker
 * spawned; `--execute` performs the paid call (the internal async worker is
 * spawned with `--execute` already applied). Uses the group.test.ts pattern:
 * no-op decorator mocks + service mocks with spies + `hasContext: () => true`
 * so the contract helpers throw ContractError instead of exiting the process.
 *
 * The default async path spawns a real detached process, so the execute-path
 * test uses `--sync`, which exercises the same brake and the same provider
 * call without leaving the test process.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

const generateImageCalls: Array<Record<string, unknown>> = [];
const createArtifactCalls: Array<Record<string, unknown>> = [];
let artifactSequence = 0;

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
  getAgent: () => undefined,
}));

mock.module("../../router/router-db.js", () => ({
  dbGetInstance: () => undefined,
  dbGetInstanceByInstanceId: () => undefined,
  dbGetSetting: () => undefined,
}));

mock.module("../../artifacts/store.js", () => ({
  createArtifact: (input: Record<string, unknown>) => {
    createArtifactCalls.push(input);
    artifactSequence += 1;
    return { id: `art-${artifactSequence}`, ...input };
  },
  updateArtifact: (id: string, input: Record<string, unknown>) => ({ id, ...input }),
  getArtifact: () => null,
  appendArtifactEvent: () => {},
  attachArtifact: () => {},
}));

mock.module("../../image/atlas.js", () => ({
  splitImageAtlas: () => {
    throw new Error("not under test");
  },
}));

mock.module("../media-send.js", () => ({
  sendMediaWithOmniCli: mock(async () => {
    throw new Error("not under test");
  }),
}));

const { ImageCommands } = await import("./image.js");
const { ContractError } = await import("../agent-contract.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

interface GenerateOverrides {
  provider?: string;
  asyncMode?: boolean;
  syncMode?: boolean;
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
    undefined,
    overrides.asyncMode,
    overrides.syncMode,
    undefined,
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
  artifactSequence = 0;
});

describe("image generate contract", () => {
  it("without --execute is a dry-run: exit 3, NO provider call, NO artifact created, NO worker spawned", async () => {
    const error = await expectContractError(
      () => runGenerate("gato roxo no espaço", { provider: "openai", asJson: true }),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      prompt: "gato roxo no espaço",
      provider: "openai",
      mode: "fast",
      async: true,
      send: false,
    });
    expect(generateImageCalls).toHaveLength(0);
    expect(createArtifactCalls).toHaveLength(0);
  });

  it("resolves and validates the provider BEFORE the brake", async () => {
    await expect(runGenerate("gato", { asJson: true })).rejects.toThrow("No image provider configured");
    expect(generateImageCalls).toHaveLength(0);
    expect(createArtifactCalls).toHaveLength(0);
  });

  it("rejects --async plus --sync BEFORE the brake", async () => {
    await expect(
      runGenerate("gato", { provider: "openai", asyncMode: true, syncMode: true, asJson: true }),
    ).rejects.toThrow("--async and --sync cannot be used together");
    expect(generateImageCalls).toHaveLength(0);
  });

  it("with --execute (sync path) calls the paid provider and returns the typed payload", async () => {
    const { result } = await captureConsole(() =>
      runGenerate("gato roxo", { provider: "openai", syncMode: true, asJson: true, execute: true }),
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
  });
});
