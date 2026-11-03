import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { findAccessibleProjectRecord, type ProjectAccessWorkspace } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import { createPageCapture, defaultThumbnailConfigHash } from "./captures";

/** Routes one request may ask about; the Pages screen sends its pages in batches of this size. */
export const MAX_THUMBNAIL_ROUTES = 6;
/** Captures that run at once for one request. Each holds a browser for a few seconds. */
const CAPTURE_CONCURRENCY = 3;
/** A capture still pending after this long died with its request and may be tried again. */
const ABANDONED_AFTER_MS = 3 * 60_000;
/** Attempts per page version, so a page that never renders doesn't cost a browser on every visit. */
const MAX_ATTEMPTS = 3;

type ThumbnailWorkspace = ProjectAccessWorkspace & { mode?: "workos" | "oidc" | "anonymous" };

export type PageThumbnailRequestState = "ready" | "pending" | "failed";

export type PageThumbnailRequestResult = {
  items: Array<{ routeId: string; state: PageThumbnailRequestState }>;
};

type CaptureAttempt = Pick<
  typeof schema.pageCaptureSets.$inferSelect,
  "routeId" | "sourceArtifactVersionId" | "status" | "createdAt"
>;

type ThumbnailTarget = { routeId: string; siteId: string; path: string; artifactVersionId: string };

type ThumbnailJob = ThumbnailTarget & { idempotencyKey: string };

/**
 * One idempotency key per page version and attempt, so viewing a page again
 * never captures it again and two people opening the screen at once share one
 * capture. A rollback costs nothing: the older version's capture is current again.
 */
export function pageThumbnailIdempotencyKey(input: { routeId: string; artifactVersionId: string; attempt: number }) {
  return `thumb:v1:${input.routeId}:${input.artifactVersionId}:${defaultThumbnailConfigHash().slice(0, 16)}:${input.attempt}`;
}

/**
 * What to do for one page given its capture attempts for the version it serves
 * now: nothing (a capture is ready, one is running, or it failed and wasn't
 * retried), or a new attempt with its number.
 */
export function planPageThumbnail(input: {
  attempts: CaptureAttempt[];
  now: Date;
  retry: boolean;
}): { state: PageThumbnailRequestState; attempt: number | null } {
  const attempts = [...input.attempts].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  if (attempts.some((attempt) => attempt.status === "ready")) return { state: "ready", attempt: null };
  const latest = attempts[0];
  const running =
    latest &&
    (latest.status === "pending" || latest.status === "capturing") &&
    input.now.getTime() - latest.createdAt.getTime() < ABANDONED_AFTER_MS;
  if (running) return { state: "pending", attempt: null };
  if (attempts.length >= MAX_ATTEMPTS) return { state: "failed", attempt: null };
  if (latest?.status === "failed" && !input.retry) return { state: "failed", attempt: null };
  return { state: "pending", attempt: attempts.length + 1 };
}

const requestSchema = z.object({
  routeIds: z.array(z.string().uuid()).min(1).max(MAX_THUMBNAIL_ROUTES),
  retry: z.boolean().default(false),
});

/**
 * Starts thumbnail captures for published pages that have none for the content
 * they serve now. Capturing creates artifacts and uses a metered browser, so it
 * needs project write permission, like `POST /api/cli/.../pages/captures`.
 * Captures run after the response through `schedule`; their state shows up in
 * the published pages read (`thumbnail.attempt`).
 */
