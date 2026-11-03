import { readFile } from "node:fs/promises";
import { and, eq, ne, sql } from "drizzle-orm";
import { getOidcConfig, oidcProvider } from "../src/lib/auth/oidc-config";
import { parseOidcBootstrap } from "../src/lib/auth/oidc-bootstrap";

// This script never infers a dev database or inherits auth from a local identity.
if (process.env.RAVI_AUTH_MODE !== "oidc" || process.env.RAVI_SINGLE_TENANT_BOOTSTRAP !== "true" || !process.env.DATABASE_URL) {
  throw new Error("Bootstrap requires explicit OIDC mode, RAVI_SINGLE_TENANT_BOOTSTRAP=true and DATABASE_URL.");
}
const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Usage: bun scripts/bootstrap-single-tenant.ts <manifest.json>");
const config = getOidcConfig();
const manifest = parseOidcBootstrap(JSON.parse(await readFile(manifestPath, "utf8")), config);
const { db, dbClient, schema } = await import("../src/server/db");

try {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(828326486, 260523)`);
    const extra = await tx.select({ id: schema.organizations.id }).from(schema.organizations)
      .where(ne(schema.organizations.id, config.organizationId)).limit(1);
    if (extra.length) throw new Error("Bootstrap refuses a database containing another organization.");
    await tx.insert(schema.organizations).values({ ...manifest.organization,
      metadataJson: { createdFrom: "single-tenant-bootstrap" },
    }).onConflictDoNothing();
    const [organization] = await tx.select().from(schema.organizations).where(eq(schema.organizations.id, config.organizationId));
    if (!organization || organization.status !== "active") throw new Error("Bootstrap cannot create/reactivate this organization.");
    for (const user of manifest.users) {
      const emailMatches = await tx.select().from(schema.users)
        .where(sql`lower(${schema.users.primaryEmail}) = ${user.email}`);
      if (emailMatches.some((existing) => existing.id !== user.id)) throw new Error("Bootstrap email is already owned by another Ravi user.");
      await tx.insert(schema.users).values({ id: user.id, primaryEmail: user.email, displayName: user.name,
        metadataJson: { createdFrom: "single-tenant-bootstrap" },
      }).onConflictDoNothing();
      const [existingUser] = await tx.select().from(schema.users).where(eq(schema.users.id, user.id));
      if (!existingUser || existingUser.status !== "active" || existingUser.primaryEmail !== user.email) {
        throw new Error("Bootstrap cannot overwrite/reactivate this user.");
      }
      await tx.insert(schema.authIdentities).values({
        provider: oidcProvider(config.issuer), providerUserId: user.subject, userId: user.id, email: user.email,
        rawProfileJson: { createdFrom: "single-tenant-bootstrap", issuer: config.issuer, subject: user.subject },
      }).onConflictDoNothing();
      const [identity] = await tx.select().from(schema.authIdentities).where(and(
        eq(schema.authIdentities.provider, oidcProvider(config.issuer)), eq(schema.authIdentities.providerUserId, user.subject),
      ));
      if (!identity || identity.userId !== user.id) throw new Error("Bootstrap cannot reassign an identity.");
      const created = await tx.insert(schema.organizationMemberships).values({ organizationId: config.organizationId,
        userId: user.id, role: user.role, status: "active",
      }).onConflictDoNothing().returning();
      const [membership] = await tx.select().from(schema.organizationMemberships).where(and(
        eq(schema.organizationMemberships.organizationId, config.organizationId), eq(schema.organizationMemberships.userId, user.id),
      ));
      if (!membership || membership.status !== "active" || membership.role !== user.role) {
        throw new Error("Bootstrap cannot overwrite/reactivate this membership.");
      }
      if (created.length) await tx.insert(schema.auditEvents).values({
        organizationId: config.organizationId, actorType: "system", targetType: "membership", targetId: membership.id,
        action: "organization_member.bootstrapped", metadataJson: { userId: user.id, provider: "oidc", role: user.role },
      });
    }
  });
  console.log(`Single-tenant bootstrap verified: ${manifest.users.length} explicitly provisioned identities.`);
} finally {
  await dbClient.end();
}
