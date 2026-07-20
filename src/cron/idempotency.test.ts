import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbDeleteCronJob } from "./cron-db.js";
import { createCronJobIdempotently } from "./idempotency.js";
import type { CronJobInput } from "./types.js";

let stateDir: string | null = null;

const input: CronJobInput = {
  name: "Proactive follow-up",
  schedule: { type: "at", at: Date.now() + 60_000 },
  message: "Check the source session",
  agentId: "proactive-followup-observer",
  replySession: "agent:observer:slack:main:group:C123",
  sessionTarget: "main",
  deleteAfterRun: true,
};

describe("cron creation idempotency", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-cron-idempotency-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("deduplicates observer actions by rule, source turn and normalized action", () => {
    const idempotency = {
      observer: { ruleId: "proactive-followups", sourceTurnIds: ["turn-1"] },
    };
    const first = createCronJobIdempotently(input, idempotency);
    const retry = createCronJobIdempotently(input, idempotency);

    expect(first.created).toBe(true);
    expect(retry).toMatchObject({ created: false, targetId: first.targetId });
    expect(retry.job?.id).toBe(first.targetId);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM cron_jobs").get() as { count: number }).toEqual({ count: 1 });
  });

  it("does not recreate a completed one-shot reaction after its job is deleted", () => {
    const idempotency = {
      observer: { ruleId: "proactive-followups", sourceTurnIds: ["turn-deleted"] },
    };
    const first = createCronJobIdempotently(input, idempotency);
    dbDeleteCronJob(first.targetId);

    const retry = createCronJobIdempotently(input, idempotency);

    expect(retry).toMatchObject({ created: false, targetId: first.targetId, job: null });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM reaction_actions").get() as { count: number }).toEqual({
      count: 1,
    });
  });

  it("allows two distinct actions from the same observer source turn", () => {
    const idempotency = {
      observer: { ruleId: "proactive-followups", sourceTurnIds: ["turn-2"] },
    };
    const first = createCronJobIdempotently(input, idempotency);
    const second = createCronJobIdempotently({ ...input, message: "A different follow-up" }, idempotency);

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.targetId).not.toBe(first.targetId);
  });
});
