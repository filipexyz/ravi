import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  BUG_COMMENT_SCHEMA_VERSION,
  BUG_COMMENT_SOURCES,
  assertBugReportBodySize,
  bugReportConsoleUrl,
  redactInlineSecrets,
  sanitizeJsonRecord,
  type BugCommentSource,
  type BugReportComment,
  type BugReportPriority,
  type BugReportSeverity,
  type BugReportStatus,
} from "@/server/console/bug-reports";
import { db, schema } from "@/server/db";

const uuidSchema = z.string().uuid();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const bugCommentSourceSchema = z.enum(BUG_COMMENT_SOURCES);

export const commentBodySchema = z.object({
  schemaVersion: z.literal(BUG_COMMENT_SCHEMA_VERSION).optional(),
  text: z.string().trim().max(8000).nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
  source: bugCommentSourceSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export type ParsedBugReportCommentBody = {
  schemaVersion: typeof BUG_COMMENT_SCHEMA_VERSION;
  text: string | null;
  payload: Record<string, unknown>;
  source: BugCommentSource;
  idempotencyKey: string;
};

export type BugReportCommentVisibleBug = {
  id: string;
  reporterUserId: string;
  title: string;
  summary: string;
  severity: BugReportSeverity;
  status: BugReportStatus;
  priority: BugReportPriority | null;
  organizationId: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BugReportCommentRow = {
  id: string;
  bugReportId: string;
  schemaVersion: string;
  authorUserId: string;
  source: BugCommentSource;
  text: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: Date;
};

export type BugReportCommentAudit = {
  organizationId: string | null;
  projectId: string | null;
  actorType: "user" | "cli" | "system";
  actorId: string | null;
  targetType: "bug_report";
  targetId: string;
  action: "bug_report.comment_appended";
  requestId: string;
  metadataJson: {
    commentId: string;
    source: BugCommentSource;
    hasText: boolean;
  };
};

export type BugReportCommentStore = {
  findVisibleBug(input: { id: string; reporterUserId: string }): Promise<BugReportCommentVisibleBug | null>;
  findByIdempotencyKey(input: { bugReportId: string; idempotencyKey: string }): Promise<BugReportCommentRow | null>;
  insertComment(input: { row: BugReportCommentRow; audit: BugReportCommentAudit }): Promise<BugReportCommentRow>;
  listComments(bugReportId: string): Promise<BugReportCommentRow[]>;
};

export type BugReportCommentResult = {
  id: string;
  commentId: string;
  bugId: string;
  reused: boolean;
  schemaVersion: string;
  text: string | null;
  source: BugCommentSource;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: number;
  consoleUrl: string;
  bug: {
    id: string;
    title: string;
    severity: BugReportSeverity;
    status: BugReportStatus;
    priority: BugReportPriority | null;
    createdAt: number;
    updatedAt: number;
    consoleUrl: string;
  };
};

export function parseBugReportCommentBody(
  body: unknown,
  headers: { idempotencyKey?: string | null } = {},
): ParsedBugReportCommentBody {
  assertBugReportBodySize(body);
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { body: "Expected an object" },
    });
  }

  const result = commentBodySchema.safeParse(body);
  if (!result.success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: firstFieldErrors(result.error.flatten().fieldErrors),
    });
  }

  const headerKey = headers.idempotencyKey?.trim() || null;
  const bodyKey = result.data.idempotencyKey?.trim() || null;
  if (headerKey && bodyKey && headerKey !== bodyKey) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { idempotencyKey: "Idempotency-Key header must match body idempotencyKey" },
    });
  }

  const idempotencyKey = bodyKey ?? headerKey;
  const keyParsed = idempotencyKeySchema.safeParse(idempotencyKey);
  if (!keyParsed.success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { idempotencyKey: "idempotencyKey is required" },
    });
  }

  const payload = sanitizeJsonRecord(result.data.payload);
  const sourceFromPayload = typeof result.data.payload.source === "string" ? result.data.payload.source : undefined;
  const sourceParsed = bugCommentSourceSchema.safeParse(result.data.source ?? sourceFromPayload);
  if (!sourceParsed.success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { source: "source is required" },
    });
  }

  const text =
    nullableText(result.data.text ? redactInlineSecrets(result.data.text) : null) ??
    nullableText(typeof payload.text === "string" ? payload.text : null);

  return {
    schemaVersion: result.data.schemaVersion ?? BUG_COMMENT_SCHEMA_VERSION,
    text,
    payload,
    source: sourceParsed.data,
    idempotencyKey: keyParsed.data,
  };
}

