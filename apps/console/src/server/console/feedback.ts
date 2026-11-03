import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import {
  colorFor,
  markFor,
  type FeedbackData,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackSeverity,
  type FeedbackSource,
} from "@/features/console/types";
import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import {
  findAccessibleProjectRecord,
  listAccessibleProjectRecords,
  type ProjectAccessRecord,
} from "./project-access";

const FEEDBACK_ACTION = "feedback.submitted";
const FEEDBACK_TARGET_TYPE = "feedback";
const MAX_FEEDBACK_BODY_BYTES = 16 * 1024;

type FeedbackWorkspace = {
  mode: import("@/lib/auth/session").ConsoleAuthState["mode"];
  user: { id: string };
  organization: { id: string };
  membership: { role: string };
};

const feedbackKindSchema = z.enum(["bug", "idea", "ux", "docs", "performance", "security", "other"]);
const feedbackSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
const feedbackSourceSchema = z.enum(["console", "cli", "agent"]);

const feedbackBodySchema = z.object({
  kind: feedbackKindSchema.optional(),
  severity: feedbackSeveritySchema.optional(),
  title: z.string().trim().max(160).nullable().optional(),
  message: z.string().trim().min(1).max(8000),
  surface: z.string().trim().max(120).nullable().optional(),
  projectRef: z.string().trim().max(160).nullable().optional(),
  url: z.string().trim().max(600).nullable().optional(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  source: feedbackSourceSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function listConsoleFeedback(
  workspace: FeedbackWorkspace,
  options: { projectRef?: string } = {},
): Promise<FeedbackData> {
  const project = options.projectRef ? await findAccessibleProjectRecord(workspace, options.projectRef) : null;
  if (options.projectRef && !project) return { total: 0, items: [] };

  const predicates = [
    eq(schema.auditEvents.organizationId, workspace.organization.id),
    eq(schema.auditEvents.action, FEEDBACK_ACTION),
  ];

  if (project) {
    predicates.push(eq(schema.auditEvents.projectId, project.id));
  } else {
    const projects = await listAccessibleProjectRecords(workspace);
    const projectPredicate = projects.length
      ? or(isNull(schema.auditEvents.projectId), inArray(schema.auditEvents.projectId, projects.map((item) => item.id)))
      : isNull(schema.auditEvents.projectId);
    if (projectPredicate) predicates.push(projectPredicate);
  }

  const rows = await db
    .select()
    .from(schema.auditEvents)
    .where(and(...predicates))
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(200);

  const projects = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.organizationId, workspace.organization.id));
  const projectById = new Map(projects.map((item) => [item.id, item]));
  const items = rows.map((row) => feedbackItemFromAudit(row, row.projectId ? projectById.get(row.projectId) ?? null : null));

  return { total: items.length, items };
}

export async function submitConsoleFeedback(input: {
  body: unknown;
  defaultSource: FeedbackSource;
  requestId: string;
  workspace: FeedbackWorkspace;
}): Promise<FeedbackItem> {
  const parsed = parseFeedbackBody(input.body, input.defaultSource);
  const project = parsed.projectRef ? await findAccessibleProjectRecord(input.workspace, parsed.projectRef) : null;
  if (parsed.projectRef && !project) {
    throw new ConsoleApiError(403, { error: "project_forbidden" });
  }

  const feedbackId = randomUUID();
  const metadata = {
    schemaVersion: 1,
    kind: parsed.kind,
    severity: parsed.severity,
    title: parsed.title,
    message: parsed.message,
    surface: parsed.surface,
    source: parsed.source,
    tags: parsed.tags,
    url: parsed.url,
    ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
  };

  const [row] = await db
    .insert(schema.auditEvents)
    .values({
      organizationId: input.workspace.organization.id,
      projectId: project?.id ?? null,
      actorType: actorTypeFor(input.workspace, parsed.source),
      actorId: input.workspace.user.id,
      targetType: FEEDBACK_TARGET_TYPE,
      targetId: feedbackId,
      action: FEEDBACK_ACTION,
      requestId: input.requestId,
      metadataJson: metadata,
    })
    .returning();

  if (!row) throw new Error("Failed to store feedback.");
  return feedbackItemFromAudit(row, project);
}

export function parseFeedbackBody(body: unknown, defaultSource: FeedbackSource) {
  const approxBytes = JSON.stringify(body ?? {}).length;
  if (approxBytes > MAX_FEEDBACK_BODY_BYTES) {
    throw new ConsoleApiError(413, { error: "payload_too_large" });
  }

  const result = feedbackBodySchema.safeParse(body);
  if (!result.success) {
    const fieldErrors = firstFieldErrors(result.error.flatten().fieldErrors);
    throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors });
  }

  const data = result.data;
  return {
    kind: data.kind ?? "other",
    severity: data.severity ?? "medium",
    title: nullableText(data.title),
    message: data.message,
    surface: nullableText(data.surface),
    projectRef: nullableText(data.projectRef),
    url: nullableText(data.url),
    tags: normalizeTags(data.tags),
    source: data.source ?? defaultSource,
    metadata: data.metadata,
  };
}

function feedbackItemFromAudit(
  event: typeof schema.auditEvents.$inferSelect,
  project: ProjectAccessRecord | null,
): FeedbackItem {
  const metadata = record(event.metadataJson);
  const kind = feedbackKind(metadata.kind);
  const severity = feedbackSeverity(metadata.severity);
  const source = feedbackSource(metadata.source);
  const actorKey = event.actorId ?? event.actorType;

  return {
    id: event.targetId ?? event.id,
    kind,
    severity,
    title: textOrNull(metadata.title),
    message: typeof metadata.message === "string" ? metadata.message : "",
    surface: textOrNull(metadata.surface),
    url: textOrNull(metadata.url),
    source,
    tags: Array.isArray(metadata.tags) ? normalizeTags(metadata.tags) : [],
    projectId: project?.id ?? event.projectId ?? null,
    projectSlug: project?.slug ?? null,
    projectName: project?.name ?? null,
    actor: actorLabel(event.actorType, event.actorId),
    actorMark: markFor(actorKey),
    color: colorFor(actorKey),
    createdAt: dateMs(event.createdAt),
  };
}

function actorTypeFor(workspace: FeedbackWorkspace, source: FeedbackSource) {
  if (workspace.mode === "anonymous") return "anonymous";
  if (source === "cli") return "cli";
  if (source === "agent") return "agent";
  return "user";
}

function normalizeTags(value: string[] | string | undefined): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(raw.map(normalizeTag).filter(Boolean))].slice(0, 12);
}

function normalizeTag(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function nullableText(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function textOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function feedbackKind(value: unknown): FeedbackKind {
  return feedbackKindSchema.safeParse(value).success ? (value as FeedbackKind) : "other";
}

function feedbackSeverity(value: unknown): FeedbackSeverity {
  return feedbackSeveritySchema.safeParse(value).success ? (value as FeedbackSeverity) : "medium";
}

function feedbackSource(value: unknown): FeedbackSource {
  return feedbackSourceSchema.safeParse(value).success ? (value as FeedbackSource) : "console";
}

function actorLabel(actorType: string, actorId: string | null) {
  if (actorType === "system") return "system";
  if (actorType === "anonymous") return "anonymous";
  return actorId ?? actorType;
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

function dateMs(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return 0;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}
