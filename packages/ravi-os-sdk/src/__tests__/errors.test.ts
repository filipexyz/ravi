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
      code: exitCode === 3 ? "WRITE_REQUIRES_EXECUTE" : exitCode === 2 ? "USAGE_ERROR" : "PROVIDER_ERROR",
      message: "contract stopped execution",
      retryable: false,
      suggestedAction: "inspect and retry",
    },
  };
}

describe("gateway ContractError compatibility", () => {
  it.each([
    [422, 1, "failed"],
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
    expect(error.body).toBe(body);
    expect((error as RaviContractError).contractBody).toBe(body);
    expect(isRaviContractErrorBody(error.body)).toBe(true);
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
