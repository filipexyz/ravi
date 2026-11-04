import { errorDiagnostic } from "../utils/error-diagnostic.js";
import { describe, expect, it } from "bun:test";
import {
  ContractError,
  GENERIC_COMMAND_FAILED_MESSAGE,
  expectedErrorToContractError,
  mapExecutionErrorToContractError,
  publicContractMessage,
  sanitizePublicContractMessage,
} from "./agent-contract.js";
import { CliExpectedError } from "./expected-error.js";

describe("ContractError mandatory diagnostic", () => {
  it("rejects a literal message without diagnostic at compile time and runtime", () => {
    expect(() => {
      // @ts-expect-error A user-facing failure must supply cause and context.
      return new ContractError("media send", "MEDIA_SEND_FAILED", "Media delivery failed.", 1);
    }).toThrow("A user failure requires an explicit cause and diagnostic context.");
  });

  it("requires both cause and context at compile time and runtime", () => {
    expect(() => {
      // @ts-expect-error A cause without diagnostic context is incomplete.
      return new ContractError("media send", "MEDIA_SEND_FAILED", "Media delivery failed.", 1, {
        cause: "provider refused media",
      });
    }).toThrow("A user failure requires an explicit cause and diagnostic context.");
    expect(() => {
      // @ts-expect-error Diagnostic context cannot replace the original cause.
      return new ContractError("media send", "MEDIA_SEND_FAILED", "Media delivery failed.", 1, {
        context: { operation: "media send" },
      });
    }).toThrow("A user failure requires an explicit cause and diagnostic context.");
  });

  it("retains the exact cause and typed context supplied to the constructor", () => {
    const original = Object.assign(
      new Error("Cannot read audio", {
        cause: new Error("EACCES: permission denied, open /tmp/audio.wav"),
      }),
      { code: "EACCES", syscall: "open", path: "/tmp/audio.wav", status: 403 },
    );
    const diagnostic = errorDiagnostic(original, { operation: "transcribe file", provider: "fixture" });
    const failure = new ContractError(
      "transcribe file",
      "TRANSCRIPTION_FAILED",
      "Audio transcription failed.",
      1,
      diagnostic,
    );
    expect(failure.envelope().error).toEqual({
      code: "TRANSCRIPTION_FAILED",
      message: "Audio transcription failed.",
      retryable: false,
      cause: "Cannot read audio\nCaused by: EACCES: permission denied, open /tmp/audio.wav",
      context: {
        operation: "transcribe file",
        provider: "fixture",
        code: "EACCES",
        syscall: "open",
        file: "/tmp/audio.wav",
        status: 403,
      },
    });
    expect(failure.details.cause).toBe(diagnostic.cause);
    expect(failure.details.context).toEqual(diagnostic.context);
  });
});

describe("publicContractMessage", () => {
  it("preserves a sanitized COMMAND_FAILED cause instead of replacing it", () => {
    const cause = "CLI/runtime mismatch detected. Pass --allow-runtime-mismatch if you really mean it.";
    expect(publicContractMessage("COMMAND_FAILED", cause)).toBe(cause);
    expect(
      new ContractError("instances routes add", "COMMAND_FAILED", cause, 1, {
        ...errorDiagnostic(cause, { operation: "instances routes add" }),
        ...{},
      }).envelope().error.message,
    ).toBe(cause);
  });

  it("uses the generic headline only when the cause is empty", () => {
    expect(publicContractMessage("COMMAND_FAILED", "")).toBe(GENERIC_COMMAND_FAILED_MESSAGE);
    expect(publicContractMessage("COMMAND_FAILED", "   \n")).toBe(GENERIC_COMMAND_FAILED_MESSAGE);
    expect(sanitizePublicContractMessage("")).toBeUndefined();
    expect(sanitizePublicContractMessage("   ")).toBeUndefined();
  });

  it("redacts only credential values and preserves non-secret diagnostics", () => {
    expect(publicContractMessage("COMMAND_FAILED", "HTTP 429: quota exhausted; api_key=opaque")).toBe(
      "HTTP 429: quota exhausted; api_key=[redacted:api_key]",
    );
    expect(publicContractMessage("COMMAND_FAILED", "leak sk-ant-abcdefghijklmnopqrstuv")).toBe(
      "leak [redacted:credential]",
    );
    expect(publicContractMessage("COMMAND_FAILED", "Cannot read file /tmp/config.json")).toBe(
      "Cannot read file /tmp/config.json",
    );
    expect(sanitizePublicContractMessage("PRIVATE_EXPECTED_MESSAGE_7M4Q")).toBe("PRIVATE_EXPECTED_MESSAGE_7M4Q");
  });

  it("does not rewrite non-COMMAND_FAILED codes", () => {
    expect(publicContractMessage("USAGE_ERROR", "Provide text or --text-file.")).toBe("Provide text or --text-file.");
    expect(publicContractMessage("SESSION_NOT_FOUND", "Session not found: main")).toBe("Session not found: main");
  });
});

