import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { dbCreateAgent, dbDeleteAgent, dbListSkillGrants, dbListSkillGrantsForAgent } from "../../router/router-db.js";
import { runWithContext } from "../context.js";
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
