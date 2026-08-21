import { afterAll, describe, expect, it, mock } from "bun:test";
import type { ContextRecord } from "../../router/router-db.js";

const actualRegistry = await import("../../runtime/context-registry.js");
const context: ContextRecord = {
  contextId: "ctx_gateway_auth",
  contextKey: "rctx_gateway_auth",
  kind: "test-runtime",
  agentId: "gateway-auth",
  capabilities: [],
  createdAt: 1000,
};
let resolutionOptions: unknown;

mock.module("../../runtime/context-registry.js", () => ({
  ...actualRegistry,
  resolveRuntimeContext: (_token: string, options?: unknown) => {
    resolutionOptions = options;
    return context;
  },
}));

const { resolveAuth } = await import("./auth.js");

afterAll(() => mock.restore());

describe("gateway auth context resolution", () => {
  it("uses read-only no-touch resolution for read commands", () => {
    const resolved = resolveAuth(
      new Request("http://localhost/api/v1/self/whoami", {
        headers: { authorization: "Bearer rctx_gateway_auth" },
      }),
      {},
      { readOnly: true },
    );

    expect(resolved.authenticated).toBe(true);
    expect(resolved.contextRecord?.contextId).toBe("ctx_gateway_auth");
    expect(resolutionOptions).toEqual({ touch: false, readOnly: true });
  });

  it("preserves touch semantics for mutations", () => {
    resolveAuth(
      new Request("http://localhost/api/v1/tasks/done", {
        headers: { authorization: "Bearer rctx_gateway_auth" },
      }),
    );

    expect(resolutionOptions).toEqual({ touch: true });
  });
});
