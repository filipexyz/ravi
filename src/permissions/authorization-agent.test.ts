import { describe, expect, it } from "bun:test";
import { authorizationAgentId, authorizationContext } from "./authorization-agent.js";
import type { CapabilityContextLike } from "./provider-types.js";

describe("authorization agent", () => {
  it("keeps real agent ids", () => {
    expect(authorizationAgentId("main")).toBe("main");
    expect(authorizationAgentId("dev")).toBe("dev");
  });

  it("maps a missing agent id to undefined", () => {
    expect(authorizationAgentId(undefined)).toBeUndefined();
    expect(authorizationAgentId(null)).toBeUndefined();
    expect(authorizationAgentId("")).toBeUndefined();
  });

  it("never replaces the record's own agent", () => {
    const record: CapabilityContextLike = { capabilities: [], agentId: "dev" };
    expect(authorizationContext(record, "main")).toBe(record);
    expect(authorizationContext(record, undefined)).toBe(record);
    expect(authorizationContext(record, null)).toBe(record);
  });

  it("fills a missing agent on the record from the caller", () => {
    const record: CapabilityContextLike = { capabilities: [], kind: "test-agentless" };
    expect(authorizationContext(record, "main")).toEqual({ ...record, agentId: "main" });
    expect(record.agentId).toBeUndefined();
    const nullAgent: CapabilityContextLike = { capabilities: [], agentId: null };
    expect(authorizationContext(nullAgent, "main")).toEqual({ capabilities: [], agentId: "main" });
  });

  it("leaves an agentless record agentless when the caller has no agent", () => {
    const record: CapabilityContextLike = { capabilities: [], kind: "test-agentless" };
    expect(authorizationContext(record, undefined)).toBe(record);
    expect(authorizationContext(record, null)).toBe(record);
    expect(authorizationContext(record, "")).toBe(record);
  });
});
