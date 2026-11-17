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
