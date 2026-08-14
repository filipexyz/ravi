import { describe, expect, test } from "bun:test";
import {
  assertRuntimeIntelligenceProxyCapability,
  buildRuntimeIntelligenceAttemptBinding,
  buildRuntimeIntelligenceProxyBinding,
  isRuntimeIntelligenceProxyRequired,
  isRuntimeIntelligencePhysicalBindingCompatible,
  readRuntimeIntelligenceProfileSelection,
  resolveRequiredRuntimeIntelligenceProfileSelection,
  type RuntimeIntelligenceHubGrant,
} from "./intelligence-proxy.js";
import { buildRuntimeCredentialSessionMetadata, isRuntimeCredentialSessionCompatible } from "./credential-resolver.js";
import type { RuntimeCapabilities } from "./types.js";

describe("runtime intelligence proxy contract", () => {
  test("reads a strict ordered connection preference profile", () => {
    expect(
      readRuntimeIntelligenceProfileSelection({
        defaults: { intelligence: { profileId: "profile_main", connectionIds: ["conn_a", "conn_b"] } },
      }),
    ).toEqual({ profileId: "profile_main", connectionIds: ["conn_a", "conn_b"] });
  });

  test("rejects malformed or duplicate profiles instead of falling back", () => {
    expect(() =>
      readRuntimeIntelligenceProfileSelection({
        defaults: { intelligence: { profileId: "profile_main", connectionIds: ["conn_a", "conn_a"] } },
      }),
    ).toThrow("must not contain duplicates");
    expect(() => readRuntimeIntelligenceProfileSelection({ defaults: { intelligence: "conn_a" } })).toThrow(
      "expected an object",
    );
  });

  test("enforces global and agent proxy-required policy", () => {
    expect(isRuntimeIntelligenceProxyRequired({ defaults: null }, "true")).toBe(true);
    expect(isRuntimeIntelligenceProxyRequired({ defaults: { intelligence: { required: true } } }, "false")).toBe(true);
    expect(
      isRuntimeIntelligenceProxyRequired(
        { defaults: { intelligence: { profileId: "profile_main", connectionIds: ["conn_a"] } } },
        undefined,
      ),
    ).toBe(false);
    expect(
      resolveRequiredRuntimeIntelligenceProfileSelection(
        {
          defaults: {
            intelligence: { profileId: "profile_main", connectionIds: ["conn_a"], required: false },
          },
        },
        undefined,
      ),
    ).toBeUndefined();
    expect(() => isRuntimeIntelligenceProxyRequired({ defaults: null }, "sometimes")).toThrow("must be true or false");
    expect(() => resolveRequiredRuntimeIntelligenceProfileSelection({ defaults: null }, "true")).toThrow(
      "no Hub intelligence profile",
    );
    expect(() =>
      resolveRequiredRuntimeIntelligenceProfileSelection({ defaults: { intelligence: { required: true } } }, undefined),
    ).toThrow("no Hub intelligence profile");
  });

  test("builds only from an identityd-authorized Hub grant", () => {
    const grant = hubGrant();
    const result = buildRuntimeIntelligenceProxyBinding({
      selection: { profileId: "profile_main", connectionIds: ["conn_openai_primary"] },
      grant,
      forwarder: localForwarder(),
      runtimeCapabilities: capabilities("cgroup"),
      runtimeProvider: "codex",
      model: "gpt-5.4",
    });
    expect(result).toMatchObject({
      runtimeId: "runtime_a",
      profileId: "profile_main",
      connectionId: "conn_openai_primary",
      protocol: "openai-responses",
      localSigningForwarderBaseUrl: "http://127.0.0.1:43123/v1",
      localSigningForwarderRequestPath: "/v1/responses",
      bindingHandle: "binding_openai_primary",
    });
    const attempt = buildRuntimeIntelligenceAttemptBinding(result, "agent:main:main");
    expect(attempt).toMatchObject({
      attemptId: "attempt_runtime_a_1",
      connectionId: "conn_openai_primary",
      profileId: "profile_main",
      authMethod: "hub-proxy",
      bindings: [],
    });
    expect("authProfileRef" in attempt).toBe(false);
    expect(JSON.stringify(result)).not.toContain("token");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("never treats local preferences as Hub membership", () => {
    expect(() =>
      buildRuntimeIntelligenceProxyBinding({
        selection: { profileId: "profile_main", connectionIds: ["conn_local_preference"] },
        grant: hubGrant(),
        forwarder: localForwarder(),
        runtimeCapabilities: capabilities("uid"),
        runtimeProvider: "codex",
        model: "gpt-5.4",
      }),
    ).toThrow("outside the requested profile preferences");
  });

  test("resumes only across grants for the same authoritative connection revision", () => {
    const first = buildRuntimeIntelligenceAttemptBinding(proxyBinding(), "agent:main:main");
    const refreshed = buildRuntimeIntelligenceAttemptBinding(
      proxyBinding({ grantId: "grant_runtime_a_2", attemptId: "attempt_runtime_a_2" }),
      "agent:main:main",
    );
    const changedRevision = buildRuntimeIntelligenceAttemptBinding(
      proxyBinding({ connectionRevision: "revision_2", sessionCompatibilityKey: "compat_conn_openai_primary_v2" }),
      "agent:main:main",
    );
    const changedForwarder = buildRuntimeIntelligenceAttemptBinding(
      proxyBinding(undefined, { origin: "http://127.0.0.1:43124" }),
      "agent:main:main",
    );
    const params = { runtimeCredential: buildRuntimeCredentialSessionMetadata(first) };

    expect(isRuntimeCredentialSessionCompatible(params, refreshed)).toBe(true);
    expect(isRuntimeCredentialSessionCompatible(params, changedRevision)).toBe(false);
    expect(isRuntimeCredentialSessionCompatible(params, changedForwarder)).toBe(true);
    expect(
      isRuntimeIntelligencePhysicalBindingCompatible(
        proxyBinding(),
        proxyBinding(undefined, { origin: "http://127.0.0.1:43124" }),
      ),
    ).toBe(false);
  });

  test("fails closed while built-in adapters have no isolated provider principal", () => {
    const unsafe = capabilities("none");
    expect(() => assertRuntimeIntelligenceProxyCapability(unsafe, "codex")).toThrow("isolated provider principal");
    expect(() =>
      buildRuntimeIntelligenceProxyBinding({
        selection: { profileId: "profile_main", connectionIds: ["conn_openai_primary"] },
        grant: hubGrant(),
        forwarder: localForwarder(),
        runtimeCapabilities: unsafe,
        runtimeProvider: "codex",
        model: "gpt-5.4",
      }),
    ).toThrow("isolated provider principal");
  });

  test("rejects unsafe Hub origins", () => {
    expect(() =>
      buildRuntimeIntelligenceProxyBinding({
        selection: { profileId: "profile_main", connectionIds: ["conn_openai_primary"] },
        grant: { ...hubGrant(), proxyOrigin: "http://hub.example.com" },
        forwarder: localForwarder(),
        runtimeCapabilities: capabilities("cgroup"),
        runtimeProvider: "codex",
        model: "gpt-5.4",
      }),
    ).toThrow("must use HTTPS");
  });

  test("accepts only an identityd-attested explicit 127.0.0.1 forwarder", () => {
    for (const origin of ["http://localhost:43123", "http://0.0.0.0:43123", "https://127.0.0.1:43123"]) {
      expect(() => proxyBinding(undefined, { origin })).toThrow("explicit 127.0.0.1");
    }
  });
});

function hubGrant(): RuntimeIntelligenceHubGrant {
  return {
    version: 1,
    grantId: "grant_runtime_a_1",
    attemptId: "attempt_runtime_a_1",
    runtimeId: "runtime_a",
    profileId: "profile_main",
    connectionId: "conn_openai_primary",
    connectionRevision: "revision_1",
    sessionCompatibilityKey: "compat_conn_openai_primary_v1",
    runtimeProvider: "codex",
    upstreamProvider: "openai",
    model: "gpt-5.4",
    proxyOrigin: "https://hub.example.com",
    audience: "ravi-hub-intelligence",
    expiresAt: Date.now() + 60_000,
  };
}

function localForwarder(overrides: Partial<ReturnType<typeof localForwarderBase>> = {}) {
  return { ...localForwarderBase(), ...overrides };
}

function localForwarderBase() {
  return {
    scheme: "identityd-signing-forwarder-v1" as const,
    verified: true as const,
    bindingHandle: "binding_openai_primary",
    origin: "http://127.0.0.1:43123",
  };
}

function proxyBinding(
  grantOverrides: Partial<RuntimeIntelligenceHubGrant> | undefined = undefined,
  forwarderOverrides: Partial<ReturnType<typeof localForwarderBase>> = {},
) {
  return buildRuntimeIntelligenceProxyBinding({
    selection: { profileId: "profile_main", connectionIds: ["conn_openai_primary"] },
    grant: { ...hubGrant(), ...(grantOverrides ?? {}) },
    forwarder: localForwarder(forwarderOverrides),
    runtimeCapabilities: capabilities("cgroup"),
    runtimeProvider: "codex",
    model: "gpt-5.4",
  });
}

function capabilities(isolation: "none" | "uid" | "cgroup" | "one-shot-capability"): RuntimeCapabilities {
  return {
    intelligenceProxy: {
      transport: {
        protocol: "openai-responses",
        basePath: "/v1",
        endpointPath: "/v1/responses",
      },
      localSigningForwarder: true,
      providerPrincipalIsolation: isolation,
    },
  } as unknown as RuntimeCapabilities;
}
