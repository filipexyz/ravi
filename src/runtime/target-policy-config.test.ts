import { describe, expect, it } from "bun:test";
import { resolveRuntimeTargetPolicy } from "./target-policy-config.js";

const targetPolicy = (id: string) => ({
  id,
  strategy: "ordered",
  maxAttemptsPerTarget: 1,
  targets: [{ id: `${id}-target`, runtimeProvider: "synthetic", model: "opaque/model" }],
});

describe("runtime target policy configuration", () => {
  it("resolves deterministic scope precedence with provenance", () => {
    expect(
      resolveRuntimeTargetPolicy({
        sessionOverride: targetPolicy("session"),
        taskProfilePolicy: targetPolicy("task"),
        taskProfileId: "research",
        agentDefaults: { runtimeTargetPolicy: targetPolicy("agent") },
        agentId: "worker",
      }),
    ).toMatchObject({
      policy: { id: "session" },
      source: "session_override",
      provenance: "session.runtimeTargetPolicy",
    });
    expect(
      resolveRuntimeTargetPolicy({
        taskProfilePolicy: targetPolicy("task"),
        taskProfileId: "research",
        agentDefaults: { runtimeTargetPolicy: targetPolicy("agent") },
      }),
    ).toMatchObject({ policy: { id: "task" }, source: "task_profile", provenance: "task-profile:research" });
    expect(
      resolveRuntimeTargetPolicy({ agentDefaults: { runtimeTargetPolicy: targetPolicy("agent") }, agentId: "worker" }),
    ).toMatchObject({
      policy: { id: "agent" },
      source: "agent_default",
      provenance: "agent:worker.defaults.runtimeTargetPolicy",
    });
  });

  it("keeps current single-target behavior when no policy exists", () => {
    expect(resolveRuntimeTargetPolicy({})).toEqual({ policy: null, source: "none", provenance: null });
  });

  it("rejects malformed policy before runtime launch", () => {
    expect(() =>
      resolveRuntimeTargetPolicy({ sessionOverride: { id: "bad", strategy: "ordered", targets: [] } }),
    ).toThrow("non-empty targets");
  });
});
