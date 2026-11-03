/**
 * Owner approvals of connector actions.
 *
 * An exec whose effective tool policy is `needs_approval` does not run:
 * the Worker records what was asked (the capability, a hash of the
 * validated parameters, an encrypted preview for the owner, the safe exec
 * context) and answers `connector_approval_required` with the Console
 * approval page. The owner approves or denies there. The same exec sent
 * again with `X-Ravi-Approval: <id>` runs only when that approval covers
 * exactly this action (connection, capability, parameters, owner,
 * requester), is approved and unexpired; it is consumed atomically right
 * before the provider call, so it can never run twice.
 *
 * The preview is the only copy of what the owner reads before approving.
 * It is encrypted like a pending grant secret (bundle bound by AAD to
 * `approval:<id>`), decrypted only for the owner, and never logged; an
 * approval whose preview cannot be read can only be denied.
 *
 * Who decides: the account's owner for a personal connection (also when
 * an agent uses it for the person asking), the member who manages an
 * organization account, or, when nobody manages it, every organization
 * owner and admin (the request names the first owner).
 *
 * The approval's lifecycle is audited on its connection (with the
 * approval id), so the owner's Recent activity shows it. The actor of a
 * request and of its use is always the CLI session user who asked (an
 * agent's operator); the person decided for is in the metadata.
 */

import { capabilityLabel, type CapabilityDefinition } from "./capabilities/registry";
import { ConnectorCryptoError } from "./crypto";
import {
  consumeActionApproval,
  decideActionApproval,
  findActionApproval,
  findReusablePendingApproval,
  insertActionApproval,
  insertAuditEvent,
  isActiveOrganizationAdmin,
  listPendingApprovalsForOwner,
  type ActionApprovalRecord,
  type ConnectorsDb,
  type ProviderConnectionRecord,
} from "./db";
import { ConnectorHttpError } from "./errors";
import { safeExecContext, type ParsedExecContext } from "./exec-context";
import { sha256Hex } from "./tokens";
import { decryptBundle, encryptBundle, pendingSecretAad } from "./vault";

export const APPROVAL_PENDING_TTL_SECONDS = 15 * 60;
export const APPROVAL_APPROVED_TTL_SECONDS = 10 * 60;
const PREVIEW_MAX_BYTES = 4096;
const GMAIL_PREVIEW_BODY_CHARS = 4000;
const APPROVALS_LIST_LIMIT = 100;
// Key versions older than the current one a stored preview may be sealed under.
const PREVIEW_KEY_VERSION_LOOKBACK = 8;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ApprovalReason = "policy" | "write_after_read";

export interface ApprovalSummary {
  id: string;
  connectionId: string;
  email: string | null;
  capability: string;
  label: string;
  reason: ApprovalReason;
  requestedAt: string;
  expiresAt: string;
  installationName: string | null;
  agentId: string | null;
  conversation: string | null;
}

export interface ApprovalDetail extends ApprovalSummary {
  status: string;
  preview: Record<string, unknown> | null;
  sessionName: string | null;
  speakerKind: string | null;
  routine: { kind: string; id?: string } | null;
}

/** What the exec answers while an action waits for the owner. */
export interface ApprovalRequiredDetails {
  approvalId: string;
  approvalUrl: string;
  expiresAt: string;
  reason: ApprovalReason;
}

export interface ApprovalDeps {
  db: ConnectorsDb;
  rootWrapKey: CryptoKey;
  dekKeyVersion: number;
  consoleBaseUrl: string;
}

// --------------------------------------------------------------------------
// Parameters: canonical form, hash, preview
// --------------------------------------------------------------------------

/** JSON with object keys sorted at every level; `undefined` members are dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonicalize(item)));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) out[key] = canonicalize(record[key]);
    }
    return out;
  }
  return value;
}

/** sha256 hex of the canonical JSON of the validated parameters. */
export async function approvalParamsHash(parameters: unknown): Promise<string> {
  return sha256Hex(canonicalJson(parameters));
}

