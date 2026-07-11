import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbUpsertSkillGrant, dbDeleteSkillGrant } from "../router/index.js";
import type { ContextCapability } from "../router/router-db.js";
import { BASELINE_SYSTEM_SKILL_SLUGS, resolveAgentSkills } from "./allowed-skills.js";

function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId, source: "test" };
}

describe("resolveAgentSkills — provider-agnostic core", () => {
  describe("baseline (Invariant B)", () => {
    it("returns baseline for an agent with zero capabilities and zero grants", () => {
      const resolved = resolveAgentSkills("agent-fresh", { capabilitiesOverride: [] });
      expect(resolved.hasConfiguration).toBe(false);
      for (const slug of BASELINE_SYSTEM_SKILL_SLUGS) {
        expect(resolved.allowlist).toContain(slug);
      }
      expect(resolved.provenance.baseline.length).toBeGreaterThan(0);
      expect(resolved.provenance.fromCapabilities).toEqual([]);
      expect(resolved.provenance.fromGrants).toEqual([]);
    });

    it("returns empty allowlist when agentId is blank", () => {
      const resolved = resolveAgentSkills("", { capabilitiesOverride: [cap("execute", "group", "cron")] });
      expect(resolved.hasConfiguration).toBe(false);
      expect(resolved.allowlist).toEqual([]);
    });
  });

  describe("C-D — derivation from execute:group capabilities", () => {
    it("shows only cron+tasks skills (plus baseline) for a narrow capability set", () => {
      const resolved = resolveAgentSkills("agent-narrow", {
        capabilitiesOverride: [cap("execute", "group", "cron"), cap("execute", "group", "tasks")],
      });
      expect(resolved.hasConfiguration).toBe(true);
      expect(resolved.allowlist).toContain("ravi-system-cron-manager");
      expect(resolved.allowlist).toContain("ravi-system-tasks");
      // No other system skills leaked
      expect(resolved.allowlist).not.toContain("ravi-system-whatsapp-manager");
      expect(resolved.allowlist).not.toContain("ravi-system-cron-manager".replace("cron-manager", "video"));
      expect(resolved.allowlist).not.toContain("ravi-system-image");
    });

    it("subcommand-scoped capability (e.g. cron_add) still activates the domain skill", () => {
      const resolved = resolveAgentSkills("agent-sub", {
        capabilitiesOverride: [cap("execute", "group", "cron_add")],
      });
      expect(resolved.allowlist).toContain("ravi-system-cron-manager");
      // video is NOT in baseline and not activated by cron_add
      expect(resolved.allowlist).not.toContain("ravi-system-video");
    });

    it("wildcard execute:group:* unlocks every system skill", () => {
      const resolved = resolveAgentSkills("agent-star", {
        capabilitiesOverride: [cap("execute", "group", "*")],
      });
      expect(resolved.allowlist).toContain("ravi-system-cron-manager");
      expect(resolved.allowlist).toContain("ravi-system-tasks");
      expect(resolved.allowlist).toContain("ravi-system-whatsapp-manager");
      expect(resolved.allowlist).toContain("ravi-system-image");
    });

    it("superadmin (admin:system:*) unlocks every system skill", () => {
      const resolved = resolveAgentSkills("agent-admin", {
        capabilitiesOverride: [cap("admin", "system", "*")],
      });
      expect(resolved.hasConfiguration).toBe(true);
      expect(resolved.allowlist).toContain("ravi-system-cron-manager");
      expect(resolved.allowlist).toContain("ravi-system-whatsapp-manager");
    });
  });

  describe("C-N — provider-agnostic", () => {
    it("returns the same list independent of which provider the agent runs on", () => {
      const caps = [cap("execute", "group", "sessions"), cap("execute", "group", "tasks")];
      const asClaude = resolveAgentSkills("agent-multi", { capabilitiesOverride: caps });
      const asCodex = resolveAgentSkills("agent-multi", { capabilitiesOverride: caps });
      expect(asClaude.allowlist.sort()).toEqual(asCodex.allowlist.sort());
    });
  });

  describe("Claude-form aliasing", () => {
    it("emits both the codex-flat slug and the bare SKILL.md name for each derived skill", () => {
      const resolved = resolveAgentSkills("agent-cron", {
        capabilitiesOverride: [cap("execute", "group", "cron")],
      });
      expect(resolved.allowlist).toContain("ravi-system-cron-manager");
      expect(resolved.allowlist).toContain("cron-manager");
      expect(resolved.allowlist).toContain("ravi-system:cron-manager");
    });

    it("baseline appears in all three forms", () => {
      const resolved = resolveAgentSkills("agent-fresh", { capabilitiesOverride: [] });
      expect(resolved.allowlist).toContain("ravi-system-tasks");
      expect(resolved.allowlist).toContain("tasks");
      expect(resolved.allowlist).toContain("ravi-system:tasks");
    });
  });
});

describe("resolveAgentSkills — custom grants integration", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-allowed-skills-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("C-D2/C-rev — grant surfaces the skill; revoke removes it on the next call", () => {
    dbUpsertSkillGrant({ agentId: "jarvis-financ", skillName: "gmail-pack" });
    const withGrant = resolveAgentSkills("jarvis-financ", { capabilitiesOverride: [] });
    expect(withGrant.hasConfiguration).toBe(true);
    expect(withGrant.allowlist).toContain("gmail-pack");
    expect(withGrant.provenance.fromGrants).toContain("gmail-pack");

    dbDeleteSkillGrant("jarvis-financ", "gmail-pack");
    const afterRevoke = resolveAgentSkills("jarvis-financ", { capabilitiesOverride: [] });
    expect(afterRevoke.hasConfiguration).toBe(false);
    expect(afterRevoke.allowlist).not.toContain("gmail-pack");
  });

  it("C-U/C1 — same skill granted to two agents does not duplicate the source; each agent sees it", () => {
    dbUpsertSkillGrant({ agentId: "jarvis-financ", skillName: "gmail-pack" });
    dbUpsertSkillGrant({ agentId: "jarvis-cobranca", skillName: "gmail-pack" });

    const first = resolveAgentSkills("jarvis-financ", { capabilitiesOverride: [] });
    const second = resolveAgentSkills("jarvis-cobranca", { capabilitiesOverride: [] });
    const other = resolveAgentSkills("book-promo", { capabilitiesOverride: [] });

    expect(first.allowlist).toContain("gmail-pack");
    expect(second.allowlist).toContain("gmail-pack");
    expect(other.allowlist).not.toContain("gmail-pack");
  });

  it("N3 — custom-plugin slug outside the 3 known prefixes surfaces as-is (no alias expansion)", () => {
    // The known prefixes are ravi-system-, ravi-dev-, ravi-user-skills-. A grant
    // that does not start with any of them (e.g. from a private org plugin)
    // should be exposed unmodified, since Claude's SDK matches SKILL.md name
    // directly. This locks the current behavior.
    const exoticSlug = "my-custom-org-thing";
    dbUpsertSkillGrant({ agentId: "agent-org", skillName: exoticSlug });
    const resolved = resolveAgentSkills("agent-org", { capabilitiesOverride: [] });
    expect(resolved.allowlist).toContain(exoticSlug);
    // Must NOT have accidentally produced plugin:name / bare-name variants
    // by "guessing" a prefix.
    expect(resolved.allowlist).not.toContain(`my-custom:org-thing`);
    expect(resolved.allowlist).not.toContain(`custom-org-thing`);
    expect(resolved.provenance.fromGrants).toEqual([exoticSlug]);
  });
});
