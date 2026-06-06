import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { buildEffectiveCapabilities, snapshotSubjectCapabilities } from "./delegation.js";
import { can, agentCan, canWithCapabilityContext, canWithCapabilities } from "./engine.js";
import { grantRelation } from "./relations.js";

let stateDir: string | null = null;

function makeToolContext(input: {
  agentId?: string;
  kind?: string;
  capabilities: ContextCapability[];
  metadata?: Record<string, unknown>;
}): ToolContext {
  const context: ContextRecord = {
    contextId: `test-${input.agentId ?? "unknown"}`,
    contextKey: `test-key-${input.agentId ?? "unknown"}`,
    kind: input.kind ?? "test-runtime",
    agentId: input.agentId,
    capabilities: input.capabilities,
    metadata: input.metadata,
    createdAt: 0,
  };

  return {
    agentId: input.agentId,
    context,
  };
}

// Helper to add a relation
function grant(
  subjectType: string,
  subjectId: string,
  relation: string,
  objectType: string,
  objectId: string,
  source = "manual",
) {
  grantRelation(subjectType, subjectId, relation, objectType, objectId, source);
}

// ============================================================================
// Tests
// ============================================================================

describe("REBAC Engine", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-permissions-engine-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  // --------------------------------------------------------------------------
  // agentCan
  // --------------------------------------------------------------------------

  describe("agentCan", () => {
    it("allows everything when agentId is undefined (CLI direct)", () => {
      expect(agentCan(undefined, "use", "tool", "Bash")).toBe(true);
      expect(agentCan(undefined, "execute", "executable", "rm")).toBe(true);
      expect(agentCan(undefined, "admin", "system", "*")).toBe(true);
    });

    it("denies when no relations exist", () => {
      expect(agentCan("test", "use", "tool", "Bash")).toBe(false);
      expect(agentCan("test", "execute", "executable", "git")).toBe(false);
    });

    it("delegates to can() with agent subject type", () => {
      grant("agent", "dev", "use", "tool", "Bash");
      expect(agentCan("dev", "use", "tool", "Bash")).toBe(true);
      expect(agentCan("dev", "use", "tool", "Read")).toBe(false);
    });

    it("uses scoped context capabilities when available", () => {
      grant("agent", "dev", "use", "tool", "*");
      const context = makeToolContext({
        agentId: "dev",
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Read" }],
      });

      expect(runWithContext(context, () => agentCan("dev", "use", "tool", "Read"))).toBe(true);
      expect(runWithContext(context, () => agentCan("dev", "use", "tool", "Bash"))).toBe(false);
    });

    it("lets live superadmin bypass stale scoped capabilities", () => {
      const context = makeToolContext({
        agentId: "dev",
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Read" }],
      });

      expect(runWithContext(context, () => agentCan("dev", "use", "tool", "Bash"))).toBe(false);

      grant("agent", "dev", "admin", "system", "*");

      expect(runWithContext(context, () => agentCan("dev", "use", "tool", "Bash"))).toBe(true);
      expect(runWithContext(context, () => agentCan("dev", "execute", "executable", "pwd"))).toBe(true);
      expect(runWithContext(context, () => agentCan("dev", "execute", "executable", "rg"))).toBe(true);
      expect(runWithContext(context, () => agentCan("dev", "execute", "group", "anything"))).toBe(true);
      expect(runWithContext(context, () => agentCan("dev", "access", "session", "any-session"))).toBe(true);
      expect(runWithContext(context, () => agentCan("dev", "modify", "session", "any-session"))).toBe(true);
    });

    it("does not let live superadmin bypass delegated scoped capabilities", () => {
      grant("agent", "dev", "admin", "system", "*");
      const context = makeToolContext({
        agentId: "dev",
        kind: "turn-runtime",
        metadata: { authorityMode: "delegated" },
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Read" }],
      });

      expect(runWithContext(context, () => agentCan("dev", "use", "tool", "Read"))).toBe(true);
      expect(runWithContext(context, () => agentCan("dev", "use", "tool", "Bash"))).toBe(false);
      expect(runWithContext(context, () => agentCan("dev", "execute", "executable", "pwd"))).toBe(false);
    });

    it("lets live superadmin bypass stale explicit capability contexts", () => {
      const context = {
        agentId: "dev",
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Read" }],
      };

      expect(canWithCapabilityContext(context, "execute", "group", "daemon")).toBe(false);

      grant("agent", "dev", "admin", "system", "*");

      expect(canWithCapabilityContext(context, "execute", "group", "daemon")).toBe(true);
      expect(canWithCapabilityContext(context, "execute", "executable", "rg")).toBe(true);
      expect(canWithCapabilityContext(context, "access", "session", "main")).toBe(true);
      expect(canWithCapabilityContext(context, "modify", "session", "main")).toBe(true);
    });

    it("does not let live superadmin bypass explicit delegated capability contexts", () => {
      const context = {
        kind: "invocation-runtime",
        agentId: "dev",
        metadata: { authorityMode: "delegated" },
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Read" }],
      };
      grant("agent", "dev", "admin", "system", "*");

      expect(canWithCapabilityContext(context, "use", "tool", "Read")).toBe(true);
      expect(canWithCapabilityContext(context, "execute", "group", "daemon")).toBe(false);
      expect(canWithCapabilityContext(context, "execute", "executable", "rg")).toBe(false);
    });

    it("lets live grants augment stale agent runtime context capabilities", () => {
      const context = makeToolContext({
        agentId: "dev",
        kind: "agent-runtime",
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Read" }],
      });

      expect(runWithContext(context, () => agentCan("dev", "execute", "group", "agents_create"))).toBe(false);

      grant("agent", "dev", "execute", "group", "agents_create");

      expect(runWithContext(context, () => agentCan("dev", "execute", "group", "agents_create"))).toBe(true);
    });

    it("keeps derived contexts snapshot-based after live grants", () => {
      const context = makeToolContext({
        agentId: "dev",
        kind: "cli-runtime",
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Read" }],
      });

      grant("agent", "dev", "execute", "group", "agents_create");

      expect(runWithContext(context, () => agentCan("dev", "execute", "group", "agents_create"))).toBe(false);
    });

    it("ignores scoped capabilities from another agent", () => {
      grant("agent", "dev", "use", "tool", "Bash");
      const context = makeToolContext({
        agentId: "other",
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Read" }],
      });

      expect(runWithContext(context, () => agentCan("dev", "use", "tool", "Bash"))).toBe(true);
    });
  });

  describe("delegated effective capabilities", () => {
    it("narrows agent wildcard grants by actor and surface grants", () => {
      const effective = buildEffectiveCapabilities({
        agentCapabilities: [{ permission: "use", objectType: "tool", objectId: "*" }],
        actorCapabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
        surfaceCapabilities: [{ permission: "use", objectType: "tool", objectId: "*" }],
      });

      expect(canWithCapabilities(effective, "use", "tool", "Bash")).toBe(true);
      expect(canWithCapabilities(effective, "use", "tool", "Read")).toBe(false);
      expect(effective).toEqual([{ permission: "use", objectType: "tool", objectId: "Bash", source: "effective" }]);
    });

    it("keeps role-expanded toolgroups inside a delegated effective context", () => {
      const effective = buildEffectiveCapabilities({
        agentCapabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
        actorCapabilities: [{ permission: "use", objectType: "toolgroup", objectId: "read-only" }],
        surfaceCapabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
      });

      expect(canWithCapabilities(effective, "use", "tool", "Read")).toBe(true);
      expect(canWithCapabilities(effective, "use", "tool", "Bash")).toBe(false);
    });

    it("expands contact role membership into actor capabilities", () => {
      grant("contact", "luis", "member", "role", "operators");
      grant("role", "operators", "use", "tool", "Bash");
      grant("role", "operators", "execute", "executable", "git");

      const capabilities = snapshotSubjectCapabilities("contact", "luis");

      expect(capabilities).toContainEqual({
        permission: "use",
        objectType: "tool",
        objectId: "Bash",
        source: "role:operators/manual",
      });
      expect(capabilities).toContainEqual({
        permission: "execute",
        objectType: "executable",
        objectId: "git",
        source: "role:operators/manual",
      });
      expect(capabilities.some((capability) => capability.permission === "member")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Superadmin
  // --------------------------------------------------------------------------

  describe("superadmin", () => {
    it("allows everything for superadmin", () => {
      grant("agent", "main", "admin", "system", "*");

      expect(can("agent", "main", "use", "tool", "Bash")).toBe(true);
      expect(can("agent", "main", "execute", "executable", "rm")).toBe(true);
      expect(can("agent", "main", "access", "session", "anything")).toBe(true);
      expect(can("agent", "main", "write_contacts", "system", "*")).toBe(true);
    });

    it("non-admin is not superadmin", () => {
      grant("agent", "dev", "use", "tool", "Bash");
      expect(can("agent", "dev", "execute", "executable", "rm")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Direct relations
  // --------------------------------------------------------------------------

  describe("direct relations", () => {
    it("matches exact relation", () => {
      grant("agent", "dev", "use", "tool", "Bash");
      expect(can("agent", "dev", "use", "tool", "Bash")).toBe(true);
    });

    it("does not match different permission", () => {
      grant("agent", "dev", "use", "tool", "Bash");
      expect(can("agent", "dev", "execute", "tool", "Bash")).toBe(false);
    });

    it("does not match different object type", () => {
      grant("agent", "dev", "use", "tool", "Bash");
      expect(can("agent", "dev", "use", "executable", "Bash")).toBe(false);
    });

    it("does not match different subject", () => {
      grant("agent", "dev", "use", "tool", "Bash");
      expect(can("agent", "other", "use", "tool", "Bash")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Wildcard on objectId
  // --------------------------------------------------------------------------

  describe("wildcard on objectId", () => {
    it("wildcard covers any objectId", () => {
      grant("agent", "dev", "use", "tool", "*");

      expect(can("agent", "dev", "use", "tool", "Bash")).toBe(true);
      expect(can("agent", "dev", "use", "tool", "Read")).toBe(true);
      expect(can("agent", "dev", "use", "tool", "Edit")).toBe(true);
    });

    it("wildcard does not cross object types", () => {
      grant("agent", "dev", "use", "tool", "*");
      expect(can("agent", "dev", "use", "executable", "git")).toBe(false);
    });

    it("wildcard does not cross permissions", () => {
      grant("agent", "dev", "use", "tool", "*");
      expect(can("agent", "dev", "execute", "tool", "Bash")).toBe(false);
    });

    it("checking for wildcard directly still works", () => {
      grant("agent", "dev", "execute", "executable", "*");
      expect(can("agent", "dev", "execute", "executable", "*")).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Pattern matching
  // --------------------------------------------------------------------------

  describe("pattern matching", () => {
    it("matches prefix pattern (dev-*)", () => {
      grant("agent", "dev", "access", "session", "dev-*");

      expect(can("agent", "dev", "access", "session", "dev-grupo1")).toBe(true);
      expect(can("agent", "dev", "access", "session", "dev-ravi-dev")).toBe(true);
      expect(can("agent", "dev", "access", "session", "dev-")).toBe(true);
    });

    it("does not match non-matching prefix", () => {
      grant("agent", "dev", "access", "session", "dev-*");

      expect(can("agent", "dev", "access", "session", "main")).toBe(false);
      expect(can("agent", "dev", "access", "session", "test-foo")).toBe(false);
    });

    it("pattern does not match when checking wildcard objectId", () => {
      grant("agent", "dev", "access", "session", "dev-*");
      // Asking "can dev access session:*" should NOT match pattern "dev-*"
      expect(can("agent", "dev", "access", "session", "*")).toBe(false);
    });

    it("multiple patterns can coexist", () => {
      grant("agent", "dev", "access", "session", "dev-*");
      grant("agent", "dev", "access", "session", "test-*");

      expect(can("agent", "dev", "access", "session", "dev-foo")).toBe(true);
      expect(can("agent", "dev", "access", "session", "test-bar")).toBe(true);
      expect(can("agent", "dev", "access", "session", "main")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Resolution order
  // --------------------------------------------------------------------------

  describe("resolution order", () => {
    it("superadmin beats everything (no other grants needed)", () => {
      grant("agent", "main", "admin", "system", "*");
      // No explicit tool grant, but superadmin covers it
      expect(can("agent", "main", "use", "tool", "Bash")).toBe(true);
    });

    it("direct relation checked before wildcard", () => {
      grant("agent", "dev", "use", "tool", "Bash");
      // Direct match found, wildcard not needed
      expect(can("agent", "dev", "use", "tool", "Bash")).toBe(true);
    });

    it("wildcard checked before pattern", () => {
      grant("agent", "dev", "access", "session", "*");
      // Wildcard covers everything, no pattern needed
      expect(can("agent", "dev", "access", "session", "dev-foo")).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe("edge cases", () => {
    it("empty relations = deny all", () => {
      expect(can("agent", "dev", "use", "tool", "Bash")).toBe(false);
    });

    it("different subject types are isolated", () => {
      grant("team", "engineering", "use", "tool", "Bash");
      expect(can("agent", "engineering", "use", "tool", "Bash")).toBe(false);
      expect(can("team", "engineering", "use", "tool", "Bash")).toBe(true);
    });

    it("admin on non-system does not make superadmin", () => {
      grant("agent", "dev", "admin", "group", "contacts");
      // Not superadmin — admin must be on system:*
      expect(can("agent", "dev", "use", "tool", "Bash")).toBe(false);
    });
  });
});