/**
 * What the owner sees before deciding. Sending email: the recipients,
 * the subject, the start of the text body and of the HTML part (its
 * markup as text: the part most mail apps show, and what hidden content
 * would hide in), and the thread and messages a reply attaches to; each
 * cut part is flagged. Anything else: the validated parameters, cut to
 * 4 KB.
 */
export function approvalPreview(capability: string, parameters: unknown): Record<string, unknown> {
  if (capability === "gmail.message.send") {
    const params = (parameters ?? {}) as {
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      body?: string;
      bodyHtml?: string;
      threadId?: string;
      inReplyTo?: string;
      references?: string[];
    };
    const body = params.body ?? "";
    const cut = cutChars(body, GMAIL_PREVIEW_BODY_CHARS);
    const html = params.bodyHtml ? cutChars(params.bodyHtml, GMAIL_PREVIEW_BODY_CHARS) : null;
    return {
      to: params.to ?? [],
      cc: params.cc ?? [],
      bcc: params.bcc ?? [],
      subject: params.subject ?? "",
      body: cut,
      ...(cut.length < body.length ? { bodyTruncated: true } : {}),
      ...(html !== null
        ? {
            hasHtmlBody: true,
            bodyHtml: html,
            ...(html.length < params.bodyHtml!.length ? { bodyHtmlTruncated: true } : {}),
          }
        : {}),
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.inReplyTo ? { inReplyTo: params.inReplyTo } : {}),
      ...(params.references?.length ? { references: params.references } : {}),
    };
  }
  const json = canonicalJson(parameters ?? {});
  if (new TextEncoder().encode(json).byteLength <= PREVIEW_MAX_BYTES) {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  }
  return { truncated: true, parameters: cutUtf8(json, PREVIEW_MAX_BYTES) };
}

function cutChars(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

function cutUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  // A cut inside a multi-byte sequence decodes to U+FFFD; drop it.
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/�+$/, "");
}

export function approvalUrl(consoleBaseUrl: string, approvalId: string): string {
  return `${consoleBaseUrl.replace(/\/+$/, "")}/connectors/approvals/${approvalId}`;
}

function previewAad(dekKeyVersion: number, input: { organizationId: string; ownerUserId: string; approvalId: string }) {
  return pendingSecretAad({
    organizationId: input.organizationId,
    userId: input.ownerUserId,
    binding: `approval:${input.approvalId}`,
    dekKeyVersion,
  });
}

/**
 * The stored preview, or `null` when there is none or it cannot be read.
 * The bundle does not name the key version it was sealed under, but its
 * AAD hash binds it: a version bumped while the approval is open is found
 * by trying the current one, then the older ones.
 */
