import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  buildExplicitReactionActionKey,
  executeIdempotentReactionAction,
  fingerprintReactionAction,
} from "./reaction-actions.js";

let stateDir: string | null = null;

describe("durable reaction actions", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-reaction-action-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("executes once and returns the durable target on retries", () => {
    const key = buildExplicitReactionActionKey("source-turn-1:cron.add");
    const actionFingerprint = fingerprintReactionAction({ schedule: "tomorrow" });
    let executions = 0;
    const run = () =>
      executeIdempotentReactionAction({
        ...key,
        actionType: "cron.add",
        actionFingerprint,
        execute: () => ({ targetType: "cron", targetId: `job-${++executions}` }),
      });

    const first = run();
    const retry = run();

    expect(first).toMatchObject({ created: true, record: { targetId: "job-1" } });
    expect(retry).toMatchObject({ created: false, record: { targetId: "job-1" } });
    expect(executions).toBe(1);
  });

  it("rolls the claim back when the action fails", () => {
    const key = buildExplicitReactionActionKey("retry-after-failure");
    const actionFingerprint = fingerprintReactionAction({ action: "cron.add" });
    expect(() =>
      executeIdempotentReactionAction({
        ...key,
        actionType: "cron.add",
        actionFingerprint,
        execute: () => {
          throw new Error("temporary failure");
        },
      }),
    ).toThrow("temporary failure");

    expect(getDb().prepare("SELECT COUNT(*) AS count FROM reaction_actions").get() as { count: number }).toEqual({
      count: 0,
    });
  });

  it("rejects reuse of an explicit key for a different action", () => {
    const key = buildExplicitReactionActionKey("operator-key");
    executeIdempotentReactionAction({
      ...key,
      actionType: "cron.add",
      actionFingerprint: fingerprintReactionAction({ message: "first" }),
      execute: () => ({ targetType: "cron", targetId: "job-1" }),
    });

    expect(() =>
      executeIdempotentReactionAction({
        ...key,
        actionType: "cron.add",
        actionFingerprint: fingerprintReactionAction({ message: "different" }),
        execute: () => ({ targetType: "cron", targetId: "job-2" }),
      }),
    ).toThrow("different reaction action");
  });
});
