import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { oidcProvider, type OidcConfig } from "./oidc-config";
import { getRuntimeOidcConfig } from "./oidc-runtime";
import { admissionGroupsAllow } from "@/server/console/fleet/sso-contract";
import { hashBrowserSessionToken, newBrowserSessionToken } from "./oidc-transaction";
import type { OidcVerifiedIdentity } from "./oidc-client";
import { lockMemberIssuance } from "./member-issuance";

export class OidcAccessDeniedError extends Error {
  constructor() { super("This identity has no active access to this installation."); }
}

export async function resolveOidcWorkspace(input: { issuer: string; subject: string; userId?: string }, config?: OidcConfig,
  database: Pick<typeof db, "select"> = db) {
  config ??= await getRuntimeOidcConfig(false);
  if (input.issuer !== config.issuer || !input.subject) return null;
  const [row] = await database.select({
    identity: schema.authIdentities, user: schema.users,
    organization: schema.organizations, membership: schema.organizationMemberships,
  }).from(schema.authIdentities)
    .innerJoin(schema.users, eq(schema.authIdentities.userId, schema.users.id))
    .innerJoin(schema.organizationMemberships, and(
      eq(schema.organizationMemberships.userId, schema.users.id),
      eq(schema.organizationMemberships.organizationId, config.organizationId),
    ))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.organizationMemberships.organizationId))
    .where(and(
      eq(schema.authIdentities.provider, oidcProvider(input.issuer)),
      eq(schema.authIdentities.providerUserId, input.subject),
      input.userId ? eq(schema.users.id, input.userId) : undefined,
      eq(schema.users.status, "active"), eq(schema.organizations.status, "active"),
      eq(schema.organizationMemberships.status, "active"),
    )).limit(1);
  return row ?? null;
}

/** Server-only bridge: no JIT user, email linkage or provider-role grants. */
export async function resolveOidcRuntimeIdentity(input: { issuer: string; subject: string }) {
  const row = await resolveOidcWorkspace(input);
  if (!row) return null;
  return { userId: row.user.id, organizationId: row.organization.id,
    email: row.user.primaryEmail, name: row.user.displayName ?? row.user.primaryEmail,
    role: row.membership.role };
}

export async function createOidcBrowserSession(identity: OidcVerifiedIdentity, config: OidcConfig) {
  if (identity.emailVerified !== true) throw new OidcAccessDeniedError();
  if (!admissionGroupsAllow(config.admissionGroups ?? [], identity.groups ?? [])) throw new OidcAccessDeniedError();
  const token = newBrowserSessionToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
  await db.transaction(async (tx) => {
    await lockMemberIssuance(tx, config.organizationId);
    // Re-read admission AFTER acquiring the lifecycle lock, not from a cached
    // preflight. Suspension either sees this row or wins and prevents issuance.
    const row = await resolveOidcWorkspace(identity, config, tx);
    if (!row) throw new OidcAccessDeniedError();
    await tx.insert(schema.consoleBrowserSessions).values({
      tokenHash: hashBrowserSessionToken(token)!, userId: row.user.id,
      authIdentityId: row.identity.id, organizationId: row.organization.id, expiresAt, oidcGroups: identity.groups ?? [],
    });
    await tx.insert(schema.auditEvents).values({
      organizationId: row.organization.id, actorType: "user", actorId: row.user.id,
      targetType: "user", targetId: row.user.id, action: "auth.session.created",
      metadataJson: { provider: "oidc", issuer: config.issuer },
    });
  });
  return { token, expiresAt };
}

export async function readOidcBrowserSession(token: string | undefined, config?: OidcConfig) {
  const tokenHash = token ? hashBrowserSessionToken(token) : null;
  if (!tokenHash) return null;
  config ??= await getRuntimeOidcConfig(false);
  const [row] = await db.select({ session: schema.consoleBrowserSessions, identity: schema.authIdentities })
    .from(schema.consoleBrowserSessions)
    .innerJoin(schema.authIdentities, and(
      eq(schema.authIdentities.id, schema.consoleBrowserSessions.authIdentityId),
      eq(schema.authIdentities.userId, schema.consoleBrowserSessions.userId),
    ))
    .where(and(eq(schema.consoleBrowserSessions.tokenHash, tokenHash),
      eq(schema.consoleBrowserSessions.organizationId, config.organizationId),
      isNull(schema.consoleBrowserSessions.revokedAt), gt(schema.consoleBrowserSessions.expiresAt, new Date()),
      eq(schema.authIdentities.provider, oidcProvider(config.issuer)),
    )).limit(1);
  if (!row) return null;
  const workspace = await resolveOidcWorkspace({ issuer: config.issuer,
    subject: row.identity.providerUserId, userId: row.session.userId }, config);
  if (!workspace) return null;
  if (!admissionGroupsAllow(config.admissionGroups ?? [], row.session.oidcGroups)) return null;
  return { issuer: config.issuer, subject: row.identity.providerUserId, userId: workspace.user.id, sessionId: row.session.id,
    email: workspace.user.primaryEmail, emailVerified: true as const,
    name: workspace.user.displayName ?? workspace.user.primaryEmail };
}

export async function revokeOidcBrowserSession(token: string | undefined) {
  const hash = token ? hashBrowserSessionToken(token) : null;
  if (!hash) return;
  await db.transaction(async (tx) => {
    const [session] = await tx.update(schema.consoleBrowserSessions).set({ revokedAt: new Date() })
      .where(and(eq(schema.consoleBrowserSessions.tokenHash, hash), isNull(schema.consoleBrowserSessions.revokedAt)))
      .returning();
    if (session) await tx.insert(schema.auditEvents).values({
      organizationId: session.organizationId, actorType: "user", actorId: session.userId,
      targetType: "user", targetId: session.userId, action: "auth.session.revoked",
      metadataJson: { provider: "oidc" },
    });
  });
}
