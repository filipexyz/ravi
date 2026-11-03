import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { cliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { emitBugStatusFollow, shouldEmitBugStatusFollow } from "@/server/console/bug-report-follow";
import {
  TRIAGE_ENGINE_NOT_CONFIGURED,
  isBugTriageEngineConfigured,
} from "@/server/console/bug-triage-config";
import { db, schema } from "@/server/db";

export const BUG_REPORT_SCHEMA_VERSION = "ravi.bug_report/v1";
export const BUG_TRIAGE_SCHEMA_VERSION = "ravi.bug_triage/v1";
export const BUG_COMMENT_SCHEMA_VERSION = "ravi.bug_comment/v1";
export const MAX_BUG_REPORT_BODY_BYTES = 512 * 1024;
export const BUG_COMMENT_SOURCES = ["cli", "agent", "console", "user"] as const;
export { TRIAGE_ENGINE_NOT_CONFIGURED } from "@/server/console/bug-triage-config";

export const BUG_REPORT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const BUG_REPORT_STATUSES = [
  "submitted",
  "triaging",
  "in_progress",
  "resolved",
  "wontfix",
  "duplicate",
] as const;
export const BUG_REPORT_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export const BUG_TRIAGE_JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export const BUG_TRIAGE_JOB_TRIGGERS = ["create", "manual"] as const;

export const BUG_REPORT_PRIORITY_SCORE_DEFAULTS = {
  p0: 95,
  p1: 80,
  p2: 55,
  p3: 30,
} as const;

export type BugReportSeverity = (typeof BUG_REPORT_SEVERITIES)[number];
export type BugReportStatus = (typeof BUG_REPORT_STATUSES)[number];
export type BugReportPriority = (typeof BUG_REPORT_PRIORITIES)[number];
export type BugTriageJobStatus = (typeof BUG_TRIAGE_JOB_STATUSES)[number];
export type BugTriageJobTrigger = (typeof BUG_TRIAGE_JOB_TRIGGERS)[number];
export type BugCommentSource = (typeof BUG_COMMENT_SOURCES)[number];
export type AdminTriageState = "ready" | "pending" | "failed" | "idle";

export type BugTriageJobSummary = {
  id: string;
  bugReportId: string;
  status: BugTriageJobStatus;
  trigger: BugTriageJobTrigger;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type BugTriageV1 = {
  schemaVersion: typeof BUG_TRIAGE_SCHEMA_VERSION;
  model: string;
  summary: string;
  suggestedPriority: BugReportPriority;
  suggestedStatus?: BugReportStatus;
  similarBugIds: string[];
  missingEvidence: string[];
  clarifyingQuestions: string[];
  surfaceNormalized?: string;
  confidence: number;
  priorityScore?: number;
  rawNotes?: string;
};

export type BugReportSummary = {
  id: string;
  title: string;
  summary: string;
  severity: BugReportSeverity;
  surface: string | null;
  status: BugReportStatus;
  statusNote: string | null;
  priority: BugReportPriority | null;
  statusUpdatedAt: number;
  organizationId: string | null;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  consoleUrl: string;
};

export type BugReportComment = {
  id: string;
  bugId: string;
  schemaVersion: string;
  authorUserId: string;
  source: BugCommentSource;
  text: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: number;
};

export type BugReportDetail = BugReportSummary & {
  schemaVersion: string;
  payload: Record<string, unknown>;
  comments: BugReportComment[];
};

export type BugReportList = {
  total: number;
  items: BugReportSummary[];
};

export type AdminBugTriageSummary = {
  model: string;
  summary: string;
  suggestedPriority: BugReportPriority;
  suggestedStatus: BugReportStatus | null;
  confidence: number;
  similarBugIds: string[];
};

export type AdminBugReportSummary = BugReportSummary & {
  reporterUserId: string;
  priorityScore: number | null;
  assigneeUserId: string | null;
  duplicateOfId: string | null;
  triagedAt: number | null;
  lastTriageAt: number | null;
  triage: AdminBugTriageSummary | null;
  triageJob: BugTriageJobSummary | null;
};

export type AdminBugReportDetail = AdminBugReportSummary & {
  schemaVersion: string;
  payload: Record<string, unknown>;
  triageJson: BugTriageV1 | null;
  comments: BugReportComment[];
};

export type AdminBugReportList = {
  total: number;
  limit: number;
  offset: number;
  items: AdminBugReportSummary[];
};

export type AdminBugListQuery = {
  status?: BugReportStatus;
  priority?: BugReportPriority;
  surface?: string;
  q?: string;
  assigneeUserId?: string;
  limit: number;
  offset: number;
};

export type BugReportStatusUpdate = {
  status: BugReportStatus;
  statusNote: string | null;
  priority?: BugReportPriority | null;
  duplicateOf?: string | null;
  assigneeUserId?: string | null;
};

export type ApplyTriageInput = {
  applyPriority: boolean;
  applyStatus: boolean;
  applyDuplicate: boolean;
  priority?: BugReportPriority;
  status?: BugReportStatus;
  duplicateOf?: string;
};

export const BUG_REPORT_DELETED_TITLE_MAX = 80;

export type BugReportDeleteActor = {
  actorType?: "user" | "system";
  actorId?: string | null;
};

export type BugReportDeleteResult = {
  id: string;
  deleted: true;
};

export type BugReportDeleteRow = {
  id: string;
  title: string;
  surface: string | null;
  status: string;
  organizationId: string | null;
  projectId: string | null;
};

export type BugReportDeletedAudit = {
  organizationId: string | null;
  projectId: string | null;
  actorType: "user" | "system";
  actorId: string | null;
  targetType: "bug_report";
  targetId: string;
  action: "bug_report.deleted";
  requestId: string;
  metadataJson: {
    id: string;
    surface: string | null;
    title: string;
    status: string;
  };
};

export type BugReportDeleteStore = {
  findById(id: string): Promise<BugReportDeleteRow | null>;
  commitDelete(input: { existing: BugReportDeleteRow; audit: BugReportDeletedAudit }): Promise<void>;
};

const bugReportSeveritySchema = z.enum(BUG_REPORT_SEVERITIES);
const bugReportStatusSchema = z.enum(BUG_REPORT_STATUSES);
const bugReportPrioritySchema = z.enum(BUG_REPORT_PRIORITIES);
const uuidSchema = z.string().uuid();

const createBodySchema = z.object({
  schemaVersion: z.literal(BUG_REPORT_SCHEMA_VERSION).optional(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(8000),
  severity: bugReportSeveritySchema,
  surface: z.string().trim().max(120).nullable().optional(),
  organizationId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
});

const statusUpdateBodySchema = z.object({
  status: bugReportStatusSchema,
  statusNote: z.string().trim().max(2000).nullable().optional(),
  priority: bugReportPrioritySchema.nullable().optional(),
  duplicateOf: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
});

const bugTriageSchema = z.object({
  schemaVersion: z.literal(BUG_TRIAGE_SCHEMA_VERSION),
  model: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(8000),
  suggestedPriority: bugReportPrioritySchema,
  suggestedStatus: bugReportStatusSchema.optional(),
  similarBugIds: z.array(z.string().uuid()).max(50),
  missingEvidence: z.array(z.string().trim().min(1).max(500)).max(50),
  clarifyingQuestions: z.array(z.string().trim().min(1).max(500)).max(50),
  surfaceNormalized: z.string().trim().min(1).max(120).optional(),
  confidence: z.number().min(0).max(1),
  priorityScore: z.number().int().min(0).max(100).optional(),
  rawNotes: z.string().trim().min(1).max(8000).optional(),
});

const storeTriageBodySchema = z.object({
  triage: bugTriageSchema.optional().nullable(),
});

const applyTriageBodySchema = z.object({
  applyPriority: z.boolean().optional(),
  applyStatus: z.boolean().optional(),
  applyDuplicate: z.boolean().optional(),
  priority: bugReportPrioritySchema.optional(),
  status: bugReportStatusSchema.optional(),
  duplicateOf: z.string().uuid().optional(),
});

const adminListQuerySchema = z.object({
  status: bugReportStatusSchema.optional(),
  priority: bugReportPrioritySchema.optional(),
  surface: z.string().trim().min(1).max(120).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  assigneeUserId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const SECRET_KEY_PATTERN = /^(password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|credential)$/i;

export function assertBugReportBodySize(body: unknown) {
  const approxBytes = JSON.stringify(body ?? {}).length;
  if (approxBytes > MAX_BUG_REPORT_BODY_BYTES) {
    throw new ConsoleApiError(413, { error: "payload_too_large" });
  }
}

export function parseBugReportCreateBody(body: unknown) {
  assertBugReportBodySize(body);
  const result = createBodySchema.safeParse(body);
  if (!result.success) {
    throw validationFailed(result.error);
  }

  return {
    schemaVersion: result.data.schemaVersion ?? BUG_REPORT_SCHEMA_VERSION,
    title: result.data.title,
    summary: result.data.summary,
    severity: result.data.severity,
    surface: nullableText(result.data.surface),
    organizationId: result.data.organizationId ?? null,
    projectId: result.data.projectId ?? null,
    payload: sanitizeJsonRecord(result.data.payload),
  };
}

export function parseBugReportStatusUpdate(body: unknown): BugReportStatusUpdate {
  assertBugReportBodySize(body);
  const result = statusUpdateBodySchema.safeParse(body);
  if (!result.success) {
    throw validationFailed(result.error);
  }

  if (result.data.status === "duplicate" && !result.data.duplicateOf) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { duplicateOf: "duplicateOf is required when status is duplicate" },
    });
  }

  const parsed: BugReportStatusUpdate = {
    status: result.data.status,
    statusNote: nullableText(result.data.statusNote),
  };
  if (result.data.priority !== undefined) parsed.priority = result.data.priority;
  if (result.data.duplicateOf !== undefined) parsed.duplicateOf = result.data.duplicateOf;
  if (result.data.assigneeUserId !== undefined) parsed.assigneeUserId = result.data.assigneeUserId;
  return parsed;
}

export function parseBugTriageV1(value: unknown): BugTriageV1 {
  const result = bugTriageSchema.safeParse(value);
  if (!result.success) {
    throw validationFailed(result.error);
  }
  return {
    schemaVersion: result.data.schemaVersion,
    model: result.data.model,
    summary: result.data.summary,
    suggestedPriority: result.data.suggestedPriority,
    similarBugIds: result.data.similarBugIds,
    missingEvidence: result.data.missingEvidence,
    clarifyingQuestions: result.data.clarifyingQuestions,
    confidence: result.data.confidence,
    ...(result.data.suggestedStatus ? { suggestedStatus: result.data.suggestedStatus } : {}),
    ...(result.data.surfaceNormalized ? { surfaceNormalized: result.data.surfaceNormalized } : {}),
    ...(result.data.priorityScore !== undefined ? { priorityScore: result.data.priorityScore } : {}),
    ...(result.data.rawNotes ? { rawNotes: result.data.rawNotes } : {}),
  };
}

export function parseStoreTriageRequest(body: unknown): { kind: "missing" } | { kind: "ok"; triage: BugTriageV1 } {
  assertBugReportBodySize(body);
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { triage: "Expected an object" } });
  }
  const result = storeTriageBodySchema.safeParse(body);
  if (!result.success) {
    throw validationFailed(result.error);
  }
  if (!result.data.triage) {
    return { kind: "missing" };
  }
  return { kind: "ok", triage: parseBugTriageV1(result.data.triage) };
}

