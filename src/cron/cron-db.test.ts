import { afterEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import {
  dbCreateCronJob,
  dbGetCronJob,
  dbMarkJobDispatched,
  dbRecordJobOutcome,
  dbUpdateCronJob,
  dbUpdateJobState,
} from "./cron-db.js";

const createdJobIds: string[] = [];

afterEach(() => {
  const db = getDb();
  for (const id of createdJobIds.splice(0)) {
    db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  }
});

describe("dbUpdateCronJob", () => {
  it("persists shell execution fields", () => {
    const created = dbCreateCronJob({
      name: `test-shell-cron-${Date.now()}`,
      schedule: { type: "every", every: 60_000 },
      message: "",
      executionType: "shell",
      shellCommand: "printf ok",
      shellTimeoutMs: 30_000,
      shellEnvFile: "/tmp/job.env",
      onError: "notify-session:ops",
    });
    createdJobIds.push(created.id);

    const reloaded = dbGetCronJob(created.id);
    expect(reloaded).toMatchObject({
      executionType: "shell",
      message: "",
      shellCommand: "printf ok",
      shellTimeoutMs: 30_000,
      shellEnvFile: "/tmp/job.env",
      onError: "notify-session:ops",
    });
  });

  it("clears nullable fields when explicitly updated to undefined", () => {
    const created = dbCreateCronJob({
      name: `test-cron-${Date.now()}`,
      schedule: { type: "every", every: 60_000 },
      message: "noop",
      agentId: "test-agent",
      accountId: "test-account",
      description: "test description",
      replySession: "agent:main:main",
      sessionTarget: "main",
    });
    createdJobIds.push(created.id);

    const updated = dbUpdateCronJob(created.id, {
      accountId: undefined,
      description: undefined,
      replySession: undefined,
      shellCommand: undefined,
      shellTimeoutMs: undefined,
      shellEnvFile: undefined,
      onError: undefined,
    });

    expect(updated.accountId).toBeUndefined();
    expect(updated.description).toBeUndefined();
    expect(updated.replySession).toBeUndefined();
    expect(updated.shellCommand).toBeUndefined();
    expect(updated.shellTimeoutMs).toBeUndefined();
    expect(updated.shellEnvFile).toBeUndefined();
    expect(updated.onError).toBeUndefined();

    const reloaded = dbGetCronJob(created.id);
    expect(reloaded?.accountId).toBeUndefined();
    expect(reloaded?.description).toBeUndefined();
    expect(reloaded?.replySession).toBeUndefined();
    expect(reloaded?.shellCommand).toBeUndefined();
    expect(reloaded?.shellTimeoutMs).toBeUndefined();
    expect(reloaded?.shellEnvFile).toBeUndefined();
    expect(reloaded?.onError).toBeUndefined();
  });
});

describe("cron owner principal", () => {
  it("persists the owner set at creation and leaves legacy jobs NULL", () => {
    const owned = dbCreateCronJob({
      name: `test-owner-cron-${Date.now()}`,
      schedule: { type: "every", every: 60_000 },
      message: "noop",
      ownerPrincipal: "operator",
    });
    createdJobIds.push(owned.id);
    const legacy = dbCreateCronJob({
      name: `test-owner-legacy-${Date.now()}`,
      schedule: { type: "every", every: 60_000 },
      message: "noop",
    });
    createdJobIds.push(legacy.id);

    expect(dbGetCronJob(owned.id)?.ownerPrincipal).toBe("operator");
    expect(dbGetCronJob(legacy.id)?.ownerPrincipal).toBeUndefined();
    const raw = getDb().prepare("SELECT owner_principal FROM cron_jobs WHERE id = ?").get(legacy.id) as {
      owner_principal: string | null;
    };
    expect(raw.owner_principal).toBeNull();
  });

  it("updates the owner when the job is re-owned", () => {
    const created = dbCreateCronJob({
      name: `test-owner-update-${Date.now()}`,
      schedule: { type: "every", every: 60_000 },
      message: "noop",
      ownerPrincipal: "operator",
    });
    createdJobIds.push(created.id);

    const updated = dbUpdateCronJob(created.id, { ownerPrincipal: "contact:c_bob" });

    expect(updated.ownerPrincipal).toBe("contact:c_bob");
    expect(dbGetCronJob(created.id)?.ownerPrincipal).toBe("contact:c_bob");
  });
});

describe("agent job dispatch and outcome state", () => {
  it("dbMarkJobDispatched advances the schedule and clears the previous outcome", () => {
    const created = dbCreateCronJob({
      name: `test-dispatch-${Date.now()}`,
      schedule: { type: "every", every: 60_000 },
      message: "noop",
    });
    createdJobIds.push(created.id);

    dbUpdateJobState(created.id, {
      lastRunAt: 1_000,
      lastStatus: "ok",
      lastDurationMs: 12,
      nextRunAt: 61_000,
      lastExitCode: 0,
    });

    dbMarkJobDispatched(created.id, { lastRunAt: 61_000, nextRunAt: 121_000 });

    const job = dbGetCronJob(created.id);
    expect(job?.lastRunAt).toBe(61_000);
    expect(job?.nextRunAt).toBe(121_000);
    expect(job?.lastStatus).toBeUndefined();
    expect(job?.lastError).toBeUndefined();
    expect(job?.lastDurationMs).toBeUndefined();
    expect(job?.lastExitCode).toBeUndefined();
  });

  it("dbRecordJobOutcome writes the turn result without touching the schedule", () => {
    const created = dbCreateCronJob({
      name: `test-outcome-${Date.now()}`,
      schedule: { type: "every", every: 60_000 },
      message: "noop",
    });
    createdJobIds.push(created.id);

    dbMarkJobDispatched(created.id, { lastRunAt: 5_000, nextRunAt: 65_000 });

    expect(
      dbRecordJobOutcome(created.id, {
        lastStatus: "error",
        lastError: "400 model not supported",
        lastDurationMs: 2_345,
      }),
    ).toBe(true);

    const failed = dbGetCronJob(created.id);
    expect(failed).toMatchObject({
      lastRunAt: 5_000,
      nextRunAt: 65_000,
      lastStatus: "error",
      lastError: "400 model not supported",
      lastDurationMs: 2_345,
    });

    expect(dbRecordJobOutcome(created.id, { lastStatus: "ok", lastDurationMs: 900 })).toBe(true);
    const recovered = dbGetCronJob(created.id);
    expect(recovered?.lastStatus).toBe("ok");
    expect(recovered?.lastError).toBeUndefined();
    expect(recovered?.lastDurationMs).toBe(900);
  });

  it("dbRecordJobOutcome reports false for jobs that no longer exist", () => {
    expect(dbRecordJobOutcome("missing-job", { lastStatus: "ok" })).toBe(false);
  });
});
