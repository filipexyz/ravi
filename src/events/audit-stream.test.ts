import { describe, expect, it } from "bun:test";
import { RAVI_EVENTS_SUBJECTS } from "./audit-stream.js";

function streamSubjectPatternsOverlap(left: string, right: string): boolean {
  const leftTokens = left.split(".");
  const rightTokens = right.split(".");

  function overlaps(leftIndex: number, rightIndex: number): boolean {
    const leftToken = leftTokens[leftIndex];
    const rightToken = rightTokens[rightIndex];

    if (leftToken === undefined || rightToken === undefined) {
      return leftToken === rightToken || leftToken === ">" || rightToken === ">";
    }

    if (leftToken === ">" || rightToken === ">") return true;
    if (leftToken === "*" || rightToken === "*") return overlaps(leftIndex + 1, rightIndex + 1);
    if (leftToken !== rightToken) return false;
    return overlaps(leftIndex + 1, rightIndex + 1);
  }

  return overlaps(0, 0);
}

describe("RAVI_EVENTS stream subjects", () => {
  it("captures internal session replay events without overlapping the prompt workqueue", () => {
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.*.runtime");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.*.response");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.*.claude");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.*.tool");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.abort");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.reset.requested");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.reset.completed");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.delete.requested");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi.session.delete.completed");
    expect(RAVI_EVENTS_SUBJECTS).toContain("ravi._cli.cli.>");
    expect(RAVI_EVENTS_SUBJECTS).not.toContain("ravi.session.*.prompt");
    expect(RAVI_EVENTS_SUBJECTS).not.toContain("ravi.*.cli.>");
    expect(new Set(RAVI_EVENTS_SUBJECTS).size).toBe(RAVI_EVENTS_SUBJECTS.length);
  });

  it("does not define overlapping subjects in the same stream", () => {
    for (const [index, subject] of RAVI_EVENTS_SUBJECTS.entries()) {
      for (const other of RAVI_EVENTS_SUBJECTS.slice(index + 1)) {
        expect(streamSubjectPatternsOverlap(subject, other), `${subject} overlaps ${other}`).toBe(false);
      }
    }
  });
});