export function parseApplyTriageBody(body: unknown): ApplyTriageInput {
  assertBugReportBodySize(body);
  const result = applyTriageBodySchema.safeParse(body ?? {});
  if (!result.success) {
    throw validationFailed(result.error);
  }
  const parsed: ApplyTriageInput = {
    applyPriority: result.data.applyPriority === true,
    applyStatus: result.data.applyStatus === true,
    applyDuplicate: result.data.applyDuplicate === true,
  };
  if (result.data.priority) parsed.priority = result.data.priority;
  if (result.data.status) parsed.status = result.data.status;
  if (result.data.duplicateOf) parsed.duplicateOf = result.data.duplicateOf;
  if (!parsed.applyPriority && !parsed.applyStatus && !parsed.applyDuplicate) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { apply: "Select at least one of applyPriority, applyStatus, or applyDuplicate" },
    });
  }
  return parsed;
}

export function parseAdminBugListQuery(input: URLSearchParams | Record<string, string | undefined>): AdminBugListQuery {
  const raw =
    input instanceof URLSearchParams
      ? {
          status: emptyToUndefined(input.get("status")),
          priority: emptyToUndefined(input.get("priority")),
          surface: emptyToUndefined(input.get("surface")),
          q: emptyToUndefined(input.get("q")),
          assigneeUserId: emptyToUndefined(input.get("assigneeUserId")),
          limit: emptyToUndefined(input.get("limit")),
          offset: emptyToUndefined(input.get("offset")),
        }
      : input;
  const result = adminListQuerySchema.safeParse(raw);
  if (!result.success) {
    throw validationFailed(result.error);
  }
  return result.data;
}

