import { afterAll, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Option: () => () => {},
}));

mock.module("../../nats.js", () => ({
  nats: {
    subscribe: () => (async function* () {})(),
  },
}));

const { formatData } = await import("./events.js");

describe("formatData", () => {
  it("includes runtime failure details", () => {
    const text = formatData(
      { type: "turn.failed", error: "permission denied for codex" },
      "ravi.session.agent-main.runtime",
    );

    expect(text).toContain("turn.failed");
    expect(text).toContain("permission denied for codex");
  });

  it("includes runtime interruption details from nested error objects", () => {
    const text = formatData(
      { type: "turn.interrupted", error: { message: "user interrupted" } },
      "ravi.session.agent-main.runtime",
    );

    expect(text).toContain("turn.interrupted");
    expect(text).toContain("user interrupted");
  });
});
