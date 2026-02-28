import { describe, expect, it, beforeEach, mock } from "bun:test";

// ============================================================================
// Mock the relations module (DB-dependent)
// ============================================================================

// In-memory relation store for testing
let relations: Array<{
  subjectType: string;
  subjectId: string;
  relation: string;
  objectType: string;
  objectId: string;
}> = [];

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
  listRelations: (filter?: {
    subjectType?: string;
    subjectId?: string;
    relation?: string;
    objectType?: string;
    objectId?: string;
  }) => {
    return relations.filter((r) => {
      if (filter?.subjectType && r.subjectType !== filter.subjectType) return false;
      if (filter?.subjectId && r.subjectId !== filter.subjectId) return false;
      if (filter?.relation && r.relation !== filter.relation) return false;
      if (filter?.objectType && r.objectType !== filter.objectType) return false;
      if (filter?.objectId && r.objectId !== filter.objectId) return false;
      return true;
    });
  },
}));

// Import AFTER mock setup
const { can, agentCan } = await import("./engine");

// Helper to add a relation
function grant(subjectType: string, subjectId: string, relation: string, objectType: string, objectId: string) {
  relations.push({ subjectType, subjectId, relation, objectType, objectId });
}

// ============================================================================
// Tests
// ============================================================================

describe("REBAC Engine", () => {
  beforeEach(() => {
    relations = [];
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
