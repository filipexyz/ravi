import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { recordRuntimeTraceEvent } from "../session-trace/runtime-trace.js";
import { reconstructRuntimeTargetTurnState } from "./target-policy-trace.js";

let stateDir: string | null = null;
const sessionKey = "agent:main:target-restart";

describe("runtime target trace reconstruction", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-target-trace-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("reconstructs attempts after restart without a new database table", () => {
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName: "target-restart",
      agentId: "main",
      eventType: "runtime.start",
      eventGroup: "runtime",
      status: "starting",
      payloadJson: { policyId: "p1", runtimeTargetId: "primary", logicalTurnId: "logical-1" },
    });
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName: "target-restart",
      agentId: "main",
      eventType: "runtime.target.switch_requested",
      eventGroup: "runtime",
      status: "recovering",
      payloadJson: { policyId: "p1", targetId: "primary", logicalTurnId: "logical-1" },
    });

    expect(reconstructRuntimeTargetTurnState(sessionKey, "p1")).toMatchObject({
      logicalTurnId: "logical-1",
      attempts: [{ targetId: "primary", attempt: 1, outcome: "recoverable_failure" }],
      sideEffectBoundaryCrossed: false,
      terminal: false,
    });
  });
});
