import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { CliApiError } from "@/server/cli/errors";
import {
  BUG_REPORT_DELETED_TITLE_MAX,
  BUG_REPORT_SCHEMA_VERSION,
  BUG_TRIAGE_SCHEMA_VERSION,
  MAX_BUG_REPORT_BODY_BYTES,
  TRIAGE_ENGINE_NOT_CONFIGURED,
  assertBugReportBodySize,
  assertNotSelfDuplicate,
  adminTriageState,
  bugReportConsoleUrl,
  bugReportDeletedAuditMetadata,
  buildBugTriageStorePatch,
  deleteBugReport,
  mapBugReportCliError,
  parseAdminBugListQuery,
  parseApplyTriageBody,
  parseBugReportCreateBody,
  parseBugReportStatusUpdate,
  parseBugTriageV1,
  parseStoreTriageRequest,
  priorityScoreFor,
  redactInlineSecrets,
  sanitizeJsonRecord,
  type BugReportDeleteRow,
  type BugReportDeleteStore,
  type BugReportDeletedAudit,
} from "./bug-reports";
import { isBugTriageEngineConfigured } from "./bug-triage-config";

describe("bug report create validation", () => {
  test("requires title, summary, severity, and payload object", () => {
    try {
      parseBugReportCreateBody({ title: "Missing fields" });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).status).toBe(400);
      expect((error as ConsoleApiError).payload.error).toBe("validation_failed");
    }
  });

  test("accepts a ravi.bug_report/v1 body", () => {
    const parsed = parseBugReportCreateBody({
      schemaVersion: BUG_REPORT_SCHEMA_VERSION,
      title: "CLI watch never arms",
      summary: "Creating a GitHub watch returns 200 but no events arrive.",
      severity: "high",
      surface: "cli",
      payload: {
        steps: "ravi watches create",
        expected: "events in inbox",
        actual: "empty inbox",
      },
    });

    expect(parsed.title).toBe("CLI watch never arms");
    expect(parsed.severity).toBe("high");
    expect(parsed.surface).toBe("cli");
    expect(parsed.payload.steps).toBe("ravi watches create");
  });

  test("rejects unknown schema versions", () => {
    expect(() =>
      parseBugReportCreateBody({
        schemaVersion: "ravi.bug_report/v0",
        title: "Old schema",
        summary: "Should fail",
        severity: "low",
        payload: {},
      }),
    ).toThrow(ConsoleApiError);
  });

  test("accepts dossier-sized bodies under the 512 KiB limit", () => {
    const parsed = parseBugReportCreateBody({
      title: "Large dossier",
      summary: "Repro with a payload that exceeds the old 16 KiB feedback bound.",
      severity: "high",
      payload: { dossier: "x".repeat(32 * 1024) },
    });
    expect(parsed.title).toBe("Large dossier");
    expect(typeof parsed.payload.dossier).toBe("string");
  });

  test("rejects oversized bodies at the 512 KiB bug-report limit", () => {
    const body = {
      title: "Huge",
      summary: "x".repeat(8000),
      severity: "low",
      payload: { note: "x".repeat(MAX_BUG_REPORT_BODY_BYTES) },
    };
    expect(() => assertBugReportBodySize(body)).toThrow(ConsoleApiError);
    try {
      assertBugReportBodySize(body);
    } catch (error) {
      expect((error as ConsoleApiError).status).toBe(413);
      expect((error as ConsoleApiError).payload.error).toBe("payload_too_large");
    }
  });
});

describe("bug report secret sanitization", () => {
  test("redacts bearer tokens, private keys, and secret-named fields", () => {
    expect(redactInlineSecrets("Authorization Bearer abcdefghijklmnop")).toContain("[REDACTED]");
    const sanitized = sanitizeJsonRecord({
      steps: "used token sk-abcdefghijklmnopqrstuv",
      password: "super-secret-value",
      environment: { apiKey: "not-a-secret-name-but-nested", token: "abcd1234secret" },
    });
    expect(String(sanitized.steps)).toContain("sk-[REDACTED]");
    expect(sanitized.password).toBe("[REDACTED]");
    const environment = sanitized.environment as Record<string, unknown>;
    expect(environment.token).toBe("[REDACTED]");
  });
});

