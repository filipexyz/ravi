import { describe, expect, it } from "bun:test";
import { resolveDeterministicProvenance } from "./skills.js";

describe("resolveDeterministicProvenance (Hermes — keep the LLM out of the provenance path)", () => {
  it("stamps the date from the system clock when no override is given", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(resolveDeterministicProvenance({}).date).toBe(today);
  });

  it("honors an explicit date override (tests / manual dispatch)", () => {
    expect(resolveDeterministicProvenance({ date: "2020-01-02" }).date).toBe("2020-01-02");
  });

  it("passes explicit provenance overrides through verbatim", () => {
    const p = resolveDeterministicProvenance({
      agentId: "ravi-dev",
      sessionKey: "sess-x",
      cadenceTurn: "10",
      taskId: "task-abc",
      date: "2026-07-10",
    });
    expect(p).toEqual({
      agentId: "ravi-dev",
      sessionKey: "sess-x",
      cadenceTurn: "10",
      taskId: "task-abc",
      date: "2026-07-10",
    });
  });

  it("falls back to agentId 'unknown' when no override and no task env", () => {
    expect(resolveDeterministicProvenance({}, {}).agentId).toBe("unknown");
  });

  it("resolves taskId from the runtime-injected RAVI_TASK_ID env (not the LLM)", () => {
    // No such task exists → getTaskDetails throws/empty, but taskId still flows
    // through from the env deterministically.
    const p = resolveDeterministicProvenance({}, { RAVI_TASK_ID: "task-zzz", RAVI_AGENT_ID: "ravi-dev" });
    expect(p.taskId).toBe("task-zzz");
    expect(p.agentId).toBe("ravi-dev");
  });

  it("never leaves the date undefined (the field the LLM must never compute)", () => {
    const p = resolveDeterministicProvenance({ agentId: "a" });
    expect(typeof p.date).toBe("string");
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
