import { describe, expect, it } from "bun:test";

import { matchesTopicGlob } from "./topic-glob.js";

describe("matchesTopicGlob", () => {
  it("keeps * within a single topic segment", () => {
    expect(matchesTopicGlob("ravi.session.dev.prompt", "ravi.session.*.prompt")).toBe(true);
    expect(matchesTopicGlob("ravi.session.dev.runtime.prompt", "ravi.session.*.prompt")).toBe(false);
  });

  it("allows ** to span topic segments", () => {
    expect(matchesTopicGlob("ravi.session.dev.runtime.prompt", "ravi.session.**.prompt")).toBe(true);
    expect(matchesTopicGlob("ravi.session.dev.runtime.prompt", "ravi.**")).toBe(true);
  });

  it("treats regex metacharacters as literal filter text", () => {
    expect(matchesTopicGlob("ravi.session.dev?prompt", "ravi.session.dev?prompt")).toBe(true);
    expect(matchesTopicGlob("ravi.session.devXprompt", "ravi.session.dev?prompt")).toBe(false);
  });
});
