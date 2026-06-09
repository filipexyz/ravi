import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { listPermissionDenials } from "./denials.js";
import { grantRelation } from "./relations.js";
import {
  getScopeContext,
  isScopeEnforced,
  canAccessSession,
  filterAccessibleSessions,
  canModifySession,
  canAccessContact,
  canWriteContacts,
  canAccessResource,
  enforceScopeCheck,
} from "./scope.js";

// Helpers
function grant(subjectType: string, subjectId: string, relation: string, objectType: string, objectId: string) {
  grantRelation(subjectType, subjectId, relation, objectType, objectId, "test");
}

type MinimalSession = { name?: string; sessionKey: string; agentId?: string };

const CONTEXT_ENV_KEYS = [
  "RAVI_CONTEXT_KEY",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_AGENT_ID",
  "RAVI_CHANNEL",
  "RAVI_ACCOUNT_ID",
  "RAVI_CHAT_ID",
] as const;

let previousContextEnv: Partial<Record<(typeof CONTEXT_ENV_KEYS)[number], string>> = {};
let stateDir: string | null = null;

setDefaultTimeout(20_000);

// ============================================================================
// Tests
// ============================================================================

describe("Scope Isolation", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-permission-scope-test-");
    previousContextEnv = {};
    for (const key of CONTEXT_ENV_KEYS) {
      if (process.env[key] !== undefined) {
        previousContextEnv[key] = process.env[key];
      }
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of CONTEXT_ENV_KEYS) {
      if (previousContextEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousContextEnv[key];
      }
    }
    previousContextEnv = {};
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  // --------------------------------------------------------------------------
  // getScopeContext
  // --------------------------------------------------------------------------

  describe("getScopeContext", () => {
    it("returns empty context when no CLI context", () => {
      const ctx = getScopeContext();
      expect(ctx.agentId).toBeUndefined();
    });

    it("extracts agentId from CLI context", () => {
      process.env.RAVI_AGENT_ID = "dev";
      process.env.RAVI_SESSION_NAME = "dev-main";
      process.env.RAVI_SESSION_KEY = "key";
      const ctx = getScopeContext();
      expect(ctx.agentId).toBe("dev");
      expect(ctx.sessionName).toBe("dev-main");
    });
  });

  // --------------------------------------------------------------------------
  // isScopeEnforced
  // --------------------------------------------------------------------------

  describe("isScopeEnforced", () => {
    it("not enforced when no agentId", () => {
      expect(isScopeEnforced({})).toBe(false);
    });

    it("not enforced for superadmin", () => {
      grant("agent", "main", "admin", "system", "*");
      expect(isScopeEnforced({ agentId: "main" })).toBe(false);
    });

    it("enforced for non-admin agent", () => {
      grant("agent", "dev", "use", "tool", "Bash");
      expect(isScopeEnforced({ agentId: "dev" })).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // enforceScopeCheck
  // --------------------------------------------------------------------------

  describe("enforceScopeCheck", () => {
    it("allows open scope for direct CLI without an agent principal", () => {
      expect(enforceScopeCheck("open", "apps", "list").allowed).toBe(true);
    });

    it("requires an explicit group grant for open scope in agent context", () => {
      process.env.RAVI_AGENT_ID = "dev";
      process.env.RAVI_SESSION_KEY = "agent:dev:dev-main";
      process.env.RAVI_SESSION_NAME = "dev-main";

      const denied = enforceScopeCheck("open", "apps", "list");
      expect(denied.allowed).toBe(false);
      expect(denied.errorMessage).toContain("requires execute on group:apps_list");

      grant("agent", "dev", "execute", "group", "apps_list");
      expect(enforceScopeCheck("open", "apps", "list").allowed).toBe(true);
    });

    it("allows CLI groups for live superadmin with stale runtime capabilities", () => {
      grant("agent", "dev", "admin", "system", "*");
      process.env.RAVI_AGENT_ID = "dev";

      expect(enforceScopeCheck("admin", "daemon", "restart").allowed).toBe(true);
      expect(enforceScopeCheck("admin", "agents", "create").allowed).toBe(true);
    });

    it("allows CLI group grants added after a stale agent-runtime context was issued", () => {
      const context = {
        contextId: "ctx_stale",
        agentId: "homologacao-solar",
        sessionKey: "agent:homologacao-solar:group",
        sessionName: "homologacao-solar",
        context: {
          contextId: "ctx_stale",
          contextKey: "rctx_stale",
          kind: "agent-runtime",
          agentId: "homologacao-solar",
          sessionKey: "agent:homologacao-solar:group",
          sessionName: "homologacao-solar",
          capabilities: [
            { permission: "use", objectType: "tool", objectId: "*" },
            { permission: "execute", objectType: "executable", objectId: "*" },
          ],
          createdAt: 0,
        },
      } satisfies ToolContext;

      grant("agent", "homologacao-solar", "execute", "group", "agents_create");

      expect(runWithContext(context, () => enforceScopeCheck("admin", "agents", "create").allowed)).toBe(true);
    });

    it("records denied CLI group scope with the current session", () => {
      process.env.RAVI_AGENT_ID = "dev";
      process.env.RAVI_SESSION_KEY = "agent:dev:dev-main";
      process.env.RAVI_SESSION_NAME = "dev-main";

      const result = enforceScopeCheck("admin", "agents", "create");

      expect(result.allowed).toBe(false);
      expect(
        listPermissionDenials({
          subjectType: "agent",
          subjectId: "dev",
          resolved: false,
        }),
      ).toContainEqual(
        expect.objectContaining({
          agentId: "dev",
          sessionKey: "agent:dev:dev-main",
          sessionName: "dev-main",
          relation: "execute",
          objectType: "group",
          objectId: "agents_create",
        }),
      );
    });

    it("records safe runtime context provenance for denied CLI group scope", () => {
      const context = {
        contextId: "ctx_turn",
        agentId: "pattern-reviewer",
        sessionKey: "agent:pattern-reviewer:cron:7db11046",
        sessionName: "pattern-reviewer-cron-pattern-reviewer-delta-sweep",
        context: {
          contextId: "ctx_turn",
          contextKey: "rctx_secret",
          kind: "turn-runtime",
          agentId: "pattern-reviewer",
          sessionKey: "agent:pattern-reviewer:cron:7db11046",
          sessionName: "pattern-reviewer-cron-pattern-reviewer-delta-sweep",
          capabilities: [],
          metadata: {
            authorityMode: "delegated",
            actorPrincipal: "automation:cron:7db11046",
            surfacePrincipal: "chat:178035101794451@lid",
            effectiveCapabilityCount: 0,
            runtimeProvider: "codex",
          },
          createdAt: 0,
        },
      } satisfies ToolContext;

      const result = runWithContext(context, () => enforceScopeCheck("open", "chats_lists", "members"));

      expect(result.allowed).toBe(false);
      const denials = listPermissionDenials({
        subjectType: "agent",
        subjectId: "pattern-reviewer",
        resolved: false,
      });
      expect(denials).toHaveLength(1);
      expect(denials[0]).toMatchObject({
        contextId: "ctx_turn",
        detail: {
          context: {
            contextId: "ctx_turn",
            kind: "turn-runtime",
            actorPrincipal: "automation:cron:7db11046",
            surfacePrincipal: "chat:178035101794451@lid",
            effectiveCapabilityCount: 0,
            capabilitiesCount: 0,
          },
        },
      });
      expect(JSON.stringify(denials[0].detail)).not.toContain("rctx_secret");
      expect(JSON.stringify(denials[0].detail)).not.toContain("runtimeProvider");
    });
  });

  // --------------------------------------------------------------------------
  // canAccessSession
  // --------------------------------------------------------------------------

  describe("canAccessSession", () => {
    it("allows when no agentId (CLI direct)", () => {
      expect(canAccessSession({}, "any-session")).toBe(true);
    });

    it("allows own session by name", () => {
      expect(canAccessSession({ agentId: "dev", sessionName: "dev-main" }, "dev-main")).toBe(true);
    });

    it("allows own session by key", () => {
      expect(canAccessSession({ agentId: "dev", sessionKey: "agent:dev:dev-main" }, "agent:dev:dev-main")).toBe(true);
    });

    it("allows with explicit access grant", () => {
      grant("agent", "dev", "access", "session", "main");
      expect(canAccessSession({ agentId: "dev" }, "main")).toBe(true);
    });

    it("denies without grant", () => {
      expect(canAccessSession({ agentId: "dev" }, "main")).toBe(false);
    });

    it("allows with pattern grant", () => {
      grant("agent", "dev", "access", "session", "test-*");
      expect(canAccessSession({ agentId: "dev" }, "test-foo")).toBe(true);
      expect(canAccessSession({ agentId: "dev" }, "main")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // filterAccessibleSessions
  // --------------------------------------------------------------------------

  describe("filterAccessibleSessions", () => {
    const sessions: MinimalSession[] = [
      { name: "main", sessionKey: "agent:main:main" },
      { name: "dev-grupo", sessionKey: "agent:dev:dev-grupo" },
      { name: "test-foo", sessionKey: "agent:test:test-foo" },
      { name: "test-bar", sessionKey: "agent:test:test-bar" },
    ];

    it("returns all when no agentId", () => {
      const result = filterAccessibleSessions({}, sessions as any);
      expect(result).toHaveLength(4);
    });

    it("filters to accessible sessions only", () => {
      grant("agent", "test", "access", "session", "test-*");
      const ctx = { agentId: "test", sessionName: "test-own" };
      const result = filterAccessibleSessions(ctx, sessions as any);
      expect(result).toHaveLength(2);
      expect(result.map((s: any) => s.name)).toEqual(["test-foo", "test-bar"]);
    });

    it("includes own session + granted", () => {
      grant("agent", "dev", "access", "session", "main");
      const ctx = { agentId: "dev", sessionName: "dev-grupo" };
      const result = filterAccessibleSessions(ctx, sessions as any);
      expect(result).toHaveLength(2);
      expect(result.map((s: any) => s.name)).toEqual(["main", "dev-grupo"]);
    });
  });

  // --------------------------------------------------------------------------
  // canModifySession
  // --------------------------------------------------------------------------

  describe("canModifySession", () => {
    it("allows own session", () => {
      expect(canModifySession({ agentId: "dev", sessionName: "dev-main" }, "dev-main")).toBe(true);
    });

    it("allows with modify grant", () => {
      grant("agent", "dev", "modify", "session", "test-session");
      expect(canModifySession({ agentId: "dev" }, "test-session")).toBe(true);
    });

    it("denies without modify grant", () => {
      // access != modify
      grant("agent", "dev", "access", "session", "test-session");
      expect(canModifySession({ agentId: "dev" }, "test-session")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // canAccessContact
  // --------------------------------------------------------------------------

  describe("canAccessContact", () => {
    const contact = { id: "abc123", tags: ["vip", "lead"] };

    it("allows when no agentId", () => {
      expect(canAccessContact({}, contact)).toBe(true);
    });

    it("allows with write_contacts", () => {
      grant("agent", "dev", "write_contacts", "system", "*");
      expect(canAccessContact({ agentId: "dev" }, contact)).toBe(true);
    });

    it("allows with read_own_contacts when contact has agent session", () => {
      grant("agent", "dev", "read_own_contacts", "system", "*");
      const sessions = [{ agentId: "dev" }];
      expect(canAccessContact({ agentId: "dev" }, contact, null, sessions)).toBe(true);
    });

    it("denies with read_own_contacts when contact has no agent session", () => {
      grant("agent", "dev", "read_own_contacts", "system", "*");
      const sessions = [{ agentId: "other" }];
      expect(canAccessContact({ agentId: "dev" }, contact, null, sessions)).toBe(false);
    });

    it("denies with read_own_contacts when no sessions provided", () => {
      grant("agent", "dev", "read_own_contacts", "system", "*");
      expect(canAccessContact({ agentId: "dev" }, contact)).toBe(false);
    });

    it("allows with read_tagged_contacts matching tag", () => {
      grant("agent", "dev", "read_tagged_contacts", "system", "vip");
      expect(canAccessContact({ agentId: "dev" }, contact)).toBe(true);
    });

    it("denies with read_tagged_contacts non-matching tag", () => {
      grant("agent", "dev", "read_tagged_contacts", "system", "enterprise");
      expect(canAccessContact({ agentId: "dev" }, contact)).toBe(false);
    });

    it("allows with specific read_contact", () => {
      grant("agent", "dev", "read_contact", "contact", "abc123");
      expect(canAccessContact({ agentId: "dev" }, contact)).toBe(true);
    });

    it("denies with read_contact on different contact", () => {
      grant("agent", "dev", "read_contact", "contact", "other-id");
      expect(canAccessContact({ agentId: "dev" }, contact)).toBe(false);
    });

    it("denies with no relevant permissions", () => {
      grant("agent", "dev", "use", "tool", "Bash");
      expect(canAccessContact({ agentId: "dev" }, contact)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // canWriteContacts
  // --------------------------------------------------------------------------

  describe("canWriteContacts", () => {
    it("allows with write_contacts grant", () => {
      grant("agent", "dev", "write_contacts", "system", "*");
      expect(canWriteContacts({ agentId: "dev" })).toBe(true);
    });

    it("denies without write_contacts", () => {
      grant("agent", "dev", "read_own_contacts", "system", "*");
      expect(canWriteContacts({ agentId: "dev" })).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // canAccessResource
  // --------------------------------------------------------------------------

  describe("canAccessResource", () => {
    it("allows when no agentId", () => {
      expect(canAccessResource({}, "any")).toBe(true);
    });

    it("allows superadmin", () => {
      grant("agent", "main", "admin", "system", "*");
      expect(canAccessResource({ agentId: "main" }, "dev")).toBe(true);
    });

    it("allows own resource", () => {
      expect(canAccessResource({ agentId: "dev" }, "dev")).toBe(true);
    });

    it("denies other agent's resource", () => {
      expect(canAccessResource({ agentId: "dev" }, "main")).toBe(false);
    });

    it("denies unowned resource for non-superadmin", () => {
      expect(canAccessResource({ agentId: "dev" }, undefined)).toBe(false);
    });
  });
});
