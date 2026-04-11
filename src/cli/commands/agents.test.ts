import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type SessionLike = {
  sessionKey: string;
  name?: string;
  agentId: string;
  agentCwd: string;
  providerSessionId?: string | null;
  sdkSessionId?: string | null;
  runtimeProvider?: string | null;
  lastChannel?: string | null;
  lastTo?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  contextTokens?: number | null;
  compactionCount?: number | null;
  createdAt: number;
  updatedAt: number;
};

let currentAgent: { id: string; cwd: string; remote?: string } | null = null;
let resolvedSession: SessionLike | null = null;
let mainSession: SessionLike | null = null;
let sessionsByAgent: SessionLike[] = [];
let transcriptPath: string | null = null;

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../permissions/scope.js", () => ({
  getScopeContext: () => undefined,
  isScopeEnforced: () => false,
  canAccessSession: () => true,
  canModifySession: () => true,
  canAccessContact: () => true,
  canAccessResource: () => true,
  filterVisibleAgents: <T>(_: unknown, agents: T[]) => agents,
  canViewAgent: () => true,
  canWriteContacts: () => true,
  filterAccessibleSessions: <T>(_: unknown, sessions: T[]) => sessions,
}));

mock.module("../../nats.js", () => ({
  nats: {
    emit: mock(async () => {}),
  },
}));

mock.module("../../router/config.js", () => ({
  getAgent: (id: string) => (currentAgent?.id === id ? currentAgent : null),
  getAllAgents: () => [],
  createAgent: () => {},
  updateAgent: () => {},
  deleteAgent: () => false,
  setAgentDebounce: () => {},
  ensureAgentDirs: () => {},
  loadRouterConfig: () => ({ defaultAgent: "main" }),
  setAgentSpecMode: () => {},
}));

mock.module("../../router/router-db.js", () => ({
  DmScopeSchema: { safeParse: () => ({ success: true }), options: [] },
}));

mock.module("../../router/sessions.js", () => ({
  deleteSession: () => true,
  getSessionsByAgent: () => sessionsByAgent,
  getMainSession: () => mainSession,
  resolveSession: () => resolvedSession,
}));

mock.module("../../transcripts.js", () => ({
  locateRuntimeTranscript: () => (transcriptPath ? { path: transcriptPath } : { path: null, reason: "missing" }),
}));

const { AgentsCommands } = await import("./agents.js");

describe("AgentsCommands debug --json", () => {
  beforeEach(() => {
    currentAgent = { id: "dev", cwd: "/tmp/dev" };
    resolvedSession = null;
    mainSession = null;
    sessionsByAgent = [];
    transcriptPath = null;
  });

  it("prints raw JSON output for the selected session transcript", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ravi-agents-debug-"));
    const transcriptFile = join(tempDir, "transcript.jsonl");
    transcriptPath = transcriptFile;
    resolvedSession = {
      sessionKey: "dev-main",
      name: "dev-main",
      agentId: "dev",
      agentCwd: "/tmp/dev",
      providerSessionId: "provider-1",
      runtimeProvider: "codex",
      lastChannel: "whatsapp",
      lastTo: "5511999999999",
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
      contextTokens: 8,
      compactionCount: 1,
      createdAt: 1000,
      updatedAt: 2000,
    };

    writeFileSync(
      transcriptFile,
      [
        JSON.stringify({
          timestamp: "2026-03-13T00:00:00.000Z",
          type: "user",
          message: { content: "hello" },
        }),
        JSON.stringify({
          timestamp: "2026-03-13T00:00:01.000Z",
          type: "assistant",
          message: { content: [{ type: "text", text: "world" }] },
        }),
      ].join("\n"),
    );

    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      commands.debug("dev", "dev-main", "1", true);
    } finally {
      console.log = originalLog;
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(logCalls).toHaveLength(1);
    const payload = JSON.parse(logCalls[0] ?? "{}");
    expect(payload.session).toMatchObject({
      sessionKey: "dev-main",
      name: "dev-main",
      agentId: "dev",
      runtimeId: "provider-1",
      runtimeProvider: "codex",
    });
    expect(payload.transcript).toMatchObject({
      available: true,
      path: transcriptFile,
      totalEntries: 2,
      selectedEntries: 2,
    });
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0]).toMatchObject({ type: "user" });
    expect(payload.entries[1]).toMatchObject({ type: "assistant" });
  });

  it("prints a JSON error payload when the session does not exist", () => {
    sessionsByAgent = [
      {
        sessionKey: "dev-main",
        name: "dev-main",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        createdAt: 1000,
        updatedAt: 1000,
      },
    ];

    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      commands.debug("dev", "missing-session", undefined, true);
    } finally {
      console.log = originalLog;
    }

    expect(logCalls).toHaveLength(1);
    const payload = JSON.parse(logCalls[0] ?? "{}");
    expect(payload.error).toBe("No session found: missing-session");
    expect(payload.agentId).toBe("dev");
    expect(payload.availableSessions).toEqual(["dev-main"]);
  });
});
