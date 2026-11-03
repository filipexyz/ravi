import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { hasActiveBrowserSession, hasActiveMember, lockMemberIssuance } from "@/lib/auth/member-issuance";

import { ConsoleApiError } from "@/server/console/api-error";
import { canAccessProject, type ProjectAccessWorkspace } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import type { PageVisibility } from "../pages";
import type { ConsoleWorkspace } from "../workspace";

export const PAGES_SESSION_COOKIE_NAME = "__Host-ravi_page_session";
export const PAGES_CLAIM_CODE_QUERY_PARAM = "code";
export const PAGES_AUTH_CLAIM_PATH = "/_ravi/auth/claim";

import { hostedPagesDomain } from "@/server/console/pages/hosted-domain";
const DEFAULT_CLAIM_CODE_TTL_SECONDS = 60;
const MAX_CLAIM_CODE_TTL_SECONDS = 5 * 60;
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;
const MAX_SESSION_TTL_SECONDS = 12 * 60 * 60;
const CAPTURE_SESSION_TTL_SECONDS = 2 * 60;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export type PagesAuthSite = {
  id: string;
  organizationId: string;
  projectId: string;
  defaultHostname: string;
  defaultVisibility: PageVisibility;
  status: "active" | "disabled" | "deleted";
};

type PagesAuthWorkspace = {
  mode: ConsoleWorkspace["mode"];
  browserSessionId?: string;
  user: { id: string };
  organization: { id: string };
  membership: { role: string };
};

