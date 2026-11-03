import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { findAccessibleProjectRecord, type ProjectAccessWorkspace } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import { isUuidRef } from "../ref";
import type { PageVisibility } from "../pages";
import { createPagesCaptureSession, expirePagesCaptureSession, getPagesControlToken } from "./auth";
import { matchPageRoute, validateRoutePath } from "./policy";

const CAPTURE_PROVIDER = process.env.RAVI_PAGES_CAPTURE_PROVIDER === "playwright" ? "playwright" : "cloudflare_browser_run";
const DEFAULT_CAPTURE_MODE = "thumbnail" as const;
const DEFAULT_VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 } as const;
const DEFAULT_FORMAT = "jpeg" as const;
const DEFAULT_QUALITY = 82;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const CAPTURE_FILENAME = "thumbnail.jpg";

export type PageCaptureMode = "thumbnail" | "full_page" | "segmented";
export type PageCaptureStatus = "pending" | "capturing" | "ready" | "failed";
export type PageCaptureImageRole = "thumbnail" | "full_page" | "segment";

type PageCaptureWorkspace = ProjectAccessWorkspace & { mode?: "workos" | "oidc" | "anonymous"; browserSessionId?: string };
export type PageCaptureSetRecord = typeof schema.pageCaptureSets.$inferSelect;
type CaptureSetRecord = PageCaptureSetRecord;
type CaptureImageRecord = typeof schema.pageCaptureImages.$inferSelect;
type CaptureAssetRecord = typeof schema.assets.$inferSelect;

export type PageCaptureTarget = {
  site: typeof schema.pageSites.$inferSelect;
  release: typeof schema.pageSiteReleases.$inferSelect;
  releaseRoute: typeof schema.pageReleaseRoutes.$inferSelect;
  effectiveVisibility: PageVisibility;
};

export type PageCaptureImageWithAsset = {
  image: CaptureImageRecord;
  asset: CaptureAssetRecord;
};

type CreatePendingCaptureInput = {
  capture: {
    id: string;
    organizationId: string;
    projectId: string;
    siteId: string;
    routeId: string;
    releaseId: string;
    releaseRouteId: string;
    sourceArtifactId: string;
    sourceArtifactVersionId: string;
    captureArtifactId: string;
    captureArtifactVersionId: string;
    mode: "thumbnail";
    provider: string;
    configHash: string;
    configJson: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "anonymous" | "user";
    requestedByActorId: string;
  };
  artifact: {
    id: string;
    projectId: string;
    slug: string;
    name: string;
    description: string;
    metadataJson: Record<string, unknown>;
  };
  version: {
    id: string;
    artifactId: string;
    sourceJson: Record<string, unknown>;
    metadataJson: Record<string, unknown>;
    createdByActorType: "anonymous" | "user";
    createdByActorId: string;
  };
  requestId: string;
};

type ReadyCaptureInput = {
  captureId: string;
  artifactId: string;
  artifactVersionId: string;
  assetId: string;
  imageId: string;
  organizationId: string;
  projectId: string;
  requestedByActorId: string;
  requestId: string;
  result: PageCaptureWorkerResult;
};

export type PageCaptureRepository = {
  findPublishedTarget(input: {
    organizationId: string;
    path: string;
    projectId: string;
    siteRef?: string | null;
  }): Promise<PageCaptureTarget | null>;
  findByIdempotency(input: {
    organizationId: string;
    projectId: string;
    idempotencyKey: string;
  }): Promise<CaptureSetRecord | null>;
  createPending(input: CreatePendingCaptureInput): Promise<CaptureSetRecord>;
  markCapturing(captureId: string, now: Date): Promise<void>;
  markReady(input: ReadyCaptureInput): Promise<CaptureSetRecord>;
  markFailed(input: {
    captureId: string;
    artifactVersionId: string;
    failureCode: string;
    metadataJson: Record<string, unknown>;
    organizationId: string;
    projectId: string;
    requestedByActorId: string;
    requestId: string;
  }): Promise<void>;
  findById(input: { captureId: string; projectId: string }): Promise<CaptureSetRecord | null>;
  listImages(captureSetId: string): Promise<PageCaptureImageWithAsset[]>;
  findImage(input: {
    captureId: string;
    projectId: string;
    sequence: number;
  }): Promise<{ capture: CaptureSetRecord; image: CaptureImageRecord; asset: CaptureAssetRecord; hostname: string } | null>;
};

