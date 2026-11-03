import { describe, expect, test } from "bun:test";

import { adminTriageState, buildBugTriageStorePatch, parseBugTriageV1 } from "./bug-reports";
import { BUG_TRIAGE_SCHEMA_VERSION } from "./bug-reports";
import { isActiveTriageJobStatus } from "./bug-triage-jobs";

const TRIAGE = parseBugTriageV1({
  schemaVersion: BUG_TRIAGE_SCHEMA_VERSION,
  model: "qwen3.8-27b",
  summary: "Worker-stored suggestion.",
  suggestedPriority: "p0",
  suggestedStatus: "in_progress",
  similarBugIds: [],
  missingEvidence: [],
  clarifyingQuestions: [],
  confidence: 0.9,
  priorityScore: 95,
});

describe("bug triage job worker store", () => {
  test("persist patch sets score timestamps and never writes confirmed priority or status", () => {
    const now = new Date("2026-09-13T00:00:00.000Z");
    const patch = buildBugTriageStorePatch({ triagedAt: null }, TRIAGE, now);
    expect(patch.triageJson).toEqual(TRIAGE);
    expect(patch.priorityScore).toBe(95);
    expect(patch.triagedAt).toEqual(now);
    expect(patch.lastTriageAt).toEqual(now);
    expect(patch).not.toHaveProperty("priority");
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("statusNote");
    expect(patch).not.toHaveProperty("duplicateOfId");
  });

  test("does not overwrite an existing first-triage timestamp", () => {
    const first = new Date("2026-09-01T00:00:00.000Z");
    const now = new Date("2026-09-13T00:00:00.000Z");
    const patch = buildBugTriageStorePatch({ triagedAt: first }, TRIAGE, now);
    expect(patch.triagedAt).toEqual(first);
    expect(patch.lastTriageAt).toEqual(now);
  });
});

describe("bug triage job inbox state", () => {
  test("pending vs ready vs failed vs idle", () => {
    expect(adminTriageState({ triage: null, triageJob: null })).toBe("idle");
    expect(
      adminTriageState({
        triage: null,
        triageJob: {
          id: "job",
          bugReportId: "bug",
          status: "queued",
          trigger: "create",
          attempts: 0,
          lastError: null,
          createdAt: 1,
          updatedAt: 1,
          startedAt: null,
          finishedAt: null,
        },
      }),
    ).toBe("pending");
    expect(
      adminTriageState({
        triage: {
          model: "qwen3.8-27b",
          summary: "ready",
          suggestedPriority: "p2",
          suggestedStatus: null,
          confidence: 0.4,
          similarBugIds: [],
        },
        triageJob: {
          id: "job",
          bugReportId: "bug",
          status: "completed",
          trigger: "create",
          attempts: 1,
          lastError: null,
          createdAt: 1,
          updatedAt: 1,
          startedAt: 1,
          finishedAt: 2,
        },
      }),
    ).toBe("ready");
    expect(
      adminTriageState({
        triage: null,
        triageJob: {
          id: "job",
          bugReportId: "bug",
          status: "failed",
          trigger: "create",
          attempts: 3,
          lastError: "triage_engine_not_configured",
          createdAt: 1,
          updatedAt: 1,
          startedAt: 1,
          finishedAt: 2,
        },
      }),
    ).toBe("failed");
  });

  test("only queued and running jobs are active", () => {
    expect(isActiveTriageJobStatus("queued")).toBe(true);
    expect(isActiveTriageJobStatus("running")).toBe(true);
    expect(isActiveTriageJobStatus("completed")).toBe(false);
    expect(isActiveTriageJobStatus("failed")).toBe(false);
  });
});