export type PagesClaimCodeRecord = {
  id: string;
  codeHash: string;
  organizationId: string;
  projectId: string;
  siteId: string;
  routeId: string | null;
  artifactId: string | null;
  artifactVersionId: string | null;
  userId: string;
  returnUrl: string;
  requestedHost: string;
  requestedPath: string;
  status: "active" | "consumed" | "expired" | "revoked";
  expiresAt: Date;
  consumedAt: Date | null;
  consumedRequestId: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type PagesSessionRecord = {
  id: string;
  sessionTokenHash: string;
  organizationId: string;
  projectId: string | null;
  siteId: string;
  userId: string;
  status: "active" | "revoked" | "expired";
  issuedForHost: string;
  issuedFromClaimCodeId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  lastRequestId: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

/** Whether a person outside the org was given access to the page at `path`. */
export type PagesGuestPathAccess = (input: { path: string; site: PagesAuthSite; userId: string }) => Promise<boolean>;

/** Whether a person outside the org was given access to this route of the site. */
export type PagesGuestRouteAccess = (input: { routeId: string; siteId: string; userId: string }) => Promise<boolean>;

type OrganizationMembershipRecord = {
  role: string;
  status: string;
};

type AuditInput = {
  action: string;
  actorId: string | null;
  actorType: "anonymous" | "user" | "system";
  metadataJson: Record<string, unknown>;
  organizationId?: string | null;
  projectId?: string | null;
  requestId?: string | null;
  targetId?: string | null;
  targetType: string;
};

type InsertClaimCodeInput = {
  requireBrowserSession?: boolean;
  browserSessionId?: string;
  codeHash: string;
  expiresAt: Date;
  metadataJson: Record<string, unknown>;
  organizationId: string;
  projectId: string;
  requestedHost: string;
  requestedPath: string;
  returnUrl: string;
  siteId: string;
  userId: string;
};

type InsertSessionInput = {
  requireBrowserSession?: boolean;
  browserSessionId?: string;
  expiresAt: Date;
  issuedForHost: string;
  issuedFromClaimCodeId: string | null;
  metadataJson?: Record<string, unknown>;
  organizationId: string;
  projectId: string;
  sessionTokenHash: string;
  siteId: string;
  userId: string;
};

export type PagesPrivateAuthRepository = {
  assertBrowserSource(organizationId: string, userId: string, browserSessionId: string | undefined): Promise<void>;
  transaction<T>(organizationId: string, fn: (repository: PagesPrivateAuthRepository) => Promise<T>): Promise<T>;
  findClaimCodeByHash(codeHash: string): Promise<PagesClaimCodeRecord | null>;
  consumeClaimCode(input: {
    codeHash: string;
    host: string;
    now: Date;
    requestId: string;
  }): Promise<PagesClaimCodeRecord | null>;
  findOrganizationMembership(input: {
    organizationId: string;
    userId: string;
  }): Promise<OrganizationMembershipRecord | null>;
  findSessionByHash(sessionTokenHash: string): Promise<PagesSessionRecord | null>;
  findSiteByHost(host: string): Promise<PagesAuthSite | null>;
  insertAudit(input: AuditInput): Promise<void>;
  insertClaimCode(input: InsertClaimCodeInput): Promise<PagesClaimCodeRecord>;
  insertSession(input: InsertSessionInput): Promise<PagesSessionRecord>;
  markSessionExpired(sessionId: string, now: Date, requestId: string): Promise<void>;
  touchSession(sessionId: string, now: Date, requestId: string): Promise<void>;
};

type DbExecutor = Pick<typeof db, "insert" | "select" | "update" | "transaction" | "execute">;

// Internal rollback signal; only the public redemption service maps it to null.
class PagesClaimExpiredError extends Error {}

export function pagesPrivateAuthRepositoryForDb(database: DbExecutor = db): PagesPrivateAuthRepository {
  return pagesAuthRepository(database);
}

function pagesAuthRepository(database: DbExecutor, lockedOrganizationId?: string): PagesPrivateAuthRepository {
  return {
    async assertBrowserSource(organizationId, userId, browserSessionId) {
      if (!await hasActiveBrowserSession(database, organizationId, userId, browserSessionId))
        throw new ConsoleApiError(403, { error: "pages_access_denied" });
    },
    async transaction(organizationId, fn) {
      if (lockedOrganizationId) {
        if (lockedOrganizationId !== organizationId) throw new ConsoleApiError(403, { error: "pages_access_denied" });
        return fn(this);
      }
      return database.transaction(async tx => {
        await lockMemberIssuance(tx, organizationId);
        return fn(pagesAuthRepository(tx, organizationId));
      });
    },
    async findClaimCodeByHash(codeHash) {
      const [row] = await database.select().from(schema.pagesClaimCodes)
        .where(eq(schema.pagesClaimCodes.codeHash, codeHash)).limit(1);
      return row ?? null;
    },
    async consumeClaimCode(input) {
      if (!lockedOrganizationId) {
        const observed = await this.findClaimCodeByHash(input.codeHash);
        if (!observed) return null;
        return this.transaction(observed.organizationId, tx => tx.consumeClaimCode(input));
      }
      const [source] = await database.select().from(schema.pagesClaimCodes)
        .where(and(eq(schema.pagesClaimCodes.codeHash, input.codeHash),
          eq(schema.pagesClaimCodes.organizationId, lockedOrganizationId))).limit(1).for("update");
      const now = new Date();
      if (!source || source.expiresAt <= now) return null;
      const [claimCode] = await database
        .update(schema.pagesClaimCodes)
        .set({
          status: "consumed",
          consumedAt: now,
          consumedRequestId: input.requestId,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.pagesClaimCodes.codeHash, input.codeHash),
            eq(schema.pagesClaimCodes.organizationId, lockedOrganizationId),
            eq(schema.pagesClaimCodes.requestedHost, input.host),
            eq(schema.pagesClaimCodes.status, "active"),
            gt(schema.pagesClaimCodes.expiresAt, now),
          ),
        )
        .returning();

      return claimCode ?? null;
    },

    async findOrganizationMembership(input) {
      const [membership] = await database
        .select({
          role: schema.organizationMemberships.role,
          status: schema.organizationMemberships.status,
        })
        .from(schema.organizationMemberships)
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, input.organizationId),
            eq(schema.organizationMemberships.userId, input.userId),
          ),
        )
        .limit(1);

      return membership ?? null;
    },

    async findSessionByHash(sessionTokenHash) {
      const [session] = await database
        .select()
        .from(schema.pagesSessions)
        .where(eq(schema.pagesSessions.sessionTokenHash, sessionTokenHash))
        .limit(1);

      return session ?? null;
    },

    async findSiteByHost(host) {
      const hostedSlug = hostedSlugFromHost(host);
      const [site] = await database
        .select()
        .from(schema.pageSites)
        .where(
          and(
            hostedSlug ? eq(schema.pageSites.slug, hostedSlug) : eq(schema.pageSites.defaultHostname, host),
            eq(schema.pageSites.status, "active"),
          ),
        )
        .limit(1);

      if (site) return site;

      const [customHostnameSite] = await database
        .select({
          id: schema.pageSites.id,
          organizationId: schema.pageSites.organizationId,
          projectId: schema.pageSites.projectId,
          defaultHostname: schema.pageSites.defaultHostname,
          defaultVisibility: schema.pageSites.defaultVisibility,
          status: schema.pageSites.status,
        })
        .from(schema.pageDomainBindings)
        .innerJoin(schema.domainBindings, eq(schema.pageDomainBindings.domainBindingId, schema.domainBindings.id))
        .innerJoin(schema.pageSites, eq(schema.pageDomainBindings.pageSiteId, schema.pageSites.id))
        .where(
          and(
            eq(schema.pageDomainBindings.hostname, host),
            eq(schema.domainBindings.product, "pages"),
            eq(schema.domainBindings.status, "active"),
            eq(schema.pageSites.status, "active"),
          ),
        )
        .limit(1);

      return customHostnameSite ?? null;
    },

    async insertAudit(input) {
      await database.insert(schema.auditEvents).values({
        organizationId: input.organizationId ?? null,
        projectId: input.projectId ?? null,
        actorType: input.actorType,
        actorId: input.actorId,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        action: input.action,
        requestId: input.requestId ?? null,
        metadataJson: input.metadataJson,
      });
    },

    async insertClaimCode(input) {
      if (lockedOrganizationId && lockedOrganizationId !== input.organizationId)
        throw new ConsoleApiError(403, { error: "pages_access_denied" });
      if (lockedOrganizationId !== input.organizationId)
        return this.transaction(input.organizationId, tx => tx.insertClaimCode(input));
      if (input.metadataJson.access !== "guest" && !await hasActiveMember(database, input.organizationId, input.userId))
        throw new ConsoleApiError(403, { error: "pages_access_denied" });
      if (input.requireBrowserSession && !await hasActiveBrowserSession(database, input.organizationId, input.userId, input.browserSessionId))
        throw new ConsoleApiError(403, { error: "pages_access_denied" });
      const [claimCode] = await database
        .insert(schema.pagesClaimCodes)
        .values({
          codeHash: input.codeHash,
          organizationId: input.organizationId,
          projectId: input.projectId,
          siteId: input.siteId,
          userId: input.userId,
          returnUrl: input.returnUrl,
          requestedHost: input.requestedHost,
          requestedPath: input.requestedPath,
          status: "active",
          expiresAt: input.expiresAt,
          metadataJson: input.metadataJson,
        })
        .returning();

      if (!claimCode) throw new Error("Failed to create Pages claim code.");
      return claimCode;
    },

    async insertSession(input) {
      if (lockedOrganizationId && lockedOrganizationId !== input.organizationId)
        throw new ConsoleApiError(403, { error: "pages_access_denied" });
      if (lockedOrganizationId !== input.organizationId)
        return this.transaction(input.organizationId, tx => tx.insertSession(input));
      // Consumption and issuance share the outer Fleet transaction. A guest
      // exemption comes only from the stored claim, never the incoming body.
      const [claim] = input.issuedFromClaimCodeId ? await database.select().from(schema.pagesClaimCodes)
        .where(and(eq(schema.pagesClaimCodes.id, input.issuedFromClaimCodeId),
          eq(schema.pagesClaimCodes.organizationId, input.organizationId), eq(schema.pagesClaimCodes.userId, input.userId),
          eq(schema.pagesClaimCodes.siteId, input.siteId), eq(schema.pagesClaimCodes.projectId, input.projectId),
          eq(schema.pagesClaimCodes.requestedHost, input.issuedForHost), eq(schema.pagesClaimCodes.status, "consumed"))).limit(1) : [];
      if (input.issuedFromClaimCodeId && !claim) throw new ConsoleApiError(403, { error: "pages_access_denied" });
      if (claim?.metadataJson.access !== "guest" && !await hasActiveMember(database, input.organizationId, input.userId))
        throw new ConsoleApiError(403, { error: "pages_access_denied" });
      if (input.requireBrowserSession && !await hasActiveBrowserSession(database, input.organizationId, input.userId, input.browserSessionId))
        throw new ConsoleApiError(403, { error: "pages_access_denied" });
      const [session] = await database
        .insert(schema.pagesSessions)
        .values({
          sessionTokenHash: input.sessionTokenHash,
          organizationId: input.organizationId,
          projectId: input.projectId,
          siteId: input.siteId,
          userId: input.userId,
          status: "active",
          issuedForHost: input.issuedForHost,
          issuedFromClaimCodeId: input.issuedFromClaimCodeId,
          expiresAt: input.expiresAt,
          metadataJson: input.metadataJson ?? {},
        })
        .returning();

      if (!session) throw new Error("Failed to create Pages session.");
      return session;
    },

    async markSessionExpired(sessionId, now, requestId) {
      await database
        .update(schema.pagesSessions)
        .set({
          status: "expired",
          lastUsedAt: now,
          lastRequestId: requestId,
          updatedAt: now,
        })
        .where(eq(schema.pagesSessions.id, sessionId));
    },

    async touchSession(sessionId, now, requestId) {
      await database
        .update(schema.pagesSessions)
        .set({
          lastUsedAt: now,
          lastRequestId: requestId,
          updatedAt: now,
        })
        .where(eq(schema.pagesSessions.id, sessionId));
    },
  };
}

