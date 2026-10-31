import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { runWithContext, type ToolContext } from "../context.js";
import { dbSetSetting } from "../../router/router-db.js";
import { getOrCreateSession } from "../../router/sessions.js";
import { findSignal } from "../../signals/service.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { SignalsCommands } from "./signals.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-signals-raise-owner-");
  dbSetSetting("signals.enabled", "true");
  for (const agentId of ["crm", "intruder"]) {
    getOrCreateSession(`agent:${agentId}:main`, agentId, stateDir, { name: agentId });
  }
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
    sessionName: agentId,
    context: {
      contextId: `ctx_${agentId}`,
      contextKey: `rctx_${agentId}`,
      kind: "agent-runtime",
      agentId,
      sessionKey,
      sessionName: agentId,
      capabilities: [{ permission: "execute", objectType: "group", objectId: "signals", source: "test" }],
      createdAt: 0,
    },
  };
}

function raise(key: string, title: string, source?: string) {
  const args: unknown[] = [key, "judgment", undefined, title]; // Default to the caller's agent scope.
  args[13] = "1h"; // --clear-decay
  args[24] = source; // --source
  args[25] = true; // --json
  return (new SignalsCommands().raise as (...values: unknown[]) => unknown)(...args);
}

describe("signals raise binds the producer to the calling agent", () => {
  it("refuses re-raising another agent's key, even with --source", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      runWithContext(agentTurn("crm"), () => raise("ops.followup", "Original"));
      const before = findSignal("ops.followup");
      expect(before?.producerId).toBe("agent:crm");
      expect(before?.scopeType).toBe("agent");
      expect(before?.scopeId).toBe("crm");
      expect(before?.targetSessions).toEqual(["crm"]);

      runWithContext(agentTurn("intruder"), () => {
        expect(() => raise("ops.followup", "Rewritten")).toThrow("cross-owner or cross-kind raise is not allowed");
        expect(() => raise("ops.followup", "Rewritten", "agent:crm")).toThrow(
          "cross-owner or cross-kind raise is not allowed",
        );
      });
      expect(findSignal("ops.followup")).toEqual(before);
    } finally {
      log.mockRestore();
    }
  });
});
