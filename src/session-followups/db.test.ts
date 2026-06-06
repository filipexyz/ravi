import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  createSessionFollowupCadence,
  createSessionFollowupRun,
  listSessionFollowupCadences,
  listSessionFollowupRuns,
} from "./db.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-session-followups-db-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("session followups db", () => {
  it("creates idle cadences with normalized followup steps", () => {
    const cadence = createSessionFollowupCadence({
      name: "Group check",
      targetType: "session",
      targetRef: "main",
      schedule: { type: "every", every: 60_000 },
      messageTemplate: "Check this session.",
      now: 1_000,
    });

    expect(cadence.id).toStartWith("sfup_");
    expect(cadence.nextRunAt).toBe(1_000);
    expect(cadence.schedule.steps).toEqual([{ afterMs: 60_000, messageTemplate: "Check this session." }]);
    expect(cadence.deliveryBarrier).toBe("after_response");
    expect(listSessionFollowupCadences().items).toHaveLength(1);
  });

  it("dedupes runs by idempotency key", () => {
    const cadence = createSessionFollowupCadence({
      name: "Idempotent check",
      targetType: "session",
      targetRef: "main",
      schedule: { type: "every", every: 60_000 },
      messageTemplate: "Check.",
      now: 1_000,
    });

    const first = createSessionFollowupRun({
      cadenceId: cadence.id,
      targetType: "session",
      targetRef: "main",
      dueAt: 2_000,
      idempotencyKey: "cadence:main:2000",
    });
    const second = createSessionFollowupRun({
      cadenceId: cadence.id,
      targetType: "session",
      targetRef: "main",
      dueAt: 2_000,
      idempotencyKey: "cadence:main:2000",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(listSessionFollowupRuns({ cadenceId: cadence.id }).items).toHaveLength(1);
  });
});
