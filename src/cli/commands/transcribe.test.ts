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
import { join, resolve } from "node:path";

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
  const originalError = console.error;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  console.error = console.log;
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
    console.error = originalError;
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
    const missingPath = "/tmp/ravi-missing-audio-fixture.mp3";
    const error = await expectContractError(
      () => new TranscribeCommands().file(missingPath, "pt", true),
      "FILE_NOT_FOUND",
      1,
    );

    expect(error.message).toBe("Audio file was not found.");
    expect(error.details.suggestedAction).toContain("audio file path");
    expect(error.envelope().error).toMatchObject({
      cause: "The requested audio file does not exist.",
      context: { operation: "transcribe file", file: resolve(missingPath), code: "ENOENT" },
    });
    expect(transcribeCalls).toHaveLength(0);
  });

  it.each([true, false])("preserves the provider cause and context in final output (json=%s)", async (asJson) => {
    const filePath = seedAudioFile();
    transcribeFailure = Object.assign(new Error("HTTP 429: audio quota exceeded; api_key=synthetic-credential"), {
      status: 429,
      code: "insufficient_quota",
      context: { provider: "openai", model: "whisper-1" },
    });
    try {
      let caught: unknown;
      const { output } = await captureConsole(async () => {
        try {
          await new TranscribeCommands().file(filePath, "pt", asJson);
        } catch (error) {
          caught = error;
        }
      });
      expect(caught).toBeInstanceOf(ContractError);
      const error = caught as ContractErrorInstance;
      expect(error.code).toBe("TRANSCRIBE_FAILED");
      expect(error.message).toBe("Audio transcription failed.");
      expect(error.exitCode).toBe(1);
      expect(error.envelope().error).toMatchObject({
        retryable: true,
        cause: "HTTP 429: audio quota exceeded; api_key=[redacted]",
        context: {
          operation: "transcribe file",
          file: filePath,
          provider: "openai",
          model: "whisper-1",
          status: 429,
          code: "insufficient_quota",
        },
      });
      expect(output).toContain("HTTP 429: audio quota exceeded");
      expect(output).toContain("api_key=[redacted]");
      expect(output).toContain("openai");
      expect(output).toContain(filePath);
      expect(output).not.toContain("synthetic-credential");
      expect(transcribeCalls).toHaveLength(1);
    } finally {
      rmSync(audioDir, { recursive: true, force: true });
    }
  });

  it.each([new Error("ffmpeg exited 127: executable not found"), "No transcription API key configured"])(
    "keeps actionable errors even when no provider metadata is available",
    async (providerFailure) => {
      const filePath = seedAudioFile();
      transcribeFailure = providerFailure;
      try {
        const error = await expectContractError(
          () => new TranscribeCommands().file(filePath, "pt", true),
          "TRANSCRIBE_FAILED",
          1,
        );
        expect(error.envelope().error.cause).toBe(
          providerFailure instanceof Error ? providerFailure.message : providerFailure,
        );
        expect(error.envelope().error.context).toMatchObject({ operation: "transcribe file", file: filePath });
      } finally {
        rmSync(audioDir, { recursive: true, force: true });
      }
    },
  );
});
