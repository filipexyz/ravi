/**
 * The person of the turn, on CLI requests.
 *
 * Every CLI request runs with the installation's `ravi login` session (the
 * executor). When an agent turn has a human author, the local daemon names
 * that person's contact in `x-ravi-actor-contact`; Console then resolves the
 * installation's active `ravi link` binding for that contact and acts as the
 * bound user, so writes (Pages publishes, Bases rows, audit) are credited to
 * the person and not to the installation owner.
 *
 * Guardrails, all of which must hold before a write runs (a named person who
 * fails them is refused, never replaced by the installation owner; a read
 * is refused too; an unlinked author never receives the executor's data):
 *
 * - the binding is active, on this installation and organization, and was
 *   approved by that same person (`linked_by = console_user_id`);
 * - the person is an active user with an active membership in the session's
 *   organization (the organization every project of this session belongs to);
 * - the acting role is the lesser of the two roles, so a turn never does more
 *   than either the installation owner or the person may do.
 *
 * Writes record both identities: one `cli.actor.delegated` audit event per
 * request (same `request_id` as the write's own audit, ledger and publish
 * rows), or `cli.actor.denied` with the reason when the write is refused:
 * `ACTOR_NOT_LINKED` (no binding approved by that person), `PROJECT_ACCESS_DENIED`
 * (not an active member) or `PAYLOAD_INVALID` (a malformed contact).
 */

import { and, eq, isNull } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { cliApiError } from "./errors";
import type { CliAuthRecords, CliMembershipRecord, CliUserRecord } from "./state";

export const CLI_ACTOR_CONTACT_HEADER = "x-ravi-actor-contact";

/** Local contact ids are short opaque tokens; anything else is ignored. */
const CONTACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/;

const ROLE_RANK: Record<string, number> = {
  owner: 4,
  admin: 3,
  developer: 2,
  viewer: 1,
  billing: 0,
};

export type CliActorRefusalReason =
  | "invalid_contact"
  | "not_linked"
  | "not_approved_by_person"
  | "not_member";

export type CliActorDelegation = {
  contactId: string;
  bindingId: string;
  /** The `ravi login` session's own user and membership. */
  executor: { user: CliUserRecord; membership: CliMembershipRecord };
};

export type CliActorBinding = {
  id: string;
  consoleUserId: string;
  linkedBy: string;
};

export type CliActorMember = {
  user: CliUserRecord;
  membership: CliMembershipRecord;
};

export type CliActorDeps = {
  findBinding?: (input: {
    installationId: string;
    organizationId: string;
    contactId: string;
  }) => Promise<CliActorBinding | null>;
  findMember?: (input: { organizationId: string; userId: string }) => Promise<CliActorMember | null>;
  audit?: (values: typeof schema.auditEvents.$inferInsert) => Promise<void>;
};

export type CliActorOptions = {
  /** A route that knows a POST only reads (a query) says so; otherwise the method decides. */
  access?: CliRequestAccess;
  /**
   * Retained only for call-site migration. Reads always refuse an unresolved
   * named human; no option can restore the executor fallback.
   */
  unlinkedReads?: "executor" | "refuse";
};

export type CliActorResolution<T extends CliAuthRecords> = T & {
  delegation: CliActorDelegation | null;
};

/**
 * `records` as the person of the turn when the request names a usable
 * contact, else unchanged with `delegation: null`.
 */
