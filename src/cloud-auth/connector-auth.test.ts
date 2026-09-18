import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CloudAuthError } from "./errors.js";
import { resolveConnectorCloudCredentials } from "./connector-auth.js";
import { writeCloudCredentials } from "./storage.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { CloudCredentials } from "./types.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-connector-auth-");
});

afterEach(async () => {
  delete process.env.RAVI_CONTEXT_KEY;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("resolveConnectorCloudCredentials", () => {
  it("uses the bound Console user when turn metadata has consoleUserId", () => {
    writeCloudCredentials(makeCredentials("user_operator", "operator-access"));
    writeCloudCredentials(makeCredentials("user_alice", "alice-access"));
    const context = createRuntimeContext({
      kind: "turn-runtime",
      metadata: { actorPrincipal: "contact:luis", consoleUserId: "user_alice" },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;

    expect(resolveConnectorCloudCredentials().accessToken).toBe("alice-access");
  });

  it("does not fall back to the operator JWT for user-scoped connector tools", () => {
    writeCloudCredentials(makeCredentials("user_operator", "operator-access"));
    const context = createRuntimeContext({
      kind: "turn-runtime",
      metadata: { actorPrincipal: "contact:luis" },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;

    try {
      resolveConnectorCloudCredentials({ requireBoundUser: true });
      throw new Error("expected AUTH_REQUIRED");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      expect((error as CloudAuthError).code).toBe("AUTH_REQUIRED");
      expect((error as CloudAuthError).message).toContain("Operator JWT is not a fallback");
    }
  });
});

function makeCredentials(userId: string, accessToken: string): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["artifacts:publish"],
    user: { id: userId },
    organization: { id: "org_123", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
