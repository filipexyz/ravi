import { describe, expect, it } from "bun:test";
import {
  remoteGatewayErrorToContractError,
  remoteGatewayExitCode,
  type RemoteDispatchResult,
} from "./remote-gateway.js";

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
    expect(remoteGatewayExitCode(result({ body: JSON.stringify({ success: false, exitCode }) }))).toBe(exitCode);
  });

  it("keeps success at zero and malformed or legacy failures at one", () => {
    expect(remoteGatewayExitCode(result({ ok: true, status: 200 }))).toBe(0);
    expect(remoteGatewayExitCode(result({ body: "not-json" }))).toBe(1);
    expect(remoteGatewayExitCode(result({ body: JSON.stringify({ error: "legacy" }) }))).toBe(1);
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
});
