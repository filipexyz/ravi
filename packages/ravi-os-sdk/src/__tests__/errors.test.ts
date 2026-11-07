import { describe, expect, it } from "bun:test";
import { projectProviderDiagnosticText, redactDiagnosticText, safeDiagnosticField } from "../diagnostic-redactor.js";

import {
  RaviAuthError,
  RaviContractError,
  RaviInternalError,
  RaviPermissionError,
  RaviValidationError,
  buildErrorFromGateway,
  isRaviContractErrorBody,
  type RaviContractErrorBody,
  type RaviErrorBody,
} from "../errors.js";
import { createHttpTransport } from "../transport/http.js";

function contractBody(exitCode: 1 | 2 | 3, outcome: RaviContractErrorBody["outcome"]): RaviContractErrorBody {
  return {
    success: false,
    op: "audio generate",
    exitCode,
    outcome,
    error: {
      code:
        outcome === "denied"
          ? "PERMISSION_DENIED"
          : exitCode === 3
            ? "WRITE_REQUIRES_EXECUTE"
            : exitCode === 2
              ? "USAGE_ERROR"
              : "PROVIDER_ERROR",
      message: "contract stopped execution",
      retryable: false,
      suggestedAction: "inspect and retry",
    },
  };
}

describe("provider diagnostic field access", () => {
  it("ignores_throwing_provider_diagnostic_getters_and_keeps_readable_reason", () => {
    const body = {
      get code(): string {
        throw new Error("PRIVATE_GETTER_FAILURE");
      },
      message: "quota exceeded",
    };
    expect(safeDiagnosticField(body, "code")).toBeUndefined();
    expect(projectProviderDiagnosticText(body, {}, 0)).toBe("quota exceeded: [redacted:provider.body]");
  });

  it("ignores_throwing_provider_message_getter_and_keeps_stable_code", () => {
    const body = {
      code: "invalid_audio",
      get message(): string {
        throw new Error("PRIVATE_GETTER_FAILURE");
      },
    };
    expect(projectProviderDiagnosticText(body, {}, 0)).toBe("invalid_audio: [redacted:provider.body]");
  });

  it("reads_each_provider_field_once_before_normalizing_it", () => {
    let reads = 0;
    const body = {
      get message(): string {
        reads++;
        if (reads > 1) throw new Error("SECOND_READ_FAILURE");
        return "provider returned 401; password=PRIVATE_PASSWORD#TAIL";
      },
    };
    expect(projectProviderDiagnosticText(body, {}, 0)).toBe(
      "provider returned 401; password=[redacted:password]: [redacted:provider.body]",
    );
    expect(reads).toBe(1);
  });
});

