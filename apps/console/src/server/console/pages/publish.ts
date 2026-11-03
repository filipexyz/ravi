import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { AwsClient } from "aws4fetch";
import { createHash, randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";

import { ConsoleApiError } from "@/server/console/api-error";
import { stripReservedRouteConfig } from "@/server/console/knowledge/marks";
import { scheduleKnowledgePageCapture } from "@/server/console/knowledge/schedule";
import { db, schema } from "@/server/db";
import type { PagePresentation } from "@/shared/widgets/types";
import type { ProjectAccessAction } from "../project-access";
import type { AuthorizationActor } from "../authorization/identity";
import { decideInTransaction } from "../authorization/store";
import { projectAuthorizationFromCli, type VerifiedCliProjectContext } from "@/server/cli/project-authorization";
import { isUuidRef } from "../ref";
import {
  buildPagesAssetStoredUsageEvent,
  buildPagesManifestStoredUsageEvent,
  buildPagesReleaseActivatedUsageEvent,
  type UsageEventRecordInput,
} from "../billing/usage-metering";
import {
  findPageRouteConflicts,
  validateArtifactPackageManifest,
  validateManifestFilePath,
  validatePageRouteDefinition,
  type PageRouteMatchType,
} from "./policy";
import {
  findRequiredPagesPasswordPolicy,
  pagesPasswordAccessRepositoryForDb,
  type PagesPasswordAccessRepository,
} from "./password-access";
import { isFinalObjectKeyForArtifact } from "./storage-keys";
import {
  diffReleaseRoutes,
  diffTextLines,
  isTextDiffable,
  RELEASE_TEXT_DIFF_MAX_BYTES,
  releaseRouteKey,
  type ReleaseDiffFileInput,
  type ReleaseDiffRoute,
  type ReleaseDiffSummary,
  type TextDiffResult,
} from "./release-diff";
import {
  snapshotConnectorUsesFromManifest,
  type PagesConnectorUsesSnapshot,
} from "./connectors/catalog";
import { parsePagePresentation } from "./kit/presentation";
import { connectorUsesForOrigin, isolatedPagesOriginsRequired } from "./connectors/origin-policy";

export type PublishVisibility = "public" | "private" | "protected_link" | "password";
type ArtifactVisibility = Exclude<PublishVisibility, "password">;
export type PublishActorType = "anonymous" | "user" | "cli" | "system";

export type PagePublishContext = {
  authorization?: AuthorizationActor["delegation"];
  actorId: string;
  actorType: PublishActorType;
  /** The `ravi login` installation behind a CLI publish; Page comment events go back to it. */
  localInstallationId?: string | null;
  membershipRole: string;
  organizationId: string;
  scopes?: string[];
};

export type PagePackageFileInput = {
  path: string;
  sha256?: string | null;
  sizeBytes?: number | null;
  contentType?: string | null;
  stagingKey?: string | null;
  cache?: "entrypoint" | "immutable" | "static" | string;
};

export type PagePackageManifestInput = {
  entrypoint?: string;
  basePath?: string;
  assetBase?: string;
  files: PagePackageFileInput[];
  uses?: string[];
};

export type CreatePageUploadSessionInput = {
  projectRef: string;
  siteRef?: string | null;
  idempotencyKey?: string | null;
  packageManifest: PagePackageManifestInput;
  uploadPolicy?: Record<string, unknown>;
};

export type FinalizePageUploadSessionInput = {
  uploadSessionId: string;
  idempotencyKey?: string | null;
  artifact?: {
    id?: string | null;
    slug?: string | null;
    name?: string | null;
    description?: string | null;
    localArtifactId?: string | null;
  };
  packageManifest: PagePackageManifestInput;
  publish?: {
    siteRef?: string | null;
    activate?: boolean;
    route?: {
      path?: string;
      matchType?: PageRouteMatchType;
      priority?: number;
      visibility?: PublishVisibility;
      allowDeviceMotion?: boolean;
    };
    routes?: Array<{
      path: string;
      matchType?: PageRouteMatchType;
      priority?: number;
      visibility?: PublishVisibility;
      allowDeviceMotion?: boolean;
    }>;
    replaceRelease?: boolean;
    reason?: string | null;
    visibility?: PublishVisibility;
    // Same allowlist as `packageManifest.uses`; `ravi pages ship --uses`
    // sends it here. Sending both with different ids is refused.
    uses?: string[];
    // Page kit presentation (`/api/cli/pages/kit`), passed through by
    // `ravi pages ship`; stored on the artifact version, never in the manifest.
    presentation?: unknown;
  };
  source?: Record<string, unknown>;
};

export type CreatePageSiteReleaseInput = {
  projectRef: string;
  siteRef: string;
  idempotencyKey?: string | null;
  activate?: boolean;
  replaceRelease?: boolean;
  reason?: string | null;
  routes: PageReleaseRouteSpec[];
};

export type PageReleaseRouteSpec = {
  path: string;
  matchType?: PageRouteMatchType;
  priority?: number;
  artifactId?: string;
  artifactVersionId: string;
  entrypoint?: string;
  assetBase?: string;
  visibility?: PublishVisibility;
  allowDeviceMotion?: boolean;
  routeConfigJson?: Record<string, unknown>;
};

export type PageUploadSessionResult = {
  uploadSession: PublicPageUploadSessionRecord;
  uploadPolicy: Record<string, unknown>;
};

export type PagePublishResult = {
  artifact: ArtifactRecord;
  artifactVersion: ArtifactVersionRecord;
  publish: PagePublishRecord;
  site: PageSiteRecord | null;
  release: PageSiteReleaseRecord | null;
  routes: PageReleaseRouteRecord[];
  url: string | null;
};

export type PageSiteReleaseResult = {
  publish: PagePublishRecord | null;
  site: PageSiteRecord;
  release: PageSiteReleaseRecord;
  routes: PageReleaseRouteRecord[];
  url: string | null;
};

type ProjectRecord = Pick<typeof schema.projects.$inferSelect, "id" | "organizationId" | "slug" | "defaultVisibility">;
type PageSiteRecord = typeof schema.pageSites.$inferSelect;
type PageRouteRecord = typeof schema.pageRoutes.$inferSelect;
type ArtifactRecord = typeof schema.artifacts.$inferSelect;
type ArtifactVersionRecord = typeof schema.artifactVersions.$inferSelect;
type AssetRecord = typeof schema.assets.$inferSelect;
type PageUploadSessionRecord = typeof schema.pageUploadSessions.$inferSelect;
type PublicPageUploadSessionRecord = Omit<PageUploadSessionRecord, "uploadPolicyJson">;
type PagePublishRecord = typeof schema.pagePublishes.$inferSelect;
type PageSiteReleaseRecord = typeof schema.pageSiteReleases.$inferSelect;
type PageReleaseRouteRecord = typeof schema.pageReleaseRoutes.$inferSelect;
type ArtifactVersionStatus = "created" | "building" | "ready" | "failed" | "archived";
type PagePublishUnreadCommentRecord = {
  id: string;
  body: string;
  path: string;
  createdAt: Date;
  createdByUserId: string | null;
  createdByDisplayName: string | null;
};
type EdgeManifestStatus = "pending" | "ready" | "failed";
export type EdgeManifestRepairReason =
  | "manifest_missing"
  | "manifest_unreadable"
  | "manifest_invalid"
  | "manifest_not_ready"
  | "site_not_active"
  | "host_mismatch"
  | "active_release_mismatch"
  | "site_visibility_changed"
  | "route_miss"
  | "reserved_asset_route_miss"
  | "reserved_asset_file_miss"
  | "file_miss";
export type EdgeManifestRepairResult =
  | {
      status: "repaired";
      manifestKey: string;
      releaseId: string;
      siteId: string;
    }
  | {
      status: "failed";
      reason: string;
      releaseId?: string | null;
      siteId: string;
    }
  | {
      status: "skipped";
      reason: string;
      releaseId?: string | null;
      siteId?: string | null;
    };

type ArtifactVersionFileRecord = {
  artifactStatus: ArtifactRecord["status"];
  versionStatus: ArtifactVersionStatus;
  versionNumber: number;
  versionSha256: string | null;
  path: string;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  storageJson: Record<string, unknown>;
  metadataJson: Record<string, unknown>;
};

type AuditInput = {
  action: string;
  actorId: string;
  actorType: PublishActorType;
  metadataJson: Record<string, unknown>;
  organizationId: string;
  projectId?: string | null;
  requestId: string;
  targetId?: string | null;
  targetType: string;
};

type CreateUploadSessionRecordInput = {
  id: string;
  organizationId: string;
  projectId: string;
  siteId: string | null;
  stagingPrefix: string;
  idempotencyKey: string | null;
  fileManifestJson: Record<string, unknown>;
  uploadPolicyJson: Record<string, unknown>;
  createdByActorType: PublishActorType;
  createdByActorId: string;
  expiresAt: Date;
};

type CreateArtifactInput = {
  projectId: string;
  slug: string;
  name: string;
  description: string | null;
  localArtifactId: string | null;
  visibility: ArtifactVisibility;
  metadataJson: Record<string, unknown>;
};

type CreateArtifactVersionInput = {
  id?: string;
  artifactId: string;
  versionNumber: number;
  status?: ArtifactVersionStatus;
  sha256: string;
  sizeBytes: number;
  sourceJson: Record<string, unknown>;
  metadataJson: Record<string, unknown>;
  createdByActorType: PublishActorType;
  createdByActorId: string;
};

type CreateAssetInput = {
  artifactId: string;
  artifactVersionId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
  visibility: ArtifactVisibility;
  storageJson: Record<string, unknown>;
  metadataJson: Record<string, unknown>;
};

type CreatePublishInput = {
  organizationId: string;
  projectId: string;
  artifactId: string | null;
  artifactVersionId: string | null;
  siteId: string | null;
  siteReleaseId: string | null;
  sourceType: string;
  sourceRef: string | null;
  status: "started" | "completed" | "failed";
  manifestKey: string | null;
  manifestHash: string | null;
  objectCount: number;
  totalBytes: number;
  visibility: ArtifactVisibility;
  routeChangesJson: Record<string, unknown>;
  idempotencyKey: string | null;
  errorCode?: string | null;
  createdByActorType: PublishActorType;
  createdByActorId: string;
  metadataJson: Record<string, unknown>;
  completedAt?: Date | null;
};

type CreatePageRouteInput = {
  organizationId: string;
  projectId: string;
  siteId: string;
  path: string;
  matchType: PageRouteMatchType;
  priority: number;
  visibility: PublishVisibility;
  defaultVisibility: PublishVisibility;
  routeConfigJson: Record<string, unknown>;
};

type CreateReleaseInput = {
  id?: string;
  organizationId: string;
  projectId: string;
  siteId: string;
  releaseNumber: number;
  previousReleaseId: string | null;
  status: "draft" | "active";
  reason: string | null;
  manifestHash: string;
  createdByActorType: PublishActorType;
  createdByActorId: string;
  activatedAt: Date | null;
};

type CreateReleaseRouteInput = {
  organizationId: string;
  projectId: string;
  siteId: string;
  releaseId: string;
  routeId: string;
  path: string;
  matchType: PageRouteMatchType;
  priority: number;
  artifactId: string;
  artifactVersionId: string;
  entrypoint: string;
  assetBase: string;
  visibility: PublishVisibility;
  routeConfigJson: Record<string, unknown>;
};

export type PagePublishRepository = {
  authorizeProject?(context: PagePublishContext, projectId: string, action: ProjectAccessAction): Promise<boolean>;
  withTransaction<T>(fn: (repository: PagePublishRepository) => Promise<T>): Promise<T>;
  findProjectByRef(organizationId: string, projectRef: string): Promise<ProjectRecord | null>;
  findSiteByRef(organizationId: string, siteRef: string): Promise<PageSiteRecord | null>;
  findDefaultSite(projectId: string): Promise<PageSiteRecord | null>;
  findSiteByHost(organizationId: string, host: string): Promise<PageSiteRecord | null>;
  updateSiteEdgeManifestState(input: {
    edgeManifest: Record<string, unknown>;
    now: Date;
    siteId: string;
  }): Promise<void>;
  findProjectMembership(projectId: string, userId: string): Promise<{ role: string; status: string } | null>;
  findUploadSession(input: {
    actorId: string;
    actorType: PublishActorType;
    organizationId: string;
    uploadSessionId: string;
  }): Promise<PageUploadSessionRecord | null>;
  findUploadSessionByIdempotencyKey(input: IdempotencyLookup): Promise<PageUploadSessionRecord | null>;
  createUploadSession(input: CreateUploadSessionRecordInput): Promise<PageUploadSessionRecord>;
  updateUploadSession(input: {
    id: string;
    status: "uploaded" | "finalized" | "expired" | "failed";
    fileManifestJson?: Record<string, unknown>;
    errorCode?: string | null;
    finalizedAt?: Date | null;
  }): Promise<void>;
  findPublishByIdempotencyKey(input: IdempotencyLookup): Promise<PagePublishRecord | null>;
  findPublish(id: string): Promise<PagePublishRecord | null>;
  createPublish(input: CreatePublishInput): Promise<PagePublishRecord>;
  updatePublish(input: {
    id: string;
    artifactId?: string | null;
    artifactVersionId?: string | null;
    siteId?: string | null;
    siteReleaseId?: string | null;
    status: "completed" | "failed";
    manifestKey?: string | null;
    manifestHash?: string | null;
    routeChangesJson?: Record<string, unknown>;
    errorCode?: string | null;
    completedAt?: Date | null;
  }): Promise<PagePublishRecord>;
  findArtifactByRef(projectId: string, artifactRef: string): Promise<ArtifactRecord | null>;
  createArtifact(input: CreateArtifactInput): Promise<ArtifactRecord>;
  updateArtifactVersionState(input: { artifactId: string; lastCloudVersion: number; syncMetadataJson: Record<string, unknown> }): Promise<void>;
  lockArtifactVersionSequence(artifactId: string): Promise<void>;
  nextArtifactVersionNumber(artifactId: string): Promise<number>;
  createArtifactVersion(input: CreateArtifactVersionInput): Promise<ArtifactVersionRecord>;
  updateArtifactVersionMetadata(input: { artifactVersionId: string; metadataJson: Record<string, unknown>; status?: ArtifactVersionStatus }): Promise<void>;
  createAsset(input: CreateAssetInput): Promise<AssetRecord>;
  createUsageEvent(input: UsageEventRecordInput): Promise<void>;
  findArtifactVersion(input: {
    organizationId: string;
    projectId: string;
    artifactVersionId: string;
  }): Promise<{ artifact: ArtifactRecord; artifactVersion: ArtifactVersionRecord } | null>;
  listArtifactVersionFiles(input: {
    artifactId: string;
    artifactVersionId: string;
  }): Promise<ArtifactVersionFileRecord[]>;
  findRoute(input: {
    siteId: string;
    path: string;
    matchType: PageRouteMatchType;
  }): Promise<PageRouteRecord | null>;
  createRoute(input: CreatePageRouteInput): Promise<PageRouteRecord>;
  getActiveRelease(siteId: string): Promise<PageSiteReleaseRecord | null>;
  listReleaseRoutes(releaseId: string): Promise<PageReleaseRouteRecord[]>;
  listUnreadPageCommentsForRoutes(input: {
    siteId: string;
    paths: string[];
    userId: string;
    limit: number;
  }): Promise<PagePublishUnreadCommentRecord[]>;
  getRelease(input: { organizationId: string; siteId: string; releaseId: string }): Promise<PageSiteReleaseRecord | null>;
  lockSiteReleaseSequence(siteId: string): Promise<void>;
  nextReleaseNumber(siteId: string): Promise<number>;
  createRelease(input: CreateReleaseInput): Promise<PageSiteReleaseRecord>;
  createReleaseRoute(input: CreateReleaseRouteInput): Promise<PageReleaseRouteRecord>;
  activateRelease(input: { siteId: string; releaseId: string; now: Date }): Promise<void>;
  insertAudit(input: AuditInput): Promise<void>;
};

type IdempotencyLookup = {
  organizationId: string;
  projectId: string;
  actorType: PublishActorType;
  actorId: string;
  idempotencyKey: string;
};

type PromoteObjectInput = {
  organizationId: string;
  projectId: string;
  artifactId: string;
  artifactVersionId: string;
  uploadSessionId: string;
  stagingPrefix: string;
  path: string;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  stagingKey?: string | null;
};

export type PageObjectStorage = {
  stagingPrefix(input: { organizationId: string; projectId: string; uploadSessionId: string }): string;
  createUploadPolicy(input: {
    stagingPrefix: string;
    expiresAt: Date;
    files: NormalizedManifestFile[];
    uploadPolicy?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  verifyStagedObjects(input: {
    uploadSession: PageUploadSessionRecord;
    files: NormalizedManifestFile[];
  }): Promise<void>;
  promoteObject(input: PromoteObjectInput): Promise<{ r2Key: string }>;
  writeManifest(input: {
    organizationId: string;
    projectId: string;
    artifactId: string;
    artifactVersionId: string;
    manifest: Record<string, unknown>;
  }): Promise<{ r2Key: string }>;
  writeSiteManifest(input: {
    hostname: string;
    manifest: Record<string, unknown>;
  }): Promise<{ r2Key: string }>;
  /** Reads a stored object as UTF-8 text; null when the driver keeps no bytes or the object is missing or too big. */
  readObjectText?(input: { key: string; maxBytes: number }): Promise<string | null>;
  /** A short-lived GET URL for a stored object; absent when the driver keeps no bytes. */
  presignObjectGet?(input: { key: string; expiresInSeconds: number }): Promise<string>;
};

/** Called once a release's edge manifest is live; schedules Knowledge capture and returns at once. Never throws. */
export type PageKnowledgeHook = (input: { siteId: string; releaseId: string; requestId: string }) => void;

type PublishServices = {
  /** Defaults to `scheduleKnowledgePageCapture`; tests pass a no-op. */
  knowledgeHook?: PageKnowledgeHook;
  passwordRepository?: PagesPasswordAccessRepository;
  repository?: PagePublishRepository;
  storage?: PageObjectStorage;
};

type PublishFailureSnapshot = {
  artifactVersionId?: string | null;
  idempotencyKey: string | null;
  manifest: NormalizedManifest;
  publishId?: string | null;
  project: ProjectRecord;
  source: Record<string, unknown>;
  uploadSession: PageUploadSessionRecord;
  visibility: ArtifactVisibility;
};

type PreparedPageFinalize = {
  artifact: ArtifactRecord;
  artifactVersion: ArtifactVersionRecord;
  idempotencyKey: string | null;
  manifest: NormalizedManifest;
  project: ProjectRecord;
  publish: PagePublishRecord;
  publishSite: PageSiteRecord | null;
  uploadSession: PageUploadSessionRecord;
};

type PagePublishDiagnosticPhase =
  | "upload_policy"
  | "prepare"
  | "pending_edge_manifest"
  | "verify_staged_objects"
  | "promote_objects"
  | "persist_release"
  | "active_edge_manifest";

type ArtifactStorageResult = {
  filesWithKeys: NormalizedManifestFile[];
  fullManifest: Record<string, unknown>;
  manifestKey: string;
  metadataJson: Record<string, unknown>;
};

const DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60;
const DEFAULT_MAX_UPLOAD_FILES = 1_000;
const DEFAULT_MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_EDGE_MANIFEST_REPAIR_COOLDOWN_SECONDS = 60;
const MAX_EDGE_MANIFEST_REPAIR_COOLDOWN_SECONDS = 600;
const DEFAULT_PAGE_STORAGE_CONCURRENCY = 8;
const MAX_PAGE_STORAGE_CONCURRENCY = 32;
import { hostedPagesDomain } from "@/server/console/pages/hosted-domain";

export function pagePublishRepositoryForDb(
  database: DbExecutor = db,
  root: DbRoot = db,
): PagePublishRepository {
  return {
    async authorizeProject(context, projectId, action) {
      if (context.actorType === "cli" && !context.authorization) return false;
      return (await decideInTransaction(database, { userId: context.actorId, organizationId: context.organizationId,
        delegation: context.authorization }, projectId, `project.${action}`, crypto.randomUUID())).allowed;
    },
    async withTransaction(fn) {
      return root.transaction(async (tx) => fn(pagePublishRepositoryForDb(tx, root)));
    },

    async findProjectByRef(organizationId, projectRef) {
      const refPredicate = isUuidRef(projectRef)
        ? or(eq(schema.projects.id, projectRef), eq(schema.projects.slug, projectRef))
        : eq(schema.projects.slug, projectRef);
      const [project] = await database
        .select({
          id: schema.projects.id,
          organizationId: schema.projects.organizationId,
          slug: schema.projects.slug,
          defaultVisibility: schema.projects.defaultVisibility,
        })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.organizationId, organizationId),
            refPredicate,
          ),
        )
        .limit(1);
      return project ?? null;
    },

    async findSiteByRef(organizationId, siteRef) {
      const refPredicate = isUuidRef(siteRef)
        ? or(eq(schema.pageSites.id, siteRef), eq(schema.pageSites.slug, siteRef))
        : eq(schema.pageSites.slug, siteRef);
      const [site] = await database
        .select()
        .from(schema.pageSites)
        .where(
          and(
            eq(schema.pageSites.organizationId, organizationId),
            refPredicate,
          ),
        )
        .limit(1);
      return site ?? null;
    },

    async findDefaultSite(projectId) {
      const [site] = await database
        .select()
        .from(schema.pageSites)
        .where(
          and(
            eq(schema.pageSites.projectId, projectId),
            eq(schema.pageSites.isDefault, true),
          ),
        )
        .limit(1);
      return site ?? null;
    },

    async findSiteByHost(organizationId, host) {
      const normalizedHost = normalizeHostedPagesHost(host);
      if (!normalizedHost) return null;
      const hostedSlug = hostedSlugFromPagesHost(normalizedHost);
      const hostPredicate = hostedSlug
        ? or(eq(schema.pageSites.defaultHostname, normalizedHost), eq(schema.pageSites.slug, hostedSlug))
        : eq(schema.pageSites.defaultHostname, normalizedHost);
      const [site] = await database
        .select()
        .from(schema.pageSites)
        .where(
          and(
            eq(schema.pageSites.organizationId, organizationId),
            hostPredicate,
          ),
        )
        .limit(1);
      return site ?? null;
    },

    async updateSiteEdgeManifestState(input) {
      const [site] = await database
        .select({ metadataJson: schema.pageSites.metadataJson })
        .from(schema.pageSites)
        .where(eq(schema.pageSites.id, input.siteId))
        .limit(1);
      const metadataJson = record(site?.metadataJson);
      await database
        .update(schema.pageSites)
        .set({
          metadataJson: {
            ...metadataJson,
            edgeManifest: input.edgeManifest,
          },
          updatedAt: input.now,
        })
        .where(eq(schema.pageSites.id, input.siteId));
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

    async findUploadSession(input) {
      const [session] = await database
        .select()
        .from(schema.pageUploadSessions)
        .where(
          and(
            eq(schema.pageUploadSessions.organizationId, input.organizationId),
            eq(schema.pageUploadSessions.id, input.uploadSessionId),
            eq(schema.pageUploadSessions.createdByActorType, input.actorType),
            eq(schema.pageUploadSessions.createdByActorId, input.actorId),
          ),
        )
        .limit(1);
      return session ?? null;
    },

    async findUploadSessionByIdempotencyKey(input) {
      const [session] = await database
        .select()
        .from(schema.pageUploadSessions)
        .where(
          and(
            eq(schema.pageUploadSessions.organizationId, input.organizationId),
            eq(schema.pageUploadSessions.projectId, input.projectId),
            eq(schema.pageUploadSessions.createdByActorType, input.actorType),
            eq(schema.pageUploadSessions.createdByActorId, input.actorId),
            eq(schema.pageUploadSessions.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      return session ?? null;
    },

    async createUploadSession(input) {
      const [session] = await database.insert(schema.pageUploadSessions).values(input).returning();
      if (!session) throw new Error("Failed to create upload session.");
      return session;
    },

    async updateUploadSession(input) {
      await database
        .update(schema.pageUploadSessions)
        .set({
          status: input.status,
          fileManifestJson: input.fileManifestJson,
          errorCode: input.errorCode,
          finalizedAt: input.finalizedAt,
          updatedAt: new Date(),
        })
        .where(eq(schema.pageUploadSessions.id, input.id));
    },

    async findPublishByIdempotencyKey(input) {
      const [publish] = await database
        .select()
        .from(schema.pagePublishes)
        .where(
          and(
            eq(schema.pagePublishes.organizationId, input.organizationId),
            eq(schema.pagePublishes.projectId, input.projectId),
            eq(schema.pagePublishes.createdByActorType, input.actorType),
            eq(schema.pagePublishes.createdByActorId, input.actorId),
            eq(schema.pagePublishes.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      return publish ?? null;
    },

    async findPublish(id) {
      const [publish] = await database.select().from(schema.pagePublishes).where(eq(schema.pagePublishes.id, id)).limit(1);
      return publish ?? null;
    },

    async createPublish(input) {
      const [publish] = await database.insert(schema.pagePublishes).values(input).returning();
      if (!publish) throw new Error("Failed to create page publish.");
      return publish;
    },

    async updatePublish(input) {
      const [publish] = await database
        .update(schema.pagePublishes)
        .set({
          artifactId: input.artifactId,
          artifactVersionId: input.artifactVersionId,
          siteId: input.siteId,
          siteReleaseId: input.siteReleaseId,
          status: input.status,
          manifestKey: input.manifestKey,
          manifestHash: input.manifestHash,
          routeChangesJson: input.routeChangesJson,
          errorCode: input.errorCode,
          completedAt: input.completedAt,
          updatedAt: new Date(),
        })
        .where(eq(schema.pagePublishes.id, input.id))
        .returning();
      if (!publish) throw new Error("Failed to update page publish.");
      return publish;
    },

    async findArtifactByRef(projectId, artifactRef) {
      const refPredicate = isUuidRef(artifactRef)
        ? or(
            eq(schema.artifacts.id, artifactRef),
            eq(schema.artifacts.slug, artifactRef),
            eq(schema.artifacts.localArtifactId, artifactRef),
          )
        : or(eq(schema.artifacts.slug, artifactRef), eq(schema.artifacts.localArtifactId, artifactRef));
      const [artifact] = await database
        .select()
        .from(schema.artifacts)
        .where(
          and(
            eq(schema.artifacts.projectId, projectId),
            refPredicate,
          ),
        )
        .limit(1);
      return artifact ?? null;
    },

    async createArtifact(input) {
      const [artifact] = await database
        .insert(schema.artifacts)
        .values({
          ...input,
          status: "active",
          syncStatus: "cloud_synced",
        })
        .returning();
      if (!artifact) throw new Error("Failed to create artifact.");
      return artifact;
    },

    async updateArtifactVersionState(input) {
      await database
        .update(schema.artifacts)
        .set({
          lastCloudVersion: input.lastCloudVersion,
          syncStatus: "cloud_synced",
          syncMetadataJson: input.syncMetadataJson,
          updatedAt: new Date(),
        })
        .where(eq(schema.artifacts.id, input.artifactId));
    },

    async lockArtifactVersionSequence(artifactId) {
      await database.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`artifact_version:${artifactId}`}))`);
    },

    async nextArtifactVersionNumber(artifactId) {
      const [latest] = await database
        .select({ versionNumber: schema.artifactVersions.versionNumber })
        .from(schema.artifactVersions)
        .where(eq(schema.artifactVersions.artifactId, artifactId))
        .orderBy(desc(schema.artifactVersions.versionNumber))
        .limit(1);
      return (latest?.versionNumber ?? 0) + 1;
    },

    async createArtifactVersion(input) {
      const [version] = await database
        .insert(schema.artifactVersions)
        .values({
          ...input,
          status: input.status ?? "created",
        })
        .returning();
      if (!version) throw new Error("Failed to create artifact version.");
      return version;
    },

    async updateArtifactVersionMetadata(input) {
      await database
        .update(schema.artifactVersions)
        .set({
          metadataJson: input.metadataJson,
          ...(input.status ? { status: input.status } : {}),
        })
        .where(eq(schema.artifactVersions.id, input.artifactVersionId));
    },

    async createAsset(input) {
      const [asset] = await database.insert(schema.assets).values({
        ...input,
        role: input.path === "index.html" ? "entrypoint" : "file",
      }).returning();
      if (!asset) throw new Error("Failed to create asset.");
      return asset;
    },

    async createUsageEvent(input) {
      await database.insert(schema.usageEvents).values(input).onConflictDoNothing();
    },

    async findArtifactVersion(input) {
      const [row] = await database
        .select({
          artifact: schema.artifacts,
          artifactVersion: schema.artifactVersions,
          project: schema.projects,
        })
        .from(schema.artifactVersions)
        .innerJoin(schema.artifacts, eq(schema.artifactVersions.artifactId, schema.artifacts.id))
        .innerJoin(schema.projects, eq(schema.artifacts.projectId, schema.projects.id))
        .where(
          and(
            eq(schema.artifactVersions.id, input.artifactVersionId),
            eq(schema.artifacts.projectId, input.projectId),
            eq(schema.projects.organizationId, input.organizationId),
          ),
        )
        .limit(1);
      return row ? { artifact: row.artifact, artifactVersion: row.artifactVersion } : null;
    },

    async listArtifactVersionFiles(input) {
      return database
        .select({
          artifactStatus: schema.artifacts.status,
          versionStatus: schema.artifactVersions.status,
          versionNumber: schema.artifactVersions.versionNumber,
          versionSha256: schema.artifactVersions.sha256,
          path: schema.assets.path,
          mimeType: schema.assets.mimeType,
          sizeBytes: schema.assets.sizeBytes,
          sha256: schema.assets.sha256,
          storageJson: schema.assets.storageJson,
          metadataJson: schema.assets.metadataJson,
        })
        .from(schema.assets)
        .innerJoin(schema.artifacts, eq(schema.assets.artifactId, schema.artifacts.id))
        .innerJoin(schema.artifactVersions, eq(schema.assets.artifactVersionId, schema.artifactVersions.id))
        .where(
          and(
            eq(schema.assets.artifactId, input.artifactId),
            eq(schema.assets.artifactVersionId, input.artifactVersionId),
          ),
        )
        .orderBy(schema.assets.path);
    },

    async findRoute(input) {
      const [route] = await database
        .select()
        .from(schema.pageRoutes)
        .where(
          and(
            eq(schema.pageRoutes.siteId, input.siteId),
            eq(schema.pageRoutes.path, input.path),
            eq(schema.pageRoutes.matchType, input.matchType),
          ),
        )
        .limit(1);
      return route ?? null;
    },

    async createRoute(input) {
      const [route] = await database.insert(schema.pageRoutes).values({ ...input, status: "active" }).returning();
      if (!route) throw new Error("Failed to create route.");
      return route;
    },

    async getActiveRelease(siteId) {
      const [site] = await database.select().from(schema.pageSites).where(eq(schema.pageSites.id, siteId)).limit(1);
      if (!site?.activeReleaseId) return null;
      const [release] = await database.select().from(schema.pageSiteReleases).where(eq(schema.pageSiteReleases.id, site.activeReleaseId)).limit(1);
      return release ?? null;
    },

    async listReleaseRoutes(releaseId) {
      return database
        .select()
        .from(schema.pageReleaseRoutes)
        .where(eq(schema.pageReleaseRoutes.releaseId, releaseId))
        .orderBy(desc(schema.pageReleaseRoutes.priority), desc(schema.pageReleaseRoutes.path));
    },

    async listUnreadPageCommentsForRoutes(input) {
      if (input.paths.length === 0) return [];
      return database
        .select({
          id: schema.pageComments.id,
          body: schema.pageComments.body,
          path: schema.pageComments.path,
          createdAt: schema.pageComments.createdAt,
          createdByUserId: schema.pageComments.createdByUserId,
          createdByDisplayName: schema.users.displayName,
        })
        .from(schema.pageComments)
        .leftJoin(
          schema.pageCommentReadReceipts,
          and(
            eq(schema.pageCommentReadReceipts.siteId, schema.pageComments.siteId),
            eq(schema.pageCommentReadReceipts.path, schema.pageComments.path),
            eq(schema.pageCommentReadReceipts.userId, input.userId),
          ),
        )
        .leftJoin(schema.users, eq(schema.pageComments.createdByUserId, schema.users.id))
        .where(
          and(
            eq(schema.pageComments.siteId, input.siteId),
            inArray(schema.pageComments.path, input.paths),
            eq(schema.pageComments.status, "open"),
            or(isNull(schema.pageComments.createdByUserId), ne(schema.pageComments.createdByUserId, input.userId)),
            or(
              isNull(schema.pageCommentReadReceipts.lastReadCommentCreatedAt),
              gt(schema.pageComments.createdAt, schema.pageCommentReadReceipts.lastReadCommentCreatedAt),
            ),
          ),
        )
        .orderBy(desc(schema.pageComments.createdAt))
        .limit(input.limit);
    },

    async getRelease(input) {
      const [release] = await database
        .select()
        .from(schema.pageSiteReleases)
        .where(
          and(
            eq(schema.pageSiteReleases.organizationId, input.organizationId),
            eq(schema.pageSiteReleases.siteId, input.siteId),
            eq(schema.pageSiteReleases.id, input.releaseId),
          ),
        )
        .limit(1);
      return release ?? null;
    },

    async lockSiteReleaseSequence(siteId) {
      await database.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`site_release:${siteId}`}))`);
    },

    async nextReleaseNumber(siteId) {
      const [latest] = await database
        .select({ releaseNumber: schema.pageSiteReleases.releaseNumber })
        .from(schema.pageSiteReleases)
        .where(eq(schema.pageSiteReleases.siteId, siteId))
        .orderBy(desc(schema.pageSiteReleases.releaseNumber))
        .limit(1);
      return (latest?.releaseNumber ?? 0) + 1;
    },

    async createRelease(input) {
      const [release] = await database.insert(schema.pageSiteReleases).values(input).returning();
      if (!release) throw new Error("Failed to create release.");
      return release;
    },

    async createReleaseRoute(input) {
      const [route] = await database.insert(schema.pageReleaseRoutes).values(input).returning();
      if (!route) throw new Error("Failed to create release route.");
      return route;
    },

    async activateRelease(input) {
      await database
        .update(schema.pageSiteReleases)
        .set({ status: "archived" })
        .where(and(eq(schema.pageSiteReleases.siteId, input.siteId), eq(schema.pageSiteReleases.status, "active")));
      await database
        .update(schema.pageSites)
        .set({ activeReleaseId: input.releaseId, updatedAt: input.now })
        .where(eq(schema.pageSites.id, input.siteId));
      await database
        .update(schema.pageSiteReleases)
        .set({ status: "active", activatedAt: input.now })
        .where(eq(schema.pageSiteReleases.id, input.releaseId));
    },

    async insertAudit(input) {
      await database.insert(schema.auditEvents).values(input);
    },
  };
}

export function createPageObjectStorageFromEnv(): PageObjectStorage {
  const allowMetadataOnlyStorage =
    process.env.RAVI_PAGES_STORAGE_DRIVER === "metadata" || process.env.RAVI_PAGES_ALLOW_METADATA_STORAGE === "true";

  if (allowMetadataOnlyStorage) {
    if (process.env.NODE_ENV === "production") {
      throw publishError(503, "publish_storage_failed");
    }
    return createMetadataOnlyPageObjectStorage();
  }

  const bucket = process.env.RAVI_PAGES_R2_BUCKET?.trim();
  const accessKeyId = process.env.RAVI_PAGES_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.RAVI_PAGES_R2_SECRET_ACCESS_KEY?.trim();
  const endpoint = r2EndpointFromEnv();
  const region = process.env.RAVI_PAGES_R2_REGION?.trim() || "auto";

  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) {
    throw publishError(503, "publish_storage_failed");
  }

  return createR2PageObjectStorage({
    accessKeyId,
    bucket,
    endpoint,
    region,
    secretAccessKey,
  });
}

function createMetadataOnlyPageObjectStorage(): PageObjectStorage {
  return {
    stagingPrefix(input) {
      return `staging/org/${input.organizationId}/project/${input.projectId}/upload/${input.uploadSessionId}`;
    },

    async createUploadPolicy(input) {
      return {
        ...input.uploadPolicy,
        driver: "metadata",
        directUpload: false,
        stagingPrefix: input.stagingPrefix,
        expiresAt: input.expiresAt.toISOString(),
        files: input.files.map((file) => ({
          path: file.path,
          stagingKey: stagingObjectKey(input.stagingPrefix, file.path),
          method: "metadata",
          headers: uploadHeadersForFile(file),
        })),
      };
    },

    async verifyStagedObjects() {
      return undefined;
    },

    async promoteObject(input) {
      return {
        r2Key: finalObjectKey(input),
      };
    },

    async writeManifest(input) {
      return {
        r2Key: manifestObjectKey(input),
      };
    },

    async writeSiteManifest(input) {
      return {
        r2Key: activeSiteManifestObjectKey(input.hostname),
      };
    },

    async readObjectText() {
      return null;
    },
  };
}

type R2StorageConfig = {
  accessKeyId: string;
  bucket: string;
  endpoint: URL;
  region: string;
  secretAccessKey: string;
};

type R2SignedRequest = {
  body?: BodyInit;
  headers?: Record<string, string>;
  method: string;
  url: URL;
};

function createR2PageObjectStorage(config: R2StorageConfig): PageObjectStorage {
  const client = createR2AwsClient(config);
  const concurrency = pageStorageConcurrency();

  return {
    stagingPrefix(input) {
      return `staging/org/${input.organizationId}/project/${input.projectId}/upload/${input.uploadSessionId}`;
    },

    async createUploadPolicy(input) {
      const expiresInSeconds = uploadPolicyTtlSeconds(input.expiresAt);
      return {
        ...input.uploadPolicy,
        driver: "object_storage",
        directUpload: true,
        stagingPrefix: input.stagingPrefix,
        expiresAt: input.expiresAt.toISOString(),
        files: await Promise.all(input.files.map(async (file) => {
          const stagingKey = stagingObjectKey(input.stagingPrefix, file.path);
          const headers = uploadHeadersForFile(file);
          return {
            path: file.path,
            stagingKey,
            method: "PUT",
            url: await presignR2Url(client, config, {
              expiresInSeconds,
              headers,
              key: stagingKey,
              method: "PUT",
            }),
            headers,
          };
        })),
      };
    },

    async verifyStagedObjects(input) {
      await mapWithConcurrency(input.files, concurrency, async (file) => {
        const stagingKey = stagingObjectKey(input.uploadSession.stagingPrefix, file.path);
        assertManifestStagingKey(file, stagingKey);
        const response = await signedR2Fetch(client, {
          method: "HEAD",
          url: r2ObjectUrl(config, stagingKey),
        });
        if (response.status === 404) throw storageProviderError("staged_object_missing", stagingKey);
        if (!response.ok) throw storageProviderError("staged_object_head_failed", stagingKey, response.status);

        const size = stagedObjectSize(response);
        if (!Number.isFinite(size)) {
          throw storageProviderError("staged_object_size_missing", stagingKey, response.status, {
            expectedSize: file.sizeBytes,
          });
        }
        if (size !== file.sizeBytes) {
          throw storageProviderError("staged_object_size_mismatch", stagingKey, response.status, {
            actualSize: size,
            expectedSize: file.sizeBytes,
          });
        }

        const sha256 = response.headers.get("x-amz-meta-ravi-sha256") ?? response.headers.get("x-amz-meta-sha256");
        if (!sha256 || sha256 !== file.sha256) {
          throw storageProviderError("staged_object_sha256_mismatch", stagingKey, response.status, {
            actualSha256: sha256,
            expectedSha256: file.sha256,
          });
        }

        const objectResponse = await signedR2Fetch(client, {
          method: "GET",
          url: r2ObjectUrl(config, stagingKey),
        });
        if (!objectResponse.ok) throw storageProviderError("staged_object_get_failed", stagingKey, objectResponse.status);
        const actualSha256 = await sha256ResponseBody(objectResponse, stagingKey);
        if (actualSha256 !== file.sha256) {
          throw storageProviderError("staged_object_body_sha256_mismatch", stagingKey, objectResponse.status, {
            actualSha256,
            expectedSha256: file.sha256,
          });
        }
      });
    },

    async promoteObject(input) {
      const stagingKey = stagingObjectKey(input.stagingPrefix, input.path);
      assertManifestStagingKey(input, stagingKey);
      const finalKey = finalObjectKey(input);
      const response = await signedR2Fetch(client, {
        headers: {
          "x-amz-copy-source": copySourceFor(config.bucket, stagingKey),
          "x-amz-metadata-directive": "COPY",
        },
        method: "PUT",
        url: r2ObjectUrl(config, finalKey),
      });
      if (!response.ok) throw storageProviderError("object_promote_failed", finalKey, response.status);
      return { r2Key: finalKey };
    },

    async writeManifest(input) {
      const key = manifestObjectKey(input);
      const body = stableStringify(input.manifest);
      const response = await signedR2Fetch(client, {
        body,
        headers: jsonObjectPutHeaders(body, {
          "content-type": "application/json; charset=utf-8",
          "x-amz-meta-ravi-manifest-sha256": stableHash(input.manifest),
        }),
        method: "PUT",
        url: r2ObjectUrl(config, key),
      });
      if (!response.ok) throw storageProviderError("manifest_write_failed", key, response.status);
      return { r2Key: key };
    },

    async writeSiteManifest(input) {
      const key = activeSiteManifestObjectKey(input.hostname);
      const body = stableStringify(input.manifest);
      const response = await signedR2Fetch(client, {
        body,
        headers: jsonObjectPutHeaders(body, {
          "content-type": "application/json; charset=utf-8",
          "x-amz-meta-ravi-edge-manifest-sha256": stableHash(input.manifest),
        }),
        method: "PUT",
        url: r2ObjectUrl(config, key),
      });
      if (!response.ok) throw storageProviderError("site_manifest_write_failed", key, response.status);
      return { r2Key: key };
    },

    async readObjectText(input) {
      const response = await signedR2Fetch(client, {
        method: "GET",
        url: r2ObjectUrl(config, input.key),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw storageProviderError("object_read_failed", input.key, response.status);
      const size = numericHeader(response, "content-length");
      if (Number.isFinite(size) && size > input.maxBytes) {
        await response.body?.cancel();
        return null;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > input.maxBytes) return null;
      return new TextDecoder("utf-8").decode(bytes);
    },

    async presignObjectGet(input) {
      return presignR2Url(client, config, {
        expiresInSeconds: input.expiresInSeconds,
        headers: {},
        key: input.key,
        method: "GET",
      });
    },
  };
}

function createR2AwsClient(config: R2StorageConfig) {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
  });
}

function r2EndpointFromEnv() {
  const configured = process.env.RAVI_PAGES_R2_ENDPOINT?.trim();
  if (configured) return new URL(configured);
  const accountId = process.env.RAVI_PAGES_R2_ACCOUNT_ID?.trim();
  return accountId ? new URL(`https://${accountId}.r2.cloudflarestorage.com`) : null;
}

async function presignR2Url(
  client: AwsClient,
  config: R2StorageConfig,
  input: {
    expiresInSeconds: number;
    headers: Record<string, string>;
    key: string;
    method: string;
  },
) {
  const url = r2ObjectUrl(config, input.key);
  url.searchParams.set("X-Amz-Expires", String(input.expiresInSeconds));
  const signed = await client.sign(url.toString(), {
    aws: { signQuery: true },
    headers: input.headers,
    method: input.method,
  });
  return signed.url;
}

async function signedR2Fetch(client: AwsClient, request: R2SignedRequest) {
  const signed = await client.sign(request.url.toString(), {
    body: request.body,
    headers: request.headers,
    method: request.method,
  });
  return fetch(signed);
}

function stagedObjectSize(response: Response) {
  const metadataSize = numericHeader(response, "x-amz-meta-ravi-size-bytes");
  if (Number.isFinite(metadataSize)) return metadataSize;
  return numericHeader(response, "content-length");
}

function numericHeader(response: Response, header: string) {
  const value = response.headers.get(header);
  if (!value) return Number.NaN;
  const size = Number(value);
  return Number.isFinite(size) ? size : Number.NaN;
}

async function sha256ResponseBody(response: Response, key: string) {
  if (!response.body) throw storageProviderError("staged_object_body_missing", key, response.status);
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest("hex");
}

function r2ObjectUrl(config: R2StorageConfig, key: string) {
  const url = new URL(config.endpoint);
  url.pathname = `/${config.bucket}/${key}`.split("/").map(awsUriEncode).join("/");
  url.search = "";
  return url;
}

function uploadHeadersForFile(file: NormalizedManifestFile) {
  return {
    "content-type": file.contentType,
    "x-amz-meta-ravi-path": file.path,
    "x-amz-meta-ravi-sha256": file.sha256,
    "x-amz-meta-ravi-size-bytes": String(file.sizeBytes),
  };
}

function jsonObjectPutHeaders(body: string, headers: Record<string, string>) {
  return {
    ...headers,
    "content-length": String(Buffer.byteLength(body)),
  };
}

function uploadPolicyTtlSeconds(expiresAt: Date) {
  return Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
}

function stagingObjectKey(stagingPrefix: string, path: string) {
  return `${stagingPrefix}/${path}`;
}

function manifestObjectKey(input: {
  organizationId: string;
  projectId: string;
  artifactId: string;
  artifactVersionId: string;
}) {
  return `org/${input.organizationId}/project/${input.projectId}/artifact/${input.artifactId}/version/${input.artifactVersionId}/manifest.json`;
}

function activeSiteManifestObjectKey(hostname: string) {
  return `sites/${hostname.toLowerCase()}/active.json`;
}

function copySourceFor(bucket: string, key: string) {
  return `/${bucket}/${key.split("/").map(awsUriEncode).join("/")}`;
}

function assertManifestStagingKey(input: { path: string; stagingKey?: string | null }, expected: string) {
  if (input.stagingKey && input.stagingKey !== expected) {
    throw publishError(400, "publish_validation_failed");
  }
}

function storageProviderError(reason: string, key: string, status?: number, details?: Record<string, unknown>) {
  const error = new Error(`Ravi Pages storage error: ${reason}`);
  Object.assign(error, { reason, key, status, details });
  return error;
}

function awsUriEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function persistFinalizeFailure({
  code,
  context,
  durationMs,
  phase,
  repository,
  requestId,
  snapshot,
}: {
  code: PublishErrorCode;
  context: PagePublishContext;
  durationMs?: number;
  phase?: PagePublishDiagnosticPhase;
  repository: PagePublishRepository;
  requestId: string;
  snapshot: PublishFailureSnapshot | null;
}) {
  if (!snapshot) return;

  try {
    await repository.withTransaction(async (tx) => {
      const existingPublish =
        (snapshot.publishId ? await tx.findPublish(snapshot.publishId) : null) ??
        (snapshot.idempotencyKey
          ? await tx.findPublishByIdempotencyKey({
              organizationId: context.organizationId,
              projectId: snapshot.project.id,
              actorType: context.actorType,
              actorId: context.actorId,
              idempotencyKey: snapshot.idempotencyKey,
            })
          : null);

      const publish =
        existingPublish ??
        (await tx.createPublish({
          organizationId: context.organizationId,
          projectId: snapshot.project.id,
          artifactId: null,
          artifactVersionId: null,
          siteId: snapshot.uploadSession.siteId,
          siteReleaseId: null,
          sourceType: "upload_session",
          sourceRef: snapshot.uploadSession.id,
          status: "failed",
          manifestKey: snapshot.manifest.manifestKey,
          manifestHash: snapshot.manifest.manifestHash,
          objectCount: snapshot.manifest.files.length,
          totalBytes: totalBytes(snapshot.manifest.files),
          visibility: snapshot.visibility,
          routeChangesJson: {},
          idempotencyKey: snapshot.idempotencyKey,
          errorCode: code,
          createdByActorType: context.actorType,
          createdByActorId: context.actorId,
          metadataJson: {
            source: snapshot.source,
            artifactVersionId: snapshot.artifactVersionId ?? null,
          },
          completedAt: new Date(),
        }));

      if (existingPublish && existingPublish.status !== "failed") {
        await tx.updatePublish({
          id: existingPublish.id,
          status: "failed",
          errorCode: code,
          completedAt: new Date(),
        });
      }

      await tx.updateUploadSession({
        id: snapshot.uploadSession.id,
        status: "failed",
        errorCode: code,
      });
      await tx.insertAudit({
        organizationId: context.organizationId,
        projectId: snapshot.project.id,
        actorType: context.actorType,
        actorId: context.actorId,
        targetType: "page_publish",
        targetId: publish.id,
        action: "page_publish.failed",
        requestId,
        metadataJson: {
          reason: code,
          phase: phase ?? null,
          durationMs: durationMs ?? null,
          artifactVersionId: snapshot.artifactVersionId ?? null,
          idempotencyKey: snapshot.idempotencyKey,
          persistedAfterFailureCleanup: true,
        },
      });
    });
  } catch (failureError) {
    console.error("Failed to persist Ravi Pages publish failure", {
      error: failureError,
      requestId,
    });
  }
}

export async function createPageUploadSession({
  context,
  input,
  repository = pagePublishRepositoryForDb(),
  requestId,
  storage = createPageObjectStorageFromEnv(),
}: {
  context: PagePublishContext;
  input: CreatePageUploadSessionInput;
  requestId: string;
} & PublishServices): Promise<PageUploadSessionResult> {
  assertCanPublish(context);
  const project = await repository.findProjectByRef(context.organizationId, input.projectRef);
  if (!project) throw publishError(404, "publish_forbidden");
  await assertProjectAccess(context, repository, project.id, "write");

  const site = input.siteRef ? await requireSite(repository, context.organizationId, project.id, input.siteRef) : null;
  const manifest = normalizePackageManifest(input.packageManifest);
  assertUploadManifestLimits(manifest);
  const idempotencyKey = cleanKey(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = await repository.findUploadSessionByIdempotencyKey({
      organizationId: context.organizationId,
      projectId: project.id,
      actorType: context.actorType,
      actorId: context.actorId,
      idempotencyKey,
    });
    if (existing) {
      const existingManifest = reusableUploadSessionManifest(existing, manifest);
      const uploadPolicy = await storage.createUploadPolicy({
        stagingPrefix: existing.stagingPrefix,
        expiresAt: existing.expiresAt,
        files: existingManifest.files,
        uploadPolicy: input.uploadPolicy,
      });
      return {
        uploadSession: publicUploadSession(existing),
        uploadPolicy,
      };
    }
  }

  const uploadSessionId = randomUUID();
  const expiresAt = new Date(Date.now() + uploadTtlSeconds() * 1000);
  const stagingPrefix = storage.stagingPrefix({
    organizationId: context.organizationId,
    projectId: project.id,
    uploadSessionId,
  });
  let uploadPolicy: Record<string, unknown>;
  try {
    uploadPolicy = await storage.createUploadPolicy({
      stagingPrefix,
      expiresAt,
      files: manifest.files,
      uploadPolicy: input.uploadPolicy,
    });
  } catch (error) {
    await repository.insertAudit({
      organizationId: context.organizationId,
      projectId: project.id,
      actorType: context.actorType,
      actorId: context.actorId,
      targetType: "page_upload_session",
      targetId: null,
      action: "page_upload_session.failed",
      requestId,
      metadataJson: {
        reason: "publish_storage_failed",
        idempotencyKey,
        storageError: safeErrorDetails(error),
      },
    });
    await capturePagesPublishDiagnostic({
      code: "publish_storage_failed",
      context,
      error,
      objectCount: manifest.files.length,
      phase: "upload_policy",
      projectId: project.id,
      requestId,
      siteId: site?.id ?? null,
      totalBytes: totalBytes(manifest.files),
    });
    throw publishError(502, "publish_storage_failed");
  }

  const uploadSession = await repository.createUploadSession({
    id: uploadSessionId,
    idempotencyKey,
    organizationId: context.organizationId,
    projectId: project.id,
    siteId: site?.id ?? null,
    stagingPrefix,
    fileManifestJson: manifest.publicManifest,
    uploadPolicyJson: uploadPolicySummary(uploadPolicy),
    createdByActorType: context.actorType,
    createdByActorId: context.actorId,
    expiresAt,
  });

  await repository.insertAudit({
    organizationId: context.organizationId,
    projectId: project.id,
    actorType: context.actorType,
    actorId: context.actorId,
    targetType: "page_upload_session",
    targetId: uploadSession.id,
    action: "page_upload_session.created",
    requestId,
    metadataJson: {
      siteId: site?.id ?? null,
      idempotencyKey,
      stagingPrefix,
      manifestHash: manifest.manifestHash,
      objectCount: manifest.files.length,
      totalBytes: totalBytes(manifest.files),
    },
  });

  return { uploadSession: publicUploadSession(uploadSession), uploadPolicy };
}

export async function finalizePageUploadSession({
  context,
  input,
  passwordRepository = pagesPasswordAccessRepositoryForDb(),
  repository = pagePublishRepositoryForDb(),
  requestId,
  knowledgeHook = scheduleKnowledgePageCapture,
  storage = createPageObjectStorageFromEnv(),
}: {
  context: PagePublishContext;
  input: FinalizePageUploadSessionInput;
  requestId: string;
} & PublishServices): Promise<PagePublishResult> {
  assertCanPublish(context);
  // A bad allowlist is the caller's error; the catch below would file it as a
  // storage failure.
  snapshotConnectorUsesFromManifest(input.publish?.uses);
  publishPresentation(input.publish?.presentation);
  let failureSnapshot: PublishFailureSnapshot | null = null;
  let preparedFinalize: PreparedPageFinalize | null = null;
  let pendingBarrierSite: PageSiteRecord | null = null;
  const finalizeStartedAt = Date.now();
  let phase: PagePublishDiagnosticPhase = "prepare";

  try {
    const prepared = await repository.withTransaction((tx) =>
      preparePageFinalize({
        context,
        input,
        repository: tx,
        requestId,
      }),
    );
    if ("existingResult" in prepared) return prepared.existingResult;

    preparedFinalize = prepared;
    failureSnapshot = {
      artifactVersionId: prepared.artifactVersion.id,
      idempotencyKey: prepared.idempotencyKey,
      manifest: prepared.manifest,
      project: prepared.project,
      publishId: prepared.publish.id,
      source: input.source ?? {},
      uploadSession: prepared.uploadSession,
      visibility: prepared.publish.visibility,
    };

    const plannedReleaseId = input.publish && prepared.publishSite && input.publish.activate !== false ? randomUUID() : null;
    if (plannedReleaseId && prepared.publishSite) {
      phase = "pending_edge_manifest";
      pendingBarrierSite = await writePendingSiteEdgeManifestForPlannedRelease({
        context,
        plannedReleaseId,
        projectRef: prepared.project.id,
        repository,
        requestId,
        siteRef: prepared.publishSite.id,
        knowledgeHook,
        storage,
      });
    }

    phase = "verify_staged_objects";
    await storage.verifyStagedObjects({
      uploadSession: prepared.uploadSession,
      files: prepared.manifest.files,
    });
    phase = "promote_objects";
    const storageResult = await writeArtifactVersionObjects({
      artifact: prepared.artifact,
      artifactVersion: prepared.artifactVersion,
      context,
      manifest: prepared.manifest,
      storage,
      uploadSession: prepared.uploadSession,
    });

    phase = "persist_release";
    const result = await repository.withTransaction(async (tx) => {
      // Storage promotion may take time after admission. Recheck even when the
      // caller is only finalizing an artifact without activating a Page release.
      await assertProjectAccess(context, tx, prepared.project.id, "write");
      const artifactVersion = await persistArtifactVersionStorage({
        artifact: prepared.artifact,
        artifactVersion: prepared.artifactVersion,
        context,
        manifest: prepared.manifest,
        publish: prepared.publish,
        repository: tx,
        requestId,
        storageResult,
        uploadSession: prepared.uploadSession,
      });

      let releaseResult: PageSiteReleaseResult | null = null;
      if (input.publish && prepared.publishSite && input.publish.activate !== false) {
        const routes = routesFromPublishInput(input.publish, prepared.artifact, artifactVersion, prepared.manifest);
        releaseResult = await createReleaseForRoutes({
          context,
          input: {
            projectRef: prepared.project.id,
            siteRef: prepared.publishSite.id,
            activate: true,
            replaceRelease: Boolean(input.publish.replaceRelease),
            reason: input.publish.reason ?? "publish",
            routes,
          },
          passwordRepository,
          repository: tx,
          requestId,
          publish: prepared.publish,
          plannedReleaseId,
        });
      }

      const publish = await tx.updatePublish({
        id: prepared.publish.id,
        artifactId: prepared.artifact.id,
        artifactVersionId: artifactVersion.id,
        siteId: releaseResult?.release.siteId ?? null,
        siteReleaseId: releaseResult?.release.id ?? null,
        status: "completed",
        manifestKey: prepared.manifest.manifestKey,
        manifestHash: prepared.manifest.manifestHash,
        routeChangesJson: {
          mode: input.publish?.routes ? "manifest" : "single_route",
          routes: releaseResult?.routes.map(releaseRouteSummary) ?? [],
        },
        completedAt: new Date(),
      });

      await tx.updateUploadSession({
        id: prepared.uploadSession.id,
        status: "finalized",
        fileManifestJson: prepared.manifest.publicManifest,
        finalizedAt: new Date(),
      });

      await tx.insertAudit({
        organizationId: context.organizationId,
        projectId: prepared.project.id,
        actorType: context.actorType,
        actorId: context.actorId,
        targetType: "page_publish",
        targetId: publish.id,
        action: "page_publish.completed",
        requestId,
        metadataJson: {
          artifactId: prepared.artifact.id,
          artifactVersionId: artifactVersion.id,
          siteReleaseId: releaseResult?.release.id ?? null,
          idempotencyKey: prepared.idempotencyKey,
          manifestHash: prepared.manifest.manifestHash,
          objectCount: prepared.manifest.files.length,
          totalBytes: totalBytes(prepared.manifest.files),
        },
      });

      return {
        artifact: prepared.artifact,
        artifactVersion,
        publish,
        site: releaseResult?.site ?? null,
        release: releaseResult?.release ?? null,
        routes: releaseResult?.routes ?? [],
        url: releaseResult ? publishedRouteUrl(releaseResult.site, primaryPublishRoutePath(input.publish)) : null,
      };
    });
    if (result.site && result.release?.status === "active") {
      phase = "active_edge_manifest";
      await writeActiveSiteEdgeManifest({
        context,
        release: result.release,
        repository,
        requestId,
        routes: result.routes,
        site: result.site,
        knowledgeHook,
        storage,
      });
    }
    return result;
  } catch (error) {
    const code = publicPublishErrorCode(error);
    const durationMs = Date.now() - finalizeStartedAt;
    console.error("Ravi Pages publish finalize failed", {
      requestId,
      code,
      phase,
      durationMs,
      internalError: safeErrorDetails(error),
    });
    await capturePagesPublishDiagnostic({
      code,
      context,
      durationMs,
      error,
      objectCount: failureSnapshot?.manifest.files.length,
      phase,
      projectId: failureSnapshot?.project.id,
      publishId: failureSnapshot?.publishId ?? null,
      requestId,
      siteId: preparedFinalize?.publishSite?.id ?? failureSnapshot?.uploadSession.siteId ?? null,
      totalBytes: failureSnapshot ? totalBytes(failureSnapshot.manifest.files) : undefined,
      uploadSessionId: failureSnapshot?.uploadSession.id,
    });
    await persistFinalizeFailure({
      code,
      context,
      durationMs,
      phase,
      repository,
      requestId,
      snapshot: failureSnapshot,
    });
    if (pendingBarrierSite) {
      await repairCurrentActiveSiteEdgeManifest({
        context,
        repository,
        requestId,
        site: pendingBarrierSite,
        knowledgeHook,
        storage,
      });
    }
    if (preparedFinalize?.artifactVersion.id) {
      await markArtifactVersionFailed({
        artifactVersionId: preparedFinalize.artifactVersion.id,
        code,
        repository,
        requestId,
      });
    }
    if (error instanceof ConsoleApiError) throw error;
    throw publishError(502, code);
  }
}

export async function createPageSiteRelease({
  context,
  input,
  passwordRepository = pagesPasswordAccessRepositoryForDb(),
  repository = pagePublishRepositoryForDb(),
  requestId,
  knowledgeHook = scheduleKnowledgePageCapture,
  storage = createPageObjectStorageFromEnv(),
}: {
  context: PagePublishContext;
  input: CreatePageSiteReleaseInput;
  requestId: string;
} & PublishServices): Promise<PageSiteReleaseResult> {
  assertCanPublish(context);
  if (input.activate !== false) {
    await assertNoUnreadPageCommentsForReleaseInput({
      context,
      input,
      repository,
    });
  }
  const plannedReleaseId = input.activate === false ? null : randomUUID();
  let pendingBarrierSite: PageSiteRecord | null = null;
  try {
    if (plannedReleaseId) {
      pendingBarrierSite = await writePendingSiteEdgeManifestForPlannedRelease({
        context,
        plannedReleaseId,
        projectRef: input.projectRef,
        repository,
        requestId,
        siteRef: input.siteRef,
        knowledgeHook,
        storage,
      });
    }
    const result = await repository.withTransaction((tx) =>
      createReleaseForRoutes({
        context,
        input,
        passwordRepository,
        repository: tx,
        requestId,
        publish: null,
        plannedReleaseId,
      }),
    );
    if (result.release.status === "active") {
      await writeActiveSiteEdgeManifest({
        context,
        release: result.release,
        repository,
        requestId,
        routes: result.routes,
        site: result.site,
        knowledgeHook,
        storage,
      });
    }
    return result;
  } catch (error) {
    if (pendingBarrierSite) {
      await repairCurrentActiveSiteEdgeManifest({
        context,
        repository,
        requestId,
        site: pendingBarrierSite,
        knowledgeHook,
        storage,
      });
    }
    throw error;
  }
}

export async function activatePageSiteRelease({
  context,
  input,
  passwordRepository = pagesPasswordAccessRepositoryForDb(),
  repository = pagePublishRepositoryForDb(),
  requestId,
  knowledgeHook = scheduleKnowledgePageCapture,
  storage = createPageObjectStorageFromEnv(),
}: {
  context: PagePublishContext;
  input: {
    siteRef: string;
    releaseId: string;
  };
  requestId: string;
} & PublishServices): Promise<PageSiteReleaseResult> {
  assertCanPublish(context);
  let pendingBarrierSite: PageSiteRecord | null = null;

  try {
    await assertNoUnreadPageCommentsForExistingRelease({
      context,
      input,
      repository,
    });
    pendingBarrierSite = await writePendingSiteEdgeManifestForExistingRelease({
      context,
      input,
      repository,
      requestId,
      knowledgeHook,
      storage,
    });
    const result = await repository.withTransaction(async (tx) => {
      const site = await tx.findSiteByRef(context.organizationId, input.siteRef);
      if (!site) throw publishError(404, "publish_site_unavailable");
      await assertProjectAccess(context, tx, site.projectId, "write");
      await tx.lockSiteReleaseSequence(site.id);
      const release = await tx.getRelease({
        organizationId: context.organizationId,
        siteId: site.id,
        releaseId: input.releaseId,
      });
      if (!release) throw publishError(404, "publish_site_unavailable");
      if (release.status === "failed") throw publishError(409, "publish_validation_failed");

      const routes = await tx.listReleaseRoutes(release.id);
      if (routes.length === 0) throw publishError(409, "publish_validation_failed");
      await assertReleaseOriginGrants({ repository: tx, routes, site });
      await assertRequiredPasswordPolicies({
        passwordRepository,
        routes,
        site,
      });

      const now = new Date();
      const previousReleaseId = site.activeReleaseId;
      const activeReleaseChanged = previousReleaseId !== release.id;
      await tx.activateRelease({
        siteId: site.id,
        releaseId: release.id,
        now,
      });
      await tx.insertAudit({
        organizationId: context.organizationId,
        projectId: site.projectId,
        actorType: context.actorType,
        actorId: context.actorId,
        targetType: "page_site_release",
        targetId: release.id,
        action: "page_site_release.activated",
        requestId,
        metadataJson: {
          siteId: site.id,
          previousReleaseId,
          activeReleaseChanged,
        },
      });

      if (activeReleaseChanged) {
        const primaryRoute = routes[0] ?? null;
        await tx.createUsageEvent(buildPagesReleaseActivatedUsageEvent({
          organizationId: context.organizationId,
          projectId: site.projectId,
          siteId: site.id,
          releaseId: release.id,
          routeId: primaryRoute?.routeId ?? null,
          artifactId: primaryRoute?.artifactId ?? null,
          artifactVersionId: primaryRoute?.artifactVersionId ?? null,
          publishId: null,
          releaseNumber: release.releaseNumber,
          requestId,
          routeCount: routes.length,
          visibility: releaseStatusVisibility(routes, site.defaultVisibility),
        }));
      }

      const activatedSite: PageSiteRecord = {
        ...site,
        activeReleaseId: release.id,
        updatedAt: now,
      };
      const activatedRelease: PageSiteReleaseRecord = {
        ...release,
        status: "active",
        activatedAt: now,
      };
      return {
        publish: null,
        site: activatedSite,
        release: activatedRelease,
        routes,
        url: publishedRouteUrl(activatedSite, routes[0]?.path ?? "/"),
      };
    });
    await writeActiveSiteEdgeManifest({
      context,
      release: result.release,
      repository,
      requestId,
      routes: result.routes,
      site: result.site,
      knowledgeHook,
      storage,
    });
    return result;
  } catch (error) {
    if (pendingBarrierSite) {
      await repairCurrentActiveSiteEdgeManifest({
        context,
        repository,
        requestId,
        site: pendingBarrierSite,
        knowledgeHook,
        storage,
      });
    }
    throw error;
  }
}

export type PageSiteReleaseRef = {
  id: string;
  releaseNumber: number;
  status: PageSiteReleaseRecord["status"];
  reason: string | null;
  createdAt: Date;
  activatedAt: Date | null;
};

export type PageSiteReleaseComparison = {
  siteId: string;
  activeReleaseId: string | null;
  base: PageSiteReleaseRef | null;
  target: PageSiteReleaseRef;
  summary: ReleaseDiffSummary;
  routes: ReleaseDiffRoute[];
};

export type PageSiteReleaseFileDiff = {
  path: string;
  file: string;
  status: "added" | "removed" | "changed" | "unchanged";
  diff: TextDiffResult | { kind: "binary" } | { kind: "unavailable" };
};

/**
 * Compares two releases of one site: routes added/removed/changed and, per route,
 * files added/removed/changed by sha256. Without baseReleaseId it compares with the
 * release this one was created from. Read-only; needs project read access.
 */
export async function comparePageSiteReleases({
  context,
  input,
  repository = pagePublishRepositoryForDb(),
}: {
  context: PagePublishContext;
  input: { siteRef: string; releaseId: string; baseReleaseId?: string | null };
  repository?: PagePublishRepository;
}): Promise<PageSiteReleaseComparison> {
  const pair = await loadReleasePairForDiff({ context, input, repository });
  const filesByVersion = await loadReleaseVersionFiles(repository, [...pair.baseRoutes, ...pair.targetRoutes]);
  const { routes, summary } = diffReleaseRoutes({
    baseRoutes: pair.baseRoutes.map((route) => releaseDiffRouteInput(route, filesByVersion)),
    targetRoutes: pair.targetRoutes.map((route) => releaseDiffRouteInput(route, filesByVersion)),
    filesForVersion: (artifactVersionId) =>
      (filesByVersion.get(artifactVersionId) ?? []).map(releaseDiffFileInput),
  });
  return {
    siteId: pair.site.id,
    activeReleaseId: pair.site.activeReleaseId,
    base: pair.base ? releaseRef(pair.base) : null,
    target: releaseRef(pair.target),
    summary,
    routes,
  };
}

/** Line diff of one file of one route between two releases, for text files up to 512 KB. */
export async function getPageSiteReleaseFileDiff({
  context,
  input,
  repository = pagePublishRepositoryForDb(),
  storage = createPageObjectStorageFromEnv(),
}: {
  context: PagePublishContext;
  input: {
    siteRef: string;
    releaseId: string;
    baseReleaseId?: string | null;
    routePath: string;
    matchType?: string | null;
    file: string;
  };
  repository?: PagePublishRepository;
  storage?: PageObjectStorage;
}): Promise<PageSiteReleaseFileDiff> {
  const pair = await loadReleasePairForDiff({ context, input, repository });
  const pickRoute = (routes: PageReleaseRouteRecord[]) =>
    routes.find(
      (route) => route.path === input.routePath && (!input.matchType || route.matchType === input.matchType),
    ) ?? null;
  const targetRoute = pickRoute(pair.targetRoutes);
  const matchType = input.matchType ?? targetRoute?.matchType ?? null;
  const baseRoute = matchType
    ? pair.baseRoutes.find((route) => releaseRouteKey(route) === releaseRouteKey({ path: input.routePath, matchType })) ?? null
    : pickRoute(pair.baseRoutes);
  if (!targetRoute && !baseRoute) throw publishError(404, "publish_site_unavailable");

  const filesByVersion = await loadReleaseVersionFiles(
    repository,
    [baseRoute, targetRoute].filter((route): route is PageReleaseRouteRecord => route !== null),
  );
  const findFile = (route: PageReleaseRouteRecord | null) =>
    route ? (filesByVersion.get(route.artifactVersionId) ?? []).find((file) => file.path === input.file) ?? null : null;
  const baseFile = findFile(baseRoute);
  const targetFile = findFile(targetRoute);
  if (!baseFile && !targetFile) throw publishError(404, "publish_site_unavailable");

  const status =
    !baseFile ? "added" : !targetFile ? "removed" : baseFile.sha256 && baseFile.sha256 === targetFile.sha256 ? "unchanged" : "changed";
  const result = { path: input.routePath, file: input.file, status } as const;
  const sides = [
    { route: baseRoute, file: baseFile },
    { route: targetRoute, file: targetFile },
  ];
  if (sides.some((side) => side.file && !isTextDiffable(releaseDiffFileInput(side.file)))) {
    return { ...result, diff: { kind: "binary" } };
  }
  if (!storage.readObjectText) return { ...result, diff: { kind: "unavailable" } };

  const texts: string[] = [];
  for (const side of sides) {
    if (!side.route || !side.file) {
      texts.push("");
      continue;
    }
    const key = readR2Key(side.file.storageJson) ?? expectedFinalObjectKey(pair.site, side.route, side.file.path);
    const text = await storage.readObjectText({ key, maxBytes: RELEASE_TEXT_DIFF_MAX_BYTES });
    if (text === null) return { ...result, diff: { kind: "unavailable" } };
    texts.push(text);
  }
  return { ...result, diff: diffTextLines(texts[0] ?? "", texts[1] ?? "") };
}

async function loadReleasePairForDiff({
  context,
  input,
  repository,
}: {
  context: PagePublishContext;
  input: { siteRef: string; releaseId: string; baseReleaseId?: string | null };
  repository: PagePublishRepository;
}) {
  const site = await repository.findSiteByRef(context.organizationId, input.siteRef);
  if (!site) throw publishError(404, "publish_site_unavailable");
  await assertProjectAccess(context, repository, site.projectId, "read");
  const target = await repository.getRelease({
    organizationId: context.organizationId,
    siteId: site.id,
    releaseId: input.releaseId,
  });
  if (!target) throw publishError(404, "publish_site_unavailable");
  const baseReleaseId = input.baseReleaseId === undefined ? target.previousReleaseId : input.baseReleaseId;
  const base = baseReleaseId
    ? await repository.getRelease({ organizationId: context.organizationId, siteId: site.id, releaseId: baseReleaseId })
    : null;
  if (baseReleaseId && !base && input.baseReleaseId) throw publishError(404, "publish_site_unavailable");
  const [targetRoutes, baseRoutes] = await Promise.all([
    repository.listReleaseRoutes(target.id),
    base ? repository.listReleaseRoutes(base.id) : Promise.resolve([] as PageReleaseRouteRecord[]),
  ]);
  return { site, target, base, targetRoutes, baseRoutes };
}

async function loadReleaseVersionFiles(repository: PagePublishRepository, routes: PageReleaseRouteRecord[]) {
  const filesByVersion = new Map<string, ArtifactVersionFileRecord[]>();
  for (const route of routes) {
    if (filesByVersion.has(route.artifactVersionId)) continue;
    filesByVersion.set(
      route.artifactVersionId,
      await repository.listArtifactVersionFiles({
        artifactId: route.artifactId,
        artifactVersionId: route.artifactVersionId,
      }),
    );
  }
  return filesByVersion;
}

function releaseDiffRouteInput(route: PageReleaseRouteRecord, filesByVersion: Map<string, ArtifactVersionFileRecord[]>) {
  return {
    path: route.path,
    matchType: route.matchType,
    priority: route.priority,
    artifactId: route.artifactId,
    artifactVersionId: route.artifactVersionId,
    artifactVersionNumber: filesByVersion.get(route.artifactVersionId)?.[0]?.versionNumber ?? null,
    entrypoint: route.entrypoint,
    visibility: route.visibility,
  };
}

function releaseDiffFileInput(file: ArtifactVersionFileRecord): ReleaseDiffFileInput {
  return {
    path: file.path,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    mimeType: file.mimeType,
  };
}

function releaseRef(release: PageSiteReleaseRecord): PageSiteReleaseRef {
  return {
    id: release.id,
    releaseNumber: release.releaseNumber,
    status: release.status,
    reason: release.reason,
    createdAt: release.createdAt,
    activatedAt: release.activatedAt,
  };
}

export async function repairActiveSiteEdgeManifest({
  organizationId,
  reason,
  repository = pagePublishRepositoryForDb(),
  requestId,
  siteRef,
  host,
  knowledgeHook = scheduleKnowledgePageCapture,
  storage = createPageObjectStorageFromEnv(),
}: {
  organizationId: string;
  reason: EdgeManifestRepairReason;
  requestId: string;
  siteRef?: string | null;
  host?: string | null;
} & PublishServices): Promise<EdgeManifestRepairResult> {
  const site = siteRef
    ? await repository.findSiteByRef(organizationId, siteRef)
    : host
      ? await repository.findSiteByHost(organizationId, host)
      : null;

  if (!site || site.status !== "active") {
    return {
      status: "skipped",
      reason: "site_unavailable",
      siteId: site?.id ?? null,
    };
  }

  const cooldown = edgeManifestRepairCooldownSeconds();
  const cooldownReason = recentEdgeManifestFailureReason(site.metadataJson, cooldown);
  if (cooldownReason) {
    return {
      status: "skipped",
      reason: cooldownReason,
      releaseId: site.activeReleaseId,
      siteId: site.id,
    };
  }

  const context: PagePublishContext = {
    actorId: "pages-edge-repair",
    actorType: "system",
    membershipRole: "system",
    organizationId: site.organizationId,
  };
  const result = await repairCurrentActiveSiteEdgeManifest({
    context,
    repository,
    requestId,
    site,
    knowledgeHook,
    storage,
  });

  if (result.status !== "skipped") {
    await repository.insertAudit({
      organizationId: site.organizationId,
      projectId: site.projectId,
      actorType: "system",
      actorId: "pages-edge-repair",
      targetType: "page_site",
      targetId: site.id,
      action: "page_site.edge_manifest_repair",
      requestId,
      metadataJson: {
        reason,
        resultStatus: result.status,
        resultReason: "reason" in result ? result.reason : null,
        releaseId: result.releaseId ?? site.activeReleaseId,
      },
    });
  }

  return result;
}

export async function getPagePublish({
  context,
  publishId,
  repository = pagePublishRepositoryForDb(),
}: {
  context: PagePublishContext;
  publishId: string;
  repository?: PagePublishRepository;
}) {
  const publish = await repository.findPublish(publishId);
  if (!publish || publish.organizationId !== context.organizationId) {
    throw publishError(404, "publish_upload_missing");
  }
  await assertProjectAccess(context, repository, publish.projectId, "read");
  return publish;
}

async function createReleaseForRoutes({
  context,
  input,
  passwordRepository,
  repository,
  requestId,
  publish,
  plannedReleaseId,
}: {
  context: PagePublishContext;
  input: CreatePageSiteReleaseInput;
  passwordRepository: PagesPasswordAccessRepository;
  repository: PagePublishRepository;
  requestId: string;
  publish: PagePublishRecord | null;
  plannedReleaseId?: string | null;
}): Promise<PageSiteReleaseResult> {
  const project = await repository.findProjectByRef(context.organizationId, input.projectRef);
  if (!project) throw publishError(404, "publish_forbidden");
  await assertProjectAccess(context, repository, project.id, "write");
  const site = await requireSite(repository, context.organizationId, project.id, input.siteRef);

  // Read active routes under the same lock that serializes release activation.
  await repository.lockSiteReleaseSequence(site.id);

  const normalized = await normalizeReleaseRoutes({
    context,
    input,
    project,
    repository,
    site,
  });
  const activeRelease = await repository.getActiveRelease(site.id);
  const activeRoutes = activeRelease && !input.replaceRelease ? await repository.listReleaseRoutes(activeRelease.id) : [];
  const mergedRoutes = mergeReleaseRoutes(activeRoutes, normalized);
  await assertReleaseOriginGrants({ repository, routes: mergedRoutes, site });

  await assertRequiredPasswordPolicies({
    passwordRepository,
    routes: mergedRoutes,
    site,
  });

  const routeConflicts = findPageRouteConflicts(
    mergedRoutes.map((route) => ({
      id: route.routeId,
      path: route.path,
      matchType: route.matchType,
      priority: route.priority,
    })),
  );
  if (routeConflicts.length > 0) throw publishError(409, "publish_route_conflict");

  const manifestHash = stableHash(
    mergedRoutes.map((route) => ({
      path: route.path,
      matchType: route.matchType,
      priority: route.priority,
      artifactVersionId: route.artifactVersionId,
      entrypoint: route.entrypoint,
      assetBase: route.assetBase,
      visibility: route.visibility,
      ...browserPermissionsProjection(route.routeConfigJson),
    })),
  );
  const activate = input.activate !== false;
  const now = new Date();
  const release = await repository.createRelease({
    ...(plannedReleaseId ? { id: plannedReleaseId } : {}),
    organizationId: context.organizationId,
    projectId: project.id,
    siteId: site.id,
    releaseNumber: await repository.nextReleaseNumber(site.id),
    previousReleaseId: activeRelease?.id ?? null,
    status: activate ? "active" : "draft",
    reason: input.reason ?? (publish ? "publish" : "manual_release"),
    manifestHash,
    createdByActorType: context.actorType,
    createdByActorId: context.actorId,
    activatedAt: activate ? now : null,
  });

  const createdRoutes: PageReleaseRouteRecord[] = [];
  for (const route of mergedRoutes) {
    createdRoutes.push(
      await repository.createReleaseRoute({
        ...route,
        organizationId: context.organizationId,
        projectId: project.id,
        siteId: site.id,
        releaseId: release.id,
      }),
    );
  }

  if (activate) {
    await repository.activateRelease({ siteId: site.id, releaseId: release.id, now });
  }

  await repository.insertAudit({
    organizationId: context.organizationId,
    projectId: project.id,
    actorType: context.actorType,
    actorId: context.actorId,
    targetType: "page_site_release",
    targetId: release.id,
    action: activate ? "page_site_release.activated" : "page_site_release.created",
    requestId,
    metadataJson: {
      siteId: site.id,
      previousReleaseId: activeRelease?.id ?? null,
      routeCount: createdRoutes.length,
      manifestHash,
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });

  if (activate) {
    const primaryRoute = createdRoutes[0] ?? null;
    await repository.createUsageEvent(buildPagesReleaseActivatedUsageEvent({
      organizationId: context.organizationId,
      projectId: project.id,
      siteId: site.id,
      releaseId: release.id,
      routeId: primaryRoute?.routeId ?? null,
      artifactId: primaryRoute?.artifactId ?? publish?.artifactId ?? null,
      artifactVersionId: primaryRoute?.artifactVersionId ?? publish?.artifactVersionId ?? null,
      publishId: publish?.id ?? null,
      releaseNumber: release.releaseNumber,
      requestId,
      routeCount: createdRoutes.length,
      visibility: releaseStatusVisibility(createdRoutes, site.defaultVisibility),
    }));
  }

  return {
    publish,
    site: activate ? { ...site, activeReleaseId: release.id, updatedAt: now } : site,
    release,
    routes: createdRoutes,
    url: publishedRouteUrl(site, createdRoutes[0]?.path ?? "/"),
  };
}

async function assertReleaseOriginGrants(input: {
  repository: PagePublishRepository;
  routes: Array<Pick<PageReleaseRouteRecord, "artifactVersionId">>;
  site: PageSiteRecord;
}) {
  if (!isolatedPagesOriginsRequired()) return;
  const metadata: unknown[] = [];
  for (const id of new Set(input.routes.map((route) => route.artifactVersionId))) {
    const version = await input.repository.findArtifactVersion({
      organizationId: input.site.organizationId,
      projectId: input.site.projectId,
      artifactVersionId: id,
    });
    metadata.push(version?.artifactVersion.metadataJson ?? null);
  }
  connectorUsesForOrigin(metadata, { error: "publish_origin_grants_conflict", status: 409 });
}

async function assertRequiredPasswordPolicies(input: {
  passwordRepository: PagesPasswordAccessRepository;
  routes: Array<Pick<PageReleaseRouteRecord, "routeId" | "visibility">>;
  site: PageSiteRecord;
}) {
  for (const route of input.routes) {
    const requiresPassword =
      route.visibility === "password" ||
      (route.visibility === "public" && input.site.defaultVisibility === "password");
    if (!requiresPassword) continue;
    const policy = await findRequiredPagesPasswordPolicy({
      repository: input.passwordRepository,
      routeId: route.routeId,
      routeVisibility: route.visibility,
      siteId: input.site.id,
      siteVisibility: input.site.defaultVisibility,
    });
    if (!policy) throw new ConsoleApiError(409, { error: "password_policy_required" });
  }
}

async function writePendingSiteEdgeManifestForPlannedRelease({
  context,
  plannedReleaseId,
  projectRef,
  repository,
  requestId,
  siteRef,
  knowledgeHook,
  storage,
}: {
  context: PagePublishContext;
  plannedReleaseId: string;
  projectRef: string;
  repository: PagePublishRepository;
  requestId: string;
  siteRef: string;
  knowledgeHook: PageKnowledgeHook;
  storage: PageObjectStorage;
}) {
  const project = await repository.findProjectByRef(context.organizationId, projectRef);
  if (!project) throw publishError(404, "publish_forbidden");
  await assertProjectAccess(context, repository, project.id, "write");
  const site = await requireSite(repository, context.organizationId, project.id, siteRef);
  try {
    await writePendingSiteEdgeManifest({
      context,
      release: plannedPendingReleaseRecord({
        context,
        id: plannedReleaseId,
        project,
        site,
      }),
      repository,
      requestId,
      site,
      storage,
    });
  } catch (error) {
    await repairCurrentActiveSiteEdgeManifest({
      context,
      repository,
      requestId,
      site,
      knowledgeHook,
      storage,
    });
    throw error;
  }
  return site;
}

async function writePendingSiteEdgeManifestForExistingRelease({
  context,
  input,
  repository,
  requestId,
  knowledgeHook,
  storage,
}: {
  context: PagePublishContext;
  input: {
    siteRef: string;
    releaseId: string;
  };
  repository: PagePublishRepository;
  requestId: string;
  knowledgeHook: PageKnowledgeHook;
  storage: PageObjectStorage;
}) {
  const site = await repository.findSiteByRef(context.organizationId, input.siteRef);
  if (!site || site.status !== "active") throw publishError(404, "publish_site_unavailable");
  await assertProjectAccess(context, repository, site.projectId, "write");
  const release = await repository.getRelease({
    organizationId: context.organizationId,
    siteId: site.id,
    releaseId: input.releaseId,
  });
  if (!release) throw publishError(404, "publish_site_unavailable");
  if (release.status === "failed") throw publishError(409, "publish_validation_failed");
  const routes = await repository.listReleaseRoutes(release.id);
  if (routes.length === 0) throw publishError(409, "publish_validation_failed");

  try {
    await writePendingSiteEdgeManifest({
      context,
      release,
      repository,
      requestId,
      site,
      storage,
    });
  } catch (error) {
    await repairCurrentActiveSiteEdgeManifest({
      context,
      repository,
      requestId,
      site,
      knowledgeHook,
      storage,
    });
    throw error;
  }
  return site;
}

function plannedPendingReleaseRecord({
  context,
  id,
  project,
  site,
}: {
  context: PagePublishContext;
  id: string;
  project: ProjectRecord;
  site: PageSiteRecord;
}): PageSiteReleaseRecord {
  return {
    id,
    organizationId: context.organizationId,
    projectId: project.id,
    siteId: site.id,
    releaseNumber: 0,
    previousReleaseId: site.activeReleaseId,
    status: "draft",
    reason: "pending_activation",
    manifestHash: null,
    createdByActorType: context.actorType,
    createdByActorId: context.actorId,
    activatedAt: null,
    createdAt: new Date(),
  };
}

async function writeActiveSiteEdgeManifest({
  context,
  release,
  repository,
  requestId,
  routes,
  site,
  knowledgeHook,
  storage,
}: {
  context: PagePublishContext;
  release: PageSiteReleaseRecord;
  repository: PagePublishRepository;
  requestId: string;
  routes: PageReleaseRouteRecord[];
  site: PageSiteRecord;
  knowledgeHook: PageKnowledgeHook;
  storage: PageObjectStorage;
}): Promise<EdgeManifestRepairResult> {
  let written: { r2Key: string };
  try {
    const activeBeforeWrite = await repository.getActiveRelease(site.id);
    if (!activeBeforeWrite || activeBeforeWrite.id !== release.id) {
      return {
        status: "skipped",
        reason: "active_release_changed_before_write",
        releaseId: release.id,
        siteId: site.id,
      };
    }

    const manifest = await buildSiteEdgeManifest({
      release,
      repository,
      routes,
      site,
    });
    written = await storage.writeSiteManifest({
      hostname: site.defaultHostname,
      manifest,
    });
    const activeAfterWrite = await repository.getActiveRelease(site.id);
    if (!activeAfterWrite || activeAfterWrite.id !== release.id) {
      await writeSupersededSiteEdgeManifestBarrier({
        activeRelease: activeAfterWrite,
        context,
        repository,
        requestId,
        site,
        storage,
      });
      return {
        status: "skipped",
        reason: "active_release_changed_after_write",
        releaseId: release.id,
        siteId: site.id,
      };
    }
  } catch (error) {
    console.error("Ravi Pages active edge manifest write failed", {
      requestId,
      siteId: site.id,
      releaseId: release.id,
      internalError: safeErrorDetails(error),
    });
    await capturePagesPublishDiagnostic({
      code: publicPublishErrorCode(error),
      context,
      error,
      phase: "active_edge_manifest",
      projectId: site.projectId,
      releaseId: release.id,
      requestId,
      routeCount: routes.length,
      siteId: site.id,
    });
    try {
      const now = new Date();
      const errorCode = publicPublishErrorCode(error);
      await repository.updateSiteEdgeManifestState({
        siteId: site.id,
        now,
        edgeManifest: edgeManifestState({
          status: "failed",
          hostname: site.defaultHostname,
          release,
          manifestKey: activeSiteManifestObjectKey(site.defaultHostname),
          manifestHash: release.manifestHash,
          requestId,
          routeCount: routes.length,
          updatedAt: now,
          errorCode,
        }),
      });
      await repository.insertAudit({
        organizationId: context.organizationId,
        projectId: site.projectId,
        actorType: context.actorType,
        actorId: context.actorId,
        targetType: "page_site",
        targetId: site.id,
        action: "page_site.edge_manifest_failed",
        requestId,
        metadataJson: {
          hostname: site.defaultHostname,
          releaseId: release.id,
          releaseNumber: release.releaseNumber,
          manifestKey: activeSiteManifestObjectKey(site.defaultHostname),
          manifestHash: release.manifestHash,
          errorCode,
        },
      });
    } catch (stateError) {
      console.error("Ravi Pages active edge manifest failure state persist failed", {
        requestId,
        siteId: site.id,
        releaseId: release.id,
        internalError: safeErrorDetails(stateError),
      });
    }
    return {
      status: "failed",
      reason: publicPublishErrorCode(error),
      releaseId: release.id,
      siteId: site.id,
    };
  }

  try {
    const now = new Date();
    await repository.updateSiteEdgeManifestState({
      siteId: site.id,
      now,
      edgeManifest: edgeManifestState({
        status: "ready",
        hostname: site.defaultHostname,
        release,
        manifestKey: written.r2Key,
        manifestHash: release.manifestHash,
        requestId,
        routeCount: routes.length,
        updatedAt: now,
      }),
    });
    await repository.insertAudit({
      organizationId: context.organizationId,
      projectId: site.projectId,
      actorType: context.actorType,
      actorId: context.actorId,
      targetType: "page_site",
      targetId: site.id,
      action: "page_site.edge_manifest_written",
      requestId,
      metadataJson: {
        hostname: site.defaultHostname,
        releaseId: release.id,
        releaseNumber: release.releaseNumber,
        routeCount: routes.length,
        manifestKey: written.r2Key,
        manifestHash: release.manifestHash,
      },
    });
  } catch (error) {
    console.error("Ravi Pages active edge manifest ready state persist failed", {
      requestId,
      siteId: site.id,
      releaseId: release.id,
      manifestKey: written.r2Key,
      internalError: safeErrorDetails(error),
    });
  }
  // The single choke point after create, finalize, activate and repairs: Knowledge reads the live release.
  try {
    knowledgeHook({ siteId: site.id, releaseId: release.id, requestId });
  } catch (error) {
    console.error("Ravi Pages knowledge capture hook failed", {
      requestId,
      siteId: site.id,
      releaseId: release.id,
      internalError: safeErrorDetails(error),
    });
  }
  return {
    status: "repaired",
    manifestKey: written.r2Key,
    releaseId: release.id,
    siteId: site.id,
  };
}

async function writeSupersededSiteEdgeManifestBarrier({
  activeRelease,
  context,
  repository,
  requestId,
  site,
  storage,
}: {
  activeRelease: PageSiteReleaseRecord | null;
  context: PagePublishContext;
  repository: PagePublishRepository;
  requestId: string;
  site: PageSiteRecord;
  storage: PageObjectStorage;
}) {
  if (!activeRelease) return;
  try {
    await writePendingSiteEdgeManifest({
      context,
      release: activeRelease,
      repository,
      requestId,
      site: {
        ...site,
        activeReleaseId: activeRelease.id,
      },
      storage,
    });
  } catch (error) {
    console.error("Ravi Pages superseded edge manifest barrier write failed", {
      requestId,
      siteId: site.id,
      releaseId: activeRelease.id,
      internalError: safeErrorDetails(error),
    });
  }
}

async function repairCurrentActiveSiteEdgeManifest({
  context,
  repository,
  requestId,
  site,
  knowledgeHook,
  storage,
}: {
  context: PagePublishContext;
  repository: PagePublishRepository;
  requestId: string;
  site: PageSiteRecord;
  knowledgeHook: PageKnowledgeHook;
  storage: PageObjectStorage;
}): Promise<EdgeManifestRepairResult> {
  try {
    const activeRelease = await repository.getActiveRelease(site.id);
    if (!activeRelease) {
      return {
        status: "skipped",
        reason: "no_active_release",
        siteId: site.id,
      };
    }

    const routes = await repository.listReleaseRoutes(activeRelease.id);
    if (routes.length === 0) {
      return {
        status: "skipped",
        reason: "no_release_routes",
        releaseId: activeRelease.id,
        siteId: site.id,
      };
    }

    return await writeActiveSiteEdgeManifest({
      context,
      release: activeRelease,
      repository,
      requestId,
      routes,
      site: {
        ...site,
        activeReleaseId: activeRelease.id,
      },
      knowledgeHook,
      storage,
    });
  } catch (error) {
    console.error("Ravi Pages active edge manifest repair failed", {
      requestId,
      siteId: site.id,
      internalError: safeErrorDetails(error),
    });
    return {
      status: "failed",
      reason: publicPublishErrorCode(error),
      siteId: site.id,
    };
  }
}

async function writePendingSiteEdgeManifest({
  context,
  release,
  repository,
  requestId,
  site,
  storage,
}: {
  context: PagePublishContext;
  release: PageSiteReleaseRecord;
  repository: PagePublishRepository;
  requestId: string;
  site: PageSiteRecord;
  storage: PageObjectStorage;
}) {
  const pendingManifest = buildPendingSiteEdgeManifest({ release, site });
  let written: { r2Key: string };
  try {
    written = await storage.writeSiteManifest({
      hostname: site.defaultHostname,
      manifest: pendingManifest,
    });
  } catch (error) {
    console.error("Ravi Pages pending edge manifest write failed", {
      requestId,
      siteId: site.id,
      releaseId: release.id,
      internalError: safeErrorDetails(error),
    });
    await capturePagesPublishDiagnostic({
      code: publicPublishErrorCode(error),
      context,
      error,
      phase: "pending_edge_manifest",
      projectId: site.projectId,
      releaseId: release.id,
      requestId,
      siteId: site.id,
    });
    throw publishError(503, "publish_storage_failed");
  }
  const now = new Date();
  await repository.updateSiteEdgeManifestState({
    siteId: site.id,
    now,
    edgeManifest: edgeManifestState({
      status: "pending",
      hostname: site.defaultHostname,
      release,
      manifestKey: written.r2Key,
      manifestHash: release.manifestHash,
      requestId,
      routeCount: 0,
      updatedAt: now,
    }),
  });
  await repository.insertAudit({
    organizationId: context.organizationId,
    projectId: site.projectId,
    actorType: context.actorType,
    actorId: context.actorId,
    targetType: "page_site",
    targetId: site.id,
    action: "page_site.edge_manifest_pending",
    requestId,
    metadataJson: {
      hostname: site.defaultHostname,
      releaseId: release.id,
      releaseNumber: release.releaseNumber,
      edgeState: "pending",
      routeCount: 0,
      manifestKey: written.r2Key,
      manifestHash: release.manifestHash,
    },
  });
}

function buildPendingSiteEdgeManifest({ release, site }: { release: PageSiteReleaseRecord; site: PageSiteRecord }) {
  return {
    schemaVersion: 1,
    edgeState: "pending",
    generatedAt: new Date().toISOString(),
    site: {
      id: site.id,
      organizationId: site.organizationId,
      projectId: site.projectId,
      defaultHostname: site.defaultHostname,
      defaultVisibility: site.defaultVisibility,
      status: site.status,
      activeReleaseId: release.id,
    },
    release: {
      id: release.id,
      number: release.releaseNumber,
      manifestHash: release.manifestHash,
      status: "pending",
      activatedAt: null,
    },
    routes: [],
  };
}

function edgeManifestState(input: {
  errorCode?: string;
  hostname: string;
  manifestHash: string | null;
  manifestKey: string;
  release: PageSiteReleaseRecord;
  requestId: string;
  routeCount: number;
  status: EdgeManifestStatus;
  updatedAt: Date;
}) {
  return {
    status: input.status,
    hostname: input.hostname,
    releaseId: input.release.id,
    releaseNumber: input.release.releaseNumber,
    manifestKey: input.manifestKey,
    manifestHash: input.manifestHash,
    routeCount: input.routeCount,
    requestId: input.requestId,
    updatedAt: input.updatedAt.toISOString(),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };
}

async function buildSiteEdgeManifest({
  release,
  repository,
  routes,
  site,
}: {
  release: PageSiteReleaseRecord;
  repository: PagePublishRepository;
  routes: PageReleaseRouteRecord[];
  site: PageSiteRecord;
}) {
  const manifestRoutes = [];
  const manifestArtifacts = new Map<string, Record<string, unknown>>();
  const filesByArtifactVersion = new Map<string, ArtifactVersionFileRecord[]>();

  for (const route of routes) {
    const artifactVersionKey = edgeArtifactVersionKey(route.artifactId, route.artifactVersionId);
    let files = filesByArtifactVersion.get(artifactVersionKey);
    if (!files) {
      files = await repository.listArtifactVersionFiles({
        artifactId: route.artifactId,
        artifactVersionId: route.artifactVersionId,
      });
      if (files.length === 0) throw publishError(409, "publish_validation_failed");
      filesByArtifactVersion.set(artifactVersionKey, files);
    }

    if (!manifestArtifacts.has(artifactVersionKey)) {
      const manifestFiles = files.map((file) => edgeManifestFileRecord(site, route, file));

      manifestArtifacts.set(artifactVersionKey, {
        id: route.artifactId,
        versionId: route.artifactVersionId,
        versionNumber: files[0]?.versionNumber ?? null,
        files: manifestFiles,
      });
    }

    manifestRoutes.push({
      id: route.routeId,
      bindingId: route.id,
      path: route.path,
      matchType: route.matchType,
      priority: route.priority,
      visibility: route.visibility,
      ...browserPermissionsProjection(route.routeConfigJson),
      artifact: {
        id: route.artifactId,
        versionId: route.artifactVersionId,
        versionNumber: files[0]?.versionNumber ?? null,
        entrypoint: route.entrypoint,
        assetBase: route.assetBase,
      },
    });
  }

  return {
    schemaVersion: 1,
    edgeState: "ready",
    generatedAt: new Date().toISOString(),
    site: {
      id: site.id,
      organizationId: site.organizationId,
      projectId: site.projectId,
      defaultHostname: site.defaultHostname,
      defaultVisibility: site.defaultVisibility,
      status: site.status,
      activeReleaseId: release.id,
    },
    release: {
      id: release.id,
      number: release.releaseNumber,
      manifestHash: release.manifestHash,
      status: release.status,
      activatedAt: release.activatedAt?.toISOString() ?? null,
    },
    artifacts: [...manifestArtifacts.values()],
    routes: manifestRoutes,
  };
}

function edgeArtifactVersionKey(artifactId: string, artifactVersionId: string) {
  return `${artifactId}:${artifactVersionId}`;
}

function edgeManifestFileRecord(site: PageSiteRecord, route: PageReleaseRouteRecord, file: ArtifactVersionFileRecord) {
  if (file.artifactStatus !== "active" || file.versionStatus !== "ready") {
    throw publishError(409, "publish_validation_failed");
  }

  const expectedKey = expectedFinalObjectKey(site, route, file.path);
  const storedKey = readR2Key(file.storageJson);
  if (
    storedKey &&
    storedKey !== expectedKey &&
    !isFinalObjectKeyForArtifact({
      artifactId: route.artifactId,
      artifactVersionId: route.artifactVersionId,
      key: storedKey,
      path: file.path,
    })
  ) {
    throw publishError(409, "publish_validation_failed");
  }

  const cache = cacheHintForEdgeManifestFile(file);
  return {
    path: file.path,
    r2Key: storedKey ?? expectedKey,
    contentType: file.mimeType ?? contentTypeForPath(file.path),
    ...(cache ? { cache } : {}),
    etag: etagFor(file.sha256 ?? file.versionSha256),
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
  };
}

function expectedFinalObjectKey(site: PageSiteRecord, route: PageReleaseRouteRecord, objectPath: string) {
  return `org/${site.organizationId}/project/${site.projectId}/artifact/${route.artifactId}/version/${route.artifactVersionId}/${objectPath}`;
}

export function readR2Key(storageJson: Record<string, unknown>) {
  for (const key of ["r2Key", "objectKey", "key"]) {
    const value = storageJson[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function cacheHintForEdgeManifestFile(file: ArtifactVersionFileRecord) {
  const metadataCache = typeof file.metadataJson.cache === "string" ? file.metadataJson.cache : null;
  if (metadataCache === "entrypoint" || metadataCache === "html") return "entrypoint";
  if (metadataCache === "immutable" || metadataCache === "private" || metadataCache === "no-store") return metadataCache;
  return null;
}

function etagFor(sha256: string | null | undefined) {
  return sha256 ? `"sha256:${sha256}"` : null;
}

function edgeManifestRepairCooldownSeconds() {
  const configured = Number(process.env.RAVI_PAGES_EDGE_REPAIR_COOLDOWN_SECONDS ?? DEFAULT_EDGE_MANIFEST_REPAIR_COOLDOWN_SECONDS);
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_EDGE_MANIFEST_REPAIR_COOLDOWN_SECONDS;
  return Math.min(Math.floor(configured), MAX_EDGE_MANIFEST_REPAIR_COOLDOWN_SECONDS);
}

function recentEdgeManifestFailureReason(metadataJson: Record<string, unknown>, cooldownSeconds: number): string | null {
  if (cooldownSeconds <= 0) return null;
  const edgeManifest = metadataJson.edgeManifest;
  if (!edgeManifest || typeof edgeManifest !== "object" || Array.isArray(edgeManifest)) return null;
  const status = (edgeManifest as Record<string, unknown>).status;
  if (status !== "failed" && status !== "pending") return null;

  const updatedAt = (edgeManifest as Record<string, unknown>).updatedAt;
  if (typeof updatedAt !== "string") return null;
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) return null;
  return Date.now() - updatedAtMs < cooldownSeconds * 1000 ? `cooldown_${status}` : null;
}

function normalizeHostedPagesHost(host: string) {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (!normalized || normalized.includes("/") || normalized.includes("@")) return null;
  return normalized;
}

function hostedSlugFromPagesHost(host: string) {
  const domain = hostedPagesDomain();
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix) || host === domain) return null;
  const slug = host.slice(0, -suffix.length);
  return slug && !slug.includes(".") ? slug : null;
}

async function normalizeReleaseRoutes({
  context,
  input,
  project,
  repository,
  site,
}: {
  context: PagePublishContext;
  input: CreatePageSiteReleaseInput;
  project: ProjectRecord;
  repository: PagePublishRepository;
  site: PageSiteRecord;
}): Promise<CreateReleaseRouteInput[]> {
  if (!Array.isArray(input.routes) || input.routes.length === 0) {
    throw publishError(400, "publish_validation_failed");
  }

  const output: CreateReleaseRouteInput[] = [];
  for (const routeInput of input.routes) {
    const routeValidation = validatePageRouteDefinition({
      path: routeInput.path,
      matchType: routeInput.matchType ?? "spa",
      priority: routeInput.priority ?? 0,
    });
    if (!routeValidation.ok) throw publishError(400, "publish_validation_failed");

    const version = await repository.findArtifactVersion({
      organizationId: context.organizationId,
      projectId: project.id,
      artifactVersionId: routeInput.artifactVersionId,
    });
    if (!version) throw publishError(404, "publish_validation_failed");
    if (routeInput.artifactId && routeInput.artifactId !== version.artifact.id) {
      throw publishError(400, "publish_validation_failed");
    }
    const entrypoint = normalizeRouteEntrypoint(routeInput.entrypoint, version.artifactVersion);
    assertArtifactVersionReadyForPages(version, entrypoint);

    let route = await repository.findRoute({
      siteId: site.id,
      path: routeValidation.route.path,
      matchType: routeValidation.route.matchType,
    });
    if (!route) {
      route = await repository.createRoute({
        organizationId: context.organizationId,
        projectId: project.id,
        siteId: site.id,
        path: routeValidation.route.path,
        matchType: routeValidation.route.matchType,
        priority: routeValidation.route.priority,
        visibility: routeInput.visibility ?? site.defaultVisibility,
        defaultVisibility: routeInput.visibility ?? site.defaultVisibility,
        routeConfigJson: routeConfigJsonForInput(routeInput),
      });
    }

    output.push({
      organizationId: context.organizationId,
      projectId: project.id,
      siteId: site.id,
      releaseId: "",
      routeId: route.id,
      path: route.path,
      matchType: route.matchType,
      priority: routeInput.priority ?? route.priority,
      artifactId: version.artifact.id,
      artifactVersionId: version.artifactVersion.id,
      entrypoint,
      assetBase: routeInput.assetBase ?? assetBaseFor(version.artifact.id, version.artifactVersion.id),
      visibility: routeInput.visibility ?? route.visibility,
      routeConfigJson: routeConfigJsonForInput(routeInput),
    });
  }
  return output;
}

function mergeReleaseRoutes(
  current: PageReleaseRouteRecord[],
  replacements: CreateReleaseRouteInput[],
): CreateReleaseRouteInput[] {
  const replacementKeys = new Set(replacements.map((route) => routeIdentity(route)));
  const preserved = current
    .filter((route) => !replacementKeys.has(routeIdentity(route)))
    .map((route) => ({
      organizationId: route.organizationId,
      projectId: route.projectId,
      siteId: route.siteId,
      releaseId: "",
      routeId: route.routeId,
      path: route.path,
      matchType: route.matchType,
      priority: route.priority,
      artifactId: route.artifactId,
      artifactVersionId: route.artifactVersionId,
      entrypoint: route.entrypoint,
      assetBase: route.assetBase,
      visibility: route.visibility,
      routeConfigJson: record(route.routeConfigJson),
    }));
  return [...preserved, ...replacements];
}

async function findOrCreateArtifact(input: {
  context: PagePublishContext;
  input?: FinalizePageUploadSessionInput["artifact"];
  manifest: NormalizedManifest;
  project: ProjectRecord;
  repository: PagePublishRepository;
  visibility: ArtifactVisibility;
}) {
  const artifactRef = cleanText(input.input?.id) ?? cleanText(input.input?.slug) ?? cleanText(input.input?.localArtifactId);
  if (artifactRef) {
    const existing = await input.repository.findArtifactByRef(input.project.id, artifactRef);
    if (existing) return existing;
  }

  const slug = cleanSlug(input.input?.slug) ?? `page-${input.manifest.manifestHash.slice(0, 12)}`;
  const existingBySlug = await input.repository.findArtifactByRef(input.project.id, slug);
  if (existingBySlug) return existingBySlug;

  return input.repository.createArtifact({
    projectId: input.project.id,
    slug,
    name: cleanText(input.input?.name) ?? slug,
    description: cleanText(input.input?.description),
    localArtifactId: cleanText(input.input?.localArtifactId),
    visibility: input.visibility,
    metadataJson: {
      source: "pages_publish",
      entrypoint: input.manifest.entrypoint,
    },
  });
}

async function preparePageFinalize(input: {
  context: PagePublishContext;
  input: FinalizePageUploadSessionInput;
  repository: PagePublishRepository;
  requestId: string;
}): Promise<PreparedPageFinalize | { existingResult: PagePublishResult }> {
  const uploadSession = await input.repository.findUploadSession({
    actorId: input.context.actorId,
    actorType: input.context.actorType,
    organizationId: input.context.organizationId,
    uploadSessionId: input.input.uploadSessionId,
  });
  if (!uploadSession) throw publishError(404, "publish_upload_missing");
  if (uploadSession.status === "finalized") {
    const existing = await existingFinalizeResult(input.repository, uploadSession, input.input.idempotencyKey);
    if (existing) return { existingResult: existing };
    throw publishError(409, "publish_upload_missing");
  }
  if (uploadSession.status !== "created") throw publishError(409, "publish_upload_missing");
  if (uploadSession.expiresAt <= new Date()) {
    await input.repository.updateUploadSession({
      id: uploadSession.id,
      status: "expired",
      errorCode: "publish_upload_missing",
    });
    throw publishError(410, "publish_upload_missing");
  }

  const idempotencyKey = cleanKey(input.input.idempotencyKey ?? uploadSession.idempotencyKey);
  const existingPublish = idempotencyKey
    ? await input.repository.findPublishByIdempotencyKey({
        organizationId: input.context.organizationId,
        projectId: uploadSession.projectId,
        actorType: input.context.actorType,
        actorId: input.context.actorId,
        idempotencyKey,
      })
    : null;
  if (existingPublish?.status === "completed" && existingPublish.artifactVersionId) {
    return { existingResult: await hydratePublishResult(input.repository, input.context.organizationId, existingPublish) };
  }
  if (existingPublish) throw publishError(409, "publish_upload_missing");

  const uploadedManifest = normalizePackageManifest(input.input.packageManifest);
  assertUploadManifestLimits(uploadedManifest);
  assertManifestMatchesUploadSession(uploadSession, uploadedManifest);
  const manifest = withPublishPresentation(
    withPublishConnectorUses(uploadedManifest, input.input.publish?.uses),
    input.input.publish?.presentation,
  );
  const project = await input.repository.findProjectByRef(input.context.organizationId, uploadSession.projectId);
  if (!project) throw publishError(404, "publish_forbidden");
  await assertProjectAccess(input.context, input.repository, project.id, "write");
  const publishSite = input.input.publish
    ? input.input.publish.siteRef
      ? await requireSite(input.repository, input.context.organizationId, project.id, input.input.publish.siteRef)
      : await requireDefaultProjectSite(input.repository, input.context.organizationId, project.id)
    : null;
  if (input.input.publish && publishSite && input.input.publish.activate !== false) {
    await assertNoUnreadPageCommentsForPublish({
      context: input.context,
      reason: input.input.publish.reason ?? "publish",
      repository: input.repository,
      routePaths: routePathsFromFinalizePublishInput(input.input.publish),
      site: publishSite,
    });
  }
  const pageVisibility = pageArtifactVisibility({
    projectDefaultVisibility: project.defaultVisibility,
    publish: input.input.publish,
    siteDefaultVisibility: publishSite?.defaultVisibility,
  });
  const artifactVisibility = artifactVisibilityForPage(pageVisibility);
  const artifact = await findOrCreateArtifact({
    context: input.context,
    input: input.input.artifact,
    manifest,
    project,
    repository: input.repository,
    visibility: artifactVisibility,
  });
  await input.repository.lockArtifactVersionSequence(artifact.id);
  const versionNumber = await input.repository.nextArtifactVersionNumber(artifact.id);
  const artifactVersion = await input.repository.createArtifactVersion({
    artifactId: artifact.id,
    versionNumber,
    status: "created",
    sha256: manifest.manifestHash,
    sizeBytes: totalBytes(manifest.files),
    sourceJson: {
      type: "page_upload_session",
      uploadSessionId: uploadSession.id,
      source: input.input.source ?? {},
      ...(input.context.localInstallationId ? { localInstallationId: input.context.localInstallationId } : {}),
      ...(input.context.actorType === "cli" && input.context.authorization ? {
        projectAuthorization: { organizationId: input.context.organizationId, userId: input.context.actorId, delegation: input.context.authorization },
      } : {}),
    },
    metadataJson: {
      packageManifest: manifest.publicManifest,
      requestId: input.requestId,
      ...(manifest.connectorUses ? { connectors: manifest.connectorUses } : {}),
      ...(manifest.presentation ? { presentation: manifest.presentation } : {}),
    },
    createdByActorType: input.context.actorType,
    createdByActorId: input.context.actorId,
  });
  const publish = await input.repository.createPublish({
    organizationId: input.context.organizationId,
    projectId: project.id,
    artifactId: artifact.id,
    artifactVersionId: artifactVersion.id,
    siteId: publishSite?.id ?? null,
    siteReleaseId: null,
    sourceType: "upload_session",
    sourceRef: uploadSession.id,
    status: "started",
    manifestKey: null,
    manifestHash: null,
    objectCount: manifest.files.length,
    totalBytes: totalBytes(manifest.files),
    visibility: artifactVisibility,
    routeChangesJson: {},
    idempotencyKey,
    createdByActorType: input.context.actorType,
    createdByActorId: input.context.actorId,
    metadataJson: {
      source: input.input.source ?? {},
      ...(manifest.connectorUses ? { connectors: manifest.connectorUses } : {}),
    },
  });

  return {
    artifact,
    artifactVersion,
    idempotencyKey,
    manifest,
    project,
    publish,
    publishSite,
    uploadSession,
  };
}

function artifactVisibilityForPage(visibility: PublishVisibility): ArtifactVisibility {
  return visibility === "password" ? "private" : visibility;
}

function pageArtifactVisibility(input: {
  projectDefaultVisibility: ArtifactVisibility;
  publish?: FinalizePageUploadSessionInput["publish"];
  siteDefaultVisibility?: PublishVisibility;
}): PublishVisibility {
  const routeVisibilities = [
    input.publish?.route?.visibility,
    ...(input.publish?.routes?.map((route) => route.visibility) ?? []),
  ];
  if (input.publish?.visibility === "password" || routeVisibilities.includes("password")) return "password";
  if (input.siteDefaultVisibility === "password") return "password";
  return input.publish?.visibility ?? input.projectDefaultVisibility;
}

async function writeArtifactVersionObjects(input: {
  artifact: ArtifactRecord;
  context: PagePublishContext;
  artifactVersion: ArtifactVersionRecord;
  manifest: NormalizedManifest;
  storage: PageObjectStorage;
  uploadSession: PageUploadSessionRecord;
}): Promise<ArtifactStorageResult> {
  const filesWithKeys = await mapWithConcurrency(input.manifest.files, pageStorageConcurrency(), async (file) => {
    const promoted = await input.storage.promoteObject({
      organizationId: input.context.organizationId,
      projectId: input.uploadSession.projectId,
      artifactId: input.artifact.id,
      artifactVersionId: input.artifactVersion.id,
      uploadSessionId: input.uploadSession.id,
      stagingPrefix: input.uploadSession.stagingPrefix,
      path: file.path,
      contentType: file.contentType,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      stagingKey: file.stagingKey,
    });
    return { ...file, r2Key: promoted.r2Key };
  });

  const fullManifest = {
    ...input.manifest.publicManifest,
    assetBase: assetBaseFor(input.artifact.id, input.artifactVersion.id),
    files: filesWithKeys.map((file) => ({
      path: file.path,
      r2Key: file.r2Key,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
      cache: file.cache,
    })),
  };
  const manifestObject = await input.storage.writeManifest({
    organizationId: input.context.organizationId,
    projectId: input.uploadSession.projectId,
    artifactId: input.artifact.id,
    artifactVersionId: input.artifactVersion.id,
    manifest: fullManifest,
  });
  input.manifest.manifestKey = manifestObject.r2Key;

  return {
    filesWithKeys,
    fullManifest,
    manifestKey: manifestObject.r2Key,
    metadataJson: {
      packageManifest: fullManifest,
      manifestHash: input.manifest.manifestHash,
      manifestKey: manifestObject.r2Key,
      storageDriver: "object_storage",
      uploadSessionId: input.uploadSession.id,
    },
  };
}

async function persistArtifactVersionStorage(input: {
  artifact: ArtifactRecord;
  artifactVersion: ArtifactVersionRecord;
  context: PagePublishContext;
  manifest: NormalizedManifest;
  publish: PagePublishRecord;
  repository: PagePublishRepository;
  requestId: string;
  storageResult: ArtifactStorageResult;
  uploadSession: PageUploadSessionRecord;
}) {
  const storedAssets: Array<{ asset: AssetRecord; file: NormalizedManifestFile }> = [];
  for (const file of input.storageResult.filesWithKeys) {
    const asset = await input.repository.createAsset({
      artifactId: input.artifact.id,
      artifactVersionId: input.artifactVersion.id,
      path: file.path,
      mimeType: file.contentType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      visibility: input.artifact.visibility,
      storageJson: {
        driver: "object_storage",
        key: file.r2Key,
      },
      metadataJson: {
        cache: file.cache,
      },
    });
    storedAssets.push({ asset, file });
  }

  const metadataJson = {
    ...input.storageResult.metadataJson,
    requestId: input.requestId,
    ...(input.manifest.connectorUses ? { connectors: input.manifest.connectorUses } : {}),
    ...(input.manifest.presentation ? { presentation: input.manifest.presentation } : {}),
  };
  await input.repository.updateArtifactVersionMetadata({
    artifactVersionId: input.artifactVersion.id,
    metadataJson,
    status: "ready",
  });

  await input.repository.updateArtifactVersionState({
    artifactId: input.artifact.id,
    lastCloudVersion: input.artifactVersion.versionNumber,
    syncMetadataJson: {
      latestManifestKey: input.storageResult.manifestKey,
      latestManifestHash: input.manifest.manifestHash,
    },
  });

  await input.repository.insertAudit({
    organizationId: input.context.organizationId,
    projectId: input.uploadSession.projectId,
    actorType: input.context.actorType,
    actorId: input.context.actorId,
    targetType: "artifact_version",
    targetId: input.artifactVersion.id,
    action: "artifact_version.created_from_publish",
    requestId: input.requestId,
    metadataJson: {
      artifactId: input.artifact.id,
      versionNumber: input.artifactVersion.versionNumber,
      manifestHash: input.manifest.manifestHash,
      objectCount: input.manifest.files.length,
      totalBytes: totalBytes(input.manifest.files),
    },
  });

  await recordPublishStorageUsage({
    artifact: input.artifact,
    artifactVersion: input.artifactVersion,
    context: input.context,
    manifest: input.manifest,
    publish: input.publish,
    repository: input.repository,
    requestId: input.requestId,
    storageResult: input.storageResult,
    storedAssets,
    uploadSession: input.uploadSession,
  });

  return {
    ...input.artifactVersion,
    metadataJson,
    status: "ready" as const,
  };
}

async function recordPublishStorageUsage(input: {
  artifact: ArtifactRecord;
  artifactVersion: ArtifactVersionRecord;
  context: PagePublishContext;
  manifest: NormalizedManifest;
  publish: PagePublishRecord;
  repository: PagePublishRepository;
  requestId: string;
  storageResult: ArtifactStorageResult;
  storedAssets: Array<{ asset: AssetRecord; file: NormalizedManifestFile }>;
  uploadSession: PageUploadSessionRecord;
}) {
  const siteId = input.uploadSession.siteId;
  const publishId = input.publish.id;

  for (const { asset, file } of input.storedAssets) {
    await input.repository.createUsageEvent(buildPagesAssetStoredUsageEvent({
      organizationId: input.context.organizationId,
      projectId: input.uploadSession.projectId,
      siteId,
      artifactId: input.artifact.id,
      artifactVersionId: input.artifactVersion.id,
      assetId: asset.id,
      publishId,
      assetPath: file.path,
      cache: file.cache,
      contentType: file.contentType,
      requestId: input.requestId,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      storageKey: file.r2Key,
      visibility: input.artifact.visibility,
    }));
  }

  await input.repository.createUsageEvent(buildPagesManifestStoredUsageEvent({
    organizationId: input.context.organizationId,
    projectId: input.uploadSession.projectId,
    siteId,
    artifactId: input.artifact.id,
    artifactVersionId: input.artifactVersion.id,
    publishId,
    byteLength: Buffer.byteLength(stableStringify(input.storageResult.fullManifest), "utf8"),
    manifestHash: input.manifest.manifestHash,
    manifestKind: "artifact_version",
    requestId: input.requestId,
    storageKey: input.storageResult.manifestKey,
  }));
}

async function markArtifactVersionFailed(input: {
  artifactVersionId: string;
  code: PublishErrorCode;
  repository: PagePublishRepository;
  requestId: string;
}) {
  try {
    await input.repository.updateArtifactVersionMetadata({
      artifactVersionId: input.artifactVersionId,
      metadataJson: {
        errorCode: input.code,
        requestId: input.requestId,
      },
      status: "failed",
    });
  } catch (error) {
    console.error("Failed to mark Ravi Pages artifact version as failed", {
      artifactVersionId: input.artifactVersionId,
      error,
      requestId: input.requestId,
    });
  }
}

function routesFromPublishInput(
  input: NonNullable<FinalizePageUploadSessionInput["publish"]>,
  artifact: ArtifactRecord,
  artifactVersion: ArtifactVersionRecord,
  manifest: NormalizedManifest,
): PageReleaseRouteSpec[] {
  const routes = input.routes?.length
    ? input.routes
    : [
        {
          path: input.route?.path ?? "/",
          matchType: input.route?.matchType ?? "spa",
          priority: input.route?.priority,
          visibility: input.route?.visibility,
          allowDeviceMotion: input.route?.allowDeviceMotion,
        },
      ];

  return routes.map((route) => ({
    path: route.path,
    matchType: route.matchType ?? "spa",
    priority: route.priority ?? 0,
    artifactId: artifact.id,
    artifactVersionId: artifactVersion.id,
    entrypoint: manifest.entrypoint,
    assetBase: assetBaseFor(artifact.id, artifactVersion.id),
    visibility: route.visibility ?? input.visibility ?? artifact.visibility,
    allowDeviceMotion: route.allowDeviceMotion,
  }));
}

export function routeConfigJsonForInput(route: PageReleaseRouteSpec): Record<string, unknown> {
  if (typeof route.allowDeviceMotion === "boolean") {
    return route.allowDeviceMotion ? { browserPermissions: { deviceMotion: "self" } } : {};
  }
  // The reserved `knowledge` key (route marks) is never written from publish input.
  return stripReservedRouteConfig(route.routeConfigJson) ?? {};
}

function browserPermissionsProjection(routeConfigJson: unknown): Record<string, unknown> {
  const browserPermissions = record(record(routeConfigJson).browserPermissions);
  return browserPermissions.deviceMotion === "self"
    ? { browserPermissions: { deviceMotion: "self" } }
    : {};
}

function routePathsFromFinalizePublishInput(
  input: NonNullable<FinalizePageUploadSessionInput["publish"]>,
) {
  const routes = input.routes?.length
    ? input.routes
    : [
        {
          path: input.route?.path ?? "/",
        },
      ];
  return routes.map((route) => route.path);
}

async function assertNoUnreadPageCommentsForReleaseInput(input: {
  context: PagePublishContext;
  input: CreatePageSiteReleaseInput;
  repository: PagePublishRepository;
}) {
  const project = await input.repository.findProjectByRef(input.context.organizationId, input.input.projectRef);
  if (!project) throw publishError(404, "publish_forbidden");
  await assertProjectAccess(input.context, input.repository, project.id, "write");
  const site = await requireSite(input.repository, input.context.organizationId, project.id, input.input.siteRef);
  await assertNoUnreadPageCommentsForPublish({
    context: input.context,
    reason: input.input.reason ?? "manual_release",
    repository: input.repository,
    routePaths: input.input.routes.map((route) => route.path),
    site,
  });
}

async function assertNoUnreadPageCommentsForExistingRelease(input: {
  context: PagePublishContext;
  input: {
    siteRef: string;
    releaseId: string;
  };
  repository: PagePublishRepository;
}) {
  if (!shouldGatePublishComments(input.context, "manual_activation")) return;
  const site = await input.repository.findSiteByRef(input.context.organizationId, input.input.siteRef);
  if (!site || site.status !== "active") throw publishError(404, "publish_site_unavailable");
  await assertProjectAccess(input.context, input.repository, site.projectId, "write");
  const release = await input.repository.getRelease({
    organizationId: input.context.organizationId,
    siteId: site.id,
    releaseId: input.input.releaseId,
  });
  if (!release) throw publishError(404, "publish_site_unavailable");
  if (release.status === "failed") throw publishError(409, "publish_validation_failed");
  const routes = await input.repository.listReleaseRoutes(release.id);
  if (routes.length === 0) throw publishError(409, "publish_validation_failed");
  await assertNoUnreadPageCommentsForPublish({
    context: input.context,
    reason: "manual_activation",
    repository: input.repository,
    routePaths: routes.map((route) => route.path),
    site,
  });
}

async function assertNoUnreadPageCommentsForPublish(input: {
  context: PagePublishContext;
  reason: string;
  repository: PagePublishRepository;
  routePaths: string[];
  site: PageSiteRecord;
}) {
  if (!shouldGatePublishComments(input.context, input.reason)) return;
  const paths = [...new Set(input.routePaths.map(normalizePublishRoutePath))];
  const unread = await input.repository.listUnreadPageCommentsForRoutes({
    siteId: input.site.id,
    paths,
    userId: input.context.actorId,
    limit: 10,
  });
  if (unread.length === 0) return;
  throw new ConsoleApiError(409, {
    error: "publish_unread_comments",
    fieldErrors: {
      comments: unreadCommentMessage(unread),
    },
  });
}

function shouldGatePublishComments(context: PagePublishContext, reason: string) {
  if (reason === "operator_visibility_update" || reason === "cli_visibility_update") return false;
  return context.actorType === "user" || context.actorType === "cli";
}

function normalizePublishRoutePath(path: string) {
  const normalized = typeof path === "string" && path.trim() ? path.trim() : "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function unreadCommentMessage(comments: PagePublishUnreadCommentRecord[]) {
  const latest = comments[0];
  if (!latest) return "Read page comments before publishing.";
  const author = latest.createdByDisplayName ?? latest.createdByUserId ?? "another user";
  return `Read ${comments.length} unread Page comment${comments.length === 1 ? "" : "s"} before publishing. Latest: ${author} on ${latest.path}.`;
}

async function existingFinalizeResult(
  repository: PagePublishRepository,
  uploadSession: PageUploadSessionRecord,
  idempotencyKey?: string | null,
) {
  const key = cleanKey(idempotencyKey ?? uploadSession.idempotencyKey);
  if (!key || !uploadSession.createdByActorId) return null;
  const publish = await repository.findPublishByIdempotencyKey({
    organizationId: uploadSession.organizationId,
    projectId: uploadSession.projectId,
    actorType: publishActorType(uploadSession.createdByActorType),
    actorId: uploadSession.createdByActorId,
    idempotencyKey: key,
  });
  if (publish?.status !== "completed" || !publish.artifactVersionId) return null;
  return hydratePublishResult(repository, uploadSession.organizationId, publish);
}

async function hydratePublishResult(
  repository: PagePublishRepository,
  organizationId: string,
  publish: PagePublishRecord,
): Promise<PagePublishResult> {
  if (!publish.artifactVersionId) throw publishError(409, "publish_validation_failed");
  const version = await repository.findArtifactVersion({
    organizationId,
    projectId: publish.projectId,
    artifactVersionId: publish.artifactVersionId,
  });
  if (!version) throw publishError(409, "publish_validation_failed");

  const release = publish.siteId && publish.siteReleaseId
    ? await repository.getRelease({ organizationId, siteId: publish.siteId, releaseId: publish.siteReleaseId })
    : null;
  const site = publish.siteId ? await repository.findSiteByRef(organizationId, publish.siteId) : null;
  const routes = release ? await repository.listReleaseRoutes(release.id) : [];
  return {
    artifact: version.artifact,
    artifactVersion: version.artifactVersion,
    publish,
    site,
    release,
    routes,
    url: site ? publishedRouteUrl(site, publishedRoutePathFromRecord(publish, routes)) : null,
  };
}

function primaryPublishRoutePath(publish: FinalizePageUploadSessionInput["publish"]): string {
  return publish?.route?.path ?? publish?.routes?.[0]?.path ?? "/";
}

function publishedRoutePathFromRecord(publish: PagePublishRecord, routes: PageReleaseRouteRecord[]): string {
  const routeChanges = publish.routeChangesJson;
  if (routeChanges && typeof routeChanges === "object" && !Array.isArray(routeChanges)) {
    const route = (routeChanges as Record<string, unknown>).routes;
    if (Array.isArray(route)) {
      const first = route.find((item) => item && typeof item === "object" && !Array.isArray(item));
      const path = first ? (first as Record<string, unknown>).path : null;
      if (typeof path === "string" && path.trim()) return path;
    }
  }
  return routes[0]?.path ?? "/";
}

function publishedRouteUrl(site: PageSiteRecord, path: string): string {
  const pathname = path.startsWith("/") ? path : `/${path}`;
  return `https://${site.defaultHostname}${pathname === "/" ? "/" : pathname}`;
}

async function requireDefaultProjectSite(
  repository: PagePublishRepository,
  organizationId: string,
  projectId: string,
) {
  const site = await repository.findDefaultSite(projectId);
  if (!site || site.organizationId !== organizationId || site.status !== "active") {
    throw publishError(404, "publish_site_unavailable");
  }
  return site;
}

async function requireSite(
  repository: PagePublishRepository,
  organizationId: string,
  projectId: string,
  siteRef: string,
) {
  const site = await repository.findSiteByRef(organizationId, siteRef);
  if (!site || site.projectId !== projectId || site.status !== "active") {
    throw publishError(404, "publish_site_unavailable");
  }
  return site;
}

type NormalizedManifestFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  stagingKey: string | null;
  cache: string;
  r2Key?: string;
};

type NormalizedManifest = {
  entrypoint: string;
  basePath: string;
  files: NormalizedManifestFile[];
  publicManifest: Record<string, unknown>;
  manifestHash: string;
  manifestKey: string | null;
  connectorUses?: PagesConnectorUsesSnapshot;
  /** `publish.presentation`, kept apart from the package manifest and its hash. */
  presentation?: PagePresentation;
};

function normalizePackageManifest(input: PagePackageManifestInput | null | undefined): NormalizedManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw publishError(400, "publish_validation_failed");
  }
  const validation = validateArtifactPackageManifest({
    entrypoint: input.entrypoint ?? "index.html",
    files: input.files,
  });
  if (!validation.ok) throw publishError(400, "publish_validation_failed");

  const seenPaths = new Set<string>();
  const files = input.files.map((file, index) => {
    const path = validation.files[index] ?? file.path;
    if (seenPaths.has(path)) throw publishError(400, "publish_validation_failed");
    seenPaths.add(path);
    return {
      path,
      sha256: requiredSha256(file.sha256),
      sizeBytes: requiredSizeBytes(file.sizeBytes),
      contentType: cleanText(file.contentType) ?? contentTypeForPath(path),
      stagingKey: cleanText(file.stagingKey),
      cache: path === validation.entrypoint ? "entrypoint" : file.cache ?? "immutable",
    };
  });

  const connectorUses = snapshotConnectorUsesFromManifest(input.uses);
  const publicManifest = {
    entrypoint: validation.entrypoint,
    basePath: input.basePath ?? "/",
    files: files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
      cache: file.cache,
    })),
    ...(connectorUses ? { uses: connectorUses.uses.map((item) => item.id) } : {}),
  };

  return {
    entrypoint: validation.entrypoint,
    basePath: input.basePath ?? "/",
    files,
    publicManifest,
    manifestHash: stableHash(publicManifest),
    manifestKey: null,
    ...(connectorUses ? { connectorUses } : {}),
  };
}

