import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TRANSCRIBE_FILE_BYTES,
  SUPPORTED_AUDIO_EXTENSIONS,
  TranscribeFileError,
  inferAudioMimeType,
  transcribeFile,
} from "./service.js";

function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ravi-transcribe-svc-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("transcribe service", () => {
  test("infers supported audio MIME types from file extensions", () => {
    expect(inferAudioMimeType("/tmp/audio.webm")).toBe("audio/webm");
    expect(inferAudioMimeType("/tmp/audio.opus")).toBe("audio/ogg; codecs=opus");
    expect(inferAudioMimeType("/tmp/audio.mp3")).toBe("audio/mpeg");
    expect(inferAudioMimeType("/tmp/audio.txt")).toBeUndefined();
    expect(SUPPORTED_AUDIO_EXTENSIONS).toContain(".webm");
  });

  test("rejects files above maxBytes before reading or calling the provider", () =>
    withTempDir(async (dir) => {
      const filePath = join(dir, "voz.mp3");
      writeFileSync(filePath, "0123456789");
      const error = await transcribeFile({ filePath, maxBytes: 4 }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(TranscribeFileError);
      expect((error as TranscribeFileError).code).toBe("FILE_TOO_LARGE");
      expect((error as TranscribeFileError).details).toEqual({ sizeBytes: 10, maxBytes: 4 });
    }));

  test("clamps a caller maxBytes above the service ceiling", () =>
    withTempDir(async (dir) => {
      const filePath = join(dir, "longo.mp3");
      writeFileSync(filePath, "");
      // Sparse file: no real disk usage, but stat reports the full size.
      truncateSync(filePath, MAX_TRANSCRIBE_FILE_BYTES + 1);
      const error = await transcribeFile({ filePath, maxBytes: Number.MAX_SAFE_INTEGER }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(TranscribeFileError);
      expect((error as TranscribeFileError).details.maxBytes).toBe(MAX_TRANSCRIBE_FILE_BYTES);
    }));

  // /proc files report size 0 but have content: the same shape as a file that grew after the stat.
  test.if(existsSync("/proc/self/status"))("keeps reading past the stat size and still enforces maxBytes", async () => {
    const error = await transcribeFile({ filePath: "/proc/self/status", mimeType: "audio/mpeg", maxBytes: 16 }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(TranscribeFileError);
    expect((error as TranscribeFileError).code).toBe("FILE_TOO_LARGE");
    expect((error as TranscribeFileError).details).toEqual({ sizeBytes: 17, maxBytes: 16 });
  });

  test("rejects non-regular paths", () =>
    withTempDir(async (dir) => {
      const dirPath = join(dir, "pasta.mp3");
      mkdirSync(dirPath);
      const error = await transcribeFile({ filePath: dirPath }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(TranscribeFileError);
      expect((error as TranscribeFileError).code).toBe("NOT_A_REGULAR_FILE");
    }));
  test("rejects a FIFO without blocking on open", () =>
    withTempDir(async (dir) => {
      const fifoPath = join(dir, "fila.mp3");
      execFileSync("mkfifo", [fifoPath]);
      const error = await transcribeFile({ filePath: fifoPath }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(TranscribeFileError);
      expect((error as TranscribeFileError).code).toBe("NOT_A_REGULAR_FILE");
    }));
});