export function priorityScoreFor(priority: BugReportPriority, explicit?: number) {
  if (explicit !== undefined) return explicit;
  return BUG_REPORT_PRIORITY_SCORE_DEFAULTS[priority];
}

export function assertNotSelfDuplicate(id: string, duplicateOf: string) {
  if (id === duplicateOf) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { duplicateOf: "A report cannot be a duplicate of itself" },
    });
  }
}

export function mapBugReportCliError(error: unknown) {
  if (error instanceof ConsoleApiError) {
    if (error.payload.error === "not_found") {
      return cliApiError(404, "PAYLOAD_INVALID", "Bug report was not found.");
    }
    if (error.payload.error === "payload_too_large") {
      return cliApiError(413, "PAYLOAD_INVALID", "Request body is too large.");
    }
    if (error.payload.error === "validation_failed" || error.payload.error === "invalid_request") {
      return cliApiError(400, "PAYLOAD_INVALID");
    }
    return cliApiError(503, "SERVER_UNAVAILABLE");
  }
  return error;
}

export function bugReportConsoleUrl(id: string) {
  const baseUrl =
    process.env.NEXT_PUBLIC_CONSOLE_URL?.trim().replace(/\/$/, "") || "https://console.ravi.bot";
  return `${baseUrl}/bugs/${id}`;
}