// The upload session hashes the manifest as it was created, so an allowlist
// sent only on the finalize publish block is folded in after that check.
function withPublishConnectorUses(manifest: NormalizedManifest, uses: unknown): NormalizedManifest {
  const fromPublish = snapshotConnectorUsesFromManifest(uses);
  if (!fromPublish) return manifest;
  const ids = fromPublish.uses.map((item) => item.id);
  if (manifest.connectorUses) {
    const manifestIds = manifest.connectorUses.uses.map((item) => item.id);
    if (manifestIds.length !== ids.length || manifestIds.some((id) => !ids.includes(id))) {
      throw publishError(400, "publish_validation_failed");
    }
    return manifest;
  }
  const publicManifest = { ...manifest.publicManifest, uses: ids };
  return { ...manifest, publicManifest, manifestHash: stableHash(publicManifest), connectorUses: fromPublish };
}

/** `publish.presentation`: optional, strict, at most 16 KiB; anything else is `publish_validation_failed`. */
function publishPresentation(value: unknown): PagePresentation | null {
  const parsed = parsePagePresentation(value);
  if (!parsed.ok) throw publishError(400, "publish_validation_failed");
  return parsed.presentation;
}

function withPublishPresentation(manifest: NormalizedManifest, value: unknown): NormalizedManifest {
  const presentation = publishPresentation(value);
  return presentation ? { ...manifest, presentation } : manifest;
}

