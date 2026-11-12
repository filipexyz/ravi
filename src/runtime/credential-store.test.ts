import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { classifyRuntimeCredentialFailure } from "./credential-classifier.js";
import { selectRuntimeCredential } from "./credential-pool.js";
import {
  createRuntimeCredential,
  getRuntimeCredential,
  getRuntimeCredentialHealth,
  reconcileRuntimeCredentialSecretShapes,
  recordRuntimeCredentialFailure,
  recordRuntimeCredentialLimitPressure,
  recordRuntimeCredentialSuccess,
  serializeRuntimeCredential,
} from "./credential-store.js";
import type { RuntimeCredentialInput } from "./credential-types.js";

let stateDir: string | null = null;
let previousStateDir: string | undefined;
let previousSecret: string | undefined;

function credentialInput(id: string, label: string, priority: number): RuntimeCredentialInput {
  return {
    id,
    label,
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

describe("runtime credential store and pool", () => {
  beforeEach(async () => {
    previousStateDir = process.env.RAVI_STATE_DIR;
    previousSecret = process.env.RAVI_TEST_OPENAI_KEY;
    process.env.RAVI_TEST_OPENAI_KEY = "sk-test_actual_secret_value";
    stateDir = await createIsolatedRaviState("ravi-runtime-credential-store-");
  });

  afterEach(async () => {
    if (previousSecret === undefined) delete process.env.RAVI_TEST_OPENAI_KEY;
    else process.env.RAVI_TEST_OPENAI_KEY = previousSecret;
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
    if (previousStateDir) process.env.RAVI_STATE_DIR = previousStateDir;
    previousStateDir = undefined;
  });

  it("marks an OAuth credential invalid when the bound secret is an API key", () => {
    const secret = "sk-ant-api03-fake-not-a-real-key";
    const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = secret;
    const credential = createRuntimeCredential({
      id: "rcred_oauth_api_key",
      label: "claude-oauth",
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      authMethod: "claude-oauth",
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "CLAUDE_CODE_OAUTH_TOKEN",
          secretRef: "env:CLAUDE_CODE_OAUTH_TOKEN",
          sourceHint: "CLAUDE_CODE_OAUTH_TOKEN",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });
    expect(credential.status).toBe("invalid");
    expect(credential.lastErrorCode).toBe("secret_shape_mismatch");
    expect(credential.lastErrorMessageRedacted).toContain('Credential "claude-oauth" (claude-oauth)');
    expect(credential.lastErrorMessageRedacted).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    const dumped = JSON.stringify(getDb().prepare("SELECT * FROM runtime_credentials WHERE id = ?").get(credential.id));
    expect(dumped).not.toContain(secret);
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  });

  it("reconciles a healthy OAuth credential after the bound env becomes an API key", () => {
    const secret = "sk-ant-api03-fake-not-a-real-key";
    const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    createRuntimeCredential({
      id: "rcred_oauth_later",
      label: "claude-oauth",
      runtimeProvider: "claude",
      authMethod: "claude-oauth",
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "CLAUDE_CODE_OAUTH_TOKEN",
          secretRef: "env:CLAUDE_CODE_OAUTH_TOKEN",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });
    expect(getRuntimeCredential("rcred_oauth_later")?.status).toBe("healthy");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = secret;
    expect(reconcileRuntimeCredentialSecretShapes()).toBe(1);
    const reconciled = getRuntimeCredential("rcred_oauth_later");
    expect(reconciled?.status).toBe("invalid");
    expect(reconciled?.lastErrorMessageRedacted).toContain("(claude-oauth)");
    expect(JSON.stringify(reconciled)).not.toContain(secret);
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  });

  it("stores credential metadata without persisting raw secret values", () => {
    const credential = createRuntimeCredential(credentialInput("rcred_secret_safe", "OpenAI primary", 10));
    const serialized = serializeRuntimeCredential(credential, { includeBindings: true });
    const dbDump = JSON.stringify({
      credentials: getDb().prepare("SELECT * FROM runtime_credentials").all(),
      bindings: getDb().prepare("SELECT * FROM runtime_credential_secret_bindings").all(),
    });

    expect(credential.bindings[0]?.secretRef).toBe("env:RAVI_TEST_OPENAI_KEY");
    expect(dbDump).not.toContain("sk-test_actual_secret_value");
    expect(JSON.stringify(serialized)).not.toContain("RAVI_TEST_OPENAI_KEY");
    expect(JSON.stringify(serialized)).not.toContain("sk-test_actual_secret_value");
  });

  it("selects the highest priority healthy same-provider credential and skips cooldown", () => {
    createRuntimeCredential(credentialInput("rcred_low", "OpenAI low", 1));
    createRuntimeCredential(credentialInput("rcred_high", "OpenAI high", 20));

    expect(
      selectRuntimeCredential({
        runtimeProvider: "codex",
        upstreamProvider: "openai",
      }).credential?.id,
    ).toBe("rcred_high");

    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      credentialId: "rcred_high",
      httpStatus: 429,
      headers: { "retry-after": "60" },
    });
    recordRuntimeCredentialFailure("rcred_high", signal, 1_000);

    const selected = selectRuntimeCredential({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      now: 2_000,
    });
    expect(selected.credential?.id).toBe("rcred_low");
    expect(selected.rejected).toContainEqual({
      credentialId: "rcred_high",
      label: "OpenAI high",
      reason: "status:cooldown",
    });
  });

  it("keeps weekly exhausted Claude credentials ineligible for later inputs", () => {
    createRuntimeCredential({
      ...credentialInput("rcred_weekly", "Claude weekly", 10),
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
    });
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      providerCode: "rate_limit",
      message: "You've hit your weekly limit · resets 10am (America/Sao_Paulo)",
    });
    const transition = recordRuntimeCredentialFailure("rcred_weekly", signal, 1_000);
    expect(transition.credential.status).toBe("exhausted");
    expect(getRuntimeCredentialHealth("rcred_weekly")?.cooldownUntil).toBe(1_000 + 24 * 60 * 60 * 1000);
    for (const now of [2_000, 61_001, 3_601_000]) {
      const selected = selectRuntimeCredential({ runtimeProvider: "claude", upstreamProvider: "anthropic", now });
      expect(selected.credential).toBeNull();
      expect(selected.rejected).toContainEqual({
        credentialId: "rcred_weekly",
        label: "Claude weekly",
        reason: "status:exhausted",
      });
    }
  });

  it("records failure against the exact attempted credential only", () => {
    createRuntimeCredential(credentialInput("rcred_failed", "Failed slot", 10));
    createRuntimeCredential(credentialInput("rcred_healthy", "Healthy slot", 10));

    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      credentialId: "rcred_failed",
      httpStatus: 401,
      message: "Invalid API key",
    });
    const transition = recordRuntimeCredentialFailure("rcred_failed", signal, 5_000);

    expect(transition.credential.status).toBe("invalid");
    expect(transition.health.lastFailureKind).toBe("auth_invalid");
    expect(getRuntimeCredential("rcred_failed")?.status).toBe("invalid");
    expect(getRuntimeCredential("rcred_healthy")?.status).toBe("healthy");
    expect(getRuntimeCredentialHealth("rcred_healthy")?.lastFailureKind).toBeUndefined();
  });

  it("clears stale credential error fields after a successful turn", () => {
    createRuntimeCredential(credentialInput("rcred_recovered", "Recovered slot", 10));
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      credentialId: "rcred_recovered",
      httpStatus: 401,
      message: "Invalid API key",
    });
    recordRuntimeCredentialFailure("rcred_recovered", signal, 5_000);

    const failed = getRuntimeCredential("rcred_recovered");
    expect(failed?.status).toBe("invalid");
    expect(failed?.lastErrorReason).toBe("auth_invalid");
    expect(failed?.lastErrorMessageRedacted).toBe("Invalid API key");

    const transition = recordRuntimeCredentialSuccess("rcred_recovered", 10_000);
    const serialized = serializeRuntimeCredential(transition.credential);

    expect(transition.credential.status).toBe("healthy");
    expect(transition.credential.lastErrorCode).toBeUndefined();
    expect(transition.credential.lastErrorReason).toBeUndefined();
    expect(transition.credential.lastErrorMessageRedacted).toBeUndefined();
    expect(serialized.lastErrorCode).toBeNull();
    expect(serialized.lastErrorReason).toBeNull();
    expect(serialized.lastErrorMessageRedacted).toBeNull();
  });

  it("records near-limit pressure without preserving stale hard-failure health", () => {
    createRuntimeCredential(credentialInput("rcred_pressure", "Pressure slot", 10));
    const authFailure = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      credentialId: "rcred_pressure",
      httpStatus: 401,
      message: "Invalid API key",
    });
    recordRuntimeCredentialFailure("rcred_pressure", authFailure, 5_000);
    expect(getRuntimeCredentialHealth("rcred_pressure")?.lastFailureKind).toBe("auth_invalid");

    const pressure = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      credentialId: "rcred_pressure",
      httpStatus: 429,
      headers: {
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "5",
        "retry-after": "10",
      },
    });
    const transition = recordRuntimeCredentialLimitPressure("rcred_pressure", pressure, 10_000);

    expect(transition.credential.status).toBe("cooldown");
    expect(transition.credential.lastErrorReason).toBe("near_limit");
    expect(transition.health.lastFailureKind).toBeUndefined();
    expect(transition.health.lastFailureConfidence).toBeUndefined();
    expect(transition.health.consecutiveFailures).toBe(0);
  });
});
