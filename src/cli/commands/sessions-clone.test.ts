import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getOrCreateSession } from "../../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { runWithContext, type ToolContext } from "../context.js";
import { SessionCommands } from "./sessions.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sessions-clone-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const AGENT_TURN: ToolContext = {
  contextId: "ctx_main",
  agentId: "main",
  sessionKey: "agent:main:main",
  sessionName: "main",
  context: {
    contextId: "ctx_main",
    contextKey: "rctx_main",
    kind: "agent-runtime",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionName: "main",
    capabilities: [{ permission: "*", objectType: "*", objectId: "*", source: "test" }],
    createdAt: 0,
  },
};

describe("ravi sessions clone --invite", () => {
  it("is refused from a turn: the copied history must not reach people a turn chose", async () => {
    getOrCreateSession("agent:main:main", "main", "/tmp/main", { name: "main" });
    let error: unknown;
    await runWithContext(AGENT_TURN, async () => {
      try {
        await new SessionCommands().clone("pesquisa", "main", undefined, "U0OTHER", true, true);
      } catch (caught) {
        error = caught;
      }
    });
    expect((error as { code?: string } | undefined)?.code).toBe("CLONE_INVITE_REQUIRES_OPERATOR");
  });
});