function assertUploadManifestLimits(manifest: NormalizedManifest) {
  const maxFiles = positiveIntegerEnv("RAVI_PAGES_MAX_FILES", DEFAULT_MAX_UPLOAD_FILES);
  const maxTotalBytes = positiveIntegerEnv("RAVI_PAGES_MAX_TOTAL_BYTES", DEFAULT_MAX_UPLOAD_TOTAL_BYTES);
  const maxFileBytes = positiveIntegerEnv("RAVI_PAGES_MAX_FILE_BYTES", DEFAULT_MAX_UPLOAD_FILE_BYTES);
  if (manifest.files.length === 0 || manifest.files.length > maxFiles) {
    throw publishError(400, "publish_validation_failed");
  }
  if (totalBytes(manifest.files) > maxTotalBytes) {
    throw publishError(400, "publish_quota_exceeded");
  }
  if (manifest.files.some((file) => file.sizeBytes > maxFileBytes)) {
    throw publishError(400, "publish_quota_exceeded");
  }
}

function assertManifestMatchesUploadSession(uploadSession: PageUploadSessionRecord, manifest: NormalizedManifest) {
  const expected = record(uploadSession.fileManifestJson);
  if (Object.keys(expected).length === 0) {
    throw publishError(400, "publish_validation_failed");
  }
  if (stableHash(expected) !== manifest.manifestHash) {
    throw publishError(400, "publish_validation_failed");
  }
}