export function toBugReportComment(row: BugReportCommentRow): BugReportComment {
  return {
    id: row.id,
    bugId: row.bugReportId,
    schemaVersion: row.schemaVersion,
    authorUserId: row.authorUserId,
    source: row.source,
    text: row.text,
    payload: row.payload,
    idempotencyKey: row.idempotencyKey,
    createdAt: dateMs(row.createdAt),
  };
}

export async function createBugReportComment(
  input: {
    id: string;
    body: unknown;
    requestId: string;
    reporterUserId: string;
    actorType?: "user" | "cli";
    idempotencyKeyHeader?: string | null;
  },
  store: BugReportCommentStore = liveBugReportCommentStore,
): Promise<BugReportCommentResult> {
  if (!uuidSchema.safeParse(input.id).success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { id: "Invalid id" },
    });
  }

  const parsed = parseBugReportCommentBody(input.body, { idempotencyKey: input.idempotencyKeyHeader });
  const bug = await store.findVisibleBug({
    id: input.id,
    reporterUserId: input.reporterUserId,
  });
  if (!bug) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  const existing = await store.findByIdempotencyKey({
    bugReportId: bug.id,
    idempotencyKey: parsed.idempotencyKey,
  });
  if (existing) {
    return toCommentResult(existing, bug, true);
  }

  const now = new Date();
  const row: BugReportCommentRow = {
    id: randomUUID(),
    bugReportId: bug.id,
    schemaVersion: parsed.schemaVersion,
    authorUserId: input.reporterUserId,
    source: parsed.source,
    text: parsed.text,
    payload: parsed.payload,
    idempotencyKey: parsed.idempotencyKey,
    createdAt: now,
  };

  try {
    const created = await store.insertComment({
      row,
      audit: {
        organizationId: bug.organizationId,
        projectId: bug.projectId,
        actorType: input.actorType ?? "cli",
        actorId: input.reporterUserId,
        targetType: "bug_report",
        targetId: bug.id,
        action: "bug_report.comment_appended",
        requestId: input.requestId,
        metadataJson: {
          commentId: row.id,
          source: parsed.source,
          hasText: Boolean(parsed.text),
        },
      },
    });
    return toCommentResult(created, bug, false);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await store.findByIdempotencyKey({
      bugReportId: bug.id,
      idempotencyKey: parsed.idempotencyKey,
    });
    if (raced) return toCommentResult(raced, bug, true);
    throw error;
  }
}

export async function listBugReportComments(
  bugReportId: string,
  store: BugReportCommentStore = liveBugReportCommentStore,
): Promise<BugReportComment[]> {
  const rows = await store.listComments(bugReportId);
  return rows.map(toBugReportComment);
}

