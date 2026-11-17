import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command, CommandAccess, Group } from "../../cli/decorators.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { remoteGatewayErrorToContractError } from "../../cli/remote-gateway.js";
import { createRuntimeContext, revokeRuntimeContext } from "../../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { resolveAuth } from "./auth.js";
import { createGatewayHandlerContext, handleGatewayRequest } from "./server.js";

let calls = 0;

@Group({ name: "authprobe", description: "Authentication regression fixture", scope: "open" })
class OpenCommands {
  @Command({ name: "read", description: "Read fixture" })
  @CommandAccess({ kind: "read", resource: "authprobe", action: "read", risk: "low" })
  read() {
    calls += 1;
    return { ok: true };
  }
}

@Group({ name: "authguard", description: "Protected authentication fixture", scope: "admin" })
class ProtectedCommands {
  @Command({ name: "read", description: "Read fixture" })
  @CommandAccess({ kind: "read", resource: "authguard", action: "read", risk: "low" })
  read() {
    calls += 1;
    return { ok: true };
  }
}

const ctx = createGatewayHandlerContext({ registry: buildRegistry([OpenCommands, ProtectedCommands]) });
const capabilities = [{ permission: "read", objectType: "authprobe", objectId: "read" }];

function request(token?: string, group = "authprobe") {
  return new Request(`http://fixture/api/v1/${group}/read`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: "{}",
  });
}
async function call(token?: string, group?: string) {
  const response = (await handleGatewayRequest(request(token, group), ctx))!;
  const body = (await response.json()) as {
    error: { code: string; message: string; suggestedAction: string };
  };
  return { response, body };
}

describe("gateway runtime context expiry", () => {
  let stateDir: string | null = null;
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-gateway-auth-expiry-");
    calls = 0;
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it.each(["authprobe", "authguard"])("reports expired credentials before dispatch on %s", async (group) => {
    const context = createRuntimeContext({ capabilities, expiresAt: Date.now() - 1 });
    expect(resolveAuth(request(context.contextKey)).reason).toBe("expired");
    const { response, body } = await call(context.contextKey, group);
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("CONTEXT_EXPIRED");
    expect(body.error.message).toContain("expired");
    expect(body.error.suggestedAction).toMatch(/context credential/i);
    expect(JSON.stringify(body)).not.toContain(context.contextKey);
    expect(calls).toBe(0);
    const remote = remoteGatewayErrorToContractError(`${group} read`, {
      status: response.status,
      ok: false,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    expect(remote?.code).toBe("CONTEXT_EXPIRED");
  });

  it("keeps revocation distinct and rejects it even on an open route", async () => {
    const context = createRuntimeContext({ capabilities, expiresAt: Date.now() - 1 });
    revokeRuntimeContext(context.contextId);
    expect(resolveAuth(request(context.contextKey)).reason).toBe("revoked");
    const { response, body } = await call(context.contextKey);
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("AUTH_REQUIRED");
    expect(calls).toBe(0);
  });

  it.each(["rctx_unknown_fixture", "not-a-runtime-key"])(
    "rejects invalid bearer %s on an open route",
    async (token) => {
      const { response, body } = await call(token);
      expect(response.status).toBe(401);
      expect(body.error.code).toBe("AUTH_REQUIRED");
      expect(calls).toBe(0);
    },
  );

  it("never authorizes a stored context whose bridge authority is invalid", async () => {
    const context = createRuntimeContext({ capabilities, metadata: { bridgeTurnId: false } });
    const { response, body } = await call(context.contextKey);
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("AUTH_REQUIRED");
    expect(calls).toBe(0);
  });

  it("keeps valid credentials without a grant as permission denied", async () => {
    const context = createRuntimeContext({ capabilities: [] });
    const { response, body } = await call(context.contextKey);
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("PERMISSION_DENIED");
    expect(calls).toBe(0);
  });

  it("preserves unauthenticated open-route dispatch and valid authorized requests", async () => {
    const missing = await call();
    expect(missing.response.status).toBe(403);
    expect(missing.body.error.code).toBe("PERMISSION_DENIED");
    const context = createRuntimeContext({ capabilities });
    const allowed = await call(context.contextKey);
    expect(allowed.response.status).toBe(200);
    expect(calls).toBe(1);
  });
});
