import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { assertProjectAccess, type ProjectAuthorizationCheck } from "@/server/console/project-access";
import {
  pagesPrivateAuthRepositoryForDb,
  type PagesPrivateAuthRepository,
  verifyPagesSessionForSite,
} from "@/server/console/pages/auth";
import {
  activatePageSiteRelease,
  comparePageSiteReleases,
  createPageSiteRelease,
  getPageSiteReleaseFileDiff,
  pagePublishRepositoryForDb,
  type PagePublishContext,
  type PagePublishRepository,
  type PublishVisibility,
} from "@/server/console/pages/publish";
import { resolvePagesRoute } from "@/server/console/pages/resolve";
import {
  findRequiredPagesPasswordPolicy,
  type PagesPasswordAccessRepository,
} from "@/server/console/pages/password-access";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

export type PagesOperatorVisibilityInput = {
  host: string;
  pagesSession: string;
  path: string;
  requestId: string;
  visibility: PublishVisibility;
};

export type AuthorizedPagesRouteVisibilityInput = {
  context: PagePublishContext;
  release: {
    id: string;
    number: number;
  };
  reason?: string;
  requestId: string;
  route: {
    bindingId: string;
    effectiveVisibility: PublishVisibility;
    id: string;
    path: string;
    visibility: PublishVisibility;
  };
  site: {
    defaultVisibility: PublishVisibility;
    id: string;
    projectId: string;
  };
  visibility: PublishVisibility;
};

type AuthorizedPagesRouteVisibilityDeps = {
  createRelease?: typeof createPageSiteRelease;
  passwordRepository?: PagesPasswordAccessRepository;
  repository?: PagePublishRepository;
};

export type PagesOperatorCommentTarget = JsonRecord;

export type PagesOperatorComment = {
  id: string;
  body: string;
  path: string;
  status: "open" | "resolved" | "deleted";
  target: PagesOperatorCommentTarget;
  parentId: string | null;
  createdAt: string;
  author: {
    id: string | null;
    displayName: string | null;
  };
  release: {
    id: string | null;
  };
};

export type PagesOperatorCommentsInput = {
  host: string;
  pagesSession: string;
  path: string;
  requestId: string;
};

export type CreatePagesOperatorCommentInput = PagesOperatorCommentsInput & {
  body: string;
  parentId?: unknown;
  target?: unknown;
};

export type DeletePagesOperatorCommentInput = PagesOperatorCommentsInput & {
  commentId: string;
};

type PageCommentListRow = {
  id: string;
  body: string;
  path: string;
  status: "open" | "resolved" | "deleted";
  targetJson: JsonRecord;
  metadataJson: JsonRecord;
  createdAt: Date;
  createdByUserId: string | null;
  createdByDisplayName: string | null;
  releaseId: string | null;
};

type PagesOperatorCommentRepository = {
  createComment(input: {
    artifactId: string | null;
    artifactVersionId: string | null;
    body: string;
    createdByUserId: string;
    metadataJson: JsonRecord;
    organizationId: string;
    path: string;
    projectId: string;
    releaseId: string | null;
    releaseRouteId: string | null;
    routeId: string | null;
    siteId: string;
    targetJson: JsonRecord;
  }): Promise<PageCommentListRow>;
  listOpenComments(input: {
    path: string;
    siteId: string;
    limit: number;
  }): Promise<PageCommentListRow[]>;
  findOpenComment(input: {
    commentId: string;
    path: string;
    siteId: string;
  }): Promise<PageCommentListRow | null>;
  deleteComment(input: {
    commentId: string;
    deletedAt: Date;
    deletedByUserId: string;
    metadataJson: JsonRecord;
    path: string;
    siteId: string;
  }): Promise<PageCommentListRow | null>;
};

type CommentDbExecutor = Pick<typeof db, "insert" | "select" | "update">;

