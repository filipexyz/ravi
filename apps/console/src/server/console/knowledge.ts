import { and, desc, eq, ne, or } from "drizzle-orm";
import { z } from "zod";

import type {
  KnowledgeSensitivity,
  KnowledgeSourceStatus,
  KnowledgeSourceSummary,
  KnowledgeSourceType,
} from "@/features/console/types";
import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import { canAccessProject as authorizeProject, type ProjectAuthorizationCheck, type ProjectAccessWorkspace } from "./project-access";
import { isUuidRef } from "./ref";
import {
  knowledgeRawSourceSafeMetadata,
  pendingKnowledgeRawSourceRef,
} from "./knowledge/raw-source-storage";

const MAX_CREATE_SOURCE_BODY_BYTES = 64 * 1024;
const SOURCE = "console.knowledge.sources";

export const KNOWLEDGE_SOURCE_TYPES = [
  "manual_note",
  "file_upload",
  "artifact",
  "meeting",
  "mail_thread",
  "calendar_event",
  "github_repository",
  "ravi_page",
  "provider_resource",
  "external_rag_collection",
] as const satisfies readonly KnowledgeSourceType[];

const KNOWLEDGE_SOURCE_STATUSES = ["active", "disabled", "revoked", "deleted"] as const satisfies readonly KnowledgeSourceStatus[];
const KNOWLEDGE_SENSITIVITIES = ["standard", "confidential", "restricted"] as const satisfies readonly KnowledgeSensitivity[];
const ALLOWED_CONSUMERS = ["console", "agent", "retrieval", "ingestion"] as const;

type KnowledgeWorkspace = {
  authorization?: ProjectAccessWorkspace["authorization"];
  mode: import("@/lib/auth/session").ConsoleAuthState["mode"];
  user: { id: string };
  organization: { id: string };
  membership: { role: string };
};

type KnowledgeProject = {
  id: string;
  organizationId: string;
};

type KnowledgeProjectMembership = {
  role: string;
  status: string;
};

type KnowledgeSourceRecord = typeof schema.knowledgeSources.$inferSelect;

type InsertKnowledgeSourceInput = {
  accessPolicyJson: Record<string, unknown>;
  createdByActorId: string;
  createdByActorType: "anonymous" | "user";
  description: string | null;
  organizationId: string;
  ownerUserId: string | null;
  projectId: string;
  rawRefJson: Record<string, unknown>;
  retentionPolicyJson: Record<string, unknown>;
  safeMetadataJson: Record<string, unknown>;
  sensitivity: KnowledgeSensitivity;
  sourceRefJson: Record<string, unknown>;
  sourceType: KnowledgeSourceType;
  title: string;
};

type DeleteKnowledgeSourceInput = {
  organizationId: string;
  projectId: string;
  sourceId: string;
};

type AuditInput = {
  action: string;
  actorId: string;
  actorType: "anonymous" | "user" | "system";
  metadataJson: Record<string, unknown>;
  organizationId: string;
  projectId: string;
  requestId: string;
  targetId?: string | null;
  targetType: string;
};

export type KnowledgeSourcesRepository = {
  authorizeProject?: ProjectAuthorizationCheck;
  deleteSource(input: DeleteKnowledgeSourceInput): Promise<KnowledgeSourceRecord | null>;
  findProjectByRef(organizationId: string, projectRef: string): Promise<KnowledgeProject | null>;
  findProjectMembership(projectId: string, userId: string): Promise<KnowledgeProjectMembership | null>;
  getSourceById(input: { organizationId: string; projectId: string; sourceId: string }): Promise<KnowledgeSourceRecord | null>;
  insertAudit(input: AuditInput): Promise<void>;
  insertSource(input: InsertKnowledgeSourceInput): Promise<KnowledgeSourceRecord>;
  listSources(projectId: string): Promise<KnowledgeSourceRecord[]>;
};

const jsonRecordSchema = z.record(z.string(), z.unknown());
const knowledgeSourceTypeSchema = z.enum(KNOWLEDGE_SOURCE_TYPES);
const knowledgeSensitivitySchema = z.enum(KNOWLEDGE_SENSITIVITIES);
const allowedConsumerSchema = z.enum(ALLOWED_CONSUMERS);

