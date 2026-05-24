import { afterEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { dbCreateCronJob, dbGetCronJob, dbUpdateCronJob } from "./cron-db.js";

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
