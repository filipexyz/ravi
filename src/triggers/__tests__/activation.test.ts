import { describe, expect, it } from "bun:test";
import { resolveTriggerActivation } from "../activation.js";

const base = { enabled: true, topic: "ravi.inbound.interaction" };

describe("resolveTriggerActivation", () => {
  it("activates enabled triggers with no filter or a valid filter", () => {
    expect(resolveTriggerActivation({ ...base })).toMatchObject({ state: "active", filterStatus: "none" });
    expect(resolveTriggerActivation({ ...base, filter: "   " })).toMatchObject({
      state: "active",
      filterStatus: "none",
    });

    const valid = resolveTriggerActivation({ ...base, filter: `data.provider == "slack"` });
    expect(valid).toMatchObject({ state: "active", filterStatus: "valid" });
    expect(valid.reason).toBeUndefined();
    expect(valid.filter.evaluate({ provider: "slack" })).toBe(true);
    expect(valid.filter.evaluate({ provider: "discord" })).toBe(false);
  });

  it("fails closed on invalid filters with the parse error as the reason", () => {
    const activation = resolveTriggerActivation({ ...base, filter: "data.branch == main" });

    expect(activation.state).toBe("invalid_filter");
    expect(activation.filterStatus).toBe("invalid");
    expect(activation.reason).toContain("Expected quoted string value");
    expect(activation.reason).toContain("will not activate");
    expect(activation.filter.evaluate({ branch: "main" })).toBe(false);
  });

  it("reports invalid filters even on disabled triggers so re-enabling is not a silent no-op", () => {
    expect(resolveTriggerActivation({ ...base, enabled: false, filter: "data.x == 1" }).state).toBe("invalid_filter");
    expect(resolveTriggerActivation({ ...base, enabled: false, filter: `data.x == "1"` })).toMatchObject({
      state: "disabled",
      filterStatus: "valid",
    });
  });

  it("keeps skipping internal session topics", () => {
    const activation = resolveTriggerActivation({ ...base, topic: "ravi.session.agent-main.prompt" });
    expect(activation.state).toBe("blocked_topic");
    expect(activation.reason).toContain("ravi.session.*");
  });

  it("reports unbound_agent when the bound agent does not exist", () => {
    const missing = resolveTriggerActivation(
      { ...base, agentId: "gone-creator", filter: `data.pageId == "site_1"` },
      { agentExists: () => false },
    );
    expect(missing.state).toBe("unbound_agent");
    expect(missing.reason).toContain("gone-creator");
    expect(missing.reason).toContain("will not activate");

    const present = resolveTriggerActivation(
      { ...base, agentId: "creator", filter: `data.pageId == "site_1"` },
      { agentExists: () => true },
    );
    expect(present.state).toBe("active");
  });
});
