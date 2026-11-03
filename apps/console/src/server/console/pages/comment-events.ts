// Agent Inbox producer for Page comments (SPEC console/pages/operator-overlay,
// "Comment events"). A new comment or reply becomes one `page.comment.created`
// item for the local installation that uploaded the commented artifact version
// (`artifact_versions.source_json.localInstallationId`, written by CLI publish).
// Nothing is emitted when that installation is unknown, revoked, outside the
// site organization, or its user can no longer read the project.

import { eq } from "drizzle-orm";

import { AGENT_INBOX_TARGET_LOCAL_INSTALLATION, recordAgentInboxItem } from "@/server/console/agent-inbox";
import { storedActorCan } from "@/server/console/authorization/stored-actor";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

export const PAGE_COMMENT_CREATED_EVENT_TYPE = "page.comment.created";
export const PAGE_COMMENT_EVENT_CATEGORY = "pages";
export const PAGE_COMMENT_SOURCE_TYPE = "page_comment";

type InboxInsert = typeof schema.agentInboxItems.$inferInsert;

export type PageCommentEventComment = {
  id: string;
  body: string;
  path: string;
  organizationId: string;
  projectId: string;
  siteId: string;
  routeId: string | null;
  routePath: string | null;
  releaseId: string | null;
  artifactVersionId: string | null;
  parentId: string | null;
  target: JsonRecord;
  createdAt: Date;
  author: { id: string | null; displayName: string | null };
};

export type PageCommentEventStore = {
  findComment(commentId: string): Promise<PageCommentEventComment | null>;
  /** The installation that uploaded the artifact version, when it may still receive project events. */
  findPublishingInstallation(input: {
    artifactVersionId: string;
    organizationId: string;
    projectId: string;
  }): Promise<string | null>;
  recordInboxItem(item: InboxInsert): Promise<unknown>;
};

export type PageCommentEventOutcome =
  | { status: "recorded"; installationId: string }
  | { status: "skipped"; reason: "comment_not_found" | "no_artifact_version" | "no_publishing_installation" };

export function pageCommentCreatedDedupeKey(input: { organizationId: string; commentId: string; installationId: string }) {
  return `page:comment:${input.organizationId}:${input.commentId}:created:${input.installationId}`;
}

export function pageCommentUrl(host: string, path: string) {
  return `https://${host}${path}`;
}

export function buildPageCommentCreatedInboxItem(input: {
  comment: PageCommentEventComment;
  host: string;
  installationId: string;
}): InboxInsert {
  const { comment } = input;
  const url = pageCommentUrl(input.host, comment.path);
  const author = comment.author.displayName ?? null;
  return {
    organizationId: comment.organizationId,
    projectId: comment.projectId,
    sourceType: PAGE_COMMENT_SOURCE_TYPE,
    sourceId: comment.id,
    eventType: PAGE_COMMENT_CREATED_EVENT_TYPE,
    category: PAGE_COMMENT_EVENT_CATEGORY,
    severity: "info",
    sensitivity: "customer_data",
    title: comment.parentId ? `New reply on ${comment.path}` : `New comment on ${comment.path}`,
    summary: comment.body.slice(0, 240),
    actorType: "user",
    actorId: comment.author.id,
    targetType: AGENT_INBOX_TARGET_LOCAL_INSTALLATION,
    targetId: input.installationId,
    dedupeKey: pageCommentCreatedDedupeKey({
      organizationId: comment.organizationId,
      commentId: comment.id,
      installationId: input.installationId,
    }),
    payloadJson: {
      // `pageId` is the site id: the OSS comment follow filters on it.
      pageId: comment.siteId,
      siteId: comment.siteId,
      orgId: comment.organizationId,
      projectId: comment.projectId,
      host: input.host,
      path: comment.path,
      routeId: comment.routeId,
      routePath: comment.routePath ?? routePathFromPagePath(comment.path),
      releaseId: comment.releaseId,
      commentId: comment.id,
      parentId: comment.parentId,
      body: comment.body,
      url,
      author: { id: comment.author.id, displayName: author },
      target: compactTarget(comment.target),
    },
    linksJson: [{ label: "Page", url }] as unknown as JsonRecord,
    occurredAt: comment.createdAt,
  };
}

