import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import capturedFixture from "../../tests/fixtures/jarvis-skill-migration-2026-09-10.json" with { type: "json" };
import { materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import { dbCreateAgent, dbUpdateAgent, dbUpsertSkillGrant } from "../router/router-db.js";
import type { ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { assertObservedSkillExposure } from "./skill-exposure-contract.js";
import { materializeSkillSnapshot } from "./skill-materialization.js";
import { resolveRuntimeSkillPolicy } from "./skill-policy-runtime.js";
import type { SkillPolicySnapshot } from "./skill-policy.js";
import type { RuntimePlugin } from "./types.js";

const capabilitySchema = z.object({ permission: z.string(), objectType: z.string(), objectId: z.string() });
const fixture = z
  .object({
    agent: z.object({
      id: z.string(),
      runtimePermissions: z.object({
        profile: z.enum(["bootstrap", "full-access"]),
        capabilities: z.array(capabilitySchema),
      }),
    }),
    grants: z.array(z.string()),
    catalog: z.array(
      z.object({
        name: z.string(),
        directory: z.string(),
        source: z.string(),
        pluginName: z.string().optional(),
        requirements: z.array(z.string()),
      }),
    ),
  })
  .parse(capturedFixture);

// Hand-checked from the captured identity graph: these migrated internal skills
// have neither a missing requirement nor a colliding installed alias.
// Pages is capability-derived even though it has no explicit grant.
const expectedVisibleIds = ["ravi-system:apps", "ravi-system:commands", "ravi-system:pages", "ravi-system:skill-gates"];
let stateDir: string;
let plugins: RuntimePlugin[];
let snapshot: SkillPolicySnapshot;

function resolve(availableCapabilities: readonly string[] = ["exec.shell", "fs.read"]): SkillPolicySnapshot {
  // This is a simulated executor context, not a claim about an active VPS turn.
  const context: ContextRecord = {
    agentId: fixture.agent.id,
    contextId: "migration-fixture",
    contextKey: "migration-fixture-private",
    kind: "agent-runtime",
    capabilities: materializeSubjectCapabilities("agent", fixture.agent.id),
    createdAt: 0,
  };
  return resolveRuntimeSkillPolicy({
    agentId: fixture.agent.id,
    executionId: "migration-fixture",
    contextKey: context.contextKey,
    cwd: stateDir,
    context,
    plugins,
    runtimeCapabilities: { tools: { availableCapabilities }, dynamicTools: { mode: "none" } },
  });
}

describe("Jarvis migration from sanitized VPS metadata, not the historical restricted incident", () => {
  beforeAll(async () => {
    stateDir = await createIsolatedRaviState("ravi-jarvis-migration-");
    dbCreateAgent({ id: fixture.agent.id, cwd: stateDir });
    dbUpdateAgent(fixture.agent.id, { defaults: { runtimePermissions: fixture.agent.runtimePermissions } });
    for (const skillName of fixture.grants) dbUpsertSkillGrant({ agentId: fixture.agent.id, skillName });
    const pluginPaths = new Map<string, string>();
    for (const skill of fixture.catalog.filter((entry) => !entry.source.startsWith("catalog:"))) {
      let root: string;
      if (skill.pluginName) {
        const pluginPath = join(stateDir, "source-plugins", skill.pluginName);
        pluginPaths.set(skill.pluginName, pluginPath);
        root = join(pluginPath, "skills");
        mkdirSync(join(pluginPath, ".claude-plugin"), { recursive: true });
        writeFileSync(join(pluginPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: skill.pluginName }));
      } else {
        root = join(stateDir, `.${skill.source.split(":").at(-1)}`, "skills");
      }
      const path = join(root, skill.directory, "SKILL.md");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        `---\nname: ${skill.name}\n${skill.requirements.join("\n")}\n---\nSanitized fixture; no remote skill body.\n`,
      );
    }
    plugins = [...pluginPaths.values()].map((path) => ({ type: "local", path }));
    snapshot = resolve();
  }, 30000);
  afterAll(async () => cleanupIsolatedRaviState(stateDir));

  test("the captured profile materializes wildcard authority plus the verified bootstrap groups", () => {
    const capabilities = materializeSubjectCapabilities("agent", fixture.agent.id);
    expect(
      capabilities.some(
        (capability) =>
          capability.permission === "admin" && capability.objectType === "system" && capability.objectId === "*",
      ),
    ).toBe(true);
    expect(
      [
        ...new Set(
          capabilities
            .filter((capability) => capability.permission === "execute" && capability.objectType === "group")
            .map((capability) => capability.objectId),
        ),
      ].sort(),
    ).toEqual(["*", "doctor", "self", "sessions", "skills", "specs", "tasks"]);
  });

  test("full-access and all captured grants do not bypass missing requirements or colliding identities", () => {
    expect(snapshot.skills.map((skill) => skill.id)).toEqual(expectedVisibleIds);
    expect(snapshot.diagnostics).toContainEqual({
      skillId: "ravi-user-skills:agent-browser",
      code: "missing-requirements",
    });
    for (const name of ["sessions", "tasks", "specs", "skill-creator"]) {
      expect(snapshot.diagnostics).toContainEqual({ skillId: `ravi-system:${name}`, code: "ambiguous-identity" });
    }
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "unknown-selection")).toBe(false);
  });

  test("the actual materialized file inventory equals the authorized set and detects an injected omitted skill", () => {
    const prepared = materializeSkillSnapshot(snapshot, join(stateDir, "materialized"));
    const discoveredNames = prepared.plugins.flatMap((plugin) =>
      readdirSync(join(plugin.path, "skills")).map((directory) => {
        const content = readFileSync(join(plugin.path, "skills", directory, "SKILL.md"), "utf8");
        return /^name:\s*(.+)$/m.exec(content)?.[1]?.trim();
      }),
    );
    const discoveredIds = discoveredNames
      .map((name) => {
        const skill = snapshot.skills.find((candidate) => candidate.name === name);
        if (!skill) throw new Error("Materialized an unauthorized skill.");
        return skill.id;
      })
      .sort();
    expect(discoveredIds).toEqual(expectedVisibleIds);
    const exposure = {
      snapshotId: snapshot.id,
      mode: "native-restricted",
      advertisedIds: discoveredIds,
      discoverableIds: discoveredIds,
      evidence: "native-discovery",
    } satisfies Parameters<typeof assertObservedSkillExposure>[1];
    expect(() => assertObservedSkillExposure(snapshot, exposure)).not.toThrow();
    expect(() =>
      assertObservedSkillExposure(snapshot, {
        ...exposure,
        discoverableIds: [...discoveredIds, "ravi-system:sessions"],
      }),
    ).toThrow();
  });

  test("removing the declared tool surface produces an empty snapshot, never a grant-based fallback", () => {
    const unavailable = resolve([]);
    expect(unavailable.skills).toEqual([]);
    expect(unavailable.status).toBe("empty");
    expect(() =>
      assertObservedSkillExposure(unavailable, {
        snapshotId: unavailable.id,
        mode: "native-restricted",
        advertisedIds: expectedVisibleIds,
        discoverableIds: expectedVisibleIds,
        evidence: "native-discovery",
      }),
    ).toThrow();
  });
});
