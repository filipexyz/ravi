import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { canWithCapabilities } from "./capability-context.js";
import {
  buildEffectiveCapabilities,
  materializeDelegatedAuthority,
  snapshotSubjectCapabilities,
  snapshotSubjectDelegationOverrides,
  type AuthorityPrincipal,
} from "./delegation.js";
import { grantRelation } from "./relations.js";

let stateDir: string | null = null;

const AGENT: AuthorityPrincipal = { subjectType: "agent", subjectId: "executor" };
const ACTOR: AuthorityPrincipal = { subjectType: "contact", subjectId: "luis" };
const SURFACE: AuthorityPrincipal = { subjectType: "chat", subjectId: "chat_group_1" };

function grant(subjectType: string, subjectId: string, relation: string, objectType: string, objectId: string) {
  grantRelation(subjectType, subjectId, relation, objectType, objectId, "manual", { permanent: true });
}

function allows(
  result: { effectiveCapabilities: ReturnType<typeof buildEffectiveCapabilities> },
  relation: string,
  objectType: string,
  objectId: string,
): boolean {
  return canWithCapabilities(result.effectiveCapabilities, relation, objectType, objectId);
}

describe("delegated authority materialization", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-delegation-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  describe("intersection", () => {
    it("allows only when agent, actor, and surface all permit", () => {
      grant("agent", "executor", "use", "tool", "*");
      grant("contact", "luis", "use", "tool", "Bash");
      grant("chat", "chat_group_1", "use", "tool", "Bash");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "use", "tool", "Bash")).toBe(true);
    });

    it("denies when the actor lacks the capability even if agent and surface allow", () => {
      grant("agent", "executor", "use", "tool", "*");
      grant("chat", "chat_group_1", "use", "tool", "*");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "use", "tool", "Bash")).toBe(false);
    });

    it("denies when the executor agent ceiling lacks the capability", () => {
      grant("contact", "luis", "use", "tool", "Bash");
      grant("chat", "chat_group_1", "use", "tool", "*");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "use", "tool", "Bash")).toBe(false);
    });
  });

  describe("surface inheritance", () => {
    it("inherits the actor branch when the surface has no decision for the object", () => {
      grant("agent", "executor", "execute", "group", "*");
      grant("contact", "luis", "execute", "group", "sessions_info");
      // surface has no grant/deny/constrain for this object

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "execute", "group", "sessions_info")).toBe(true);
    });

    it("does not inherit a capability the actor does not have", () => {
      grant("agent", "executor", "execute", "group", "*");
      grant("contact", "luis", "execute", "group", "sessions_info");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "execute", "group", "whatsapp_group_create")).toBe(false);
    });

    it("honors an explicit surface grant for the matching object", () => {
      grant("agent", "executor", "use", "tool", "*");
      grant("contact", "luis", "use", "tool", "Bash");
      grant("chat", "chat_group_1", "use", "tool", "Bash");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "use", "tool", "Bash")).toBe(true);
    });
  });

  describe("deny veto", () => {
    it("vetoes a capability that agent, actor, and inheritance would allow", () => {
      grant("agent", "executor", "execute", "group", "*");
      grant("contact", "luis", "execute", "group", "sessions_info");
      grant("chat", "chat_group_1", "deny_execute", "group", "sessions_info");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "execute", "group", "sessions_info")).toBe(false);
    });

    it("vetoes via a wildcard deny on the surface", () => {
      grant("agent", "executor", "use", "tool", "*");
      grant("contact", "luis", "use", "tool", "Bash");
      grant("chat", "chat_group_1", "use", "tool", "Bash");
      grant("chat", "chat_group_1", "deny_use", "tool", "*");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "use", "tool", "Bash")).toBe(false);
    });
  });

  describe("surface constraints", () => {
    it("bounds the surface to the constraint role closure", () => {
      grant("agent", "executor", "execute", "group", "*");
      grant("contact", "luis", "execute", "group", "sessions_info");
      grant("contact", "luis", "execute", "group", "whatsapp_group_create");
      grant("chat", "chat_group_1", "constrain", "role", "public-chat");
      grant("role", "public-chat", "execute", "group", "sessions_info");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "execute", "group", "sessions_info")).toBe(true);
      expect(allows(result, "execute", "group", "whatsapp_group_create")).toBe(false);
    });
  });

  describe("role expansion", () => {
    it("expands nested role membership on the actor branch", () => {
      grant("agent", "executor", "use", "tool", "*");
      grant("contact", "luis", "member", "role", "trusted");
      grant("role", "trusted", "member", "role", "base");
      grant("role", "base", "use", "tool", "Bash");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "use", "tool", "Bash")).toBe(true);
    });

    it("terminates on cyclic role membership", () => {
      grant("agent", "executor", "use", "tool", "*");
      grant("contact", "luis", "member", "role", "a");
      grant("role", "a", "member", "role", "b");
      grant("role", "b", "member", "role", "a");
      grant("role", "b", "use", "tool", "Bash");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "use", "tool", "Bash")).toBe(true);
    });

    it("expands role membership on the executor agent ceiling", () => {
      grant("agent", "executor", "member", "role", "executor-role");
      grant("role", "executor-role", "execute", "group", "sessions_info");
      grant("contact", "luis", "execute", "group", "sessions_info");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "execute", "group", "sessions_info")).toBe(true);
    });
  });

  describe("delegation overrides", () => {
    it("agent-level delegate satisfies only the actor branch, not the surface", () => {
      grant("agent", "executor", "use", "tool", "Bash");
      grant("agent", "executor", "delegate_use", "tool", "Bash");
      // actor has no direct grant; surface has no grant either

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      // actor branch satisfied by override, but surface has no decision -> inherits
      // actor's *direct* branch, which is empty -> denied.
      expect(allows(result, "use", "tool", "Bash")).toBe(false);
    });

    it("agent-level delegate plus a normal surface grant allows the actor", () => {
      grant("agent", "executor", "use", "tool", "Bash");
      grant("agent", "executor", "delegate_use", "tool", "Bash");
      grant("chat", "chat_group_1", "use", "tool", "Bash");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "use", "tool", "Bash")).toBe(true);
    });

    it("surface-level delegate satisfies both the actor and surface branches", () => {
      grant("agent", "executor", "use", "tool", "Bash");
      grant("chat", "chat_group_1", "delegate_use", "tool", "Bash");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "use", "tool", "Bash")).toBe(true);
    });

    it("delegate cannot exceed the executor agent ceiling", () => {
      grant("chat", "chat_group_1", "delegate_use", "tool", "Bash");
      // executor agent lacks use tool:Bash

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: ACTOR,
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "use", "tool", "Bash")).toBe(false);
    });

    it("drops delegate_admin", () => {
      grant("agent", "executor", "admin", "system", "*");
      grant("chat", "chat_group_1", "delegate_admin", "system", "*");

      const overrides = snapshotSubjectDelegationOverrides("chat", "chat_group_1");
      expect(overrides.some((cap) => cap.permission === "admin")).toBe(false);
    });
  });

  describe("automation and unresolved actors", () => {
    it("gives an automation actor no inherited human authority even with a superadmin executor", () => {
      grant("agent", "executor", "admin", "system", "*");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: { subjectType: "automation", subjectId: "cron:job-1" },
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "use", "tool", "Bash")).toBe(false);
      expect(allows(result, "execute", "group", "sessions_info")).toBe(false);
    });

    it("gives an automation actor only its own role grants", () => {
      grant("agent", "executor", "execute", "group", "*");
      grant("automation", "cron:job-1", "member", "role", "automation-base");
      grant("role", "automation-base", "execute", "group", "context_codex-bash-hook");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: { subjectType: "automation", subjectId: "cron:job-1" },
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "execute", "group", "context_codex-bash-hook")).toBe(true);
      expect(allows(result, "execute", "group", "sessions_info")).toBe(false);
    });

    it("does not apply human delegation overrides for automation actors", () => {
      grant("agent", "executor", "use", "tool", "Bash");
      grant("chat", "chat_group_1", "delegate_use", "tool", "Bash");

      const result = materializeDelegatedAuthority({
        agentPrincipal: AGENT,
        actorPrincipal: { subjectType: "automation", subjectId: "cron:job-1" },
        surfacePrincipal: SURFACE,
      });

      expect(allows(result, "use", "tool", "Bash")).toBe(false);
    });
  });

  describe("snapshotSubjectCapabilities", () => {
    it("excludes membership, override, and constraint pseudo-relations", () => {
      grant("contact", "luis", "member", "role", "trusted");
      grant("contact", "luis", "delegate_use", "tool", "Bash");
      grant("contact", "luis", "use", "tool", "Read");
      grant("role", "trusted", "use", "tool", "Bash");

      const caps = snapshotSubjectCapabilities("contact", "luis");

      expect(caps.some((c) => c.permission === "member")).toBe(false);
      expect(caps.some((c) => c.permission === "delegate_use")).toBe(false);
      expect(caps.some((c) => c.permission === "use" && c.objectId === "Read")).toBe(true);
      expect(caps.some((c) => c.permission === "use" && c.objectId === "Bash")).toBe(true);
    });
  });

  describe("buildEffectiveCapabilities edge cases", () => {
    it("intersects without a surface branch when none is provided", () => {
      const effective = buildEffectiveCapabilities({
        agentCapabilities: [{ permission: "use", objectType: "tool", objectId: "*" }],
        actorCapabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
      });

      expect(canWithCapabilities(effective, "use", "tool", "Bash")).toBe(true);
      expect(canWithCapabilities(effective, "use", "tool", "Read")).toBe(false);
    });
  });
});
