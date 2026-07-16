import { describe, expect, it } from "bun:test";
import { parseRuntimeTargetPolicy, resolveRuntimeTargetPolicy } from "./target-policy-config.js";

const targetPolicy = (id: string) => ({
  id,
  strategy: "ordered",
  maxAttemptsPerTarget: 1,
  targets: [{ id: `${id}-target`, runtimeProvider: "synthetic", model: "opaque/model" }],
});

describe("runtime target policy configuration", () => {
  it("resolves deterministic scope precedence with provenance", () => {
    expect(
      resolveRuntimeTargetPolicy({
        sessionOverride: targetPolicy("session"),
        taskProfilePolicy: targetPolicy("task"),
        taskProfileId: "research",
        agentDefaults: { runtimeTargetPolicy: targetPolicy("agent") },
        agentId: "worker",
      }),
    ).toMatchObject({
      policy: { id: "session" },
      source: "session_override",
      provenance: "session.runtimeTargetPolicy",
    });
    expect(
      resolveRuntimeTargetPolicy({
        taskProfilePolicy: targetPolicy("task"),
        taskProfileId: "research",
        agentDefaults: { runtimeTargetPolicy: targetPolicy("agent") },
      }),
    ).toMatchObject({ policy: { id: "task" }, source: "task_profile", provenance: "task-profile:research" });
    expect(
      resolveRuntimeTargetPolicy({ agentDefaults: { runtimeTargetPolicy: targetPolicy("agent") }, agentId: "worker" }),
    ).toMatchObject({
      policy: { id: "agent" },
      source: "agent_default",
      provenance: "agent:worker.defaults.runtimeTargetPolicy",
    });
  });

  it("keeps current single-target behavior when no policy exists", () => {
    expect(resolveRuntimeTargetPolicy({})).toEqual({ policy: null, source: "none", provenance: null });
  });

  it("defaults credential recovery to one bounded same-target retry", () => {
    expect(resolveRuntimeTargetPolicy({ sessionOverride: targetPolicy("credential") }).policy).toMatchObject({
      maxAttemptsPerTarget: 1,
      maxCredentialRecoveryAttemptsPerTarget: 1,
    });
    expect(
      resolveRuntimeTargetPolicy({
        sessionOverride: { ...targetPolicy("disabled"), maxCredentialRecoveryAttemptsPerTarget: 0 },
      }).policy,
    ).toMatchObject({ maxCredentialRecoveryAttemptsPerTarget: 0 });
  });

  it("materializes reusable model presets and typed credential requirements once", () => {
    const policy = parseRuntimeTargetPolicy(
      {
        id: "composed",
        strategy: "ordered",
        targets: [
          {
            id: "primary",
            modelPresetId: "fast-sonnet",
            credentialRequirements: {
              credentialIds: ["rcred_primary"],
              authMethods: ["oauth"],
              sessionCompatibilityKey: "account-primary",
              requireManaged: true,
            },
          },
        ],
      },
      {
        lookupModelPreset: () => ({
          id: "fast-sonnet",
          provider: "claude",
          model: "sonnet",
          description: null,
          enabled: true,
          version: 3,
          createdAt: 1,
          updatedAt: 2,
        }),
      },
    );

    expect(policy.targets[0]).toEqual({
      id: "primary",
      runtimeProvider: "claude",
      model: "sonnet",
      modelPreset: { id: "fast-sonnet", version: 3 },
      credentialRequirements: {
        credentialIds: ["rcred_primary"],
        authMethods: ["oauth"],
        sessionCompatibilityKey: "account-primary",
        requireManaged: true,
      },
    });
  });

  it("rejects duplicate model configuration and obsolete no-op credential fields", () => {
    expect(() =>
      parseRuntimeTargetPolicy({
        ...targetPolicy("duplicate-model"),
        targets: [
          {
            id: "primary",
            modelPresetId: "fast-sonnet",
            runtimeProvider: "claude",
            model: "sonnet",
          },
        ],
      }),
    ).toThrow("either modelPresetId or runtimeProvider + model");
    expect(() =>
      parseRuntimeTargetPolicy({
        ...targetPolicy("obsolete-credential"),
        targets: [
          {
            id: "primary",
            runtimeProvider: "claude",
            model: "sonnet",
            credentialScope: "unused",
          },
        ],
      }),
    ).toThrow("obsolete credential fields");
  });

  it("rejects unknown policy, target, and credential fields instead of failing open", () => {
    expect(() =>
      parseRuntimeTargetPolicy({
        ...targetPolicy("unknown-policy"),
        maxAttempsPerTarget: 2,
      }),
    ).toThrow("unknown field");
    expect(() =>
      parseRuntimeTargetPolicy({
        ...targetPolicy("unknown-target"),
        targets: [
          {
            id: "primary",
            runtimeProvider: "claude",
            model: "sonnet",
            requiredCapabilites: ["supportsSessionResume"],
          },
        ],
      }),
    ).toThrow("unknown field");
    expect(() =>
      parseRuntimeTargetPolicy({
        ...targetPolicy("unknown-credential"),
        targets: [
          {
            id: "primary",
            runtimeProvider: "claude",
            model: "sonnet",
            credentialRequirements: { requireManged: true },
          },
        ],
      }),
    ).toThrow("unknown field");
    expect(() =>
      parseRuntimeTargetPolicy({
        ...targetPolicy("empty-credential"),
        targets: [
          {
            id: "primary",
            runtimeProvider: "claude",
            model: "sonnet",
            credentialRequirements: { requireManaged: false },
          },
        ],
      }),
    ).toThrow("enforceable managed credential constraint");
  });

  it("rejects malformed policy before runtime launch", () => {
    expect(() =>
      resolveRuntimeTargetPolicy({ sessionOverride: { id: "bad", strategy: "ordered", targets: [] } }),
    ).toThrow("non-empty targets");
    expect(() =>
      parseRuntimeTargetPolicy({
        ...targetPolicy("invalid-options"),
        targets: [
          {
            id: "primary",
            runtimeProvider: "claude",
            model: "sonnet",
            effort: "xhighest",
            thinking: "sometimes",
          },
        ],
      }),
    ).toThrow("Invalid runtime effort");
    expect(() =>
      parseRuntimeTargetPolicy({
        ...targetPolicy("invalid-thinking"),
        targets: [
          {
            id: "primary",
            runtimeProvider: "claude",
            model: "sonnet",
            effort: "high",
            thinking: "sometimes",
          },
        ],
      }),
    ).toThrow("Invalid runtime thinking");
  });

  it("rejects duplicate target ids during parsing", () => {
    expect(() =>
      parseRuntimeTargetPolicy({
        ...targetPolicy("duplicate-targets"),
        targets: [
          { id: "same", runtimeProvider: "codex", model: "gpt-5" },
          { id: "same", runtimeProvider: "claude", model: "sonnet" },
        ],
      }),
    ).toThrow("Duplicate runtime target id: same");
  });
});
