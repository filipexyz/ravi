import { hash, verify } from "@node-rs/argon2";
import { createHmac, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { assertProjectAccess, type ProjectAuthorizationCheck } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import type { PageVisibility } from "../pages";
import {
  pagesPrivateAuthRepositoryForDb,
  verifyPagesSessionForSite,
  type PagesAuthSite,
  type PagesPrivateAuthRepository,
} from "./auth";
import { matchPageRoute, validateRoutePath } from "./policy";
import {
  normalizeHostname,
  pagesRouteResolveRepositoryForDb,
  type PagesResolveRelease,
  type PagesResolveRoute,
  type PagesResolveSite,
  type PagesRouteResolveRepository,
} from "./resolve";

export const PAGES_PASSWORD_SESSION_COOKIE_NAME = "__Host-ravi_page_password_session";
export const PAGES_PASSWORD_CHALLENGE_PATH = "/_ravi/auth/password";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export type PagesPasswordPolicyScope = "site" | "route";

export type PagesPasswordPolicyRecord = typeof schema.pagePasswordPolicies.$inferSelect;
export type PagesPasswordSessionRecord = typeof schema.pagePasswordSessions.$inferSelect;

type PasswordAuditInput = {
  action: string;
  actorId: string | null;
  actorType: "anonymous" | "cli" | "user" | "system";
  metadataJson: Record<string, unknown>;
  organizationId: string;
  projectId: string;
  requestId: string;
  targetId: string | null;
  targetType: string;
};

export type PagesPasswordAccessRepository = {
  disablePolicy(input: {
    configuredByUserId: string;
    now: Date;
    policyId: string;
  }): Promise<PagesPasswordPolicyRecord | null>;
  findPolicyForScope(input: {
    routeId: string | null;
    siteId: string;
  }): Promise<PagesPasswordPolicyRecord | null>;
  findSessionByHash(sessionTokenHash: string): Promise<PagesPasswordSessionRecord | null>;
  insertAudit(input: PasswordAuditInput): Promise<void>;
  insertSession(input: {
    expiresAt: Date;
    issuedForHost: string;
    organizationId: string;
    policyId: string;
    policyVersion: number;
    projectId: string;
    routeId: string | null;
    sessionTokenHash: string;
    siteId: string;
  }): Promise<PagesPasswordSessionRecord>;
  markSessionExpired(input: {
    now: Date;
    requestId: string;
    sessionId: string;
  }): Promise<void>;
  touchSession(input: {
    now: Date;
    requestId: string;
    sessionId: string;
  }): Promise<void>;
  upsertPolicy(input: {
    configuredByUserId: string;
    now: Date;
    organizationId: string;
    passwordHash: string;
    projectId: string;
    routeId: string | null;
    siteId: string;
  }): Promise<PagesPasswordPolicyRecord>;
};

type DbExecutor = Pick<typeof db, "insert" | "select" | "update">;

export function pagesPasswordAccessRepositoryForDb(
  database: DbExecutor = db,
): PagesPasswordAccessRepository {
  return {
    async disablePolicy(input) {
      const [policy] = await database
        .update(schema.pagePasswordPolicies)
        .set({
          configuredByUserId: input.configuredByUserId,
          disabledAt: input.now,
          status: "disabled",
          updatedAt: input.now,
        })
        .where(eq(schema.pagePasswordPolicies.id, input.policyId))
        .returning();
      return policy ?? null;
    },

    async findPolicyForScope(input) {
      const predicates = [eq(schema.pagePasswordPolicies.siteId, input.siteId)];
      predicates.push(
        input.routeId
          ? eq(schema.pagePasswordPolicies.routeId, input.routeId)
          : isNull(schema.pagePasswordPolicies.routeId),
      );
      const [policy] = await database
        .select()
        .from(schema.pagePasswordPolicies)
        .where(and(...predicates))
        .limit(1);
      return policy ?? null;
    },

    async findSessionByHash(sessionTokenHash) {
      const [session] = await database
        .select()
        .from(schema.pagePasswordSessions)
        .where(eq(schema.pagePasswordSessions.sessionTokenHash, sessionTokenHash))
        .limit(1);
      return session ?? null;
    },

    async insertAudit(input) {
      await database.insert(schema.auditEvents).values(input);
    },

    async insertSession(input) {
      const [session] = await database
        .insert(schema.pagePasswordSessions)
        .values({
          ...input,
          status: "active",
        })
        .returning();
      if (!session) throw new Error("Failed to create Pages password session.");
      return session;
    },

    async markSessionExpired(input) {
      await database
        .update(schema.pagePasswordSessions)
        .set({
          lastRequestId: input.requestId,
          lastUsedAt: input.now,
          status: "expired",
          updatedAt: input.now,
        })
        .where(eq(schema.pagePasswordSessions.id, input.sessionId));
    },

    async touchSession(input) {
      await database
        .update(schema.pagePasswordSessions)
        .set({
          lastRequestId: input.requestId,
          lastUsedAt: input.now,
          updatedAt: input.now,
        })
        .where(eq(schema.pagePasswordSessions.id, input.sessionId));
    },

    async upsertPolicy(input) {
      const existing = await this.findPolicyForScope({
        routeId: input.routeId,
        siteId: input.siteId,
      });
      if (existing) {
        const [policy] = await database
          .update(schema.pagePasswordPolicies)
          .set({
            configuredByUserId: input.configuredByUserId,
            disabledAt: null,
            passwordHash: input.passwordHash,
            rotatedAt: input.now,
            status: "active",
            updatedAt: input.now,
            version: existing.version + 1,
          })
          .where(eq(schema.pagePasswordPolicies.id, existing.id))
          .returning();
        if (!policy) throw new Error("Failed to rotate Pages password policy.");
        return policy;
      }

      const [policy] = await database
        .insert(schema.pagePasswordPolicies)
        .values({
          configuredByUserId: input.configuredByUserId,
          organizationId: input.organizationId,
          passwordHash: input.passwordHash,
          projectId: input.projectId,
          routeId: input.routeId,
          siteId: input.siteId,
          status: "active",
          version: 1,
        })
        .returning();
      if (!policy) throw new Error("Failed to create Pages password policy.");
      return policy;
    },
  };
}

export type PagesPasswordRouteContext = {
  effectiveVisibility: PageVisibility;
  release: PagesResolveRelease;
  route: PagesResolveRoute;
  site: PagesResolveSite;
};

export type AuthorizedPagesPasswordPolicyContext = PagesPasswordRouteContext & {
  actorId: string;
  actorType: "cli" | "user";
};

export async function resolvePagesPasswordRouteContext(
  input: { host: string; path: string },
  repository: PagesRouteResolveRepository = pagesRouteResolveRepositoryForDb(),
): Promise<PagesPasswordRouteContext | null> {
  const host = normalizeHostname(input.host);
  const normalizedPath = validateRoutePath(input.path);
  if (!host || !normalizedPath.ok) return null;

  const site = await repository.findSiteByHost(host);
  if (!site || site.status !== "active") return null;
  const release = await repository.getActiveRelease(site);
  if (!release || release.status !== "active") return null;
  const routes = await repository.listReleaseRoutes(release.id);
  const match = matchPageRoute(
    routes.map((route) => ({
      id: route.id,
      matchType: route.matchType,
      path: route.path,
      priority: route.priority,
    })),
    normalizedPath.path,
  );
  const route = match ? routes.find((candidate) => candidate.id === match.id) : null;
  if (!route) return null;

  return {
    effectiveVisibility: effectiveVisibility(site.defaultVisibility, route.visibility),
    release,
    route,
    site,
  };
}

export async function configurePagesPasswordPolicy(input: {
  host: string;
  pagesSession: string;
  password: string;
  path: string;
  requestId: string;
  scope?: PagesPasswordPolicyScope;
}, deps: {
  authRepository?: PagesPrivateAuthRepository;
  /** Current-policy project check; defaults to canAccessProject. */
  canAccessProject?: ProjectAuthorizationCheck;
  passwordRepository?: PagesPasswordAccessRepository;
  routeRepository?: PagesRouteResolveRepository;
} = {}) {
  const context = await authorizedOperatorContext(input, deps);
  return configureAuthorizedPagesPasswordPolicy({
    context,
    host: input.host,
    password: input.password,
    requestId: input.requestId,
    scope: input.scope,
    source: "pages_operator_overlay",
  }, deps.passwordRepository);
}

export async function configureAuthorizedPagesPasswordPolicy(input: {
  context: AuthorizedPagesPasswordPolicyContext;
  host: string;
  password: string;
  requestId: string;
  scope?: PagesPasswordPolicyScope;
  source: string;
}, repository: PagesPasswordAccessRepository = pagesPasswordAccessRepositoryForDb()) {
  const password = normalizePassword(input.password);
  const passwordHash = await hash(password, {
    algorithm: 2,
    memoryCost: 19_456,
    outputLen: 32,
    parallelism: 1,
    timeCost: 2,
  });
  const routeId = input.scope === "site" ? null : input.context.route.routeId;
  const now = new Date();
  const policy = await repository.upsertPolicy({
    configuredByUserId: input.context.actorId,
    now,
    organizationId: input.context.site.organizationId,
    passwordHash,
    projectId: input.context.site.projectId,
    routeId,
    siteId: input.context.site.id,
  });
  await repository.insertAudit({
    action: policy.version === 1 ? "pages.password_policy.created" : "pages.password_policy.rotated",
    actorId: input.context.actorId,
    actorType: input.context.actorType,
    metadataJson: {
      host: normalizeHostname(input.host),
      path: input.context.route.path,
      policyVersion: policy.version,
      requestId: input.requestId,
      scope: routeId ? "route" : "site",
      source: input.source,
    },
    organizationId: input.context.site.organizationId,
    projectId: input.context.site.projectId,
    requestId: input.requestId,
    targetId: policy.id,
    targetType: "page_password_policy",
  });

  return publicPolicy(policy);
}

export async function disablePagesPasswordPolicy(input: {
  host: string;
  pagesSession: string;
  path: string;
  requestId: string;
  scope?: PagesPasswordPolicyScope;
}, deps: {
  authRepository?: PagesPrivateAuthRepository;
  /** Current-policy project check; defaults to canAccessProject. */
  canAccessProject?: ProjectAuthorizationCheck;
  passwordRepository?: PagesPasswordAccessRepository;
  routeRepository?: PagesRouteResolveRepository;
} = {}) {
  const context = await authorizedOperatorContext(input, deps);
  if (context.effectiveVisibility === "password") {
    throw new ConsoleApiError(409, { error: "password_policy_in_use" });
  }
  return disableAuthorizedPagesPasswordPolicy({
    context,
    host: input.host,
    requestId: input.requestId,
    scope: input.scope,
    source: "pages_operator_overlay",
  }, deps.passwordRepository);
}

export async function disableAuthorizedPagesPasswordPolicy(input: {
  context: AuthorizedPagesPasswordPolicyContext;
  host: string;
  requestId: string;
  scope?: PagesPasswordPolicyScope;
  source: string;
}, repository: PagesPasswordAccessRepository = pagesPasswordAccessRepositoryForDb()) {
  const routeId = input.scope === "site" ? null : input.context.route.routeId;
  const policy = await repository.findPolicyForScope({ routeId, siteId: input.context.site.id });
  if (!policy || policy.status !== "active") return { changed: false, policy: null };
  const disabled = await repository.disablePolicy({
    configuredByUserId: input.context.actorId,
    now: new Date(),
    policyId: policy.id,
  });
  await repository.insertAudit({
    action: "pages.password_policy.disabled",
    actorId: input.context.actorId,
    actorType: input.context.actorType,
    metadataJson: {
      host: normalizeHostname(input.host),
      path: input.context.route.path,
      policyVersion: policy.version,
      requestId: input.requestId,
      scope: routeId ? "route" : "site",
      source: input.source,
    },
    organizationId: input.context.site.organizationId,
    projectId: input.context.site.projectId,
    requestId: input.requestId,
    targetId: policy.id,
    targetType: "page_password_policy",
  });
  return { changed: Boolean(disabled), policy: disabled ? publicPolicy(disabled) : null };
}

export async function getPagesPasswordPolicyStatus(input: {
  host: string;
  pagesSession: string;
  path: string;
  requestId: string;
  scope?: PagesPasswordPolicyScope;
}, deps: {
  authRepository?: PagesPrivateAuthRepository;
  /** Current-policy project check; defaults to canAccessProject. */
  canAccessProject?: ProjectAuthorizationCheck;
  passwordRepository?: PagesPasswordAccessRepository;
  routeRepository?: PagesRouteResolveRepository;
} = {}) {
  const context = await authorizedOperatorContext(input, deps);
  return getAuthorizedPagesPasswordPolicyStatus({ context, scope: input.scope }, deps.passwordRepository);
}

export async function getAuthorizedPagesPasswordPolicyStatus(input: {
  context: AuthorizedPagesPasswordPolicyContext;
  scope?: PagesPasswordPolicyScope;
}, repository: PagesPasswordAccessRepository = pagesPasswordAccessRepositoryForDb()) {
  const routeId = input.scope === "site" ? null : input.context.route.routeId;
  const policy = await repository.findPolicyForScope({ routeId, siteId: input.context.site.id });
  return {
    configured: policy?.status === "active",
    policy: policy ? publicPolicy(policy) : null,
    scope: routeId ? "route" as const : "site" as const,
  };
}

export async function verifyPagesPasswordAndCreateSession(input: {
  host: string;
  password: string;
  path: string;
  requestId: string;
}, deps: {
  passwordRepository?: PagesPasswordAccessRepository;
  routeRepository?: PagesRouteResolveRepository;
} = {}) {
  const host = normalizeHostname(input.host);
  if (!host) return null;
  const routeContext = await resolvePagesPasswordRouteContext(input, deps.routeRepository);
  if (!routeContext || routeContext.effectiveVisibility !== "password") return null;
  const repository = deps.passwordRepository ?? pagesPasswordAccessRepositoryForDb();
  const policy = await findRequiredPagesPasswordPolicy({
    repository,
    routeId: routeContext.route.routeId,
    routeVisibility: routeContext.route.visibility,
    siteId: routeContext.site.id,
    siteVisibility: routeContext.site.defaultVisibility,
  });
  if (!policy) return null;

  let valid = false;
  try {
    valid = await verify(policy.passwordHash, input.password.normalize("NFC"));
  } catch {
    valid = false;
  }
  if (!valid) {
    await repository.insertAudit({
      action: "pages.password_challenge.denied",
      actorId: null,
      actorType: "anonymous",
      metadataJson: {
        host,
        path: routeContext.route.path,
        reason: "invalid_password",
        requestId: input.requestId,
      },
      organizationId: routeContext.site.organizationId,
      projectId: routeContext.site.projectId,
      requestId: input.requestId,
      targetId: policy.id,
      targetType: "page_password_policy",
    });
    return null;
  }

  const now = new Date();
  await repository.insertAudit({
    action: "pages.password_challenge.allowed",
    actorId: null,
    actorType: "anonymous",
    metadataJson: {
      host,
      path: routeContext.route.path,
      policyVersion: policy.version,
      requestId: input.requestId,
    },
    organizationId: routeContext.site.organizationId,
    projectId: routeContext.site.projectId,
    requestId: input.requestId,
    targetId: policy.id,
    targetType: "page_password_policy",
  });
  const expiresAt = new Date(now.getTime() + passwordSessionTtlSeconds() * 1000);
  const sessionToken = randomBytes(32).toString("base64url");
  const session = await repository.insertSession({
    expiresAt,
    issuedForHost: host,
    organizationId: routeContext.site.organizationId,
    policyId: policy.id,
    policyVersion: policy.version,
    projectId: routeContext.site.projectId,
    routeId: policy.routeId,
    sessionTokenHash: hashPasswordSessionToken(sessionToken),
    siteId: routeContext.site.id,
  });
  await repository.insertAudit({
    action: "pages.password_session.created",
    actorId: null,
    actorType: "anonymous",
    metadataJson: {
      expiresAt: expiresAt.toISOString(),
      host,
      path: routeContext.route.path,
      policyVersion: policy.version,
      requestId: input.requestId,
    },
    organizationId: routeContext.site.organizationId,
    projectId: routeContext.site.projectId,
    requestId: input.requestId,
    targetId: session.id,
    targetType: "page_password_session",
  });
  return { expiresAt, sessionToken };
}

export async function verifyPagesPasswordSessionForRoute(input: {
  host: string;
  requestId: string;
  routeId: string;
  routeVisibility: PageVisibility;
  sessionToken: string | null | undefined;
  site: PagesAuthSite;
}, repository: PagesPasswordAccessRepository = pagesPasswordAccessRepositoryForDb()) {
  if (!input.sessionToken || !OPAQUE_TOKEN_PATTERN.test(input.sessionToken)) return false;
  const host = normalizeHostname(input.host);
  if (!host) return false;
  const policy = await findRequiredPagesPasswordPolicy({
    repository,
    routeId: input.routeId,
    routeVisibility: input.routeVisibility,
    siteId: input.site.id,
    siteVisibility: input.site.defaultVisibility,
  });
  if (!policy) return false;
  const session = await repository.findSessionByHash(hashPasswordSessionToken(input.sessionToken));
  if (!session) return false;
  const now = new Date();
  const valid =
    session.status === "active" &&
    !session.revokedAt &&
    session.expiresAt.getTime() > now.getTime() &&
    session.organizationId === input.site.organizationId &&
    session.projectId === input.site.projectId &&
    session.siteId === input.site.id &&
    session.routeId === policy.routeId &&
    session.issuedForHost === host &&
    session.policyId === policy.id &&
    session.policyVersion === policy.version &&
    (policy.routeId === null || policy.routeId === input.routeId);
  if (!valid) {
    const expired = session.expiresAt.getTime() <= now.getTime();
    if (expired) {
      await repository.markSessionExpired({ now, requestId: input.requestId, sessionId: session.id });
    }
    await repository.insertAudit({
      action: expired ? "pages.password_session.expired" : "pages.password_session.rejected",
      actorId: null,
      actorType: "anonymous",
      metadataJson: {
        host,
        policyVersion: policy.version,
        reason: expired ? "expired" : "scope_or_version_mismatch",
        requestId: input.requestId,
      },
      organizationId: session.organizationId,
      projectId: session.projectId,
      requestId: input.requestId,
      targetId: session.id,
      targetType: "page_password_session",
    });
    return false;
  }
  await repository.touchSession({ now, requestId: input.requestId, sessionId: session.id });
  return true;
}

export async function findRequiredPagesPasswordPolicy(input: {
  repository?: PagesPasswordAccessRepository;
  routeId: string;
  routeVisibility: PageVisibility;
  siteId: string;
  siteVisibility: PageVisibility;
}) {
  const routeId = requiredPasswordPolicyRouteId(input);
  if (routeId === undefined) return null;
  const policy = await (input.repository ?? pagesPasswordAccessRepositoryForDb()).findPolicyForScope({
    routeId,
    siteId: input.siteId,
  });
  return policy?.status === "active" && policy.siteId === input.siteId && policy.routeId === routeId
    ? policy
    : null;
}

export function pagesPasswordSessionCookie(sessionToken: string, expiresAt: Date) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${PAGES_PASSWORD_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearPagesPasswordSessionCookie() {
  return `${PAGES_PASSWORD_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

async function authorizedOperatorContext(input: {
  host: string;
  pagesSession: string;
  path: string;
  requestId: string;
}, deps: {
  authRepository?: PagesPrivateAuthRepository;
  canAccessProject?: ProjectAuthorizationCheck;
  routeRepository?: PagesRouteResolveRepository;
}) {
  const authRepository = deps.authRepository ?? pagesPrivateAuthRepositoryForDb();
  const routeContext = await resolvePagesPasswordRouteContext(input, deps.routeRepository);
  if (!routeContext) throw new ConsoleApiError(404, { error: "not_found" });
  const workspace = await verifyPagesSessionForSite({
    host: input.host,
    repository: authRepository,
    requestId: input.requestId,
    sessionToken: input.pagesSession,
    site: routeContext.site,
    ...(deps.canAccessProject ? { canReadProject: deps.canAccessProject } : {}),
  });
  if (!workspace) throw new ConsoleApiError(404, { error: "not_found" });
  await assertProjectAccess(workspace, routeContext.site.projectId, "write", deps.canAccessProject);
  return {
    ...routeContext,
    actorId: workspace.user.id,
    actorType: "user" as const,
  };
}

function normalizePassword(password: string) {
  const normalized = password.normalize("NFC");
  const length = [...normalized].length;
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    throw new ConsoleApiError(400, {
      error: "invalid_password",
      fieldErrors: { password: `Use between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.` },
    });
  }
  return normalized;
}

function publicPolicy(policy: PagesPasswordPolicyRecord) {
  return {
    configured: policy.status === "active",
    id: policy.id,
    rotatedAt: policy.rotatedAt.toISOString(),
    scope: policy.routeId ? "route" as const : "site" as const,
    status: policy.status,
    version: policy.version,
  };
}

function effectiveVisibility(siteVisibility: PageVisibility, routeVisibility: PageVisibility): PageVisibility {
  if (routeVisibility !== "public") return routeVisibility;
  return siteVisibility === "public" ? "public" : siteVisibility;
}

function requiredPasswordPolicyRouteId(input: {
  routeId: string;
  routeVisibility: PageVisibility;
  siteVisibility: PageVisibility;
}) {
  if (input.routeVisibility === "password") return input.routeId;
  if (input.routeVisibility === "public" && input.siteVisibility === "password") return null;
  return undefined;
}

function hashPasswordSessionToken(token: string) {
  const secret = process.env.RAVI_PAGES_AUTH_SESSION_SECRET ?? process.env.RAVI_PAGES_AUTH_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new ConsoleApiError(503, { error: "pages_auth_not_configured" });
  }
  return createHmac("sha256", secret).update("pages-password-session:").update(token).digest("hex");
}

function passwordSessionTtlSeconds() {
  const raw = Number(process.env.RAVI_PAGES_PASSWORD_SESSION_TTL_SECONDS);
  if (!Number.isInteger(raw)) return DEFAULT_SESSION_TTL_SECONDS;
  return Math.min(MAX_SESSION_TTL_SECONDS, Math.max(60, raw));
}
