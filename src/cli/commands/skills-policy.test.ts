import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  dbCreateAgent,
  dbListSkillGrantsForAgent,
  dbUpdateContextRuntimeState,
  dbUpsertSkillGrant,
} from "../../router/router-db.js";
import type { ContextRecord } from "../../router/router-db.js";
import { createRuntimeContext } from "../../runtime/context-registry.js";
import { buildSkillPolicyContextBinding } from "../../runtime/skill-policy-runtime.js";
import * as skillManager from "../../skills/manager.js";
import * as codexSkills from "../../plugins/codex-skills.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { runWithContext } from "../context.js";
import { ContractError } from "../agent-contract.js";
import { SkillsCommands } from "./skills.js";
import { skillInspectReturnSchema } from "./operational-return-schemas.js";

let stateDir: string;
let sourcePath: string;
let installedLookup: ReturnType<typeof spyOn<typeof skillManager, "listInstalledSkills">>;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("skills-policy-cli-");
  sourcePath = join(stateDir, "unadmitted-source");
  mkdirSync(join(sourcePath, "private"), { recursive: true });
  writeFileSync(join(sourcePath, "private", "SKILL.md"), "---\nname: private\n---\nPRIVATE-INSTRUCTIONS\n");
  dbCreateAgent({ id: "restricted", cwd: stateDir });
  const originalInstalled = skillManager.listInstalledSkills;
  installedLookup = spyOn(skillManager, "listInstalledSkills").mockImplementation((options) =>
    originalInstalled({ ...options, homeDir: stateDir }),
  );
});

afterEach(async () => {
  installedLookup.mockRestore();
  await cleanupIsolatedRaviState(stateDir);
});

