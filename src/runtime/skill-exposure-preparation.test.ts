import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClaudeRuntimeProvider } from "./claude-provider.js";
import { prepareSnapshotForProvider } from "./skill-exposure-preparation.js";
import { assertObservedSkillExposure } from "./skill-exposure-contract.js";
import type { SkillExposureCapabilities } from "./skill-exposure-contract.js";
import type { SkillPolicySnapshot } from "./skill-policy.js";
import type { RuntimePrepareSessionRequest, SessionRuntimeProvider } from "./types.js";

const capabilities: SkillExposureCapabilities = {
  contractVersion: 1,
  modelCallFence: { contractVersion: 1, guarantee: "before-every-model-call" },
  modes: ["native-restricted"],
  nativeDiscovery: { user: "disabled", project: "disabled", plugins: "restricted" },
  contextUpdate: "rebuild",
};

function snapshot(): SkillPolicySnapshot {
  return {
    contractVersion: 1,
    id: "a".repeat(64),
    status: "ready",
    scope: { agentId: "restricted", executionId: "test", contextKey: "test-context" },
    revisions: { policy: "1", catalog: "1", permissions: "1", toolSurface: "1" },
    skills: [
      {
        id: "test-plugin:permitted",
        aliases: ["permitted"],
        name: "permitted",
        resource: {
          path: "SKILL.md",
          files: [{ path: "SKILL.md", content: "---\nname: permitted\ndescription: Allowed\n---\nAllowed body\n" }],
        },
        requirements: { kind: "none" },
      },
    ],
    provenance: { "test-plugin:permitted": ["grant"] },
    diagnostics: [],
  };
}

function provider(onPrepare: (input: RuntimePrepareSessionRequest) => readonly string[]): SessionRuntimeProvider {
  return {
    id: "future-adapter",
    getCapabilities: () => ({ ...createClaudeRuntimeProvider().getCapabilities(), skillExposure: capabilities }),
    prepareSession(input) {
      return {
        skillExposure: {
          snapshotId: input.skillPolicy?.id ?? "missing",
          mode: "native-restricted",
          preparedIds: onPrepare(input),
        },
      };
    },
    startSession() {
      throw new Error("No model may be called during preparation tests");
    },
  };
}

describe("central skill preparation", () => {
  test("prepares a future adapter from only immutable authorized resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-preparation-"));
    let observedFiles: string[] = [];
    const result = await prepareSnapshotForProvider({
      provider: provider((input) => {
        observedFiles = (input.plugins ?? []).flatMap((plugin) => readdirSync(join(plugin.path, "skills")));
        return ["test-plugin:permitted"];
      }),
      snapshot: snapshot(),
      cwd: root,
      materializationRoot: join(root, "prepared"),
    });
    expect(observedFiles).toEqual(["permitted"]);
    expect(result?.providerBootstrap.skillExposure?.preparedIds).toEqual(["test-plugin:permitted"]);
  });

  test("rejects unsupported adapters before creating materialized files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-unsupported-preparation-"));
    const adapter = provider(() => []);
    adapter.getCapabilities = () => ({ ...createClaudeRuntimeProvider().getCapabilities(), skillExposure: undefined });
    await expect(
      prepareSnapshotForProvider({
        provider: adapter,
        snapshot: snapshot(),
        cwd: root,
        materializationRoot: join(root, "prepared"),
      }),
    ).rejects.toThrow("skill exposure contract");
    expect(existsSync(join(root, "prepared"))).toBe(false);
  });

  test("rejects a provider that prepares more skills than authorized", async () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-expanded-preparation-"));
    await expect(
      prepareSnapshotForProvider({
        provider: provider(() => ["test-plugin:permitted", "test-plugin:private"]),
        snapshot: snapshot(),
        cwd: root,
        materializationRoot: join(root, "prepared"),
      }),
    ).rejects.toThrow("authorized snapshot");
  });

  test("observed discovery cannot silently add skills or duplicate their announcement", () => {
    const base = { snapshotId: snapshot().id, mode: "native-restricted", evidence: "native-discovery" } satisfies Pick<
      Parameters<typeof assertObservedSkillExposure>[1],
      "snapshotId" | "mode" | "evidence"
    >;
    expect(() =>
      assertObservedSkillExposure(snapshot(), {
        ...base,
        advertisedIds: ["test-plugin:permitted"],
        discoverableIds: ["test-plugin:permitted", "private"],
      }),
    ).toThrow("authorized snapshot");
    expect(() =>
      assertObservedSkillExposure(snapshot(), {
        ...base,
        advertisedIds: ["test-plugin:permitted", "test-plugin:permitted"],
        discoverableIds: ["test-plugin:permitted"],
      }),
    ).toThrow("duplicate");
  });
});
