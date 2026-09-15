import { describe, expect, it } from "bun:test";
import { isSessionResponseTopic } from "./nats.js";

describe("isSessionResponseTopic", () => {
  it("matches only session chat response topics", () => {
    expect(isSessionResponseTopic("ravi.session.demo-agent.response")).toBe(true);
    expect(isSessionResponseTopic("ravi.session.demo-group.response")).toBe(true);
  });

  it("does not treat approval or other .response topics as ghost chat emits", () => {
    expect(isSessionResponseTopic("ravi.approval.response")).toBe(false);
    expect(isSessionResponseTopic("ravi.session.demo-agent.runtime")).toBe(false);
    expect(isSessionResponseTopic("ravi.outbound.deliver")).toBe(false);
  });
});
