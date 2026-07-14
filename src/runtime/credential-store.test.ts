import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { REDACTION_TEXT_CORPUS } from "../test/redaction-corpus.js";
import { classifyRuntimeCredentialFailure } from "./credential-classifier.js";
import { selectRuntimeCredential } from "./credential-pool.js";
import {
  completeRuntimeCredentialAttempt,
  createRuntimeCredential,
  getRuntimeCredential,
  getRuntimeCredentialHealth,
  listRuntimeProviderHealth,
  recordRuntimeCredentialFailure,
  recordRuntimeCredentialLimitPressure,
  recordRuntimeCredentialSuccess,
  reserveRuntimeCredentialAttempt,
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

  it("redacts secrets from runtime credential attempt metadata", () => {
    createRuntimeCredential(credentialInput("rcred_attempt_safe", "Attempt safe", 10));
    const attemptId = reserveRuntimeCredentialAttempt({
      credentialId: "rcred_attempt_safe",
      runtimeProvider: "codex",
      metadata: { phase: "reserve", detail: "sk-proj-abcdefghijklmnopqrstuvwxyz" },
    });
    completeRuntimeCredentialAttempt(attemptId, {
      status: "abandoned",
      metadata: {
        phase: "runtime.start",
        error: "provider rejected ghp_abcdefghijklmnopqrstuvwxyz123456",
        nested: { aws: "AKIA1234567890ABCDEF" },
      },
    });

    const row = getDb()
      .prepare("SELECT metadata_json FROM runtime_credential_attempts WHERE id = ?")
      .get(attemptId) as { metadata_json: string };
    expect(row.metadata_json).toContain("[REDACTED]");
    expect(row.metadata_json).not.toContain("sk-proj-");
    expect(row.metadata_json).not.toContain("ghp_");
    expect(row.metadata_json).not.toContain("AKIA1234567890ABCDEF");
  });

  it("re-sanitizes the shared adversarial corpus at persistence sinks", () => {
    createRuntimeCredential(credentialInput("rcred_sink_safe", "Sink safe", 10));
    const baseSignal = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      credentialId: "rcred_sink_safe",
      httpStatus: 503,
      message: "provider unavailable",
    });

    for (const entry of REDACTION_TEXT_CORPUS) {
      recordRuntimeCredentialFailure(
        "rcred_sink_safe",
        {
          ...baseSignal,
          upstreamProvider: entry.input,
          model: entry.input,
          providerCode: entry.input,
          providerType: entry.input,
          requestId: entry.input,
          message: entry.input,
        },
        1_000,
      );
      const persisted = JSON.stringify({
        credential: getDb()
          .prepare("SELECT last_error_code, last_error_message_redacted FROM runtime_credentials WHERE id = ?")
          .get("rcred_sink_safe"),
        health: getDb()
          .prepare("SELECT last_request_id FROM runtime_credential_health WHERE credential_id = ?")
          .get("rcred_sink_safe"),
        provider: getDb()
          .prepare("SELECT upstream_provider, model, last_request_id, reason FROM runtime_provider_health LIMIT 1")
          .get(),
      });
      expect(persisted).not.toContain(entry.secret);
      expect(persisted).toContain("[REDACTED]");
    }
  });

  it("re-sanitizes legacy failure rows when emitting credential health", () => {
    createRuntimeCredential(credentialInput("rcred_legacy_safe", "Legacy safe", 10));
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      credentialId: "rcred_legacy_safe",
      httpStatus: 503,
      message: "provider unavailable",
    });
    recordRuntimeCredentialFailure("rcred_legacy_safe", signal, 1_000);
    const providerHealthId = listRuntimeProviderHealth()[0]?.id;
    expect(providerHealthId).toBeDefined();

    for (const entry of REDACTION_TEXT_CORPUS) {
      getDb()
        .prepare(
          `
          UPDATE runtime_credentials
          SET last_error_code = ?, last_error_reason = ?, last_error_message_redacted = ?
          WHERE id = ?
        `,
        )
        .run(entry.input, entry.input, entry.input, "rcred_legacy_safe");
      getDb()
        .prepare("UPDATE runtime_credential_health SET last_request_id = ? WHERE credential_id = ?")
        .run(entry.input, "rcred_legacy_safe");
      getDb()
        .prepare(
          `
          UPDATE runtime_provider_health
          SET runtime_provider = ?, upstream_provider = ?, model = ?, last_request_id = ?, reason = ?
          WHERE id = ?
        `,
        )
        .run(entry.input, entry.input, entry.input, entry.input, entry.input, providerHealthId);

      const emitted = JSON.stringify({
        credential: getRuntimeCredential("rcred_legacy_safe"),
        health: getRuntimeCredentialHealth("rcred_legacy_safe"),
        providerHealth: listRuntimeProviderHealth(),
      });
      expect(emitted).not.toContain(entry.secret);
      expect(emitted).toContain("[REDACTED]");
    }
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

  it("applies target credential requirements through the existing credential pool", () => {
    createRuntimeCredential({
      ...credentialInput("rcred_oauth", "OAuth account", 20),
      authMethod: "oauth",
      sessionCompatibilityKey: "account-a",
    });
    createRuntimeCredential({
      ...credentialInput("rcred_api", "API account", 10),
      authMethod: "api-key",
      sessionCompatibilityKey: "account-b",
    });

    const selected = selectRuntimeCredential({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      credentialIds: ["rcred_oauth"],
      authMethods: ["oauth"],
      sessionCompatibilityKey: "account-a",
    });
    expect(selected.credential?.id).toBe("rcred_oauth");
    expect(selected.rejected).toContainEqual({
      credentialId: "rcred_api",
      label: "API account",
      reason: "credential_not_allowed",
    });

    const incompatible = selectRuntimeCredential({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      authMethods: ["oauth"],
      sessionCompatibilityKey: "account-b",
    });
    expect(incompatible.credential).toBeNull();
    expect(incompatible.rejected.map((item) => item.reason)).toContain("session_compatibility_mismatch");
    expect(incompatible.rejected.map((item) => item.reason)).toContain("auth_method_not_allowed");
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
