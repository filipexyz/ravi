import { randomUUID } from "node:crypto";
import { actorCanGrantRequestedPermission } from "../../approval/grantor.js";
import { logger } from "../../utils/logger.js";
import { applyPermissionGrant } from "../apply-grant.js";
import { canWithCapabilities } from "../capability-snapshot.js";
import { resolveContactChatOverlay } from "../contact-policy-permissions-provider.js";
import { emitPermissionGrantAudit } from "../denials.js";
import { materializeSubjectCapabilities } from "../provider-runtime.js";
import {
  claimGrantRequest,
  createGrantRequest,
  expireGrantRequests,
  failGrantRequest,
  findOpenGrantRequest,
  getGrantRequest,
  listGrantRequestDeliveries,
  recordGrantRequestDelivery,
  recordGrantRequestOutcome,
} from "./store.js";
import type {
  GrantApprovalChannelAdapter,
  GrantDecision,
  GrantDecisionResult,
  GrantRequestDelivery,
  GrantRequestPlan,
  GrantRequestRecord,
  GrantRequestRequester,
  ReachableContact,
  VerifiedActor,
} from "./types.js";

const log = logger.child("permissions:grant-requests");

/** What full access is: everything the executor itself may do. */
export const FULL_ACCESS_CAPABILITY = { permission: "admin", objectType: "system", objectId: "*" } as const;

/** A request nobody answers in this long is gone; the asker has to ask again. */
export const GRANT_REQUEST_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Adapter registry. Channels register at boot; the core never imports one.
// ---------------------------------------------------------------------------

const adapters = new Map<string, GrantApprovalChannelAdapter>();

export function registerGrantApprovalAdapter(adapter: GrantApprovalChannelAdapter): void {
  adapters.set(adapter.channel, adapter);
}

export function unregisterGrantApprovalAdapter(channel: string): void {
  adapters.delete(channel);
}

export function listGrantApprovalAdapters(): GrantApprovalChannelAdapter[] {
  return [...adapters.values()];
}

