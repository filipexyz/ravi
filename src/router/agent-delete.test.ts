import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { AgentsCommands } from "../cli/commands/agents.js";
import {
  dbGetLibraryAgentState,
  dbSetLibraryAgentAcceptsRequests,
  dbSetLibraryAgentDescription,
  dbSetLibraryAgentListed,
} from "../library/agents-db.js";
import { createRuntimeContext, issueRuntimeContext, resolveRuntimeContext } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateAgent, dbDeleteAgent } from "./router-db.js";

setDefaultTimeout(20_000);

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-agent-delete-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("deleting an agent", () => {
  it("leaves no Library listing for a new agent with the same id", () => {
    dbCreateAgent({ id: "concierge", cwd: "/tmp/concierge" });
    dbSetLibraryAgentDescription("concierge", "Answers questions about the old catalog");
    dbSetLibraryAgentListed("concierge", true);
    dbSetLibraryAgentAcceptsRequests("concierge", true);

    expect(dbDeleteAgent("concierge")).toBe(true);
    dbCreateAgent({ id: "concierge", cwd: "/tmp/concierge-new" });

    const state = dbGetLibraryAgentState("concierge");
    expect(state?.listed ?? false).toBe(false);
    expect(state?.acceptsRequests ?? false).toBe(false);
  });

  it("revokes the agent's live context keys and their children", () => {
    dbCreateAgent({ id: "retired", cwd: "/tmp/retired" });
    const turn = createRuntimeContext({
      kind: "agent-runtime",
      agentId: "retired",
      capabilities: [{ permission: "execute", objectType: "group", objectId: "sessions" }],
    });
    const child = issueRuntimeContext({ parent: turn, cliName: "child", inheritCapabilities: true });

    new AgentsCommands().delete("retired", true, true);

    expect(resolveRuntimeContext(turn.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).toBeNull();
  });
});

describe("agent workspace in a turn held below the agent's break-glass", () => {
  it("refuses moving an agent's cwd or creating an agent, but lets other agent updates through", async () => {
    const { runWithContext } = await import("../cli/context.js");
    const { dbUpdateAgent } = await import("./router-db.js");
    dbCreateAgent({ id: "workspace-agent", cwd: "/tmp/workspace-agent" });
    const limited = {
      contextId: "ctx_person",
      agentId: "workspace-agent",
      context: {
        contextId: "ctx_person",
        contextKey: "rctx_person",
        kind: "turn-runtime",
        agentId: "workspace-agent",
        capabilities: [{ permission: "deny_execute", objectType: "executable", objectId: "*" }],
        metadata: {},
        createdAt: 0,
      },
    };
    expect(() =>
      runWithContext(limited, () => dbUpdateAgent("workspace-agent", { cwd: "/Users/someone/.ravi" })),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() => runWithContext(limited, () => dbCreateAgent({ id: "other-agent", cwd: "/tmp/other" }))).toThrow(
      expect.objectContaining({ code: "PERMISSION_DENIED" }),
    );
    expect(() =>
      runWithContext(limited, () => dbUpdateAgent("workspace-agent", { cwd: "/tmp/workspace-agent" })),
    ).not.toThrow();
  });
});