export function sanitizeJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeJson(value, 0);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

export function redactInlineSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(/\bravi_(?:crt|cat|pat)_[A-Za-z0-9_-]{12,}\b/g, "ravi_[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "gh_[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]")
    .replace(
      /(accessToken|refreshToken|apiKey|secret|password|token)["'=:\s]+[A-Za-z0-9._~+/=-]{8,}/gi,
      "$1=[REDACTED]",
    );
}

export async function createBugReport(input: {
  body: unknown;
  requestId: string;
  reporterUserId: string;
  defaultOrganizationId?: string | null;
  actorType?: "user" | "cli";
}): Promise<BugReportDetail> {
  const parsed = parseBugReportCreateBody(input.body);
  const context = await resolveOptionalContext({
    organizationId: parsed.organizationId ?? input.defaultOrganizationId ?? null,
    projectId: parsed.projectId,
  });
  const now = new Date();
  const payloadJson = {
    schemaVersion: BUG_REPORT_SCHEMA_VERSION,
    title: parsed.title,
    summary: parsed.summary,
    severity: parsed.severity,
    surface: parsed.surface,
    organizationId: context.organizationId,
    projectId: context.projectId,
    payload: parsed.payload,
  };

  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.bugReports)
      .values({
        schemaVersion: BUG_REPORT_SCHEMA_VERSION,
        reporterUserId: input.reporterUserId,
        title: parsed.title,
        summary: parsed.summary,
        severity: parsed.severity,
        surface: parsed.surface,
        status: "submitted",
        statusNote: null,
        statusUpdatedAt: now,
        organizationId: context.organizationId,
        projectId: context.projectId,
        payloadJson,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!created) throw new Error("Failed to store bug report.");

    await tx.insert(schema.bugTriageJobs).values({
      bugReportId: created.id,
      status: "queued",
      trigger: "create",
      requestId: input.requestId,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(schema.auditEvents).values({
      organizationId: context.organizationId,
      projectId: context.projectId,
      actorType: input.actorType ?? "user",
      actorId: input.reporterUserId,
      targetType: "bug_report",
      targetId: created.id,
      action: "bug_report.submitted",
      requestId: input.requestId,
      metadataJson: {
        schemaVersion: BUG_REPORT_SCHEMA_VERSION,
        severity: parsed.severity,
        surface: parsed.surface,
        triageJobQueued: true,
      },
    });

    return created;
  });

  return { ...toDetail(row), comments: [] };
}

export async function listBugReportsForReporter(reporterUserId: string): Promise<BugReportList> {
  const rows = await db
    .select()
    .from(schema.bugReports)
    .where(eq(schema.bugReports.reporterUserId, reporterUserId))
    .orderBy(desc(schema.bugReports.createdAt))
    .limit(200);

  const items = rows.map(toSummary);
  return { total: items.length, items };
}

export async function getBugReportForReporter(input: {
  id: string;
  reporterUserId: string;
}): Promise<BugReportDetail> {
  const row = await findBugReportById(input.id);
  if (!row || row.reporterUserId !== input.reporterUserId) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }
  return { ...toDetail(row), comments: await listStoredComments(row.id) };
}

export async function listAdminBugReports(query: unknown): Promise<AdminBugReportList> {
  const parsed = query instanceof URLSearchParams || isPlainRecord(query) ? parseAdminBugListQuery(query) : parseAdminBugListQuery({});
  const filters: SQL[] = [];

  if (parsed.status) filters.push(eq(schema.bugReports.status, parsed.status));
  if (parsed.priority) filters.push(eq(schema.bugReports.priority, parsed.priority));
  if (parsed.surface) filters.push(eq(schema.bugReports.surface, parsed.surface));
  if (parsed.assigneeUserId) filters.push(eq(schema.bugReports.assigneeUserId, parsed.assigneeUserId));
  if (parsed.q) {
    const pattern = containsPattern(parsed.q);
    const search = or(ilike(schema.bugReports.title, pattern), ilike(schema.bugReports.summary, pattern));
    if (search) filters.push(search);
  }

  const where = filters.length ? and(...filters) : undefined;
  const [totalRow] = await db.select({ total: count() }).from(schema.bugReports).where(where);
  const rows = await db
    .select()
    .from(schema.bugReports)
    .where(where)
    .orderBy(sql`${schema.bugReports.priorityScore} DESC NULLS LAST`, desc(schema.bugReports.createdAt))
    .limit(parsed.limit)
    .offset(parsed.offset);

  return {
    total: Number(totalRow?.total ?? 0),
    limit: parsed.limit,
    offset: parsed.offset,
    items: await attachTriageJobs(rows).then((jobs) => rows.map((row) => toAdminSummary(row, jobs.get(row.id) ?? null))),
  };
}

