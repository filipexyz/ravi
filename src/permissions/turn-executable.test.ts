import { describe, expect, it } from "bun:test";
import { resolveRaviAppCommand } from "../apps/command.js";
import { runWithContext, type ToolContext } from "../cli/context.js";

function turn(
  capabilities: ToolContext["context"] extends infer C ? (C extends { capabilities: infer K } ? K : never) : never,
): ToolContext {
  return {
    contextId: "ctx_person",
    agentId: "full-agent",
    context: {
      contextId: "ctx_person",
      contextKey: "rctx_person",
      kind: "turn-runtime",
      agentId: "full-agent",
      capabilities,
      metadata: { actorBreakGlassWithheld: ["admin:system:*", "execute:executable:*"] },
      createdAt: 0,
    },
  };
}

const personHeldBelowBreakGlass = turn([
  { permission: "admin", objectType: "system", objectId: "*" },
  { permission: "execute", objectType: "executable", objectId: "*" },
  { permission: "deny_admin", objectType: "system", objectId: "*" },
  { permission: "deny_execute", objectType: "executable", objectId: "*" },
]);

describe("app commands spawn only what the turn may execute", () => {
  it("refuses an arbitrary executable (apps import-cli 'sh script', apps run) for a person held below break-glass", () => {
    expect(() =>
      runWithContext(personHeldBelowBreakGlass, () => resolveRaviAppCommand("sh /tmp/x.sh", ["manifest", "--json"])),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() =>
      runWithContext(personHeldBelowBreakGlass, () => resolveRaviAppCommand("/usr/bin/python3 -c 'x'")),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });

  it("still lets Ravi itself run, and code outside a turn spawn as before", () => {
    expect(() =>
      runWithContext(personHeldBelowBreakGlass, () =>
        resolveRaviAppCommand("ravi apps list", [], { execPath: "/bin/bun", entrypoint: "/tmp/ravi.js" }),
      ),
    ).not.toThrow();
    expect(resolveRaviAppCommand("sh /tmp/x.sh").executable).toBe("sh");
  });

  it("lets an explicit, exact executable grant through", () => {
    const withExplicit = turn([
      { permission: "execute", objectType: "executable", objectId: "omie" },
      { permission: "deny_execute", objectType: "executable", objectId: "*" },
    ]);
    expect(() => runWithContext(withExplicit, () => resolveRaviAppCommand("omie orders list"))).not.toThrow();
  });
});
