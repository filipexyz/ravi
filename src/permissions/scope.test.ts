import { describe, expect, it, beforeEach, mock } from "bun:test";

// ============================================================================
// Mock dependencies
// ============================================================================

let relations: Array<{
  subjectType: string;
  subjectId: string;
  relation: string;
  objectType: string;
  objectId: string;
}> = [];

// Mock the relations module
mock.module("./relations.js", () => ({
  hasRelation: (
    subjectType: string,
    subjectId: string,
    relation: string,
    objectType: string,
    objectId: string,
  ): boolean => {
    return relations.some(
      (r) =>
        r.subjectType === subjectType &&
        r.subjectId === subjectId &&
        r.relation === relation &&
        r.objectType === objectType &&
        r.objectId === objectId,
    );
  },
  listRelations: (filter?: { subjectType?: string; subjectId?: string; relation?: string; objectType?: string }) => {
    return relations.filter((r) => {
      if (filter?.subjectType && r.subjectType !== filter.subjectType) return false;
      if (filter?.subjectId && r.subjectId !== filter.subjectId) return false;
      if (filter?.relation && r.relation !== filter.relation) return false;
      if (filter?.objectType && r.objectType !== filter.objectType) return false;
      return true;
    });
  },
}));

// Mock CLI context
let mockContext: { agentId?: string; sessionKey?: string; sessionName?: string } | undefined;

mock.module("../cli/context.js", () => ({
  getContext: () => mockContext,
}));

// Import AFTER mocks
const {
  getScopeContext,
  isScopeEnforced,
  canAccessSession,
  filterAccessibleSessions,
  canModifySession,
  canAccessContact,
  canWriteContacts,
  canAccessResource,
} = await import("./scope");

// Helpers
function grant(subjectType: string, subjectId: string, relation: string, objectType: string, objectId: string) {
  relations.push({ subjectType, subjectId, relation, objectType, objectId });
}

type MinimalSession = { name?: string; sessionKey: string; agentId?: string };

// ============================================================================
// Tests
// ============================================================================

describe("Scope Isolation", () => {
  beforeEach(() => {
    relations = [];
    mockContext = undefined;
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
      mockContext = { agentId: "dev", sessionName: "dev-main", sessionKey: "key" };
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
