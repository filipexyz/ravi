import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import type { ContextCapability } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { listPermissionDenials } from "./denials.js";
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
  type ScopeContext,
} from "./scope.js";

// Helpers
function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId, source: "test" };
}

function scopeCtx(
  agentId: string,
  capabilities: ContextCapability[],
  overrides: Partial<ScopeContext> = {},
): ScopeContext {
  const sessionName = overrides.sessionName ?? `${agentId}-main`;
  const sessionKey = overrides.sessionKey ?? `agent:${agentId}:${sessionName}`;
  return {
    agentId,
    sessionName,
    sessionKey,
    context: {
      contextId: "ctx_test",
      contextKey: "rctx_test",
      kind: "agent-runtime",
      agentId,
      sessionKey,
      sessionName,
      capabilities,
      createdAt: 0,
    },
    ...overrides,
  };
}

function toolCtx(
  agentId: string,
  capabilities: ContextCapability[],
  overrides: { contextId?: string; sessionKey?: string; sessionName?: string } = {},
): ToolContext {
  const sessionName = overrides.sessionName ?? `${agentId}-main`;
  const sessionKey = overrides.sessionKey ?? `agent:${agentId}:${sessionName}`;
  return {
    contextId: overrides.contextId ?? "ctx_test",
    agentId,
    sessionKey,
    sessionName,
    context: {
      contextId: overrides.contextId ?? "ctx_test",
      contextKey: "rctx_test",
      kind: "agent-runtime",
      agentId,
      sessionKey,
      sessionName,
      capabilities,
      createdAt: 0,
    },
  };
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
      expect(isScopeEnforced(scopeCtx("main", [cap("admin", "system", "*")]))).toBe(false);
    });

    it("enforced for non-admin agent", () => {
      expect(isScopeEnforced(scopeCtx("dev", [cap("use", "tool", "Bash")]))).toBe(true);
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

      const allowedContext = toolCtx("dev", [cap("execute", "group", "apps_list")], {
        sessionKey: "agent:dev:dev-main",
        sessionName: "dev-main",
      });
      expect(runWithContext(allowedContext, () => enforceScopeCheck("open", "apps", "list").allowed)).toBe(true);
    });

    it("allows CLI groups from the runtime capability snapshot", () => {
      const context = toolCtx("dev", [cap("execute", "group", "*")]);

      expect(runWithContext(context, () => enforceScopeCheck("admin", "daemon", "restart").allowed)).toBe(true);
      expect(runWithContext(context, () => enforceScopeCheck("admin", "agents", "create").allowed)).toBe(true);
    });

    it("allows superadmin commands for a direct operator even when no agent holds admin", () => {
      // Break-glass recovery: an incident that revokes every agent's admin must
      // not lock out the operator CLI. With no agent principal, superadmin-scoped
      // recovery commands stay allowed through the explicit operator-control path.
      const result = enforceScopeCheck("superadmin", "permissions", "grant");
      expect(result.allowed).toBe(true);
    });

    it("denies superadmin commands for a non-admin agent principal", () => {
      process.env.RAVI_AGENT_ID = "dev";
      const result = enforceScopeCheck("superadmin", "permissions", "grant");
      expect(result.allowed).toBe(false);
      expect(result.errorMessage).toContain("requires admin on system:*");
    });

    it("keeps stale agent-runtime contexts isolated from later provider-owned config changes", () => {
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

      expect(runWithContext(context, () => enforceScopeCheck("admin", "agents", "create").allowed)).toBe(false);

      const refreshed = toolCtx("homologacao-solar", [
        { permission: "use", objectType: "tool", objectId: "*" },
        { permission: "execute", objectType: "executable", objectId: "*" },
        cap("execute", "group", "agents_create"),
      ]);

      expect(runWithContext(refreshed, () => enforceScopeCheck("admin", "agents", "create").allowed)).toBe(true);
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

    it("allows delegated command scopes inherited from the actor when the surface has no override, including repeated context ids", () => {
      const context = {
        contextId: "ctx_repeated_delegated",
        agentId: "audit",
        sessionKey: "agent:audit:whatsapp:main:group:120363424239734858",
        sessionName: "audit-2",
        context: {
          contextId: "ctx_repeated_delegated",
          contextKey: "rctx_repeated_delegated",
          kind: "turn-runtime",
          agentId: "audit",
          sessionKey: "agent:audit:whatsapp:main:group:120363424239734858",
          sessionName: "audit-2",
          capabilities: [
            { permission: "execute", objectType: "group", objectId: "context_codex-bash-hook" },
            { permission: "execute", objectType: "group", objectId: "sessions_info" },
          ],
          metadata: {
            authorityMode: "delegated",
            executorAgentId: "audit",
            actorPrincipal: "contact:luis",
            actorCapabilityCount: 2,
            surfacePrincipal: "chat:chat_a6a497c4e546c5eb62c51f25",
            surfaceCapabilityCount: 0,
            effectiveCapabilityCount: 2,
          },
          createdAt: 0,
        },
      } satisfies ToolContext;

      const bashHook = runWithContext(context, () => enforceScopeCheck("open", "context", "codex-bash-hook"));
      const sessionsInfo = runWithContext(context, () => enforceScopeCheck("open", "sessions", "info"));
      const repeatedBashHook = runWithContext(context, () => enforceScopeCheck("open", "context", "codex-bash-hook"));

      expect(bashHook.allowed).toBe(true);
      expect(sessionsInfo.allowed).toBe(true);
      expect(repeatedBashHook.allowed).toBe(true);
      expect(listPermissionDenials({ subjectType: "agent", subjectId: "audit", resolved: false })).toEqual([]);
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
            actorDisplayName: "Pattern Reviewer Delta Sweep",
            surfacePrincipal: "chat:178035101794451@lid",
            surfaceDisplayName: "Sistemas e Workstreams",
            actorCapabilityCount: 0,
            surfaceCapabilityCount: 0,
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
            actorDisplayName: "Pattern Reviewer Delta Sweep",
            surfacePrincipal: "chat:178035101794451@lid",
            surfaceDisplayName: "Sistemas e Workstreams",
            actorCapabilityCount: 0,
            surfaceCapabilityCount: 0,
            effectiveCapabilityCount: 0,
            capabilitiesCount: 0,
          },
          diagnosis: {
            blockType: "delegated_actor_capabilities_empty",
            detail:
              "Delegated scope denied for execute group:chats_lists_members: actor Pattern Reviewer Delta Sweep (automation:cron:7db11046) has 0 capabilities. Grant execute group:chats_lists_members to automation:cron:7db11046.",
            missingPrincipals: ["automation:cron:7db11046"],
            missingPrincipalDetails: [
              {
                branch: "actor",
                principal: "automation:cron:7db11046",
                displayName: "Pattern Reviewer Delta Sweep",
              },
            ],
            recommendedGrantSubjects: ["automation:cron:7db11046"],
          },
        },
      });
      expect(JSON.stringify(denials[0].detail)).not.toContain("rctx_secret");
      expect(JSON.stringify(denials[0].detail)).not.toContain("runtimeProvider");
    });

    it("does not recommend granting delegated access to an unresolved actor principal", () => {
      const context = {
        contextId: "ctx_unknown_actor",
        agentId: "audit",
        sessionKey: "agent:audit:whatsapp:main:group:120363424239734858",
        sessionName: "audit-2",
        context: {
          contextId: "ctx_unknown_actor",
          contextKey: "rctx_unknown_actor",
          kind: "turn-runtime",
          agentId: "audit",
          sessionKey: "agent:audit:whatsapp:main:group:120363424239734858",
          sessionName: "audit-2",
          capabilities: [],
          metadata: {
            authorityMode: "delegated",
            authorityResolver: "turn-scoped-v1",
            actorPrincipal: "unknown",
            actorResolution: "missing_contact",
            surfacePrincipal: "chat:chat_a6a497c4e546c5eb62c51f25",
            surfaceDisplayName: "Ravi - Audit",
            actorCapabilityCount: 0,
            surfaceCapabilityCount: 45,
            effectiveCapabilityCount: 0,
            runtimeProvider: "codex",
          },
          createdAt: 0,
        },
      } satisfies ToolContext;

      const result = runWithContext(context, () => enforceScopeCheck("open", "context", "codex-bash-hook"));

      expect(result.allowed).toBe(false);
      const denials = listPermissionDenials({
        subjectType: "agent",
        subjectId: "audit",
        resolved: false,
      });
      expect(denials).toHaveLength(1);
      expect(denials[0]).toMatchObject({
        detail: {
          context: {
            contextId: "ctx_unknown_actor",
            kind: "turn-runtime",
            actorPrincipal: "unknown",
            actorResolution: "missing_contact",
            surfacePrincipal: "chat:chat_a6a497c4e546c5eb62c51f25",
            surfaceDisplayName: "Ravi - Audit",
            actorCapabilityCount: 0,
            surfaceCapabilityCount: 45,
            effectiveCapabilityCount: 0,
            capabilitiesCount: 0,
          },
          diagnosis: {
            blockType: "delegated_actor_capabilities_empty",
            detail:
              "Delegated scope denied for execute group:context_codex-bash-hook: actor unknown without a resolved contact has 0 capabilities. Resolve the actor contact before granting execute group:context_codex-bash-hook.",
            missingPrincipals: ["unknown"],
            missingPrincipalDetails: [
              {
                branch: "actor",
                principal: "unknown",
                resolution: "missing_contact",
              },
            ],
            recommendedGrantSubjects: [],
          },
        },
      });
      expect(JSON.stringify(denials[0].detail)).not.toContain("Grant execute group:context_codex-bash-hook to unknown");
    });

    it("does not recommend granting agent identity access when the actor is unresolved", () => {
      const context = {
        contextId: "ctx_agent_identity_unknown_actor",
        agentId: "audit",
        sessionKey: "agent:audit:whatsapp:main:group:120363424239734858",
        sessionName: "audit-2",
        context: {
          contextId: "ctx_agent_identity_unknown_actor",
          contextKey: "rctx_agent_identity_unknown_actor",
          kind: "turn-runtime",
          agentId: "audit",
          sessionKey: "agent:audit:whatsapp:main:group:120363424239734858",
          sessionName: "audit-2",
          capabilities: [],
          metadata: {
            authorityMode: "agent-identity",
            authorityResolver: "agent-identity-v1",
            executorAgentId: "audit",
            actorPrincipal: "unknown",
            actorResolution: "missing_contact",
            actorAuthorizationMode: "invoke-only",
            surfacePrincipal: "chat:chat_a6a497c4e546c5eb62c51f25",
            surfaceAuthorizationMode: "compartment",
            agentIdentityPrincipal: "agent_identity:audit:chat:chat_a6a497c4e546c5eb62c51f25",
            agentIdentityCompartment: "chat:chat_a6a497c4e546c5eb62c51f25",
            agentIdentityCapabilityCount: 0,
            actorCapabilityCount: 0,
            surfaceCapabilityCount: 0,
            effectiveCapabilityCount: 0,
          },
          createdAt: 0,
        },
      } satisfies ToolContext;

      const result = runWithContext(context, () => enforceScopeCheck("open", "context", "codex-bash-hook"));

      expect(result.allowed).toBe(false);
      const denials = listPermissionDenials({
        subjectType: "agent",
        subjectId: "audit",
        resolved: false,
      });
      expect(denials).toHaveLength(1);
      expect(denials[0]).toMatchObject({
        detail: {
          context: {
            authorityMode: "agent-identity",
            authorityResolver: "agent-identity-v1",
            actorPrincipal: "unknown",
            actorResolution: "missing_contact",
            actorAuthorizationMode: "invoke-only",
            surfacePrincipal: "chat:chat_a6a497c4e546c5eb62c51f25",
            surfaceAuthorizationMode: "compartment",
            agentIdentityPrincipal: "agent_identity:audit:chat:chat_a6a497c4e546c5eb62c51f25",
            agentIdentityCompartment: "chat:chat_a6a497c4e546c5eb62c51f25",
            agentIdentityCapabilityCount: 0,
            effectiveCapabilityCount: 0,
            capabilitiesCount: 0,
          },
          diagnosis: {
            blockType: "agent_identity_actor_unresolved",
            detail:
              "Agent identity scope denied for execute group:context_codex-bash-hook: actor unknown is not resolved. Resolve the actor identity before granting execute group:context_codex-bash-hook.",
            missingPrincipals: ["unknown"],
            missingPrincipalDetails: [
              {
                branch: "actor",
                principal: "unknown",
                resolution: "missing_contact",
              },
            ],
            recommendedGrantSubjects: [],
          },
        },
      });
      expect(JSON.stringify(denials[0].detail)).not.toContain(
        "Grant execute group:context_codex-bash-hook to agent:audit",
      );
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
      expect(canAccessSession(scopeCtx("dev", [cap("access", "session", "main")]), "main")).toBe(true);
    });

    it("denies without grant", () => {
      expect(canAccessSession({ agentId: "dev" }, "main")).toBe(false);
    });

    it("allows with pattern capability", () => {
      const ctx = scopeCtx("dev", [cap("access", "session", "test-*")]);
      expect(canAccessSession(ctx, "test-foo")).toBe(true);
      expect(canAccessSession(ctx, "main")).toBe(false);
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
      const ctx = scopeCtx("test", [cap("access", "session", "test-*")], { sessionName: "test-own" });
      const result = filterAccessibleSessions(ctx, sessions as any);
      expect(result).toHaveLength(2);
      expect(result.map((s: any) => s.name)).toEqual(["test-foo", "test-bar"]);
    });

    it("includes own session + granted", () => {
      const ctx = scopeCtx("dev", [cap("access", "session", "main")], { sessionName: "dev-grupo" });
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
      expect(canModifySession(scopeCtx("dev", [cap("modify", "session", "test-session")]), "test-session")).toBe(true);
    });

    it("denies without modify grant", () => {
      // access != modify
      expect(canModifySession(scopeCtx("dev", [cap("access", "session", "test-session")]), "test-session")).toBe(false);
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
      expect(canAccessContact(scopeCtx("dev", [cap("write_contacts", "system", "*")]), contact)).toBe(true);
    });

    it("allows with read_own_contacts when contact has agent session", () => {
      const sessions = [{ agentId: "dev" }];
      expect(
        canAccessContact(scopeCtx("dev", [cap("read_own_contacts", "system", "*")]), contact, null, sessions),
      ).toBe(true);
    });

    it("denies with read_own_contacts when contact has no agent session", () => {
      const sessions = [{ agentId: "other" }];
      expect(
        canAccessContact(scopeCtx("dev", [cap("read_own_contacts", "system", "*")]), contact, null, sessions),
      ).toBe(false);
    });

    it("denies with read_own_contacts when no sessions provided", () => {
      expect(canAccessContact(scopeCtx("dev", [cap("read_own_contacts", "system", "*")]), contact)).toBe(false);
    });

    it("allows with read_tagged_contacts matching tag", () => {
      expect(canAccessContact(scopeCtx("dev", [cap("read_tagged_contacts", "system", "vip")]), contact)).toBe(true);
    });

    it("denies with read_tagged_contacts non-matching tag", () => {
      expect(canAccessContact(scopeCtx("dev", [cap("read_tagged_contacts", "system", "enterprise")]), contact)).toBe(
        false,
      );
    });

    it("allows with specific read_contact", () => {
      expect(canAccessContact(scopeCtx("dev", [cap("read_contact", "contact", "abc123")]), contact)).toBe(true);
    });

    it("denies with read_contact on different contact", () => {
      expect(canAccessContact(scopeCtx("dev", [cap("read_contact", "contact", "other-id")]), contact)).toBe(false);
    });

    it("denies with no relevant permissions", () => {
      expect(canAccessContact(scopeCtx("dev", [cap("use", "tool", "Bash")]), contact)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // canWriteContacts
  // --------------------------------------------------------------------------

  describe("canWriteContacts", () => {
    it("allows with write_contacts grant", () => {
      expect(canWriteContacts(scopeCtx("dev", [cap("write_contacts", "system", "*")]))).toBe(true);
    });

    it("denies without write_contacts", () => {
      expect(canWriteContacts(scopeCtx("dev", [cap("read_own_contacts", "system", "*")]))).toBe(false);
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
      expect(canAccessResource(scopeCtx("main", [cap("admin", "system", "*")]), "dev")).toBe(true);
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
