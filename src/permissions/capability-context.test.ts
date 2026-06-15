import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ContextCapability } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  canWithCapabilities,
  canWithCapabilityContext,
  isDelegatedAuthorityContext,
  matchPattern,
  type CapabilityContextLike,
} from "./capability-context.js";

let stateDir: string | null = null;

function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId };
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

  describe("canWithCapabilityContext", () => {
    it("uses only capabilities already present in the context snapshot", () => {
      const context: CapabilityContextLike = {
        agentId: "dev",
        kind: "agent-runtime",
        capabilities: [cap("use", "tool", "Read")],
      };

      expect(canWithCapabilityContext(context, "use", "tool", "Read")).toBe(true);
      expect(canWithCapabilityContext(context, "use", "tool", "Bash")).toBe(false);
    });

    it("treats admin system:* as a snapshot capability, not a live lookup", () => {
      const context: CapabilityContextLike = {
        agentId: "admin-agent",
        kind: "agent-runtime",
        capabilities: [cap("admin", "system", "*")],
      };

      expect(canWithCapabilityContext(context, "use", "tool", "Bash")).toBe(true);
      expect(canWithCapabilityContext(context, "execute", "group", "daemon")).toBe(true);
    });

    it("keeps agent-runtime contexts bounded to the issued snapshot", () => {
      const context: CapabilityContextLike = {
        agentId: "dev",
        kind: "agent-runtime",
        capabilities: [],
      };

      expect(canWithCapabilityContext(context, "execute", "group", "sessions_info")).toBe(false);
    });
  });

  describe("helpers", () => {
    it("matchPattern handles exact and trailing wildcard", () => {
      expect(matchPattern("dev-*", "dev-1")).toBe(true);
      expect(matchPattern("dev-1", "dev-1")).toBe(true);
      expect(matchPattern("dev-*", "prod-1")).toBe(false);
    });
  });
});
