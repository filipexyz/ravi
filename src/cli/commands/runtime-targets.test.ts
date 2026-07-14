import { describe, expect, it, mock } from "bun:test";
import { configStore } from "../../config-store.js";
import { getDb } from "../../router/router-db.js";
import { getAgent } from "../../router/config.js";
import { dbUpdateAgent } from "../../router/router-db.js";
import { createRuntimeCredential } from "../../runtime/credential-store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  getCommandAccessMetadata,
  getCommandsMetadata,
  getGroupMetadata,
  getOptionsMetadata,
  getReturnsMetadata,
} from "../decorators.js";
import { runWithContext } from "../context.js";

mock.module("../../nats.js", () => ({
  nats: { emit: mock(async () => {}) },
}));

const { buildRuntimeTargetPolicyDefaults, parseRuntimeTargetPolicyJson, RuntimeTargetsCommands } = await import(
  "./runtime-targets.js"
);

describe("runtime targets CLI", () => {
  it("publishes an agent-first typed explain command", () => {
    const command = getCommandsMetadata(RuntimeTargetsCommands).find((entry) => entry.name === "explain");
    expect(getGroupMetadata(RuntimeTargetsCommands)?.name).toBe("runtime.targets");
    expect(command?.description).toContain("without executing");
    const options = command ? getOptionsMetadata(new RuntimeTargetsCommands(), command.method) : [];
    expect(options.some((option) => option.flags === "--agent <id>" || option.flags === "--agent-id <id>")).toBe(true);
    expect(options.some((option) => option.flags === "--task-profile <id>")).toBe(true);
    expect(options.some((option) => option.flags === "--session-policy-json <json>")).toBe(true);
    expect(command && getReturnsMetadata(RuntimeTargetsCommands).get(command.method)).toBeDefined();
    expect(command && getCommandAccessMetadata(RuntimeTargetsCommands).get(command.method)).toMatchObject({
      kind: "read",
      risk: "low",
    });
  });

  it("explains session-policy provenance and rejects targets whose managed secret cannot resolve", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-targets-explain-");
    try {
      configStore.refresh();
      dbUpdateAgent("main", {
        defaults: {
          runtimePermissions: {
            profile: "full-access",
            capabilities: [{ permission: "use", objectType: "runtime.target", objectId: "*" }],
          },
        },
      });
      configStore.refresh();
      createRuntimeCredential({
        id: "rcred_explain_missing",
        label: "Explain missing",
        runtimeProvider: "codex",
        upstreamProvider: "openai",
        bindings: [
          {
            sourceKind: "env",
            targetKind: "env",
            targetName: "OPENAI_API_KEY",
            secretRef: "env:RAVI_EXPLAIN_MISSING_KEY",
            sourceHint: "RAVI_EXPLAIN_MISSING_KEY",
            sensitive: true,
            remoteForward: false,
          },
        ],
      });
      const commands = new RuntimeTargetsCommands();
      const result = commands.explain(
        "main",
        undefined,
        JSON.stringify({
          id: "session-explain",
          strategy: "ordered",
          targets: [
            {
              id: "managed",
              runtimeProvider: "codex",
              model: "gpt-5",
              credentialRequirements: { credentialIds: ["rcred_explain_missing"], requireManaged: true },
            },
          ],
          maxAttemptsPerTarget: 1,
        }),
      );

      expect(result.source).toBe("session_override");
      expect(result.provenance).toBe("session.runtimeTargetPolicy");
      expect(result.selectedTarget).toBeNull();
      expect(result.rejected).toContainEqual({
        targetId: "managed",
        reason: "credential_unavailable",
        detail: "Explain missing: missing_secret:env:RAVI_EXPLAIN_[redacted]",
      });
      expect(
        getDb().prepare("SELECT COUNT(*) AS count FROM runtime_credential_attempts").get() as { count: number },
      ).toEqual({ count: 0 });
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("publishes typed set and clear mutations with JSON output", () => {
    const commands = getCommandsMetadata(RuntimeTargetsCommands);
    for (const name of ["set", "clear"]) {
      const command = commands.find((entry) => entry.name === name);
      expect(command && getReturnsMetadata(RuntimeTargetsCommands).get(command.method)).toBeDefined();
      expect(command && getCommandAccessMetadata(RuntimeTargetsCommands).get(command.method)).toMatchObject({
        kind: "mutate",
        risk: "medium",
      });
      expect(
        command &&
          getOptionsMetadata(new RuntimeTargetsCommands(), command.method).some((option) => option.flags === "--json"),
      ).toBe(true);
    }
  });

  it("sets and clears only runtimeTargetPolicy while preserving unrelated defaults", () => {
    const policy = parseRuntimeTargetPolicyJson(
      JSON.stringify({
        id: "safe-failover",
        strategy: "ordered",
        targets: [{ id: "primary", runtimeProvider: "codex", model: "gpt-5" }],
        maxAttemptsPerTarget: 1,
      }),
    );
    const original = { heartbeat: { enabled: true }, locale: "pt-BR" };
    const configured = buildRuntimeTargetPolicyDefaults(original, policy);
    expect(configured).toMatchObject({ heartbeat: { enabled: true }, locale: "pt-BR", runtimeTargetPolicy: policy });
    expect(original).toEqual({ heartbeat: { enabled: true }, locale: "pt-BR" });
    expect(buildRuntimeTargetPolicyDefaults(configured, null)).toEqual(original);
  });

  it("rejects malformed or unknown policy fields before mutation", () => {
    expect(() => parseRuntimeTargetPolicyJson("not-json")).toThrow("valid JSON");
    expect(() =>
      parseRuntimeTargetPolicyJson(
        JSON.stringify({
          id: "unsafe",
          strategy: "ordered",
          targets: [{ id: "primary", runtimeProvider: "codex", model: "gpt-5" }],
          maxAttemptsPerTarget: 1,
          typoField: true,
        }),
      ),
    ).toThrow("unknown field");
  });

  it("rejects duplicate ids without changing persisted configuration", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-targets-duplicate-");
    try {
      configStore.refresh();
      const original = { locale: "pt-BR", runtimeTargetPolicy: { id: "existing" } };
      dbUpdateAgent("main", { defaults: original });
      configStore.refresh();
      const commands = new RuntimeTargetsCommands();
      expect(() =>
        runWithContext({}, () =>
          commands.set(
            "main",
            JSON.stringify({
              id: "duplicate",
              strategy: "ordered",
              targets: [
                { id: "same", runtimeProvider: "codex", model: "gpt-5" },
                { id: "same", runtimeProvider: "claude", model: "sonnet" },
              ],
              maxAttemptsPerTarget: 1,
            }),
          ),
        ),
      ).toThrow("Duplicate runtime target id: same");
      expect(getAgent("main")?.defaults).toEqual(original);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("persists set and clear without overwriting other agent defaults", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-targets-cli-");
    try {
      configStore.refresh();
      dbUpdateAgent("main", { defaults: { locale: "pt-BR", heartbeat: { enabled: true } } });
      configStore.refresh();
      const commands = new RuntimeTargetsCommands();
      const result = commands.set(
        "main",
        JSON.stringify({
          id: "cli-persisted-policy",
          strategy: "ordered",
          targets: [{ id: "primary", runtimeProvider: "codex", model: "gpt-5" }],
          maxAttemptsPerTarget: 1,
        }),
      );
      expect(result.changed).toBe(true);
      expect(getAgent("main")?.defaults).toMatchObject({
        locale: "pt-BR",
        heartbeat: { enabled: true },
        runtimeTargetPolicy: { id: "cli-persisted-policy" },
      });
      commands.clear("main");
      expect(getAgent("main")?.defaults).toEqual({ locale: "pt-BR", heartbeat: { enabled: true } });
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });
});
