import { describe, expect, it } from "bun:test";
import {
  getRemoteGatewayConfig,
  remoteGatewayErrorToContractError,
  remoteGatewayExitCode,
  type RemoteDispatchResult,
} from "./remote-gateway.js";

describe("remote gateway configuration", () => {
  it("distinguishes an unset gateway from an invalid configured URL", () => {
    expect(getRemoteGatewayConfig({})).toBeNull();
    for (const value of ["not a URL", "file:///tmp/ravi"]) {
      let failure: unknown;
      try {
        getRemoteGatewayConfig({ RAVI_GATEWAY_URL: value });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "REMOTE_GATEWAY_INVALID", exitCode: 2 });
    }
  });
});

function result(overrides: Partial<RemoteDispatchResult>): RemoteDispatchResult {
  return {
    status: 500,
    ok: false,
    body: "",
    contentType: "application/json",
    ...overrides,
  };
}

describe("remote gateway exit taxonomy", () => {
  it.each([1, 2, 3] as const)("preserves contract exit %i", (exitCode) => {
    const outcome = exitCode === 2 ? "usage_error" : exitCode === 3 ? "blocked" : "failed";
    expect(
      remoteGatewayExitCode(
        result({
          body: JSON.stringify({
            success: false,
            op: "commands list",
            exitCode,
            outcome,
            error: { code: "DEMO_ERROR", message: "safe failure", retryable: false },
          }),
        }),
      ),
    ).toBe(exitCode);
  });

  it("keeps success at zero and malformed or legacy failures at one", () => {
    expect(remoteGatewayExitCode(result({ ok: true, status: 200 }))).toBe(0);
    expect(remoteGatewayExitCode(result({ body: "not-json" }))).toBe(1);
    expect(remoteGatewayExitCode(result({ body: JSON.stringify({ error: "legacy" }) }))).toBe(1);
    expect(remoteGatewayExitCode(result({ body: JSON.stringify({ success: false, exitCode: 3 }) }))).toBe(1);
  });

  it("normalizes legacy permission responses into the canonical contract", () => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "PermissionDenied", reason: "missing capability" }),
      }),
    );

    expect(error).toMatchObject({ op: "commands list", code: "PERMISSION_DENIED", exitCode: 1 });
    expect(error?.envelope()).toMatchObject({ success: false, error: { code: "PERMISSION_DENIED" } });
  });

  it("redacts malformed remote failures as retryable server errors", () => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({ status: 503, contentType: "text/plain", body: "private upstream response" }),
    );

    expect(error).toMatchObject({ op: "commands list", code: "SERVER_UNAVAILABLE", exitCode: 1 });
    expect(JSON.stringify(error?.envelope())).not.toContain("private upstream response");
  });

  it("rejects partial or incoherent contract-looking responses", () => {
    const partial = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "commands list",
          exitCode: 3,
          error: { code: "WRITE_REQUIRES_EXECUTE", message: "raw private response" },
        }),
      }),
    );
    const wrongOperation = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "secrets reveal",
          exitCode: 3,
          outcome: "blocked",
          error: { code: "WRITE_REQUIRES_EXECUTE", message: "blocked", retryable: false },
        }),
      }),
    );

    expect(partial).toMatchObject({ code: "SERVER_UNAVAILABLE", exitCode: 1 });
    expect(JSON.stringify(partial?.envelope())).not.toContain("raw private response");
    expect(wrongOperation).toMatchObject({ code: "SERVER_UNAVAILABLE", exitCode: 1 });
  });

  it("preserves a complete coherent contract response", () => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "commands list",
          exitCode: 3,
          outcome: "blocked",
          error: { code: "WRITE_REQUIRES_EXECUTE", message: "confirmation required", retryable: false },
        }),
      }),
    );

    expect(error).toBeNull();
  });
});