export async function getAdminBugReport(id: string): Promise<AdminBugReportDetail> {
  const row = await findBugReportById(id);
  if (!row) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }
  const jobs = await attachTriageJobs([row]);
  return withAdminComments(row, jobs.get(row.id) ?? null);
}

export function truncateBugReportTitle(title: string, max = BUG_REPORT_DELETED_TITLE_MAX) {
  const text = title.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function bugReportDeletedAuditMetadata(row: Pick<BugReportDeleteRow, "id" | "title" | "surface" | "status">) {
  return {
    id: row.id,
    surface: row.surface,
    title: truncateBugReportTitle(row.title),
    status: row.status,
  };
}

const liveBugReportDeleteStore: BugReportDeleteStore = {
  async findById(id) {
    const row = await findBugReportById(id);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      surface: row.surface,
      status: row.status,
      organizationId: row.organizationId,
      projectId: row.projectId,
    };
  },
  async commitDelete({ existing, audit }) {
    await db.transaction(async (tx) => {
      await tx.delete(schema.bugReports).where(eq(schema.bugReports.id, existing.id));
      await tx.insert(schema.auditEvents).values(audit);
    });
  },
};

export async function deleteBugReport(
  input: {
    id: string;
    requestId: string;
    actorType?: "user" | "system";
    actorId?: string | null;
  },
  store: BugReportDeleteStore = liveBugReportDeleteStore,
): Promise<BugReportDeleteResult> {
  if (!uuidSchema.safeParse(input.id).success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { id: "Invalid id" },
    });
  }

  const existing = await store.findById(input.id);
  if (!existing) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  await store.commitDelete({
    existing,
    audit: {
      organizationId: existing.organizationId,
      projectId: existing.projectId,
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? null,
      targetType: "bug_report",
      targetId: existing.id,
      action: "bug_report.deleted",
      requestId: input.requestId,
      metadataJson: bugReportDeletedAuditMetadata(existing),
    },
  });

  return { id: existing.id, deleted: true };
}

export async function updateBugReportStatus(input: {
  id: string;
  body: unknown;
  requestId: string;
}): Promise<AdminBugReportDetail> {
  const parsed = parseBugReportStatusUpdate(input.body);
  const existing = await findBugReportById(input.id);
  if (!existing) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  if (parsed.duplicateOf) {
    await assertValidDuplicateOf(existing.id, parsed.duplicateOf);
  }
  if (parsed.assigneeUserId) {
    await assertUserExists(parsed.assigneeUserId);
  }

  const now = new Date();
  const statusChanged = shouldEmitBugStatusFollow(existing.status, parsed.status);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.bugReports)
      .set({
        status: parsed.status,
        statusNote: parsed.statusNote,
        statusUpdatedAt: now,
        updatedAt: now,
        ...(parsed.priority !== undefined
          ? {
              priority: parsed.priority,
              priorityScore: parsed.priority ? priorityScoreFor(parsed.priority) : null,
            }
          : {}),
        ...(parsed.duplicateOf !== undefined ? { duplicateOfId: parsed.duplicateOf } : {}),
        ...(parsed.assigneeUserId !== undefined ? { assigneeUserId: parsed.assigneeUserId } : {}),
      })
      .where(eq(schema.bugReports.id, existing.id))
      .returning();

    if (!updated) throw new Error("Failed to update bug report status.");

    await tx.insert(schema.auditEvents).values({
      organizationId: updated.organizationId,
      projectId: updated.projectId,
      actorType: "system",
      actorId: null,
      targetType: "bug_report",
      targetId: updated.id,
      action: "bug_report.status_updated",
      requestId: input.requestId,
      metadataJson: {
        from: existing.status,
        to: parsed.status,
        hasNote: Boolean(parsed.statusNote),
        ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
        ...(parsed.duplicateOf !== undefined ? { duplicateOf: parsed.duplicateOf } : {}),
        ...(parsed.assigneeUserId !== undefined ? { assigneeUserId: parsed.assigneeUserId } : {}),
      },
    });

    if (statusChanged) {
      await emitBugStatusFollow({
        bug: {
          id: updated.id,
          title: updated.title,
          status: updated.status,
          priority: updated.priority,
          reporterUserId: updated.reporterUserId,
          organizationId: updated.organizationId,
          projectId: updated.projectId,
          statusUpdatedAt: updated.statusUpdatedAt,
        },
        previousStatus: existing.status,
        requestId: input.requestId,
        tx,
      });
    }

    return updated;
  });

  const jobs = await attachTriageJobs([row]);
  return withAdminComments(row, jobs.get(row.id) ?? null);
}

export function buildBugTriageStorePatch(
  existing: { triagedAt: Date | null },
  triage: BugTriageV1,
  now: Date,
) {
  return {
    triageJson: triage,
    lastTriageAt: now,
    triagedAt: existing.triagedAt ?? now,
    priorityScore: priorityScoreFor(triage.suggestedPriority, triage.priorityScore),
    updatedAt: now,
  };
}