describe("expectedErrorToContractError", () => {
  it("preserves the default COMMAND_FAILED code and the expected message", () => {
    const error = new CliExpectedError("--text-file must not contain '..' path segments.");
    expect(error.code).toBe("COMMAND_FAILED");

    const contract = expectedErrorToContractError("audio generate", error);
    expect(contract).toMatchObject({
      op: "audio generate",
      code: "COMMAND_FAILED",
      message: "--text-file must not contain '..' path segments.",
      exitCode: 1,
    });
    expect(contract?.envelope().error).toMatchObject({
      code: "COMMAND_FAILED",
      message: "--text-file must not contain '..' path segments.",
      suggestedAction: "Inspect the command input and retry 'audio generate'",
    });
  });

  it("preserves an explicit code without renaming it to COMMAND_FAILED", () => {
    const contract = expectedErrorToContractError(
      "cloud fixture custom",
      new CliExpectedError("Watch provider request failed.", "WATCH_PROVIDER_FAILED", 1),
    );
    expect(contract).toMatchObject({
      code: "WATCH_PROVIDER_FAILED",
      message: "Watch provider request failed.",
      exitCode: 1,
    });
    expect(contract?.envelope().error.message).toBe("Watch provider request failed.");
  });

  it("preserves a throw-site suggestedAction such as --allow-runtime-mismatch", () => {
    const suggestedAction = "Re-run with the repo CLI/runtime or pass --allow-runtime-mismatch if you really mean it.";
    const contract = expectedErrorToContractError(
      "instances routes add",
      new CliExpectedError(
        `CLI/runtime mismatch detected.\nTarget instance: main\n${suggestedAction}`,
        "COMMAND_FAILED",
        1,
        suggestedAction,
      ),
    );

    expect(contract?.code).toBe("COMMAND_FAILED");
    expect(contract?.envelope().error.message).toContain("CLI/runtime mismatch detected.");
    expect(contract?.envelope().error.message).toContain("--allow-runtime-mismatch");
    expect(contract?.envelope().error.suggestedAction).toBe(suggestedAction);
  });

  it("uses generic copy only when empty and retains sanitized guidance", () => {
    const empty = expectedErrorToContractError("sessions runtime list", new CliExpectedError(""));
    const unsafe = expectedErrorToContractError(
      "sessions runtime list",
      new CliExpectedError(
        "HTTP 401: invalid API key; api_key=opaque",
        "COMMAND_FAILED",
        1,
        "Replace the api_key=opaque",
      ),
    );

    expect(empty?.envelope().error).toMatchObject({
      code: "COMMAND_FAILED",
      message: GENERIC_COMMAND_FAILED_MESSAGE,
      suggestedAction: "Inspect the command input and retry 'sessions runtime list'",
    });
    expect(unsafe?.envelope().error).toMatchObject({
      code: "COMMAND_FAILED",
      message: "HTTP 401: invalid API key; api_key=[redacted:api_key]",
      suggestedAction: "Replace the api_key=[redacted:api_key]",
    });
    expect(JSON.stringify(unsafe?.envelope())).not.toContain("opaque");
  });
});