export function resetGrantApprovalAdaptersForTest(): void {
  adapters.clear();
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type GrantRequestErrorCode = "already_held" | "no_adapter" | "no_eligible_grantor" | "undeliverable";

export class GrantRequestError extends Error {
  constructor(
    readonly code: GrantRequestErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GrantRequestError";
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface GrantRequestServiceDependencies {
  readonly now: () => number;
  readonly adapters: () => readonly GrantApprovalChannelAdapter[];
  readonly ttlMs: number;
  /** Best-effort notification of a decision, for whoever is watching. */
  readonly emit?: (topic: string, data: Record<string, unknown>) => Promise<unknown>;
}

const defaultDependencies: GrantRequestServiceDependencies = {
  now: Date.now,
  adapters: listGrantApprovalAdapters,
  ttlMs: GRANT_REQUEST_TTL_MS,
};

// ---------------------------------------------------------------------------
// Grantors
// ---------------------------------------------------------------------------

/** The gate a contact must pass to approve full access, independent of channel. */
export function contactHoldsAdmin(contactId: string): boolean {
  return canWithCapabilities(
    materializeSubjectCapabilities("contact", contactId),
    FULL_ACCESS_CAPABILITY.permission,
    FULL_ACCESS_CAPABILITY.objectType,
    FULL_ACCESS_CAPABILITY.objectId,
  );
}

/**
 * Whether the contact's own turns in that chat already hold full access, so the
 * grant would change nothing there and nobody should be asked. It reads what a
 * turn of theirs gets: in a chat governed by contact grants, their overlay (chat
 * grants and global permission tags such as an admin tag); in a chat with no
 * grants, their own capabilities, which decide whether break-glass is withheld.
 */
export function contactHoldsFullAccessInChat(contactId: string, chatId: string): boolean {
  const overlay = resolveContactChatOverlay({ contactId, chatId });
  if (!overlay.active) return contactHoldsAdmin(contactId);
  return (
    overlay.eligible &&
    canWithCapabilities(
      overlay.capabilities,
      FULL_ACCESS_CAPABILITY.permission,
      FULL_ACCESS_CAPABILITY.objectType,
      FULL_ACCESS_CAPABILITY.objectId,
    )
  );
}

interface GrantorTarget {
  readonly adapter: GrantApprovalChannelAdapter;
  readonly contact: ReachableContact;
}

/**
 * Contacts that hold admin and that at least one adapter can reach. The grantee
 * is never a candidate: nobody grants themselves access.
 */
function resolveGrantorTargets(plan: GrantRequestPlan, candidates: readonly GrantApprovalChannelAdapter[]) {
  const targets: GrantorTarget[] = [];
  const adminByContact = new Map<string, boolean>();
  for (const adapter of candidates) {
    for (const contact of adapter.listReachableContacts()) {
      if (contact.contactId === plan.contactId) continue;
      let holdsAdmin = adminByContact.get(contact.contactId);
      if (holdsAdmin === undefined) {
        holdsAdmin = contactHoldsAdmin(contact.contactId);
        adminByContact.set(contact.contactId, holdsAdmin);
      }
      if (holdsAdmin) targets.push({ adapter, contact });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Who would be asked, without asking anyone. Throws the same errors a real
 * request would, so a plan never promises a request that cannot be sent.
 */
export function previewGrantRequest(
  plan: GrantRequestPlan,
  dependencies: GrantRequestServiceDependencies = defaultDependencies,
): { readonly grantors: ReadonlyArray<{ readonly contactId: string; readonly channel: string }> } {
  if (contactHoldsFullAccessInChat(plan.contactId, plan.chatId)) throw alreadyHeldError(plan);
  const channelAdapters = dependencies.adapters();
  if (channelAdapters.length === 0) throw noAdapterError();
  const targets = resolveGrantorTargets(plan, channelAdapters);
  if (targets.length === 0) throw noEligibleGrantorError();
  return {
    grantors: targets.map((target) => ({ contactId: target.contact.contactId, channel: target.adapter.channel })),
  };
}

function alreadyHeldError(plan: GrantRequestPlan): GrantRequestError {
  return new GrantRequestError(
    "already_held",
    `Contact ${plan.contactId} already holds full access in chat ${plan.chatId}: their own turns there run with the agent's whole authority, so there is nothing to approve and nobody was asked.`,
  );
}

function noAdapterError(): GrantRequestError {
  return new GrantRequestError(
    "no_adapter",
    "No channel can reach an approver from this runtime: no approval adapter is registered.",
  );
}

function noEligibleGrantorError(): GrantRequestError {
  return new GrantRequestError(
    "no_eligible_grantor",
    "No contact that holds admin on this installation can be reached on any channel, so nobody could be asked.",
  );
}

export interface RequestGrantResult {
  readonly request: GrantRequestRecord;
  readonly deliveries: readonly GrantRequestDelivery[];
  /** True when an identical request was still open and nothing new was sent. */
  readonly reused: boolean;
}

/**
 * Record the ask and offer it to every eligible grantor on every channel that
 * can reach them. Returns as soon as the offers are out; the decision arrives
 * later through {@link decideGrantRequest}. Fails closed, with nothing left
 * pending, when nobody can be asked.
 */
export async function requestGrant(
  input: { readonly plan: GrantRequestPlan; readonly requester: GrantRequestRequester },
  dependencies: GrantRequestServiceDependencies = defaultDependencies,
): Promise<RequestGrantResult> {
  const now = dependencies.now();
  expireGrantRequests(now);
  // Checked before reuse: an open request for access the contact now holds is not worth answering.
  if (contactHoldsFullAccessInChat(input.plan.contactId, input.plan.chatId)) throw alreadyHeldError(input.plan);

  const open = findOpenGrantRequest(input.plan, now);
  if (open) return { request: open, deliveries: listGrantRequestDeliveries(open.id), reused: true };

  const channelAdapters = dependencies.adapters();
  if (channelAdapters.length === 0) throw noAdapterError();
  const targets = resolveGrantorTargets(input.plan, channelAdapters);
  if (targets.length === 0) throw noEligibleGrantorError();

  const grantorContactIds = [...new Set(targets.map((target) => target.contact.contactId))];
  const request = createGrantRequest({
    id: `pgr_${randomUUID()}`,
    plan: input.plan,
    requester: input.requester,
    grantorContactIds,
    createdAt: now,
    expiresAt: now + dependencies.ttlMs,
  });

  const failures: string[] = [];
  for (const target of targets) {
    try {
      const delivered = await target.adapter.deliver({
        request,
        contactId: target.contact.contactId,
        address: target.contact.address,
      });
      recordGrantRequestDelivery({
        requestId: request.id,
        contactId: target.contact.contactId,
        channel: target.adapter.channel,
        ref: delivered.ref,
        createdAt: dependencies.now(),
      });
    } catch (error) {
      log.warn("Grant request could not be delivered", {
        requestId: request.id,
        channel: target.adapter.channel,
        error: error instanceof Error ? error.message : String(error),
      });
      failures.push(`${target.adapter.channel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const deliveries = listGrantRequestDeliveries(request.id);
  if (deliveries.length === 0) {
    failGrantRequest(request.id, "no approver could be reached", dependencies.now());
    throw new GrantRequestError(
      "undeliverable",
      `Eligible approvers exist but none could be reached (${failures.join("; ") || "no detail"}).`,
    );
  }
  return { request, deliveries, reused: false };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * The one decision path, for every channel. The adapter proves who answered
 * (a verified platform sender); this decides whether that person may. A request
 * that is applied, rejected, expired or failed can never be decided again, and
 * the grantee can never decide their own access.
 */
export function decideGrantRequest(
  input: {
    readonly requestId: string;
    readonly decision: GrantDecision;
    readonly actor: VerifiedActor;
    /**
     * The contact the answered prompt was delivered to, as the adapter recorded it. An answer
     * counts only when the verified approver is that very contact: a prompt sent to one person
     * is not answered by another, even another admin. Required: an adapter with no recorded
     * delivery for the answer passes an empty string, which matches nobody.
     */
    readonly deliveredTo: string;
  },
  dependencies: GrantRequestServiceDependencies = defaultDependencies,
): GrantDecisionResult {
  const now = dependencies.now();
  const record = getGrantRequest(input.requestId);
  if (!record) return { kind: "refused", reason: "not_found" };
  const gate = actorCanGrantRequestedPermission({
    channel: input.actor.channel,
    ...(input.actor.accountId ? { accountId: input.actor.accountId } : {}),
    ...(input.actor.instanceId ? { instanceId: input.actor.instanceId } : {}),
    senderId: input.actor.senderId,
    ...(input.actor.senderAliases?.length ? { senderAliases: input.actor.senderAliases } : {}),
    permission: FULL_ACCESS_CAPABILITY.permission,
    objectType: FULL_ACCESS_CAPABILITY.objectType,
    objectId: FULL_ACCESS_CAPABILITY.objectId,
  });
  if (gate.reason === "missing_actor" || gate.reason === "unresolved_identity") {
    return { kind: "refused", reason: "unknown_actor", request: record };
  }
  if (!gate.allowed || gate.subjectType !== "contact" || !gate.subjectId) {
    return { kind: "refused", reason: "not_grantor", request: record };
  }
  const approverContactId = gate.subjectId;
  if (approverContactId === record.plan.contactId) {
    return { kind: "refused", reason: "grantee_cannot_decide", request: record };
  }
  // Only people the request was offered to may answer it, and only through the prompt that was sent to them.
  if (!record.grantorContactIds.includes(approverContactId)) {
    return { kind: "refused", reason: "not_grantor", request: record };
  }
  if (input.deliveredTo !== approverContactId) {
    return { kind: "refused", reason: "not_grantor", request: record };
  }

  // Terminal states are only told to a verified, offered approver: a stranger who quotes an old
  // prompt learns nothing and triggers nothing.
  if (record.status === "expired" || (record.status === "pending" && record.expiresAt <= now)) {
    expireGrantRequests(now);
    return { kind: "refused", reason: "expired", request: getGrantRequest(record.id) ?? record };
  }
  if (record.status !== "pending") return { kind: "refused", reason: "already_decided", request: record };

  const claimed = claimGrantRequest({
    id: record.id,
    status: input.decision === "approve" ? "approved" : "rejected",
    decidedByContactId: approverContactId,
    decidedVia: input.actor.channel,
    ...(input.decision === "reject" ? { reason: "rejected" } : {}),
    now,
  });
  if (!claimed) {
    // Lost the single-use claim, or ran out of time between the read and the write.
    const current = getGrantRequest(record.id) ?? record;
    return {
      kind: "refused",
      reason: current.status === "expired" ? "expired" : "already_decided",
      request: current,
    };
  }

  const request = claimed.status === "approved" ? applyApproved(claimed, input.actor, approverContactId, now) : claimed;
  void dependencies
    .emit?.("ravi.permissions.grant_request.decided", {
      requestId: request.id,
      status: request.status,
      outcome: request.outcome,
      decidedByContactId: request.decidedByContactId,
      decidedVia: request.decidedVia,
    })
    ?.catch((error: unknown) => {
      log.warn("Grant request decision could not be announced", {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return { kind: "decided", request };
}

function applyApproved(
  request: GrantRequestRecord,
  actor: VerifiedActor,
  approverContactId: string,
  now: number,
): GrantRequestRecord {
  let applied: ReturnType<typeof applyPermissionGrant> | null = null;
  let errorText: string | undefined;
  try {
    applied = applyPermissionGrant({
      intent: "full-access",
      scope: { type: "chat", chatId: request.plan.chatId },
      capability: FULL_ACCESS_CAPABILITY,
      contactId: request.plan.contactId,
      // No agentId: approving never writes an agent's own permissions.
      actor: { channel: actor.channel, userId: actor.senderId, contactId: approverContactId },
      requestId: request.id,
      idempotencyKey: `grant-request:${request.id}`,
      createdBy: "permissions.request",
      now,
    });
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error);
    log.warn("Approved grant request could not be applied", { requestId: request.id, error: errorText });
  }

  emitPermissionGrantAudit({
    agentId: request.requester.agentId ?? "unknown",
    requestId: request.id,
    capability: "admin:system:*",
    intent: "full-access",
    scope: "chat",
    clicker: { channel: actor.channel, userId: actor.senderId, actorId: approverContactId },
    profile: applied?.profile ?? null,
    capabilities: [],
    agentCeiling: { agentId: null, changed: false },
    changed: applied?.changed ?? false,
    replay: applied?.replay ?? false,
    applied: Boolean(applied),
    resolvedDenials: 0,
    operations: applied?.operations ?? [],
    ...(errorText ? { error: errorText } : {}),
    timestamp: new Date(now).toISOString(),
  });

  return (
    recordGrantRequestOutcome(request.id, applied ? "applied" : "failed", applied ? undefined : "failed") ?? request
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function getGrantRequestStatus(
  requestId: string,
  dependencies: GrantRequestServiceDependencies = defaultDependencies,
): { readonly request: GrantRequestRecord; readonly deliveries: readonly GrantRequestDelivery[] } | null {
  expireGrantRequests(dependencies.now());
  const request = getGrantRequest(requestId);
  return request ? { request, deliveries: listGrantRequestDeliveries(requestId) } : null;
}

/** Sweep used by the daemon runner so an unanswered request does not stay `pending` forever. */
export function sweepExpiredGrantRequests(
  dependencies: GrantRequestServiceDependencies = defaultDependencies,
): GrantRequestRecord[] {
  return expireGrantRequests(dependencies.now());
}
