/**
 * Grant requests: a channel-free ask for a durable permission grant that a
 * human with authority must approve.
 *
 * This module and its siblings belong to the core. They know contacts, chats,
 * agents and capabilities; they never know Slack, WhatsApp or any other
 * channel. A channel enters only through a `GrantApprovalChannelAdapter`
 * (delivery) and through a *verified actor* that an adapter hands back from a
 * platform event (identity comes from the platform sender, never from text).
 */

export type GrantRequestStatus = "pending" | "approved" | "rejected" | "expired" | "failed";
export type GrantRequestOutcome = "applied" | "failed";

/** Only full access is supported today; the shape leaves room for other profiles. */
export type GrantRequestProfile = "full-access";

export interface GrantRequestRequester {
  readonly agentId?: string;
  readonly sessionName?: string;
  /** The human whose message drove the turn, when the turn had a verified one. */
  readonly contactId?: string;
  /** Provenance only: the channel the turn came from. Never used to decide anything. */
  readonly channel?: string;
}

/** The exact plan an approver is asked to approve. */
export interface GrantRequestPlan {
  readonly profile: GrantRequestProfile;
  readonly contactId: string;
  /** Canonical chat id the grant is scoped to. */
  readonly chatId: string;
  /** Display only: the executor that serves that chat (its own permissions are never changed). */
  readonly executorAgentId: string;
  readonly contactLabel: string;
  readonly chatLabel: string;
}

export interface GrantRequestRecord {
  readonly id: string;
  readonly plan: GrantRequestPlan;
  readonly requester: GrantRequestRequester;
  /** Contacts the request was offered to (they held admin when it was created). */
  readonly grantorContactIds: readonly string[];
  readonly status: GrantRequestStatus;
  readonly decidedByContactId: string | null;
  /** Provenance of the decision: which channel the approver answered on. */
  readonly decidedVia: string | null;
  readonly outcome: GrantRequestOutcome | null;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | null;
}

/** One place where one grantor was asked. `ref` is opaque to the core. */
export interface GrantRequestDelivery {
  readonly requestId: string;
  readonly contactId: string;
  readonly channel: string;
  readonly ref: Record<string, unknown>;
  readonly createdAt: number;
}

/** A contact an adapter could reach, with an opaque address only that adapter understands. */
export interface ReachableContact {
  readonly contactId: string;
  readonly address: Record<string, unknown>;
}

export interface GrantApprovalChannelAdapter {
  readonly channel: string;
  /** Cheap, side-effect free. The core filters the result by capability. */
  listReachableContacts(): readonly ReachableContact[];
  /** Ask one grantor. Throws when the message could not be delivered. */
  deliver(input: {
    readonly request: GrantRequestRecord;
    readonly contactId: string;
    readonly address: Record<string, unknown>;
  }): Promise<{ readonly ref: Record<string, unknown> }>;
}

/**
 * Who answered, as verified by the platform event the adapter received.
 * `senderId` is the platform's own sender id; text typed by the sender is not
 * part of this and is never consulted.
 */
export interface VerifiedActor {
  readonly channel: string;
  readonly senderId: string;
  readonly accountId?: string;
  readonly instanceId?: string;
}

export type GrantDecision = "approve" | "reject";

export type GrantDecisionRefusal =
  | "not_found"
  | "expired"
  | "already_decided"
  | "unknown_actor"
  | "not_grantor"
  | "grantee_cannot_decide";

export type GrantDecisionResult =
  | { readonly kind: "decided"; readonly request: GrantRequestRecord }
  | { readonly kind: "refused"; readonly reason: GrantDecisionRefusal; readonly request?: GrantRequestRecord };