export async function createPagesClaimCode({
  canReadProject = canAccessProject,
  repository = pagesPrivateAuthRepositoryForDb(),
  requestId,
  returnTo,
  workspace,
}: {
  canReadProject?: typeof canAccessProject;
  repository?: PagesPrivateAuthRepository;
  requestId: string;
  returnTo: string;
  workspace: PagesAuthWorkspace;
}) {
  const target = await resolvePagesReturnTarget(returnTo, repository);
  if (!target) {
    await repository.insertAudit({
      actorId: workspace.user.id,
      actorType: actorTypeForWorkspace(workspace),
      action: "pages.private_auth.return_target_rejected",
      metadataJson: { requestId, returnTo: safeReturnToForAudit(returnTo) },
      organizationId: workspace.organization.id,
      requestId,
      targetType: "page_site",
    });
    throw new ConsoleApiError(400, { error: "invalid_return_to" });
  }

  const reason =
    target.site.organizationId !== workspace.organization.id
      ? "org_forbidden"
      : !(await canReadProject(workspace, target.site.projectId, "read"))
        ? "project_forbidden"
        : null;

  if (reason) {
    await repository.insertAudit({
      actorId: workspace.user.id,
      actorType: actorTypeForWorkspace(workspace),
      action: "pages.private_auth.denied",
      metadataJson: {
        host: target.host,
        path: target.url.pathname,
        reason,
        requestId,
      },
      organizationId: target.site.organizationId,
      projectId: target.site.projectId,
      requestId,
      targetId: target.site.id,
      targetType: "page_site",
    });
    throw new ConsoleApiError(403, { error: "pages_access_denied", reason });
  }

  return repository.transaction(target.site.organizationId, tx => issuePagesClaimCode(tx, target, {
    actorId: workspace.user.id,
    actorType: actorTypeForWorkspace(workspace),
    requestId,
    requireBrowserSession: workspace.mode === "oidc",
    browserSessionId: workspace.browserSessionId,
  }));
}