function reusableUploadSessionManifest(
  uploadSession: PageUploadSessionRecord,
  retryManifest: NormalizedManifest,
): NormalizedManifest {
  if (uploadSession.status !== "created") {
    throw publishError(409, "publish_upload_missing");
  }
  if (uploadSession.expiresAt <= new Date()) {
    throw publishError(410, "publish_upload_missing");
  }

  const existingManifest = normalizePackageManifest(uploadSession.fileManifestJson as PagePackageManifestInput);
  if (existingManifest.manifestHash !== retryManifest.manifestHash) {
    throw publishError(400, "publish_validation_failed");
  }
  return existingManifest;
}

function publicUploadSession(uploadSession: PageUploadSessionRecord): PublicPageUploadSessionRecord {
  const { uploadPolicyJson: _uploadPolicyJson, ...safeUploadSession } = uploadSession;
  return safeUploadSession;
}

function uploadPolicySummary(policy: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ["driver", "directUpload", "stagingPrefix", "expiresAt"]) {
    if (policy[key] !== undefined) summary[key] = policy[key];
  }

  if (Array.isArray(policy.files)) {
    summary.files = policy.files.map((item) => uploadPolicyFileSummary(record(item)));
  }

  return summary;
}

function uploadPolicyFileSummary(file: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ["path", "stagingKey", "method"]) {
    if (file[key] !== undefined) summary[key] = file[key];
  }
  const headers = uploadPolicyHeaderSummary(file.headers);
  if (headers) summary.headers = headers;
  return summary;
}

