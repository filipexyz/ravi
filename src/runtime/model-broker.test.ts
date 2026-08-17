import { describe, expect, test } from "bun:test";
import {
  assertRuntimeModelBrokerCapability,
  buildRuntimeModelBrokerAttemptBinding,
  buildRuntimeModelBrokerBinding,
  isRuntimeModelBrokerPhysicalBindingCompatible,
  readRuntimeModelBrokerSelection,
  reportRuntimeModelBrokerAttempt,
  resolveRequiredRuntimeModelBrokerSelection,
  type RuntimeModelBrokerRouteLease,
} from "./model-broker.js";
import { buildRuntimeCredentialSessionMetadata, isRuntimeCredentialSessionCompatible } from "./credential-resolver.js";
import type { RuntimeCapabilities } from "./types.js";

describe("generic model-broker contract", () => {
  test("persists only brokerId, profileRef, and required", () => {
    const defaults = { modelBroker: { brokerId: "hub", profileRef: "profile_main", required: true } };
    expect(readRuntimeModelBrokerSelection({ defaults })).toEqual(defaults.modelBroker);
    expect(JSON.stringify(defaults)).not.toContain("connectionIds");
    expect(() => readRuntimeModelBrokerSelection({ defaults: { modelBroker: { brokerId: "hub" } } })).toThrow(
      "configured together",
    );
    expect(resolveRequiredRuntimeModelBrokerSelection({ defaults }, "false")).toEqual(defaults.modelBroker);
    expect(resolveRequiredRuntimeModelBrokerSelection({ defaults: null }, "true")).toEqual({
      brokerId: "hub",
      profileRef: "canonical",
      required: true,
    });
    expect(
      resolveRequiredRuntimeModelBrokerSelection({ defaults: { modelBroker: { required: true } } }, "false"),
    ).toEqual({ brokerId: "hub", profileRef: "canonical", required: true });
  });

  test("lets the supervised host require the canonical broker and rejects an invalid policy", () => {
    expect(resolveRequiredRuntimeModelBrokerSelection({ defaults: null }, "false", "true")).toEqual({
      brokerId: "hub",
      profileRef: "canonical",
      required: true,
    });
    expect(() => resolveRequiredRuntimeModelBrokerSelection({ defaults: null }, undefined, "enabled")).toThrow(
      "RAVI_MODEL_BROKER_REQUIRED must be true or false",
    );
    expect(() => resolveRequiredRuntimeModelBrokerSelection({ defaults: null }, "enabled", "true")).toThrow(
      "runtime.model_broker.required must be true or false",
    );
  });

  test("accepts an authoritative secretless route and builds generic attempt metadata", () => {
    const binding = brokerBinding();
    expect(binding).toMatchObject({
      brokerId: "hub",
      profileRef: "profile_main",
      runtimeProvider: "codex",
      model: "gpt-5.4",
      transport: { scheme: "local-http-forwarder-v1", protocol: "openai-responses" },
    });
    const attempt = buildRuntimeModelBrokerAttemptBinding(binding, "agent:main:main");
    expect(attempt).toMatchObject({
      authMethod: "model-broker",
      modelBrokerId: "hub",
      modelBrokerProfileRef: "profile_main",
      modelBrokerLeaseId: "grant_a",
      modelBrokerTurnId: "turn_a",
      bindings: [],
      resolvedEnv: {},
    });
    expect(JSON.stringify(binding)).not.toMatch(/token|secret|connectionId/i);
  });

  test("requires loopback and rejects authority, credential, framing, and hop-by-hop headers", () => {
    for (const origin of ["http://localhost:43123", "http://0.0.0.0:43123", "https://127.0.0.1:43123"]) {
      expect(() => brokerBinding({ transport: { ...lease().transport, origin } })).toThrow("127.0.0.1");
    }
    for (const header of [
      "authorization",
      "cookie",
      "set-cookie",
      "host",
      "content-length",
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "proxy-x",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "x-api-key",
      "api-key",
      "anthropic-api-key",
      "openai-api-key",
      "x-access-token",
      "provider-auth-token",
      "x-client-secret",
      "x-provider-credential",
    ]) {
      expect(() =>
        brokerBinding({ transport: { ...lease().transport, publicHeaders: { [header]: "public" } } }),
      ).toThrow("forbidden header");
    }
  });

  test("treats lease provider and model as authority and fails closed without isolation", () => {
    expect(() => brokerBinding({ runtimeProvider: "pi" })).toThrow("changed after preflight");
    expect(() => assertRuntimeModelBrokerCapability(capabilities("none"), "codex")).toThrow("isolated principal");
  });

  test("session continuity depends on generic route and compatibility revisions", () => {
    const first = buildRuntimeModelBrokerAttemptBinding(brokerBinding(), "agent:main:main");
    const refreshed = buildRuntimeModelBrokerAttemptBinding(
      brokerBinding({ leaseId: "grant_b", attemptId: "attempt_b", turnId: "turn_b" }),
      "agent:main:main",
    );
    const changed = buildRuntimeModelBrokerAttemptBinding(
      brokerBinding({ routeRevision: "route_b", compatibilityRevision: "compat_b" }),
      "agent:main:main",
    );
    const params = { runtimeCredential: buildRuntimeCredentialSessionMetadata(first) };
    expect(isRuntimeCredentialSessionCompatible(params, refreshed)).toBe(true);
    expect(isRuntimeCredentialSessionCompatible(params, changed)).toBe(false);
    expect(isRuntimeModelBrokerPhysicalBindingCompatible(brokerBinding(), brokerBinding({ leaseId: "grant_b" }))).toBe(
      true,
    );
    expect(
      isRuntimeModelBrokerPhysicalBindingCompatible(
        brokerBinding(),
        brokerBinding({
          leaseId: "grant_c",
          attemptId: "attempt_c",
          turnId: "turn_c",
          transport: { ...lease().transport, publicHeaders: { "x-public-route": "binding_c" } },
        }),
      ),
    ).toBe(true);
  });

  test("rejects broker-directed advancement outside the pre-effect credential boundary", async () => {
    const broker = {
      id: "test",
      resolveRoute: async () => lease(),
      reportAttempt: async () => ({ recorded: true as const, nextAction: "advance" as const }),
    };
    await expect(
      reportRuntimeModelBrokerAttempt(broker, {
        leaseId: "lease_a",
        attemptId: "attempt_a",
        turnId: "turn_a",
        runtimeId: "runtime_a",
        sessionKey: "agent:main:main",
        outcome: "credential_failed",
        effectState: "tool_started",
      }),
    ).rejects.toThrow("effect-safe credential boundary");
  });
});