/**
 * Sign-in for someone outside the site's organization who was given access
 * to the requested page (or the whole site). Members keep using
 * `createPagesClaimCode`; this path never admits on membership.
 */
export async function createPagesGuestClaimCode({
  canViewPath,
  repository = pagesPrivateAuthRepositoryForDb(),
  requestId,
  returnTo,
  userId,
}: {
  canViewPath: PagesGuestPathAccess;
  repository?: PagesPrivateAuthRepository;
  requestId: string;
  returnTo: string;
  userId: string;
}) {
  const target = await resolvePagesReturnTarget(returnTo, repository);
  if (!target) throw new ConsoleApiError(400, { error: "invalid_return_to" });

  if (!(await canViewPath({ path: target.url.pathname, site: target.site, userId }))) {
    await repository.insertAudit({
      actorId: userId,
      actorType: "user",
      action: "pages.private_auth.denied",
      metadataJson: { host: target.host, path: target.url.pathname, reason: "no_access_grant", requestId },
      organizationId: target.site.organizationId,
      projectId: target.site.projectId,
      requestId,
      targetId: target.site.id,
      targetType: "page_site",
    });
    throw new ConsoleApiError(403, { error: "pages_access_denied", reason: "org_forbidden" });
  }

  return repository.transaction(target.site.organizationId, tx => issuePagesClaimCode(tx, target, {
    access: "guest",
    actorId: userId,
    actorType: "user",
    requestId,
  }));
}