const createKnowledgeSourceBodySchema = z.object({
  sourceType: knowledgeSourceTypeSchema.optional(),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(2000).nullable().optional(),
  sensitivity: knowledgeSensitivitySchema.optional(),
  sourceRef: jsonRecordSchema.optional(),
  retentionPolicy: jsonRecordSchema.optional(),
  metadata: jsonRecordSchema.optional(),
  allowedConsumers: z.array(allowedConsumerSchema).max(ALLOWED_CONSUMERS.length).optional(),
});

export function knowledgeSourcesRepositoryForDb(database: Pick<typeof db, "insert" | "select" | "update"> = db): KnowledgeSourcesRepository {
  return {
    authorizeProject,
    async deleteSource(input) {
      const now = new Date();
      const [source] = await database
        .update(schema.knowledgeSources)
        .set({
          status: "deleted",
          revokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.knowledgeSources.organizationId, input.organizationId),
            eq(schema.knowledgeSources.projectId, input.projectId),
            eq(schema.knowledgeSources.id, input.sourceId),
            ne(schema.knowledgeSources.status, "deleted"),
          ),
        )
        .returning();

      if (!source) return null;

      await database
        .update(schema.knowledgeDocuments)
        .set({ status: "archived", updatedAt: now })
        .where(
          and(
            eq(schema.knowledgeDocuments.organizationId, input.organizationId),
            eq(schema.knowledgeDocuments.projectId, input.projectId),
            eq(schema.knowledgeDocuments.sourceId, input.sourceId),
          ),
        );

      await database
        .update(schema.knowledgeChunks)
        .set({ status: "deleted", updatedAt: now })
        .where(
          and(
            eq(schema.knowledgeChunks.organizationId, input.organizationId),
            eq(schema.knowledgeChunks.projectId, input.projectId),
            eq(schema.knowledgeChunks.sourceId, input.sourceId),
          ),
        );

      return source;
    },

    async findProjectByRef(organizationId, projectRef) {
      const refPredicate = isUuidRef(projectRef)
        ? or(eq(schema.projects.id, projectRef), eq(schema.projects.slug, projectRef))
        : eq(schema.projects.slug, projectRef);
      const [project] = await database
        .select({
          id: schema.projects.id,
          organizationId: schema.projects.organizationId,
        })
        .from(schema.projects)
        .where(and(eq(schema.projects.organizationId, organizationId), refPredicate))
        .limit(1);

      return project ?? null;
    },

    async findProjectMembership(projectId, userId) {
      const [membership] = await database
        .select({
          role: schema.projectMemberships.role,
          status: schema.projectMemberships.status,
        })
        .from(schema.projectMemberships)
        .where(
          and(
            eq(schema.projectMemberships.projectId, projectId),
            eq(schema.projectMemberships.userId, userId),
            eq(schema.projectMemberships.status, "active"),
          ),
        )
        .limit(1);

      return membership ?? null;
    },

    async getSourceById(input) {
      const [source] = await database
        .select()
        .from(schema.knowledgeSources)
        .where(
          and(
            eq(schema.knowledgeSources.organizationId, input.organizationId),
            eq(schema.knowledgeSources.projectId, input.projectId),
            eq(schema.knowledgeSources.id, input.sourceId),
            ne(schema.knowledgeSources.status, "deleted"),
          ),
        )
        .limit(1);

      return source ?? null;
    },

    async insertAudit(input) {
      await database.insert(schema.auditEvents).values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        actorType: input.actorType,
        actorId: input.actorId,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        action: input.action,
        requestId: input.requestId,
        metadataJson: input.metadataJson,
      });
    },

    async insertSource(input) {
      const [source] = await database
        .insert(schema.knowledgeSources)
        .values({
          organizationId: input.organizationId,
          projectId: input.projectId,
          ownerUserId: input.ownerUserId,
          sourceType: input.sourceType,
          title: input.title,
          description: input.description,
          status: "active",
          sensitivity: input.sensitivity,
          sourceRefJson: input.sourceRefJson,
          rawRefJson: input.rawRefJson,
          accessPolicyJson: input.accessPolicyJson,
          retentionPolicyJson: input.retentionPolicyJson,
          safeMetadataJson: input.safeMetadataJson,
          createdByActorType: input.createdByActorType,
          createdByActorId: input.createdByActorId,
        })
        .returning();

      if (!source) throw new Error("Failed to create knowledge source.");
      return source;
    },

    async listSources(projectId) {
      return database
        .select()
        .from(schema.knowledgeSources)
        .where(and(eq(schema.knowledgeSources.projectId, projectId), ne(schema.knowledgeSources.status, "deleted")))
        .orderBy(desc(schema.knowledgeSources.updatedAt));
    },
  };
}

