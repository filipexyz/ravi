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

describe("audited operational error controls", () => {
  const envelope = (details: Record<string, unknown>) =>
    new ContractError("demo", "COMMAND_FAILED", "Operation failed.", 1, {
      ...errorDiagnostic(new Error("Operation failed.")),
      ...details,
    }).envelope().error;

  it("retains typed recovery and publication metadata without forwarding nested payloads", () => {
    const result = envelope({
      runId: "run_123",
      proposalStatus: "proposed",
      routine: "cron",
      expectedSha: "a".repeat(40),
      actualSha: "b".repeat(40),
      objectType: "tree",
      reason: "admin_context_exists",
      liveBytes: 256,
      storedBytes: 0,
      allowedKeys: ["OPENAI_API_KEY", "RAVI_LOG_LEVEL"],
      path: "/PRIVATE_OPENAPI_PATH/openapi.json",
      dir: "/PRIVATE_SDK_DIR",
      candidates: [
        {
          installationId: "install_1",
          name: "Desk",
          online: true,
          reportedAt: "2026-11-04T14:00:00Z",
          body: "PRIVATE_BODY",
        },
        { installationId: "install_2", name: null, online: false, reportedAt: null },
      ],
      arbitrary: "PRIVATE_ARBITRARY",
    });
    expect(result).toMatchObject({
      runId: "run_123",
      proposalStatus: "proposed",
      routine: "cron",
      reason: "admin_context_exists",
      expectedSha: "a".repeat(40),
      actualSha: "b".repeat(40),
      objectType: "tree",
      liveBytes: 256,
      storedBytes: 0,
      allowedKeys: ["OPENAI_API_KEY", "RAVI_LOG_LEVEL"],
      path: "[REDACTED:path]",
      dir: "[REDACTED:path]",
      candidates: [
        { installationId: "install_1", name: "Desk", online: true, reportedAt: "2026-11-04T14:00:00Z" },
        { installationId: "install_2", name: null, online: false, reportedAt: null },
      ],
    });
    expect(result.candidates).toEqual([
      { installationId: "install_1", name: "Desk", online: true, reportedAt: "2026-11-04T14:00:00Z" },
      { installationId: "install_2", name: null, online: false, reportedAt: null },
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("redacts text and private SDK paths while keeping actionable watch patterns", () => {
    const path = "/private/PRIVATE_DRIFT_PATH/types.ts";
    const result = envelope({
      candidates: [{ installationId: "install_1", name: "Desk?key=PRIVATE_NAME", online: true, reportedAt: null }],
      drift: [
        { file: "types.ts", reason: `missing on disk (${path}); token=PRIVATE_REASON`, path, body: "PRIVATE_BODY" },
      ],
      installUrl: "https://user:PRIVATE_PASSWORD@console.example/install?token=PRIVATE_QUERY#PRIVATE_FRAGMENT",
      connectUrl: "https://console.example/connect/PRIVATE_PATH?key=PRIVATE_KEY",
      missingPermissions: ["pull_requests:read", "repo?token=PRIVATE_PERMISSION"],
      missingCapabilities: ["use:tool:*", "PRIVATE_CAPABILITY?key=secret"],
      unsupportedEventTypes: ["watch.github.*", "https://PRIVATE_EVENT.invalid"],
    });
    expect(result.candidates).toEqual([
      { installationId: "install_1", name: "Desk?[redacted:url-query]", online: true, reportedAt: null },
    ]);
    expect(result.drift).toEqual([
      { file: "types.ts", reason: expect.stringContaining("missing on disk"), path: "[REDACTED:path]" },
    ]);
    expect(result.installUrl).toBe("https://console.example");
    expect(result.connectUrl).toBe("https://console.example");
    expect(result.missingPermissions).toEqual(["pull_requests:read"]);
    expect(result.missingCapabilities).toEqual(["use:tool:*"]);
    expect(result.unsupportedEventTypes).toEqual(["watch.github.*"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expect(JSON.stringify(result)).not.toContain(path);
    expect(envelope({ drift: false }).drift).toBe(false);
    expect(envelope({ drift: true }).drift).toBe(true);
  });

  it("bounds operational arrays to 32 entries and display text independently", () => {
    const result = envelope({
      candidates: Array.from({ length: 40 }, (_, i) => ({
        installationId: `install_${i}`,
        name: "Desk ".repeat(100),
        online: true,
        reportedAt: null,
      })),
      drift: Array.from({ length: 40 }, (_, i) => ({
        file: `file${i}_${"name".repeat(50)}`,
        reason: "missing on disk ".repeat(100),
      })),
      allowedKeys: Array.from({ length: 40 }, (_, i) => `ENV_KEY_${i}`),
      missingPermissions: Array.from({ length: 40 }, (_, i) => `permission.${i}`),
      missingCapabilities: Array.from({ length: 40 }, (_, i) => `use:tool:${i}`),
      unsupportedEventTypes: Array.from({ length: 40 }, (_, i) => `event.${i}`),
    });
    for (const key of [
      "candidates",
      "drift",
      "allowedKeys",
      "missingPermissions",
      "missingCapabilities",
      "unsupportedEventTypes",
    ])
      expect(result[key]).toHaveLength(32);
    const candidate = (result.candidates as Array<{ name: string }>)[0]!;
    const drift = (result.drift as Array<{ file: string; reason: string }>)[0]!;
    expect(candidate.name.length).toBeLessThanOrEqual(160);
    expect(drift.file.length).toBeLessThanOrEqual(160);
    expect(drift.reason.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(result)).not.toContain("install_32");
  });

  it("rejects malformed types, unknown enum values and credential-bearing identifiers", () => {
    const result = envelope({
      runId: "run?token=PRIVATE_RUN",
      proposalStatus: "pending",
      routine: "webhook",
      reason: "PRIVATE_REASON",
      expectedSha: "a".repeat(41),
      actualSha: "g".repeat(40),
      objectType: "tag",
      liveBytes: -1,
      storedBytes: Infinity,
      path: {},
      dir: 1,
      installUrl: "javascript:PRIVATE_URL",
      connectUrl: `https://example.test/${"a".repeat(2048)}`,
      candidates: [
        { installationId: "install_1", name: "Desk", online: true, reportedAt: "PRIVATE_TIMESTAMP" },
        { installationId: "install_2", name: "Desk", online: "true", reportedAt: null },
        { installationId: "install?key=PRIVATE_ID", name: null, online: true, reportedAt: null },
      ],
      drift: [
        { file: {}, reason: "PRIVATE_REASON" },
        { file: "types.ts", reason: 12 },
      ],
      allowedKeys: ["lowercase", "KEY=PRIVATE_VALUE", "K".repeat(97), 12],
      missingPermissions: ["Authorization: Bearer PRIVATE_TOKEN", {}],
    });
    for (const key of [
      "runId",
      "proposalStatus",
      "routine",
      "reason",
      "expectedSha",
      "actualSha",
      "objectType",
      "liveBytes",
      "storedBytes",
      "path",
      "dir",
      "installUrl",
      "connectUrl",
    ])
      expect(result).not.toHaveProperty(key);
    for (const key of ["candidates", "drift", "allowedKeys", "missingPermissions"]) expect(result[key]).toEqual([]);
    expect(envelope({ runId: "r".repeat(81) })).not.toHaveProperty("runId");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("does not evaluate arbitrary nested getters and tolerates a throwing allowed getter", () => {
    let unknownReads = 0;
    const result = envelope({
      candidates: [
        {
          installationId: "install_1",
          name: null,
          online: true,
          reportedAt: null,
          get body() {
            unknownReads++;
            throw new Error("PRIVATE_BODY");
          },
        },
      ],
      drift: [
        {
          file: "types.ts",
          reason: "byte mismatch",
          get path() {
            throw new Error("PRIVATE_PATH");
          },
          get body() {
            unknownReads++;
            throw new Error("PRIVATE_BODY");
          },
        },
      ],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.drift).toEqual([{ file: "types.ts", reason: "byte mismatch" }]);
    expect(unknownReads).toBe(0);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("ignores a throwing contrast pair getter while preserving the cause and other checks", () => {
    const pair = ["text.muted", "surface.page"];
    Object.defineProperty(pair, "0", {
      get() {
        throw new Error("PRIVATE_PAIR_GETTER");
      },
    });
    const result = envelope({
      contrast: {
        ok: false,
        failed: [
          { pair, ratio: 3.1, min: 4.5 },
          { pair: ["text.primary", "surface.page"], ratio: 3.2, min: 4.5 },
        ],
      },
    });
    expect(result.cause).toBe("Operation failed.");
    expect(result.contrast).toEqual({
      ok: false,
      failed: [{ pair: ["text.primary", "surface.page"], ratio: 3.2, min: 4.5 }],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
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
  it("bounds contrast failures to 32 pairs and projects only their redacted typed fields", () => {
    const failed = Array.from({ length: 40 }, (_, index) => ({
      pair: [`text.color${index}`, "surface.page"],
      ratio: 3.1,
      min: 4.5,
      body: "PRIVATE_CHECK_BODY",
    }));
    failed[0]!.pair[0] = "text.color?key=PRIVATE_PAIR_SECRET";
    const error = new ContractError("themes publish", "THEME_INVALID", "Theme has errors.", 2, {
      ...errorDiagnostic(new Error("Theme has errors.")),
      contrast: { ok: false, failed, body: "PRIVATE_CONTRAST_BODY" },
      arbitrary: "PRIVATE_ARBITRARY",
    });
    const contrast = error.envelope().error.contrast as {
      ok: boolean;
      failed: Array<{ pair: [string, string]; ratio: number; min: number }>;
    };
    expect(contrast.ok).toBe(false);
    expect(contrast.failed).toHaveLength(32);
    expect(contrast.failed[0]).toEqual({
      pair: ["text.color?[redacted:url-query]", "surface.page"],
      ratio: 3.1,
      min: 4.5,
    });
    expect(contrast.failed[31]).toEqual({ pair: ["text.color31", "surface.page"], ratio: 3.1, min: 4.5 });
    expect(JSON.stringify(error.envelope())).not.toContain("PRIVATE_");
    expect(JSON.stringify(error.envelope())).not.toContain("text.color32");
  });

  it("rejects malformed contrast fields without coercing them", () => {
    const error = new ContractError("themes publish", "THEME_INVALID", "Theme has errors.", 2, {
      ...errorDiagnostic(new Error("Theme has errors.")),
      contrast: {
        ok: false,
        failed: [
          { pair: ["a", "b", "PRIVATE_THIRD"], ratio: 3, min: 4.5 },
          { pair: ["a", {}], ratio: 3, min: 4.5 },
          { pair: ["a", "b"], ratio: Infinity, min: 4.5 },
          { pair: ["a", "b"], ratio: 3, min: -1 },
          { pair: ["a", "b"], ratio: "3", min: 4.5 },
        ],
      },
    });
    expect(error.envelope().error.contrast).toEqual({ ok: false, failed: [] });
    expect(JSON.stringify(error.envelope())).not.toContain("PRIVATE_");
  });

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
