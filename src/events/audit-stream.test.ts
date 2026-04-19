import { describe, expect, it } from "bun:test";
import { RAVI_EVENTS_SUBJECTS } from "./audit-stream.js";

describe("RAVI_EVENTS stream subjects", () => {
  it("captures internal session replay events without overlapping the prompt workqueue", () => {
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.*.runtime");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.*.response");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.*.claude");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.*.tool");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.abort");
    expect(RAVI_EVENTS_SUBJECTS).not.toContain("ravi.session.*.prompt");
    expect(new Set(RAVI_EVENTS_SUBJECTS).size).toBe(RAVI_EVENTS_SUBJECTS.length);
  });
});
