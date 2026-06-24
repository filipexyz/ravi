import { describe, expect, test } from "bun:test";
import { SUPPORTED_AUDIO_EXTENSIONS, inferAudioMimeType } from "./service.js";

describe("transcribe service", () => {
  test("infers supported audio MIME types from file extensions", () => {
    expect(inferAudioMimeType("/tmp/audio.webm")).toBe("audio/webm");
    expect(inferAudioMimeType("/tmp/audio.opus")).toBe("audio/ogg; codecs=opus");
    expect(inferAudioMimeType("/tmp/audio.mp3")).toBe("audio/mpeg");
    expect(inferAudioMimeType("/tmp/audio.txt")).toBeUndefined();
    expect(SUPPORTED_AUDIO_EXTENSIONS).toContain(".webm");
  });
});
