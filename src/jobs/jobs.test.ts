import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "../router/router-db.js";
import {
  buildJobEnv,
  buildJobOutcomeSummary,
  isPidAlive,
  JOB_DELIVERY_INFLIGHT_STALE_MS,
  jobOutcomeMessageId,
  JobsRunner,
  readJobTail,
} from "./runner.js";
import {
  dbClaimJobDelivery,
  dbCreateJob,
  dbFinishJob,
  dbGetJob,
  dbListJobs,
  dbListRunningJobs,
  dbListUndeliveredJobs,
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

describe("job runner", () => {
  it("starts the command as acting for the job, never as the operator's terminal", () => {
    const job = makeJob();
    const envs: Array<Record<string, string>> = [];
    const runner = new JobsRunner({
      spawnCommand: (_command, _cwd, _logPath, env) => {
        envs.push(env);
        return { pid: null, onExit: () => {} };
      },
      notifySession: async () => {},
    });
    // startJob only runs on a started runner; start() would also subscribe to NATS.
    (runner as unknown as { running: boolean }).running = true;

    expect(runner.startJob(job.id)).toBe(true);
    expect(envs).toHaveLength(1);
    expect(envs[0]?.RAVI_AUTOMATION_PRINCIPAL).toBe(`automation:job:${job.id}`);
  });

  it("starts every job with the allowlisted env, whoever created it", () => {
    const daemonEnv = {
      PATH: "/usr/bin:/bin",
      RAVI_STATE_DIR: "/tmp/ravi-state",
      RAVI_ADMIN_TOKEN: "canary-admin",
      OPENAI_API_KEY: "canary-openai",
      DEVIN_API_KEY: "canary-devin",
    };

    // No owner, an agent, a session: there is no exception, not even for the operator.
    const env = buildJobEnv({ id: "job_any" }, daemonEnv);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.RAVI_STATE_DIR).toBe("/tmp/ravi-state");
    expect(env.RAVI_ADMIN_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DEVIN_API_KEY).toBeUndefined();
    expect(env.RAVI_AUTOMATION_PRINCIPAL).toBe("automation:job:job_any");
  });

  it("gets a secret only through the operator's passthrough list", () => {
    // The documented way for a job to receive a daemon secret; nothing else opts one in.
    const daemonEnv = {
      PATH: "/usr/bin:/bin",
      RAVI_ADMIN_TOKEN: "canary-admin",
      DEVIN_API_KEY: "canary-devin",
      ELEVENLABS_API_KEY: "canary-elevenlabs",
      RAVI_AGENT_ENV_PASSTHROUGH: "DEVIN_API_KEY",
    };
    const env = buildJobEnv({ id: "job_passthrough" }, daemonEnv);
    expect(env.DEVIN_API_KEY).toBe("canary-devin");
    expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    expect(env.RAVI_ADMIN_TOKEN).toBeUndefined();
  });

  it("spawns an agent-owned job without the daemon env underneath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-job-env-"));
    const logPath = join(dir, "job.log");
    const previous = process.env.RAVI_JOB_TEST_CANARY_SECRET;
    process.env.RAVI_JOB_TEST_CANARY_SECRET = "canary-job-secret";
    try {
      const job = makeJob({ command: "env", logPath });
      const exited = new Promise<void>((resolve) => {
        const runner = new JobsRunner({ notifySession: async () => resolve() });
        (runner as unknown as { running: boolean }).running = true;
        expect(runner.startJob(job.id)).toBe(true);
      });
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);

      const output = readFileSync(logPath, "utf8");
      expect(output).toContain("RAVI_AUTOMATION_PRINCIPAL=");
      expect(output).not.toContain("RAVI_JOB_TEST_CANARY_SECRET");
      expect(output).not.toContain("canary-job-secret");
    } finally {
      if (previous === undefined) delete process.env.RAVI_JOB_TEST_CANARY_SECRET;
      else process.env.RAVI_JOB_TEST_CANARY_SECRET = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a failed outcome delivery on the job and retries it instead of dropping it", async () => {
    const job = makeJob();
    dbMarkJobRunning(job.id, process.pid);
    dbFinishJob(job.id, { status: "succeeded", exitCode: 0, signal: null });
    const delivered: string[] = [];
    let queueUp = false;
    const runner = new JobsRunner({
      notifySession: async (record) => {
        if (!queueUp) throw new Error("queue down");
        delivered.push(record.id);
      },
    });

    await runner.handleJobFinished(job.id);
    const failed = dbGetJob(job.id)!;
    expect(failed.notifiedAt).toBeNull();
    expect(failed.deliveryError).toBe("queue down");
    expect(failed.deliveryAttempts).toBe(1);

    queueUp = true;
    await runner.redeliverUndeliveredOutcomes();
    expect(delivered).toEqual([job.id]);
    expect(dbGetJob(job.id)?.notifiedAt).toBeGreaterThan(0);
  });

  it("overlapping_redelivery_publishes_completion_once", async () => {
    const job = makeJob();
    dbMarkJobRunning(job.id, process.pid);
    dbFinishJob(job.id, { status: "succeeded", exitCode: 0, signal: null });

    // The publish stays in flight until the test releases it.
    const published: Array<{ jobId: string; messageId: string }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new JobsRunner({
      notifySession: async (record, _summary, delivery) => {
        // The reconcile walks every undelivered job in the database.
        if (record.id !== job.id) return;
        published.push({ jobId: record.id, messageId: delivery.messageId });
        await gate;
      },
    });

    const first = runner.handleJobFinished(job.id);
    // The outcome is reserved before the publish resolves.
    const inflight = dbGetJob(job.id)!;
    expect(inflight.deliveryState).toBe("inflight");
    expect(inflight.notifiedAt).toBeNull();

    // Every other route that can see the same outcome runs while it is in flight.
    await runner.redeliverUndeliveredOutcomes();
    await runner.reconcileOrphans();
    await runner.handleJobFinished(job.id);
    expect(published).toHaveLength(1);

    release();
    await first;
    const notified = dbGetJob(job.id)!;
    expect(notified.deliveryState).toBe("notified");
    expect(notified.notifiedAt).toBeGreaterThan(0);
    expect(notified.deliveryClaimedAt).toBeNull();

    await runner.reconcileOrphans();
    expect(published).toEqual([{ jobId: job.id, messageId: jobOutcomeMessageId(job.id) }]);
  });

  it("a stale in-flight delivery is retried under the same deduplication key", async () => {
    const job = makeJob();
    dbMarkJobRunning(job.id, process.pid);
    dbFinishJob(job.id, { status: "succeeded", exitCode: 0, signal: null });

    let clock = Date.now();
    const published: string[] = [];
    const hung = new Promise<void>(() => {});
    const runner = new JobsRunner({
      now: () => clock,
      notifySession: async (_record, _summary, delivery) => {
        published.push(delivery.messageId);
        // The first publish never settles: whoever reserved it is gone.
        if (published.length === 1) await hung;
      },
    });

    void runner.handleJobFinished(job.id);
    expect(published).toHaveLength(1);

    clock += JOB_DELIVERY_INFLIGHT_STALE_MS - 1;
    await runner.redeliverUndeliveredOutcomes();
    expect(published).toHaveLength(1);

    clock += 1;
    await runner.redeliverUndeliveredOutcomes();
    // Same key both times: the queue drops the second if the first reached it.
    expect(published).toEqual([jobOutcomeMessageId(job.id), jobOutcomeMessageId(job.id)]);
    expect(dbGetJob(job.id)?.deliveryState).toBe("notified");
  });

  it("a failed delivery releases the reservation, and a delivered job is never reopened", async () => {
    const job = makeJob();
    dbMarkJobRunning(job.id, process.pid);
    dbFinishJob(job.id, { status: "failed", exitCode: 1, signal: null });
    const staleAfterMs = JOB_DELIVERY_INFLIGHT_STALE_MS;
    const listed = () =>
      dbListUndeliveredJobs({ maxAttempts: 20, staleAfterMs, limit: 500 }).some((row) => row.id === job.id);

    expect(dbClaimJobDelivery(job.id, { staleAfterMs })).toBe(true);
    expect(dbClaimJobDelivery(job.id, { staleAfterMs })).toBe(false);
    expect(listed()).toBe(false);

    const failing = async () => {
      throw new Error("queue down");
    };
    // The reservation is held elsewhere: this route neither publishes nor counts a failure.
    await new JobsRunner({ notifySession: failing }).handleJobFinished(job.id);
    expect(dbGetJob(job.id)?.deliveryAttempts).toBe(0);

    // A stale reservation is retaken; its failure hands the job back to the reconcile.
    await new JobsRunner({ now: () => Date.now() + staleAfterMs, notifySession: failing }).handleJobFinished(job.id);
    const released = dbGetJob(job.id)!;
    expect(released.deliveryState).toBe("pending");
    expect(released.deliveryClaimedAt).toBeNull();
    expect(released.deliveryAttempts).toBe(1);
    expect(listed()).toBe(true);

    dbMarkJobNotified(job.id);
    expect(dbClaimJobDelivery(job.id, { staleAfterMs })).toBe(false);
  });

  it("does not reserve the delivery of a job that has not finished", () => {
    const job = makeJob();
    dbMarkJobRunning(job.id, process.pid);
    expect(dbClaimJobDelivery(job.id, { staleAfterMs: JOB_DELIVERY_INFLIGHT_STALE_MS })).toBe(false);
    expect(dbGetJob(job.id)?.deliveryState).toBe("pending");
  });
});