function brokerBinding(overrides: Partial<RuntimeModelBrokerRouteLease> = {}) {
  return buildRuntimeModelBrokerBinding({
    selection: { brokerId: "hub", profileRef: "profile_main", required: true },
    lease: { ...lease(), ...overrides },
    runtimeCapabilities: capabilities("cgroup"),
    expectedRuntimeProvider: "codex",
  });
}

function lease(): RuntimeModelBrokerRouteLease {
  return {
    version: 1,
    brokerId: "hub",
    leaseId: "grant_a",
    attemptId: "attempt_a",
    turnId: "turn_a",
    runtimeId: "runtime_a",
    runtimeProvider: "codex",
    model: "gpt-5.4",
    routeRevision: "route_a",
    compatibilityRevision: "compat_a",
    expiresAt: Date.now() + 60_000,
    transport: {
      scheme: "local-http-forwarder-v1",
      protocol: "openai-responses",
      origin: "http://127.0.0.1:43123",
      path: "/v1/responses",
      publicHeaders: { "x-public-route": "binding_a" },
    },
  };
}

function capabilities(isolation: "none" | "uid" | "cgroup" | "one-shot-capability"): RuntimeCapabilities {
  return {
    modelBroker: { protocols: ["openai-responses"], principalIsolation: isolation },
  } as unknown as RuntimeCapabilities;
}
