import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { JobsRunner } from "../jobs/runner.js";
import { dbCreateJob, dbFinishJob, dbGetJob, dbMarkJobRunning, dbRegisterJob } from "../jobs/store.js";
import type { JobRecord } from "../jobs/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  buildNativeBackgroundTaskOutcomePrompt,
  decideIdleEviction,
  observeNativeBackgroundTaskEvent,
  publishBackgroundWake,
  resolveRuntimeBackgroundTaskTtlMs,
  type BackgroundWorkHolder,
} from "./background-work.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-background-work-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function logPath(name: string): string {
  return join(stateDir ?? "/tmp", `${name}.log`);
}

/** A pid that existed and is gone: what a job looks like after its process died unseen. */
function deadPid(): number {
  const child = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number.parseInt(child.stdout.trim(), 10);
}

describe("background work keeps a session from looking idle", () => {
  it("tracks provider tasks from task_started until task_notification", () => {
    const holder: BackgroundWorkHolder = {};
    observeNativeBackgroundTaskEvent(holder, {
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "toolu_1",
      description: "nba sql",
    });
    expect(holder.pendingBackgroundTasks?.size).toBe(1);

    const idle = decideIdleEviction({
      sessionName: "dm",
      holder,
      idleMs: 6 * 60_000,
      idleTtlMs: 5 * 60_000,
      backgroundTtlMs: 60 * 60_000,
    });
    expect(idle.evict).toBe(false);
    expect(idle.reason).toBe("background_work");

    const finished = observeNativeBackgroundTaskEvent(holder, {
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "completed",
      summary: "22 rows",
      output_file: "/tmp/t1.out",
    });
    expect(finished.kind).toBe("finished");
    expect(holder.pendingBackgroundTasks?.size).toBe(0);
    if (finished.kind !== "finished") throw new Error("expected finished");
    const prompt = buildNativeBackgroundTaskOutcomePrompt(finished);
    expect(prompt).toContain("t1 (nba sql) terminou: completed");
    expect(prompt).toContain("/tmp/t1.out");

    expect(decideIdleEviction({ sessionName: "dm", holder, idleMs: 6 * 60_000, idleTtlMs: 5 * 60_000 }).evict).toBe(
      true,
    );
  });

  it("ignores provider housekeeping tasks", () => {
    const holder: BackgroundWorkHolder = {};
    observeNativeBackgroundTaskEvent(holder, {
      type: "system",
      subtype: "task_started",
      task_id: "ambient",
      skip_transcript: true,
    });
    expect(holder.pendingBackgroundTasks?.size ?? 0).toBe(0);
  });

  it("has an explicit background TTL, larger than the idle TTL", () => {
    expect(resolveRuntimeBackgroundTaskTtlMs("")).toBe(60 * 60_000);
    expect(resolveRuntimeBackgroundTaskTtlMs("1200000")).toBe(1_200_000);
    expect(resolveRuntimeBackgroundTaskTtlMs("0")).toBe(60 * 60_000);
  });
});

describe("background completion survives the session", () => {
  it("completion_wakes_evicted_session", async () => {
    // The bug's path: run_in_background became a detached job; the session was
    // evicted (no live runtime anywhere in this test) and the job finished.
    const job = dbRegisterJob({
      id: "job_bg_wake_0001",
      sessionName: "dm-evicted",
      agentId: "nba",
      command: "nba sql 'select 1'",
      logPath: logPath("wake"),
      pid: process.pid,
    });
    writeFileSync(job.logPath, "22 rows\n");

    const delivered: Array<{ job: JobRecord; summary: string }> = [];
    let queueUp = false;
    const runner = new JobsRunner({
      notifySession: async (record, summary) => {
        if (!queueUp) throw new Error("SESSION_PROMPTS unavailable");
        delivered.push({ job: record, summary });
      },
    });

    dbFinishJob(job.id, { status: "succeeded", exitCode: 0, signal: null });
    await runner.handleJobFinished(job.id);

    // Delivery failed: the row is the durable record, with the reason.
    const undelivered = dbGetJob(job.id)!;
    expect(undelivered.notifiedAt).toBeNull();
    expect(undelivered.deliveryError).toBe("SESSION_PROMPTS unavailable");
    expect(undelivered.deliveryAttempts).toBe(1);
    expect(delivered).toHaveLength(0);

    // The reconcile retries it; the durable session prompt is what wakes the
    // evicted session, so no live runtime is needed.
    queueUp = true;
    await runner.reconcileOrphans();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.job.sessionName).toBe("dm-evicted");
    expect(delivered[0]?.summary).toContain("succeeded");
    expect(delivered[0]?.summary).toContain("22 rows");
    expect(dbGetJob(job.id)?.notifiedAt).toBeGreaterThan(0);

    // Delivered once: another reconcile does not repeat it.
    await runner.reconcileOrphans();
    expect(delivered).toHaveLength(1);
  });

  it("wakes the session through the durable prompt queue, not the live runtime", async () => {
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    await publishBackgroundWake(
      "dm-evicted",
      "[System] Tarefa em background t1 terminou: completed.",
      { kind: "native_task_finished", taskIds: ["t1"] },
      async (sessionName, payload) => {
        published.push({ sessionName, payload });
      },
    );
    expect(published).toEqual([
      {
        sessionName: "dm-evicted",
        payload: {
          prompt: "[System] Tarefa em background t1 terminou: completed.",
          deliveryBarrier: "after_response",
          deliveryBarrierSource: "default",
          _backgroundTask: { kind: "native_task_finished", taskIds: ["t1"] },
        },
      },
    ]);
  });

  it("dead_background_task_reports_failure_instead_of_hanging", async () => {
    const job = dbCreateJob({
      sessionName: "dm-dead",
      command: "nba sql 'select 1'",
      logPath: logPath("dead"),
      origin: "detach",
    });
    dbMarkJobRunning(job.id, deadPid());
    writeFileSync(job.logPath, "partial output\n");

    // While it runs, it holds the session out of the idle TTL.
    // (the pid is already gone, but nobody has noticed yet)
    expect(
      decideIdleEviction({ sessionName: "dm-dead", holder: {}, idleMs: 6 * 60_000, idleTtlMs: 5 * 60_000 }).evict,
    ).toBe(false);

    const delivered: Array<{ job: JobRecord; summary: string }> = [];
    const runner = new JobsRunner({
      notifySession: async (record, summary) => {
        delivered.push({ job: record, summary });
      },
    });
    await runner.reconcileOrphans();

    const settled = dbGetJob(job.id)!;
    expect(settled.status).toBe("failed");
    expect(settled.notifiedAt).toBeGreaterThan(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.summary).toContain("failed");
    expect(delivered[0]?.summary).toContain("partial output");

    // No longer pending: the session goes back to the normal idle TTL.
    expect(
      decideIdleEviction({ sessionName: "dm-dead", holder: {}, idleMs: 6 * 60_000, idleTtlMs: 5 * 60_000 }).evict,
    ).toBe(true);
  });
});