describe("bug report status updates", () => {
  test("accepts allowed statuses and optional notes", () => {
    expect(parseBugReportStatusUpdate({ status: "in_progress" })).toEqual({
      status: "in_progress",
      statusNote: null,
    });
    expect(parseBugReportStatusUpdate({ status: "wontfix", statusNote: "duplicate of earlier report" })).toEqual({
      status: "wontfix",
      statusNote: "duplicate of earlier report",
    });
  });

  test("rejects unknown statuses", () => {
    expect(() => parseBugReportStatusUpdate({ status: "closed" })).toThrow(ConsoleApiError);
  });

  test("accepts optional priority, assignee, and duplicate fields", () => {
    expect(
      parseBugReportStatusUpdate({
        status: "triaging",
        priority: "p1",
        assigneeUserId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      status: "triaging",
      statusNote: null,
      priority: "p1",
      assigneeUserId: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("requires duplicateOf when status is duplicate", () => {
    try {
      parseBugReportStatusUpdate({ status: "duplicate" });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).payload.fieldErrors?.duplicateOf).toMatch(/required/i);
    }
  });

  test("rejects a report marked as a duplicate of itself", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    try {
      assertNotSelfDuplicate(id, id);
      throw new Error("expected self-duplicate failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).payload.fieldErrors?.duplicateOf).toMatch(/itself/i);
    }
  });

  test("allows a distinct duplicateOf uuid", () => {
    expect(() =>
      assertNotSelfDuplicate("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"),
    ).not.toThrow();
    expect(
      parseBugReportStatusUpdate({
        status: "duplicate",
        duplicateOf: "22222222-2222-4222-8222-222222222222",
      }),
    ).toMatchObject({
      status: "duplicate",
      duplicateOf: "22222222-2222-4222-8222-222222222222",
    });
  });
});

describe("bug report CLI error mapping", () => {
  test("maps not found and validation to stable CLI envelopes", () => {
    const notFound = mapBugReportCliError(new ConsoleApiError(404, { error: "not_found" }));
    expect(notFound).toBeInstanceOf(CliApiError);
    expect(notFound).toMatchObject({ status: 404, code: "PAYLOAD_INVALID" });

    const invalid = mapBugReportCliError(new ConsoleApiError(400, { error: "validation_failed" }));
    expect(invalid).toMatchObject({ status: 400, code: "PAYLOAD_INVALID" });

    const oversized = mapBugReportCliError(new ConsoleApiError(413, { error: "payload_too_large" }));
    expect(oversized).toMatchObject({ status: 413, code: "PAYLOAD_INVALID" });
  });
});

const SAMPLE_TRIAGE = {
  schemaVersion: BUG_TRIAGE_SCHEMA_VERSION,
  model: "placeholder/manual",
  summary: "Likely a watch arming race.",
  suggestedPriority: "p1" as const,
  suggestedStatus: "triaging" as const,
  similarBugIds: ["22222222-2222-4222-8222-222222222222"],
  missingEvidence: ["daemon logs"],
  clarifyingQuestions: ["Does it reproduce on main?"],
  confidence: 0.72,
};

describe("bug triage v1 validation", () => {
  test("accepts a complete ravi.bug_triage/v1 document", () => {
    expect(parseBugTriageV1(SAMPLE_TRIAGE)).toMatchObject({
      schemaVersion: BUG_TRIAGE_SCHEMA_VERSION,
      suggestedPriority: "p1",
      confidence: 0.72,
      similarBugIds: ["22222222-2222-4222-8222-222222222222"],
    });
  });

  test("rejects unknown schema versions and out-of-range confidence", () => {
    expect(() => parseBugTriageV1({ ...SAMPLE_TRIAGE, schemaVersion: "ravi.bug_triage/v0" })).toThrow(ConsoleApiError);
    expect(() => parseBugTriageV1({ ...SAMPLE_TRIAGE, confidence: 1.2 })).toThrow(ConsoleApiError);
    expect(() => parseBugTriageV1({ ...SAMPLE_TRIAGE, suggestedPriority: "p9" })).toThrow(ConsoleApiError);
    expect(() => parseBugTriageV1({ ...SAMPLE_TRIAGE, similarBugIds: ["not-a-uuid"] })).toThrow(ConsoleApiError);
  });

  test("maps suggested priority to default scores unless an explicit score is provided", () => {
    expect(priorityScoreFor("p0")).toBe(95);
    expect(priorityScoreFor("p1")).toBe(80);
    expect(priorityScoreFor("p2")).toBe(55);
    expect(priorityScoreFor("p3")).toBe(30);
    expect(priorityScoreFor("p1", 41)).toBe(41);
  });

  test("treats a missing triage body as enqueue, not an implicit store", () => {
    expect(parseStoreTriageRequest({})).toEqual({ kind: "missing" });
    expect(parseStoreTriageRequest({ triage: null })).toEqual({ kind: "missing" });
    const stored = parseStoreTriageRequest({ triage: SAMPLE_TRIAGE });
    expect(stored).toEqual({ kind: "ok", triage: parseBugTriageV1(SAMPLE_TRIAGE) });
    expect(TRIAGE_ENGINE_NOT_CONFIGURED).toBe("triage_engine_not_configured");
    expect(isBugTriageEngineConfigured({})).toBe(false);
  });

  test("manual store patch does not auto-apply priority or status", () => {
    const now = new Date("2026-09-13T00:00:00.000Z");
    const patch = buildBugTriageStorePatch({ triagedAt: null }, parseBugTriageV1(SAMPLE_TRIAGE), now);
    expect(patch.priorityScore).toBe(80);
    expect(patch).not.toHaveProperty("priority");
    expect(patch).not.toHaveProperty("status");
    expect(adminTriageState({ triage: null, triageJob: null })).toBe("idle");
  });
});

describe("apply-triage parsers", () => {
  test("requires at least one apply flag", () => {
    try {
      parseApplyTriageBody({});
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).payload.fieldErrors?.apply).toMatch(/at least one/i);
    }
  });

  test("accepts apply flags and overrides", () => {
    expect(
      parseApplyTriageBody({
        applyPriority: true,
        applyStatus: true,
        applyDuplicate: false,
        priority: "p0",
        status: "in_progress",
        duplicateOf: "22222222-2222-4222-8222-222222222222",
      }),
    ).toEqual({
      applyPriority: true,
      applyStatus: true,
      applyDuplicate: false,
      priority: "p0",
      status: "in_progress",
      duplicateOf: "22222222-2222-4222-8222-222222222222",
    });
  });
});

describe("admin bug list query", () => {
  test("defaults limit and offset and accepts filters", () => {
    expect(parseAdminBugListQuery({})).toEqual({
      limit: 50,
      offset: 0,
    });
    expect(
      parseAdminBugListQuery(
        new URLSearchParams({
          status: "submitted",
          priority: "p0",
          q: "watch",
          assigneeUserId: "11111111-1111-4111-8111-111111111111",
          limit: "25",
          offset: "50",
        }),
      ),
    ).toEqual({
      status: "submitted",
      priority: "p0",
      q: "watch",
      assigneeUserId: "11111111-1111-4111-8111-111111111111",
      limit: 25,
      offset: 50,
    });
  });

  test("rejects invalid filters", () => {
    expect(() => parseAdminBugListQuery({ status: "closed" })).toThrow(ConsoleApiError);
    expect(() => parseAdminBugListQuery({ limit: "999" })).toThrow(ConsoleApiError);
    expect(() => parseAdminBugListQuery({ assigneeUserId: "nope" })).toThrow(ConsoleApiError);
  });
});

describe("bug report hard delete", () => {
  const REPORT_ID = "11111111-1111-4111-8111-111111111111";

  function memoryDeleteStore(initial?: BugReportDeleteRow) {
    const rows = new Map<string, BugReportDeleteRow>();
    const audits: BugReportDeletedAudit[] = [];
    if (initial) rows.set(initial.id, initial);
    const store: BugReportDeleteStore = {
      findById: async (id) => rows.get(id) ?? null,
      commitDelete: async ({ existing, audit }) => {
        rows.delete(existing.id);
        audits.push(audit);
      },
    };
    return { store, rows, audits };
  }

  function sampleRow(overrides: Partial<BugReportDeleteRow> = {}): BugReportDeleteRow {
    return {
      id: REPORT_ID,
      title: "Harness noise that should be removable",
      surface: "harness",
      status: "wontfix",
      organizationId: null,
      projectId: null,
      ...overrides,
    };
  }

  test("rejects invalid ids before touching storage", async () => {
    const { store, rows, audits } = memoryDeleteStore(sampleRow());
    try {
      await deleteBugReport({ id: "not-a-uuid", requestId: "req_invalid" }, store);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).status).toBe(400);
      expect((error as ConsoleApiError).payload.error).toBe("validation_failed");
    }
    expect(rows.size).toBe(1);
    expect(audits).toHaveLength(0);
  });

  test("authorizes the mutation by deleting once, writing audit, then 404ing", async () => {
    const row = sampleRow({
      title: `${"Very long harness title that must be truncated for audit metadata ".repeat(3)}payload-secret-should-never-appear`,
    });
    const { store, rows, audits } = memoryDeleteStore(row);

    const deleted = await deleteBugReport(
      { id: REPORT_ID, requestId: "req_delete", actorType: "user", actorId: "operator-1" },
      store,
    );
    expect(deleted).toEqual({ id: REPORT_ID, deleted: true });
    expect(rows.size).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "bug_report.deleted",
      actorType: "user",
      actorId: "operator-1",
      requestId: "req_delete",
      targetId: REPORT_ID,
      targetType: "bug_report",
    });
    expect(audits[0]?.metadataJson.id).toBe(REPORT_ID);
    expect(audits[0]?.metadataJson.surface).toBe("harness");
    expect(audits[0]?.metadataJson.title.length).toBeLessThanOrEqual(BUG_REPORT_DELETED_TITLE_MAX);
    expect(JSON.stringify(audits[0]?.metadataJson)).not.toContain("payload-secret-should-never-appear");
    expect(audits[0]?.metadataJson).not.toHaveProperty("payload");

    try {
      await deleteBugReport({ id: REPORT_ID, requestId: "req_again" }, store);
      throw new Error("expected not found after delete");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).status).toBe(404);
      expect((error as ConsoleApiError).payload.error).toBe("not_found");
    }
    expect(audits).toHaveLength(1);
  });

  test("audit metadata keeps only safe fields and truncates the title", () => {
    const metadata = bugReportDeletedAuditMetadata({
      id: REPORT_ID,
      title: `${"x".repeat(200)} secret-token-value`,
      surface: "harness",
      status: "submitted",
    });
    expect(metadata).toEqual({
      id: REPORT_ID,
      surface: "harness",
      title: `${"x".repeat(BUG_REPORT_DELETED_TITLE_MAX - 1)}…`,
      status: "submitted",
    });
    expect(JSON.stringify(metadata)).not.toContain("secret-token-value");
  });
});

describe("bug report console url", () => {
  test("uses the public console origin", () => {
    const previous = process.env.NEXT_PUBLIC_CONSOLE_URL;
    delete process.env.NEXT_PUBLIC_CONSOLE_URL;
    expect(bugReportConsoleUrl("11111111-1111-4111-8111-111111111111")).toBe(
      "https://console.ravi.bot/bugs/11111111-1111-4111-8111-111111111111",
    );
    process.env.NEXT_PUBLIC_CONSOLE_URL = "https://console.example.test/";
    expect(bugReportConsoleUrl("11111111-1111-4111-8111-111111111111")).toBe(
      "https://console.example.test/bugs/11111111-1111-4111-8111-111111111111",
    );
    if (previous === undefined) delete process.env.NEXT_PUBLIC_CONSOLE_URL;
    else process.env.NEXT_PUBLIC_CONSOLE_URL = previous;
  });
});