function boundContext(admin = false): ContextRecord {
  const plugin = join(stateDir, "ravi", "plugins", "example");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), '{"name":"example"}');
  for (const name of ["allowed", "private"]) {
    const path = join(plugin, "skills", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} guide\nravi.requires: {"kind":"none"}\n---\n${name.toUpperCase()}-CONTENT\n`,
    );
  }
  dbUpsertSkillGrant({ agentId: "restricted", skillName: "example:allowed" });
  const context = createRuntimeContext({
    kind: "agent-runtime",
    agentId: "restricted",
    capabilities: admin ? [{ permission: "admin", objectType: "system", objectId: "*" }] : [],
  });
  const binding = buildSkillPolicyContextBinding({
    scope: { agentId: "restricted", executionId: "execution-cli", contextKey: context.contextKey },
    cwd: stateDir,
    runtimeCapabilities: { tools: { availableCapabilities: [] }, dynamicTools: { mode: "none" } },
    plugins: [{ type: "local", path: plugin }],
  });
  const updated = dbUpdateContextRuntimeState(context.contextId, { metadata: { skillPolicyBinding: binding } });
  if (!updated) throw new Error("Fixture context could not be bound");
  return updated;
}

function managed<T>(context: ContextRecord, operation: () => T): T {
  return runWithContext({ context, agentId: "restricted", transport: "tool", suppressCliOutput: true }, operation);
}

function captureContractError(operation: () => unknown): ContractError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("Expected a contract failure");
}

describe("CLI skill discovery requires the managed execution snapshot", () => {
  test("reports a structured policy failure instead of an unexpected transport error", () => {
    const error = captureContractError(() =>
      runWithContext({ transport: "tool", suppressCliOutput: true }, () => {
        new SkillsCommands().list(undefined, false, false, true);
      }),
    );
    expect(error.code).toBe("SKILL_POLICY_UNAVAILABLE");
    expect(error.exitCode).toBe(3);
  });
  test.each(["catalog", "installed", "codex", "source"])(
    "rejects %s discovery without a resolved runtime context",
    (variant) => {
      expect(() =>
        runWithContext({ transport: "tool", agentId: "restricted", suppressCliOutput: true }, () =>
          new SkillsCommands().list(
            variant === "source" ? sourcePath : undefined,
            variant === "installed",
            variant === "codex",
            true,
          ),
        ),
      ).toThrow(/context|snapshot|policy/i);
    },
  );

  test("does not deliver a known catalog skill through show without a policy binding", () => {
    expect(() =>
      runWithContext({ transport: "tool", agentId: "restricted", suppressCliOutput: true }, () =>
        new SkillsCommands().show("agents-manager", undefined, false, true),
      ),
    ).toThrow(/context|snapshot|policy/i);
  });

  test("does not suggest hidden names to an unbound agent", () => {
    expect(() =>
      runWithContext({ transport: "gateway", agentId: "restricted", suppressCliOutput: true }, () =>
        new SkillsCommands().show("agents-manage", undefined, false, true),
      ),
    ).toThrow(/context|snapshot|policy/i);
  });

  test("an explicit local operator can inspect an external local source", () => {
    const result = runWithContext({ suppressCliOutput: true }, () =>
      new SkillsCommands().show("private", sourcePath, false, true),
    );
    expect(result.skill.content).toContain("PRIVATE-INSTRUCTIONS");
  });

  test.each(["catalog", "installed", "codex", "source"])(
    "only exposes the authorized skill through %s",
    (variant) => {
      const context = boundContext();
      const result = managed(context, () =>
        new SkillsCommands().list(
          variant === "source" ? join(stateDir, "ravi", "plugins", "example") : undefined,
          variant === "installed",
          variant === "codex",
          true,
        ),
      );
      expect(result.items.map((item) => item.name)).toEqual(["allowed"]);
      expect(result.total).toBe(1);
      expect(JSON.stringify(result)).not.toContain("private");
    },
    60_000,
  );

  test("show resolves a canonical id and never accepts a same-name skill from a different source", () => {
    const context = boundContext();
    const commands = new SkillsCommands();
    expect(managed(context, () => commands.show("example:allowed", undefined, false, true)).skill.content).toContain(
      "ALLOWED-CONTENT",
    );
    writeFileSync(join(sourcePath, "private", "SKILL.md"), "---\nname: allowed\n---\nIMPOSTOR-CONTENT\n");
    expect(() => managed(context, () => commands.show("allowed", sourcePath, false, true))).toThrow(/Skill not found/);
    const error = captureContractError(() => managed(context, () => commands.show("privat", undefined, false, true)));
    expect(error.details.suggestions).not.toContain("private");
  });

  test("does not grant a hidden skill or reveal it through a batch preview", () => {
    const context = boundContext();
    const commands = new SkillsCommands();
    expect(() =>
      managed(context, () => {
        commands.grant("restricted", "private", undefined, true);
      }),
    ).toThrow(/Skill not found/);
    const preview = managed(context, () =>
      commands.grantBatch("restricted", false, undefined, true, undefined, true, true),
    );
    expect(preview.sampleSkills).toEqual(["example:allowed"]);
    expect(dbListSkillGrantsForAgent("restricted").map((grant) => grant.skillName)).toEqual(["example:allowed"]);
  });

  test("re-evaluates operator grants and revocations before the next agent discovery", () => {
    const context = boundContext();
    const commands = new SkillsCommands();
    const operator = <T>(operation: () => T) => runWithContext({ suppressCliOutput: true }, operation);
    operator(() => commands.grant("restricted", "private", undefined, true));
    expect(managed(context, () => commands.show("private", undefined, false, true)).skill.content).toContain(
      "PRIVATE-CONTENT",
    );
    operator(() => commands.revoke("restricted", "private", true));
    expect(() => managed(context, () => commands.show("private", undefined, false, true))).toThrow(/Skill not found/);
  });

  test("inspect and who keep managed output within the execution snapshot", () => {
    const context = boundContext();
    dbUpsertSkillGrant({ agentId: "main", skillName: "private" });
    const commands = new SkillsCommands();
    const inspection = managed(context, () => commands.inspect("restricted", true));
    expect(inspection.allowlist).toEqual(["example:allowed"]);
    expect("diagnostics" in inspection).toBe(false);
    expect(JSON.stringify(inspection)).not.toContain(context.contextKey);
    const grants = managed(context, () => commands.who(undefined, undefined, true));
    expect(grants.grants.map((grant) => grant.skillName)).toEqual(["example:allowed"]);
    expect(() => managed(context, () => commands.inspect("main", true))).toThrow(/context|scope/i);
  });

  test("admin inspection includes scoped diagnostics without skill contents or bearer credentials", () => {
    const context = boundContext(true);
    const inspection = managed(context, () => new SkillsCommands().inspect("restricted", true));
    const parsed = skillInspectReturnSchema.parse(inspection);
    expect(parsed.diagnostics?.length).toBeGreaterThan(0);
    expect(parsed.scope?.contextId).toBe(context.contextId);
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain("PRIVATE-CONTENT");
    expect(serialized).not.toContain(context.contextKey);
  });

  test("managed installation cannot announce or copy the unfiltered catalog", () => {
    const context = boundContext();
    const installation = spyOn(skillManager, "installSkills").mockReturnValue([]);
    try {
      expect(() =>
        managed(context, () => {
          new SkillsCommands().install(undefined, undefined, undefined, true, undefined, false, true, true);
        }),
      ).toThrow(/operator|managed|scope/i);
    } finally {
      installation.mockRestore();
    }
  });

  test("managed sync cannot repopulate a global provider skill directory", () => {
    const context = boundContext();
    const synchronization = spyOn(codexSkills, "syncCodexSkills").mockReturnValue(["private"]);
    try {
      expect(() =>
        managed(context, () => {
          new SkillsCommands().sync(true);
        }),
      ).toThrow(/operator|managed|scope/i);
    } finally {
      synchronization.mockRestore();
    }
  });
});