describe("gateway ContractError compatibility", () => {
  it("bounds_redacted_multiline_diagnostics_including_a_stable_truncation_marker", () => {
    const source = ["provider returned 401; token=SDK_BOUNDARY_SECRET", ...Array(5).fill("a".repeat(1000))].join("\n");
    const body = contractBody(1, "failed");
    body.error.message = source;
    body.error.cause = source;
    const error = buildErrorFromGateway(422, body, "audio.generate") as RaviContractError;
    for (const text of [error.message, error.cause!]) {
      expect(text).toStartWith("provider returned 401; token=[redacted:token]");
      expect(text).toEndWith(" [truncated]");
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).not.toContain("SDK_BOUNDARY_SECRET");
      expect(redactDiagnosticText(text)).toBe(text);
    }
    const projectedAgain = buildErrorFromGateway(422, error.contractBody, "audio.generate") as RaviContractError;
    expect(projectedAgain.contractBody).toEqual(error.contractBody);
  });

  it.each([
    "AUTH_REQUIRED?token=SDK_CODE_QUERY_798",
    "rctx_sdk_code_secret798",
    "sk-sdkCodeSecret798",
    "A".repeat(97),
    '{"body":"SDK_CODE_BODY_798"}',
  ])("rejects malformed or credential-bearing code %s without reflecting it", (code) => {
    const body = contractBody(1, "failed");
    body.error.code = code;
    body.error.cause = "provider rejected the request";
    const error = buildErrorFromGateway(422, body, "audio.generate") as RaviContractError;
    expect(error.code).toBe("REMOTE_ERROR");
    expect(error.contractBody.error.code).toBe("REMOTE_ERROR");
    expect(error.cause).toBe("provider rejected the request");
    expect(JSON.stringify(error)).not.toContain(code);
  });

  it.each([
    "audio generate?key=SDK_OP_QUERY_798",
    "rctx_sdk_op_secret798",
    "Bearer SDK_OP_AUTH_798",
    "https://provider.test/?key=SDK_OP_URL_798",
    "a".repeat(161),
    "audio\nSDK_OP_LINE_798",
  ])("uses the validated request command for malformed remote op %s", (op) => {
    const body = contractBody(1, "failed");
    body.op = op;
    body.error.cause = "provider rejected the request";
    const error = buildErrorFromGateway(422, body, "audio.generate") as RaviContractError;
    expect(error.op).toBe("audio.generate");
    expect(error.contractBody.op).toBe("audio.generate");
    expect(error.command).toBe("audio.generate");
    expect(error.cause).toBe("provider rejected the request");
    expect(JSON.stringify(error)).not.toContain(op);
  });

  it("uses a fixed fallback when both remote op and request command contain credentials", () => {
    const body = contractBody(1, "failed");
    body.op = "rctx_remote_operation798";
    const error = buildErrorFromGateway(422, body, "rctx_request_operation798") as RaviContractError;
    expect(error.op).toBe("gateway");
    expect(error.command).toBeNull();
    expect(JSON.stringify(error)).not.toContain("rctx_");
  });

  it("preserves existing lowercase app codes and camelcase command identifiers", () => {
    const body = contractBody(1, "failed");
    body.op = "apps showManifest";
    body.error.code = "not_found";
    const error = buildErrorFromGateway(422, body, "apps.showManifest") as RaviContractError;
    expect(error.op).toBe("apps showManifest");
    expect(error.code).toBe("not_found");
    expect(error.command).toBe("apps.showManifest");
  });

  it("preserves_specific_cause_through_sdk_projection_and_http", async () => {
    const cause =
      "Cannot read audio\nCaused by: EACCES: permission denied, open /tmp/audio.wav; token=[redacted:token]";
    const context = {
      status: 403,
      provider: "openai",
      model: "whisper-1",
      operation: "transcribe file",
      code: "EACCES",
      syscall: "open",
      file: "/tmp/audio.wav",
      actor: { type: "agent", id: "main" },
    };
    const body = contractBody(1, "failed");
    Object.assign(body.error, { cause, context });
    const direct = buildErrorFromGateway(422, body, "transcribe.file") as RaviContractError;
    const transport = createHttpTransport({
      baseUrl: "https://gateway.example",
      contextKey: "rctx_test",
      fetch: (async () => Response.json(body, { status: 422 })) as typeof fetch,
    });
    let relayed: unknown;
    try {
      await transport.call({ groupSegments: ["transcribe"], command: "file", body: {} });
    } catch (error) {
      relayed = error;
    }
    for (const error of [direct, relayed as RaviContractError]) {
      expect(error).toBeInstanceOf(RaviContractError);
      expect(error.code).toBe(body.error.code);
      expect(error.cause).toBe(cause);
      expect(error.context).toEqual(context);
      expect(error.contractBody.error.cause).toBe(cause);
      expect(error.body).toEqual(body);
    }
  });

  it("projects_only_typed_diagnostic_context_and_actor_fields", () => {
    const sentinel = "PRIVATE_DIAGNOSTIC_PAYLOAD";
    const body = contractBody(1, "failed");
    Object.assign(body.error, {
      cause: "quota exceeded",
      headers: { cookie: sentinel },
      body: sentinel,
      stack: sentinel,
      context: {
        status: 429,
        provider: "openai",
        model: "whisper-1",
        operation: "transcribe file",
        code: "insufficient_quota",
        file: "/tmp/audio.wav",
        syscall: "open",
        actor: { type: "agent", id: "main", profile: sentinel, credential: sentinel },
        headers: sentinel,
        cookies: sentinel,
        query: sentinel,
        body: sentinel,
        stack: sentinel,
      },
    });
    const error = buildErrorFromGateway(422, body, "transcribe.file") as RaviContractError;
    expect(error.context).toEqual({
      status: 429,
      provider: "openai",
      model: "whisper-1",
      operation: "transcribe file",
      code: "insufficient_quota",
      file: "/tmp/audio.wav",
      syscall: "open",
      actor: { type: "agent", id: "main" },
    });
    expect(error.cause).toBe("quota exceeded");
    expect(JSON.stringify(error)).not.toContain(sentinel);
  });

  it.each([99, 600, 401.5, NaN, Infinity, "401"])("rejects invalid diagnostic status %s", (status) => {
    const body = contractBody(1, "failed");
    Object.assign(body.error, {
      context: { status, actor: { type: "agent", id: "rctx_privatecredential" }, provider: "https://host?key=private" },
    });
    const error = buildErrorFromGateway(422, body, "transcribe.file") as RaviContractError;
    expect(error.context).toEqual({});
  });

  it.each([
    [422, 1, "failed"],
    [403, 1, "denied"],
    [400, 2, "usage_error"],
    [409, 3, "blocked"],
  ] as const)("preserves the canonical envelope at HTTP %i / exit %i", (status, exitCode, outcome) => {
    const body = contractBody(exitCode, outcome);
    const error = buildErrorFromGateway(status, body, "audio.generate");

    expect(error).toBeInstanceOf(RaviContractError);
    expect(error).toMatchObject({
      name: "RaviContractError",
      message: "contract stopped execution",
      status,
      command: "audio.generate",
      op: "audio generate",
      code: body.error.code,
      retryable: false,
      exitCode,
      outcome,
    });
    expect(error.body).not.toBe(body);
    expect(error.body).toEqual(body);
    expect((error as RaviContractError).contractBody).toEqual(body);
    expect(isRaviContractErrorBody(error.body)).toBe(true);
  });

  it("projects and sanitizes canonical details instead of retaining the remote body", () => {
    const body = {
      ...contractBody(3, "blocked"),
      providerBody: "SENTINEL_SECRET_7M4Q",
      error: {
        ...contractBody(3, "blocked").error,
        providerBody: "SENTINEL_SECRET_7M4Q",
        dryRun: true,
        acceptedFlags: ["--execute", "--json"],
        plan: {
          providerBody: "SENTINEL_SECRET_7M4Q",
          caption: "PRIVATE_MESSAGE_8K2R",
          filePath: "C:/private/SENTINEL_SECRET_7M4Q.txt",
          key: "custom.password",
          value: "SENTINEL_SECRET_7M4Q",
          count: 2,
          captionPresent: true,
        },
        issues: [
          {
            path: ["caption"],
            code: "invalid",
            message: "PRIVATE_MESSAGE_8K2R",
            providerBody: "SENTINEL_SECRET_7M4Q",
          },
        ],
      },
    } as unknown as RaviContractErrorBody;

    const error = buildErrorFromGateway(409, body, "artifacts.publish") as RaviContractError;
    const serialized = JSON.stringify({ body: error.body, contractBody: error.contractBody });

    expect(error).toBeInstanceOf(RaviContractError);
    expect(error.contractBody).toEqual({
      success: false,
      op: "audio generate",
      error: {
        code: "WRITE_REQUIRES_EXECUTE",
        message: "contract stopped execution",
        retryable: false,
        suggestedAction: "inspect and retry",
        acceptedFlags: ["--execute", "--json"],
        dryRun: true,
        plan: {
          caption: "[REDACTED:content length=20]",
          filePath: "[REDACTED:path]",
          key: "custom.password",
          value: "[REDACTED]",
          count: 2,
          captionPresent: true,
        },
        issues: [
          {
            path: ["caption"],
            code: "invalid",
            message: "[REDACTED:content length=20]",
          },
        ],
      },
      exitCode: 3,
      outcome: "blocked",
    });
    expect(serialized).not.toContain("SENTINEL_SECRET_7M4Q");
    expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(serialized).not.toContain("providerBody");
  });

  it.each([
    [1, "blocked"],
    [1, "usage_error"],
    [2, "failed"],
    [2, "denied"],
    [2, "blocked"],
    [3, "failed"],
    [3, "denied"],
    [3, "usage_error"],
  ] as const)("rejects the incoherent exit %i / %s pair", (exitCode, outcome) => {
    const body = contractBody(exitCode, outcome as RaviContractErrorBody["outcome"]);

    expect(isRaviContractErrorBody(body)).toBe(false);
    expect(buildErrorFromGateway(400, body, "audio.generate")).not.toBeInstanceOf(RaviContractError);
  });

  it.each([
    ["denied", "SOME_ERROR"],
    ["failed", "PERMISSION_DENIED"],
  ] as const)("rejects outcome %s with permission code %s", (outcome, code) => {
    const body = contractBody(1, outcome);
    body.error.code = code;

    expect(isRaviContractErrorBody(body)).toBe(false);
    expect(buildErrorFromGateway(403, body, "agents.debounce")).not.toBeInstanceOf(RaviContractError);
  });

  it.each([
    [1, "failed", "WRITE_REQUIRES_EXECUTE"],
    [1, "failed", "USAGE_ERROR"],
  ] as const)("rejects exit %i/%s with policy code %s", (exitCode, outcome, code) => {
    const body = contractBody(exitCode, outcome);
    body.error.code = code;

    expect(isRaviContractErrorBody(body)).toBe(false);
    expect(buildErrorFromGateway(400, body, "audio.generate")).not.toBeInstanceOf(RaviContractError);
  });

  it("discards an incoherent contract-looking response instead of retaining remote content", () => {
    const sentinel = "PRIVATE_SENTINEL_INCOHERENT_4J7M";
    const body = {
      ...contractBody(3, "failed"),
      error: {
        ...contractBody(3, "failed").error,
        message: sentinel,
        plan: { prompt: sentinel },
      },
      providerBody: sentinel,
    } as unknown as RaviContractErrorBody;

    const error = buildErrorFromGateway(409, body, "audio.generate");
    const serialized = JSON.stringify({
      message: error.message,
      body: error.body,
      status: error.status,
      command: error.command,
    });

    expect(error).not.toBeInstanceOf(RaviContractError);
    expect(error).toMatchObject({
      message: "Ravi gateway returned HTTP 409",
      body: null,
      status: 409,
      command: "audio.generate",
    });
    expect(serialized).not.toContain(sentinel);
  });

  it("preserves a policy block through the HTTP transport", async () => {
    const body = contractBody(3, "blocked");
    const transport = createHttpTransport({
      baseUrl: "https://gateway.example",
      contextKey: "rctx_test",
      fetch: (async () => Response.json(body, { status: 409 })) as typeof fetch,
    });

    let caught: unknown;
    try {
      await transport.call({ groupSegments: ["audio"], command: "generate", body: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RaviContractError);
    expect(caught).toMatchObject({
      message: "contract stopped execution",
      op: "audio generate",
      code: "WRITE_REQUIRES_EXECUTE",
      exitCode: 3,
      outcome: "blocked",
    });
  });

  it("does not retain a malformed non-JSON HTTP response", async () => {
    const sentinel = "PRIVATE_SENTINEL_HTTP_BODY_9K2R";
    const transport = createHttpTransport({
      baseUrl: "https://gateway.example",
      contextKey: "rctx_test",
      fetch: (async () =>
        new Response(`<html>${sentinel}</html>`, {
          status: 502,
          headers: { "content-type": "text/html; charset=utf-8" },
        })) as typeof fetch,
    });

    let caught: unknown;
    try {
      await transport.call({ groupSegments: ["audio"], command: "generate", body: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RaviInternalError);
    expect(caught).toMatchObject({
      message: "Ravi gateway returned HTTP 502",
      body: null,
      status: 502,
      command: "audio.generate",
    });
    expect(JSON.stringify(caught)).not.toContain(sentinel);
  });

  it.each([
    [401, RaviAuthError, { error: "Unauthorized", reason: "expired" }],
    [403, RaviPermissionError, { error: "PermissionDenied", reason: "missing grant" }],
    [400, RaviValidationError, { error: "ValidationError", message: "invalid input", issues: [] }],
    [500, RaviInternalError, { error: "InternalError", message: "kaboom" }],
  ] as const)("keeps legacy error:string mapping at HTTP %i", (status, ErrorClass, body) => {
    const error = buildErrorFromGateway(status, body as RaviErrorBody, "demo.command");

    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.body).toEqual(body);
  });
});

describe("gateway error correlation", () => {
  it("keeps request/diagnostic ids and validation fields in the SDK error", () => {
    const body = contractBody(2, "usage_error");
    Object.assign(body.error, {
      requestId: "5d8b1710-bace-4efa-8ac6-6d006e80d53e",
      diagnosticRequestId: "c9bc1cb5-e23e-4c96-a009-75df935035ec",
      field: "instructions",
      argument: "--instructions",
    });
    expect(buildErrorFromGateway(422, body).body).toEqual(body);
  });
  it("does not accept arbitrary text as correlation or field metadata", () => {
    const body = contractBody(2, "usage_error");
    Object.assign(body.error, {
      requestId: "password=private",
      diagnosticRequestId: "Bearer private",
      field: "arbitrary text",
      argument: "--flag=private",
    });
    const error = buildErrorFromGateway(422, body) as RaviContractError;
    expect(error.contractBody.error.requestId).toBeUndefined();
    expect(error.contractBody.error.diagnosticRequestId).toBeUndefined();
    expect(error.contractBody.error.field).toBeUndefined();
    expect(error.contractBody.error.argument).toBeUndefined();
  });
});
