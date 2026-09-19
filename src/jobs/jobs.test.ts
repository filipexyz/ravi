import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "../router/router-db.js";
import { buildJobOutcomeSummary, isPidAlive, readJobTail } from "./runner.js";
import {
  dbCreateJob,
  dbFinishJob,
  dbGetJob,
  dbListJobs,
  dbListRunningJobs,
  dbMarkJobNotified,
  dbMarkJobRunning,
} from "./store.js";
import { isJobTerminal, type JobRecord } from "./types.js";

const createdIds: string[] = [];

function makeJob(overrides: Partial<Parameters<typeof dbCreateJob>[0]> = {}) {
  const job = dbCreateJob({
    sessionName: `test-jobs-${Date.now()}`,
    command: "printf ok",
    cwd: null,
    logPath: join(tmpdir(), `ravi-job-test-${Date.now()}.log`),
    origin: "cli",
    ...overrides,
  });
  createdIds.push(job.id);
  return job;
}

afterEach(() => {
  const db = getDb();
  for (const id of createdIds.splice(0)) {
    db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }
});

describe("job store", () => {
  it("creates a job pending, then running, then terminal", () => {
    const job = makeJob();
    expect(job.status).toBe("pending");
    expect(job.pid).toBeNull();
    expect(job.startedAt).toBeNull();

    expect(dbMarkJobRunning(job.id, 4242)).toBe(true);
    const running = dbGetJob(job.id)!;
    expect(running.status).toBe("running");
    expect(running.pid).toBe(4242);
    expect(running.startedAt).toBeGreaterThan(0);

    expect(dbFinishJob(job.id, { status: "succeeded", exitCode: 0, signal: null })).toBe(true);
    const done = dbGetJob(job.id)!;
    expect(done.status).toBe("succeeded");
    expect(done.exitCode).toBe(0);
    expect(done.finishedAt).toBeGreaterThan(0);
    expect(isJobTerminal(done.status)).toBe(true);
  });

  it("does not mark running a job that already finished", () => {
    const job = makeJob();
    dbFinishJob(job.id, { status: "failed", exitCode: 1, signal: null });
    // O processo pode terminar antes do daemon registrar o start.
    expect(dbMarkJobRunning(job.id, 1)).toBe(false);
    expect(dbGetJob(job.id)!.status).toBe("failed");
  });

  it("lists by session and by running state", () => {
    const session = `test-jobs-list-${Date.now()}`;
    const first = makeJob({ sessionName: session });
    const second = makeJob({ sessionName: session });

    const listed = dbListJobs({ sessionName: session });
    expect(listed.map((job) => job.id).sort()).toEqual([first.id, second.id].sort());

    const running = dbListRunningJobs().map((job) => job.id);
    expect(running).toContain(first.id);
    expect(running).toContain(second.id);

    dbFinishJob(first.id, { status: "succeeded", exitCode: 0, signal: null });
    expect(dbListRunningJobs().map((job) => job.id)).not.toContain(first.id);
  });

  it("records that the outcome was delivered", () => {
    const job = makeJob();
    expect(job.notifiedAt).toBeNull();
    expect(dbMarkJobNotified(job.id)).toBe(true);
    expect(dbGetJob(job.id)!.notifiedAt).toBeGreaterThan(0);
  });

  it("keeps the origin, so a promoted call is distinguishable from a requested one", () => {
    const promoted = makeJob({ origin: "promotion" });
    expect(promoted.origin).toBe("promotion");
  });
});

describe("job outcome summary", () => {
  function finished(overrides: Partial<JobRecord> = {}): JobRecord {
    return {
      ...makeJob(),
      status: "succeeded",
      exitCode: 0,
      signal: null,
      ...overrides,
    } as JobRecord;
  }

  it("names the job, the status and the exit code", () => {
    const job = finished();
    const summary = buildJobOutcomeSummary(job);
    expect(summary).toContain(`Job ${job.id} terminou`);
    expect(summary).toContain("succeeded");
    expect(summary).toContain("exit 0");
  });

  it("reports the signal when the job was killed", () => {
    const summary = buildJobOutcomeSummary(finished({ status: "killed", exitCode: null, signal: "SIGTERM" }));
    expect(summary).toContain("killed");
    expect(summary).toContain("SIGTERM");
  });

  it("includes the log tail so the agent can decide the next step", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-job-summary-"));
    try {
      const logPath = join(dir, "job.log");
      writeFileSync(logPath, "linha 1\nlinha 2\n");
      const summary = buildJobOutcomeSummary(finished({ logPath }));
      expect(summary).toContain("linha 1");
      expect(summary).toContain("linha 2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says so when there is no output instead of pretending", () => {
    expect(buildJobOutcomeSummary(finished({ logPath: "/tmp/nao-existe-job.log" }))).toContain("(sem saída)");
  });
});

describe("job tail reading", () => {
  it("returns the last characters, not the first", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-job-tail-"));
    try {
      const logPath = join(dir, "job.log");
      writeFileSync(logPath, "A".repeat(500) + "FIM");
      const tail = readJobTail(logPath, 100);
      expect(tail).toHaveLength(100);
      expect(tail.endsWith("FIM")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns everything when the log is small", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-job-tail-small-"));
    try {
      const logPath = join(dir, "job.log");
      writeFileSync(logPath, "curto");
      expect(readJobTail(logPath, 1000)).toBe("curto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty for a missing log instead of throwing", () => {
    expect(readJobTail("/tmp/nao-existe-job-tail.log")).toBe("");
  });
});

describe("process liveness", () => {
  it("knows our own pid is alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("reports a pid that cannot exist as dead", () => {
    // PIDs acima do limite do kernel não existem; serve para o reconcile não
    // considerar vivo um job órfão.
    expect(isPidAlive(2_147_483_646)).toBe(false);
  });
});