function uploadPolicyHeaderSummary(value: unknown): Record<string, string> | null {
  const headers = record(value);
  const safeHeaders = Object.fromEntries(
    Object.entries(headers).filter(
      ([key, item]) => typeof item === "string" && !isSecretUploadHeader(key),
    ),
  ) as Record<string, string>;
  return Object.keys(safeHeaders).length > 0 ? safeHeaders : null;
}

function isSecretUploadHeader(key: string) {
  const normalized = key.toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "x-amz-security-token" ||
    normalized.includes("signature") ||
    normalized.includes("credential") ||
    normalized.includes("secret") ||
    normalized.includes("token")
  );
}

function assertCanPublish(context: PagePublishContext) {
  if (context.actorType === "cli") {
    if (!context.scopes?.includes("artifacts.publish") || !context.authorization) {
      throw publishError(403, "publish_forbidden");
    }
    return;
  }
  if (context.actorType === "anonymous" || context.actorType === "system") {
    throw publishError(403, "publish_forbidden");
  }
}

async function assertProjectAccess(
  context: PagePublishContext,
  repository: PagePublishRepository,
  projectId: string,
  action: ProjectAccessAction,
) {
  if (await repository.authorizeProject?.(context, projectId, action)) return;
  throw publishError(403, "publish_forbidden");
}

