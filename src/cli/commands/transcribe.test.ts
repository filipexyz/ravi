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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(() => mock.restore());

const transcribeCalls: Array<Record<string, unknown>> = [];
let transcribeFailure: unknown;
let runtimeInvocation = false;
let callerCwd: string | undefined;

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
  getContext: () => (callerCwd ? { cwd: callerCwd } : undefined),
  hasRuntimeInvocationContext: () => runtimeInvocation,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

class MockTranscribeFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

mock.module("../../transcribe/service.js", () => ({
  TranscribeFileError: MockTranscribeFileError,
  SUPPORTED_AUDIO_EXTENSIONS: [".ogg", ".mp3", ".m4a", ".wav"],
  MAX_TRANSCRIBE_FILE_BYTES: 200 * 1024 * 1024,
  inferAudioMimeType: (filePath: string) => {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".wav")) return "audio/wav";
    return undefined;
  },
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
  runtimeInvocation = false;
  callerCwd = undefined;
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

  it.each([new Error("PRIVATE_MESSAGE_8K2R"), "SENTINEL_SECRET_7M4Q"])(
    "does not expose a provider rejection in the TRANSCRIBE_FAILED envelope",
    async (providerFailure) => {
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
    },
  );

  it("reports a file that grew past the limit during the read as FILE_TOO_LARGE, not a provider failure", async () => {
    const filePath = seedAudioFile();
    transcribeFailure = new MockTranscribeFileError("FILE_TOO_LARGE", "too large", { sizeBytes: 9, maxBytes: 8 });
    try {
      const error = await expectContractError(
        () => new TranscribeCommands().file(filePath, "pt", true),
        "FILE_TOO_LARGE",
        2,
      );
      expect(error.details.sizeBytes).toBe(9);
      expect(error.details.retryable).toBeUndefined();
    } finally {
      rmSync(audioDir, { recursive: true, force: true });
    }
  });

  it("passes the local CLI ceiling to the service and transcribes the resolved real path", async () => {
    const filePath = seedAudioFile();
    try {
      await captureConsole(() => new TranscribeCommands().file(filePath, "pt", true));
      expect(transcribeCalls).toHaveLength(1);
      expect(transcribeCalls[0]?.maxBytes).toBe(200 * 1024 * 1024);
    } finally {
      rmSync(audioDir, { recursive: true, force: true });
    }
  });

  it("resolves relative paths against the caller cwd instead of the daemon cwd", async () => {
    seedAudioFile("rel.mp3");
    callerCwd = audioDir;
    try {
      await captureConsole(() => new TranscribeCommands().file("rel.mp3", "pt", true));
      expect(transcribeCalls).toHaveLength(1);
      expect(String(transcribeCalls[0]?.filePath)).toEndWith("/rel.mp3");
    } finally {
      rmSync(audioDir, { recursive: true, force: true });
    }
  });

  it("caps agent/gateway callers at the inbound audio limit before reading the file", async () => {
    const filePath = seedAudioFile("grande.mp3");
    truncateSync(filePath, 20 * 1024 * 1024 + 1);
    runtimeInvocation = true;
    try {
      const error = await expectContractError(
        () => new TranscribeCommands().file(filePath, "pt", true),
        "FILE_TOO_LARGE",
        2,
      );
      expect(error.details).toMatchObject({ maxBytes: 20 * 1024 * 1024, sizeBytes: 20 * 1024 * 1024 + 1 });
      expect(transcribeCalls).toHaveLength(0);
    } finally {
      rmSync(audioDir, { recursive: true, force: true });
    }
  });

  it("rejects a directory named like audio with INVALID_FILE", async () => {
    audioDir = mkdtempSync(join(tmpdir(), "ravi-transcribe-test-"));
    const dirPath = join(audioDir, "pasta.mp3");
    mkdirSync(dirPath);
    try {
      await expectContractError(() => new TranscribeCommands().file(dirPath, "pt", true), "INVALID_FILE", 2);
      expect(transcribeCalls).toHaveLength(0);
    } finally {
      rmSync(audioDir, { recursive: true, force: true });
    }
  });

  it("rejects an audio-named symlink that points at a non-audio host file", async () => {
    audioDir = mkdtempSync(join(tmpdir(), "ravi-transcribe-test-"));
    const target = join(audioDir, "segredo.env");
    writeFileSync(target, "OPENAI_API_KEY=SENTINEL_KEY_4Q2W");
    const link = join(audioDir, "voz.mp3");
    symlinkSync(target, link);
    try {
      const error = await expectContractError(() => new TranscribeCommands().file(link, "pt", true), "INVALID_FILE", 2);
      expect(JSON.stringify(error.envelope())).not.toContain("SENTINEL_KEY_4Q2W");
      expect(transcribeCalls).toHaveLength(0);
    } finally {
      rmSync(audioDir, { recursive: true, force: true });
    }
  });
  it("sends the MIME type of the resolved file, not of the link name", async () => {
    audioDir = mkdtempSync(join(tmpdir(), "ravi-transcribe-test-"));
    const target = join(audioDir, "gravacao.wav");
    writeFileSync(target, "RIFF");
    const link = join(audioDir, "voz.mp3");
    symlinkSync(target, link);
    try {
      await captureConsole(() => new TranscribeCommands().file(link, "pt", true));
      expect(transcribeCalls).toHaveLength(1);
      expect(transcribeCalls[0]).toMatchObject({ mimeType: "audio/wav" });
    } finally {
      rmSync(audioDir, { recursive: true, force: true });
    }
  });
});
