import { describe, expect, it, mock } from "bun:test";
import { Command as CommanderCommand } from "commander";
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
import { registerCommands } from "../registry.js";
import { extractTools } from "../tools-export.js";

mock.module("../../nats.js", () => ({
  nats: { emit: mock(async () => {}) },
}));

const {
  buildRuntimeTargetPolicyDefaults,
  parseRuntimeTargetPolicyJson,
  reorderRuntimeTargetPolicy,
  RuntimeTargetsCommands,
} = await import("./runtime-targets.js");

describe("runtime targets CLI", () => {
  it("is discoverable as nested CLI help and typed tools", () => {
    const program = new CommanderCommand();
    registerCommands(program, [RuntimeTargetsCommands]);
    const runtime = program.commands.find((entry) => entry.name() === "runtime");
    const targets = runtime?.commands.find((entry) => entry.name() === "targets");
    const setCommand = targets?.commands.find((entry) => entry.name() === "set");
    let setHelp = "";
    setCommand?.configureOutput({ writeOut: (value) => (setHelp += value) });
    setCommand?.outputHelp();

    expect(targets?.commands.map((entry) => entry.name())).toEqual(["show", "explain", "set", "clear"]);
    expect(targets?.helpInformation()).toContain("show");
    expect(setHelp).toContain("--order");
    expect(setHelp).toContain("RULES HARD");
    expect(extractTools([RuntimeTargetsCommands]).map((tool) => tool.name)).toEqual([
      "runtime_targets_show",
      "runtime_targets_explain",
      "runtime_targets_set",
      "runtime_targets_clear",
    ]);
  });

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

  it("publishes typed show, set and clear commands with JSON output", () => {
    const commands = getCommandsMetadata(RuntimeTargetsCommands);
    for (const name of ["show", "set", "clear"]) {
      const command = commands.find((entry) => entry.name === name);
      expect(command && getReturnsMetadata(RuntimeTargetsCommands).get(command.method)).toBeDefined();
      expect(command && getCommandAccessMetadata(RuntimeTargetsCommands).get(command.method)).toMatchObject({
        kind: name === "show" ? "read" : "mutate",
        risk: name === "show" ? "low" : "medium",
      });
      expect(
        command &&
          getOptionsMetadata(new RuntimeTargetsCommands(), command.method).some((option) => option.flags === "--json"),
      ).toBe(true);
    }
    const set = commands.find((entry) => entry.name === "set");
    expect(
      set &&
        getOptionsMetadata(new RuntimeTargetsCommands(), set.method).some(
          (option) => option.flags === "--order <target-ids>",
        ),
    ).toBe(true);
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

  it("reorders by an exact stable-id permutation without changing policy or target data", () => {
    const policy = parseRuntimeTargetPolicyJson(
      JSON.stringify({
        id: "ordered-policy",
        strategy: "ordered",
        targets: [
          { id: "claude-main", runtimeProvider: "claude", model: "sonnet", effort: "high" },
          {
            id: "pi-main",
            runtimeProvider: "pi",
            model: "kimi-coding/k2p6",
            credentialRequirements: { credentialIds: ["rcred_pi"], requireManaged: true },
          },
          { id: "codex-live", runtimeProvider: "codex", model: "gpt-5.6-sol", thinking: "normal" },
        ],
        maxAttemptsPerTarget: 2,
        maxCredentialRecoveryAttemptsPerTarget: 1,
        cooldownMs: 45_000,
        circuitBreakerThreshold: 4,
      }),
    );

    const reordered = reorderRuntimeTargetPolicy(policy, "codex-live, claude-main,pi-main");
    expect(reordered.targets.map((target) => target.id)).toEqual(["codex-live", "claude-main", "pi-main"]);
    expect({ ...reordered, targets: [...reordered.targets].sort((a, b) => a.id.localeCompare(b.id)) }).toEqual({
      ...policy,
      targets: [...policy.targets].sort((a, b) => a.id.localeCompare(b.id)),
    });
    expect(policy.targets.map((target) => target.id)).toEqual(["claude-main", "pi-main", "codex-live"]);
  });

  it("rejects partial, duplicate, unknown and empty reorder input", () => {
    const policy = parseRuntimeTargetPolicyJson(
      JSON.stringify({
        id: "strict-order",
        strategy: "ordered",
        targets: [
          { id: "a", runtimeProvider: "claude", model: "sonnet" },
          { id: "b", runtimeProvider: "pi", model: "pi-model" },
          { id: "c", runtimeProvider: "codex", model: "gpt-5" },
        ],
        maxAttemptsPerTarget: 1,
      }),
    );

    expect(() => reorderRuntimeTargetPolicy(policy, "a,a,c")).toThrow("duplicate target ids");
    expect(() => reorderRuntimeTargetPolicy(policy, "a,b")).toThrow("missing: c");
    expect(() => reorderRuntimeTargetPolicy(policy, "a,b,x")).toThrow("unknown: x");
    expect(() => reorderRuntimeTargetPolicy(policy, "a,,c")).toThrow("non-empty stable target ids");
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
      expect(commands.show("main")).toMatchObject({
        enabled: true,
        order: ["primary"],
        policy: { id: "cli-persisted-policy" },
      });
      commands.clear("main");
      expect(getAgent("main")?.defaults).toEqual({ locale: "pt-BR", heartbeat: { enabled: true } });
      expect(commands.show("main")).toMatchObject({ enabled: false, order: [], policy: null });
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("reorders persisted targets repeatedly and rejects unsafe mutation inputs without changing defaults", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-targets-reorder-");
    try {
      configStore.refresh();
      const commands = new RuntimeTargetsCommands();
      commands.set(
        "main",
        JSON.stringify({
          id: "reorder-live",
          strategy: "ordered",
          targets: [
            { id: "claude-main", runtimeProvider: "claude", model: "sonnet" },
            { id: "pi-main", runtimeProvider: "pi", model: "pi-model" },
            { id: "codex-live", runtimeProvider: "codex", model: "gpt-5" },
          ],
          maxAttemptsPerTarget: 1,
          cooldownMs: 30_000,
        }),
      );
      const originalDefaults = structuredClone(getAgent("main")?.defaults);

      expect(commands.set("main", undefined, "codex-live,claude-main,pi-main")).toMatchObject({
        changed: true,
        policy: { id: "reorder-live", cooldownMs: 30_000 },
      });
      expect(commands.show("main").order).toEqual(["codex-live", "claude-main", "pi-main"]);
      expect(commands.set("main", undefined, "claude-main,pi-main,codex-live").changed).toBe(true);
      expect(getAgent("main")?.defaults).toEqual(originalDefaults);

      const invalidCalls = [
        () => commands.set("main", undefined, "claude-main,pi-main"),
        () => commands.set("main", undefined, "claude-main,pi-main,unknown"),
        () => commands.set("main", undefined, "claude-main,claude-main,codex-live"),
        () => commands.set("main"),
        () =>
          commands.set("main", JSON.stringify(originalDefaults?.runtimeTargetPolicy), "claude-main,pi-main,codex-live"),
      ];
      for (const invoke of invalidCalls) {
        const before = structuredClone(getAgent("main")?.defaults);
        expect(() => runWithContext({}, invoke)).toThrow();
        expect(getAgent("main")?.defaults).toEqual(before);
      }
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("rejects reorder when no policy exists", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-targets-reorder-empty-");
    try {
      configStore.refresh();
      const commands = new RuntimeTargetsCommands();
      expect(() => runWithContext({}, () => commands.set("main", undefined, "codex-live"))).toThrow(
        "Create one with --policy-json",
      );
      expect(getAgent("main")?.defaults?.runtimeTargetPolicy).toBeUndefined();
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });
});