export function adminTriageState(input: {
  triage: AdminBugTriageSummary | BugTriageV1 | null;
  triageJob: BugTriageJobSummary | null;
}): AdminTriageState {
  if (input.triage) return "ready";
  if (input.triageJob?.status === "queued" || input.triageJob?.status === "running") return "pending";
  if (input.triageJob?.status === "failed") return "failed";
  return "idle";
}

export async function persistStoredBugTriage(input: {
  id: string;
  triage: BugTriageV1;
  requestId: string;
}): Promise<AdminBugReportDetail> {
  const existing = await findBugReportById(input.id);
  if (!existing) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  const now = new Date();
  const patch = buildBugTriageStorePatch(existing, input.triage, now);
  const [row] = await db.update(schema.bugReports).set(patch).where(eq(schema.bugReports.id, existing.id)).returning();

  if (!row) throw new Error("Failed to store bug report triage.");

  await db.insert(schema.auditEvents).values({
    organizationId: row.organizationId,
    projectId: row.projectId,
    actorType: "system",
    actorId: null,
    targetType: "bug_report",
    targetId: row.id,
    action: "bug_report.triage_stored",
    requestId: input.requestId,
    metadataJson: {
      model: input.triage.model,
      suggestedPriority: input.triage.suggestedPriority,
      confidence: input.triage.confidence,
      similarBugCount: input.triage.similarBugIds.length,
    },
  });

  const jobs = await attachTriageJobs([row]);
  return withAdminComments(row, jobs.get(row.id) ?? null);
}

export async function storeBugReportTriage(input: {
  id: string;
  body: unknown;
  requestId: string;
}): Promise<AdminBugReportDetail> {
  const parsed = parseStoreTriageRequest(input.body);
  if (parsed.kind === "missing") {
    return ensureBugTriageJob({
      id: input.id,
      requestId: input.requestId,
      trigger: "manual",
    });
  }

  return persistStoredBugTriage({
    id: input.id,
    triage: parsed.triage,
    requestId: input.requestId,
  });
}

export async function ensureBugTriageJob(input: {
  id: string;
  requestId: string;
  trigger: BugTriageJobTrigger;
}): Promise<AdminBugReportDetail> {
  if (!isBugTriageEngineConfigured()) {
    throw new ConsoleApiError(501, { error: TRIAGE_ENGINE_NOT_CONFIGURED });
  }

  const existing = await findBugReportById(input.id);
  if (!existing) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  const active = await findActiveTriageJob(existing.id);
  if (active) {
    return withAdminComments(existing, toJobSummary(active));
  }

  const now = new Date();
  try {
    const [job] = await db
      .insert(schema.bugTriageJobs)
      .values({
        bugReportId: existing.id,
        status: "queued",
        trigger: input.trigger,
        requestId: input.requestId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!job) throw new Error("Failed to enqueue bug triage job.");

    await db.insert(schema.auditEvents).values({
      organizationId: existing.organizationId,
      projectId: existing.projectId,
      actorType: "system",
      actorId: null,
      targetType: "bug_report",
      targetId: existing.id,
      action: "bug_report.triage_enqueued",
      requestId: input.requestId,
      metadataJson: {
        jobId: job.id,
        trigger: input.trigger,
      },
    });

    return withAdminComments(existing, toJobSummary(job));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findActiveTriageJob(existing.id);
    if (raced) return withAdminComments(existing, toJobSummary(raced));
    throw error;
  }
}

export async function applyBugReportTriage(input: {
  id: string;
  body: unknown;
  requestId: string;
}): Promise<AdminBugReportDetail> {
  const parsed = parseApplyTriageBody(input.body);
  const existing = await findBugReportById(input.id);
  if (!existing) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  const triage = readStoredTriage(existing.triageJson);
  if (!triage) {
    throw new ConsoleApiError(409, { error: "triage_not_available" });
  }

  const now = new Date();
  const updates: Partial<typeof schema.bugReports.$inferInsert> = { updatedAt: now };
  const applied: Record<string, unknown> = {};

  if (parsed.applyPriority) {
    const priority = parsed.priority ?? triage.suggestedPriority;
    updates.priority = priority;
    updates.priorityScore = priorityScoreFor(priority, triage.priorityScore);
    applied.priority = priority;
  }

  if (parsed.applyStatus) {
    const status = parsed.status ?? triage.suggestedStatus;
    if (!status) {
      throw new ConsoleApiError(400, {
        error: "validation_failed",
        fieldErrors: { status: "No suggestedStatus in triage_json and no status override" },
      });
    }
    updates.status = status;
    updates.statusUpdatedAt = now;
    applied.status = status;
  }

  const nextStatus = (updates.status ?? existing.status) as BugReportStatus;
  const applyingDuplicateStatus = parsed.applyStatus && nextStatus === "duplicate";
  if (parsed.applyDuplicate || applyingDuplicateStatus) {
    const duplicateOf = parsed.duplicateOf ?? triage.similarBugIds[0];
    if (!duplicateOf) {
      throw new ConsoleApiError(400, {
        error: "validation_failed",
        fieldErrors: {
          duplicateOf: applyingDuplicateStatus
            ? "duplicateOf is required when applying status duplicate"
            : "No similarBugIds in triage_json and no duplicateOf override",
        },
      });
    }
    await assertValidDuplicateOf(existing.id, duplicateOf);
    updates.duplicateOfId = duplicateOf;
    applied.duplicateOf = duplicateOf;
  }

  const statusChanged =
    typeof updates.status === "string" && shouldEmitBugStatusFollow(existing.status, updates.status);

  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(schema.bugReports).set(updates).where(eq(schema.bugReports.id, existing.id)).returning();
    if (!updated) throw new Error("Failed to apply bug report triage.");

    await tx.insert(schema.auditEvents).values({
      organizationId: updated.organizationId,
      projectId: updated.projectId,
      actorType: "system",
      actorId: null,
      targetType: "bug_report",
      targetId: updated.id,
      action: "bug_report.triage_applied",
      requestId: input.requestId,
      metadataJson: {
        applied,
        overrides: {
          ...(parsed.priority ? { priority: parsed.priority } : {}),
          ...(parsed.status ? { status: parsed.status } : {}),
          ...(parsed.duplicateOf ? { duplicateOf: parsed.duplicateOf } : {}),
        },
        applyPriority: parsed.applyPriority,
        applyStatus: parsed.applyStatus,
        applyDuplicate: parsed.applyDuplicate,
      },
    });

    if (statusChanged) {
      await emitBugStatusFollow({
        bug: {
          id: updated.id,
          title: updated.title,
          status: updated.status,
          priority: updated.priority,
          reporterUserId: updated.reporterUserId,
          organizationId: updated.organizationId,
          projectId: updated.projectId,
          statusUpdatedAt: updated.statusUpdatedAt,
        },
        previousStatus: existing.status,
        requestId: input.requestId,
        tx,
      });
    }

    return updated;
  });

  const jobs = await attachTriageJobs([row]);
  return withAdminComments(row, jobs.get(row.id) ?? null);
}