export async function requestPageThumbnails({
  input,
  now = new Date(),
  projectRef,
  requestId,
  schedule,
  capture = createPageCapture,
  workspace,
}: {
  input: unknown;
  now?: Date;
  projectRef: string;
  requestId: string;
  schedule: (task: () => Promise<void>) => void;
  capture?: typeof createPageCapture;
  workspace: ThumbnailWorkspace;
}): Promise<PageThumbnailRequestResult> {
  const parsed = requestSchema.safeParse(input ?? {});
  if (!parsed.success) throw new ConsoleApiError(400, { error: "validation_failed" });

  const readable = await findAccessibleProjectRecord(workspace, projectRef, "read");
  if (!readable) throw new ConsoleApiError(404, { error: "project_not_found" });
  const project = await findAccessibleProjectRecord(workspace, projectRef, "write");
  if (!project) throw new ConsoleApiError(403, { error: "forbidden" });

  const routeIds = [...new Set(parsed.data.routeIds)];
  const targets = await listActiveRouteTargets({ organizationId: workspace.organization.id, projectId: project.id, routeIds });
  const attempts = await listThumbnailAttempts({ projectId: project.id, targets });

  const items: PageThumbnailRequestResult["items"] = [];
  const jobs: ThumbnailJob[] = [];
  for (const target of targets) {
    const plan = planPageThumbnail({
      attempts: attempts.filter(
        (attempt) => attempt.routeId === target.routeId && attempt.sourceArtifactVersionId === target.artifactVersionId,
      ),
      now,
      retry: parsed.data.retry,
    });
    items.push({ routeId: target.routeId, state: plan.state });
    if (plan.attempt !== null) {
      jobs.push({
        ...target,
        idempotencyKey: pageThumbnailIdempotencyKey({ ...target, attempt: plan.attempt }),
      });
    }
  }

  if (jobs.length > 0) {
    schedule(() =>
      runWithConcurrency(jobs, CAPTURE_CONCURRENCY, async (job) => {
        await capture({
          // A publish while this job waited for a slot changes what the path serves: then this key isn't for it.
          planned: { routeId: job.routeId, artifactVersionId: job.artifactVersionId },
          input: { siteRef: job.siteId, path: job.path, mode: "thumbnail", idempotencyKey: job.idempotencyKey },
          projectRef: project.id,
          requestId: `${requestId}:${job.routeId}`,
          workspace,
        }).catch((error: unknown) => {
          // The newer version gets its own request; nothing to report.
          if (error instanceof ConsoleApiError && error.payload.error === "page_changed") return;
          // A failed capture is recorded as failed on its capture set; the page keeps its placeholder.
          console.warn("Ravi Pages thumbnail capture failed", {
            requestId,
            routeId: job.routeId,
            error: error instanceof ConsoleApiError ? error.payload : String(error),
          });
        });
      }),
    );
  }

  return { items };
}

/** The pages of a project's active hosts that serve one of these routes now. */
async function listActiveRouteTargets(input: {
  organizationId: string;
  projectId: string;
  routeIds: string[];
}): Promise<ThumbnailTarget[]> {
  if (input.routeIds.length === 0) return [];
  const rows = await db
    .select({
      routeId: schema.pageReleaseRoutes.routeId,
      siteId: schema.pageSites.id,
      path: schema.pageReleaseRoutes.path,
      artifactVersionId: schema.pageReleaseRoutes.artifactVersionId,
    })
    .from(schema.pageReleaseRoutes)
    .innerJoin(schema.pageSites, eq(schema.pageSites.activeReleaseId, schema.pageReleaseRoutes.releaseId))
    .where(
      and(
        eq(schema.pageSites.organizationId, input.organizationId),
        eq(schema.pageSites.projectId, input.projectId),
        eq(schema.pageSites.status, "active"),
        inArray(schema.pageReleaseRoutes.routeId, input.routeIds),
      ),
    );
  return rows;
}

/**
 * Capture attempts for the versions these pages serve now. Older versions'
 * attempts are left out in the query, since every route collects them on each
 * publish; callers still match route and version together.
 */
