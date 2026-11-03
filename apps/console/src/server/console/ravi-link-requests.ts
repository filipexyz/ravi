import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { and, count, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { hasActiveBrowserSession, hasActiveMember, lockMemberIssuance } from "@/lib/auth/member-issuance";

import type { CliAuthContext } from "@/server/cli/auth";
import { CliApiError, cliApiError, type CliErrorCode } from "@/server/cli/errors";
import { getCliAccessTokenSecret, hashToken } from "@/server/cli/tokens";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import {
  firstRecord,
  firstString,
  isUniqueViolation,
  optionalUuid,
  parseObject,
  publicBinding,
  raviLinkRepositoryForDb,
  requireContactId,
  requireInstallationAccess,
  sanitizePlatformIdentities,
  writeApprovedBinding,
  type RaviActorBindingPublic,
  type RaviActorBindingRecord,
  type RaviLinkCaller,
  type RaviLinkDbExecutor,
  type RaviLinkInstallationRecord,
  type RaviLinkRepository,
} from "./ravi-link";

/**
 * Link requests: the only way a chat contact gets bound to a Console user.
 *
 * The local daemon asks for a request on behalf of the person who wrote the
 * message, DMs them the single-use approve URL, and the person approves it
 * here while signed in. The binding is then written for the approver, never
 * for the operator whose CLI session created the request.
 */

export const RAVI_LINK_REQUEST_TTL_MS = 10 * 60 * 1000;
export const RAVI_LINK_REQUEST_RATE_LIMIT = 5;
export const RAVI_LINK_REQUEST_RATE_WINDOW_MS = 10 * 60 * 1000;

const TOKEN_PREFIX = "ravi_lr_";
const TOKEN_RE = /^ravi_lr_[A-Za-z0-9_-]{43}$/;
const DISPLAY_NAME_MAX_LENGTH = 80;
const EMAIL_MAX_LENGTH = 320;

const createBodySchema = z
  .object({
    contactId: z.string().optional(),
    contact_id: z.string().optional(),
    platformIdentities: z.record(z.string(), z.unknown()).optional(),
    platform_identities: z.record(z.string(), z.unknown()).optional(),
    requester: z
      .object({
        displayName: z.string().optional(),
        display_name: z.string().optional(),
      })
      .strict()
      .optional(),
    expectedEmail: z.string().optional(),
    expected_email: z.string().optional(),
    installationId: z.string().optional(),
    installation_id: z.string().optional(),
    organizationId: z.string().optional(),
    organization_id: z.string().optional(),
  })
  .strict();

export type RaviLinkRequestRecord = typeof schema.raviLinkRequests.$inferSelect;
export type RaviLinkRequestStatus = RaviLinkRequestRecord["status"];

export type RaviLinkRequestCaller = RaviLinkCaller & {
  cliSessionId: string;
};

export type RaviLinkApprover = {
  requireBrowserSession?: boolean;
  browserSessionId?: string;
  actorType: "anonymous" | "user";
  email: string | null;
  emailVerified: boolean;
  impersonated: boolean;
  userId: string;
};

export type RaviLinkInstallationDetails = {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  status: string;
};

export type RaviLinkUserBinding = {
  id: string;
  channel: string | null;
  installationName: string;
  linkedAt: string;
  organizationName: string;
};

export type RaviLinkRequestRepository = RaviLinkRepository & {
  lockIssuance(organizationId: string): Promise<void>;
  assertCurrentCaller(organizationId: string, caller: RaviLinkRequestCaller): Promise<void>;
  assertCurrentApprover(organizationId: string, approver: RaviLinkApprover): Promise<void>;
  transaction<T>(fn: (repository: RaviLinkRequestRepository) => Promise<T>): Promise<T>;
  findRequestByTokenHash(
    tokenHash: string,
    options?: { forUpdate?: boolean },
  ): Promise<RaviLinkRequestRecord | null>;
  findRequestById(requestId: string): Promise<RaviLinkRequestRecord | null>;
  findPendingRequestForContact(
    installationId: string,
    contactId: string,
  ): Promise<RaviLinkRequestRecord | null>;
  countRequestsSince(installationId: string, contactId: string, since: Date): Promise<number>;
  insertRequest(
    values: typeof schema.raviLinkRequests.$inferInsert,
  ): Promise<RaviLinkRequestRecord>;
  /** Conditional update: returns null when the row is no longer in `whenStatus`. */
  updateRequest(
    requestId: string,
    whenStatus: RaviLinkRequestStatus,
    values: Partial<
      Pick<
        RaviLinkRequestRecord,
        | "status"
        | "approvedByUserId"
        | "approvedAt"
        | "deniedAt"
        | "cancelledAt"
        | "bindingId"
        | "failureReason"
        | "updatedAt"
      >
    >,
  ): Promise<RaviLinkRequestRecord | null>;
  findInstallationDetails(installationId: string): Promise<RaviLinkInstallationDetails | null>;
  listActiveBindingsForConsoleUser(consoleUserId: string): Promise<RaviLinkUserBinding[]>;
};

export type RaviLinkRequestPublic = {
  id: string;
  status: RaviLinkRequestStatus;
  expiresAt: string;
  approvedAt?: string;
  failureReason?: string;
};

// ---------------------------------------------------------------------------
// CLI side (bearer CLI session of the local installation)
// ---------------------------------------------------------------------------

export function raviLinkRequestCallerFromCliAuth(auth: CliAuthContext): RaviLinkRequestCaller {
  return {
    cliSessionId: auth.cliSession.id,
    membershipStatus: auth.membership.status,
    sessionInstallationId: auth.localInstallation.id,
    sessionOrganizationId: auth.organization.id,
    userId: auth.user.id,
  };
}

export async function createRaviLinkRequest(input: {
  body: unknown;
  caller: RaviLinkRequestCaller;
  now?: Date;
  origin: string;
  repository?: RaviLinkRequestRepository;
  requestId: string;
}): Promise<
  | { httpStatus: 200; payload: { version: 1; status: "already_linked"; binding: RaviActorBindingPublic } }
  | {
      httpStatus: 201;
      payload: {
        version: 1;
        status: "pending";
        request: RaviLinkRequestPublic;
        approveUrl: string;
      };
    }
> {
  const parsed = parseObject(createBodySchema, input.body);
  const repository = input.repository ?? raviLinkRequestRepositoryForDb();
  const contactId = requireContactId(firstString(parsed, "contactId", "contact_id"));
  const platformIdentities =
    sanitizePlatformIdentities(firstRecord(parsed, "platformIdentities", "platform_identities")) ??
    {};
  const requesterDisplayName = cleanDisplayName(
    parsed.requester ? firstString(parsed.requester, "displayName", "display_name") : undefined,
  );
  const expectedEmail = normalizeEmail(firstString(parsed, "expectedEmail", "expected_email"));
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

  const active = await repository.findActiveBindingByContact(installation.id, contactId);
  if (active) {
    return {
      httpStatus: 200,
      payload: { version: 1, status: "already_linked", binding: publicBinding(active) },
    };
  }

  const now = input.now ?? new Date();
  const recent = await repository.countRequestsSince(
    installation.id,
    contactId,
    new Date(now.getTime() - RAVI_LINK_REQUEST_RATE_WINDOW_MS),
  );
  if (recent >= RAVI_LINK_REQUEST_RATE_LIMIT) {
    await repository.insertAudit({
      action: "ravi_link.request.rate_limited",
      actorId: input.caller.userId,
      organizationId: installation.organizationId,
      requestId: input.requestId,
      targetId: installation.id,
      targetType: "local_installation",
      metadata: { installationId: installation.id, contactId, recent },
    });
    throw cliApiError(429, "RATE_LIMITED", "Too many link requests for this person. Try again later.");
  }

  const token = generateLinkRequestToken();
  const expectedEmailHash = expectedEmail ? emailHintHash(expectedEmail) : null;
  try {
    const created = await repository.transaction(async (tx) => {
      await tx.lockIssuance(installation.organizationId);
      const previous = await tx.findPendingRequestForContact(installation.id, contactId);
      await tx.assertCurrentCaller(installation.organizationId, input.caller);
      const now = input.now ?? new Date();
      const expiresAt = new Date(now.getTime() + RAVI_LINK_REQUEST_TTL_MS);
      if (previous) {
        await tx.updateRequest(previous.id, "pending", {
          status: "cancelled",
          cancelledAt: now,
          failureReason: "rotated",
          updatedAt: now,
        });
      }
      const request = await tx.insertRequest({
        tokenHash: linkRequestTokenHash(token),
        installationId: installation.id,
        organizationId: installation.organizationId,
        requestedByUserId: input.caller.userId,
        cliSessionId: input.caller.cliSessionId,
        contactId,
        platformIdentitiesJson: platformIdentities,
        requesterDisplayName,
        expectedEmailHash,
        status: "pending",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insertAudit({
        action: "ravi_link.request.created",
        actorId: input.caller.userId,
        organizationId: installation.organizationId,
        requestId: input.requestId,
        targetId: request.id,
        targetType: "ravi_link_request",
        metadata: {
          installationId: installation.id,
          contactId,
          emailHint: expectedEmailHash !== null,
          ...(previous ? { rotatedRequestId: previous.id } : {}),
        },
      });
      await tx.assertCurrentCaller(installation.organizationId, input.caller);
      return request;
    });

    return {
      httpStatus: 201,
      payload: {
        version: 1,
        status: "pending",
        request: publicRequest(created),
        approveUrl: raviLinkApproveUrl(input.origin, token),
      },
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Another request for the same person landed at the same moment.
      throw cliApiError(429, "RATE_LIMITED", "A link request for this person is being created. Try again.");
    }
    throw error;
  }
}

export async function getRaviLinkRequestForCli(input: {
  caller: RaviLinkRequestCaller;
  linkRequestId: string;
  now?: Date;
  repository?: RaviLinkRequestRepository;
  requestId: string;
}): Promise<{ version: 1; request: RaviLinkRequestPublic; binding?: RaviActorBindingPublic }> {
  const repository = input.repository ?? raviLinkRequestRepositoryForDb();
  const installation = await requireInstallationAccess({
    caller: input.caller,
    repository,
    requestId: input.requestId,
  });
  let request = await findOwnRequest(repository, installation, input.linkRequestId);
  const now = input.now ?? new Date();

  if (request.status === "pending" && request.expiresAt <= now) {
    request =
      (await repository.updateRequest(request.id, "pending", {
        status: "expired",
        failureReason: "expired",
        updatedAt: now,
      })) ?? (await findOwnRequest(repository, installation, input.linkRequestId));
  }

  if (request.status === "approved" && request.bindingId) {
    const binding = await repository.findBindingById(request.bindingId);
    if (binding && binding.status === "active" && binding.installationId === installation.id) {
      return { version: 1, request: publicRequest(request), binding: publicBinding(binding) };
    }
  }
  return { version: 1, request: publicRequest(request) };
}

export async function cancelRaviLinkRequestForCli(input: {
  caller: RaviLinkRequestCaller;
  linkRequestId: string;
  now?: Date;
  repository?: RaviLinkRequestRepository;
  requestId: string;
}): Promise<{ version: 1; request: RaviLinkRequestPublic }> {
  const repository = input.repository ?? raviLinkRequestRepositoryForDb();
  const installation = await requireInstallationAccess({
    caller: input.caller,
    repository,
    requestId: input.requestId,
  });
  const request = await findOwnRequest(repository, installation, input.linkRequestId);
  if (request.status !== "pending") {
    return { version: 1, request: publicRequest(request) };
  }

  const now = input.now ?? new Date();
  const cancelled = await repository.updateRequest(request.id, "pending", {
    status: "cancelled",
    cancelledAt: now,
    failureReason: "cancelled",
    updatedAt: now,
  });
  if (!cancelled) {
    return {
      version: 1,
      request: publicRequest(await findOwnRequest(repository, installation, input.linkRequestId)),
    };
  }
  await repository.insertAudit({
    action: "ravi_link.request.cancelled",
    actorId: input.caller.userId,
    organizationId: installation.organizationId,
    requestId: input.requestId,
    targetId: cancelled.id,
    targetType: "ravi_link_request",
    metadata: { installationId: installation.id, contactId: cancelled.contactId },
  });
  return { version: 1, request: publicRequest(cancelled) };
}

// ---------------------------------------------------------------------------
// Browser side (signed-in Console user who received the link)
// ---------------------------------------------------------------------------

export type RaviLinkRequestView =
  | { state: "invalid" }
  | { state: "expired" }
  | { state: "used" }
  | { state: "approved" }
  | { state: "not_member" }
  | { state: "user_mismatch" }
  | {
      state: "pending";
      channel: string | null;
      expiresAt: string;
      installationName: string;
      organizationName: string;
      requesterDisplayName: string | null;
    };

/** Read-only: link unfurlers fetch this page, so it must not change state. */
export async function getRaviLinkRequestView(input: {
  approver: RaviLinkApprover;
  now?: Date;
  repository?: RaviLinkRequestRepository;
  token: string | null | undefined;
}): Promise<RaviLinkRequestView> {
  const repository = input.repository ?? raviLinkRequestRepositoryForDb();
  const token = normalizeToken(input.token);
  if (!token) return { state: "invalid" };
  const request = await repository.findRequestByTokenHash(linkRequestTokenHash(token));
  if (!request) return { state: "invalid" };

  if (request.status === "approved") {
    return request.approvedByUserId === input.approver.userId
      ? { state: "approved" }
      : { state: "used" };
  }
  if (request.status === "expired") return { state: "expired" };
  if (request.status !== "pending") return { state: "used" };
  const now = input.now ?? new Date();
  if (request.expiresAt <= now) return { state: "expired" };

  const membership = await repository.findActiveMembership(
    request.organizationId,
    input.approver.userId,
  );
  if (!membership) return { state: "not_member" };
  if (approverMismatchReason(request, input.approver)) return { state: "user_mismatch" };

  const installation = await repository.findInstallationDetails(request.installationId);
  if (!installation || installation.status === "revoked") return { state: "invalid" };

  return {
    state: "pending",
    channel: channelLabel(request.platformIdentitiesJson),
    expiresAt: request.expiresAt.toISOString(),
    installationName: installation.name,
    organizationName: installation.organizationName,
    requesterDisplayName: request.requesterDisplayName,
  };
}

export async function approveRaviLinkRequest(input: {
  approver: RaviLinkApprover;
  now?: Date;
  repository?: RaviLinkRequestRepository;
  requestId: string;
  token: string | null | undefined;
}): Promise<{ binding: RaviActorBindingPublic; reused: boolean }> {
  const repository = input.repository ?? raviLinkRequestRepositoryForDb();
  const token = normalizeToken(input.token);
  if (!token) {
    await auditRejection(repository, input, null, "invalid_token");
    throw cliApiError(404, "LINK_REQUEST_INVALID");
  }

  let outcome: ApproveOutcome;
  try {
    // Only discover the lock key here. Request and current admission are read
    // again after Fleet, before any request-row lock (no lifecycle inversion).
    const observed = await repository.findRequestByTokenHash(linkRequestTokenHash(token));
    if (!observed) {
      await auditRejection(repository, input, null, "invalid_token");
      throw cliApiError(404, "LINK_REQUEST_INVALID");
    }
    outcome = await repository.transaction(async (tx): Promise<ApproveOutcome> => {
      await tx.lockIssuance(observed.organizationId);
      const request = await tx.findRequestByTokenHash(linkRequestTokenHash(token), {
        forUpdate: true,
      });
      const now = input.now ?? new Date();
      const failure = await checkPendingRequest(tx, request, now);
      if (failure) return failure;
      const pending = request!;
      if (pending.organizationId !== observed.organizationId) throw cliApiError(404, "LINK_REQUEST_INVALID");
      await tx.assertCurrentApprover(pending.organizationId, input.approver);

      const membership = await tx.findActiveMembership(pending.organizationId, input.approver.userId);
      if (!membership) return fail(pending, 403, "NOT_MEMBER", "not_member");

      const mismatch = approverMismatchReason(pending, input.approver);
      if (mismatch) return fail(pending, 403, "LINK_USER_MISMATCH", mismatch);

      const installation = await tx.findInstallation(pending.installationId);
      if (!installation) return fail(pending, 404, "LINK_REQUEST_INVALID", "installation_missing");
      if (installation.status === "revoked") {
        return fail(pending, 403, "INSTALLATION_REVOKED", "installation_revoked");
      }

      const written = await writeApprovedBinding({
        actorType: input.approver.actorType,
        consoleUserId: input.approver.userId,
        contactId: pending.contactId,
        installation,
        linkRequestId: pending.id,
        platformIdentities: pending.platformIdentitiesJson,
        repository: tx,
        requestId: input.requestId,
      });
      if (written.kind === "conflict") {
        return fail(pending, 409, "CONFLICT", "contact_linked_to_another_user");
      }

      const approved = await tx.updateRequest(pending.id, "pending", {
        status: "approved",
        approvedByUserId: input.approver.userId,
        approvedAt: now,
        bindingId: written.binding.id,
        updatedAt: now,
      });
      if (!approved) {
        // Lost a race with another approval or cancel: undo the binding write.
        throw cliApiError(409, "LINK_REQUEST_USED");
      }
      await tx.insertAudit({
        action: "ravi_link.request.approved",
        actorId: input.approver.userId,
        actorType: input.approver.actorType,
        organizationId: installation.organizationId,
        requestId: input.requestId,
        targetId: approved.id,
        targetType: "ravi_link_request",
        metadata: {
          installationId: installation.id,
          contactId: approved.contactId,
          bindingId: written.binding.id,
          bindingWrite: written.kind,
        },
      });
      // Binding reactivation/unique-key/audit writes can also wait. Revalidate
      // inside this transaction; throw (not a failure return) to undo all writes.
      await tx.assertCurrentApprover(pending.organizationId, input.approver);
      if (pending.expiresAt <= (input.now ?? new Date())) throw cliApiError(410, "LINK_REQUEST_EXPIRED");
      return { ok: true, binding: written.binding, reused: written.kind === "existing" };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      await auditRejection(repository, input, null, "contact_linked_to_another_user");
      throw cliApiError(409, "CONFLICT");
    }
    if (error instanceof CliApiError && error.code === "LINK_REQUEST_USED") {
      await auditRejection(repository, input, null, "already_used");
    }
    if (error instanceof CliApiError && error.code === "NOT_MEMBER") {
      await auditRejection(repository, input, null, "not_member");
    }
    if (error instanceof CliApiError && error.code === "LINK_REQUEST_EXPIRED") {
      await auditRejection(repository, input, null, "expired");
    }
    throw error;
  }

  if (!outcome.ok) {
    await auditRejection(repository, input, outcome.request, outcome.reason);
    throw cliApiError(outcome.status, outcome.code);
  }
  return { binding: publicBinding(outcome.binding), reused: outcome.reused };
}

export async function denyRaviLinkRequest(input: {
  approver: RaviLinkApprover;
  now?: Date;
  repository?: RaviLinkRequestRepository;
  requestId: string;
  token: string | null | undefined;
}): Promise<{ ok: true }> {
  const repository = input.repository ?? raviLinkRequestRepositoryForDb();
  const token = normalizeToken(input.token);
  if (!token) throw cliApiError(404, "LINK_REQUEST_INVALID");

  const outcome = await repository.transaction(async (tx): Promise<DenyOutcome> => {
    const request = await tx.findRequestByTokenHash(linkRequestTokenHash(token), {
      forUpdate: true,
    });
    const now = input.now ?? new Date();
    const failure = await checkPendingRequest(tx, request, now);
    if (failure) return failure;
    const pending = request!;

    const membership = await tx.findActiveMembership(pending.organizationId, input.approver.userId);
    if (!membership) return fail(pending, 403, "NOT_MEMBER", "not_member");

    const denied = await tx.updateRequest(pending.id, "pending", {
      status: "denied",
      deniedAt: now,
      failureReason: "denied",
      updatedAt: now,
    });
    if (!denied) return fail(pending, 409, "LINK_REQUEST_USED", "already_used");
    await tx.insertAudit({
      action: "ravi_link.request.denied",
      actorId: input.approver.userId,
      actorType: input.approver.actorType,
      organizationId: denied.organizationId,
      requestId: input.requestId,
      targetId: denied.id,
      targetType: "ravi_link_request",
      metadata: { installationId: denied.installationId, contactId: denied.contactId },
    });
    return { ok: true };
  });

  if (!outcome.ok) {
    await auditRejection(repository, input, outcome.request, outcome.reason);
    throw cliApiError(outcome.status, outcome.code);
  }
  return { ok: true };
}

/** The signed-in user's own active chat links, for the revoke page. */
export async function listRaviLinkBindingsForUser(input: {
  consoleUserId: string;
  repository?: RaviLinkRequestRepository;
}) {
  const repository = input.repository ?? raviLinkRequestRepositoryForDb();
  return repository.listActiveBindingsForConsoleUser(input.consoleUserId);
}

/** Self-only revoke from the browser. Unknown or foreign bindings are NOT_FOUND. */
export async function revokeRaviLinkBindingForUser(input: {
  approver: RaviLinkApprover;
  bindingId: string;
  repository?: RaviLinkRequestRepository;
  requestId: string;
}): Promise<{ binding: RaviActorBindingPublic }> {
  const repository = input.repository ?? raviLinkRequestRepositoryForDb();
  const bindingId = optionalUuidOrNull(input.bindingId);
  const found = bindingId ? await repository.findBindingById(bindingId) : null;
  if (!found || found.consoleUserId !== input.approver.userId) {
    throw cliApiError(404, "NOT_FOUND");
  }
  if (found.status === "revoked") return { binding: publicBinding(found) };

  const now = new Date();
  const binding = await repository.updateBinding(found.id, {
    status: "revoked",
    revokedAt: now,
    updatedAt: now,
  });
  await repository.insertAudit({
    action: "ravi_link.binding.revoked",
    actorId: input.approver.userId,
    actorType: input.approver.actorType,
    organizationId: binding.organizationId,
    requestId: input.requestId,
    targetId: binding.id,
    metadata: {
      installationId: binding.installationId,
      contactId: binding.contactId,
      consoleUserId: binding.consoleUserId,
      revokedBy: input.approver.userId,
      scope: "self",
      source: "console",
    },
  });
  return { binding: publicBinding(binding) };
}

// ---------------------------------------------------------------------------
// Tokens, hints and helpers
// ---------------------------------------------------------------------------

export function generateLinkRequestToken() {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function linkRequestTokenHash(token: string) {
  return hashToken(`ravi-link-request:${token}`);
}

export function raviLinkApproveUrl(origin: string, token: string) {
  return `${origin.replace(/\/+$/, "")}/link/${token}`;
}

/** Console origin for links we hand out; mirrors the CLI config fallback. */
export function raviLinkConsoleOrigin(requestUrl: string) {
  const configured = process.env.NEXT_PUBLIC_CONSOLE_URL?.trim();
  if (configured) {
    try {
      return new URL(
        configured.startsWith("http://") || configured.startsWith("https://")
          ? configured
          : `https://${configured}`,
      ).origin;
    } catch {
      // fall through to the request origin
    }
  }
  return new URL(requestUrl).origin;
}

/**
 * Keyed hash of the chat account's email, so the approver can be checked
 * against it without storing the address.
 */
export function emailHintHash(email: string, secret = getCliAccessTokenSecret()) {
  if (!secret) return null;
  return `hmac-sha256:${createHmac("sha256", secret)
    .update(`ravi-link-email:${email.trim().toLowerCase()}`, "utf8")
    .digest("hex")}`;
}

function approverMismatchReason(request: RaviLinkRequestRecord, approver: RaviLinkApprover) {
  if (approver.impersonated) return "impersonation";
  if (!request.expectedEmailHash) return null;
  if (!approver.email || !approver.emailVerified) return "email_unverified";
  const actual = emailHintHash(approver.email);
  if (!actual || !constantTimeEqual(actual, request.expectedEmailHash)) return "email_mismatch";
  return null;
}

type FailedOutcome = {
  ok: false;
  code: CliErrorCode;
  reason: string;
  request: RaviLinkRequestRecord | null;
  status: number;
};
type ApproveOutcome =
  | FailedOutcome
  | { ok: true; binding: RaviActorBindingRecord; reused: boolean };
type DenyOutcome = FailedOutcome | { ok: true };

function fail(
  request: RaviLinkRequestRecord | null,
  status: number,
  code: CliErrorCode,
  reason: string,
): FailedOutcome {
  return { ok: false, code, reason, request, status };
}

async function checkPendingRequest(
  repository: RaviLinkRequestRepository,
  request: RaviLinkRequestRecord | null,
  now: Date,
): Promise<FailedOutcome | null> {
  if (!request) return fail(null, 404, "LINK_REQUEST_INVALID", "unknown_token");
  if (request.status === "expired") return fail(request, 410, "LINK_REQUEST_EXPIRED", "expired");
  if (request.status !== "pending") return fail(request, 409, "LINK_REQUEST_USED", "already_used");
  if (request.expiresAt <= now) {
    await repository.updateRequest(request.id, "pending", {
      status: "expired",
      failureReason: "expired",
      updatedAt: now,
    });
    return fail(request, 410, "LINK_REQUEST_EXPIRED", "expired");
  }
  return null;
}

async function auditRejection(
  repository: RaviLinkRequestRepository,
  input: { approver: RaviLinkApprover; requestId: string },
  request: RaviLinkRequestRecord | null,
  reason: string,
) {
  await repository.insertAudit({
    action: "ravi_link.request.rejected",
    actorId: input.approver.userId,
    actorType: input.approver.actorType,
    organizationId: request?.organizationId ?? null,
    requestId: input.requestId,
    targetId: request?.id ?? null,
    targetType: "ravi_link_request",
    metadata: {
      reason,
      ...(request ? { installationId: request.installationId } : {}),
    },
  });
}

async function findOwnRequest(
  repository: RaviLinkRequestRepository,
  installation: RaviLinkInstallationRecord,
  linkRequestId: string,
) {
  const id = optionalUuidOrNull(linkRequestId);
  const request = id ? await repository.findRequestById(id) : null;
  if (!request || request.installationId !== installation.id) {
    throw cliApiError(404, "NOT_FOUND");
  }
  return request;
}

function publicRequest(request: RaviLinkRequestRecord): RaviLinkRequestPublic {
  return {
    id: request.id,
    status: request.status,
    expiresAt: request.expiresAt.toISOString(),
    ...(request.approvedAt ? { approvedAt: request.approvedAt.toISOString() } : {}),
    ...(request.failureReason ? { failureReason: request.failureReason } : {}),
  };
}

export function normalizeLinkRequestToken(value: string | null | undefined) {
  return normalizeToken(value);
}

function normalizeToken(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return TOKEN_RE.test(token) ? token : null;
}

function optionalUuidOrNull(value: string) {
  try {
    return optionalUuid(value, "requestId") ?? null;
  } catch {
    return null;
  }
}

function cleanDisplayName(value: string | undefined) {
  if (value === undefined) return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > DISPLAY_NAME_MAX_LENGTH
    ? `${cleaned.slice(0, DISPLAY_NAME_MAX_LENGTH - 1)}…`
    : cleaned;
}

function normalizeEmail(value: string | undefined) {
  if (value === undefined) return null;
  const email = value.trim().toLowerCase();
  if (!email) return null;
  if (email.length > EMAIL_MAX_LENGTH || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw cliApiError(400, "PAYLOAD_INVALID", "expectedEmail is invalid.");
  }
  return email;
}

const CHANNEL_LABELS: Record<string, string> = {
  discord: "Discord",
  slack: "Slack",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  "whatsapp-baileys": "WhatsApp",
};

export function channelLabel(platformIdentities: JsonRecord): string | null {
  const channel = platformIdentities.channel;
  if (typeof channel !== "string") return null;
  return CHANNEL_LABELS[channel.trim().toLowerCase()] ?? null;
}

function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Database repository
// ---------------------------------------------------------------------------

export function raviLinkRequestRepositoryForDb(
  executor: RaviLinkDbExecutor = db,
): RaviLinkRequestRepository {
  const base = raviLinkRepositoryForDb(executor);
  return {
    ...base,

    async lockIssuance(organizationId) { await lockMemberIssuance(executor, organizationId); },
    async assertCurrentCaller(organizationId, caller) {
      const [session] = await executor.select().from(schema.cliSessions)
        .where(and(eq(schema.cliSessions.id, caller.cliSessionId), eq(schema.cliSessions.status, "active"),
          eq(schema.cliSessions.organizationId, organizationId))).limit(1);
      if (caller.userId && !await hasActiveMember(executor, organizationId, caller.userId)) throw cliApiError(403, "NOT_MEMBER");
      if (!session || session.expiresAt <= new Date() || session.localInstallationId !== caller.sessionInstallationId ||
        session.userId !== caller.userId) throw cliApiError(401, "AUTH_EXPIRED");
    },
    async assertCurrentApprover(organizationId, approver) {
      if (!await hasActiveMember(executor, organizationId, approver.userId) ||
        (approver.requireBrowserSession && !await hasActiveBrowserSession(executor, organizationId, approver.userId, approver.browserSessionId)))
        throw cliApiError(403, "NOT_MEMBER");
    },

    async transaction(fn) {
      return executor.transaction(async (tx) => fn(raviLinkRequestRepositoryForDb(tx)));
    },

    async findRequestByTokenHash(tokenHash, options = {}) {
      const query = executor
        .select()
        .from(schema.raviLinkRequests)
        .where(eq(schema.raviLinkRequests.tokenHash, tokenHash))
        .limit(1);
      const [row] = options.forUpdate ? await query.for("update") : await query;
      return row ?? null;
    },

    async findRequestById(requestId) {
      const [row] = await executor
        .select()
        .from(schema.raviLinkRequests)
        .where(eq(schema.raviLinkRequests.id, requestId))
        .limit(1);
      return row ?? null;
    },

    async findPendingRequestForContact(installationId, contactId) {
      const [row] = await executor
        .select()
        .from(schema.raviLinkRequests)
        .where(
          and(
            eq(schema.raviLinkRequests.installationId, installationId),
            eq(schema.raviLinkRequests.contactId, contactId),
            eq(schema.raviLinkRequests.status, "pending"),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },

    async countRequestsSince(installationId, contactId, since) {
      const [row] = await executor
        .select({ value: count() })
        .from(schema.raviLinkRequests)
        .where(
          and(
            eq(schema.raviLinkRequests.installationId, installationId),
            eq(schema.raviLinkRequests.contactId, contactId),
            gte(schema.raviLinkRequests.createdAt, since),
          ),
        );
      return row?.value ?? 0;
    },

    async insertRequest(values) {
      const [row] = await executor.insert(schema.raviLinkRequests).values(values).returning();
      if (!row) throw new Error("Failed to create link request.");
      return row;
    },

    async updateRequest(requestId, whenStatus, values) {
      const [row] = await executor
        .update(schema.raviLinkRequests)
        .set(values)
        .where(
          and(
            eq(schema.raviLinkRequests.id, requestId),
            eq(schema.raviLinkRequests.status, whenStatus),
          ),
        )
        .returning();
      return row ?? null;
    },

    async findInstallationDetails(installationId) {
      const [row] = await executor
        .select({
          id: schema.localInstallations.id,
          name: schema.localInstallations.name,
          organizationId: schema.localInstallations.organizationId,
          organizationName: schema.organizations.name,
          status: schema.localInstallations.status,
        })
        .from(schema.localInstallations)
        .innerJoin(
          schema.organizations,
          eq(schema.localInstallations.organizationId, schema.organizations.id),
        )
        .where(eq(schema.localInstallations.id, installationId))
        .limit(1);
      return row ?? null;
    },

    async listActiveBindingsForConsoleUser(consoleUserId) {
      const rows = await executor
        .select({
          id: schema.raviActorBindings.id,
          platformIdentitiesJson: schema.raviActorBindings.platformIdentitiesJson,
          linkedAt: schema.raviActorBindings.linkedAt,
          installationName: schema.localInstallations.name,
          organizationName: schema.organizations.name,
        })
        .from(schema.raviActorBindings)
        .innerJoin(
          schema.localInstallations,
          eq(schema.raviActorBindings.installationId, schema.localInstallations.id),
        )
        .innerJoin(
          schema.organizations,
          eq(schema.raviActorBindings.organizationId, schema.organizations.id),
        )
        .where(
          and(
            eq(schema.raviActorBindings.consoleUserId, consoleUserId),
            eq(schema.raviActorBindings.status, "active"),
          ),
        )
        .orderBy(desc(schema.raviActorBindings.linkedAt));
      return rows.map((row) => ({
        id: row.id,
        channel: channelLabel(row.platformIdentitiesJson),
        installationName: row.installationName,
        linkedAt: row.linkedAt.toISOString(),
        organizationName: row.organizationName,
      }));
    },
  };
}
