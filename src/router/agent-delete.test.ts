import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { AgentsCommands } from "../cli/commands/agents.js";
import {
  dbGetLibraryAgentState,
  dbSetLibraryAgentAcceptsRequests,
  dbSetLibraryAgentDescription,
  dbSetLibraryAgentListed,
} from "../library/agents-db.js";
import { createRuntimeContext, issueRuntimeContext, resolveRuntimeContext } from "../runtime/context-registry.js";
import {
  attachMcpServer,
  createMcpServer,
  listMcpAttachments,
  setMcpConfigChangedEmitterForTests,
} from "../mcp/registry-db.js";
import { createMcpCall, getMcpCall } from "../mcp/calls-db.js";
import { listMcpSkillPins, upsertMcpSkillPin } from "../mcp/skill-pins-db.js";
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

  it("leaves no MCP server attachment for a new agent with the same id", () => {
    setMcpConfigChangedEmitterForTests(() => {});
    try {
      dbCreateAgent({ id: "concierge", cwd: "/tmp/concierge" });
      createMcpServer({ name: "github", transport: "http", url: "https://mcp.example.com/mcp" });
      attachMcpServer({ agentId: "concierge", server: "github", audience: "any" });
      attachMcpServer({ agentId: "main", server: "github" });

      expect(dbDeleteAgent("concierge")).toBe(true);
      dbCreateAgent({ id: "concierge", cwd: "/tmp/concierge-new" });

      expect(listMcpAttachments({ server: "github" }).map((row) => row.agentId)).toEqual(["main"]);
    } finally {
      setMcpConfigChangedEmitterForTests(null);
    }
  });

  it("leaves no remote skill pin for a new agent with the same id", () => {
    const uri = "skill://project/prs/weekly-report/SKILL.md";
    const pin = (agentId: string) =>
      upsertMcpSkillPin({
        agentId,
        server: "docs",
        skillUri: uri,
        skillId: "mcp:docs:project/prs/weekly-report",
        skillName: "mcp-docs-weekly-report",
        description: "Write the weekly report.",
        manifest: { uri, name: "weekly-report", description: "Write the weekly report.", resources: [] },
        manifestDigest: `sha256:${"a".repeat(64)}`,
        libraryRef: null,
        externalAllowed: false,
        approvedBy: "operator",
      });
    dbCreateAgent({ id: "concierge", cwd: "/tmp/concierge" });
    pin("concierge");
    pin("main");

    expect(dbDeleteAgent("concierge")).toBe(true);
    dbCreateAgent({ id: "concierge", cwd: "/tmp/concierge-new" });

    expect(listMcpSkillPins({ server: "docs" }).map((row) => row.agentId)).toEqual(["main"]);
  });

  it("ends the agent's open background MCP calls, leaving other agents' and finished ones alone", () => {
    const call = (agentId: string, state: "running" | "task") =>
      createMcpCall({
        server: "github",
        tool: "long",
        agentId,
        sessionName: `${agentId}-session`,
        origin: { contextId: null, contactId: null, operatorOwn: false },
        surface: "cli",
        detachReason: state === "task" ? "task" : "budget",
        state,
        ...(state === "task" ? { remoteTaskId: "mct_1", nextPollAt: Date.now() + 10_000 } : {}),
        expiresAt: Date.now() + 60_000,
      });
    dbCreateAgent({ id: "concierge", cwd: "/tmp/concierge" });
    const task = call("concierge", "task");
    const kept = call("concierge", "running");
    const other = call("main", "task");

    expect(dbDeleteAgent("concierge")).toBe(true);
    dbCreateAgent({ id: "concierge", cwd: "/tmp/concierge-new" });

    for (const id of [task.id, kept.id]) {
      expect(getMcpCall(id)).toMatchObject({ state: "failed", outcome: "discarded", nextPollAt: null, result: null });
    }
    expect(getMcpCall(other.id)).toMatchObject({ state: "task", outcome: null });
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
