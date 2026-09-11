import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLocalSkillsPreserved } from "./claude-provider.js";
import type { RuntimeStartRequest } from "./types.js";

/**
 * spec: skills/scoping/per-agent-visibility — Invariant F/B regression.
 *
 * Guards the F1 blocker: when a per-agent allowlist is active, the agent's own
 * local skills (its `.claude/skills` arsenal) MUST survive the Options.skills
 * filter. Without this, main (admin:system:* → allowlist active) would lose all
 * ~22 local skills the moment the feature goes live.
 */

function makeAgentWorkspace(skillNames: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-local-skills-"));
  for (const name of skillNames) {
    const dir = join(root, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n`);
  }
  return root;
}

function makeRequest(overrides: Record<string, unknown>): RuntimeStartRequest {
  return { cwd: "/tmp", model: "claude-x", ...overrides } as unknown as RuntimeStartRequest;
}

describe("withLocalSkillsPreserved", () => {
  test("no-op when no allowlist is active (Invariant F — grandfather)", () => {
    const cwd = makeAgentWorkspace(["swarm-orchestrator"]);
    const req = makeRequest({ cwd, allowedSkills: undefined });
    // Returns the same object untouched → SDK omits `skills` → full visibility.
    expect(withLocalSkillsPreserved(req)).toBe(req);
  });

  test("no-op when the allowlist is an empty array", () => {
    const cwd = makeAgentWorkspace(["swarm-orchestrator"]);
    const req = makeRequest({ cwd, allowedSkills: [] });
    expect(withLocalSkillsPreserved(req).allowedSkills).toEqual([]);
  });

  test("unions the agent's own local project skills into an active allowlist", () => {
    const cwd = makeAgentWorkspace(["swarm-orchestrator", "devils-advocate"]);
    const req = makeRequest({ cwd, allowedSkills: ["ravi-system-tasks"], settingSources: ["project"] });
    const out = withLocalSkillsPreserved(req).allowedSkills ?? [];
    expect(out).toContain("ravi-system-tasks");
    expect(out).toContain("swarm-orchestrator");
    expect(out).toContain("devils-advocate");
  });

  test("does not duplicate a local skill already present in the allowlist", () => {
    const cwd = makeAgentWorkspace(["managing-vault"]);
    const req = makeRequest({
      cwd,
      allowedSkills: ["managing-vault", "ravi-system-tasks"],
      settingSources: ["project"],
    });
    const out = withLocalSkillsPreserved(req).allowedSkills ?? [];
    expect(out.filter((s) => s === "managing-vault")).toHaveLength(1);
  });

  test("ignores directories that have no SKILL.md", () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-local-skills-"));
    mkdirSync(join(root, ".claude", "skills", "not-a-skill"), { recursive: true });
    const req = makeRequest({ cwd: root, allowedSkills: ["ravi-system-tasks"], settingSources: ["project"] });
    const out = withLocalSkillsPreserved(req).allowedSkills ?? [];
    expect(out).not.toContain("not-a-skill");
    expect(out).toContain("ravi-system-tasks");
  });

  test("skips project skills when settingSources excludes 'project'", () => {
    const cwd = makeAgentWorkspace(["swarm-orchestrator"]);
    const req = makeRequest({ cwd, allowedSkills: ["ravi-system-tasks"], settingSources: ["user"] });
    const out = withLocalSkillsPreserved(req).allowedSkills ?? [];
    expect(out).not.toContain("swarm-orchestrator");
  });
});