export async function listKnowledgeSources({
  projectRef,
  repository = knowledgeSourcesRepositoryForDb(),
  workspace,
}: {
  projectRef: string;
  repository?: KnowledgeSourcesRepository;
  workspace: KnowledgeWorkspace;
}): Promise<KnowledgeSourceSummary[]> {
  const project = await getAccessibleProject({ action: "read", projectRef, repository, workspace });
  const sources = await repository.listSources(project.id);
  return sources.map(knowledgeSourceSummaryFromRecord);
}

export async function getKnowledgeSource({
  projectRef,
  repository = knowledgeSourcesRepositoryForDb(),
  sourceId,
  workspace,
}: {
  projectRef: string;
  repository?: KnowledgeSourcesRepository;
  sourceId: string;
  workspace: KnowledgeWorkspace;
}): Promise<KnowledgeSourceSummary | null> {
  const project = await getAccessibleProject({ action: "read", projectRef, repository, workspace });
  const source = await repository.getSourceById({
    organizationId: workspace.organization.id,
    projectId: project.id,
    sourceId,
  });
  return source ? knowledgeSourceSummaryFromRecord(source) : null;
}

export async function createKnowledgeSource({
  body,
  projectRef,
  repository = knowledgeSourcesRepositoryForDb(),
  requestId,
  workspace,
}: {
  body: unknown;
  projectRef: string;
  repository?: KnowledgeSourcesRepository;
  requestId: string;
  workspace: KnowledgeWorkspace;
}): Promise<KnowledgeSourceSummary> {
  const parsed = parseCreateKnowledgeSourceBody(body);
  const project = await getAccessibleProject({ action: "write", projectRef, repository, workspace });
  const actorType = actorTypeForWorkspace(workspace);
  const allowedConsumers = normalizeAllowedConsumers(parsed.allowedConsumers);

  const accessPolicyJson = {
    schemaVersion: 1,
    scope: "project",
    organizationId: workspace.organization.id,
    projectId: project.id,
    visibility: "project_private",
    allowedConsumers,
  };

  const source = await repository.insertSource({
    organizationId: workspace.organization.id,
    projectId: project.id,
    ownerUserId: isUuidRef(workspace.user.id) ? workspace.user.id : null,
    sourceType: parsed.sourceType,
    title: parsed.title,
    description: parsed.description,
    sensitivity: parsed.sensitivity,
    sourceRefJson: parsed.sourceRef,
    rawRefJson: pendingKnowledgeRawSourceRef(),
    accessPolicyJson,
    retentionPolicyJson: parsed.retentionPolicy,
    safeMetadataJson: parsed.metadata,
    createdByActorType: actorType,
    createdByActorId: workspace.user.id,
  });

  await repository.insertAudit({
    organizationId: workspace.organization.id,
    projectId: project.id,
    actorType,
    actorId: workspace.user.id,
    targetType: "knowledge_source",
    targetId: source.id,
    action: "knowledge_source.created",
    requestId,
    metadataJson: {
      source: `${SOURCE}.create`,
      sourceType: source.sourceType,
      sensitivity: source.sensitivity,
      status: source.status,
      title: source.title,
      allowedConsumers,
    },
  });

  return knowledgeSourceSummaryFromRecord(source);
}

export async function deleteKnowledgeSource({
  projectRef,
  repository = knowledgeSourcesRepositoryForDb(),
  requestId,
  sourceId,
  workspace,
}: {
  projectRef: string;
  repository?: KnowledgeSourcesRepository;
  requestId: string;
  sourceId: string;
  workspace: KnowledgeWorkspace;
}): Promise<KnowledgeSourceSummary> {
  const project = await getAccessibleProject({ action: "write", projectRef, repository, workspace });
  const actorType = actorTypeForWorkspace(workspace);
  const source = await repository.deleteSource({
    organizationId: workspace.organization.id,
    projectId: project.id,
    sourceId,
  });

  if (!source) throw new ConsoleApiError(404, { error: "knowledge_source_not_found" });

  await repository.insertAudit({
    organizationId: workspace.organization.id,
    projectId: project.id,
    actorType,
    actorId: workspace.user.id,
    targetType: "knowledge_source",
    targetId: source.id,
    action: "knowledge_source.deleted",
    requestId,
    metadataJson: {
      source: `${SOURCE}.delete`,
      sourceType: source.sourceType,
      sensitivity: source.sensitivity,
      status: source.status,
      title: source.title,
    },
  });

  return knowledgeSourceSummaryFromRecord(source);
}