export function consolePublishContextFromWorkspace(workspace: {
  authorization?: AuthorizationActor["delegation"];
  mode: "anonymous" | "workos" | "oidc";
  user: { id: string };
  organization: { id: string };
  membership: { role: string };
}): PagePublishContext {
  return {
    authorization: workspace.authorization,
    actorId: workspace.user.id,
    actorType: workspace.mode === "anonymous" ? "anonymous" : "user",
    membershipRole: workspace.membership.role,
    organizationId: workspace.organization.id,
  };
}

export function cliPublishContextFromAuth(context: VerifiedCliProjectContext & {
  user: { id: string }; organization: { id: string }; membership: { role: string }; scopes: string[];
}): PagePublishContext {
  return {
    authorization: projectAuthorizationFromCli(context),
    actorId: context.user.id,
    actorType: "cli",
    localInstallationId: context.localInstallation?.id ?? null,
    membershipRole: context.membership.role,
    organizationId: context.organization.id,
    scopes: context.scopes,
  };
}

export function publishError(status: number, error: PublishErrorCode) {
  return new ConsoleApiError(status, { error });
}

export type PublishErrorCode =
  | "publish_validation_failed"
  | "publish_quota_exceeded"
  | "publish_forbidden"
  | "publish_site_unavailable"
  | "publish_route_conflict"
  | "publish_origin_grants_conflict"
  | "publish_unread_comments"
  | "publish_upload_missing"
  | "publish_storage_failed"
  | "publish_activation_failed";