type DbExecutor = typeof db;

export function pageCaptureRepositoryForDb(database: DbExecutor = db): PageCaptureRepository {
  return {
    async findPublishedTarget(input) {
      const sitePredicate = input.siteRef
        ? isUuidRef(input.siteRef)
          ? or(eq(schema.pageSites.id, input.siteRef), eq(schema.pageSites.slug, input.siteRef))
          : eq(schema.pageSites.slug, input.siteRef)
        : eq(schema.pageSites.isDefault, true);
      const [site] = await database
        .select()
        .from(schema.pageSites)
        .where(
          and(
            eq(schema.pageSites.organizationId, input.organizationId),
            eq(schema.pageSites.projectId, input.projectId),
            eq(schema.pageSites.status, "active"),
            sitePredicate,
          ),
        )
        .orderBy(desc(schema.pageSites.isDefault), desc(schema.pageSites.updatedAt))
        .limit(1);
      if (!site?.activeReleaseId) return null;

      const [release] = await database
        .select()
        .from(schema.pageSiteReleases)
        .where(
          and(
            eq(schema.pageSiteReleases.id, site.activeReleaseId),
            eq(schema.pageSiteReleases.siteId, site.id),
            eq(schema.pageSiteReleases.status, "active"),
          ),
        )
        .limit(1);
      if (!release) return null;

      const releaseRoutes = await database
        .select()
        .from(schema.pageReleaseRoutes)
        .where(eq(schema.pageReleaseRoutes.releaseId, release.id));
      const matched = matchPageRoute(
        releaseRoutes.map((route) => ({
          id: route.id,
          path: route.path,
          matchType: route.matchType,
          priority: route.priority,
        })),
        input.path,
      );
      const releaseRoute = matched ? releaseRoutes.find((route) => route.id === matched.id) : null;
      if (!releaseRoute) return null;

      return {
        site,
        release,
        releaseRoute,
        effectiveVisibility: effectiveVisibility(site.defaultVisibility, releaseRoute.visibility),
      };
    },

    async findByIdempotency(input) {
      const [capture] = await database
        .select()
        .from(schema.pageCaptureSets)
        .where(
          and(
            eq(schema.pageCaptureSets.organizationId, input.organizationId),
            eq(schema.pageCaptureSets.projectId, input.projectId),
            eq(schema.pageCaptureSets.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      return capture ?? null;
    },

    async createPending(input) {
      return database.transaction(async (tx) => {
        await tx.insert(schema.artifacts).values({
          id: input.artifact.id,
          projectId: input.artifact.projectId,
          slug: input.artifact.slug,
          name: input.artifact.name,
          description: input.artifact.description,
          visibility: "private",
          status: "active",
          syncStatus: "cloud_only",
          metadataJson: input.artifact.metadataJson,
        });
        await tx.insert(schema.artifactVersions).values({
          id: input.version.id,
          artifactId: input.version.artifactId,
          versionNumber: 1,
          status: "building",
          sourceJson: input.version.sourceJson,
          metadataJson: input.version.metadataJson,
          createdByActorType: input.version.createdByActorType,
          createdByActorId: input.version.createdByActorId,
        });
        const [capture] = await tx
          .insert(schema.pageCaptureSets)
          .values({
            ...input.capture,
            status: "pending",
          })
          .returning();
        if (!capture) throw new Error("Failed to create Page capture set.");
        await tx.insert(schema.auditEvents).values({
          organizationId: input.capture.organizationId,
          projectId: input.capture.projectId,
          actorType: input.capture.requestedByActorType,
          actorId: input.capture.requestedByActorId,
          targetType: "page_capture_set",
          targetId: capture.id,
          action: "pages.capture.requested",
          requestId: input.requestId,
          metadataJson: {
            mode: input.capture.mode,
            releaseId: input.capture.releaseId,
            routeId: input.capture.routeId,
            sourceArtifactVersionId: input.capture.sourceArtifactVersionId,
          },
        });
        return capture;
      });
    },

    async markCapturing(captureId, now) {
      await database
        .update(schema.pageCaptureSets)
        .set({ status: "capturing", startedAt: now, updatedAt: now })
        .where(eq(schema.pageCaptureSets.id, captureId));
    },

    async markReady(input) {
      return database.transaction(async (tx) => {
        await tx.insert(schema.assets).values({
          id: input.assetId,
          artifactId: input.artifactId,
          artifactVersionId: input.artifactVersionId,
          role: input.result.role,
          path: input.result.filename,
          mimeType: input.result.mimeType,
          sizeBytes: input.result.sizeBytes,
          sha256: input.result.sha256,
          visibility: "private",
          storageJson: {
            driver: "r2",
            bucket: "pages",
            r2Key: input.result.storageKey,
          },
          metadataJson: {
            captureSetId: input.captureId,
            width: input.result.width,
            height: input.result.height,
          },
        });
        await tx.insert(schema.pageCaptureImages).values({
          id: input.imageId,
          captureSetId: input.captureId,
          assetId: input.assetId,
          sequence: 0,
          role: input.result.role,
          width: input.result.width,
          height: input.result.height,
          mimeType: input.result.mimeType,
          sizeBytes: input.result.sizeBytes,
          sha256: input.result.sha256,
          metadataJson: { provider: CAPTURE_PROVIDER },
        });
        const now = new Date();
        await tx
          .update(schema.artifactVersions)
          .set({
            status: "ready",
            sha256: input.result.sha256,
            sizeBytes: input.result.sizeBytes,
            metadataJson: {
              captureSetId: input.captureId,
              height: input.result.height,
              width: input.result.width,
            },
          })
          .where(eq(schema.artifactVersions.id, input.artifactVersionId));
        await tx
          .update(schema.artifacts)
          .set({
            lastCloudVersion: 1,
            syncStatus: "cloud_only",
            updatedAt: now,
          })
          .where(eq(schema.artifacts.id, input.artifactId));
        const [capture] = await tx
          .update(schema.pageCaptureSets)
          .set({ status: "ready", completedAt: now, updatedAt: now })
          .where(eq(schema.pageCaptureSets.id, input.captureId))
          .returning();
        if (!capture) throw new Error("Failed to finish Page capture set.");
        await tx.insert(schema.auditEvents).values({
          organizationId: input.organizationId,
          projectId: input.projectId,
          actorType: "user",
          actorId: input.requestedByActorId,
          targetType: "page_capture_set",
          targetId: input.captureId,
          action: "pages.capture.ready",
          requestId: input.requestId,
          metadataJson: {
            height: input.result.height,
            imageCount: 1,
            mimeType: input.result.mimeType,
            sizeBytes: input.result.sizeBytes,
            width: input.result.width,
          },
        });
        return capture;
      });
    },

    async markFailed(input) {
      await database.transaction(async (tx) => {
        const now = new Date();
        await tx
          .update(schema.artifactVersions)
          .set({ status: "failed", metadataJson: { captureFailureCode: input.failureCode } })
          .where(eq(schema.artifactVersions.id, input.artifactVersionId));
        await tx
          .update(schema.pageCaptureSets)
          .set({
            status: "failed",
            failureCode: input.failureCode,
            failureMetadataJson: input.metadataJson,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.pageCaptureSets.id, input.captureId));
        await tx.insert(schema.auditEvents).values({
          organizationId: input.organizationId,
          projectId: input.projectId,
          actorType: "user",
          actorId: input.requestedByActorId,
          targetType: "page_capture_set",
          targetId: input.captureId,
          action: "pages.capture.failed",
          requestId: input.requestId,
          metadataJson: { failureCode: input.failureCode, ...input.metadataJson },
        });
      });
    },

    async findById(input) {
      const [capture] = await database
        .select()
        .from(schema.pageCaptureSets)
        .where(
          and(eq(schema.pageCaptureSets.id, input.captureId), eq(schema.pageCaptureSets.projectId, input.projectId)),
        )
        .limit(1);
      return capture ?? null;
    },

    async listImages(captureSetId) {
      return database
        .select({ image: schema.pageCaptureImages, asset: schema.assets })
        .from(schema.pageCaptureImages)
        .innerJoin(schema.assets, eq(schema.pageCaptureImages.assetId, schema.assets.id))
        .where(eq(schema.pageCaptureImages.captureSetId, captureSetId))
        .orderBy(schema.pageCaptureImages.sequence);
    },

    async findImage(input) {
      const [row] = await database
        .select({
          capture: schema.pageCaptureSets,
          image: schema.pageCaptureImages,
          asset: schema.assets,
          hostname: schema.pageSites.defaultHostname,
        })
        .from(schema.pageCaptureSets)
        .innerJoin(schema.pageCaptureImages, eq(schema.pageCaptureImages.captureSetId, schema.pageCaptureSets.id))
        .innerJoin(schema.assets, eq(schema.pageCaptureImages.assetId, schema.assets.id))
        .innerJoin(schema.pageSites, eq(schema.pageCaptureSets.siteId, schema.pageSites.id))
        .where(
          and(
            eq(schema.pageCaptureSets.id, input.captureId),
            eq(schema.pageCaptureSets.projectId, input.projectId),
            eq(schema.pageCaptureSets.status, "ready"),
            eq(schema.pageCaptureImages.sequence, input.sequence),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  };
}

export type PageCaptureWorkerInput = {
  hostname: string;
  organizationId: string;
  projectId: string;
  captureSetId: string;
  captureArtifactId: string;
  captureArtifactVersionId: string;
  path: string;
  pagesSession: string;
  config: PageCaptureConfig;
};

export type PageCaptureWorkerResult = {
  storageKey: string;
  filename: string;
  role: "thumbnail";
  mimeType: "image/jpeg";
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
};

export type PageCaptureWorker = {
  capture(input: PageCaptureWorkerInput): Promise<PageCaptureWorkerResult>;
  readImage(input: {
    hostname: string;
    organizationId: string;
    projectId: string;
    artifactId: string;
    artifactVersionId: string;
    filename: string;
  }): Promise<Response>;
};

export type PageCaptureConfig = {
  viewport: { width: number; height: number; deviceScaleFactor: number };
  format: "jpeg";
  quality: number;
  timeoutMs: number;
};

export function pageCaptureWorkerFromEnv(fetchImpl: typeof fetch = fetch): PageCaptureWorker {
  const controlToken = getPagesControlToken();
  if (!controlToken) throw new ConsoleApiError(503, { error: "pages_capture_not_configured" });

  return {
    async capture(input) {
      const endpoint = new URL("/_ravi/internal/captures", `https://${input.hostname}`);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${controlToken}`,
          "content-type": "application/json",
          "x-request-id": input.captureSetId,
        },
        body: JSON.stringify({
          organizationId: input.organizationId,
          projectId: input.projectId,
          captureSetId: input.captureSetId,
          captureArtifactId: input.captureArtifactId,
          captureArtifactVersionId: input.captureArtifactVersionId,
          path: input.path,
          pagesSession: input.pagesSession,
          mode: DEFAULT_CAPTURE_MODE,
          config: input.config,
        }),
      });
      const payload = await readJsonRecord(response);
      if (!response.ok) throw new PageCaptureWorkerError(workerFailureCode(response.status, payload));
      return parseWorkerResult(payload);
    },

    async readImage(input) {
      const endpoint = new URL(
        `/_ravi/internal/captures/${input.organizationId}/${input.projectId}/${input.artifactId}/${input.artifactVersionId}/${encodeURIComponent(input.filename)}`,
        `https://${input.hostname}`,
      );
      return fetchImpl(endpoint, {
        headers: {
          authorization: `Bearer ${controlToken}`,
          accept: "image/*",
        },
      });
    },
  };
}

export async function createPageCapture({
  input,
  planned,
  projectRef,
  repository = pageCaptureRepositoryForDb(),
  requestId,
  worker,
  workspace,
  findProject = findAccessibleProjectRecord,
  createSession = createPagesCaptureSession,
  expireSession = expirePagesCaptureSession,
}: {
  input: unknown;
  /** The page and version the caller planned for; when the path serves something else by now, nothing is captured. */
  planned?: { routeId: string; artifactVersionId: string };
  projectRef: string;
  repository?: PageCaptureRepository;
  requestId: string;
  worker?: PageCaptureWorker;
  workspace: PageCaptureWorkspace;
  findProject?: typeof findAccessibleProjectRecord;
  createSession?: typeof createPagesCaptureSession;
  expireSession?: typeof expirePagesCaptureSession;
}) {
  const parsed = parseCreateCaptureInput(input);
  const project = await findProject(workspace, projectRef, "write");
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });

  const normalizedPath = validateRoutePath(parsed.path);
  if (!normalizedPath.ok) throw new ConsoleApiError(400, { error: "invalid_path" });
  const target = await repository.findPublishedTarget({
    organizationId: workspace.organization.id,
    path: normalizedPath.path,
    projectId: project.id,
    siteRef: parsed.siteRef,
  });
  if (!target) throw new ConsoleApiError(404, { error: "page_not_found" });
  if (
    planned &&
    (target.releaseRoute.routeId !== planned.routeId || target.releaseRoute.artifactVersionId !== planned.artifactVersionId)
  ) {
    throw new ConsoleApiError(409, { error: "page_changed" });
  }

  const idempotencyKey = parsed.idempotencyKey ?? randomUUID();
  const existing = await repository.findByIdempotency({
    organizationId: workspace.organization.id,
    projectId: project.id,
    idempotencyKey,
  });
  const config = defaultCaptureConfig();
  const configHash = captureConfigHash(config);
  if (existing) {
    assertCaptureIdempotencyMatch(existing, target, configHash);
    return hydrateCapture(existing, await repository.listImages(existing.id), projectRef);
  }
  const captureId = randomUUID();
  const captureArtifactId = randomUUID();
  const captureArtifactVersionId = randomUUID();
  const actorType = workspace.mode === "anonymous" ? "anonymous" : "user";
  try {
    await repository.createPending({
      capture: {
        id: captureId,
        organizationId: workspace.organization.id,
        projectId: project.id,
        siteId: target.site.id,
        routeId: target.releaseRoute.routeId,
        releaseId: target.release.id,
        releaseRouteId: target.releaseRoute.id,
        sourceArtifactId: target.releaseRoute.artifactId,
        sourceArtifactVersionId: target.releaseRoute.artifactVersionId,
        captureArtifactId,
        captureArtifactVersionId,
        mode: DEFAULT_CAPTURE_MODE,
        provider: CAPTURE_PROVIDER,
        configHash,
        configJson: config,
        idempotencyKey,
        requestedByActorType: actorType,
        requestedByActorId: workspace.user.id,
      },
      artifact: {
        id: captureArtifactId,
        projectId: project.id,
        slug: `page-capture-${captureId}`,
        name: `${target.site.defaultHostname}${normalizedPath.path} thumbnail`,
        description: "Ravi Pages screenshot thumbnail",
        metadataJson: {
          kind: "pages.capture",
          captureSetId: captureId,
          siteId: target.site.id,
          routeId: target.releaseRoute.routeId,
        },
      },
      version: {
        id: captureArtifactVersionId,
        artifactId: captureArtifactId,
        sourceJson: {
          kind: "pages.capture",
          siteId: target.site.id,
          routeId: target.releaseRoute.routeId,
          releaseId: target.release.id,
          releaseRouteId: target.releaseRoute.id,
          sourceArtifactId: target.releaseRoute.artifactId,
          sourceArtifactVersionId: target.releaseRoute.artifactVersionId,
        },
        metadataJson: { captureSetId: captureId, configHash },
        createdByActorType: actorType,
        createdByActorId: workspace.user.id,
      },
      requestId,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await repository.findByIdempotency({
      organizationId: workspace.organization.id,
      projectId: project.id,
      idempotencyKey,
    });
    if (!raced) throw error;
    assertCaptureIdempotencyMatch(raced, target, configHash);
    return hydrateCapture(raced, await repository.listImages(raced.id), projectRef);
  }

  let session: Awaited<ReturnType<typeof createPagesCaptureSession>> | null = null;
  try {
    session = await createSession({
      requireBrowserSession: workspace.mode === "oidc",
      browserSessionId: workspace.browserSessionId,
      requestId,
      site: target.site,
      userId: workspace.user.id,
    });
    await repository.markCapturing(captureId, new Date());
    const runner = worker ?? pageCaptureWorkerFromEnv();
    const result = await runner.capture({
      hostname: target.site.defaultHostname,
      organizationId: workspace.organization.id,
      projectId: project.id,
      captureSetId: captureId,
      captureArtifactId,
      captureArtifactVersionId,
      path: normalizedPath.path,
      pagesSession: session.sessionToken,
      config,
    });
    if (result.sizeBytes > MAX_IMAGE_BYTES) throw new PageCaptureWorkerError("capture_image_too_large");
    const ready = await repository.markReady({
      captureId,
      artifactId: captureArtifactId,
      artifactVersionId: captureArtifactVersionId,
      assetId: randomUUID(),
      imageId: randomUUID(),
      organizationId: workspace.organization.id,
      projectId: project.id,
      requestedByActorId: workspace.user.id,
      requestId,
      result,
    });
    return hydrateCapture(ready, await repository.listImages(ready.id), projectRef);
  } catch (error) {
    const failureCode = captureFailureCode(error);
    await repository.markFailed({
      captureId,
      artifactVersionId: captureArtifactVersionId,
      failureCode,
      metadataJson: { provider: CAPTURE_PROVIDER },
      organizationId: workspace.organization.id,
      projectId: project.id,
      requestedByActorId: workspace.user.id,
      requestId,
    });
    throw new ConsoleApiError(503, {
      error: "page_capture_failed",
      fieldErrors: { captureId, code: failureCode },
    });
  } finally {
    if (session) {
      await expireSession({ requestId, sessionId: session.sessionId }).catch(() => undefined);
    }
  }
}

export async function getPageCapture({
  captureId,
  projectRef,
  repository = pageCaptureRepositoryForDb(),
  workspace,
  findProject = findAccessibleProjectRecord,
}: {
  captureId: string;
  projectRef: string;
  repository?: PageCaptureRepository;
  workspace: PageCaptureWorkspace;
  findProject?: typeof findAccessibleProjectRecord;
}) {
  const project = await findProject(workspace, projectRef, "read");
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });
  const capture = await repository.findById({ captureId, projectId: project.id });
  if (!capture) throw new ConsoleApiError(404, { error: "capture_not_found" });
  return hydrateCapture(capture, await repository.listImages(capture.id), projectRef);
}

export async function getPageCaptureImage({
  captureId,
  projectRef,
  repository = pageCaptureRepositoryForDb(),
  sequence,
  worker,
  workspace,
  findProject = findAccessibleProjectRecord,
}: {
  captureId: string;
  projectRef: string;
  repository?: PageCaptureRepository;
  sequence: number;
  worker?: PageCaptureWorker;
  workspace: PageCaptureWorkspace;
  findProject?: typeof findAccessibleProjectRecord;
}) {
  const project = await findProject(workspace, projectRef, "read");
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });
  const row = await repository.findImage({ captureId, projectId: project.id, sequence });
  if (!row || !row.capture.captureArtifactId || !row.capture.captureArtifactVersionId) {
    throw new ConsoleApiError(404, { error: "capture_image_not_found" });
  }
  const runner = worker ?? pageCaptureWorkerFromEnv();
  const response = await runner.readImage({
    hostname: row.hostname,
    organizationId: row.capture.organizationId,
    projectId: row.capture.projectId,
    artifactId: row.capture.captureArtifactId,
    artifactVersionId: row.capture.captureArtifactVersionId,
    filename: row.asset.path,
  });
  if (!response.ok) throw new ConsoleApiError(response.status === 404 ? 404 : 503, { error: "capture_image_unavailable" });
  return { response, image: row.image, asset: row.asset };
}

export type PageThumbnailSummary = {
  captureId: string;
  state: "current" | "stale";
  sourceArtifactVersionId: string;
  capturedAt: number;
  image: {
    sequence: number;
    width: number;
    height: number;
    mimeType: string;
    sizeBytes: number;
  };
};

export async function listLatestPageThumbnails(input: {
  projectId: string;
  routes: Array<{ routeId: string; artifactVersionId: string }>;
}): Promise<Map<string, PageThumbnailSummary>> {
  if (input.routes.length === 0) return new Map();
  const routeIds = [...new Set(input.routes.map((route) => route.routeId))];
  const rows = await db
    .select({ capture: schema.pageCaptureSets, image: schema.pageCaptureImages })
    .from(schema.pageCaptureSets)
    .innerJoin(schema.pageCaptureImages, eq(schema.pageCaptureImages.captureSetId, schema.pageCaptureSets.id))
    .where(
      and(
        eq(schema.pageCaptureSets.projectId, input.projectId),
        eq(schema.pageCaptureSets.status, "ready"),
        eq(schema.pageCaptureSets.mode, "thumbnail"),
        eq(schema.pageCaptureImages.role, "thumbnail"),
        eq(schema.pageCaptureImages.sequence, 0),
        inArray(schema.pageCaptureSets.routeId, routeIds),
      ),
    )
    .orderBy(desc(schema.pageCaptureSets.completedAt), desc(schema.pageCaptureSets.createdAt));

  const activeVersionByRoute = new Map(input.routes.map((route) => [route.routeId, route.artifactVersionId]));
  const current = new Map<string, PageThumbnailSummary>();
  const stale = new Map<string, PageThumbnailSummary>();
  for (const { capture, image } of rows) {
    const summary: PageThumbnailSummary = {
      captureId: capture.id,
      state: activeVersionByRoute.get(capture.routeId) === capture.sourceArtifactVersionId ? "current" : "stale",
      sourceArtifactVersionId: capture.sourceArtifactVersionId,
      capturedAt: (capture.completedAt ?? capture.createdAt).getTime(),
      image: {
        sequence: image.sequence,
        width: image.width,
        height: image.height,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
      },
    };
    if (summary.state === "current" && !current.has(capture.routeId)) current.set(capture.routeId, summary);
    if (summary.state === "stale" && !stale.has(capture.routeId)) stale.set(capture.routeId, summary);
  }
  return new Map(routeIds.flatMap((routeId) => {
    const summary = current.get(routeId) ?? stale.get(routeId);
    return summary ? [[routeId, summary] as const] : [];
  }));
}

function parseCreateCaptureInput(input: unknown) {
  const schema = z.object({
    siteRef: z.string().trim().min(1).max(160).optional(),
    path: z.string().trim().min(1).max(2048).default("/"),
    mode: z.enum(["thumbnail", "full_page", "segmented"]).default("thumbnail"),
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
  });
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw new ConsoleApiError(400, { error: "validation_failed" });
  if (parsed.data.mode !== "thumbnail") {
    throw new ConsoleApiError(400, {
      error: "capture_mode_not_supported",
      fieldErrors: { mode: "Only thumbnail capture is available now." },
    });
  }
  return { ...parsed.data, mode: DEFAULT_CAPTURE_MODE };
}

function defaultCaptureConfig(): PageCaptureConfig {
  return {
    viewport: { ...DEFAULT_VIEWPORT },
    format: DEFAULT_FORMAT,
    quality: DEFAULT_QUALITY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

/** The configuration hash every default thumbnail capture carries. */
export function defaultThumbnailConfigHash() {
  return captureConfigHash(defaultCaptureConfig());
}

function captureConfigHash(config: PageCaptureConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function assertCaptureIdempotencyMatch(
  capture: CaptureSetRecord,
  target: PageCaptureTarget,
  configHash: string,
) {
  if (
    capture.siteId !== target.site.id ||
    capture.routeId !== target.releaseRoute.routeId ||
    capture.sourceArtifactVersionId !== target.releaseRoute.artifactVersionId ||
    capture.mode !== DEFAULT_CAPTURE_MODE ||
    capture.configHash !== configHash
  ) {
    throw new ConsoleApiError(409, { error: "capture_idempotency_conflict" });
  }
}

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.code === "23505" || record.constraint === "page_capture_sets_project_idempotency_unique";
}

function hydrateCapture(capture: CaptureSetRecord, images: PageCaptureImageWithAsset[], projectRef: string) {
  return {
    id: capture.id,
    status: capture.status,
    mode: capture.mode,
    provider: capture.provider,
    projectId: capture.projectId,
    siteId: capture.siteId,
    routeId: capture.routeId,
    releaseId: capture.releaseId,
    releaseRouteId: capture.releaseRouteId,
    sourceArtifactId: capture.sourceArtifactId,
    sourceArtifactVersionId: capture.sourceArtifactVersionId,
    captureArtifactId: capture.captureArtifactId,
    captureArtifactVersionId: capture.captureArtifactVersionId,
    failureCode: capture.failureCode,
    createdAt: capture.createdAt.toISOString(),
    completedAt: capture.completedAt?.toISOString() ?? null,
    images: images.map(({ image, asset }) => ({
      id: image.id,
      sequence: image.sequence,
      role: image.role,
      width: image.width,
      height: image.height,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      sha256: image.sha256,
      assetId: asset.id,
      downloadPath: `/api/cli/projects/${encodeURIComponent(projectRef)}/pages/captures/${capture.id}/images/${image.sequence}`,
      consolePath: `/api/console/projects/${encodeURIComponent(projectRef)}/pages/captures/${capture.id}/images/${image.sequence}`,
    })),
  };
}

function parseWorkerResult(payload: Record<string, unknown>): PageCaptureWorkerResult {
  const schema = z.object({
    storageKey: z.string().min(1),
    filename: z.literal(CAPTURE_FILENAME),
    role: z.literal("thumbnail"),
    mimeType: z.literal("image/jpeg"),
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
    sizeBytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new PageCaptureWorkerError("capture_invalid_response");
  return parsed.data;
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload = await response.json();
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function workerFailureCode(status: number, payload: Record<string, unknown>) {
  const code = typeof payload.error === "string" ? payload.error : null;
  if (code && /^[a-z0-9_]{3,80}$/.test(code)) return code;
  if (status === 429) return "capture_rate_limited";
  if (status === 401 || status === 403) return "capture_worker_unauthorized";
  return "capture_worker_failed";
}

function captureFailureCode(error: unknown) {
  if (error instanceof PageCaptureWorkerError) return error.code;
  if (error instanceof ConsoleApiError && typeof error.payload.error === "string") return error.payload.error;
  return "capture_failed";
}

class PageCaptureWorkerError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function effectiveVisibility(siteVisibility: PageVisibility, routeVisibility: PageVisibility): PageVisibility {
  if (routeVisibility !== "public") return routeVisibility;
  return siteVisibility === "public" ? "public" : siteVisibility;
}