export function parseCreateKnowledgeSourceBody(body: unknown) {
  const approxBytes = JSON.stringify(body ?? {}).length;
  if (approxBytes > MAX_CREATE_SOURCE_BODY_BYTES) {
    throw new ConsoleApiError(413, { error: "payload_too_large" });
  }

  const result = createKnowledgeSourceBodySchema.safeParse(body);
  if (!result.success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: firstFieldErrors(result.error.flatten().fieldErrors),
    });
  }

  return {
    sourceType: result.data.sourceType ?? "manual_note",
    title: result.data.title,
    description: nullableText(result.data.description),
    sensitivity: result.data.sensitivity ?? "standard",
    sourceRef: result.data.sourceRef ?? {},
    retentionPolicy: result.data.retentionPolicy ?? { schemaVersion: 1, mode: "default" },
    metadata: result.data.metadata ?? {},
    allowedConsumers: result.data.allowedConsumers ?? ["console", "agent", "retrieval", "ingestion"],
  } satisfies {
    allowedConsumers: Array<(typeof ALLOWED_CONSUMERS)[number]>;
    description: string | null;
    metadata: Record<string, unknown>;
    retentionPolicy: Record<string, unknown>;
    sensitivity: KnowledgeSensitivity;
    sourceRef: Record<string, unknown>;
    sourceType: KnowledgeSourceType;
    title: string;
  };
}

function knowledgeSourceSummaryFromRecord(source: KnowledgeSourceRecord): KnowledgeSourceSummary {
  const accessPolicy = record(source.accessPolicyJson);
  return {
    id: source.id,
    projectId: source.projectId ?? "",
    sourceType: sourceTypeFromRecord(source.sourceType),
    title: source.title,
    description: source.description,
    status: sourceStatusFromRecord(source.status),
    sensitivity: sensitivityFromRecord(source.sensitivity),
    sourceRef: record(source.sourceRefJson),
    metadata: record(source.safeMetadataJson),
    raw: knowledgeRawSourceSafeMetadata(source.rawRefJson),
    access: {
      scope: "project",
      allowedConsumers: normalizeAllowedConsumers(accessPolicy.allowedConsumers),
    },
    documentCount: 0,
    chunkCount: 0,
    revokedAt: dateMsOrNull(source.revokedAt),
    createdAt: dateMs(source.createdAt),
    updatedAt: dateMs(source.updatedAt),
  };
}

async function getAccessibleProject({
  action,
  projectRef,
  repository,
  workspace,
}: {
  action: "read" | "write" | "admin";
  projectRef: string;
  repository: KnowledgeSourcesRepository;
  workspace: KnowledgeWorkspace;
}) {
  const project = await repository.findProjectByRef(workspace.organization.id, projectRef);
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });
  if (await canAccessProject({ action, projectId: project.id, repository, workspace })) return project;
  throw new ConsoleApiError(403, { error: "project_forbidden" });
}

async function canAccessProject({
  action,
  projectId,
  repository,
  workspace,
}: {
  action: "read" | "write" | "admin";
  projectId: string;
  repository: KnowledgeSourcesRepository;
  workspace: KnowledgeWorkspace;
}) {
  return (await repository.authorizeProject?.(workspace, projectId, action)) ?? false;
}

function actorTypeForWorkspace(workspace: KnowledgeWorkspace) {
  return workspace.mode === "anonymous" ? "anonymous" : "user";
}

function normalizeAllowedConsumers(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [];
  return [...new Set(items.filter((item): item is (typeof ALLOWED_CONSUMERS)[number] => allowedConsumerSchema.safeParse(item).success))];
}

function sourceTypeFromRecord(value: unknown): KnowledgeSourceType {
  return knowledgeSourceTypeSchema.safeParse(value).success ? (value as KnowledgeSourceType) : "manual_note";
}

function sourceStatusFromRecord(value: unknown): KnowledgeSourceStatus {
  return z.enum(KNOWLEDGE_SOURCE_STATUSES).safeParse(value).success ? (value as KnowledgeSourceStatus) : "active";
}

function sensitivityFromRecord(value: unknown): KnowledgeSensitivity {
  return knowledgeSensitivitySchema.safeParse(value).success ? (value as KnowledgeSensitivity) : "standard";
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

function dateMs(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return 0;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function dateMsOrNull(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  return dateMs(value);
}