export async function updatePagesOperatorRouteVisibility(input: PagesOperatorVisibilityInput) {
  const authRepository = pagesPrivateAuthRepositoryForDb();
  const site = await authRepository.findSiteByHost(input.host);
  if (!site || site.status !== "active") {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  const workspace = await verifyPagesSessionForSite({
    host: input.host,
    repository: authRepository,
    requestId: input.requestId,
    sessionToken: input.pagesSession,
    site,
  });
  if (!workspace) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  const resolved = await resolvePagesRoute({
    input: {
      host: input.host,
      method: "GET",
      pagesSession: input.pagesSession,
      path: input.path,
      requestId: input.requestId,
    },
  });
  if (resolved.status !== "ok" || resolved.site.id !== site.id) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  return updateAuthorizedPagesRouteVisibility({
    context: {
      actorId: workspace.user.id,
      actorType: "user",
      membershipRole: workspace.membership.role,
      organizationId: workspace.organization.id,
    },
    release: resolved.release,
    requestId: input.requestId,
    route: {
      bindingId: resolved.route.bindingId,
      effectiveVisibility: resolved.toolbar?.effectiveVisibility ?? resolved.route.visibility,
      id: resolved.route.id,
      path: resolved.route.path,
      visibility: resolved.route.visibility,
    },
    site: {
      defaultVisibility: resolved.site.visibility,
      id: resolved.site.id,
      projectId: resolved.site.projectId,
    },
    visibility: input.visibility,
  });
}

export async function updateAuthorizedPagesRouteVisibility(
  input: AuthorizedPagesRouteVisibilityInput,
  deps: AuthorizedPagesRouteVisibilityDeps = {},
) {
  const repository = deps.repository ?? pagePublishRepositoryForDb();
  const activeRoutes = await repository.listReleaseRoutes(input.release.id);
  const activeRoute = activeRoutes.find(
    (route) => route.id === input.route.bindingId || route.routeId === input.route.id,
  );
  if (!activeRoute) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  if (input.visibility === "password") {
    const policy = await findRequiredPagesPasswordPolicy({
      repository: deps.passwordRepository,
      routeId: activeRoute.routeId,
      routeVisibility: "password",
      siteId: input.site.id,
      siteVisibility: input.site.defaultVisibility,
    });
    if (!policy) {
      throw new ConsoleApiError(409, { error: "password_policy_required" });
    }
  }

  if (activeRoute.visibility === input.visibility) {
    return {
      changed: false,
      release: {
        id: input.release.id,
        number: input.release.number,
      },
      route: {
        id: input.route.id,
        bindingId: input.route.bindingId,
        effectiveVisibility: input.route.effectiveVisibility,
        path: input.route.path,
        visibility: activeRoute.visibility,
      },
      site: {
        id: input.site.id,
        projectId: input.site.projectId,
      },
    };
  }

  const createRelease = deps.createRelease ?? createPageSiteRelease;
  const result = await createRelease({
    context: input.context,
    input: {
      projectRef: input.site.projectId,
      reason: input.reason ?? "operator_visibility_update",
      routes: [
        {
          artifactId: activeRoute.artifactId,
          artifactVersionId: activeRoute.artifactVersionId,
          assetBase: activeRoute.assetBase,
          entrypoint: activeRoute.entrypoint,
          matchType: activeRoute.matchType,
          path: activeRoute.path,
          priority: activeRoute.priority,
          routeConfigJson: jsonRecord(activeRoute.routeConfigJson),
          visibility: input.visibility,
        },
      ],
      siteRef: input.site.id,
    },
    requestId: input.requestId,
    repository,
    ...(deps.passwordRepository ? { passwordRepository: deps.passwordRepository } : {}),
  });

  const updatedRoute = result.routes.find((route) => route.routeId === activeRoute.routeId) ?? result.routes[0];
  return {
    changed: true,
    release: {
      id: result.release.id,
      number: result.release.releaseNumber,
    },
    route: {
      id: updatedRoute?.routeId ?? input.route.id,
      bindingId: updatedRoute?.id ?? input.route.bindingId,
      effectiveVisibility: effectiveVisibility(result.site.defaultVisibility, updatedRoute?.visibility ?? input.visibility),
      path: updatedRoute?.path ?? input.route.path,
      visibility: updatedRoute?.visibility ?? input.visibility,
    },
    site: {
      id: result.site.id,
      projectId: result.site.projectId,
    },
  };
}

function effectiveVisibility(siteVisibility: PublishVisibility, routeVisibility: PublishVisibility): PublishVisibility {
  if (routeVisibility !== "public") return routeVisibility;
  return siteVisibility === "public" ? "public" : siteVisibility;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function listPagesOperatorComments(
  input: PagesOperatorCommentsInput,
  deps: {
    authRepository?: PagesPrivateAuthRepository;
    /** Current-policy project check; defaults to canAccessProject. */
    canAccessProject?: ProjectAuthorizationCheck;
    commentRepository?: PagesOperatorCommentRepository;
    resolveRoute?: typeof resolvePagesRoute;
  } = {},
): Promise<{ comments: PagesOperatorComment[] }> {
  const authRepository = deps.authRepository ?? pagesPrivateAuthRepositoryForDb();
  const commentRepository = deps.commentRepository ?? pagesOperatorCommentRepositoryForDb();
  const resolved = await resolveOperatorCommentContext(input, {
    authRepository,
    canAccessProject: deps.canAccessProject,
    resolveRoute: deps.resolveRoute ?? resolvePagesRoute,
  });

  const comments = await commentRepository.listOpenComments({
    siteId: resolved.site.id,
    path: resolved.path,
    limit: 100,
  });

  return {
    comments: comments.map(formatOperatorComment),
  };
}

export async function createPagesOperatorComment(
  input: CreatePagesOperatorCommentInput,
  deps: {
    authRepository?: PagesPrivateAuthRepository;
    /** Current-policy project check; defaults to canAccessProject. */
    canAccessProject?: ProjectAuthorizationCheck;
    commentRepository?: PagesOperatorCommentRepository;
    resolveRoute?: typeof resolvePagesRoute;
  } = {},
): Promise<{ comment: PagesOperatorComment }> {
  const body = sanitizeCommentBody(input.body);
  const target = sanitizeCommentTarget(input.target);
  const parentId = sanitizeOptionalCommentId(input.parentId);
  const authRepository = deps.authRepository ?? pagesPrivateAuthRepositoryForDb();
  const commentRepository = deps.commentRepository ?? pagesOperatorCommentRepositoryForDb();
  const resolved = await resolveOperatorCommentContext(input, {
    authRepository,
    canAccessProject: deps.canAccessProject,
    resolveRoute: deps.resolveRoute ?? resolvePagesRoute,
  });

  const parent = parentId
    ? await commentRepository.findOpenComment({
        commentId: parentId,
        path: resolved.path,
        siteId: resolved.site.id,
      })
    : null;
  if (parentId && !parent) {
    throw new ConsoleApiError(404, { error: "comment_not_found" });
  }

  const targetJson = parent ? parent.targetJson : target;
  const comment = await commentRepository.createComment({
    artifactId: resolved.artifact.id,
    artifactVersionId: resolved.artifact.versionId,
    body,
    createdByUserId: resolved.workspace.user.id,
    metadataJson: {
      ...(parent ? { parentId: parent.id } : {}),
      requestId: input.requestId,
      source: "pages_operator_overlay",
    },
    organizationId: resolved.site.organizationId,
    path: resolved.path,
    projectId: resolved.site.projectId,
    releaseId: resolved.release.id,
    releaseRouteId: resolved.route.bindingId,
    routeId: resolved.route.id,
    siteId: resolved.site.id,
    targetJson,
  });

  await authRepository.insertAudit({
    action: parent ? "page_comment.replied" : "page_comment.created",
    actorId: resolved.workspace.user.id,
    actorType: "user",
    metadataJson: {
      host: input.host,
      path: resolved.path,
      parentId: parent?.id,
      releaseId: resolved.release.id,
      routeId: resolved.route.id,
      source: "pages_operator_overlay",
      target: compactCommentTarget(targetJson),
    },
    organizationId: resolved.site.organizationId,
    projectId: resolved.site.projectId,
    requestId: input.requestId,
    targetId: comment.id,
    targetType: "page_comment",
  });

  return {
    comment: formatOperatorComment(comment),
  };
}

export async function deletePagesOperatorComment(
  input: DeletePagesOperatorCommentInput,
  deps: {
    authRepository?: PagesPrivateAuthRepository;
    /** Current-policy project check; defaults to canAccessProject. */
    canAccessProject?: ProjectAuthorizationCheck;
    commentRepository?: PagesOperatorCommentRepository;
    resolveRoute?: typeof resolvePagesRoute;
  } = {},
): Promise<{ comment: PagesOperatorComment }> {
  const commentId = sanitizeCommentId(input.commentId);
  const authRepository = deps.authRepository ?? pagesPrivateAuthRepositoryForDb();
  const commentRepository = deps.commentRepository ?? pagesOperatorCommentRepositoryForDb();
  const resolved = await resolveOperatorCommentContext(input, {
    authRepository,
    canAccessProject: deps.canAccessProject,
    resolveRoute: deps.resolveRoute ?? resolvePagesRoute,
  });

  await assertProjectAccess(resolved.workspace, resolved.site.projectId, "write", deps.canAccessProject);

  const existing = await commentRepository.findOpenComment({
    commentId,
    path: resolved.path,
    siteId: resolved.site.id,
  });
  if (!existing) {
    throw new ConsoleApiError(404, { error: "comment_not_found" });
  }

  const now = new Date();
  const comment = await commentRepository.deleteComment({
    commentId,
    deletedAt: now,
    deletedByUserId: resolved.workspace.user.id,
    metadataJson: {
      ...existing.metadataJson,
      deletedAt: now.toISOString(),
      deletedByUserId: resolved.workspace.user.id,
      requestId: input.requestId,
      source: "pages_operator_overlay",
    },
    path: resolved.path,
    siteId: resolved.site.id,
  });
  if (!comment) {
    throw new ConsoleApiError(404, { error: "comment_not_found" });
  }

  await authRepository.insertAudit({
    action: "page_comment.deleted",
    actorId: resolved.workspace.user.id,
    actorType: "user",
    metadataJson: {
      host: input.host,
      parentId: commentParentId(existing.metadataJson),
      path: resolved.path,
      releaseId: resolved.release.id,
      routeId: resolved.route.id,
      source: "pages_operator_overlay",
      target: compactCommentTarget(existing.targetJson),
    },
    organizationId: resolved.site.organizationId,
    projectId: resolved.site.projectId,
    requestId: input.requestId,
    targetId: comment.id,
    targetType: "page_comment",
  });

  return {
    comment: formatOperatorComment(comment),
  };
}

function pagesOperatorCommentRepositoryForDb(database: CommentDbExecutor = db): PagesOperatorCommentRepository {
  return {
    async createComment(input) {
      const [comment] = await database
        .insert(schema.pageComments)
        .values({
          artifactId: input.artifactId,
          artifactVersionId: input.artifactVersionId,
          body: input.body,
          createdByUserId: input.createdByUserId,
          metadataJson: input.metadataJson,
          organizationId: input.organizationId,
          path: input.path,
          projectId: input.projectId,
          releaseId: input.releaseId,
          releaseRouteId: input.releaseRouteId,
          routeId: input.routeId,
          siteId: input.siteId,
          status: "open",
          targetJson: input.targetJson,
        })
        .returning();

      if (!comment) throw new Error("Failed to create Page comment.");
      return {
        id: comment.id,
        body: comment.body,
        path: comment.path,
        status: comment.status,
        targetJson: comment.targetJson,
        metadataJson: comment.metadataJson,
        createdAt: comment.createdAt,
        createdByUserId: comment.createdByUserId,
        createdByDisplayName: null,
        releaseId: comment.releaseId,
      };
    },

    async listOpenComments(input) {
      return database
        .select({
          id: schema.pageComments.id,
          body: schema.pageComments.body,
          path: schema.pageComments.path,
          status: schema.pageComments.status,
          targetJson: schema.pageComments.targetJson,
          metadataJson: schema.pageComments.metadataJson,
          createdAt: schema.pageComments.createdAt,
          createdByUserId: schema.pageComments.createdByUserId,
          createdByDisplayName: schema.users.displayName,
          releaseId: schema.pageComments.releaseId,
        })
        .from(schema.pageComments)
        .leftJoin(schema.users, eq(schema.pageComments.createdByUserId, schema.users.id))
        .where(
          and(
            eq(schema.pageComments.siteId, input.siteId),
            eq(schema.pageComments.path, input.path),
            eq(schema.pageComments.status, "open"),
          ),
        )
        .orderBy(asc(schema.pageComments.createdAt))
        .limit(input.limit);
    },

    async findOpenComment(input) {
      const [comment] = await database
        .select({
          id: schema.pageComments.id,
          body: schema.pageComments.body,
          path: schema.pageComments.path,
          status: schema.pageComments.status,
          targetJson: schema.pageComments.targetJson,
          metadataJson: schema.pageComments.metadataJson,
          createdAt: schema.pageComments.createdAt,
          createdByUserId: schema.pageComments.createdByUserId,
          createdByDisplayName: schema.users.displayName,
          releaseId: schema.pageComments.releaseId,
        })
        .from(schema.pageComments)
        .leftJoin(schema.users, eq(schema.pageComments.createdByUserId, schema.users.id))
        .where(
          and(
            eq(schema.pageComments.id, input.commentId),
            eq(schema.pageComments.siteId, input.siteId),
            eq(schema.pageComments.path, input.path),
            eq(schema.pageComments.status, "open"),
          ),
        )
        .limit(1);

      return comment ?? null;
    },

    async deleteComment(input) {
      const [comment] = await database
        .update(schema.pageComments)
        .set({
          metadataJson: input.metadataJson,
          resolvedAt: input.deletedAt,
          resolvedByUserId: input.deletedByUserId,
          status: "deleted",
          updatedAt: input.deletedAt,
        })
        .where(
          and(
            eq(schema.pageComments.id, input.commentId),
            eq(schema.pageComments.siteId, input.siteId),
            eq(schema.pageComments.path, input.path),
            eq(schema.pageComments.status, "open"),
          ),
        )
        .returning();

      if (!comment) return null;
      return {
        id: comment.id,
        body: comment.body,
        path: comment.path,
        status: comment.status,
        targetJson: comment.targetJson,
        metadataJson: comment.metadataJson,
        createdAt: comment.createdAt,
        createdByUserId: comment.createdByUserId,
        createdByDisplayName: null,
        releaseId: comment.releaseId,
      };
    },
  };
}

async function resolveOperatorCommentContext(
  input: PagesOperatorCommentsInput,
  deps: {
    authRepository: PagesPrivateAuthRepository;
    canAccessProject?: ProjectAuthorizationCheck;
    resolveRoute: typeof resolvePagesRoute;
  },
) {
  const path = normalizeCommentPath(input.path);
  const site = await deps.authRepository.findSiteByHost(input.host);
  if (!site || site.status !== "active") {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  const workspace = await verifyPagesSessionForSite({
    host: input.host,
    repository: deps.authRepository,
    requestId: input.requestId,
    sessionToken: input.pagesSession,
    site,
    ...(deps.canAccessProject ? { canReadProject: deps.canAccessProject } : {}),
  });
  if (!workspace) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  const resolved = await deps.resolveRoute({
    input: {
      host: input.host,
      method: "GET",
      pagesSession: input.pagesSession,
      path,
      requestId: input.requestId,
    },
  });
  if (resolved.status !== "ok" || resolved.site.id !== site.id) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  return {
    ...resolved,
    path,
    workspace,
  };
}

function normalizeCommentPath(path: string) {
  const normalized = typeof path === "string" ? path.trim() : "";
  if (!normalized.startsWith("/") || normalized.includes("\0") || normalized.length > 2048) {
    throw new ConsoleApiError(400, { error: "invalid_path" });
  }
  return normalized;
}

function sanitizeCommentBody(body: string) {
  const normalized = typeof body === "string" ? body.trim() : "";
  if (normalized.length === 0 || normalized.length > 2000) {
    throw new ConsoleApiError(400, { error: "invalid_comment_body" });
  }
  return normalized;
}

function sanitizeOptionalCommentId(commentId: unknown) {
  if (commentId === undefined || commentId === null || commentId === "") return null;
  return sanitizeCommentId(commentId);
}

function sanitizeCommentId(commentId: unknown) {
  const normalized = typeof commentId === "string" ? commentId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new ConsoleApiError(400, { error: "invalid_comment_id" });
  }
  return normalized;
}

function sanitizeCommentTarget(input: unknown): JsonRecord {
  const raw = jsonRecord(input);
  const target: JsonRecord = {};
  assignString(target, "tag", raw.tag, 64);
  assignString(target, "selector", raw.selector, 512);
  assignString(target, "text", raw.text, 240);

  const rect = jsonRecord(raw.rect);
  const parsedRect = {
    x: finiteNumber(rect.x),
    y: finiteNumber(rect.y),
    width: finiteNumber(rect.width),
    height: finiteNumber(rect.height),
  };
  if (
    parsedRect.x !== null &&
    parsedRect.y !== null &&
    parsedRect.width !== null &&
    parsedRect.height !== null &&
    parsedRect.width >= 0 &&
    parsedRect.height >= 0
  ) {
    target.rect = parsedRect;
  }

  return target;
}

function compactCommentTarget(target: JsonRecord): JsonRecord {
  return {
    ...(typeof target.tag === "string" ? { tag: target.tag } : {}),
    ...(typeof target.selector === "string" ? { selector: target.selector } : {}),
  };
}

function commentParentId(metadataJson: JsonRecord) {
  return typeof metadataJson.parentId === "string" ? metadataJson.parentId : null;
}

function assignString(target: JsonRecord, key: string, value: unknown, maxLength: number) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed) return;
  target[key] = trimmed.slice(0, maxLength);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function formatOperatorComment(comment: PageCommentListRow): PagesOperatorComment {
  return {
    id: comment.id,
    body: comment.body,
    path: comment.path,
    status: comment.status,
    target: comment.targetJson,
    parentId: commentParentId(comment.metadataJson),
    createdAt: comment.createdAt.toISOString(),
    author: {
      id: comment.createdByUserId,
      displayName: comment.createdByDisplayName,
    },
    release: {
      id: comment.releaseId,
    },
  };
}

export type PagesOperatorReleasesAction = "list" | "compare" | "file_diff" | "restore";

export type PagesOperatorReleasesInput = PagesOperatorCommentsInput & {
  action: PagesOperatorReleasesAction;
  releaseId?: string;
  /** undefined: the release it was created from; null: compare with nothing. */
  baseReleaseId?: string | null;
  routePath?: string;
  matchType?: string | null;
  file?: string;
};

export type PagesOperatorReleaseSummary = {
  id: string;
  number: number;
  status: string;
  reason: string | null;
  routeCount: number;
  createdAt: Date;
  activatedAt: Date | null;
  /** Who created the release; `via` says whether it came from the Console/bar, the CLI or the system. */
  author: { name: string | null; via: "console" | "cli" | "system" };
};

type PagesOperatorReleasesDeps = {
  activate?: typeof activatePageSiteRelease;
  authRepository?: PagesPrivateAuthRepository;
  compare?: typeof comparePageSiteReleases;
  fileDiff?: typeof getPageSiteReleaseFileDiff;
  listReleases?: (siteId: string, limit: number) => Promise<PagesOperatorReleaseSummary[]>;
  /** Current-policy project check; defaults to canAccessProject. */
  canAccessProject?: ProjectAuthorizationCheck;
  resolveRoute?: typeof resolvePagesRoute;
};

const OPERATOR_RELEASE_LIST_LIMIT = 30;

/**
 * Release history for the operator bar: list the site's releases, compare two of them, diff
 * one file, or restore (re-activate) an earlier release. The same Pages-session check as the
 * comments endpoint; reads need project read access, restore goes through release activation
 * (publish role, project write access, unread-comment gate, password policies, audit).
 */
export async function pagesOperatorReleases(input: PagesOperatorReleasesInput, deps: PagesOperatorReleasesDeps = {}) {
  const resolved = await resolveOperatorCommentContext(input, {
    authRepository: deps.authRepository ?? pagesPrivateAuthRepositoryForDb(),
    canAccessProject: deps.canAccessProject,
    resolveRoute: deps.resolveRoute ?? resolvePagesRoute,
  });
  const context: PagePublishContext = {
    actorId: resolved.workspace.user.id,
    actorType: "user",
    membershipRole: resolved.workspace.membership.role,
    organizationId: resolved.workspace.organization.id,
  };
  const siteId = resolved.site.id;

  if (input.action === "list") {
    await assertProjectAccess(resolved.workspace, resolved.site.projectId, "read", deps.canAccessProject);
    const releases = await (deps.listReleases ?? listOperatorReleasesForDb)(siteId, OPERATOR_RELEASE_LIST_LIMIT);
    return {
      activeReleaseId: resolved.release.id,
      currentRoute: { path: resolved.route.path },
      releases,
    };
  }

  const releaseId = sanitizeReleaseId(input.releaseId);
  const baseReleaseId =
    input.baseReleaseId === undefined || input.baseReleaseId === null ? input.baseReleaseId : sanitizeReleaseId(input.baseReleaseId);

  if (input.action === "compare") {
    const comparison = await (deps.compare ?? comparePageSiteReleases)({
      context,
      input: { siteRef: siteId, releaseId, baseReleaseId },
    });
    return { comparison };
  }

  if (input.action === "file_diff") {
    const routePath = normalizeCommentPath(input.routePath ?? "");
    const file = typeof input.file === "string" ? input.file.trim() : "";
    if (!file || file.length > 1024 || file.includes("\0")) throw new ConsoleApiError(400, { error: "invalid_request" });
    const matchType = typeof input.matchType === "string" && input.matchType.length <= 32 ? input.matchType : null;
    const fileDiff = await (deps.fileDiff ?? getPageSiteReleaseFileDiff)({
      context,
      input: { siteRef: siteId, releaseId, baseReleaseId, routePath, matchType, file },
    });
    return { fileDiff };
  }

  const result = await (deps.activate ?? activatePageSiteRelease)({
    context,
    input: { siteRef: siteId, releaseId },
    requestId: input.requestId,
  });
  return {
    release: { id: result.release.id, number: result.release.releaseNumber },
    previousReleaseId: resolved.release.id,
  };
}

function sanitizeReleaseId(value: unknown) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ConsoleApiError(400, { error: "invalid_release" });
  }
  return id;
}

