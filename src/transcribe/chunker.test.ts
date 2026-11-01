import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import { splitAudioChunks } from "./chunker.js";

const execFileAsync = promisify(execFile);

async function hasCommand(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

describe("audio chunker", () => {
  test("re-encodes long ogg input chunks as provider-safe mp3", async () => {
    if (!(await hasCommand("ffmpeg")) || !(await hasCommand("ffprobe"))) {
      return;
    }

    const fixturePath = join(tmpdir(), `ravi-chunker-test-${Date.now()}.ogg`);
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=1.2",
        "-c:a",
        "libopus",
        "-b:a",
        "24k",
        "-v",
        "quiet",
        fixturePath,
      ]);

      const input = await readFile(fixturePath);
      const chunks = await splitAudioChunks(input, "ogg", { chunkDuration: 0.5, overlap: 0.1 });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].startSec).toBe(0);
      expect(chunks[1].startSec).toBeCloseTo(0.4, 3);
      for (const chunk of chunks) {
        expect(chunk.mimetype).toBe("audio/mpeg");
        expect(chunk.duration).toBeGreaterThanOrEqual(0.1);
        expect(chunk.buffer.length).toBeGreaterThan(0);
      }
    } finally {
      await unlink(fixturePath).catch(() => {});
    }
  });
});

describe("audio chunker with a forged container duration", () => {
  test("stops at the real end of the audio instead of looping over the declared duration", async () => {
    if (!(await hasCommand("ffmpeg")) || !(await hasCommand("ffprobe"))) {
      return;
    }

    const fixturePath = join(tmpdir(), `ravi-chunker-forged-${Date.now()}.ogg`);
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1.2",
        "-c:a",
        "libopus",
        "-v",
        "quiet",
        fixturePath,
      ]);

      const input = await readFile(fixturePath);
      const chunks = await splitAudioChunks(input, "ogg", { chunkDuration: 0.5, overlap: 0.1, durationHintSec: 1e9 });

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.length).toBeLessThanOrEqual(4);
    } finally {
      await unlink(fixturePath).catch(() => {});
    }
  }, 30_000);

  test("caps the chunk count", async () => {
    if (!(await hasCommand("ffmpeg")) || !(await hasCommand("ffprobe"))) {
      return;
    }

    const fixturePath = join(tmpdir(), `ravi-chunker-cap-${Date.now()}.ogg`);
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=3",
        "-c:a",
        "libopus",
        "-v",
        "quiet",
        fixturePath,
      ]);

      const input = await readFile(fixturePath);
      const chunks = await splitAudioChunks(input, "ogg", { chunkDuration: 0.5, overlap: 0.1, maxChunks: 2 });
      expect(chunks.length).toBe(2);
    } finally {
      await unlink(fixturePath).catch(() => {});
    }
  }, 30_000);
});
