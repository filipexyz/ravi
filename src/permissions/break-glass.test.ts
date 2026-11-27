import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { runWithContext } from "../cli/context.js";
import { ADMIN_PERMISSION_PROFILES } from "./apply-grant.js";
import {
  ADMIN_PROFILE_SLUGS,
  agentConfigBreakGlassReasons,
  assertBreakGlassStoreWrite,
  grantProfileBreakGlassReasons,
  assertAgentBreakGlassRaiseAllowed,
  runApprovedBreakGlassGrant,
  setInteractiveTerminalProbeForTests,
  isAdminProfileSlug,
  isBreakGlassCapability,
  profileBreakGlassReasons,
  tagDefinitionBreakGlassReasons,
} from "./break-glass.js";

function cap(value: string) {
  const [permission, objectType, objectId] = value.split(":");
  return { permission: permission!, objectType: objectType!, objectId: objectId! };
}

describe("break-glass power", () => {
  it("keeps the admin profile list identical to the one grants use", () => {
    expect([...ADMIN_PROFILE_SLUGS].sort()).toEqual([...ADMIN_PERMISSION_PROFILES].sort());
  });

  it("counts any admin on system and only the full executable wildcard", () => {
    expect(isBreakGlassCapability(cap("admin:system:*"))).toBe(true);
    expect(isBreakGlassCapability(cap("Admin:System:*"))).toBe(true);
    expect(isBreakGlassCapability(cap("admin:system:anything"))).toBe(true);
    expect(isBreakGlassCapability(cap("execute:executable:*"))).toBe(true);
    expect(isBreakGlassCapability(cap("execute:executable:git*"))).toBe(false);
    expect(isBreakGlassCapability(cap("execute:executable:curl"))).toBe(false);
    expect(isBreakGlassCapability(cap("admin:agent:*"))).toBe(false);
    expect(isBreakGlassCapability(cap("use:tool:*"))).toBe(false);
  });

  it("reads admin profile names in every spelling the contact provider reads", () => {
    for (const spelling of [
      "permission-admin",
      "Permission.Owner",
      "permission_superadmin",
      "PERMISSION:ADMIN",
      "permission-admin-",
    ]) {
      expect(isAdminProfileSlug(spelling)).toBe(true);
    }
    expect(isAdminProfileSlug("permission-administrator")).toBe(false);
  });

  it("names the admin profile and the capabilities that make a profile break-glass", () => {
    expect(profileBreakGlassReasons("permission-owner", [])).toEqual(["permission-owner (admin profile)"]);
    expect(profileBreakGlassReasons("permission-ops", [cap("read:skills:show"), cap("execute:executable:*")])).toEqual([
      "execute:executable:*",
    ]);
    expect(profileBreakGlassReasons("permission-reader", [cap("read:skills:show")])).toEqual([]);
  });

  it("reads a stored definition only when it is a permission profile", () => {
    const metadata = { permissions: { capabilities: ["admin:system:*"] } };
    const base = { slug: "permission-x", label: "x", createdAt: 0, updatedAt: 0 } as never;
    expect(
      tagDefinitionBreakGlassReasons("permission-x", {
        ...(base as object),
        kind: "system",
        source: "permissions",
        metadata,
      } as never),
    ).toEqual(["admin:system:*"]);
    expect(
      tagDefinitionBreakGlassReasons("permission-x", { ...(base as object), kind: "user", metadata } as never),
    ).toEqual([]);
  });

  it("names no channel", () => {
    const source = readFileSync(new URL("./break-glass.ts", import.meta.url), "utf8").toLowerCase();
    for (const channel of ["slack", "whatsapp", "telegram", "omni", "matrix", "discord"]) {
      expect(source).not.toContain(channel);
    }
  });

  it("refuses an asynchronous approved body, so the scope never crosses an await", () => {
    expect(() => runApprovedBreakGlassGrant("test", (async () => 1) as never)).toThrow(/synchronous/);
    expect(runApprovedBreakGlassGrant("test", () => 2)).toBe(2);
  });

  it("ignores malformed capabilities in a definition instead of throwing", () => {
    const malformed = {
      slug: "permission-bad",
      label: "bad",
      createdAt: 0,
      updatedAt: 0,
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: [{ permission: 1, objectType: "system", objectId: "*" }, 42, null] } },
    } as never;
    expect(() => tagDefinitionBreakGlassReasons("permission-bad", malformed)).not.toThrow();
    expect(tagDefinitionBreakGlassReasons("permission-bad", malformed)).toEqual([]);
  });

  it("warns the operator on stderr when a terminal write wakes dormant break-glass", () => {
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      assertAgentBreakGlassRaiseAllowed(
        "test",
        "dormant-agent",
        { profile: "chat-only", capabilities: ["admin:system:*"] },
        { profile: "bootstrap", capabilities: ["admin:system:*"] },
      );
      assertAgentBreakGlassRaiseAllowed("test", "deliberate-agent", null, { profile: "full-access" });
    } finally {
      process.stderr.write = original;
    }
    const output = stderr.join("");
    expect(output).toContain("waking dormant break-glass on agent dormant-agent");
    expect(output).not.toContain("deliberate-agent");
  });

  it("lets the operator terminal on its default credential raise an agent; agents and the gateway stay refused", () => {
    const bootstrapKey = { contextId: "ctx_op", kind: "admin-bootstrap", agentId: "bootstrap" } as never;
    const quiet = <T>(fn: () => T): T => {
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try {
        return fn();
      } finally {
        process.stderr.write = original;
      }
    };
    const raise = () => assertAgentBreakGlassRaiseAllowed("test", "main", null, { profile: "full-access" });
    const terminal = {
      contextOrigin: "default-credential" as const,
      contextId: "ctx_op",
      context: bootstrapKey,
      agentId: "bootstrap",
    };

    // The interactive terminal with no RAVI_* env: the CLI resolved ~/.ravi/credentials.json locally.
    let restore = setInteractiveTerminalProbeForTests(() => true);
    try {
      expect(() => quiet(() => runWithContext(terminal, raise))).not.toThrow();
    } finally {
      restore();
    }

    // The same default credential from a shell with no TTY (a full-access agent that dropped
    // its RAVI_* env) is not the operator.
    restore = setInteractiveTerminalProbeForTests(() => false);
    try {
      expect(() => runWithContext(terminal, raise)).toThrow(/an agent never raises another agent/);
    } finally {
      restore();
    }

    // The same key presented through the gateway is a remote caller, not the terminal.
    expect(() =>
      runWithContext({ transport: "gateway", contextId: "ctx_op", context: bootstrapKey, agentId: "bootstrap" }, raise),
    ).toThrow(/an agent never raises another agent/);

    // An agent turn raising another agent.
    expect(() => runWithContext({ transport: "tool", agentId: "worker" }, raise)).toThrow(
      /an agent never raises another agent/,
    );
  });

  it("keeps a narrow executable pattern narrow, whatever follows the wildcard", () => {
    const definition = {
      slug: "permission-report",
      label: "report",
      createdAt: 0,
      updatedAt: 0,
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["execute:executable:*:report"] } },
    } as never;
    expect(tagDefinitionBreakGlassReasons("permission-report", definition)).toEqual([]);
    expect(grantProfileBreakGlassReasons("permission-report", () => definition)).toEqual([]);
    expect(
      agentConfigBreakGlassReasons(
        { profile: "explicit-only", capabilities: ["execute:executable:*:report"] },
        "stored",
      ),
    ).toEqual([]);
  });

  it("reads a grant profile by the exact stored slug", () => {
    const rootDefinition = {
      slug: "permission-root",
      label: "root",
      createdAt: 0,
      updatedAt: 0,
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["admin:system:*"] } },
    } as never;
    const lookup = (slug: string) => (slug === "permission-root" ? rootDefinition : null);
    expect(grantProfileBreakGlassReasons("permission-root", lookup)).toEqual(["admin:system:*"]);
    expect(grantProfileBreakGlassReasons("permission.root", lookup)).toEqual([]);
    expect(grantProfileBreakGlassReasons("permission-admin", () => null)).toEqual(["permission-admin (admin profile)"]);
  });

  it("closes the approval when the body returns, even for continuations it scheduled", async () => {
    const previous = process.env.RAVI_AGENT_ID;
    process.env.RAVI_AGENT_ID = "scheduled-agent";
    let later: unknown = "not-run";
    try {
      runApprovedBreakGlassGrant("test", () => {
        assertBreakGlassStoreWrite("inside", ["admin:system:*"]);
        void Promise.resolve().then(() => {
          try {
            assertBreakGlassStoreWrite("after return", ["admin:system:*"]);
            later = null;
          } catch (error) {
            later = error;
          }
        });
        return 1;
      });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      if (previous === undefined) delete process.env.RAVI_AGENT_ID;
      else process.env.RAVI_AGENT_ID = previous;
    }
    expect(later).toMatchObject({ code: "FULL_ACCESS_APPROVAL_REQUIRED" });
  });
});
