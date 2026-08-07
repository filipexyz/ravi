import { describe, expect, it } from "bun:test";
import { remoteGatewayExitCode, type RemoteDispatchResult } from "./remote-gateway.js";

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
});