async function listOperatorReleasesForDb(siteId: string, limit: number): Promise<PagesOperatorReleaseSummary[]> {
  const rows = await db
    .select({
      release: schema.pageSiteReleases,
      authorDisplayName: schema.users.displayName,
      authorEmail: schema.users.primaryEmail,
    })
    .from(schema.pageSiteReleases)
    // created_by_actor_id is text and may hold a non-user id (system actors), so compare as text.
    .leftJoin(schema.users, sql`${schema.users.id}::text = ${schema.pageSiteReleases.createdByActorId}`)
    .where(eq(schema.pageSiteReleases.siteId, siteId))
    .orderBy(desc(schema.pageSiteReleases.releaseNumber))
    .limit(limit);
  if (rows.length === 0) return [];
  const releases = rows.map((row) => row.release);
  const counts = await db
    .select({ releaseId: schema.pageReleaseRoutes.releaseId, routes: count() })
    .from(schema.pageReleaseRoutes)
    .where(inArray(schema.pageReleaseRoutes.releaseId, releases.map((release) => release.id)))
    .groupBy(schema.pageReleaseRoutes.releaseId);
  const countByRelease = new Map(counts.map((row) => [row.releaseId, Number(row.routes)]));
  return rows.map(({ release, authorDisplayName, authorEmail }) => ({
    id: release.id,
    number: release.releaseNumber,
    status: release.status,
    reason: release.reason,
    routeCount: countByRelease.get(release.id) ?? 0,
    createdAt: release.createdAt,
    activatedAt: release.activatedAt,
    author: releaseAuthor(release.createdByActorType, authorDisplayName, authorEmail),
  }));
}

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The users behind these actor ids, looked up by primary key. Actor ids are
 * text and may name system actors; those are skipped instead of compared as
 * text, which would scan every user.
 */
export async function listActorUsers(actorIds: Array<string | null | undefined>) {
  const ids = [...new Set(actorIds.filter((id): id is string => typeof id === "string" && USER_ID_PATTERN.test(id)))];
  const users = new Map<string, { displayName: string | null; email: string | null }>();
  if (ids.length === 0) return users;
  const rows = await db
    .select({ id: schema.users.id, displayName: schema.users.displayName, email: schema.users.primaryEmail })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  for (const row of rows) users.set(row.id.toLowerCase(), { displayName: row.displayName, email: row.email });
  return users;
}

export function releaseAuthor(
  actorType: string,
  displayName: string | null | undefined,
  email: string | null | undefined,
): PagesOperatorReleaseSummary["author"] {
  const via = actorType === "cli" ? "cli" : actorType === "user" || actorType === "anonymous" ? "console" : "system";
  const name = displayName?.trim() || email?.split("@")[0]?.trim() || null;
  return { name: via === "system" ? null : name, via };
}