async function findBugReportById(id: string) {
  if (!uuidSchema.safeParse(id).success) {
    throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { id: "Invalid id" } });
  }
  const [row] = await db.select().from(schema.bugReports).where(eq(schema.bugReports.id, id)).limit(1);
  return row ?? null;
}

async function assertValidDuplicateOf(id: string, duplicateOf: string) {
  assertNotSelfDuplicate(id, duplicateOf);
  const target = await findBugReportById(duplicateOf);
  if (!target) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { duplicateOf: "duplicateOf must reference an existing bug report" },
    });
  }
}

async function assertUserExists(userId: string) {
  const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { assigneeUserId: "assigneeUserId must reference an existing user" },
    });
  }
}

async function resolveOptionalContext(input: {
  organizationId: string | null;
  projectId: string | null;
}) {
  let organizationId = input.organizationId;
  let projectId = input.projectId;

  if (organizationId) {
    const [organization] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, organizationId))
      .limit(1);
    if (!organization) organizationId = null;
  }

  if (projectId) {
    const [project] = await db
      .select({
        id: schema.projects.id,
        organizationId: schema.projects.organizationId,
      })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    if (!project) {
      projectId = null;
    } else {
      if (!organizationId) organizationId = project.organizationId;
      if (organizationId && project.organizationId !== organizationId) {
        projectId = null;
      }
    }
  }

  return { organizationId, projectId };
}

function toSummary(row: typeof schema.bugReports.$inferSelect): BugReportSummary {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    surface: row.surface,
    status: row.status,
    statusNote: row.statusNote,
    priority: row.priority,
    statusUpdatedAt: dateMs(row.statusUpdatedAt),
    organizationId: row.organizationId,
    projectId: row.projectId,
    createdAt: dateMs(row.createdAt),
    updatedAt: dateMs(row.updatedAt),
    consoleUrl: bugReportConsoleUrl(row.id),
  };
}

function toDetail(row: typeof schema.bugReports.$inferSelect): Omit<BugReportDetail, "comments"> {
  return {
    ...toSummary(row),
    schemaVersion: row.schemaVersion,
    payload: record(row.payloadJson),
  };
}

