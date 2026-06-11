import { afterAll, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "ravi-tts-test-"));
let generatedCount = 0;
const generatedFiles: string[] = [];

mock.module("./generator.js", () => ({
  generateAudio: mock(async (text: string, opts: Record<string, unknown> = {}) => {
    const filePath = join(tmpRoot, `audio-${generatedCount++}.mp3`);
    writeFileSync(filePath, Buffer.from(`audio:${text}`));
    generatedFiles.push(filePath);
    return {
      filePath,
      mimeType: "audio/mpeg",
      text,
      sizeBytes: 8,
      provider: "elevenlabs",
      voiceId: typeof opts.voiceId === "string" ? opts.voiceId : "voice-test",
      modelId: typeof opts.modelId === "string" ? opts.modelId : "model-test",
      outputFormat: typeof opts.outputFormat === "string" ? opts.outputFormat : "mp3_44100_128",
    };
  }),
}));

const { handleRaviTtsRequest, readTtsPlaybackAudio } = await import("./tts.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("TTS playback store", () => {
  it("returns null for missing audio files and deletes evicted temp files", async () => {
    const emit = mock(async () => {});
    await handleRaviTtsRequest({ id: "missing-file", text: "missing file" }, emit);
    const missingPath = generatedFiles.at(-1);
    expect(missingPath).toBeTruthy();
    unlinkSync(missingPath!);

    expect(readTtsPlaybackAudio("missing-file")).toBeNull();

    for (let index = 0; index < 81; index++) {
      await handleRaviTtsRequest({ id: `evict-${index}`, text: `evict ${index}` }, emit);
    }

    const firstEvictPath = generatedFiles.find((filePath) => filePath.endsWith("audio-1.mp3"));
    expect(firstEvictPath).toBeTruthy();
    expect(existsSync(firstEvictPath!)).toBe(false);
    expect(readTtsPlaybackAudio("evict-80")?.bytes.length).toBeGreaterThan(0);
  });
});
