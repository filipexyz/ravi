import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { evaluateBashPermission } from "../bash/hook.js";
import { dbCreateAgent, dbUpdateAgent } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { canWithCapabilities } from "./capability-snapshot.js";
import { materializeSubjectCapabilities } from "./provider-runtime.js";
import { runtimeBootstrapProvider } from "./runtime-bootstrap-provider.js";

/**
 * explicit-only: a public-facing agent holds exactly the capabilities it was
 * granted — no bootstrap floor (tool:*, bun, cat, xargs…) — so a customer chat
 * cannot steer it into reading host files or running code.
 */

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-explicit-only-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function createAgent(id: string, runtimePermissions: Record<string, unknown>) {
  dbCreateAgent({ id, cwd: `/tmp/${id}` });
  dbUpdateAgent(id, { defaults: { runtimePermissions } });
}

describe("explicit-only runtime permission profile", () => {
  it("keeps only the listed capabilities and drops the bootstrap floor", () => {
    createAgent("cofre", {
      profile: "explicit-only",
      capabilities: ["use:tool:Bash", "read:crypto:*", "mutate:crypto:deposit"],
    });

    expect(runtimeBootstrapProvider.materializeCapabilities?.({ type: "agent", id: "cofre" })).toEqual([]);

    const caps = materializeSubjectCapabilities("agent", "cofre");
    const can = (permission: string, objectType: string, objectId: string) =>
      canWithCapabilities(caps, permission, objectType, objectId);
    expect(can("use", "tool", "Bash")).toBe(true);
    expect(can("read", "crypto", "balance")).toBe(true);
    expect(can("mutate", "crypto", "deposit")).toBe(true);

    expect(can("use", "tool", "Read")).toBe(false);
    expect(can("use", "tool", "Write")).toBe(false);
    expect(can("execute", "executable", "bun")).toBe(false);
    expect(can("execute", "executable", "cat")).toBe(false);
    expect(can("execute", "group", "sessions")).toBe(false);
    expect(can("mutate", "crypto.trades", "approve")).toBe(false);
  });

  it("lets the agent run its ravi commands through Bash but nothing around them", () => {
    createAgent("cofre", {
      profile: "explicit-only",
      capabilities: ["use:tool:Bash", "read:crypto:*", "mutate:crypto:deposit"],
    });
    const ctx = {
      agentId: "cofre",
      kind: "test-runtime",
      capabilities: materializeSubjectCapabilities("agent", "cofre"),
    };

    expect(evaluateBashPermission("ravi crypto balance --json", ctx).allowed).toBe(true);
    expect(evaluateBashPermission("ravi crypto deposit 100 --json 2>/dev/null", ctx).allowed).toBe(true);
    for (const command of [
      "bun -e 'console.log(1)'",
      "cat ~/.ravi/crypto-production.db",
      "xargs ravi crypto balance",
      "ravi crypto status > ~/.ravi/crypto-production.db",
      "env -i ./bin/r'a'vi crypto trades approve trd_x --execute",
    ]) {
      expect(evaluateBashPermission(command, ctx).allowed, command).toBe(false);
    }
  });

  it("a bootstrap agent still gets the floor (explicit-only is opt-in)", () => {
    createAgent("worker", { capabilities: ["read:crypto:*"] });
    const caps = materializeSubjectCapabilities("agent", "worker");
    expect(canWithCapabilities(caps, "use", "tool", "Read")).toBe(true);
    expect(canWithCapabilities(caps, "execute", "executable", "bun")).toBe(true);
  });
});
