import { describe, expect, it } from "bun:test";
import { PAGES_APP_GATEWAY_AGENT_LABEL } from "../app-gateway/constants.js";
import { authorizationAgentId, authorizationContext } from "./authorization-agent.js";
import type { CapabilityContextLike } from "./provider-types.js";

describe("authorization agent", () => {
  it("keeps real agent ids and drops the Pages app gateway audit label", () => {
    expect(authorizationAgentId("main")).toBe("main");
    expect(authorizationAgentId(PAGES_APP_GATEWAY_AGENT_LABEL)).toBeUndefined();
    expect(authorizationAgentId(undefined)).toBeUndefined();
    expect(authorizationAgentId(null)).toBeUndefined();
  });

  it("fills a context record's agent from the caller unless the caller is an audit label", () => {
    const record: CapabilityContextLike = { capabilities: [], kind: "pages-app-gateway" };
    expect(authorizationContext(record, "main")).toEqual({ ...record, agentId: "main" });
    expect(authorizationContext(record, PAGES_APP_GATEWAY_AGENT_LABEL)).toBe(record);
    expect(authorizationContext(record, undefined)).toBe(record);
  });

  it("never replaces the record's own agent", () => {
    const record: CapabilityContextLike = { capabilities: [], agentId: "dev" };
    expect(authorizationContext(record, "main")).toBe(record);
    expect(authorizationContext(record, PAGES_APP_GATEWAY_AGENT_LABEL)).toBe(record);
  });
});
