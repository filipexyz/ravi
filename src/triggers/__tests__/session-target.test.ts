import { describe, expect, it } from "bun:test";
import { resolveSessionTargetName } from "../runner.js";
import { sessionTargetError } from "../types.js";

describe("trigger session targets", () => {
  it("accepts any non-empty session name or template", () => {
    expect(sessionTargetError("support-desk")).toBeNull();
    expect(sessionTargetError("issue-{{data.payload.rowId}}")).toBeNull();
    expect(sessionTargetError("  ")).toContain("give a session name");
    expect(sessionTargetError("issue-{{data.id")).toContain("unmatched");
    expect(sessionTargetError("issue-data.id}}")).toContain("unmatched");
  });

  it("resolves a session name from event data", () => {
    const event = { topic: "t", data: { payload: { row: { values: { topic_id: ["Topic_A.1"] } } } } };
    expect(resolveSessionTargetName("issue-{{data.payload.row.values.topic_id.0}}", event)).toBe("issue-topic-a-1");
    expect(resolveSessionTargetName("issue-{{data.payload.missing}}", event)).toBeNull();
    expect(resolveSessionTargetName("issue-{{data.payload.missing}}", event, { fillUnresolved: "test" })).toBe(
      "issue-test",
    );
    expect(
      resolveSessionTargetName("{{data.payload.empty}}", { topic: "t", data: { payload: { empty: "" } } }),
    ).toBeNull();
  });

  it("caps the session name at 64 characters", () => {
    const longId = "x".repeat(400);
    const event = { topic: "t", data: { id: longId } };
    const name = resolveSessionTargetName("i-{{data.id}}", event);
    expect(name).toHaveLength(64);
    expect(name).toMatch(/^i-x+-[0-9a-f]{8}$/);
  });

  it("keeps long names that share their first 64 characters apart", () => {
    const prefix = "x".repeat(80);
    const a = resolveSessionTargetName("{{data.id}}", { topic: "t", data: { id: `${prefix}a` } });
    const b = resolveSessionTargetName("{{data.id}}", { topic: "t", data: { id: `${prefix}b` } });
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
    expect(b).toHaveLength(64);
  });
});
