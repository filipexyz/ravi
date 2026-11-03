import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { cliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

/** `db` or a transaction opened from it. */
export type RaviLinkDbExecutor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

const CONTACT_MAX_LENGTH = 256;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_KEY_RE =
  /^(access_token|refresh_token|id_token|token|secret|password|api_key|apikey|client_secret|private_key|authorization|bearer)$/i;

const unlinkBodySchema = z
  .object({
    installationId: z.string().optional(),
    organizationId: z.string().optional(),
    contactId: z.string().optional(),
    bindingId: z.string().optional(),
    installation_id: z.string().optional(),
    organization_id: z.string().optional(),
    contact_id: z.string().optional(),
    binding_id: z.string().optional(),
  })
  .strict();

export type RaviLinkCaller = {
  membershipStatus: string;
  sessionInstallationId: string;
  sessionOrganizationId: string;
  userId: string;
};

export type RaviActorBindingRecord = typeof schema.raviActorBindings.$inferSelect;

export type RaviActorBindingPublic = {
  id: string;
  installationId: string;
  organizationId: string;
  consoleUserId: string;
  contactId: string;
  platformIdentities: JsonRecord;
  status: "active" | "revoked";
  linkedBy: string;
  linkedAt: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RaviLinkInstallationRecord = {
  id: string;
  organizationId: string;
  status: string;
};

export type RaviLinkMembershipRecord = {
  userId: string;
  organizationId: string;
  status: string;
};

export type RaviLinkAuditInput = {
  action: string;
  actorId: string;
  /** Defaults to `cli`; browser approvals and revokes are `user` (or `anonymous` in local dev). */
  actorType?: "anonymous" | "cli" | "user";
  metadata: JsonRecord;
  organizationId: string | null;
  requestId: string;
  targetId: string | null;
  /** Defaults to `ravi_actor_binding`. */
  targetType?: string;
};

export type RaviLinkRepository = {
  findInstallation(installationId: string): Promise<RaviLinkInstallationRecord | null>;
  findActiveMembership(
    organizationId: string,
    userId: string,
  ): Promise<RaviLinkMembershipRecord | null>;
  findActiveBindingByContact(
    installationId: string,
    contactId: string,
  ): Promise<RaviActorBindingRecord | null>;
  findLatestBindingForUserContact(
    installationId: string,
    contactId: string,
    consoleUserId: string,
  ): Promise<RaviActorBindingRecord | null>;
  findBindingById(bindingId: string): Promise<RaviActorBindingRecord | null>;
  listActiveBindingsByUser(
    installationId: string,
    consoleUserId: string,
  ): Promise<RaviActorBindingRecord[]>;
  insertBinding(
    values: typeof schema.raviActorBindings.$inferInsert,
  ): Promise<RaviActorBindingRecord>;
  updateBinding(
    bindingId: string,
    values: Partial<
      Pick<
        RaviActorBindingRecord,
        | "platformIdentitiesJson"
        | "status"
        | "linkedBy"
        | "linkedAt"
        | "revokedAt"
        | "updatedAt"
      >
    >,
  ): Promise<RaviActorBindingRecord>;
  insertAudit(input: RaviLinkAuditInput): Promise<void>;
};

/**
 * The direct binding POST is closed: it bound the turn's contact to whoever
 * ran `ravi login` (the operator), so in a channel anyone could end up acting
 * as the operator. Bindings are now written only when the person approves a
 * link request in the browser (see ravi-link-requests.ts).
 *
 * Old CLI builds are the only callers, and they send a locally generated
 * installation id, so the body is not read: validating it would answer them
 * PAYLOAD_INVALID or INSTALLATION_MISMATCH instead of the update signal.
 */
export async function upsertRaviLink(input: {
  caller: RaviLinkCaller;
  repository?: RaviLinkRepository;
  requestId: string;
}): Promise<never> {
  const repository = input.repository ?? raviLinkRepositoryForDb();
  try {
    await repository.insertAudit({
      action: "ravi_link.binding.denied",
      actorId: input.caller.userId,
      organizationId: input.caller.sessionOrganizationId,
      requestId: input.requestId,
      targetId: input.caller.sessionInstallationId,
      metadata: {
        reason: "approval_required",
        installationId: input.caller.sessionInstallationId,
        consoleUserId: input.caller.userId,
      },
    });
  } catch {
    // The audit is best effort; the answer is always the 410.
  }
  throw cliApiError(410, "LINK_APPROVAL_REQUIRED");
}

/**
 * Writes the active binding for an approved link request. Runs inside the
 * approval transaction; `consoleUserId` is always the person who approved.
 */
export async function writeApprovedBinding(input: {
  actorType: "anonymous" | "user";
  consoleUserId: string;
  contactId: string;
  installation: RaviLinkInstallationRecord;
  linkRequestId: string;
  platformIdentities: JsonRecord;
  repository: RaviLinkRepository;
  requestId: string;
}): Promise<
  | { kind: "conflict"; existing: RaviActorBindingRecord }
  | { kind: "created" | "reactivated" | "existing"; binding: RaviActorBindingRecord }
> {
  const { repository, installation, contactId, consoleUserId } = input;
  const now = new Date();
  const audit = (action: string, binding: RaviActorBindingRecord) =>
    repository.insertAudit({
      action,
      actorId: consoleUserId,
      actorType: input.actorType,
      organizationId: installation.organizationId,
      requestId: input.requestId,
      targetId: binding.id,
      metadata: {
        installationId: installation.id,
        contactId,
        consoleUserId,
        viaRequestId: input.linkRequestId,
      },
    });

  const active = await repository.findActiveBindingByContact(installation.id, contactId);
  if (active) {
    if (active.consoleUserId !== consoleUserId) {
      return { kind: "conflict", existing: active };
    }
    return { kind: "existing", binding: active };
  }

  const existing = await repository.findLatestBindingForUserContact(
    installation.id,
    contactId,
    consoleUserId,
  );
  if (existing && existing.status === "revoked") {
    const binding = await repository.updateBinding(existing.id, {
      platformIdentitiesJson: input.platformIdentities,
      status: "active",
      linkedBy: consoleUserId,
      linkedAt: now,
      revokedAt: null,
      updatedAt: now,
    });
    await audit("ravi_link.binding.reactivated", binding);
    return { kind: "reactivated", binding };
  }

  const binding = await repository.insertBinding({
    installationId: installation.id,
    organizationId: installation.organizationId,
    consoleUserId,
    contactId,
    platformIdentitiesJson: input.platformIdentities,
    status: "active",
    linkedBy: consoleUserId,
    linkedAt: now,
  });
  await audit("ravi_link.binding.created", binding);
  return { kind: "created", binding };
}

export async function resolveRaviLink(input: {
  caller: RaviLinkCaller;
  query: Record<string, string | undefined>;
  repository?: RaviLinkRepository;
  requestId: string;
}) {
  const contactRaw = firstString(input.query, "contactId", "contact_id");
  const consoleUserRaw = firstString(input.query, "consoleUserId", "console_user_id");
  if (contactRaw === undefined && consoleUserRaw === undefined) {
    throw cliApiError(
      400,
      "PAYLOAD_INVALID",
      "Resolve requires contactId or consoleUserId.",
    );
  }

  const contactId = contactRaw === undefined ? undefined : requireContactId(contactRaw);
  const consoleUserId = optionalUuid(consoleUserRaw, "consoleUserId");
  const repository = input.repository ?? raviLinkRepositoryForDb();
  const installation = await requireInstallationAccess({
    caller: input.caller,
    installationId: optionalUuid(
      firstString(input.query, "installationId", "installation_id"),
      "installationId",
    ),
    organizationId: optionalUuid(
      firstString(input.query, "organizationId", "organization_id"),
      "organizationId",
    ),
    repository,
    requestId: input.requestId,
  });

  if (contactId && consoleUserId) {
    const binding = await repository.findActiveBindingByContact(installation.id, contactId);
    return {
      version: 1 as const,
      binding:
        binding && binding.consoleUserId === consoleUserId ? publicBinding(binding) : null,
    };
  }

  if (contactId) {
    const binding = await repository.findActiveBindingByContact(installation.id, contactId);
    return { version: 1 as const, binding: binding ? publicBinding(binding) : null };
  }

  const bindings = await repository.listActiveBindingsByUser(installation.id, consoleUserId!);
  return { version: 1 as const, bindings: bindings.map(publicBinding) };
}

export async function unlinkRaviLink(input: {
  body: unknown;
  caller: RaviLinkCaller;
  repository?: RaviLinkRepository;
  requestId: string;
}) {
  const parsed = parseObject(unlinkBodySchema, input.body);
  const contactRaw = firstString(parsed, "contactId", "contact_id");
  const bindingId = optionalUuid(firstString(parsed, "bindingId", "binding_id"), "bindingId");
  if (contactRaw === undefined && !bindingId) {
    throw cliApiError(400, "CONTACT_REQUIRED", "Unlink requires contactId or bindingId.");
  }
  const contactId = contactRaw === undefined ? undefined : requireContactId(contactRaw);

  const repository = input.repository ?? raviLinkRepositoryForDb();
  const installation = await requireInstallationAccess({
    caller: input.caller,
    installationId: optionalUuid(
      firstString(parsed, "installationId", "installation_id"),
      "installationId",
    ),
    organizationId: optionalUuid(
      firstString(parsed, "organizationId", "organization_id"),
      "organizationId",
    ),
    repository,
    requestId: input.requestId,
  });

  const found = bindingId
    ? await repository.findBindingById(bindingId)
    : ((await repository.findActiveBindingByContact(installation.id, contactId!)) ??
      (await repository.findLatestBindingForUserContact(
        installation.id,
        contactId!,
        input.caller.userId,
      )));

  // Revoking only removes access, so the installation that owns the binding
  // may revoke it (the daemon does this when the person runs `ravi unlink`),
  // as may the bound user. Bindings elsewhere stay invisible.
  if (
    !found ||
    found.installationId !== installation.id ||
    found.organizationId !== installation.organizationId
  ) {
    return { version: 1 as const, binding: null };
  }

  if (found.status === "revoked") {
    return { version: 1 as const, binding: publicBinding(found) };
  }

  const now = new Date();
  const binding = await repository.updateBinding(found.id, {
    status: "revoked",
    revokedAt: now,
    updatedAt: now,
  });
  await repository.insertAudit({
    action: "ravi_link.binding.revoked",
    actorId: input.caller.userId,
    organizationId: installation.organizationId,
    requestId: input.requestId,
    targetId: binding.id,
    metadata: {
      installationId: installation.id,
      contactId: binding.contactId,
      consoleUserId: binding.consoleUserId,
      revokedBy: input.caller.userId,
      scope: binding.consoleUserId === input.caller.userId ? "self" : "installation",
    },
  });
  return { version: 1 as const, binding: publicBinding(binding) };
}

export function publicBinding(binding: RaviActorBindingRecord): RaviActorBindingPublic {
  return {
    id: binding.id,
    installationId: binding.installationId,
    organizationId: binding.organizationId,
    consoleUserId: binding.consoleUserId,
    contactId: binding.contactId,
    platformIdentities: binding.platformIdentitiesJson,
    status: binding.status,
    linkedBy: binding.linkedBy,
    linkedAt: binding.linkedAt.toISOString(),
    revokedAt: binding.revokedAt?.toISOString() ?? null,
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString(),
  };
}

export function raviLinkRepositoryForDb(
  executor: RaviLinkDbExecutor = db,
): RaviLinkRepository {
  const db = executor;
  return {
    async findInstallation(installationId) {
      const [row] = await db
        .select({
          id: schema.localInstallations.id,
          organizationId: schema.localInstallations.organizationId,
          status: schema.localInstallations.status,
        })
        .from(schema.localInstallations)
        .where(eq(schema.localInstallations.id, installationId))
        .limit(1);
      return row ?? null;
    },

    async findActiveMembership(organizationId, userId) {
      const [row] = await db
        .select({
          userId: schema.organizationMemberships.userId,
          organizationId: schema.organizationMemberships.organizationId,
          status: schema.organizationMemberships.status,
        })
        .from(schema.organizationMemberships)
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, organizationId),
            eq(schema.organizationMemberships.userId, userId),
            eq(schema.organizationMemberships.status, "active"),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async findActiveBindingByContact(installationId, contactId) {
      const [row] = await db
        .select()
        .from(schema.raviActorBindings)
        .where(
          and(
            eq(schema.raviActorBindings.installationId, installationId),
            eq(schema.raviActorBindings.contactId, contactId),
            eq(schema.raviActorBindings.status, "active"),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async findLatestBindingForUserContact(installationId, contactId, consoleUserId) {
      const [row] = await db
        .select()
        .from(schema.raviActorBindings)
        .where(
          and(
            eq(schema.raviActorBindings.installationId, installationId),
            eq(schema.raviActorBindings.contactId, contactId),
            eq(schema.raviActorBindings.consoleUserId, consoleUserId),
          ),
        )
        .orderBy(desc(schema.raviActorBindings.updatedAt))
        .limit(1);
      return row ?? null;
    },

    async findBindingById(bindingId) {
      const [row] = await db
        .select()
        .from(schema.raviActorBindings)
        .where(eq(schema.raviActorBindings.id, bindingId))
        .limit(1);
      return row ?? null;
    },

    async listActiveBindingsByUser(installationId, consoleUserId) {
      return db
        .select()
        .from(schema.raviActorBindings)
        .where(
          and(
            eq(schema.raviActorBindings.installationId, installationId),
            eq(schema.raviActorBindings.consoleUserId, consoleUserId),
            eq(schema.raviActorBindings.status, "active"),
          ),
        )
        .orderBy(desc(schema.raviActorBindings.linkedAt));
    },

    async insertBinding(values) {
      const [row] = await db.insert(schema.raviActorBindings).values(values).returning();
      if (!row) throw new Error("Failed to create actor binding.");
      return row;
    },

    async updateBinding(bindingId, values) {
      const [row] = await db
        .update(schema.raviActorBindings)
        .set(values)
        .where(eq(schema.raviActorBindings.id, bindingId))
        .returning();
      if (!row) throw new Error("Failed to update actor binding.");
      return row;
    },

    async insertAudit(input) {
      await db.insert(schema.auditEvents).values({
        organizationId: input.organizationId ?? undefined,
        actorType: input.actorType ?? "cli",
        actorId: input.actorId,
        targetType: input.targetType ?? "ravi_actor_binding",
        targetId: input.targetId,
        action: input.action,
        requestId: input.requestId,
        metadataJson: input.metadata,
      });
    },
  };
}

/**
 * Every /api/cli/link call acts on the CLI session's own installation. An
 * explicit `installationId` is accepted only when it names that installation,
 * so one installation can never read, claim or revoke another one's bindings.
 */
export async function requireInstallationAccess(input: {
  caller: RaviLinkCaller;
  installationId?: string;
  organizationId?: string;
  repository: RaviLinkRepository;
  requestId: string;
}) {
  const installationId = input.caller.sessionInstallationId;
  if (input.installationId && input.installationId !== installationId) {
    await input.repository.insertAudit({
      action: "ravi_link.binding.denied",
      actorId: input.caller.userId,
      organizationId: input.caller.sessionOrganizationId,
      requestId: input.requestId,
      targetId: installationId,
      metadata: {
        reason: "installation_mismatch",
        installationId,
        requestedInstallationId: input.installationId,
      },
    });
    throw cliApiError(403, "INSTALLATION_MISMATCH");
  }

  const installation = await input.repository.findInstallation(installationId);
  if (!installation) {
    await input.repository.insertAudit({
      action: "ravi_link.binding.denied",
      actorId: input.caller.userId,
      organizationId: input.caller.sessionOrganizationId,
      requestId: input.requestId,
      targetId: installationId,
      metadata: { reason: "installation_missing", installationId },
    });
    throw cliApiError(404, "LOCAL_INSTALLATION_MISSING");
  }

  if (installation.status === "revoked") {
    await deny(input.repository, {
      action: "ravi_link.binding.denied",
      caller: input.caller,
      installation,
      reason: "installation_revoked",
      requestId: input.requestId,
    });
    throw cliApiError(403, "INSTALLATION_REVOKED");
  }

  if (input.organizationId && input.organizationId !== installation.organizationId) {
    await deny(input.repository, {
      action: "ravi_link.binding.denied",
      caller: input.caller,
      installation,
      reason: "installation_org_mismatch",
      requestId: input.requestId,
    });
    throw cliApiError(409, "INSTALLATION_ORG_MISMATCH");
  }

  const sameSessionOrg = installation.organizationId === input.caller.sessionOrganizationId;
  if (sameSessionOrg) {
    if (input.caller.membershipStatus !== "active") {
      await deny(input.repository, {
        action: "ravi_link.binding.denied",
        caller: input.caller,
        installation,
        reason: "not_member",
        requestId: input.requestId,
      });
      throw cliApiError(403, "NOT_MEMBER");
    }
    return installation;
  }

  const membership = await input.repository.findActiveMembership(
    installation.organizationId,
    input.caller.userId,
  );
  if (!membership) {
    await deny(input.repository, {
      action: "ravi_link.binding.denied",
      caller: input.caller,
      installation,
      reason: "not_member",
      requestId: input.requestId,
    });
    throw cliApiError(403, "NOT_MEMBER");
  }
  return installation;
}

async function deny(
  repository: RaviLinkRepository,
  input: {
    action: string;
    caller: RaviLinkCaller;
    contactId?: string;
    installation: RaviLinkInstallationRecord;
    reason: string;
    requestId: string;
  },
) {
  await repository.insertAudit({
    action: input.action,
    actorId: input.caller.userId,
    organizationId: input.installation.organizationId,
    requestId: input.requestId,
    targetId: input.installation.id,
    metadata: {
      reason: input.reason,
      installationId: input.installation.id,
      contactId: input.contactId,
      consoleUserId: input.caller.userId,
    },
  });
}

export function requireContactId(value: string | undefined) {
  if (value === undefined) {
    throw cliApiError(400, "CONTACT_REQUIRED");
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) throw cliApiError(400, "CONTACT_REQUIRED");
  if (cleaned.length > CONTACT_MAX_LENGTH) {
    throw cliApiError(400, "PAYLOAD_INVALID", "contactId is too long.");
  }
  return cleaned;
}

export function optionalUuid(value: string | undefined, field: string) {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  if (!cleaned) {
    throw cliApiError(400, "PAYLOAD_INVALID", `${field} is invalid.`);
  }
  if (!UUID_RE.test(cleaned)) {
    throw cliApiError(400, "PAYLOAD_INVALID", `${field} is invalid.`);
  }
  return cleaned;
}

export function sanitizePlatformIdentities(value: JsonRecord | undefined) {
  if (value === undefined) return undefined;
  assertSafeIdentities(value);
  return value;
}

function assertSafeIdentities(value: unknown, path = "platformIdentities") {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeIdentities(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") {
    if (typeof value === "string" && /^\s*bearer\s+/i.test(value)) {
      throw cliApiError(400, "PAYLOAD_INVALID", `${path} must not include credentials.`);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      throw cliApiError(400, "PAYLOAD_INVALID", `${path} must not include credentials.`);
    }
    assertSafeIdentities(nested, `${path}.${key}`);
  }
}

export function parseObject<T>(schema: z.ZodType<T>, body: unknown): T {
  if (body === undefined || body === null || body === "") {
    return schema.parse({});
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw cliApiError(400, "PAYLOAD_INVALID");
  }
  return result.data;
}

export function firstString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw cliApiError(400, "PAYLOAD_INVALID");
    }
    return value;
  }
  return undefined;
}

export function firstRecord(
  record: Record<string, unknown>,
  ...keys: string[]
): JsonRecord | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw cliApiError(400, "PAYLOAD_INVALID", "platformIdentities must be an object.");
    }
    return value as JsonRecord;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown) {
  let current: unknown = error;
  for (let i = 0; i < 4; i += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code?: unknown }).code === "23505"
    ) {
      return true;
    }
    if (typeof current === "object" && current !== null && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}
