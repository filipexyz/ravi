import { describe, expect, it } from "bun:test";

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

describe("gateway ContractError compatibility", () => {
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
