import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ContextCapability } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  canWithCapabilities,
  canWithCapabilityContext,
  isAgentSuperadmin,
  isDelegatedAuthorityContext,
  matchPattern,
  type CapabilityContextLike,
} from "./capability-context.js";
import { grantRelation } from "./relations.js";

let stateDir: string | null = null;

function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId };
}

function grant(subjectId: string, relation: string, objectType: string, objectId: string) {
  grantRelation("agent", subjectId, relation, objectType, objectId, "manual", { permanent: true });
}

describe("capability-context snapshot matcher", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-capability-context-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  describe("canWithCapabilities", () => {
    it("matches an exact capability", () => {
      expect(canWithCapabilities([cap("use", "tool", "Bash")], "use", "tool", "Bash")).toBe(true);
      expect(canWithCapabilities([cap("use", "tool", "Bash")], "use", "tool", "Read")).toBe(false);
    });

    it("matches a wildcard object id", () => {
      expect(canWithCapabilities([cap("use", "tool", "*")], "use", "tool", "Bash")).toBe(true);
    });

    it("matches a trailing-pattern object id", () => {
      expect(canWithCapabilities([cap("access", "session", "dev-*")], "access", "session", "dev-grupo1")).toBe(true);
      expect(canWithCapabilities([cap("access", "session", "dev-*")], "access", "session", "prod-1")).toBe(false);
    });

    it("resolves tool-group membership for use tool", () => {
      // read-only is a real tool group; assert a known read tool resolves via the group.
      expect(canWithCapabilities([cap("use", "toolgroup", "read-only")], "use", "tool", "Read")).toBe(true);
      expect(canWithCapabilities([cap("use", "toolgroup", "read-only")], "use", "tool", "Bash")).toBe(false);
    });

    it("short-circuits on admin system:*", () => {
      expect(canWithCapabilities([cap("admin", "system", "*")], "use", "tool", "Bash")).toBe(true);
      expect(canWithCapabilities([cap("admin", "system", "*")], "execute", "group", "anything")).toBe(true);
    });

    it("denies on an empty capability set", () => {
      expect(canWithCapabilities([], "use", "tool", "Bash")).toBe(false);
    });
  });

  describe("isDelegatedAuthorityContext", () => {
    it("recognizes turn-runtime and invocation-runtime kinds", () => {
      expect(isDelegatedAuthorityContext({ kind: "turn-runtime" })).toBe(true);
      expect(isDelegatedAuthorityContext({ kind: "invocation-runtime" })).toBe(true);
    });

    it("recognizes the delegated authorityMode flag", () => {
      expect(isDelegatedAuthorityContext({ kind: "other", metadata: { authorityMode: "delegated" } })).toBe(true);
    });

    it("treats agent-runtime as non-delegated", () => {
      expect(isDelegatedAuthorityContext({ kind: "agent-runtime" })).toBe(false);
    });
  });

  describe("canWithCapabilityContext superadmin boundary", () => {
    it("lets a live superadmin grant win for a non-delegated agent context", () => {
      grant("admin-agent", "admin", "system", "*");
      const context: CapabilityContextLike = {
        agentId: "admin-agent",
        kind: "agent-runtime",
        capabilities: [],
      };
      expect(canWithCapabilityContext(context, "use", "tool", "Bash")).toBe(true);
    });

    it("does NOT let a live superadmin grant widen a delegated context", () => {
      grant("admin-agent", "admin", "system", "*");
      const context: CapabilityContextLike = {
        agentId: "admin-agent",
        kind: "turn-runtime",
        capabilities: [cap("use", "tool", "Read")],
        metadata: { authorityMode: "delegated" },
      };
      // Read is in the effective snapshot, Bash is not; live superadmin must not widen.
      expect(canWithCapabilityContext(context, "use", "tool", "Read")).toBe(true);
      expect(canWithCapabilityContext(context, "use", "tool", "Bash")).toBe(false);
    });

    it("picks up a live grant added after an agent-runtime context was issued", () => {
      const context: CapabilityContextLike = {
        agentId: "dev",
        kind: "agent-runtime",
        capabilities: [],
      };
      expect(canWithCapabilityContext(context, "execute", "group", "sessions_info")).toBe(false);
      grant("dev", "execute", "group", "sessions_info");
      expect(canWithCapabilityContext(context, "execute", "group", "sessions_info")).toBe(true);
    });

    it("does not consult live grants for a delegated context (snapshot is the bound)", () => {
      const context: CapabilityContextLike = {
        agentId: "dev",
        kind: "turn-runtime",
        capabilities: [],
        metadata: { authorityMode: "delegated" },
      };
      grant("dev", "execute", "group", "sessions_info");
      // Delegated contexts ignore live agent grants in the snapshot evaluator.
      expect(canWithCapabilityContext(context, "execute", "group", "sessions_info")).toBe(false);
    });
  });

  describe("helpers", () => {
    it("isAgentSuperadmin reflects the live admin grant", () => {
      expect(isAgentSuperadmin("x")).toBe(false);
      grant("x", "admin", "system", "*");
      expect(isAgentSuperadmin("x")).toBe(true);
    });

    it("matchPattern handles exact and trailing wildcard", () => {
      expect(matchPattern("dev-*", "dev-1")).toBe(true);
      expect(matchPattern("dev-1", "dev-1")).toBe(true);
      expect(matchPattern("dev-*", "prod-1")).toBe(false);
    });
  });
});