export async function resolveCliActor<T extends CliAuthRecords>(
  records: T,
  request: Pick<Request, "headers" | "method" | "url">,
  requestId: string,
  deps: CliActorDeps = {},
  options: CliActorOptions = {},
): Promise<CliActorResolution<T>> {
  const raw = request.headers.get(CLI_ACTOR_CONTACT_HEADER);
  const contactId = raw?.trim() ?? "";
  if (!contactId) return { ...records, delegation: null };

  const audit = deps.audit ?? insertAuditEvent;
  const writes = options.access ? options.access === "write" : isWrite(request.method);
  // Both reads and writes preserve the named human; no executor fallback.
  const unusable = async (reason: CliActorRefusalReason, extra: Record<string, unknown> = {}) => {
    await audit({
      organizationId: records.organization.id,
      actorType: "agent",
      actorId: records.user.id,
      targetType: "ravi_actor_contact",
      targetId: null,
      action: "cli.actor.denied",
      requestId,
      metadataJson: {
        reason,
        ...extra,
        ...requestMetadata(records, request),
      },
    });
    throw refusal(reason);
  };

  if (!CONTACT_ID_PATTERN.test(contactId)) return unusable("invalid_contact");

  const binding = await (deps.findBinding ?? findActiveCliActorBinding)({
    installationId: records.localInstallation.id,
    organizationId: records.organization.id,
    contactId,
  });
  if (!binding) return unusable("not_linked", { contactId });
  if (binding.linkedBy !== binding.consoleUserId) {
    return unusable("not_approved_by_person", { contactId, bindingId: binding.id });
  }
  // Even owner==actor retains the verified binding, so revocation is effective.
  const member = binding.consoleUserId === records.user.id
    ? { user: records.user, membership: records.membership }
    : await (deps.findMember ?? findActiveCliActorMember)({
    organizationId: records.organization.id,
    userId: binding.consoleUserId,
  });
  if (!member) return unusable("not_member", { contactId, bindingId: binding.id });

  const role = lesserRole(records.membership.role, member.membership.role);
  const delegation: CliActorDelegation = {
    contactId,
    bindingId: binding.id,
    executor: { user: records.user, membership: records.membership },
  };
  if (writes) {
    await audit({
      organizationId: records.organization.id,
      actorType: "agent",
      actorId: records.user.id,
      targetType: "user",
      targetId: member.user.id,
      action: "cli.actor.delegated",
      requestId,
      metadataJson: {
        executorUserId: records.user.id,
        executorRole: records.membership.role,
        actorUserId: member.user.id,
        actorRole: member.membership.role,
        role,
        contactId,
        bindingId: binding.id,
        ...requestMetadata(records, request),
      },
    });
  }

  return {
    ...records,
    user: member.user,
    membership: { ...member.membership, role },
    delegation,
  };
}

function refusal(reason: CliActorRefusalReason) {
  switch (reason) {
    case "invalid_contact":
      return cliApiError(400, "PAYLOAD_INVALID", "The x-ravi-actor-contact header is malformed.", { reason });
    case "not_member":
      return cliApiError(
        403,
        "PROJECT_ACCESS_DENIED",
        "The person asking is not an active member of this organization, so Ravi will not act on their behalf.",
        { reason },
      );
    default:
      return cliApiError(403, "ACTOR_NOT_LINKED", undefined, { reason });
  }
}

/** Whether a request reads or writes, when the route knows better than its method. */
export type CliRequestAccess = "read" | "write";

/** The lesser of two organization roles; an unknown role wins (fails closed). */
export function lesserRole(a: string, b: string): string {
  const rankA = ROLE_RANK[a] ?? -1;
  const rankB = ROLE_RANK[b] ?? -1;
  return rankA <= rankB ? a : b;
}

function isWrite(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== "GET" && upper !== "HEAD" && upper !== "OPTIONS";
}

function requestMetadata(records: CliAuthRecords, request: Pick<Request, "method" | "url">) {
  let path: string | null = null;
  try {
    path = new URL(request.url).pathname;
  } catch {
    path = null;
  }
  return {
    method: request.method.toUpperCase(),
    path,
    localInstallationId: records.localInstallation.id,
    cliSessionId: records.cliSession.id,
  };
}

export async function findActiveCliActorBinding(input: {
  installationId: string;
  organizationId: string;
  contactId: string;
}): Promise<CliActorBinding | null> {
  const [row] = await db
    .select({
      id: schema.raviActorBindings.id,
      consoleUserId: schema.raviActorBindings.consoleUserId,
      linkedBy: schema.raviActorBindings.linkedBy,
    })
    .from(schema.raviActorBindings)
    .where(
      and(
        eq(schema.raviActorBindings.installationId, input.installationId),
        eq(schema.raviActorBindings.organizationId, input.organizationId),
        eq(schema.raviActorBindings.contactId, input.contactId),
        eq(schema.raviActorBindings.status, "active"),
        isNull(schema.raviActorBindings.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findActiveCliActorMember(input: {
  organizationId: string;
  userId: string;
}): Promise<CliActorMember | null> {
  const [row] = await db
    .select({
      user: {
        id: schema.users.id,
        primaryEmail: schema.users.primaryEmail,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
        status: schema.users.status,
      },
      membership: {
        id: schema.organizationMemberships.id,
        role: schema.organizationMemberships.role,
        status: schema.organizationMemberships.status,
      },
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, input.organizationId),
        eq(schema.organizationMemberships.userId, input.userId),
        eq(schema.organizationMemberships.status, "active"),
        eq(schema.users.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function insertAuditEvent(values: typeof schema.auditEvents.$inferInsert) {
  await db.insert(schema.auditEvents).values(values);
}