export function createMemoryBugReportCommentStore(seed?: {
  bugs?: BugReportCommentVisibleBug[];
  comments?: BugReportCommentRow[];
}): BugReportCommentStore & {
  bugs: Map<string, BugReportCommentVisibleBug>;
  comments: BugReportCommentRow[];
  audits: BugReportCommentAudit[];
} {
  const bugs = new Map((seed?.bugs ?? []).map((bug) => [bug.id, bug]));
  const comments = [...(seed?.comments ?? [])];
  const audits: BugReportCommentAudit[] = [];

  return {
    bugs,
    comments,
    audits,
    async findVisibleBug({ id, reporterUserId }) {
      const bug = bugs.get(id);
      if (!bug || bug.reporterUserId !== reporterUserId) return null;
      return { ...bug };
    },
    async findByIdempotencyKey({ bugReportId, idempotencyKey }) {
      return comments.find((row) => row.bugReportId === bugReportId && row.idempotencyKey === idempotencyKey) ?? null;
    },
    async insertComment({ row, audit }) {
      if (comments.some((item) => item.bugReportId === row.bugReportId && item.idempotencyKey === row.idempotencyKey)) {
        const error = new Error("unique_violation") as Error & { code: string };
        error.code = "23505";
        throw error;
      }
      comments.push({ ...row });
      audits.push(audit);
      return { ...row };
    },
    async listComments(bugReportId) {
      return comments
        .filter((row) => row.bugReportId === bugReportId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .map((row) => ({ ...row }));
    },
  };
}

const liveBugReportCommentStore: BugReportCommentStore = {
  async findVisibleBug({ id, reporterUserId }) {
    const [row] = await db.select().from(schema.bugReports).where(eq(schema.bugReports.id, id)).limit(1);
    if (!row || row.reporterUserId !== reporterUserId) return null;
    return {
      id: row.id,
      reporterUserId: row.reporterUserId,
      title: row.title,
      summary: row.summary,
      severity: row.severity,
      status: row.status,
      priority: row.priority,
      organizationId: row.organizationId,
      projectId: row.projectId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },
  async findByIdempotencyKey({ bugReportId, idempotencyKey }) {
    const [row] = await db
      .select()
      .from(schema.bugReportComments)
      .where(
        and(
          eq(schema.bugReportComments.bugReportId, bugReportId),
          eq(schema.bugReportComments.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row ? toStoredCommentRow(row) : null;
  },
  async insertComment({ row, audit }) {
    const [created] = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.bugReportComments)
        .values({
          id: row.id,
          bugReportId: row.bugReportId,
          schemaVersion: row.schemaVersion,
          authorUserId: row.authorUserId,
          source: row.source,
          text: row.text,
          payloadJson: row.payload,
          idempotencyKey: row.idempotencyKey,
          createdAt: row.createdAt,
        })
        .returning();
      if (!inserted) throw new Error("Failed to store bug report comment.");
      await tx.insert(schema.auditEvents).values(audit);
      return [inserted];
    });
    if (!created) throw new Error("Failed to store bug report comment.");
    return toStoredCommentRow(created);
  },
  async listComments(bugReportId) {
    const rows = await db
      .select()
      .from(schema.bugReportComments)
      .where(eq(schema.bugReportComments.bugReportId, bugReportId))
      .orderBy(asc(schema.bugReportComments.createdAt));
    return rows.map(toStoredCommentRow);
  },
};

function toStoredCommentRow(row: typeof schema.bugReportComments.$inferSelect): BugReportCommentRow {
  const source = bugCommentSourceSchema.safeParse(row.source);
  return {
    id: row.id,
    bugReportId: row.bugReportId,
    schemaVersion: row.schemaVersion,
    authorUserId: row.authorUserId,
    source: source.success ? source.data : "cli",
    text: row.text,
    payload: record(row.payloadJson),
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  };
}

function toCommentResult(
  row: BugReportCommentRow,
  bug: BugReportCommentVisibleBug,
  reused: boolean,
): BugReportCommentResult {
  return {
    id: row.id,
    commentId: row.id,
    bugId: bug.id,
    reused,
    schemaVersion: row.schemaVersion,
    text: row.text,
    source: row.source,
    payload: row.payload,
    idempotencyKey: row.idempotencyKey,
    createdAt: dateMs(row.createdAt),
    consoleUrl: bugReportConsoleUrl(bug.id),
    bug: {
      id: bug.id,
      title: bug.title,
      severity: bug.severity,
      status: bug.status,
      priority: bug.priority,
      createdAt: dateMs(bug.createdAt),
      updatedAt: dateMs(bug.updatedAt),
      consoleUrl: bugReportConsoleUrl(bug.id),
    },
  };
}

function firstFieldErrors(errors: Record<string, string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors)
      .map(([field, messages]) => [field, messages?.[0] ?? "Invalid value"] as const)
      .filter(([, message]) => Boolean(message)),
  );
}

function nullableText(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function dateMs(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return 0;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505");
}
