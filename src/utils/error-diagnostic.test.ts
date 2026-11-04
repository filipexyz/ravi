import { describe, expect, it } from "bun:test";
import { errorDiagnostic, redactDiagnosticText } from "./error-diagnostic.js";

describe("error diagnostics", () => {
  it("retains OS cause chains and actionable metadata without dumping arbitrary payloads", () => {
    const inner = Object.assign(new Error("EACCES: permission denied, open /tmp/report.wav"), {
      code: "EACCES",
      syscall: "open",
      path: "/tmp/report.wav",
      body: "DO_NOT_COPY",
    });
    const error = Object.assign(new Error("Audio transcription failed", { cause: inner }), {
      context: { provider: "openai", status: 403 },
    });
    const result = errorDiagnostic(error, { operation: "transcribe file" });
    expect(result.cause).toBe("Audio transcription failed\nCaused by: EACCES: permission denied, open /tmp/report.wav");
    expect(result.context).toEqual({
      operation: "transcribe file",
      provider: "openai",
      status: 403,
      code: "EACCES",
      syscall: "open",
      file: "/tmp/report.wav",
    });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_COPY");
  });

  it.each([
    ["HTTP 429 quota exhausted; token=fixture-token", "HTTP 429 quota exhausted; token=[redacted]"],
    [
      'HTTP 401: {"api_key":"fixture-key","message":"invalid key"}',
      'HTTP 401: {"api_key":[redacted],"message":"invalid key"}',
    ],
    ["request failed Authorization: Bearer fixture-token", "request failed Authorization: [redacted]"],
    [
      "HTTP 503 at https://user:password@example.test/audio?token=fixture-token",
      "HTTP 503 at https://[redacted]@example.test/audio?token=[redacted]",
    ],
    ["connection rejected rctx_fixture-secret", "connection rejected [redacted]"],
    ["HTTP 401 sk-abcdefghijklmnop", "HTTP 401 [redacted]"],
    ["Groq rejected gsk_abcdefghijklmnop", "Groq rejected [redacted]"],
    ["read PRIVATE_MESSAGE_8K2R at /tmp/audio.wav", "read PRIVATE_MESSAGE_8K2R at /tmp/audio.wav"],
  ])("redacts values while retaining cause: %s", (source, expected) => {
    expect(redactDiagnosticText(source)).toBe(expected);
    expect(redactDiagnosticText(expected)).toBe(expected);
  });

  it("handles record/string/cyclic errors without JSON dumping", () => {
    expect(errorDiagnostic({ error: { message: "provider unavailable", status: 503 } }).cause).toBe(
      "provider unavailable",
    );
    const circular = new Error("cycle") as Error & { cause: unknown };
    circular.cause = circular;
    expect(errorDiagnostic(circular).cause).toContain("[circular cause]");
    expect(errorDiagnostic("ffmpeg exited 127: executable not found").cause).toBe(
      "ffmpeg exited 127: executable not found",
    );
  });
});