/**
 * Records the inbox item for a comment just created on `host`. Best effort:
 * the caller already saved the comment, so a failure here is logged, never
 * returned to the person commenting.
 */
export async function emitPageCommentCreated(
  input: { commentId: string; host: string; requestId: string },
  store: PageCommentEventStore = pageCommentEventStoreForDb(),
): Promise<PageCommentEventOutcome | null> {
  try {
    const comment = await store.findComment(input.commentId);
    if (!comment) return { status: "skipped", reason: "comment_not_found" };
    if (!comment.artifactVersionId) return { status: "skipped", reason: "no_artifact_version" };
    const installationId = await store.findPublishingInstallation({
      artifactVersionId: comment.artifactVersionId,
      organizationId: comment.organizationId,
      projectId: comment.projectId,
    });
    if (!installationId) return { status: "skipped", reason: "no_publishing_installation" };
    await store.recordInboxItem(buildPageCommentCreatedInboxItem({ comment, host: input.host, installationId }));
    return { status: "recorded", installationId };
  } catch (error) {
    console.warn("Ravi Pages comment inbox event failed", { requestId: input.requestId, error: String(error) });
    return null;
  }
}

export function pageCommentEventStoreForDb(database = db): PageCommentEventStore {
  return {
    async findComment(commentId) {
      const [row] = await database
        .select({
          id: schema.pageComments.id,
          body: schema.pageComments.body,
          path: schema.pageComments.path,
          organizationId: schema.pageComments.organizationId,
          projectId: schema.pageComments.projectId,
          siteId: schema.pageComments.siteId,
          routeId: schema.pageComments.routeId,
          routePath: schema.pageRoutes.path,
          releaseId: schema.pageComments.releaseId,
          artifactVersionId: schema.pageComments.artifactVersionId,
          metadataJson: schema.pageComments.metadataJson,
          targetJson: schema.pageComments.targetJson,
          createdAt: schema.pageComments.createdAt,
          createdByUserId: schema.pageComments.createdByUserId,
          createdByDisplayName: schema.users.displayName,
        })
        .from(schema.pageComments)
        .leftJoin(schema.pageRoutes, eq(schema.pageRoutes.id, schema.pageComments.routeId))
        .leftJoin(schema.users, eq(schema.users.id, schema.pageComments.createdByUserId))
        .where(eq(schema.pageComments.id, commentId))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        body: row.body,
        path: row.path,
        organizationId: row.organizationId,
        projectId: row.projectId,
        siteId: row.siteId,
        routeId: row.routeId,
        routePath: row.routePath ?? null,
        releaseId: row.releaseId,
        artifactVersionId: row.artifactVersionId,
        parentId: typeof row.metadataJson.parentId === "string" ? row.metadataJson.parentId : null,
        target: row.targetJson,
        createdAt: row.createdAt,
        author: { id: row.createdByUserId, displayName: row.createdByDisplayName ?? null },
      };
    },
    async findPublishingInstallation(input) {
      const [version] = await database
        .select({ sourceJson: schema.artifactVersions.sourceJson })
        .from(schema.artifactVersions)
        .where(eq(schema.artifactVersions.id, input.artifactVersionId))
        .limit(1);
      const installationId = installationIdFromSource(version?.sourceJson);
      if (!installationId) return null;

      // Resolve the original authenticated author, never the installation owner.
      return await storedActorCan(database, version?.sourceJson.projectAuthorization, { ...input, installationId }, "project.read") ? installationId : null;
    },
    async recordInboxItem(item) {
      return recordAgentInboxItem(item);
    },
  };
}

function installationIdFromSource(source: unknown): string | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const value = (source as Record<string, unknown>).localInstallationId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** `/weekly/` (the address the Worker redirects to) is the `/weekly` route. */
function routePathFromPagePath(path: string) {
  return path.replace(/\/+$/g, "") || "/";
}

function compactTarget(target: JsonRecord): JsonRecord {
  return {
    ...(typeof target.tag === "string" ? { tag: target.tag } : {}),
    ...(typeof target.selector === "string" ? { selector: target.selector } : {}),
    ...(typeof target.text === "string" ? { text: target.text } : {}),
  };
}
