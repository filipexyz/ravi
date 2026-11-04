import { describe, expect, it } from "bun:test";
import {
  diagnosticError,
  errorDiagnostic,
  projectDiagnosticContext,
  projectFailureDiagnostic,
  redactDiagnosticText,
} from "./error-diagnostic.js";

describe("error diagnostics", () => {
  it.each(["path", "context", "status", "message", "cause", "error"])(
    "continues collecting diagnostics when %s getter throws",
    (field) => {
      const error = Object.assign(new Error("Cannot read audio"), {
        code: "EACCES",
        syscall: "open",
        cause: new Error("permission denied"),
      });
      Object.defineProperty(error, field, {
        get() {
          throw new Error("GETTER_PRIVATE_SECRET");
        },
      });
      const result = errorDiagnostic(error, { operation: "transcribe file" });
      expect(result.context).toMatchObject({ code: "EACCES", syscall: "open", operation: "transcribe file" });
      expect(result.cause).toContain(field === "message" ? "permission denied" : "Cannot read audio");
      expect(JSON.stringify(projectFailureDiagnostic(error))).not.toContain("GETTER_PRIVATE_SECRET");
    },
  );

  it.each(["provider", "model", "operation", "actor", "file", "syscall", "code", "status"])(
    "ignores a throwing context %s getter without losing readable fields",
    (field) => {
      const context = { provider: "fixture", model: "audio-1", status: 401 };
      Object.defineProperty(context, field, {
        get() {
          throw new Error("GETTER_PRIVATE_SECRET");
        },
      });
      const projected = projectDiagnosticContext(context);
      expect(projected[field as keyof typeof projected]).toBeUndefined();
      expect(projected[field === "model" ? "provider" : "model"]).toBe(field === "model" ? "fixture" : "audio-1");
    },
  );

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
    ["HTTP 429 quota exhausted; token=fixture-token", "HTTP 429 quota exhausted; token=[redacted:token]"],
    ['HTTP 401: {"api_key":"fixture-key","message":"invalid key"}', "HTTP 401: invalid key: [redacted:provider.body]"],
    ["request failed Authorization: Bearer fixture-token", "request failed Authorization: [redacted:authorization]"],
    [
      "HTTP 503 at https://user:password@example.test/audio?token=fixture-token",
      "HTTP 503 at https://[redacted:userinfo]@example.test/audio?[redacted:url-query]",
    ],
    ["connection rejected rctx_fixture-secret", "connection rejected [redacted:credential]"],
    ["HTTP 401 sk-abcdefghijklmnop", "HTTP 401 [redacted:credential]"],
    ["Groq rejected gsk_abcdefghijklmnop", "Groq rejected [redacted:credential]"],
    ["read PRIVATE_MESSAGE_8K2R at /tmp/audio.wav", "read PRIVATE_MESSAGE_8K2R at /tmp/audio.wav"],
  ])("redacts values while retaining cause: %s", (source, expected) => {
    expect(redactDiagnosticText(source)).toBe(expected);
    expect(redactDiagnosticText(expected)).toBe(expected);
  });

  it("redacts a known credential inside allowed context fields at egress", () => {
    const error = diagnosticError(
      new Error("provider denied"),
      {
        file: "/tmp/fixture-opaque-value/audio.wav",
        actor: { type: "agent", id: "fixture-opaque-value" },
      },
      { secrets: ["fixture-opaque-value"] },
    );
    expect(error.cause).toBeInstanceOf(Error);
    const result = errorDiagnostic(error);
    expect(result.cause).toBe("provider denied");
    expect(result.context.file).toBe("/tmp/[redacted:credential]/audio.wav");
    expect(result.context.actor).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("fixture-opaque-value");
  });

  it("bounds oversized and recursively nested diagnostics before parsing payloads", () => {
    const payload = "provider failed\npassword=" + "x".repeat(1000000);
    expect(redactDiagnosticText(payload)).toBe("provider failed\n[redacted:oversize]");
    let error: Error = new Error("innermost");
    for (let index = 0; index < 100; index++) error = new Error("provider failed", { cause: error });
    expect(errorDiagnostic(error).cause).toContain("[cause chain truncated]");
    expect(errorDiagnostic(error).cause.length).toBeLessThan(4096);
  });

  it("bounds the complete public cause and file including the truncation marker", () => {
    const text = ["provider returned 401; token=BOUNDARY_SECRET", ...Array(5).fill("a".repeat(1000))].join("\n");
    const result = errorDiagnostic(new Error(text), { file: text, operation: "transcribe file" });
    expect(result.cause).toStartWith("provider returned 401; token=[redacted:token]");
    expect(result.cause).toEndWith(" [truncated]");
    expect(result.cause.length).toBeLessThanOrEqual(4096);
    expect(result.context.file?.length).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(result)).not.toContain("BOUNDARY_SECRET");
    expect(redactDiagnosticText(result.cause)).toBe(result.cause);
    const homePaths = Array(4).fill("/home/u/".repeat(120)).join("\n");
    const file = projectDiagnosticContext({ file: homePaths }).file!;
    expect(file.length).toBeLessThanOrEqual(4096);
    expect(file).not.toContain("/home/u/");
  });

  it("preserves long filesystem paths assembled from non-secret components", () => {
    const path = "/var/folders/34/z527s1r52n74f5349z9x9rzh0000gn/T/ravi-transcribe-test-w84dsg/voz.mp3";
    expect(errorDiagnostic(new Error(`EACCES: permission denied, open ${path}`), { file: path })).toEqual({
      cause: `EACCES: permission denied, open ${path}`,
      context: { file: path },
    });
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