export async function readApprovalPreview(
  deps: Pick<ApprovalDeps, "rootWrapKey" | "dekKeyVersion">,
  approval: Pick<ActionApprovalRecord, "id" | "organizationId" | "ownerUserId" | "previewEncrypted">,
): Promise<Record<string, unknown> | null> {
  if (!approval.previewEncrypted) return null;
  const oldest = Math.max(1, deps.dekKeyVersion - PREVIEW_KEY_VERSION_LOOKBACK);
  for (let version = deps.dekKeyVersion; version >= oldest; version -= 1) {
    let text: string;
    try {
      text = await decryptBundle({
        bundle: approval.previewEncrypted,
        aad: previewAad(version, {
          organizationId: approval.organizationId,
          ownerUserId: approval.ownerUserId,
          approvalId: approval.id,
        }),
        rootWrapKey: deps.rootWrapKey,
      });
    } catch (error) {
      if (error instanceof ConnectorCryptoError && error.code === "aad_mismatch") continue;
      return null;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Exec side
// --------------------------------------------------------------------------

export interface ApprovalRequestInput {
  connection: ProviderConnectionRecord;
  /** Who decides: the account owner, or the manager of an organization account. */
  ownerUserId: string;
  capability: CapabilityDefinition;
  parameters: unknown;
  paramsHash: string;
  reason: ApprovalReason;
  /** The CLI session user: the audit's actor, whoever decides. */
  requestedByUserId: string;
  /** `agent` when an agent asks through agent exec; `cli` (the default) for an owner's own exec. */
  auditActorType?: "cli" | "agent";
  /** How an agent uses the connection (mode, grant, the person it acts for); merged into the audit. */
  auditMetadata?: Record<string, unknown>;
  localInstallationId: string | null;
  cliSessionId: string | null;
  execContext: ParsedExecContext;
  requestId: string;
}

/**
 * Ask the owner: a new pending approval (or the same still-pending one a
 * retry already created). Returns what the exec answers with.
 */
export async function requestApproval(
  deps: ApprovalDeps,
  input: ApprovalRequestInput,
): Promise<ApprovalRequiredDetails> {
  const { connection, ownerUserId } = input;
  const reusable = await findReusablePendingApproval(deps.db, {
    providerConnectionId: connection.id,
    capability: input.capability.id,
    paramsHash: input.paramsHash,
    ownerUserId,
    requestedByUserId: input.requestedByUserId,
    localInstallationId: input.localInstallationId,
    reason: input.reason,
  });
  if (reusable) {
    return {
      approvalId: reusable.id,
      approvalUrl: approvalUrl(deps.consoleBaseUrl, reusable.id),
      expiresAt: reusable.expiresAt.toISOString(),
      reason: input.reason,
    };
  }

  const approvalId = crypto.randomUUID();
  const previewEncrypted = await encryptBundle({
    plaintext: JSON.stringify(approvalPreview(input.capability.id, input.parameters)),
    aad: previewAad(deps.dekKeyVersion, {
      organizationId: connection.organizationId,
      ownerUserId,
      approvalId,
    }),
    rootWrapKey: deps.rootWrapKey,
  });
  const inserted = await insertActionApproval(deps.db, {
    id: approvalId,
    organizationId: connection.organizationId,
    providerConnectionId: connection.id,
    ownerUserId,
    requestedByUserId: input.requestedByUserId,
    localInstallationId: input.localInstallationId,
    cliSessionId: input.cliSessionId,
    capability: input.capability.id,
    capabilityClass: input.capability.class,
    paramsHash: input.paramsHash,
    previewEncrypted,
    reason: input.reason,
    execContext: safeExecContext(input.execContext),
    ttlSeconds: APPROVAL_PENDING_TTL_SECONDS,
  });
  await insertAuditEvent(deps.db, {
    organizationId: connection.organizationId,
    actorType: input.auditActorType ?? "cli",
    actorId: input.requestedByUserId,
    targetType: "provider_connection",
    targetId: connection.id,
    action: "connector.approval.created",
    requestId: input.requestId,
    metadata: {
      approvalId,
      capability: input.capability.id,
      reason: input.reason,
      agentId: input.execContext.context.agentId ?? null,
      conversation: input.execContext.context.conversation,
      installationId: input.localInstallationId,
      ownerUserId,
      ...(input.auditMetadata ?? {}),
    },
  });
  return {
    approvalId,
    approvalUrl: approvalUrl(deps.consoleBaseUrl, approvalId),
    expiresAt: inserted.expiresAt.toISOString(),
    reason: input.reason,
  };
}

export interface ApprovalRedeemInput {
  approvalId: string;
  connection: ProviderConnectionRecord;
  /** Who must have decided: the account owner, or the organization account's manager. */
  ownerUserId: string;
  capability: CapabilityDefinition;
  paramsHash: string;
  /** The CLI session user, who asked: the audit's actor. */
  requestedByUserId: string;
  cliSessionId: string | null;
  auditActorType?: "cli" | "agent";
  auditMetadata?: Record<string, unknown>;
  requestId: string;
}

export type ApprovalCheckOutcome =
  | { kind: "approved" }
  | { kind: "pending"; details: ApprovalRequiredDetails }
  | { kind: "denied" }
  | { kind: "invalid" };

/**
 * The exec carries `X-Ravi-Approval`: does it cover exactly this action,
 * and did the owner approve it in time? Read only: the approval is used up
 * by `consumeApproval`, right before the provider call, so a refusal on the
 * way there (step-up, missing credentials, a failed refresh) leaves it for
 * the retry.
 */
export async function checkApproval(
  deps: Pick<ApprovalDeps, "db" | "consoleBaseUrl">,
  input: ApprovalRedeemInput,
): Promise<ApprovalCheckOutcome> {
  if (!UUID_RE.test(input.approvalId)) return { kind: "invalid" };
  const approval = await findActionApproval(deps.db, input.approvalId);
  if (
    !approval ||
    approval.organizationId !== input.connection.organizationId ||
    approval.providerConnectionId !== input.connection.id ||
    approval.capability !== input.capability.id ||
    approval.paramsHash !== input.paramsHash ||
    approval.ownerUserId !== input.ownerUserId ||
    approval.requestedByUserId !== input.requestedByUserId
  ) {
    return { kind: "invalid" };
  }
  if (approval.status === "approved" && !approval.pastExpiry) return { kind: "approved" };
  if (approval.status === "pending" && !approval.pastExpiry) {
    return {
      kind: "pending",
      details: {
        approvalId: approval.id,
        approvalUrl: approvalUrl(deps.consoleBaseUrl, approval.id),
        expiresAt: approval.expiresAt.toISOString(),
        reason: approvalReason(approval.reason),
      },
    };
  }
  if (approval.status === "denied") return { kind: "denied" };
  return { kind: "invalid" };
}

/**
 * Use the approval, once: the atomic `approved` → `consumed` of exactly
 * this action. `false` when a concurrent use won it or it expired since
 * `checkApproval`.
 */
export async function consumeApproval(deps: Pick<ApprovalDeps, "db">, input: ApprovalRedeemInput): Promise<boolean> {
  const consumed = await consumeActionApproval(deps.db, {
    id: input.approvalId,
    providerConnectionId: input.connection.id,
    capability: input.capability.id,
    paramsHash: input.paramsHash,
    ownerUserId: input.ownerUserId,
    requestedByUserId: input.requestedByUserId,
  });
  if (!consumed) return false;
  await insertAuditEvent(deps.db, {
    organizationId: input.connection.organizationId,
    actorType: input.auditActorType ?? "cli",
    actorId: input.requestedByUserId,
    targetType: "provider_connection",
    targetId: input.connection.id,
    action: "connector.approval.consumed",
    requestId: input.requestId,
    metadata: {
      approvalId: input.approvalId,
      capability: input.capability.id,
      ownerUserId: input.ownerUserId,
      requestedByUserId: input.requestedByUserId,
      cliSessionId: input.cliSessionId,
      ...(input.auditMetadata ?? {}),
    },
  });
  return true;
}

/** `expired` once past `expires_at`, even before the scheduler marks it. */
export function effectiveApprovalStatus(approval: Pick<ActionApprovalRecord, "status" | "pastExpiry">): string {
  if ((approval.status === "pending" || approval.status === "approved") && approval.pastExpiry) return "expired";
  return approval.status;
}

// --------------------------------------------------------------------------
// Owner side (Console, HMAC)
// --------------------------------------------------------------------------

export async function listOwnerApprovals(
  deps: Pick<ApprovalDeps, "db">,
  actor: { organizationId: string; userId: string },
): Promise<ApprovalSummary[]> {
  const rows = await listPendingApprovalsForOwner(deps.db, {
    organizationId: actor.organizationId,
    ownerUserId: actor.userId,
    includeUnmanaged: await isActiveOrganizationAdmin(deps.db, actor),
    limit: APPROVALS_LIST_LIMIT,
  });
  return rows.map(toApprovalSummary);
}

export async function getOwnerApproval(
  deps: ApprovalDeps,
  actor: { organizationId: string; userId: string },
  approvalId: string,
): Promise<ApprovalDetail> {
  const approval = await requireOwnApproval(deps.db, actor, approvalId);
  const preview = await readApprovalPreview(deps, approval);
  const context = approval.execContextJson ?? {};
  const speaker = context.speaker as { kind?: unknown } | undefined;
  const routine = context.routine as { kind?: unknown; id?: unknown } | undefined;
  return {
    ...toApprovalSummary(approval),
    status: effectiveApprovalStatus(approval),
    preview,
    sessionName: stringOrNull(context.sessionName),
    speakerKind: stringOrNull(speaker?.kind),
    routine: typeof routine?.kind === "string"
      ? { kind: routine.kind, ...(typeof routine.id === "string" ? { id: routine.id } : {}) }
      : null,
  };
}

/**
 * Approve or deny a pending, unexpired approval of the owner. Deciding
 * the same way again answers the current status; anything else is
 * `connector_approval_invalid`. Nothing is approved unseen: an approval
 * whose preview is missing or cannot be read can only be denied.
 */
export async function decideOwnerApproval(
  deps: Pick<ApprovalDeps, "db" | "rootWrapKey" | "dekKeyVersion">,
  actor: { organizationId: string; userId: string },
  input: { approvalId: string; decision: unknown; requestId: string },
): Promise<{ status: string }> {
  if (input.decision !== "approve" && input.decision !== "deny") {
    throw new ConnectorHttpError(400, "payload_invalid", "decision must be approve or deny");
  }
  const decision = input.decision;
  const approval = await requireOwnApproval(deps.db, actor, input.approvalId);
  if (decision === "approve" && approval.status === "pending" && !(await readApprovalPreview(deps, approval))) {
    throw new ConnectorHttpError(400, "connector_approval_invalid", "This request can't be shown, so it can't be approved", {
      status: effectiveApprovalStatus(approval),
    });
  }
  const status = await decideActionApproval(deps.db, {
    id: approval.id,
    organizationId: actor.organizationId,
    ownerUserId: approval.ownerUserId,
    decidedByUserId: actor.userId,
    decision,
    approvedTtlSeconds: APPROVAL_APPROVED_TTL_SECONDS,
  });
  if (!status) {
    const current = (await findActionApproval(deps.db, approval.id)) ?? approval;
    const currentStatus = effectiveApprovalStatus(current);
    if (currentStatus === (decision === "approve" ? "approved" : "denied")) return { status: currentStatus };
    throw new ConnectorHttpError(400, "connector_approval_invalid", "Approval is no longer pending", {
      status: currentStatus,
    });
  }
  await insertAuditEvent(deps.db, {
    organizationId: approval.organizationId,
    actorType: "user",
    actorId: actor.userId,
    targetType: "provider_connection",
    targetId: approval.providerConnectionId,
    action: decision === "approve" ? "connector.approval.approved" : "connector.approval.denied",
    requestId: input.requestId,
    metadata: {
      approvalId: approval.id,
      capability: approval.capability,
      reason: approval.reason,
      agentId: stringOrNull(approval.execContextJson?.agentId),
      conversation: stringOrNull(approval.execContextJson?.conversation),
    },
  });
  return { status };
}

/**
 * An approval the actor decides: theirs, or one on an organization account
 * nobody manages when they are an organization owner or admin. Anything
 * else answers like an unknown id.
 */
async function requireOwnApproval(
  db: ConnectorsDb,
  actor: { organizationId: string; userId: string },
  approvalId: string,
): Promise<ActionApprovalRecord> {
  const approval = UUID_RE.test(approvalId) ? await findActionApproval(db, approvalId) : null;
  if (!approval || approval.organizationId !== actor.organizationId) {
    throw new ConnectorHttpError(404, "not_found", "Approval not found");
  }
  if (approval.ownerUserId === actor.userId) return approval;
  const unmanaged = approval.connectionScopeKind === "organization" && !approval.connectionManagedByUserId;
  if (unmanaged && (await isActiveOrganizationAdmin(db, actor))) return approval;
  throw new ConnectorHttpError(404, "not_found", "Approval not found");
}

function toApprovalSummary(approval: ActionApprovalRecord): ApprovalSummary {
  const context = approval.execContextJson ?? {};
  return {
    id: approval.id,
    connectionId: approval.providerConnectionId,
    email: approval.connectionEmail,
    capability: approval.capability,
    label: capabilityLabel(approval.capability),
    reason: approvalReason(approval.reason),
    requestedAt: approval.createdAt.toISOString(),
    expiresAt: approval.expiresAt.toISOString(),
    installationName: approval.installationName,
    agentId: stringOrNull(context.agentId),
    conversation: stringOrNull(context.conversation),
  };
}

function approvalReason(value: string): ApprovalReason {
  return value === "write_after_read" ? "write_after_read" : "policy";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