describe("CliExpectedError default code", () => {
  it("defaults to COMMAND_FAILED and still surfaces a safe fail() message", () => {
    const error = new CliExpectedError("Agent not found: ghost. Pass --create-agent to create it.");
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.suggestedAction).toBeUndefined();

    const contract = mapExecutionErrorToContractError("whatsapp group create", error);
    expect(contract.code).toBe("COMMAND_FAILED");
    expect(contract.envelope().error.message).toBe("Agent not found: ghost. Pass --create-agent to create it.");
  });
});

describe("public expected-error credentials", () => {
  it.each(["password=opaque", "access_token=opaque", "apiKey=opaque", "rctx_fixture_secret"])(
    "does not relay a secret embedded in public error copy: %s",
    (secret) => {
      const result = sanitizePublicContractMessage(`Lookup failed: ${secret}`);
      expect(result).toContain("Lookup failed:");
      expect(result).toContain("[redacted:");
      expect(result).not.toContain(secret);
    },
  );
});

describe("diagnostic identifier egress", () => {
  it("preserves typed resolution controls while excluding provider row contents and arbitrary nested fields", () => {
    const error = new ContractError("bases rows update", "VERSION_CONFLICT", "Row changed.", 1, {
      ...errorDiagnostic(new Error("Row changed.")),
      consoleError: "version_conflict",
      current: { rowId: "row_1", version: 4, values: { email: "PRIVATE_ROW_VALUE" }, body: "PRIVATE_ROW_BODY" },
      schemaVersion: 2,
      inputsHash: "fedcba9876543210",
      retryAfterMs: 1000,
      missingScopes: ["console.bases.read", "scope?token=PRIVATE_SCOPE"],
      organization: { name: "Acme", body: "PRIVATE_ORG_BODY" },
      currentChat: "chat_1",
      importProgress: { failedBatch: 0, batches: 2, rowsCreated: 0, firstFailedLine: null, body: "PRIVATE_IMPORT" },
    });
    expect(error.envelope().error).toMatchObject({
      consoleError: "version_conflict",
      current: { rowId: "row_1", version: 4 },
      schemaVersion: 2,
      inputsHash: "fedcba9876543210",
      retryAfterMs: 1000,
      missingScopes: ["console.bases.read"],
      organization: { name: "Acme" },
      currentChat: "chat_1",
      importProgress: { failedBatch: 0, batches: 2, rowsCreated: 0, firstFailedLine: null },
    });
    expect(JSON.stringify(error.envelope())).not.toContain("PRIVATE_");
  });

  it("rejects invalid control types and redacts permitted text", () => {
    const error = new ContractError("demo", "CONFLICT", "Conflict.", 1, {
      ...errorDiagnostic(new Error("Conflict.")),
      consoleError: "code?key=PRIVATE_CODE",
      current: { rowId: "row_1", version: -1 },
      schemaVersion: NaN,
      retryAfterMs: Infinity,
      inputsHash: "PRIVATE_HASH",
      currentChat: "chat?token=PRIVATE_CHAT",
      missingScopes: [12, { scope: "PRIVATE_SCOPE" }],
      organization: { name: "Acme https://example.test?key=PRIVATE_ORG" },
      diff: "+ theirs https://example.test?key=PRIVATE_DIFF",
    });
    const envelope = error.envelope().error;
    for (const key of [
      "consoleError",
      "current",
      "schemaVersion",
      "retryAfterMs",
      "inputsHash",
      "currentChat",
      "missingScopes",
    ])
      expect(envelope).not.toHaveProperty(key);
    expect(envelope.organization).toEqual({ name: "Acme https://example.test?[redacted:url-query]" });
    expect(envelope.diff).toContain("+ theirs");
    expect(JSON.stringify(envelope)).not.toContain("PRIVATE_");
  });

  it("rejects credential-bearing code and operation fields without discarding the cause", () => {
    const error = new ContractError(
      "upload?key=PRIVATE_OP",
      "FAIL_token=PRIVATE_CODE",
      "provider unavailable",
      1,
      errorDiagnostic(new Error("provider unavailable")),
    );
    expect(error.op).toBe("command");
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.envelope().error.cause).toBe("provider unavailable");
    expect(JSON.stringify(error.envelope())).not.toMatch(/PRIVATE_OP|PRIVATE_CODE/);
  });
});
