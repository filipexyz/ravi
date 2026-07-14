import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { querySessionTrace } from "./query.js";
import { recordAdapterRequestTrace } from "./runtime-trace.js";
import {
  countSessionTerminalTurns,
  getSessionTraceBlob,
  listRecentSessionEventsByType,
  recordSessionEvent,
  upsertSessionTurn,
} from "./session-trace-db.js";

let stateDir: string | null = null;

function recordTraceEvent(eventType: string, eventGroup: string, timestamp: number) {
  recordSessionEvent({
    sessionKey: "agent:main:trace-limit",
    sessionName: "trace-limit",
    agentId: "main",
    eventType,
    eventGroup,
    timestamp,
    createdAt: timestamp,
  });
}

describe("session trace query", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-session-trace-limit-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("applies stream suppression before the bounded timeline limit", () => {
    recordTraceEvent("channel.message.received", "channel", 1000);
    recordTraceEvent("adapter.raw", "adapter", 1100);
    recordTraceEvent("tool.start", "tool", 1200);
    recordTraceEvent("response.emitted", "response", 1300);

    expect(querySessionTrace({ session: "trace-limit", limit: 2 }).events.map((event) => event.eventType)).toEqual([
      "tool.start",
      "response.emitted",
    ]);

    expect(
      querySessionTrace({ session: "trace-limit", only: "stream", includeStream: true }).events.map(
        (event) => event.eventType,
      ),
    ).toEqual(["adapter.raw"]);
  });

  it("lists recent events by type using newest event ids first", () => {
    recordSessionEvent({
      sessionKey: "agent:main:trace-limit",
      sessionName: "trace-limit",
      agentId: "main",
      eventType: "turn.complete",
      eventGroup: "turn",
      timestamp: 1000,
      createdAt: 1000,
      preview: "old complete",
    });
    recordSessionEvent({
      sessionKey: "agent:main:trace-limit",
      sessionName: "trace-limit",
      agentId: "main",
      eventType: "tool.start",
      eventGroup: "tool",
      timestamp: 1100,
      createdAt: 1100,
      preview: "tool event",
    });
    recordSessionEvent({
      sessionKey: "agent:main:trace-limit",
      sessionName: "trace-limit",
      agentId: "main",
      eventType: "turn.complete",
      eventGroup: "turn",
      timestamp: 1200,
      createdAt: 1200,
      preview: "newer complete",
    });

    expect(
      listRecentSessionEventsByType("agent:main:trace-limit", "turn.complete", { limit: 2 }).map(
        (event) => event.preview,
      ),
    ).toEqual(["newer complete", "old complete"]);
  });

  it("records runtime option sources in the adapter request payload", () => {
    const trace = recordAdapterRequestTrace({
      sessionKey: "agent:main:trace-limit",
      sessionName: "trace-limit",
      agentId: "main",
      runId: "run-runtime-options",
      turnId: "turn-runtime-options",
      provider: "codex",
      model: "gpt-5",
      effort: "high",
      thinking: "normal",
      modelSource: "session_override",
      effortSource: "agent_default",
      thinkingSource: "runtime_default",
      prompt: "hello",
      systemPrompt: "system",
      cwd: "/tmp/main",
      resume: false,
      fork: false,
      hasHooks: false,
      pluginNames: [],
      mcpServerNames: [],
      hasRemoteSpawn: false,
    });

    expect(trace).not.toBeNull();
    expect(getSessionTraceBlob(trace!.requestBlobSha256)?.contentJson).toMatchObject({
      model_source: "session_override",
      effort_source: "agent_default",
      thinking_source: "runtime_default",
    });
  });

  it("counts durable terminal turns for cold-start cadence reconstruction", () => {
    const sessionKey = "agent:main:trace-limit";
    const terminalStatuses = ["complete", "interrupted", "failed"] as const;

    terminalStatuses.forEach((status, index) => {
      upsertSessionTurn({
        turnId: `terminal-${status}`,
        sessionKey,
        sessionName: "trace-limit",
        agentId: "main",
        status,
        startedAt: 1000 + index,
        completedAt: 1100 + index,
        updatedAt: 1100 + index,
      });
    });

    upsertSessionTurn({
      turnId: "running-turn",
      sessionKey,
      sessionName: "trace-limit",
      agentId: "main",
      status: "running",
      startedAt: 1200,
      updatedAt: 1200,
    });
    upsertSessionTurn({
      turnId: "other-session",
      sessionKey: "agent:main:other",
      sessionName: "other",
      agentId: "main",
      status: "complete",
      startedAt: 1300,
      completedAt: 1400,
      updatedAt: 1400,
    });

    expect(countSessionTerminalTurns(sessionKey)).toBe(3);
    expect(countSessionTerminalTurns("agent:main:other")).toBe(1);
    expect(countSessionTerminalTurns("agent:main:missing")).toBe(0);
  });
});
