import { describe, expect, test } from "bun:test";

import { consoleFeatureForSegments } from "./console-api-features";

describe("console API feature mapping", () => {
  test("maps reporter bugs to console.bugs and does not treat manage/admin bugs as an org feature", () => {
    expect(consoleFeatureForSegments(["bugs"])).toBe("console.bugs");
    expect(consoleFeatureForSegments(["bugs", "report-id"])).toBe("console.bugs");
    expect(consoleFeatureForSegments(["admin", "bugs"])).toBeNull();
    expect(consoleFeatureForSegments(["manage", "bugs"])).toBeNull();
    expect(consoleFeatureForSegments(["manage", "bugs", "report-id", "status"])).toBeNull();
    expect(consoleFeatureForSegments(["admin", "bugs", "report-id", "apply-triage"])).toBeNull();
  });

  test("does not treat unknown admin segments as bug ops", () => {
    expect(consoleFeatureForSegments(["admin"])).toBeNull();
    expect(consoleFeatureForSegments(["admin", "orgs"])).toBeNull();
  });
});