async function issuePagesClaimCode(
  repository: PagesPrivateAuthRepository,
  target: { host: string; site: PagesAuthSite; url: URL },
  input: { access?: "guest"; actorId: string; actorType: "anonymous" | "user"; requestId: string;
    requireBrowserSession?: boolean; browserSessionId?: string },
) {
  const { requestId } = input;
  const code = opaqueToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + claimCodeTtlSeconds() * 1000);
  const claimCode = await repository.insertClaimCode({
    requireBrowserSession: input.requireBrowserSession, browserSessionId: input.browserSessionId,
    codeHash: hashSecret("pages-claim-code", code),
    expiresAt,
    metadataJson: { requestId, source: "pages.private_auth.start", ...(input.access ? { access: input.access } : {}) },
    organizationId: target.site.organizationId,
    projectId: target.site.projectId,
    requestedHost: target.host,
    requestedPath: `${target.url.pathname}${target.url.search}`,
    returnUrl: target.url.toString(),
    siteId: target.site.id,
    userId: input.actorId,
  });

  await repository.insertAudit({
    actorId: input.actorId,
    actorType: input.actorType,
    action: "pages.claim_code.created",
    metadataJson: {
      ...(input.access ? { access: input.access } : {}),
      expiresAt: expiresAt.toISOString(),
      host: target.host,
      path: target.url.pathname,
      requestId,
    },
    organizationId: target.site.organizationId,
    projectId: target.site.projectId,
    requestId,
    targetId: claimCode.id,
    targetType: "pages_claim_code",
  });

  const claimUrl = new URL(`${target.url.protocol}//${target.url.host}${PAGES_AUTH_CLAIM_PATH}`);
  claimUrl.searchParams.set(PAGES_CLAIM_CODE_QUERY_PARAM, code);
  if (input.requireBrowserSession)
    await repository.assertBrowserSource(target.site.organizationId, input.actorId, input.browserSessionId);

  return {
    claimCodeId: claimCode.id,
    claimUrl: claimUrl.toString(),
    expiresAt,
  };
}

export async function resolvePagesReturnTargetForAuthStart({
  repository = pagesPrivateAuthRepositoryForDb(),
  returnTo,
}: {
  repository?: PagesPrivateAuthRepository;
  returnTo: string;
}) {
  const target = await resolvePagesReturnTarget(returnTo, repository);
  if (!target) return null;

  return {
    host: target.host,
    organizationId: target.site.organizationId,
    projectId: target.site.projectId,
    siteId: target.site.id,
  };
}

export async function consumePagesClaimCode({
  code,
  host,
  repository = pagesPrivateAuthRepositoryForDb(),
  requestId,
}: {
  code: string;
  host: string;
  repository?: PagesPrivateAuthRepository;
  requestId: string;
}) {
  const normalizedHost = normalizeHostname(host);
  if (!normalizedHost || !isOpaqueTokenShape(code)) {
    return null;
  }

  // This first read chooses the lock key only. Re-read/consume under that lock;
  // never hold a claim row lock while waiting for Fleet (lifecycle lock order).
  const observed = await repository.findClaimCodeByHash(hashSecret("pages-claim-code", code));
  if (!observed) return null;
  try {
    return await repository.transaction(observed.organizationId, tx => consumePagesClaimCodeInTransaction(code, normalizedHost, requestId, tx));
  } catch (error) {
    if (error instanceof PagesClaimExpiredError) return null;
    throw error;
  }
}

async function consumePagesClaimCodeInTransaction(code: string, normalizedHost: string, requestId: string, repository: PagesPrivateAuthRepository) {
  const now = new Date();
  const claimCode = await repository.consumeClaimCode({
    codeHash: hashSecret("pages-claim-code", code),
    host: normalizedHost,
    now,
    requestId,
  });
  if (!claimCode) return null;

  const sessionToken = opaqueToken();
  const expiresAt = new Date(now.getTime() + sessionTtlSeconds() * 1000);
  const session = await repository.insertSession({
    expiresAt,
    issuedForHost: normalizedHost,
    issuedFromClaimCodeId: claimCode.id,
    organizationId: claimCode.organizationId,
    projectId: claimCode.projectId,
    sessionTokenHash: hashSecret("pages-session", sessionToken),
    siteId: claimCode.siteId,
    userId: claimCode.userId,
  });

  await repository.insertAudit({
    actorId: claimCode.userId,
    actorType: "user",
    action: "pages.claim_code.consumed",
    metadataJson: {
      host: normalizedHost,
      requestId,
      sessionId: session.id,
    },
    organizationId: claimCode.organizationId,
    projectId: claimCode.projectId,
    requestId,
    targetId: claimCode.id,
    targetType: "pages_claim_code",
  });

  await repository.insertAudit({
    actorId: claimCode.userId,
    actorType: "user",
    action: "pages.session.created",
    metadataJson: {
      expiresAt: expiresAt.toISOString(),
      host: normalizedHost,
      requestId,
    },
    organizationId: claimCode.organizationId,
    projectId: claimCode.projectId,
    requestId,
    targetId: session.id,
    targetType: "pages_session",
  });

  if (claimCode.expiresAt <= new Date()) throw new PagesClaimExpiredError();
  return {
    expiresAt,
    returnTo: claimCode.returnUrl,
    sessionId: session.id,
    sessionToken,
  };
}