async function listThumbnailAttempts(input: {
  projectId: string;
  targets: Array<{ routeId: string; artifactVersionId: string }>;
}): Promise<CaptureAttempt[]> {
  if (input.targets.length === 0) return [];
  return db
    .select({
      routeId: schema.pageCaptureSets.routeId,
      sourceArtifactVersionId: schema.pageCaptureSets.sourceArtifactVersionId,
      status: schema.pageCaptureSets.status,
      createdAt: schema.pageCaptureSets.createdAt,
    })
    .from(schema.pageCaptureSets)
    .where(
      and(
        eq(schema.pageCaptureSets.projectId, input.projectId),
        eq(schema.pageCaptureSets.mode, "thumbnail"),
        inArray(schema.pageCaptureSets.routeId, [...new Set(input.targets.map((target) => target.routeId))]),
        inArray(schema.pageCaptureSets.sourceArtifactVersionId, [
          ...new Set(input.targets.map((target) => target.artifactVersionId)),
        ]),
      ),
    )
    .orderBy(desc(schema.pageCaptureSets.createdAt));
}

async function runWithConcurrency<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await run(item);
    }
  });
  await Promise.all(workers);
}

export type PageThumbnailAttemptSummary = {
  status: "pending" | "failed";
  at: number;
  /** A failed version with attempts left; a person's "Try again" can start one more. */
  retryable: boolean;
};

/**
 * For pages with no ready capture of the content they serve now: whether one
 * is being taken or the last try failed, and whether it can be tried again.
 * Abandoned captures read as neither, so the screen asks again.
 */
export async function listPageThumbnailAttempts(input: {
  now?: Date;
  projectId: string;
  routes: Array<{ routeId: string; artifactVersionId: string }>;
}): Promise<Map<string, PageThumbnailAttemptSummary>> {
  const now = input.now ?? new Date();
  const attempts = await listThumbnailAttempts({ projectId: input.projectId, targets: input.routes });
  const result = new Map<string, PageThumbnailAttemptSummary>();
  for (const route of input.routes) {
    const summary = summarizeThumbnailAttempts(
      attempts.filter(
        (attempt) => attempt.routeId === route.routeId && attempt.sourceArtifactVersionId === route.artifactVersionId,
      ),
      now,
    );
    if (summary) result.set(route.routeId, summary);
  }
  return result;
}

/**
 * The attempt state the screen shows for one page version: nothing when a
 * capture is ready or the screen should ask for one, otherwise pending or
 * failed, and whether "Try again" can still start one.
 */
export function summarizeThumbnailAttempts(attempts: CaptureAttempt[], now: Date): PageThumbnailAttemptSummary | null {
  const plan = planPageThumbnail({ attempts, now, retry: false });
  const latest = [...attempts].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  if (!latest || plan.state === "ready" || plan.attempt !== null) return null;
  return {
    status: plan.state,
    at: latest.createdAt.getTime(),
    retryable: plan.state === "failed" && attempts.length < MAX_ATTEMPTS,
  };
}

/**
 * After a release goes live: captures the host's most recently published pages
 * that have no capture of what they serve now, as the publisher. Runs after the
 * publish response and never affects the release.
 */
export async function refreshSiteThumbnails({
  capture,
  requestId,
  siteId,
  workspace,
}: {
  capture?: typeof createPageCapture;
  requestId: string;
  siteId: string;
  workspace: ThumbnailWorkspace;
}) {
  const routes = await db
    .select({ routeId: schema.pageReleaseRoutes.routeId, projectId: schema.pageSites.projectId })
    .from(schema.pageReleaseRoutes)
    .innerJoin(schema.pageSites, eq(schema.pageSites.activeReleaseId, schema.pageReleaseRoutes.releaseId))
    .innerJoin(schema.artifactVersions, eq(schema.artifactVersions.id, schema.pageReleaseRoutes.artifactVersionId))
    .where(and(eq(schema.pageSites.id, siteId), eq(schema.pageSites.organizationId, workspace.organization.id)))
    .orderBy(desc(schema.artifactVersions.createdAt))
    .limit(MAX_THUMBNAIL_ROUTES);
  const projectId = routes[0]?.projectId;
  if (!projectId) return;
  let task: (() => Promise<void>) | null = null;
  await requestPageThumbnails({
    capture,
    input: { routeIds: routes.map((route) => route.routeId) },
    projectRef: projectId,
    requestId,
    schedule: (scheduled) => {
      task = scheduled;
    },
    workspace,
  });
  if (task) await (task as () => Promise<void>)();
}
