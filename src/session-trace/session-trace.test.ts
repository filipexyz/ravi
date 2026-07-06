import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { querySessionTrace } from "./query.js";
import { recordSessionEvent } from "./session-trace-db.js";

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
});
