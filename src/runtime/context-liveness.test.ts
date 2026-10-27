import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { authorizeRuntimeContext } from "../approval/service.js";
import { enforceCliCommandAccess } from "../cli/command-access.js";
import { runWithContext } from "../cli/context.js";
import { dbCreateAgent, dbListContexts } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { isRuntimeContextLive } from "./context-liveness.js";
import { createRuntimeContext, issueRuntimeContext, revokeRuntimeContext } from "./context-registry.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-context-liveness-");
  dbCreateAgent({ id: "pi-agent", cwd: "/tmp/pi-agent" });
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function revokedTurnContext() {
  const cached = createRuntimeContext({
    kind: "agent-runtime",
    agentId: "pi-agent",
    capabilities: [
      { permission: "execute", objectType: "group", objectId: "sessions" },
      { permission: "use", objectType: "tool", objectId: "Bash" },
    ],
  });
  revokeRuntimeContext(cached.contextId, { reason: "permissions reduced" });
  return cached;
}

describe("a revoked context held in memory", () => {
  it("is not live although the cached copy has no revokedAt", () => {
    const cached = revokedTurnContext();
    expect(cached.revokedAt ?? null).toBeNull();
    expect(isRuntimeContextLive(cached)).toBe(false);
    expect(isRuntimeContextLive({ contextId: "ctx_in_memory_only" })).toBe(true);
  });

  it("no longer authorizes host tools, in-process commands or child contexts", async () => {
    const cached = revokedTurnContext();

    const tool = await authorizeRuntimeContext({
      context: cached,
      permission: "use",
      objectType: "tool",
      objectId: "Bash",
    });
    expect(tool.allowed).toBe(false);

    const command = runWithContext({ agentId: "pi-agent", context: cached }, () =>
      enforceCliCommandAccess({
        group: "sessions",
        command: "list",
        access: { kind: "read", resource: "sessions", action: "list", risk: "low" },
        input: {},
        source: "tool",
      }),
    );
    expect(command.allowed).toBe(false);

    const before = dbListContexts().length;
    expect(() => issueRuntimeContext({ parent: cached, cliName: "child", inheritCapabilities: true })).toThrow(
      "revoked or expired",
    );
    expect(dbListContexts().length).toBe(before);
  });
});
