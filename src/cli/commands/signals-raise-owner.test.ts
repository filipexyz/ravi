import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { runWithContext, type ToolContext } from "../context.js";
import { dbSetSetting } from "../../router/router-db.js";
import { findSignal } from "../../signals/service.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { SignalsCommands } from "./signals.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-signals-raise-owner-");
  dbSetSetting("signals.enabled", "true");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function agentTurn(agentId: string): ToolContext {
  const sessionKey = `agent:${agentId}:main`;
  return {
    contextId: `ctx_${agentId}`,
    agentId,
    sessionKey,
    sessionName: sessionKey,
    context: {
      contextId: `ctx_${agentId}`,
      contextKey: `rctx_${agentId}`,
      kind: "agent-runtime",
      agentId,
      sessionKey,
      sessionName: sessionKey,
      capabilities: [{ permission: "execute", objectType: "group", objectId: "signals", source: "test" }],
      createdAt: 0,
    },
  };
}

function raise(key: string, title: string, source?: string) {
  const args: unknown[] = [key, "judgment", "fleet", title];
  args[14] = true; // --clear-manual
  args[24] = source; // --source
  args[25] = true; // --json
  return (new SignalsCommands().raise as (...values: unknown[]) => unknown)(...args);
}

describe("signals raise binds the producer to the calling session", () => {
  it("refuses re-raising another session's key, even with --source", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      runWithContext(agentTurn("crm"), () => raise("ops.followup", "Original"));
      const before = findSignal("ops.followup");
      expect(before?.producerId).toBe("session:agent:crm:main");

      runWithContext(agentTurn("intruder"), () => {
        expect(() => raise("ops.followup", "Rewritten")).toThrow("not available");
        expect(() => raise("ops.followup", "Rewritten", "session:agent:crm:main")).toThrow("not available");
      });
      expect(findSignal("ops.followup")?.title).toBe("Original");
    } finally {
      log.mockRestore();
    }
  });
});
