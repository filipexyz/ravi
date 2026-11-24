import { describe, expect, it } from "bun:test";
import { applyCronFailureAck, planCronFailureAck } from "./failure-ack.js";
import type { CronRunRow } from "./run-db.js";

function run(id: string, jobId: string, agentId: string | null, admittedAt: number, notice?: string): CronRunRow {
  return {
    id,
    job_id: jobId,
    session_name: "s",
    admitted_at: admittedAt,
    notification_json: notice ?? JSON.stringify({ id: jobId, name: `job ${jobId}`, agentId }),
    status: "error",
    error: "boom",
  };
}

const pending = [
  run("r1", "a", "main", 10),
  run("r2", "a", "main", 30),
  run("r3", "b", "other", 20),
  run("r4", "c", null, 5, "{not json"),
];

describe("cron failure ack", () => {
  it("groups the pending reports the caller may settle, by job", () => {
    const plan = planCronFailureAck({ canAck: () => true }, { listPending: () => pending });
    expect(plan.pending).toBe(4);
    expect(plan.selected).toBe(4);
    expect(plan.denied).toBe(0);
    expect(plan.jobs.map((job) => job.jobId)).toEqual(["a", "b", "c"]);
    expect(plan.jobs[0]).toMatchObject({ name: "job a", ownerAgentId: "main", oldestAt: 10, newestAt: 30 });
    expect(plan.jobs[0]?.runIds).toEqual(["r1", "r2"]);
    // An unreadable notice keeps its job id and has no known owner.
    expect(plan.jobs[2]).toMatchObject({ jobId: "c", name: null, ownerAgentId: null });
  });

  it("counts, and never selects, reports of jobs the caller may not settle", () => {
    const plan = planCronFailureAck({ canAck: (owner) => owner === "main" }, { listPending: () => pending });
    expect(plan.selected).toBe(2);
    expect(plan.denied).toBe(2);
    expect(plan.jobs.map((job) => job.jobId)).toEqual(["a"]);
  });

  it("narrows to one job", () => {
    const plan = planCronFailureAck({ jobId: "b", canAck: () => true }, { listPending: () => pending });
    expect(plan.selected).toBe(1);
    expect(plan.jobs.map((job) => job.jobId)).toEqual(["b"]);
  });

  it("marks exactly the selected runs reported and nothing else", () => {
    const plan = planCronFailureAck({ canAck: (owner) => owner === "main" }, { listPending: () => pending });
    const marked: string[] = [];
    expect(applyCronFailureAck(plan, { markReported: (id) => marked.push(id) })).toBe(2);
    expect(marked).toEqual(["r1", "r2"]);
  });

  it("does nothing when nothing is pending", () => {
    const plan = planCronFailureAck({ canAck: () => true }, { listPending: () => [] });
    const marked: string[] = [];
    expect(applyCronFailureAck(plan, { markReported: (id) => marked.push(id) })).toBe(0);
    expect(plan).toEqual({ pending: 0, selected: 0, denied: 0, jobs: [] });
    expect(marked).toEqual([]);
  });
});
