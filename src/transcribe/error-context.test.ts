import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const originalGroqKey = process.env.GROQ_API_KEY;
const originalOpenaiKey = process.env.OPENAI_API_KEY;
let providerFailure: unknown;
let chunkFailure: unknown;
let duration = 10;
let requestCalls = 0;
const ActualAPIError = (await import("openai")).APIError;

mock.module("openai", () => ({
  default: class {
    audio = {
      transcriptions: {
        create: async () => {
          requestCalls++;
          if (providerFailure !== undefined) throw providerFailure;
          return { text: "transcript", duration: 10 };
        },
      },
    };
  },
}));
mock.module("./chunker.js", () => ({
  getAudioDuration: async () => duration,
  splitAudioChunks: async () => {
    if (chunkFailure !== undefined) throw chunkFailure;
    return [{ buffer: Buffer.from("fixture"), startSec: 0, duration: 1 }];
  },
}));

const { transcribeAudio } = await import("./openai.js");
const { errorDiagnostic } = await import("../utils/error-diagnostic.js");

beforeEach(() => {
  delete process.env.GROQ_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-openai-key";
  providerFailure = undefined;
  chunkFailure = undefined;
  requestCalls = 0;
  duration = 10;
});

afterEach(() => {
  if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalGroqKey;
  if (originalOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenaiKey;
});

afterAll(() => mock.restore());

describe("transcription provider error context", () => {
  it("does_not_relay_api_error_body_or_pii", async () => {
    providerFailure = new ActualAPIError(
      400,
      {
        code: "invalid_audio",
        debug: { transcript: "PERSONAL_AUDIO_FIXTURE", headers: { "x-custom-auth": "OPAQUE_HEADER_FIXTURE" } },
      },
      undefined,
      new Headers(),
    );
    let caught: unknown;
    try {
      await transcribeAudio(Buffer.from("fixture"), "audio/mpeg");
    } catch (error) {
      caught = error;
    }
    const diagnostic = errorDiagnostic(caught);
    expect(diagnostic.cause).toBe("HTTP 400: invalid_audio: [redacted:provider.body]");
    expect(diagnostic.context).toMatchObject({
      provider: "openai",
      model: "whisper-1",
      status: 400,
      code: "invalid_audio",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("PERSONAL_AUDIO_FIXTURE");
    expect(JSON.stringify(diagnostic)).not.toContain("OPAQUE_HEADER_FIXTURE");
  });

  it("redacts a known provider credential echoed without a field label", async () => {
    providerFailure = new Error("Provider rejected synthetic-openai-key");
    let caught: unknown;
    try {
      await transcribeAudio(Buffer.from("fixture"), "audio/mpeg");
    } catch (error) {
      caught = error;
    }
    expect(errorDiagnostic(caught).cause).toBe("Provider rejected [redacted:credential]");
  });

  it.each([
    { provider: "openai", model: "whisper-1", status: 429 },
    { provider: "groq", model: "whisper-large-v3-turbo", status: 503 },
  ])("retains $provider identity and original failure through its request boundary", async (fixture) => {
    if (fixture.provider === "groq") process.env.GROQ_API_KEY = "synthetic-groq-key";
    providerFailure = Object.assign(new Error("audio quota exceeded; api_key=synthetic-credential"), {
      status: fixture.status,
      code: "audio_quota_exceeded",
      response: { raw: "must not be copied" },
    });
    let caught: unknown;
    try {
      await transcribeAudio(Buffer.from("fixture"), "audio/mpeg");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBe(providerFailure);
    const diagnostic = errorDiagnostic(caught, { operation: "transcribe file", file: "/tmp/fixture.mp3" });
    expect(diagnostic.cause).toContain("audio quota exceeded");
    expect(diagnostic.cause).toContain("api_key=[redacted:api_key]");
    expect(diagnostic.context).toMatchObject({
      operation: "transcribe file",
      file: "/tmp/fixture.mp3",
      provider: fixture.provider,
      model: fixture.model,
      status: fixture.status,
      code: "audio_quota_exceeded",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("synthetic-credential");
    expect(JSON.stringify(diagnostic)).not.toContain("must not be copied");
    expect(requestCalls).toBe(1);
  });

  it("keeps too-short chunk handling after adding provider context", async () => {
    duration = 700;
    providerFailure = new Error("Audio file is too short; minimum audio length is 0.1 seconds");
    const result = await transcribeAudio(Buffer.from("fixture"), "audio/mpeg");
    expect(result).toMatchObject({ text: "", chunks: 1, provider: "openai" });
    expect(requestCalls).toBe(1);
  });

  it("identifies ffmpeg failures before making a provider request", async () => {
    duration = 700;
    chunkFailure = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT", syscall: "spawn ffmpeg" });
    let caught: unknown;
    try {
      await transcribeAudio(Buffer.from("fixture"), "audio/mpeg");
    } catch (error) {
      caught = error;
    }
    expect(errorDiagnostic(caught)).toMatchObject({
      cause: "spawn ffmpeg ENOENT",
      context: { operation: "audio.split", provider: "ffmpeg", code: "ENOENT", syscall: "spawn ffmpeg" },
    });
    expect(requestCalls).toBe(0);
  });
});