export async function verifyPagesSessionForSite({
  canReadProject = canAccessProject,
  host,
  repository = pagesPrivateAuthRepositoryForDb(),
  requestId,
  sessionToken,
  site,
}: {
  canReadProject?: typeof canAccessProject;
  host?: string | null;
  repository?: PagesPrivateAuthRepository;
  requestId: string;
  sessionToken: string | null | undefined;
  site: PagesAuthSite;
}): Promise<ProjectAccessWorkspace | null> {
  const active = await activePagesSessionForSite({ host, repository, requestId, sessionToken, site });
  if (!active) return null;
  const { now, normalizedHost, session } = active;

  const membership = await repository.findOrganizationMembership({
    organizationId: session.organizationId,
    userId: session.userId,
  });
  if (!membership || membership.status !== "active") {
    await auditPagesSessionAccess(repository, session, {
      action: "pages.private_route.denied",
      host: normalizedHost,
      reason: "membership_inactive",
      requestId,
      site,
    });
    return null;
  }

  const workspace = {
    user: { id: session.userId },
    organization: { id: session.organizationId },
    membership: { role: membership.role },
  };
  if (!(await canReadProject(workspace, site.projectId, "read"))) {
    await auditPagesSessionAccess(repository, session, {
      action: "pages.private_route.denied",
      host: normalizedHost,
      reason: "project_forbidden",
      requestId,
      site,
    });
    return null;
  }

  await repository.touchSession(session.id, now, requestId);
  await auditPagesSessionAccess(repository, session, {
    action: "pages.private_route.allowed",
    host: normalizedHost,
    reason: "project_read_allowed",
    requestId,
    site,
  });
  return workspace;
}

/**
 * A session of someone outside the org, admitted only on a grant for this
 * route or the whole site. It never yields a workspace: guests get no Pages
 * bar, no Page Chat, no connectors and no live data.
 */
export async function verifyPagesGuestSessionForRoute({
  canViewRoute,
  host,
  repository = pagesPrivateAuthRepositoryForDb(),
  requestId,
  routeId,
  sessionToken,
  site,
}: {
  canViewRoute: PagesGuestRouteAccess;
  host?: string | null;
  repository?: PagesPrivateAuthRepository;
  requestId: string;
  routeId: string;
  sessionToken: string | null | undefined;
  site: PagesAuthSite;
}): Promise<boolean> {
  // Resolve checks the member path first, which already audits and expires
  // an invalid session; checking it again stays quiet.
  const active = await activePagesSessionForSite({ host, quiet: true, repository, requestId, sessionToken, site });
  if (!active) return false;
  const { now, normalizedHost, session } = active;
  if (pagesSessionActorKind(session) !== "human_viewer") return false;

  if (!(await canViewRoute({ routeId, siteId: site.id, userId: session.userId }))) {
    await auditPagesSessionAccess(repository, session, {
      action: "pages.private_route.denied",
      host: normalizedHost,
      reason: "no_access_grant",
      requestId,
      site,
    });
    return false;
  }

  await repository.touchSession(session.id, now, requestId);
  await auditPagesSessionAccess(repository, session, {
    action: "pages.private_route.allowed",
    host: normalizedHost,
    reason: "access_grant_allowed",
    requestId,
    site,
  });
  return true;
}

/**
 * The person behind an active `human_viewer` session for this site, for the
 * guest paths that are not about one served route (Page Chat and its
 * `ravi.knowledge.search` built-in). Same session checks as
 * `verifyPagesGuestSessionForRoute`, minus the route grant, which each caller
 * checks for the routes it serves. It never builds a workspace or a role.
 */
export async function resolvePagesGuestViewer({
  host,
  repository = pagesPrivateAuthRepositoryForDb(),
  requestId,
  sessionToken,
  site,
}: {
  host?: string | null;
  site: PagesAuthSite;
  sessionToken: string | null | undefined;
  requestId: string;
  repository?: PagesPrivateAuthRepository;
}): Promise<{ userId: string; sessionId: string } | null> {
  // The member check runs first and already audits an invalid session.
  const active = await activePagesSessionForSite({ host, quiet: true, repository, requestId, sessionToken, site });
  if (!active) return null;
  if (pagesSessionActorKind(active.session) !== "human_viewer") return null;
  return { userId: active.session.userId, sessionId: active.session.id };
}