function publicPublishErrorCode(error: unknown): PublishErrorCode {
  if (error instanceof ConsoleApiError && isPublishErrorCode(error.payload.error)) {
    return error.payload.error;
  }
  return "publish_storage_failed";
}

function isPublishErrorCode(code: string): code is PublishErrorCode {
  return (
    code === "publish_validation_failed" ||
    code === "publish_quota_exceeded" ||
    code === "publish_forbidden" ||
    code === "publish_site_unavailable" ||
    code === "publish_route_conflict" ||
    code === "publish_origin_grants_conflict" ||
    code === "publish_unread_comments" ||
    code === "publish_upload_missing" ||
    code === "publish_storage_failed" ||
    code === "publish_activation_failed"
  );
}

function publishActorType(value: string): PublishActorType {
  if (value === "anonymous" || value === "user" || value === "cli" || value === "system") return value;
  return "system";
}

function finalObjectKey(input: PromoteObjectInput) {
  return `org/${input.organizationId}/project/${input.projectId}/artifact/${input.artifactId}/version/${input.artifactVersionId}/${input.path}`;
}

function assetBaseFor(artifactId: string, artifactVersionId: string) {
  return `/_ravi/assets/${artifactId}/${artifactVersionId}/`;
}

function normalizeRouteEntrypoint(input: string | undefined, version: ArtifactVersionRecord) {
  const entrypoint = input ?? entrypointFromVersion(version);
  const validation = validateManifestFilePath(entrypoint);
  if (!validation.ok) throw publishError(400, "publish_validation_failed");
  return validation.path;
}

