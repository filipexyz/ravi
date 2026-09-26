import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupIsolatedRaviState,
  createIsolatedRaviState,
  withoutRaviRuntimeContextEnv,
} from "../../test/ravi-state.js";
import { getOrCreateSession } from "../../router/index.js";
import { dbCreateAgent, dbDeleteAgent, dbListSkillGrants, dbListSkillGrantsForAgent } from "../../router/router-db.js";
import { resolveAgentSkills } from "../../runtime/allowed-skills.js";
import { createRuntimeContext } from "../../runtime/context-registry.js";
import { createRuntimeHostServices } from "../../runtime/host-services.js";
import { authorizePiToolCall } from "../../runtime/pi-tool-permissions.js";
import { formatSkillNotAuthorizedReason } from "../../runtime/skill-authorization.js";
import { contractErrorResponse } from "../../sdk/gateway/errors.js";
import * as skillManager from "../../skills/manager.js";
import type { ResolvedSkillSource } from "../../skills/manager.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { remoteGatewayErrorToContractError } from "../remote-gateway.js";
import { SkillsCommands } from "./skills.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("skills-cli-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function withoutLogs<T>(run: () => T): T {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return run();
  } finally {
    console.log = originalLog;
  }
}

function captureLogs(run: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

function expectContractError(run: () => unknown): InstanceType<typeof ContractError> {
  let thrown: unknown;
  try {
    withoutLogs(run);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ContractError);
  return thrown as InstanceType<typeof ContractError>;
}

/**
 * Pick a real catalog skill name so grant fail-fast on skill-not-found does
 * not accidentally reject a valid case. `agents-manager` ships in the
 * internal `ravi-system` plugin, so it is always available in tests.
 */
const KNOWN_CATALOG_SKILL = "agents-manager";

describe("SkillsCommands — grant/revoke/who/inspect", () => {
  describe("grant", () => {
    it("fail-fasts when the agent id does not exist", () => {
      const commands = new SkillsCommands();
      expect(() =>
        runWithContext({}, () => commands.grant("no-such-agent", KNOWN_CATALOG_SKILL, undefined, true)),
      ).toThrow(/Agent not found/);
    });

    it("fail-fasts when the skill does not exist (C-orphan)", () => {
      const commands = new SkillsCommands();
      expect(() =>
        runWithContext({}, () => commands.grant("main", "definitely-not-a-real-skill", undefined, true)),
      ).toThrow(/Skill not found/);
    });

    it("stores the canonical skill name — not raw user input", () => {
      const commands = new SkillsCommands();
      const result = withoutLogs(() =>
        runWithContext({}, () => commands.grant("main", KNOWN_CATALOG_SKILL.toUpperCase(), "smoke-note", true)),
      );
      expect(result.success).toBe(true);
      // Canonical name must match SKILL.md name (lowercase), not the raw upper-case input.
      expect(result.skillName).toBe(KNOWN_CATALOG_SKILL);
      const grants = dbListSkillGrantsForAgent("main");
      expect(grants.map((g) => g.skillName)).toEqual([KNOWN_CATALOG_SKILL]);
      expect(grants[0]?.note).toBe("smoke-note");
    });

    it("is idempotent (upsert) — repeated grants do not stack rows", () => {
      const commands = new SkillsCommands();
      withoutLogs(() => runWithContext({}, () => commands.grant("main", KNOWN_CATALOG_SKILL, undefined, true)));
      withoutLogs(() => runWithContext({}, () => commands.grant("main", KNOWN_CATALOG_SKILL, "revised", true)));
      const grants = dbListSkillGrantsForAgent("main");
      expect(grants).toHaveLength(1);
      expect(grants[0]?.note).toBe("revised");
    });
  });

  describe("revoke", () => {
    it("returns success:false when no matching grant exists", () => {
      const commands = new SkillsCommands();
      const payload = withoutLogs(() => runWithContext({}, () => commands.revoke("main", KNOWN_CATALOG_SKILL, true)));
      expect(payload.success).toBe(false);
    });

    it("removes an existing grant", () => {
      const commands = new SkillsCommands();
      withoutLogs(() => runWithContext({}, () => commands.grant("main", KNOWN_CATALOG_SKILL, undefined, true)));
      const payload = withoutLogs(() => runWithContext({}, () => commands.revoke("main", KNOWN_CATALOG_SKILL, true)));
      expect(payload.success).toBe(true);
      expect(dbListSkillGrantsForAgent("main")).toEqual([]);
    });
  });

  describe("who", () => {
    it("lists agents granted a specific skill (positional scope)", () => {
      const commands = new SkillsCommands();
      withoutLogs(() => runWithContext({}, () => commands.grant("main", KNOWN_CATALOG_SKILL, undefined, true)));
      const payload = withoutLogs(() => runWithContext({}, () => commands.who(KNOWN_CATALOG_SKILL, undefined, true)));
      expect(payload.total).toBe(1);
      expect(payload.grants.map((g) => g.agentId)).toContain("main");
      expect(payload.skillName).toBe(KNOWN_CATALOG_SKILL);
    });

    it("lists grants for an agent via --agent (skillName omitted from payload)", () => {
      const commands = new SkillsCommands();
      withoutLogs(() => runWithContext({}, () => commands.grant("main", KNOWN_CATALOG_SKILL, undefined, true)));
      const payload = withoutLogs(() => runWithContext({}, () => commands.who(undefined, "main", true)));
      expect(payload.total).toBe(1);
      expect(payload.grants[0]?.skillName).toBe(KNOWN_CATALOG_SKILL);
      // skillName should be omitted (or empty) when the scope is by-agent, not by-skill.
      expect(payload.skillName ?? "").toBe("");
    });

    it("lists all grants when neither scope is provided", () => {
      const commands = new SkillsCommands();
      withoutLogs(() => runWithContext({}, () => commands.grant("main", KNOWN_CATALOG_SKILL, undefined, true)));
      const payload = withoutLogs(() => runWithContext({}, () => commands.who(undefined, undefined, true)));
      expect(payload.total).toBe(dbListSkillGrants().length);
      expect(payload.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe("dbDeleteAgent → skill_grants cleanup (M2 regression)", () => {
    it("removes per-agent grants so a same-id recreation does not inherit orphans", () => {
      const commands = new SkillsCommands();
      dbCreateAgent({ id: "ephemeral-agent", cwd: "/tmp/ephemeral" });
      withoutLogs(() =>
        runWithContext({}, () => commands.grant("ephemeral-agent", KNOWN_CATALOG_SKILL, undefined, true)),
      );
      expect(dbListSkillGrantsForAgent("ephemeral-agent")).toHaveLength(1);

      dbDeleteAgent("ephemeral-agent");
      expect(dbListSkillGrantsForAgent("ephemeral-agent")).toEqual([]);

      // Re-create with the same id — must start clean.
      dbCreateAgent({ id: "ephemeral-agent", cwd: "/tmp/ephemeral-again" });
      expect(dbListSkillGrantsForAgent("ephemeral-agent")).toEqual([]);
    });
  });

  describe("grant-batch / revoke-batch", () => {
    it("grants every catalog skill to a single agent in one call", () => {
      const commands = new SkillsCommands();
      dbCreateAgent({ id: "batch-target", cwd: "/tmp/batch-target" });
      const payload = withoutLogs(() =>
        runWithContext({}, () => commands.grantBatch("batch-target", false, undefined, true, "bulk-open", false, true)),
      );
      expect(payload.op).toBe("grant");
      expect(payload.agentsTargeted).toBe(1);
      expect(payload.skillsTargeted).toBeGreaterThan(1);
      expect(payload.pairsAffected).toBe(payload.skillsTargeted);
      // Every targeted skill is now an explicit grant row for the agent.
      expect(dbListSkillGrantsForAgent("batch-target")).toHaveLength(payload.skillsTargeted);
    });

    it("dry-run counts pairs without writing any grant", () => {
      const commands = new SkillsCommands();
      dbCreateAgent({ id: "batch-dry", cwd: "/tmp/batch-dry" });
      const payload = withoutLogs(() =>
        runWithContext({}, () => commands.grantBatch("batch-dry", false, undefined, true, undefined, true, true)),
      );
      expect(payload.dryRun).toBe(true);
      expect(payload.pairsAffected).toBeGreaterThan(0);
      expect(dbListSkillGrantsForAgent("batch-dry")).toEqual([]);
    });

    it("fail-fasts when no agent axis is given", () => {
      const commands = new SkillsCommands();
      expect(() =>
        runWithContext({}, () => commands.grantBatch(undefined, false, undefined, true, undefined, false, true)),
      ).toThrow(/agent axis/);
    });

    it("fail-fasts when both --agent and --all-agents are given", () => {
      const commands = new SkillsCommands();
      expect(() =>
        runWithContext({}, () => commands.grantBatch("main", true, undefined, true, undefined, true, true)),
      ).toThrow(/not both/);
    });

    it("revoke-batch removes the grants a matching grant-batch created", () => {
      const commands = new SkillsCommands();
      dbCreateAgent({ id: "batch-rev", cwd: "/tmp/batch-rev" });
      withoutLogs(() =>
        runWithContext({}, () => commands.grantBatch("batch-rev", false, undefined, true, undefined, false, true)),
      );
      expect(dbListSkillGrantsForAgent("batch-rev").length).toBeGreaterThan(0);
      const payload = withoutLogs(() =>
        runWithContext({}, () => commands.revokeBatch("batch-rev", false, undefined, true, false, true)),
      );
      expect(payload.op).toBe("revoke");
      expect(payload.pairsAffected).toBeGreaterThan(0);
      expect(dbListSkillGrantsForAgent("batch-rev")).toEqual([]);
    });

    it("--all-agents targets every agent in the fleet", () => {
      const commands = new SkillsCommands();
      dbCreateAgent({ id: "fleet-a", cwd: "/tmp/fleet-a" });
      dbCreateAgent({ id: "fleet-b", cwd: "/tmp/fleet-b" });
      const payload = withoutLogs(() =>
        runWithContext({}, () =>
          commands.grantBatch(undefined, true, KNOWN_CATALOG_SKILL, false, undefined, true, true),
        ),
      );
      expect(payload.skillsTargeted).toBe(1);
      // At least the two agents just created are covered.
      expect(payload.agentsTargeted).toBeGreaterThanOrEqual(2);
    });
  });

  describe("inspect", () => {
    it("fail-fasts when the agent id does not exist", () => {
      const commands = new SkillsCommands();
      expect(() => runWithContext({}, () => commands.inspect("no-such-agent", true))).toThrow(/Agent not found/);
    });

    it("returns the resolved allowlist for the main agent", () => {
      const commands = new SkillsCommands();
      const payload = withoutLogs(() => runWithContext({}, () => commands.inspect("main", true)));
      // Main gets execute:group:* via bootstrap → all derived skills + baseline.
      expect(payload.agentId).toBe("main");
      expect(payload.hasConfiguration).toBe(true);
      expect(payload.allowlist.length).toBeGreaterThan(0);
      // Baseline is always included.
      expect(payload.allowlist).toContain("ravi-system-tasks");
      expect(payload.provenance.baseline.length).toBeGreaterThan(0);
    });

    it("reflects a fresh grant in the next inspect call", () => {
      const commands = new SkillsCommands();
      withoutLogs(() => runWithContext({}, () => commands.grant("main", KNOWN_CATALOG_SKILL, undefined, true)));
      const payload = withoutLogs(() => runWithContext({}, () => commands.inspect("main", true)));
      expect(payload.provenance.fromGrants).toContain(KNOWN_CATALOG_SKILL);
    });
  });
});

describe("skills agent-first contract", () => {
  it("blocks a Git source before resolving it when --execute is absent", () => {
    const resolveSpy = spyOn(skillManager, "withResolvedSkillSource").mockImplementation(() => {
      throw new Error("Git source resolution must not run before confirmation");
    });
    try {
      const contractError = expectContractError(() =>
        runWithContext({}, () =>
          new SkillsCommands().install(
            undefined,
            "https://github.com/example/ravi-skills.git",
            undefined,
            true,
            undefined,
            undefined,
            true,
            true,
            undefined,
          ),
        ),
      );

      expect(contractError).toMatchObject({
        code: "WRITE_REQUIRES_EXECUTE",
        exitCode: 3,
        op: "skills install",
      });
      const plan = contractError.envelope().error.plan as Record<string, unknown>;
      expect(plan).toEqual({
        sourceKind: "git",
        sourceLabel: "git",
        selectionDeferred: true,
        overwrite: false,
        codexSync: false,
      });
      expect(JSON.stringify(plan)).not.toContain("https://github.com/example/ravi-skills.git");
      expect(resolveSpy).toHaveBeenCalledTimes(0);
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("uses a closed Git source label and removes URL query data", () => {
    const repoName = `ravi-${"x".repeat(180)}`;
    const source = `https://git.example/org/${repoName}.git?access=SENTINEL_PRIVATE`;
    const resolveSpy = spyOn(skillManager, "withResolvedSkillSource").mockImplementation(() => {
      throw new Error("Git source resolution must not run before confirmation");
    });
    try {
      const contractError = expectContractError(() =>
        runWithContext({}, () =>
          new SkillsCommands().install(undefined, source, undefined, true, undefined, undefined, true, true, undefined),
        ),
      );

      const plan = contractError.envelope().error.plan as Record<string, unknown>;
      expect(plan).toEqual({
        sourceKind: "git",
        sourceLabel: "git",
        selectionDeferred: true,
        overwrite: false,
        codexSync: false,
      });
      expect(JSON.stringify(plan)).not.toContain("SENTINEL_PRIVATE");
      expect(JSON.stringify(plan)).not.toContain("git.example");
      expect(resolveSpy).toHaveBeenCalledTimes(0);
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("installs a confirmed Git source after resolving it", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "skills-confirmed-git-"));
    const gitSource = "https://github.com/example/ravi-skills.git";
    let resolveSpy: ReturnType<typeof spyOn> | undefined;
    let installSpy: ReturnType<typeof spyOn> | undefined;
    let installedNames: string[] = [];
    try {
      writeFileSync(
        join(sourceRoot, "SKILL.md"),
        "---\nname: confirmed-git-skill\ndescription: Confirmed Git fixture\n---\n\nFixture content\n",
      );
      resolveSpy = spyOn(skillManager, "withResolvedSkillSource").mockImplementation(
        <T>(input: string, run: (resolved: ResolvedSkillSource) => T): T =>
          run({ source: skillManager.parseSkillSource(input), rootPath: sourceRoot }),
      );
      installSpy = spyOn(skillManager, "installSkills").mockImplementation((skills, options = {}) => {
        installedNames = skills.map((skill) => skill.name);
        return skills.map((skill) => ({
          ...skill,
          installPath: join(sourceRoot, ".test-install", skill.name),
          pluginName: options.pluginName ?? "ravi-user-skills",
        }));
      });

      const result = withoutLogs(() =>
        runWithContext({}, () =>
          new SkillsCommands().install(undefined, gitSource, undefined, true, undefined, undefined, true, true, true),
        ),
      );

      expect(result.success).toBe(true);
      expect(installedNames).toEqual(["confirmed-git-skill"]);
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(installSpy).toHaveBeenCalledTimes(1);
    } finally {
      installSpy?.mockRestore();
      resolveSpy?.mockRestore();
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("does not echo a confirmed source URL or resolved path in SKILL_NOT_FOUND", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "SENTINEL_PRIVATE_PATH-"));
    const gitSource = "https://git.example/org/repo.git?access=SENTINEL_PRIVATE_URL";
    const resolveSpy = spyOn(skillManager, "withResolvedSkillSource").mockImplementation(
      <T>(input: string, run: (resolved: ResolvedSkillSource) => T): T =>
        run({ source: skillManager.parseSkillSource(input), rootPath: sourceRoot }),
    );
    try {
      writeFileSync(
        join(sourceRoot, "SKILL.md"),
        "---\nname: available-skill\ndescription: Available fixture\n---\n\nFixture content\n",
      );
      const contractError = expectContractError(() =>
        runWithContext({}, () =>
          new SkillsCommands().install(
            "missing-skill",
            gitSource,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            true,
            true,
          ),
        ),
      );

      expect(contractError).toMatchObject({ code: "SKILL_NOT_FOUND", exitCode: 1, op: "skills install" });
      const envelope = contractError.envelope();
      const serialized = JSON.stringify(envelope);
      expect(String(envelope.error.suggestedAction)).toContain("--source <source>");
      expect(serialized).not.toContain("SENTINEL_PRIVATE_URL");
      expect(serialized).not.toContain("SENTINEL_PRIVATE_PATH");
      expect(serialized).not.toContain(gitSource);
      expect(serialized).not.toContain(sourceRoot);
      expect(resolveSpy).toHaveBeenCalledTimes(1);
    } finally {
      resolveSpy.mockRestore();
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("blocks a catalog overwrite without --execute with only minimal source metadata", () => {
    const commands = new SkillsCommands();
    const contractError = expectContractError(() =>
      runWithContext({}, () =>
        commands.install(
          KNOWN_CATALOG_SKILL,
          undefined,
          undefined,
          undefined,
          undefined,
          true, // --overwrite
          true, // --skip-codex-sync
          true, // --json
          undefined, // no --execute → brake
        ),
      ),
    );
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("skills install");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    const plan = envelope.error.plan as Record<string, unknown>;
    expect(plan).toEqual({
      sourceKind: "catalog",
      sourceLabel: "catalog",
      skillCount: 1,
      overwrite: true,
      codexSync: false,
    });
    expect(JSON.stringify(plan)).not.toContain(KNOWN_CATALOG_SKILL);
  });

  it("blocks a catalog overwrite before the file installation sink", () => {
    let installState = "unchanged";
    const installSpy = spyOn(skillManager, "installSkills").mockImplementation(() => {
      installState = "changed";
      return [];
    });
    try {
      const contractError = expectContractError(() =>
        runWithContext({}, () =>
          new SkillsCommands().install(
            KNOWN_CATALOG_SKILL,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            true,
            true,
            undefined,
          ),
        ),
      );

      expect(contractError).toMatchObject({
        code: "WRITE_REQUIRES_EXECUTE",
        exitCode: 3,
        op: "skills install",
      });
      expect(installSpy).toHaveBeenCalledTimes(0);
      expect(installState).toBe("unchanged");
    } finally {
      installSpy.mockRestore();
    }
  });

  it("validates a local overwrite before the brake and exposes only minimal source metadata", () => {
    const source = mkdtempSync(join(tmpdir(), "sentinel-private-"));
    const resolveSpy = spyOn(skillManager, "withResolvedSkillSource");
    try {
      writeFileSync(
        join(source, "SKILL.md"),
        "---\nname: PRIVATE_MESSAGE_8K2R\ndescription: SENTINEL_SECRET_7M4Q\n---\n\nPrivate content\n",
      );
      const commands = new SkillsCommands();
      const contractError = expectContractError(() =>
        runWithContext({}, () =>
          commands.install(undefined, source, undefined, true, undefined, true, true, true, undefined),
        ),
      );

      const plan = contractError.envelope().error.plan as Record<string, unknown>;
      expect(plan).toEqual({
        sourceKind: "local",
        sourceLabel: "local",
        skillCount: 1,
        overwrite: true,
        codexSync: false,
      });
      expect(JSON.stringify(plan)).not.toContain(source);
      expect(JSON.stringify(plan)).not.toContain("PRIVATE_MESSAGE_8K2R");
      expect(JSON.stringify(plan)).not.toContain("SENTINEL_SECRET_7M4Q");
      expect(resolveSpy).toHaveBeenCalledTimes(1);
    } finally {
      resolveSpy.mockRestore();
      rmSync(source, { recursive: true, force: true });
    }
  });

  it("installs an additive local source immediately without --execute", () => {
    const source = mkdtempSync(join(tmpdir(), "skills-additive-local-"));
    let installSpy: ReturnType<typeof spyOn> | undefined;
    let installedNames: string[] = [];
    try {
      writeFileSync(
        join(source, "SKILL.md"),
        "---\nname: local-additive-skill\ndescription: Local additive fixture\n---\n\nFixture content\n",
      );
      installSpy = spyOn(skillManager, "installSkills").mockImplementation((skills, options = {}) => {
        installedNames = skills.map((skill) => skill.name);
        return skills.map((skill) => ({
          ...skill,
          installPath: join(source, ".test-install", skill.name),
          pluginName: options.pluginName ?? "ravi-user-skills",
        }));
      });
      const result = withoutLogs(() =>
        runWithContext({}, () =>
          new SkillsCommands().install(undefined, source, undefined, true, undefined, undefined, true, true, undefined),
        ),
      );

      expect(result.success).toBe(true);
      expect(result.installed).toHaveLength(1);
      expect(installedNames).toEqual(["local-additive-skill"]);
      expect(installSpy).toHaveBeenCalledTimes(1);
    } finally {
      installSpy?.mockRestore();
      rmSync(source, { recursive: true, force: true });
    }
  });

  it("validates SKILL_NOT_FOUND before a catalog overwrite brake (exit 1, not 3)", () => {
    const commands = new SkillsCommands();
    const contractError = expectContractError(() =>
      runWithContext({}, () =>
        commands.install(
          "definitely-not-a-real-skill",
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          true,
          true,
          undefined,
        ),
      ),
    );
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("skills install");
    expect(envelope.error.code).toBe("SKILL_NOT_FOUND");
    expect(Array.isArray(envelope.error.suggestions)).toBe(true);
    expect(String(envelope.error.suggestedAction)).toContain("ravi skills list --json");
    expect(String(envelope.error.suggestedAction)).not.toContain("--source");
  });

  it("installs an additive catalog skill without --execute into the redirected user plugin bucket", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "skills-exec-home-"));
    try {
      const childEnv = {
        ...withoutRaviRuntimeContextEnv(),
        HOME: tempHome,
        USERPROFILE: tempHome,
        RAVI_TEST_EXPECTED_HOME: tempHome,
        RAVI_LOG_LEVEL: "error",
      };

      // Bun 1.3.11/Linux does not update os.homedir() when HOME changes after
      // process start. Validate the redirect and perform the write in that same
      // fresh process so a runtime that cannot honor it exits before mutation.
      const execution = spawnSync(
        process.execPath,
        [
          "--eval",
          `
            import { homedir } from "node:os";
            import { runWithContext } from "./src/cli/context.ts";
            import { SkillsCommands } from "./src/cli/commands/skills.ts";

            const expectedHome = process.env.RAVI_TEST_EXPECTED_HOME;
            if (!expectedHome || homedir() !== expectedHome) {
              console.error("Redirected home was not honored; refusing skills install");
              process.exit(70);
            }

            const originalLog = console.log;
            console.log = () => {};
            try {
              const result = runWithContext({}, () =>
                new SkillsCommands().install(
                  ${JSON.stringify(KNOWN_CATALOG_SKILL)},
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  true,
                  true,
                  undefined,
                ),
              );
              process.stdout.write(JSON.stringify(result));
            } finally {
              console.log = originalLog;
            }
          `,
        ],
        { cwd: process.cwd(), encoding: "utf8", env: childEnv },
      );
      expect(execution.status).toBe(0);
      expect(execution.stderr).toBe("");
      const result = JSON.parse(execution.stdout) as {
        success: boolean;
        installed: Array<{ installPath?: string }>;
      };
      expect(result.success).toBe(true);
      const installPath = String(result.installed[0]?.installPath ?? "");
      expect(installPath.startsWith(tempHome)).toBe(true);
      expect(existsSync(installPath)).toBe(true);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  }, 20_000);

  it("installs a catalog overwrite when --execute is present", () => {
    const installSpy = spyOn(skillManager, "installSkills").mockImplementation((skills, options = {}) =>
      skills.map((skill) => ({
        ...skill,
        installPath: join(tmpdir(), "skills-overwrite-control", skill.name),
        pluginName: options.pluginName ?? "ravi-user-skills",
      })),
    );
    try {
      const result = withoutLogs(() =>
        runWithContext({}, () =>
          new SkillsCommands().install(
            KNOWN_CATALOG_SKILL,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            true,
            true,
            true,
          ),
        ),
      );

      expect(result.success).toBe(true);
      expect(result.installed).toHaveLength(1);
      expect(installSpy).toHaveBeenCalledTimes(1);
      expect(installSpy.mock.calls[0]?.[1]).toMatchObject({ overwrite: true });
    } finally {
      installSpy.mockRestore();
    }
  });

  it("emits SKILL_NOT_FOUND envelope with suggestions on skills show --json (exit 1)", () => {
    const commands = new SkillsCommands();
    const contractError = expectContractError(() =>
      runWithContext({}, () => commands.show("agents-managerr", undefined, undefined, true)),
    );
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("skills show");
    expect(envelope.error.code).toBe("SKILL_NOT_FOUND");
    expect(envelope.error.suggestions).toContain(KNOWN_CATALOG_SKILL);
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
  });

  it("enforces the current agent allowlist on skills show", () => {
    const commands = new SkillsCommands();
    const agentId = "skills-show-agent";
    dbCreateAgent({ id: agentId, cwd: "/tmp/skills-show-agent" });
    withoutLogs(() => runWithContext({}, () => commands.grant(agentId, KNOWN_CATALOG_SKILL, undefined, true)));
    const deniedSkill = skillManager
      .listCatalogSkills()
      .find(
        (skill) =>
          skill.name !== KNOWN_CATALOG_SKILL && !["sessions", "tasks", "specs", "skill-creator"].includes(skill.name),
      );
    expect(deniedSkill).toBeDefined();

    const allowed = withoutLogs(() =>
      runWithContext({ transport: "tool", agentId }, () =>
        commands.show(KNOWN_CATALOG_SKILL, undefined, undefined, true),
      ),
    );
    expect(allowed.skill.name).toBe(KNOWN_CATALOG_SKILL);

    const contractError = expectContractError(() =>
      runWithContext({ transport: "tool", agentId }, () =>
        commands.show(deniedSkill!.name, undefined, undefined, true),
      ),
    );
    expect(contractError.exitCode).toBe(1);
    const denied = contractError.envelope().error;
    expect(denied.code).toBe("SKILL_NOT_AUTHORIZED");
    expect(denied.message).toBe(`Skill '${deniedSkill!.name}' is not authorized for agent '${agentId}'.`);
    expect(String(denied.suggestedAction)).toContain(`ravi skills grant ${agentId} ${deniedSkill!.name}`);
    expect(String(denied.suggestedAction)).toContain("ravi skills install --source <skill-dir>");

    expect(() =>
      withoutLogs(() => runWithContext({}, () => commands.show(deniedSkill!.name, undefined, undefined, true))),
    ).not.toThrow();
  });

  it("emits AGENT_NOT_FOUND envelope with suggestions on skills grant --json (exit 1)", () => {
    const commands = new SkillsCommands();
    const contractError = expectContractError(() =>
      runWithContext({}, () => commands.grant("maim", KNOWN_CATALOG_SKILL, undefined, true)),
    );
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("skills grant");
    expect(envelope.error.code).toBe("AGENT_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("main");
  });

  it("emits SKILL_NOT_FOUND envelope on skills grant of an unknown skill --json (exit 1)", () => {
    const commands = new SkillsCommands();
    const contractError = expectContractError(() =>
      runWithContext({}, () => commands.grant("main", "agents-managerr", undefined, true)),
    );
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.error.code).toBe("SKILL_NOT_FOUND");
    expect(envelope.error.suggestions).toContain(KNOWN_CATALOG_SKILL);
  });

  it("supports --fields compact mode on skills list", () => {
    const commands = new SkillsCommands();
    const logs = captureLogs(() =>
      runWithContext({}, () =>
        commands.list(undefined, undefined, undefined, true, undefined, undefined, undefined, "name,source"),
      ),
    );
    const payload = JSON.parse(logs) as { items: Array<Record<string, unknown>> };
    expect(payload.items.length).toBeGreaterThan(0);
    expect(Object.keys(payload.items[0] ?? {}).sort()).toEqual(["name", "source"]);
  });

  it("supports --fields compact mode on skills who", () => {
    const commands = new SkillsCommands();
    withoutLogs(() => runWithContext({}, () => commands.grant("main", KNOWN_CATALOG_SKILL, undefined, true)));
    const payload = withoutLogs(() =>
      runWithContext({}, () => commands.who(KNOWN_CATALOG_SKILL, undefined, true, "agentId")),
    );
    expect(payload.total).toBe(1);
    expect(Object.keys(payload.grants[0] ?? {})).toEqual(["agentId"]);
  });
});

async function throughRemoteGateway(error: InstanceType<typeof ContractError>) {
  const response = contractErrorResponse(error);
  return {
    status: response.status,
    remote: remoteGatewayErrorToContractError(error.op, {
      status: response.status,
      ok: false,
      body: await response.text(),
      contentType: response.headers.get("content-type"),
    }),
  };
}

function writeSkillDir(root: string, name: string, description: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  return dir;
}

describe("skills install --source for a single on-disk skill (bug 2b7fcc09)", () => {
  function spyInstall() {
    const installed: string[] = [];
    const spy = spyOn(skillManager, "installSkills").mockImplementation((skills, options = {}) => {
      installed.push(...skills.map((skill) => skill.name));
      return skills.map((skill) => ({
        ...skill,
        installPath: join(tmpdir(), "skills-install-control", skill.name),
        pluginName: options.pluginName ?? "ravi-user-skills",
      }));
    });
    return { spy, installed };
  }

  it("installs a single-skill directory without a name or --all", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-single-source-"));
    const { spy, installed } = spyInstall();
    try {
      const source = writeSkillDir(root, "find-skills", 'Use when users ask "how do I do X".');
      const result = withoutLogs(() =>
        runWithContext({}, () =>
          new SkillsCommands().install(
            undefined,
            source,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            true,
            undefined,
          ),
        ),
      );
      expect(result.success).toBe(true);
      expect(installed).toEqual(["find-skills"]);
      expect((result.installed[0] as Record<string, unknown> | undefined)?.description).toBe(
        'Use when users ask "how do I do X".',
      );
      expect(result.nextSteps).toEqual(["ravi skills grant <agent> find-skills"]);
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a relative local source against the caller cwd, not the daemon cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-caller-cwd-"));
    const { spy, installed } = spyInstall();
    try {
      writeSkillDir(join(root, "skills"), "find-skills", "Caller cwd fixture");
      const result = withoutLogs(() =>
        runWithContext({ cwd: root }, () =>
          new SkillsCommands().install(
            undefined,
            "./skills/find-skills",
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            true,
            undefined,
          ),
        ),
      );
      expect(result.success).toBe(true);
      expect(installed).toEqual(["find-skills"]);
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the selection cause visible through the remote gateway for a multi-skill source", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-multi-source-"));
    try {
      writeSkillDir(join(root, "skills"), "alpha", "Alpha fixture");
      writeSkillDir(join(root, "skills"), "beta", "Beta fixture");
      const error = expectContractError(() =>
        runWithContext({}, () =>
          new SkillsCommands().install(
            undefined,
            root,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            true,
            undefined,
          ),
        ),
      );
      expect(error).toMatchObject({ code: "SKILL_SELECTION_REQUIRED", exitCode: 2, op: "skills install" });
      expect(error.envelope().error.suggestions).toEqual(["alpha", "beta"]);

      const { status, remote } = await throughRemoteGateway(error);
      expect(status).toBe(400);
      expect(remote?.message).toBe("name: Source has 2 skills. Pass a skill name or --all.");
      expect(remote?.message).not.toBe("Remote command failed.");
      expect(JSON.stringify(remote?.envelope())).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a missing local source explicitly without echoing its path", async () => {
    const missing = join(tmpdir(), "SENTINEL_MISSING_SKILL_SOURCE_2b7fcc09");
    const error = expectContractError(() =>
      runWithContext({}, () =>
        new SkillsCommands().install(
          undefined,
          missing,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          true,
          undefined,
        ),
      ),
    );
    expect(error).toMatchObject({ code: "SKILL_SOURCE_NOT_FOUND", exitCode: 1 });
    const { status, remote } = await throughRemoteGateway(error);
    expect(status).toBe(422);
    expect(remote?.message).toBe("source: Local skill source not found.");
    expect(remote?.details.issues).toEqual([
      { path: ["source"], code: "SKILL_SOURCE_NOT_FOUND", message: "Local skill source not found." },
      {
        path: ["suggestedAction"],
        code: "SUGGESTED_ACTION",
        message: expect.stringContaining("contains SKILL.md"),
      },
    ]);
    expect(JSON.stringify(error.envelope())).not.toContain("SENTINEL_MISSING_SKILL_SOURCE");
  });

  it("maps an already-installed skill to SKILL_ALREADY_INSTALLED pointing at grant", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-already-installed-"));
    const spy = spyOn(skillManager, "installSkills").mockImplementation(() => {
      throw new skillManager.SkillSourceError(
        "SKILL_ALREADY_INSTALLED",
        "Skill already installed: find-skills. Pass --overwrite to replace it.",
        { publicMessage: "Skill already installed: find-skills.", skillName: "find-skills" },
      );
    });
    try {
      const source = writeSkillDir(root, "find-skills", "Already installed fixture");
      const error = expectContractError(() =>
        runWithContext({}, () =>
          new SkillsCommands().install(
            undefined,
            source,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            true,
            undefined,
          ),
        ),
      );
      expect(error).toMatchObject({ code: "SKILL_ALREADY_INSTALLED", exitCode: 1 });
      expect(error.envelope().error.suggestedAction).toBe(
        "Grant it with 'ravi skills grant <agent> find-skills', or replace it with --overwrite --execute",
      );
      const { remote } = await throughRemoteGateway(error);
      expect(remote?.message).toBe("name: Skill already installed: find-skills.");
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still requires a name or --all for catalog installs, as a usage error", async () => {
    const error = expectContractError(() =>
      runWithContext({}, () =>
        new SkillsCommands().install(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          true,
          undefined,
        ),
      ),
    );
    expect(error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const { remote } = await throughRemoteGateway(error);
    expect(remote?.message).toBe("name: Pass a catalog skill name, --source <skill-dir>, or --all.");
  });

  it("points a SKILL_NOT_FOUND grant at install --source", async () => {
    const error = expectContractError(() =>
      runWithContext({}, () => new SkillsCommands().grant("main", "find-skills-not-installed", undefined, true)),
    );
    expect(error.code).toBe("SKILL_NOT_FOUND");
    expect(String(error.envelope().error.suggestedAction)).toContain("ravi skills install --source <skill-dir>");
    const { remote } = await throughRemoteGateway(error);
    expect(remote?.message).toBe("skill: Skill not found: find-skills-not-installed");
    expect(JSON.stringify(remote?.details.issues)).toContain("ravi skills install --source <skill-dir>");
  });

  it("closes the loop: ~/.agents skill → install → grant → gate allows it and still denies others", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "skills-loop-home-"));
    const agentId = "loop-agent";
    try {
      dbCreateAgent({ id: agentId, cwd: "/tmp/loop-agent" });
      const agentsSkills = join(tempHome, ".agents", "skills");
      writeSkillDir(agentsSkills, "find-skills", 'Helps when users ask "how do I do X".');
      writeSkillDir(agentsSkills, "other-skill", "Never granted.");
      const findSkillFile = join(agentsSkills, "find-skills", "SKILL.md");
      const otherSkillFile = join(agentsSkills, "other-skill", "SKILL.md");

      // os.homedir() ignores HOME changes after start: run install/grant in a
      // fresh process that owns the redirected home (see catalog install test).
      const execution = spawnSync(
        process.execPath,
        [
          "--eval",
          `
            import { homedir } from "node:os";
            import { runWithContext } from "./src/cli/context.ts";
            import { SkillsCommands } from "./src/cli/commands/skills.ts";

            if (homedir() !== process.env.RAVI_TEST_EXPECTED_HOME) {
              console.error("Redirected home was not honored; refusing skills install");
              process.exit(70);
            }
            const commands = new SkillsCommands();
            const capture = (run) => {
              try {
                return { ok: run() };
              } catch (error) {
                return { error: typeof error?.envelope === "function" ? error.envelope().error : String(error) };
              }
            };
            const originalLog = console.log;
            console.log = () => {};
            let out;
            try {
              out = runWithContext({}, () => ({
                grantBefore: capture(() => commands.grant(${JSON.stringify(agentId)}, "find-skills", undefined, true)),
                install: capture(() =>
                  commands.install(undefined, "~/.agents/skills/find-skills", undefined, undefined, undefined, undefined, true, true, undefined),
                ),
                grantAfter: capture(() => commands.grant(${JSON.stringify(agentId)}, "find-skills", undefined, true)),
              }));
            } finally {
              console.log = originalLog;
            }
            process.stdout.write(JSON.stringify(out));
          `,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...withoutRaviRuntimeContextEnv(),
            HOME: tempHome,
            USERPROFILE: tempHome,
            RAVI_TEST_EXPECTED_HOME: tempHome,
            RAVI_LOG_LEVEL: "error",
          },
        },
      );
      expect(execution.status).toBe(0);
      expect(execution.stderr).not.toContain("Redirected home");
      const steps = JSON.parse(execution.stdout) as {
        grantBefore: { error?: { code: string; suggestedAction?: string } };
        install: { ok?: { installed: Array<{ name: string; installPath: string }> } };
        grantAfter: { ok?: { skillName: string } };
      };

      expect(steps.grantBefore.error?.code).toBe("SKILL_NOT_FOUND");
      expect(steps.grantBefore.error?.suggestedAction).toContain("ravi skills install --source <skill-dir>");
      expect(steps.install.ok?.installed.map((skill) => skill.name)).toEqual(["find-skills"]);
      const installedSkillFile = join(String(steps.install.ok?.installed[0]?.installPath), "SKILL.md");
      expect(installedSkillFile.startsWith(tempHome)).toBe(true);
      expect(steps.grantAfter.ok?.skillName).toBe("find-skills");
      expect(dbListSkillGrantsForAgent(agentId).map((grant) => grant.skillName)).toEqual(["find-skills"]);

      const { allowlist, hasConfiguration } = resolveAgentSkills(agentId);
      expect(hasConfiguration).toBe(true);
      const piHandlers = {
        canUseTool: async () => ({ behavior: "allow" as const }),
        allowedSkills: allowlist,
        agentId,
      };
      await expect(authorizePiToolCall("read", { path: installedSkillFile }, piHandlers)).resolves.toEqual({
        allowed: true,
      });
      await expect(authorizePiToolCall("read", { path: findSkillFile }, piHandlers)).resolves.toEqual({
        allowed: true,
      });
      await expect(authorizePiToolCall("read", { path: otherSkillFile }, piHandlers)).resolves.toEqual({
        allowed: false,
        reason: formatSkillNotAuthorizedReason("other-skill", agentId),
      });

      getOrCreateSession(`agent:${agentId}:main`, agentId, stateDir!, { name: "loop", runtimeProvider: "pi" });
      const services = createRuntimeHostServices({
        context: createRuntimeContext({
          kind: "agent-runtime",
          agentId,
          sessionKey: `agent:${agentId}:main`,
          sessionName: "loop",
          capabilities: [{ permission: "use", objectType: "tool", objectId: "Bash", source: "test" }],
        }),
        agentId,
        sessionName: "loop",
        toolContext: {},
      });
      const deniedRead = await services.authorizeCommandExecution({ command: `head -20 ${otherSkillFile}`, input: {} });
      expect(deniedRead).toEqual({
        approved: false,
        reason:
          "SKILL_NOT_AUTHORIZED: Skill 'other-skill' is not authorized for agent 'loop-agent'. " +
          "Install it into Ravi if needed ('ravi skills install --source <skill-dir>'), then grant it " +
          "('ravi skills grant loop-agent other-skill').",
      });
      const grantedRead = await services.authorizeCommandExecution({ command: `head -20 ${findSkillFile}`, input: {} });
      expect(String(grantedRead.reason ?? "")).not.toContain("SKILL_NOT_AUTHORIZED");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);
});