async function activePagesSessionForSite({
  host,
  quiet = false,
  repository,
  requestId,
  sessionToken,
  site,
}: {
  host?: string | null;
  quiet?: boolean;
  repository: PagesPrivateAuthRepository;
  requestId: string;
  sessionToken: string | null | undefined;
  site: PagesAuthSite;
}): Promise<{ normalizedHost: string; now: Date; session: PagesSessionRecord } | null> {
  if (!sessionToken || !isOpaqueTokenShape(sessionToken)) return null;

  const session = await repository.findSessionByHash(hashSecret("pages-session", sessionToken));
  if (!session) return null;

  const normalizedHost = normalizeHostname(host ?? site.defaultHostname);
  const now = new Date();
  if (
    !normalizedHost ||
    session.status !== "active" ||
    session.revokedAt ||
    session.organizationId !== site.organizationId ||
    session.projectId !== site.projectId ||
    session.siteId !== site.id ||
    session.issuedForHost !== normalizedHost
  ) {
    if (quiet) return null;
    await auditPagesSessionAccess(repository, session, {
      action: "pages.private_route.denied",
      host: normalizedHost ?? host ?? site.defaultHostname,
      reason: "session_scope_invalid",
      requestId,
      site,
    });
    return null;
  }

  if (session.expiresAt.getTime() <= now.getTime()) {
    if (quiet) return null;
    await repository.markSessionExpired(session.id, now, requestId);
    await auditPagesSessionAccess(repository, session, {
      action: "pages.session.expired",
      host: normalizedHost,
      reason: "session_expired",
      requestId,
      site,
    });
    return null;
  }

  return { normalizedHost, now, session };
}

export async function findPagesSessionByToken({
  repository = pagesPrivateAuthRepositoryForDb(),
  sessionToken,
}: {
  repository?: PagesPrivateAuthRepository;
  sessionToken: string;
}): Promise<PagesSessionRecord | null> {
  if (!sessionToken || !isOpaqueTokenShape(sessionToken)) return null;
  return repository.findSessionByHash(hashSecret("pages-session", sessionToken));
}

export function pagesSessionActorKind(
  session: Pick<PagesSessionRecord, "issuedFromClaimCodeId" | "metadataJson">,
) {
  const source = session.metadataJson.source;
  if (source === "pages.capture") return "capture" as const;
  if (typeof source === "string" && source.length > 0) return "unscoped" as const;
  if (session.issuedFromClaimCodeId) return "human_viewer" as const;
  return "unscoped" as const;
}

export async function createPagesCaptureSession({
  requireBrowserSession,
  browserSessionId,
  repository = pagesPrivateAuthRepositoryForDb(),
  requestId,
  site,
  userId,
}: {
  requireBrowserSession?: boolean;
  browserSessionId?: string;
  repository?: PagesPrivateAuthRepository;
  requestId: string;
  site: PagesAuthSite;
  userId: string;
}) {
  return repository.transaction(site.organizationId, tx => createPagesCaptureSessionInTransaction(tx, requestId, site, userId, { requireBrowserSession, browserSessionId }));
}

async function createPagesCaptureSessionInTransaction(repository: PagesPrivateAuthRepository, requestId: string, site: PagesAuthSite, userId: string,
  source: { requireBrowserSession?: boolean; browserSessionId?: string }) {
  const now = new Date();
  const sessionToken = opaqueToken();
  const expiresAt = new Date(now.getTime() + CAPTURE_SESSION_TTL_SECONDS * 1000);
  const session = await repository.insertSession({
    ...source,
    expiresAt,
    issuedForHost: site.defaultHostname,
    issuedFromClaimCodeId: null,
    metadataJson: { requestId, source: "pages.capture" },
    organizationId: site.organizationId,
    projectId: site.projectId,
    sessionTokenHash: hashSecret("pages-session", sessionToken),
    siteId: site.id,
    userId,
  });

  await repository.insertAudit({
    actorId: userId,
    actorType: "user",
    action: "pages.capture_session.created",
    metadataJson: {
      expiresAt: expiresAt.toISOString(),
      host: site.defaultHostname,
      requestId,
    },
    organizationId: site.organizationId,
    projectId: site.projectId,
    requestId,
    targetId: session.id,
    targetType: "pages_session",
  });

  if (source.requireBrowserSession)
    await repository.assertBrowserSource(site.organizationId, userId, source.browserSessionId);
  return { expiresAt, sessionId: session.id, sessionToken };
}

