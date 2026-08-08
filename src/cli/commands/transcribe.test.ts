/**
 * Agent-first contract tests for the `transcribe` CLI domain (Manual v2):
 * transcription is routine processing and runs immediately; no cost threshold
 * or estimate contract exists, so the CLI does not require `--execute`.
 * Format/file validation still happens before the provider call. Follows the
 * group.test.ts pattern: no-op decorator mocks + service mocks with spies +
 * `hasContext: () => true` so the contract helpers throw ContractError instead
 * of exiting the process.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(() => mock.restore());

const transcribeCalls: Array<Record<string, unknown>> = [];
let transcribeFailure: unknown;

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

mock.module("../../transcribe/service.js", () => ({
  SUPPORTED_AUDIO_EXTENSIONS: [".ogg", ".mp3", ".m4a", ".wav"],
  inferAudioMimeType: (filePath: string) => (filePath.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : undefined),
  transcribeFile: mock(async (input: Record<string, unknown>) => {
    transcribeCalls.push(input);
    if (transcribeFailure !== undefined) throw transcribeFailure;
    return {
      text: "texto transcrito",
      provider: "openai",
      model: "whisper-1",
      duration: 12,
      source: {
        filePath: String(input.filePath),
        mimeType: String(input.mimeType),
        sizeBytes: 3,
        sizeMB: 0,
      },
    };
  }),
}));

const { TranscribeCommands } = await import("./transcribe.js");
const { ContractError } = await import("../agent-contract.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

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

let audioDir: string;

beforeEach(() => {
  transcribeCalls.length = 0;
  transcribeFailure = undefined;
});

function seedAudioFile(name = "voz.mp3"): string {
  audioDir = mkdtempSync(join(tmpdir(), "ravi-transcribe-test-"));
  const filePath = join(audioDir, name);
  writeFileSync(filePath, "mp3");
  return filePath;
}

describe("transcribe file contract", () => {
  it("runs the transcription provider directly without --execute", async () => {
    const filePath = seedAudioFile();
    try {
      const { result } = await captureConsole(() => new TranscribeCommands().file(filePath, "pt", true));

      expect(transcribeCalls).toHaveLength(1);
      expect(transcribeCalls[0]).toMatchObject({ mimeType: "audio/mpeg", language: "pt" });
      expect(result).toMatchObject({
        success: true,
        transcription: { text: "texto transcrito", provider: "openai" },
        options: { lang: "pt" },
      });
    } finally {
      rmSync(audioDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported formats before the provider call", async () => {
    await expect(new TranscribeCommands().file("/tmp/nota.xyz", "pt", true)).rejects.toThrow(
      "Unsupported audio format",
    );
    expect(transcribeCalls).toHaveLength(0);
  });

  it("exits 1 with FILE_NOT_FOUND when the audio file does not exist", async () => {
    const missingPath = "C:/sentinel/private/file-9P3X.mp3";
    const error = await expectContractError(
      () => new TranscribeCommands().file(missingPath, "pt", true),
      "FILE_NOT_FOUND",
      1,
    );

    expect(error.message).toBe("Audio file was not found.");
    expect(error.details.suggestedAction).toContain("audio file path");
    expect(JSON.stringify(error.envelope())).not.toContain("file-9P3X");
    expect(JSON.stringify(error.envelope())).not.toContain(missingPath);
    expect(transcribeCalls).toHaveLength(0);
  });

  it.each([
    new Error("PRIVATE_MESSAGE_8K2R"),
    "SENTINEL_SECRET_7M4Q",
  ])("does not expose a provider rejection in the TRANSCRIBE_FAILED envelope", async (providerFailure) => {
    const filePath = seedAudioFile();
    transcribeFailure = providerFailure;
    try {
      const error = await expectContractError(
        () => new TranscribeCommands().file(filePath, "pt", true),
        "TRANSCRIBE_FAILED",
        1,
      );

      expect(error.message).toBe("Audio transcription failed.");
      expect(error.details.retryable).toBe(true);
      const serialized = JSON.stringify(error.envelope());
      expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
      expect(serialized).not.toContain("SENTINEL_SECRET_7M4Q");
      expect(transcribeCalls).toHaveLength(1);
    } finally {
      rmSync(audioDir, { recursive: true, force: true });
    }
  });
});
