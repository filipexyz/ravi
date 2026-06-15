import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { buildEffectiveCapabilities } from "./delegation.js";
import { snapshotSubjectCapabilities, snapshotSubjectDelegationOverrides } from "./local-grants-capabilities.js";
import {
  agentCanWithLocalGrants as agentCan,
  canSubjectWithLocalGrants as can,
  canWithCapabilityContext,
} from "./local-grants-provider.js";
import { canWithCapabilities } from "./provider-runtime.js";
import { grantRelation, revokeRelation } from "./relations.js";

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

describe("local grants permission provider", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-local-grants-provider-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  // --------------------------------------------------------------------------
  // agentCan
  // --------------------------------------------------------------------------

  describe("agentCan", () => {
    it("fails closed when agentId is undefined", () => {
      expect(agentCan(undefined, "use", "tool", "Bash")).toBe(false);
      expect(agentCan(undefined, "execute", "executable", "rm")).toBe(false);
      expect(agentCan(undefined, "admin", "system", "*")).toBe(false);
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

    it("re-resolves delegated authority from the live graph when provenance is present", () => {
      grant("agent", "dev", "use", "tool", "Bash");
      grant("contact", "luis", "use", "tool", "Bash");
      const context = {
        kind: "turn-runtime",
        agentId: "dev",
        metadata: {
          authorityMode: "delegated",
          executorAgentId: "dev",
          actorPrincipal: "contact:luis",
          surfacePrincipal: "chat:chat_group_1",
        },
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
      };

      expect(canWithCapabilityContext(context, "use", "tool", "Bash")).toBe(true);

      revokeRelation("contact", "luis", "use", "tool", "Bash");

      expect(canWithCapabilityContext(context, "use", "tool", "Bash")).toBe(false);
    });

    it("allows delegated grants that are present in the live graph even when the snapshot is stale", () => {
      grant("agent", "dev", "execute", "group", "sessions_info");
      grant("contact", "luis", "execute", "group", "sessions_info");
      const context = {
        kind: "turn-runtime",
        agentId: "dev",
        metadata: {
          authorityMode: "delegated",
          executorAgentId: "dev",
          actorPrincipal: "contact:luis",
          surfacePrincipal: "chat:chat_group_1",
        },
        capabilities: [],
      };

      expect(canWithCapabilityContext(context, "execute", "group", "sessions_info")).toBe(true);
    });

    it("preserves turn-scoped grants while rechecking delegated authority against the live graph", () => {
      grant("contact", "luis", "execute", "group", "observer_report");
      const turnGrant = {
        permission: "execute",
        objectType: "group",
        objectId: "observer_report",
        source: "observer-rule",
      };
      const context = {
        kind: "turn-runtime",
        agentId: "dev",
        metadata: {
          authorityMode: "delegated",
          executorAgentId: "dev",
          actorPrincipal: "contact:luis",
          surfacePrincipal: "chat:chat_group_1",
          turnCapabilityCount: 1,
          turnCapabilities: [turnGrant],
        },
        capabilities: [{ ...turnGrant, source: "effective" }],
      };

      expect(canWithCapabilityContext(context, "execute", "group", "observer_report")).toBe(true);

      revokeRelation("contact", "luis", "execute", "group", "observer_report");

      expect(canWithCapabilityContext(context, "execute", "group", "observer_report")).toBe(false);
    });

    it("allows a repeated delegated context after a live actor grant when turn capabilities are serialized", () => {
      const turnGrant = {
        permission: "execute",
        objectType: "group",
        objectId: "observer_report",
        source: "observer-rule",
      };
      const context = {
        kind: "turn-runtime",
        agentId: "dev",
        metadata: {
          authorityMode: "delegated",
          executorAgentId: "dev",
          actorPrincipal: "contact:luis",
          surfacePrincipal: "chat:chat_group_1",
          turnCapabilityCount: 1,
          turnCapabilities: [turnGrant],
        },
        capabilities: [],
      };

      expect(canWithCapabilityContext(context, "execute", "group", "observer_report")).toBe(false);

      grant("contact", "luis", "execute", "group", "observer_report");

      expect(canWithCapabilityContext(context, "execute", "group", "observer_report")).toBe(true);
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

    it("inherits actor capabilities when the delegated surface has no explicit decision", () => {
      const effective = buildEffectiveCapabilities({
        agentCapabilities: [{ permission: "execute", objectType: "group", objectId: "*" }],
        actorCapabilities: [{ permission: "execute", objectType: "group", objectId: "sessions_info" }],
        surfaceCapabilities: [],
      });

      expect(canWithCapabilities(effective, "execute", "group", "sessions_info")).toBe(true);
      expect(effective).toEqual([
        { permission: "execute", objectType: "group", objectId: "sessions_info", source: "effective" },
      ]);
    });

    it("keeps explicit delegated surface deny above actor inheritance", () => {
      const effective = buildEffectiveCapabilities({
        agentCapabilities: [{ permission: "execute", objectType: "group", objectId: "*" }],
        actorCapabilities: [{ permission: "execute", objectType: "group", objectId: "sessions_info" }],
        surfaceCapabilities: [{ permission: "deny_execute", objectType: "group", objectId: "sessions_info" }],
      });

      expect(canWithCapabilities(effective, "execute", "group", "sessions_info")).toBe(false);
      expect(effective).toEqual([]);
    });

    it("does not inherit from the executor when the actor branch lacks the grant", () => {
      const effective = buildEffectiveCapabilities({
        agentCapabilities: [{ permission: "execute", objectType: "group", objectId: "sessions_info" }],
        actorCapabilities: [],
        surfaceCapabilities: [],
      });

      expect(canWithCapabilities(effective, "execute", "group", "sessions_info")).toBe(false);
      expect(effective).toEqual([]);
    });

    it("does not let actor wildcards bypass an explicit delegated surface deny", () => {
      const effective = buildEffectiveCapabilities({
        agentCapabilities: [{ permission: "execute", objectType: "group", objectId: "*" }],
        actorCapabilities: [{ permission: "execute", objectType: "group", objectId: "*" }],
        surfaceCapabilities: [{ permission: "deny_execute", objectType: "group", objectId: "sessions_info" }],
      });

      expect(canWithCapabilities(effective, "execute", "group", "sessions_info")).toBe(false);
      expect(canWithCapabilities(effective, "execute", "group", "context_codex-bash-hook")).toBe(false);
      expect(effective).toEqual([]);
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

    it("lets explicit delegation overrides satisfy a missing actor branch without exceeding the agent", () => {
      const effective = buildEffectiveCapabilities({
        agentCapabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
        actorCapabilities: [],
        surfaceCapabilities: [{ permission: "use", objectType: "tool", objectId: "*" }],
        actorOverrideCapabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
      });

      expect(canWithCapabilities(effective, "use", "tool", "Bash")).toBe(true);
      expect(canWithCapabilities(effective, "use", "tool", "Read")).toBe(false);
      expect(effective).toEqual([{ permission: "use", objectType: "tool", objectId: "Bash", source: "effective" }]);
    });

    it("does not let delegation overrides grant beyond the executor agent ceiling", () => {
      const effective = buildEffectiveCapabilities({
        agentCapabilities: [{ permission: "use", objectType: "tool", objectId: "Read" }],
        actorCapabilities: [],
        surfaceCapabilities: [{ permission: "use", objectType: "tool", objectId: "*" }],
        actorOverrideCapabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
      });

      expect(canWithCapabilities(effective, "use", "tool", "Bash")).toBe(false);
      expect(canWithCapabilities(effective, "use", "tool", "Read")).toBe(false);
      expect(effective).toEqual([]);
    });

    it("lets a surface delegation override satisfy both actor and surface branches", () => {
      const chatOverride = [{ permission: "use", objectType: "tool", objectId: "Bash" }];
      const effective = buildEffectiveCapabilities({
        agentCapabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
        actorCapabilities: [],
        surfaceCapabilities: [],
        actorOverrideCapabilities: chatOverride,
        surfaceOverrideCapabilities: chatOverride,
      });

      expect(canWithCapabilities(effective, "use", "tool", "Bash")).toBe(true);
    });

    it("does not let an agent delegation override bypass a missing surface branch", () => {
      const effective = buildEffectiveCapabilities({
        agentCapabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
        actorCapabilities: [],
        surfaceCapabilities: [],
        actorOverrideCapabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
      });

      expect(canWithCapabilities(effective, "use", "tool", "Bash")).toBe(false);
      expect(effective).toEqual([]);
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

    it("keeps delegation override grants out of normal subject capabilities", () => {
      grant("chat", "chat_group_1", "delegate_use", "tool", "Bash");

      const capabilities = snapshotSubjectCapabilities("chat", "chat_group_1");
      const overrides = snapshotSubjectDelegationOverrides("chat", "chat_group_1");

      expect(capabilities).toEqual([]);
      expect(overrides).toEqual([
        { permission: "use", objectType: "tool", objectId: "Bash", source: "delegate:manual" },
      ]);
    });

    it("ignores delegated superadmin overrides even if they exist in relation storage", () => {
      grant("chat", "chat_group_1", "delegate_admin", "system", "*");

      expect(snapshotSubjectCapabilities("chat", "chat_group_1")).toEqual([]);
      expect(snapshotSubjectDelegationOverrides("chat", "chat_group_1")).toEqual([]);
    });

    it("expands surface constrain role grants into surface capabilities", () => {
      grant("chat", "chat_group_1", "constrain", "role", "public-chat");
      grant("role", "public-chat", "use", "tool", "Read");

      const surfaceCapabilities = snapshotSubjectCapabilities("chat", "chat_group_1", { includeRoles: false });
      const effective = buildEffectiveCapabilities({
        agentCapabilities: [{ permission: "use", objectType: "tool", objectId: "*" }],
        actorCapabilities: [{ permission: "use", objectType: "tool", objectId: "*" }],
        surfaceCapabilities,
      });

      expect(surfaceCapabilities).toContainEqual({
        permission: "use",
        objectType: "tool",
        objectId: "Read",
        source: "constraint:public-chat/manual",
      });
      expect(canWithCapabilities(effective, "use", "tool", "Read")).toBe(true);
      expect(canWithCapabilities(effective, "use", "tool", "Bash")).toBe(false);
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

    it("expands role membership for direct permission checks", () => {
      grant("contact", "luis", "member", "role", "trusted-dev");
      grant("role", "trusted-dev", "use", "tool", "Bash");

      expect(can("contact", "luis", "use", "tool", "Bash")).toBe(true);
      expect(can("contact", "luis", "use", "tool", "Read")).toBe(false);
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
