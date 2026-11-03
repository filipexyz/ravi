import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { isUuidRef } from "@/server/console/ref";
import { db, schema } from "@/server/db";

export const ADMIN_GRANTABLE_FEATURE_KEYS = [
  "console.internal_control",
  "console.managed_runtime",
  "console.knowledge",
] as const;

const grantBodySchema = z.object({
  enabled: z.boolean().optional().default(true),
  featureKey: z.enum(ADMIN_GRANTABLE_FEATURE_KEYS),
  organizationRef: z.string().trim().min(1).max(240),
  reason: z.string().min(3).max(500),
});

type GrantAdminEntitlementInput = {
  body: unknown;
  requestId: string;
};

export async function grantAdminEntitlement(input: GrantAdminEntitlementInput) {
  const body = parseAdminEntitlementGrantBody(input.body);

  return db.transaction(async (tx) => {
    const organizationPredicate = isUuidRef(body.organizationRef)
      ? eq(schema.organizations.id, body.organizationRef)
      : eq(schema.organizations.slug, body.organizationRef);

    const [organization] = await tx.select().from(schema.organizations).where(organizationPredicate).limit(1);

    if (!organization) {
      return {
        status: "not_found" as const,
        code: "organization_not_found",
      };
    }

    const [before] = await tx
      .select()
      .from(schema.entitlements)
      .where(
        and(
          eq(schema.entitlements.organizationId, organization.id),
          eq(schema.entitlements.key, body.featureKey),
        ),
      )
      .limit(1);

    const now = new Date();
    const [entitlement] = await tx
      .insert(schema.entitlements)
      .values({
        organizationId: organization.id,
        key: body.featureKey,
        valueJson: { enabled: body.enabled },
        source: "admin_bootstrap",
        startsAt: null,
        endsAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.entitlements.organizationId, schema.entitlements.key],
        set: {
          valueJson: { enabled: body.enabled },
          source: "admin_bootstrap",
          startsAt: null,
          endsAt: null,
          updatedAt: now,
        },
      })
      .returning();

    await tx.insert(schema.auditEvents).values({
      organizationId: organization.id,
      actorType: "system",
      actorId: null,
      targetType: "entitlement",
      targetId: entitlement?.id ?? body.featureKey,
      action: body.enabled ? "admin.entitlement.granted" : "admin.entitlement.revoked",
      requestId: input.requestId,
      beforeJson: before ? sanitizeEntitlementAudit(before) : null,
      afterJson: entitlement ? sanitizeEntitlementAudit(entitlement) : null,
      metadataJson: {
        featureKey: body.featureKey,
        reason: body.reason,
        source: "admin_bootstrap",
      },
    });

    return {
      status: "ok" as const,
      entitlement: entitlement ? sanitizeEntitlementAudit(entitlement) : null,
      organization: {
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
        status: organization.status,
      },
    };
  });
}

export function parseAdminEntitlementGrantBody(body: unknown) {
  const result = grantBodySchema.safeParse(body);
  if (!result.success) {
    return fail("invalid_body");
  }
  return result.data;
}

function fail(code: string): never {
  const error = new Error(code);
  error.name = "AdminEntitlementError";
  throw error;
}

function sanitizeEntitlementAudit(entitlement: typeof schema.entitlements.$inferSelect) {
  return {
    id: entitlement.id,
    key: entitlement.key,
    source: entitlement.source,
    startsAt: entitlement.startsAt?.toISOString() ?? null,
    endsAt: entitlement.endsAt?.toISOString() ?? null,
    valueJson: entitlement.valueJson,
  };
}