function toAdminSummary(
  row: typeof schema.bugReports.$inferSelect,
  triageJob: BugTriageJobSummary | null = null,
): AdminBugReportSummary {
  const triage = readStoredTriage(row.triageJson);
  return {
    ...toSummary(row),
    reporterUserId: row.reporterUserId,
    priorityScore: row.priorityScore,
    assigneeUserId: row.assigneeUserId,
    duplicateOfId: row.duplicateOfId,
    triagedAt: dateMsOrNull(row.triagedAt),
    lastTriageAt: dateMsOrNull(row.lastTriageAt),
    triage: triage
      ? {
          model: triage.model,
          summary: triage.summary,
          suggestedPriority: triage.suggestedPriority,
          suggestedStatus: triage.suggestedStatus ?? null,
          confidence: triage.confidence,
          similarBugIds: triage.similarBugIds,
        }
      : null,
    triageJob,
  };
}

function toAdminDetail(
  row: typeof schema.bugReports.$inferSelect,
  triageJob: BugTriageJobSummary | null = null,
): Omit<AdminBugReportDetail, "comments"> {
  return {
    ...toAdminSummary(row, triageJob),
    schemaVersion: row.schemaVersion,
    payload: record(row.payloadJson),
    triageJson: readStoredTriage(row.triageJson),
  };
}

async function withAdminComments(
  row: typeof schema.bugReports.$inferSelect,
  triageJob: BugTriageJobSummary | null = null,
): Promise<AdminBugReportDetail> {
  return {
    ...toAdminDetail(row, triageJob),
    comments: await listStoredComments(row.id),
  };
}

async function listStoredComments(bugReportId: string): Promise<BugReportComment[]> {
  const rows = await db
    .select()
    .from(schema.bugReportComments)
    .where(eq(schema.bugReportComments.bugReportId, bugReportId))
    .orderBy(asc(schema.bugReportComments.createdAt));
  return rows.map((row) => ({
    id: row.id,
    bugId: row.bugReportId,
    schemaVersion: row.schemaVersion,
    authorUserId: row.authorUserId,
    source: isBugCommentSource(row.source) ? row.source : "cli",
    text: row.text,
    payload: record(row.payloadJson),
    idempotencyKey: row.idempotencyKey,
    createdAt: dateMs(row.createdAt),
  }));
}

function isBugCommentSource(value: string): value is BugCommentSource {
  return (BUG_COMMENT_SOURCES as readonly string[]).includes(value);
}

function toJobSummary(row: typeof schema.bugTriageJobs.$inferSelect): BugTriageJobSummary {
  return {
    id: row.id,
    bugReportId: row.bugReportId,
    status: row.status,
    trigger: row.trigger,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: dateMs(row.createdAt),
    updatedAt: dateMs(row.updatedAt),
    startedAt: dateMsOrNull(row.startedAt),
    finishedAt: dateMsOrNull(row.finishedAt),
  };
}

async function attachTriageJobs(rows: Array<{ id: string }>) {
  const jobs = new Map<string, BugTriageJobSummary>();
  if (rows.length === 0) return jobs;
  const stored = await db
    .select()
    .from(schema.bugTriageJobs)
    .where(
      inArray(
        schema.bugTriageJobs.bugReportId,
        rows.map((row) => row.id),
      ),
    );
  for (const row of stored) {
    const current = jobs.get(row.bugReportId);
    const next = toJobSummary(row);
    if (!current || next.createdAt > current.createdAt || (next.createdAt === current.createdAt && next.updatedAt >= current.updatedAt)) {
      jobs.set(row.bugReportId, next);
    }
  }
  return jobs;
}

async function findActiveTriageJob(bugReportId: string) {
  const [row] = await db
    .select()
    .from(schema.bugTriageJobs)
    .where(
      and(eq(schema.bugTriageJobs.bugReportId, bugReportId), inArray(schema.bugTriageJobs.status, ["queued", "running"])),
    )
    .limit(1);
  return row ?? null;
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505");
}

function readStoredTriage(value: unknown): BugTriageV1 | null {
  if (value == null) return null;
  const result = bugTriageSchema.safeParse(value);
  return result.success ? parseBugTriageV1(result.data) : null;
}

function sanitizeJson(value: unknown, depth: number): unknown {
  if (depth > 12) return "[truncated]";
  if (typeof value === "string") return redactInlineSecrets(value).slice(0, 4000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeJson(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 80)
        .map(([key, item]) => {
          if (SECRET_KEY_PATTERN.test(key) && typeof item === "string") {
            return [key, "[REDACTED]"];
          }
          return [key, sanitizeJson(item, depth + 1)];
        }),
    );
  }
  return null;
}

function nullableText(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstFieldErrors(errors: Record<string, string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors)
      .map(([field, messages]) => [field, messages?.[0] ?? "Invalid value"] as const)
      .filter(([, message]) => Boolean(message)),
  );
}

function validationFailed(error: z.ZodError) {
  return new ConsoleApiError(400, {
    error: "validation_failed",
    fieldErrors: firstFieldErrors(error.flatten().fieldErrors),
  });
}

function dateMs(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return 0;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function dateMsOrNull(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  return dateMs(value);
}

function containsPattern(value: string) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function emptyToUndefined(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, string | undefined> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && !(value instanceof URLSearchParams));
}
