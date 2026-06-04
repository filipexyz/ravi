import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { classifyRuntimeCredentialFailure } from "./credential-classifier.js";
import { selectRuntimeCredential } from "./credential-pool.js";
import { refreshRuntimeCredential, refreshRuntimeCredentialPool } from "./credential-refresh.js";
import {
  createRuntimeCredential,
  getRuntimeCredential,
  recordRuntimeCredentialFailure,
  recordRuntimeCredentialLimitPressure,
} from "./credential-store.js";
import type { RuntimeCredentialInput } from "./credential-types.js";

let stateDir: string | null = null;

function credentialInput(id: string, priority: number): RuntimeCredentialInput {
  return {
    id,
    label: id,
    runtimeProvider: "codex",
    upstreamProvider: "openai",
    authMethod: "api-key",
    priority,
    bindings: [
      {
        sourceKind: "env",
        targetKind: "env",
        targetName: "OPENAI_API_KEY",
        secretRef: "env:RAVI_TEST_OPENAI_KEY",
        sourceHint: "RAVI_TEST_OPENAI_KEY",
        sensitive: true,
        remoteForward: false,
      },
    ],
  };
}

describe("runtime credential refresh", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-credential-refresh-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("recovers expired cooldown credentials before pool selection", async () => {
    createRuntimeCredential(credentialInput("rcred_high", 100));
    createRuntimeCredential(credentialInput("rcred_low", 1));
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      credentialId: "rcred_high",
      httpStatus: 429,
      headers: { "retry-after": "1" },
    });
    recordRuntimeCredentialFailure("rcred_high", signal, 1_000);

    expect(
      selectRuntimeCredential({
        runtimeProvider: "codex",
        upstreamProvider: "openai",
        now: 1_500,
      }).credential?.id,
    ).toBe("rcred_low");

    const refreshed = await refreshRuntimeCredentialPool({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      now: 3_000,
    });

    expect(refreshed).toContainEqual(
      expect.objectContaining({
        credentialId: "rcred_high",
        action: "recovered",
        statusAfter: "healthy",
      }),
    );
    expect(getRuntimeCredential("rcred_high")?.status).toBe("healthy");
    expect(
      selectRuntimeCredential({
        runtimeProvider: "codex",
        upstreamProvider: "openai",
        now: 3_000,
      }).credential?.id,
    ).toBe("rcred_high");
  });

  it("rotates near-limit credentials with a soft cooldown", () => {
    createRuntimeCredential(credentialInput("rcred_near_limit", 100));
    createRuntimeCredential(credentialInput("rcred_spare", 1));
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      credentialId: "rcred_near_limit",
      headers: {
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "5",
        "x-ratelimit-reset-requests": "5000",
      },
    });

    recordRuntimeCredentialLimitPressure("rcred_near_limit", signal, 1_000);

    expect(getRuntimeCredential("rcred_near_limit")?.status).toBe("cooldown");
    expect(
      selectRuntimeCredential({
        runtimeProvider: "codex",
        upstreamProvider: "openai",
        now: 2_000,
      }).credential?.id,
    ).toBe("rcred_spare");
  });

  it("reports unsupported refresh when no provider hook exists", async () => {
    createRuntimeCredential({
      ...credentialInput("rcred_oauth", 1),
      authMethod: "claude-oauth",
      runtimeProvider: "claude",
    });
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      credentialId: "rcred_oauth",
      httpStatus: 401,
    });
    recordRuntimeCredentialFailure("rcred_oauth", signal, 1_000);

    const result = await refreshRuntimeCredential("rcred_oauth", {
      reason: "operator",
      now: 2_000,
    });

    expect(result.action).toBe("unsupported");
    expect(result.statusAfter).toBe("needs_reauth");
  });
});