function entrypointFromVersion(version: ArtifactVersionRecord) {
  const metadata = record(version.metadataJson);
  const manifest = record(metadata.packageManifest);
  return typeof manifest.entrypoint === "string" ? manifest.entrypoint : "index.html";
}

function assertArtifactVersionReadyForPages(
  version: { artifact: ArtifactRecord; artifactVersion: ArtifactVersionRecord },
  entrypoint: string,
) {
  if (version.artifact.status !== "active" || version.artifactVersion.status !== "ready") {
    throw publishError(400, "publish_validation_failed");
  }

  const metadata = record(version.artifactVersion.metadataJson);
  const manifest = record(metadata.packageManifest);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const hasEntrypoint = files.some((file) => record(file).path === entrypoint);
  if (!hasEntrypoint) throw publishError(400, "publish_validation_failed");
}

function releaseRouteSummary(route: PageReleaseRouteRecord) {
  return {
    path: route.path,
    matchType: route.matchType,
    priority: route.priority,
    artifactId: route.artifactId,
    artifactVersionId: route.artifactVersionId,
  };
}

function releaseStatusVisibility(routes: PageReleaseRouteRecord[], fallback: PublishVisibility): PublishVisibility {
  if (routes.some((route) => route.visibility === "private")) return "private";
  if (routes.some((route) => route.visibility === "password")) return "password";
  if (routes.some((route) => route.visibility === "protected_link")) return "protected_link";
  return fallback;
}

function routeIdentity(route: { path: string; matchType: PageRouteMatchType }) {
  return `${route.path}:${route.matchType}`;
}

function cleanSlug(value: string | null | undefined) {
  const cleaned = cleanText(value)?.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || null;
}

function cleanKey(value: string | null | undefined) {
  return cleanText(value)?.slice(0, 180) ?? null;
}

function cleanText(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned || null;
}

function requiredSha256(value: string | null | undefined) {
  const sha256 = cleanText(value);
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw publishError(400, "publish_validation_failed");
  return sha256;
}

function requiredSizeBytes(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw publishError(400, "publish_validation_failed");
  }
  return value;
}

function positiveIntegerEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPositiveIntegerEnv(name: string, fallback: number, max: number) {
  return Math.min(positiveIntegerEnv(name, fallback), max);
}

function uploadTtlSeconds() {
  return positiveIntegerEnv("RAVI_PAGES_UPLOAD_TTL_SECONDS", DEFAULT_UPLOAD_TTL_SECONDS);
}

function pageStorageConcurrency() {
  return boundedPositiveIntegerEnv(
    "RAVI_PAGES_STORAGE_CONCURRENCY",
    DEFAULT_PAGE_STORAGE_CONCURRENCY,
    MAX_PAGE_STORAGE_CONCURRENCY,
  );
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  callback: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: limit }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index] as T, index);
    }
  }));

  return results;
}

function safeErrorDetails(error: unknown) {
  const details = record(error);
  return {
    name: error instanceof Error ? error.name : "unknown",
    message: sanitizeInternalErrorMessage(error instanceof Error ? error.message : String(error)),
    reason: typeof details.reason === "string" ? details.reason : undefined,
    status: typeof details.status === "number" ? details.status : undefined,
    details: record(details.details),
  };
}

async function capturePagesPublishDiagnostic(input: {
  code: PublishErrorCode;
  context: PagePublishContext;
  durationMs?: number;
  error: unknown;
  objectCount?: number;
  phase: PagePublishDiagnosticPhase;
  projectId?: string | null;
  publishId?: string | null;
  releaseId?: string | null;
  requestId: string;
  routeCount?: number;
  siteId?: string | null;
  totalBytes?: number;
  uploadSessionId?: string;
}) {
  if (!shouldCapturePublishDiagnostic(input.code)) return;

  const internalError = safeErrorDetails(input.error);
  try {
    Sentry.captureMessage("Ravi Pages publish operation failed", {
      level: "error",
      tags: compactSentryTags({
        "ravi.domain": "pages",
        "ravi.operation": "publish",
        "ravi.phase": input.phase,
        "ravi.error_code": input.code,
        "ravi.error_reason": internalError.reason,
        "ravi.provider_status": internalError.status === undefined ? undefined : String(internalError.status),
      }),
      contexts: {
        ravi_pages_publish: compactSentryRecord({
          actorType: input.context.actorType,
          durationMs: input.durationMs,
          objectCount: input.objectCount,
          organizationId: input.context.organizationId,
          phase: input.phase,
          projectId: input.projectId,
          publishId: input.publishId,
          releaseId: input.releaseId,
          requestId: input.requestId,
          routeCount: input.routeCount,
          siteId: input.siteId,
          totalBytes: input.totalBytes,
          uploadSessionId: input.uploadSessionId,
        }),
      },
      extra: {
        internalError,
      },
      fingerprint: [
        "ravi-pages-publish",
        input.phase,
        input.code,
        internalError.reason ?? internalError.name,
      ],
    });
    await Sentry.flush(1500);
  } catch (diagnosticError) {
    console.error("Ravi Pages publish diagnostic capture failed", {
      requestId: input.requestId,
      internalError: safeErrorDetails(diagnosticError),
    });
  }
}

function shouldCapturePublishDiagnostic(code: PublishErrorCode) {
  return code === "publish_storage_failed" || code === "publish_activation_failed";
}

function compactSentryTags(input: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function compactSentryRecord(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
}

function sanitizeInternalErrorMessage(message: string) {
  let sanitized = message;
  for (const secret of [
    process.env.RAVI_PAGES_R2_ACCESS_KEY_ID,
    process.env.RAVI_PAGES_R2_SECRET_ACCESS_KEY,
  ]) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return sanitized.replace(/https?:\/\/\S+/g, "[url]").slice(0, 500);
}

function totalBytes(files: Array<{ sizeBytes: number }>) {
  return files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

function contentTypeForPath(path: string) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function stableHash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbExecutor = Pick<DbTransaction, "execute" | "insert" | "select" | "update">;
type DbRoot = DbExecutor & Pick<typeof db, "transaction">;