export async function expirePagesCaptureSession({
  repository = pagesPrivateAuthRepositoryForDb(),
  requestId,
  sessionId,
}: {
  repository?: PagesPrivateAuthRepository;
  requestId: string;
  sessionId: string;
}) {
  await repository.markSessionExpired(sessionId, new Date(), requestId);
}

export function pagesSessionCookie(sessionToken: string, expiresAt: Date) {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${PAGES_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearPagesSessionCookies() {
  return [`${PAGES_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`];
}

export function getPagesControlToken() {
  return process.env.RAVI_PAGES_CONTROL_TOKEN?.trim() || null;
}

export function isPagesControlRequestAuthorized(request: Request, expectedToken = getPagesControlToken()) {
  const token = expectedToken?.trim();
  if (!token) return false;

  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const bearerToken = match?.[1]?.trim();
  if (!bearerToken) return false;

  return bearerToken.length === token.length && timingSafeStringEqual(bearerToken, token);
}

export function normalizeHostname(host: string): string | null {
  if (typeof host !== "string") return null;

  const withoutPort = host.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (!withoutPort || withoutPort.includes("/") || withoutPort.includes("@")) return null;

  return withoutPort;
}

async function resolvePagesReturnTarget(returnTo: string, repository: PagesPrivateAuthRepository) {
  let url: URL;

  try {
    url = new URL(returnTo);
  } catch {
    return null;
  }

  const host = normalizeHostname(url.hostname);
  if (!host || url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.pathname === PAGES_AUTH_CLAIM_PATH || url.pathname.startsWith(`${PAGES_AUTH_CLAIM_PATH}/`)) return null;
  if (url.searchParams.has(PAGES_CLAIM_CODE_QUERY_PARAM)) return null;

  const site = await repository.findSiteByHost(host);
  if (!site || site.status !== "active") return null;

  return { host, site, url };
}

function hostedSlugFromHost(host: string) {
  const domain = hostedPagesDomain();
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix) || host === domain) return null;

  const slug = host.slice(0, -suffix.length);
  return slug && !slug.includes(".") ? slug : null;
}

function hashSecret(kind: string, rawValue: string) {
  const secret = pagesAuthSecret();
  return createHmac("sha256", secret).update(kind).update(":").update(rawValue).digest("hex");
}

function pagesAuthSecret() {
  const value = process.env.RAVI_PAGES_AUTH_SESSION_SECRET ?? process.env.RAVI_PAGES_AUTH_TOKEN_SECRET;
  if (!value || value.length < 32) {
    throw new ConsoleApiError(503, { error: "pages_auth_not_configured" });
  }
  return value;
}

function claimCodeTtlSeconds() {
  return boundedSeconds(process.env.RAVI_PAGES_CLAIM_CODE_TTL_SECONDS, DEFAULT_CLAIM_CODE_TTL_SECONDS, {
    min: 10,
    max: MAX_CLAIM_CODE_TTL_SECONDS,
  });
}

function sessionTtlSeconds() {
  return boundedSeconds(process.env.RAVI_PAGES_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS, {
    min: 60,
    max: MAX_SESSION_TTL_SECONDS,
  });
}

function boundedSeconds(value: string | undefined, fallback: number, bounds: { min: number; max: number }) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function opaqueToken() {
  return randomBytes(32).toString("base64url");
}

function isOpaqueTokenShape(token: string) {
  return OPAQUE_TOKEN_PATTERN.test(token);
}

async function auditPagesSessionAccess(
  repository: PagesPrivateAuthRepository,
  session: PagesSessionRecord,
  input: {
    action: string;
    host: string;
    reason: string;
    requestId: string;
    site: PagesAuthSite;
  },
) {
  await repository.insertAudit({
    actorId: session.userId,
    actorType: "user",
    action: input.action,
    metadataJson: {
      host: input.host,
      reason: input.reason,
      requestId: input.requestId,
      siteId: input.site.id,
    },
    organizationId: session.organizationId,
    projectId: session.projectId ?? input.site.projectId,
    requestId: input.requestId,
    targetId: session.id,
    targetType: "pages_session",
  });
}

function actorTypeForWorkspace(workspace: Pick<PagesAuthWorkspace, "mode">) {
  return workspace.mode === "anonymous" ? "anonymous" : "user";
}

function safeReturnToForAudit(returnTo: string) {
  try {
    const url = new URL(returnTo);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "invalid";
  }
}

function timingSafeStringEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
