import { randomUUID } from "node:crypto";
import { nats as runtimeNats } from "../nats.js";
import { isChatOnlyAgent, isToolOrExecCapability } from "../permissions/agent-default-capabilities-provider.js";
import { canWithCapabilityContext } from "../permissions/provider-runtime.js";
import {
  recordAndEmitPermissionDenial,
  listPermissionDenials,
  resolvePermissionDenials,
  emitPermissionGrantAudit,
  type PermissionDenial,
} from "../permissions/denials.js";
import {
  applyPermissionGrant,
  resolveGrantScopeRef,
  type PermissionGrantScopeValue,
} from "../permissions/apply-grant.js";
import { buildAuditContextProvenance } from "../permissions/audit-provenance.js";
import { buildAuthorizationGuidance, formatCanonicalCapability } from "../permissions/authorization-guidance.js";
import { dbUpdateContextCapabilities, type ContextCapability, type ContextRecord } from "../router/router-db.js";
import { updateSlackText } from "../channels/slack/text-send.js";
import { respondToSlackInteraction } from "../channels/slack/interactions.js";
import { requestReply as runtimeRequestReply } from "../utils/request-reply.js";
import { logger } from "../utils/logger.js";
import { evaluateApprovalInboundEvent, type ApprovalInboundEvaluation } from "./decision.js";
import { findSlackUserIdForContact, listSlackApprovalGrantorUserIds } from "./grantor.js";
import {
  buildPermissionGrantMetadata,
  describeGrantScope,
  readPermissionGrantMetadata,
  sameGrantTuple,
  type PermissionGrantMetadata,
} from "./grant-metadata.js";
import {
  buildSlackApprovalFinalMessage,
  buildSlackApprovalRequestMessage,
  buildSlackPermissionGrantMessage,
} from "./slack-blocks.js";
import {
  attachApprovalRequestMessageId,
  claimApprovalDecision,
  createApprovalRequest,
  expireApprovalRequest,
  getApprovalRequest,
  listApprovalDeliveries,
  listPendingApprovalRequestsForChat,
  recordApprovalDeliveries,
  setApprovalCardScope,
  type ApprovalDeliveryKind,
  type ApprovalRequestRecord,
  type ApprovalRequestType,
} from "./store.js";
import { DEFAULT_APPROVAL_DELIVERY_TIMEOUT_MS, DEFAULT_APPROVAL_TIMEOUT_MS } from "./timeouts.js";

const log = logger.child("approval:service");
export { DEFAULT_APPROVAL_TIMEOUT_MS };

export interface ApprovalFinalizeSlackInput {
  readonly accountId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly text: string;
  readonly blocks: readonly Record<string, unknown>[];
}

export interface ApprovalRespondSlackInput {
  readonly responseUrlId: string;
  readonly payload: Record<string, unknown>;
}

export interface ApprovalServiceDependencies {
  nats: Pick<typeof runtimeNats, "emit" | "subscribe">;
  requestReply: typeof runtimeRequestReply;
  now: () => number;
  finalizeSlackApproval: (input: ApprovalFinalizeSlackInput) => Promise<void>;
  /** Answers one Slack click privately through its `response_url`. */
  respondSlackInteraction: (input: ApprovalRespondSlackInput) => Promise<void>;
}

const defaultApprovalServiceDependencies: ApprovalServiceDependencies = {
  nats: runtimeNats,
  requestReply: runtimeRequestReply,
  now: Date.now,
  finalizeSlackApproval: async (input) => {
    await updateSlackText({
      accountId: input.accountId,
      chatId: input.chatId,
      messageId: input.messageId,
      text: input.text,
      blocks: input.blocks,
    });
  },
  respondSlackInteraction: async (input) => {
    await respondToSlackInteraction(input);
  },
};

let approvalServiceDependencies = defaultApprovalServiceDependencies;
const publishedApprovalResponses = new Set<string>();

export function setApprovalServiceDependenciesForTest(overrides?: Partial<ApprovalServiceDependencies>): void {
  approvalServiceDependencies = {
    ...defaultApprovalServiceDependencies,
    ...(overrides ?? {}),
  };
  publishedApprovalResponses.clear();
}

function approvalResponseDedupeKey(data: Record<string, unknown>): string {
  const messageId = typeof data.messageId === "string" ? data.messageId.trim() : "";
  if (messageId) return `message:${messageId}`;
  const sessionName = typeof data.sessionName === "string" ? data.sessionName : "";
  const type = typeof data.type === "string" ? data.type : "";
  return `session:${sessionName}:${type}`;
}

/** One `ravi.approval.response` per request. Reaction traffic must not republish. */
export async function emitApprovalResponseOnce(data: Record<string, unknown>): Promise<boolean> {
  const key = approvalResponseDedupeKey(data);
  if (publishedApprovalResponses.has(key)) {
    log.info("Skipping duplicate approval.response", { key });
    return false;
  }
  publishedApprovalResponses.add(key);
  const emitId = typeof data._emitId === "string" && data._emitId.trim() ? data._emitId : `approval-${key}`;
  await approvalServiceDependencies.nats.emit("ravi.approval.response", {
    ...data,
    _emitId: emitId,
    timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
  });
  return true;
}

export interface ApprovalTarget {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string;
  instanceId?: string;
}

export interface CascadingApprovalOptions {
  resolvedSource?: ApprovalTarget;
  approvalSource?: ApprovalTarget;
  type: ApprovalRequestType;
  sessionName: string;
  agentId: string;
  text: string;
  timeoutMs?: number;
  autoApproveWithoutSource?: boolean;
  eventData?: Record<string, unknown>;
  beforeExternalApproval?: () => void;
  /** Present on permission denials that may be granted as a durable profile. */
  grant?: PermissionGrantMetadata | null;
  /** Slack user id of the person whose call was denied. */
  requesterUserId?: string;
}

export interface ContextAuthorizationOptions {
  context: ContextRecord;
  permission: string;
  objectType: string;
  objectId: string;
  timeoutMs?: number;
  eventData?: Record<string, unknown>;
  beforeExternalApproval?: () => void;
}

export interface ContextAuthorizationResult {
  allowed: boolean;
  approved: boolean;
  inherited: boolean;
  reason?: string;
  context: ContextRecord;
}

export interface RequestApprovalOptions {
  timeoutMs?: number;
  type?: ApprovalRequestType;
  sessionName?: string;
  agentId?: string;
  permission?: string;
  objectType?: string;
  objectId?: string;
  delegated?: boolean;
  grant?: PermissionGrantMetadata | null;
  /** Slack user id of the person whose call was denied, for the card mention. */
  requesterUserId?: string;
}

interface ApprovalDeliveryReply {
  messageId?: string;
  deliveries?: Array<{ userId?: unknown; kind?: unknown; chatId?: unknown; messageId?: unknown }>;
}

export async function requestApproval(
  source: ApprovalTarget,
  text: string,
  options?: RequestApprovalOptions,
): Promise<{ approved: boolean; reason?: string; messageId?: string }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const now = approvalServiceDependencies.now();
  const requestId = randomUUID();
  const type = options?.type ?? "permission";
  const slack = isSlackChannel(source.channel);
  const grantInput = slack ? (options?.grant ?? null) : null;
  const grant = grantInput ? { ...grantInput, reason: compactReason(text) } : null;

  // Slack cards go privately to the people who can grant the request, and to
  // nobody else. When nobody can, say so now instead of posting a card no one
  // can use and holding the tool call for the whole approval window.
  const grantors = slack
    ? listSlackApprovalGrantorUserIds({
        instanceId: source.instanceId ?? source.accountId,
        permission: options?.permission,
        objectType: options?.objectType,
        objectId: options?.objectId,
      })
    : [];
  // A grant card goes to the admins when there are any (they can grant the
  // admin profile); otherwise to whoever can grant the exact capability.
  const recipients = grant && grant.adminUserIds.length > 0 ? [...grant.adminUserIds] : grantors;
  if (slack && recipients.length === 0) {
    const reason = buildNoSlackGrantorReason(type, options);
    log.warn("No Slack grantor for approval request", {
      channel: source.channel,
      accountId: source.accountId,
      sessionName: options?.sessionName,
      permission: options?.permission,
      objectType: options?.objectType,
      objectId: options?.objectId,
    });
    return { approved: false, reason };
  }

  // Dedupe: one open grant card per (chat, subject, capability). A second
  // denied call in the same chat waits on the card already on screen.
  if (grant) {
    const duplicate = findOpenGrantRequest(grant, source.chatId, approvalServiceDependencies.now());
    if (duplicate) {
      log.info("Waiting on the open permission grant card", {
        requestId: duplicate.id,
        chatId: grant.targets.chatId,
        capability: formatCanonicalCapability(grant.capability),
      });
      return waitForExistingApproval(duplicate, timeoutMs);
    }
  }

  const slackDelivery = slack
    ? grant
      ? buildSlackPermissionGrantMessage({
          requestId,
          ...(options?.requesterUserId ? { requesterUserId: options.requesterUserId } : {}),
          capabilityText: formatCanonicalCapability(grant.capability),
          reason: grant.reason ?? text,
          ...(options?.agentId ? { agentId: options.agentId } : {}),
          ...(options?.sessionName ? { sessionName: options.sessionName } : {}),
          adminUserIds: grant.adminUserIds,
          allowed: grant.allowed,
          scopes: grant.scopes,
        })
      : buildSlackApprovalRequestMessage({
          requestId,
          type,
          text,
          agentId: options?.agentId,
          sessionName: options?.sessionName,
          delegated: options?.delegated,
        })
    : null;
  const deliveryText =
    slackDelivery?.text ?? buildReactionApprovalText(type, text, options?.agentId, options?.delegated === true);

  createApprovalRequest({
    id: requestId,
    type,
    channel: source.channel,
    accountId: source.accountId,
    chatId: source.chatId,
    instanceId: source.instanceId ?? source.accountId,
    threadId: source.threadId,
    sessionName: options?.sessionName,
    agentId: options?.agentId,
    permission: options?.permission,
    objectType: options?.objectType,
    objectId: options?.objectId,
    ...(grant ? { grant } : {}),
    createdAt: now,
    expiresAt: now + timeoutMs,
  });

  let sendResult: ApprovalDeliveryReply;
  try {
    sendResult = await approvalServiceDependencies.requestReply<ApprovalDeliveryReply>(
      "ravi.outbound.deliver",
      {
        channel: source.channel,
        accountId: source.accountId,
        to: source.chatId,
        text: deliveryText,
        ...(slackDelivery ? { blocks: slackDelivery.blocks, privateTo: recipients } : {}),
        ...(source.threadId ? { threadId: source.threadId } : {}),
      },
      Math.min(timeoutMs, DEFAULT_APPROVAL_DELIVERY_TIMEOUT_MS),
    );
  } catch (err) {
    expireApprovalRequest(requestId, approvalServiceDependencies.now());
    log.warn("Failed to send approval request", { error: err });
    return { approved: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const deliveries = parseApprovalDeliveries(sendResult.deliveries, approvalServiceDependencies.now());
  if (deliveries.length > 0) {
    recordApprovalDeliveries(requestId, deliveries);
  }
  const messageId = sendResult.messageId ?? deliveries[0]?.messageId;
  if (!messageId) {
    expireApprovalRequest(requestId, approvalServiceDependencies.now());
    log.warn("Approval request returned without messageId");
    return { approved: false, reason: "Falha ao enviar mensagem de aprovação." };
  }

  const pending = attachApprovalRequestMessageId(requestId, messageId) ?? getApprovalRequest(requestId);
  if (!pending?.messageId) {
    expireApprovalRequest(requestId, approvalServiceDependencies.now());
    return { approved: false, reason: "Falha ao correlacionar pedido de aprovação." };
  }

  log.info("Waiting for approval response", {
    requestId,
    messageId,
    channel: source.channel,
    privateCards: deliveries.length,
  });
  const result = await waitForApprovalResponse(requestId, timeoutMs);
  return { ...result, messageId };
}

function parseApprovalDeliveries(
  value: ApprovalDeliveryReply["deliveries"],
  now: number,
): Array<{ userId: string; kind: ApprovalDeliveryKind; chatId: string; messageId: string; createdAt: number }> {
  if (!Array.isArray(value)) return [];
  const deliveries: Array<{
    userId: string;
    kind: ApprovalDeliveryKind;
    chatId: string;
    messageId: string;
    createdAt: number;
  }> = [];
  for (const entry of value) {
    const userId = typeof entry?.userId === "string" ? entry.userId.trim() : "";
    const chatId = typeof entry?.chatId === "string" ? entry.chatId.trim() : "";
    const messageId = typeof entry?.messageId === "string" ? entry.messageId.trim() : "";
    const kind = entry?.kind === "dm" ? "dm" : entry?.kind === "ephemeral" ? "ephemeral" : null;
    if (!userId || !chatId || !messageId || !kind) continue;
    deliveries.push({ userId, kind, chatId, messageId, createdAt: now });
  }
  return deliveries;
}

/**
 * The open card that already covers this (chat, subject, capability). Two denied
 * calls in one chat must not produce two cards the admin has to reason about.
 */
function findOpenGrantRequest(
  grant: PermissionGrantMetadata,
  approvalChatId: string,
  now: number,
): ApprovalRequestRecord | null {
  const chatId = approvalChatId?.trim() || grant.targets.chatId;
  if (!chatId) return null;
  for (const candidate of listPendingApprovalRequestsForChat(chatId, now)) {
    const candidateGrant = readPermissionGrantMetadata(candidate);
    if (candidateGrant && sameGrantTuple(candidateGrant, grant)) return candidate;
  }
  return null;
}

/**
 * Wait on a card someone else is already holding. Only the waiter that created
 * the request claims its decision; this path just observes the outcome so the
 * second blocked call proceeds with the same grant.
 */
async function waitForExistingApproval(
  request: ApprovalRequestRecord,
  timeoutMs: number,
): Promise<{ approved: boolean; reason?: string; messageId?: string }> {
  const startedAt = Date.now();
  for (;;) {
    const current = getApprovalRequest(request.id) ?? request;
    if (current.status === "decided") {
      return {
        approved: current.decision === "approved",
        ...(current.decision === "rejected" ? { reason: current.reason ?? "rejected" } : {}),
        ...(current.messageId ? { messageId: current.messageId } : {}),
      };
    }
    if (current.status === "expired") {
      return { approved: false, reason: "Timeout — nenhuma resposta em 5 minutos." };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { approved: false, reason: "Timeout — nenhuma resposta em 5 minutos." };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function buildNoSlackGrantorReason(type: ApprovalRequestType, options: RequestApprovalOptions | undefined): string {
  const asked =
    options?.permission && options.objectType && options.objectId
      ? formatCanonicalCapability({
          permission: options.permission,
          objectType: options.objectType,
          objectId: options.objectId,
        })
      : "admin:system:*";
  const what = type === "plan" ? "este plano" : type === "spec" ? "esta spec" : asked;
  return `Ninguém neste Slack pode aprovar ${what}: nenhuma pessoa vinculada a um usuário do Slack tem a permissão ${asked}. Nenhum pedido foi enviado. Quem tem essa permissão precisa vincular o próprio usuário do Slack ao seu contato, ou conceder a permissão direto ao agente.`;
}

export async function requestPollAnswer(
  source: ApprovalTarget,
  pollName: string,
  optionLabels: string[],
  options?: { timeoutMs?: number; selectableCount?: number },
): Promise<{ selectedLabels: string[] } | { freeText: string }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  let sendResult: { messageId?: string };
  try {
    sendResult = await approvalServiceDependencies.requestReply<{ messageId?: string }>(
      "ravi.outbound.deliver",
      {
        channel: source.channel,
        accountId: source.accountId,
        to: source.chatId,
        poll: {
          name: pollName,
          values: optionLabels,
          selectableCount: options?.selectableCount ?? 1,
        },
      },
      timeoutMs,
    );
  } catch (err) {
    log.warn("Failed to send poll question", { error: err });
    return { freeText: err instanceof Error ? err.message : String(err) };
  }

  if (!sendResult.messageId) {
    log.warn("Poll request returned without messageId");
    return { freeText: "Failed to send poll." };
  }

  log.info("Poll sent, waiting for vote or reply", { messageId: sendResult.messageId, optionLabels });
  return waitForPollAnswer(sendResult.messageId, timeoutMs);
}

export async function requestCascadingApproval(
  opts: CascadingApprovalOptions,
): Promise<{ approved: boolean; reason?: string; isDelegated: boolean }> {
  const targetSource = opts.resolvedSource ?? opts.approvalSource;
  if (!targetSource) {
    if (opts.autoApproveWithoutSource !== false) {
      log.info(`${opts.type} auto-approved (no source available)`, { sessionName: opts.sessionName });
      return { approved: true, isDelegated: false };
    }
    return { approved: false, reason: "No approval source available.", isDelegated: false };
  }

  const isDelegated = !opts.resolvedSource && !!opts.approvalSource;
  opts.beforeExternalApproval?.();
  log.info(`${opts.type} approval requested`, { sessionName: opts.sessionName, isDelegated });

  approvalServiceDependencies.nats
    .emit("ravi.approval.request", {
      type: opts.type,
      sessionName: opts.sessionName,
      agentId: opts.agentId,
      delegated: isDelegated,
      channel: targetSource.channel,
      chatId: targetSource.chatId,
      timestamp: Date.now(),
      ...(opts.eventData ?? {}),
    })
    .catch(() => {});

  const result = await requestApproval(targetSource, opts.text, {
    timeoutMs: opts.timeoutMs,
    type: opts.type,
    sessionName: opts.sessionName,
    agentId: opts.agentId,
    delegated: isDelegated,
    permission: stringField(opts.eventData, "permission"),
    objectType: stringField(opts.eventData, "objectType"),
    objectId: stringField(opts.eventData, "objectId"),
    ...(opts.grant ? { grant: opts.grant } : {}),
    ...(opts.requesterUserId ? { requesterUserId: opts.requesterUserId } : {}),
  });

  await emitApprovalResponseOnce({
    type: opts.type,
    sessionName: opts.sessionName,
    agentId: opts.agentId,
    approved: result.approved,
    reason: result.reason,
    ...(result.messageId ? { messageId: result.messageId } : {}),
    ...(opts.eventData ?? {}),
  }).catch(() => {});

  return { ...result, isDelegated };
}

export async function authorizeRuntimeContext(opts: ContextAuthorizationOptions): Promise<ContextAuthorizationResult> {
  const { context, permission, objectType, objectId } = opts;

  if (isChatOnlyAgent(context.agentId) && isToolOrExecCapability({ permission, objectType })) {
    const reason = `Permission denied: agent:${context.agentId ?? "unknown"} is chat-only and cannot use ${permission} ${objectType}:${objectId}`;
    return denyRuntimeContext(opts, reason, "runtime_chat_only_ceiling");
  }

  if (canWithCapabilityContext(context, permission, objectType, objectId)) {
    return { allowed: true, approved: false, inherited: true, context };
  }

  // An actor that reached the agent from an external surface without resolving to
  // a contact must not escalate: the approval card would go back to that same
  // surface, so the unidentified actor could approve its own request. The CLI and
  // gateway already fail closed for this actor; the tool path does the same.
  if (isUnresolvedExternalActor(context)) {
    const reason = `Permission denied: the actor of this turn is not identified (no linked contact), so ${permission} ${objectType}:${objectId} cannot be requested for approval. Link the actor's identity first.`;
    return denyRuntimeContext(opts, reason, "runtime_actor_unresolved");
  }

  const resolvedSource = toApprovalTarget(context.source);
  const approvalSource = resolvedSource ? undefined : getApprovalSourceFromMetadata(context);
  const text = buildPermissionRequestText(permission, objectType, objectId, context);
  const grant = buildRuntimePermissionGrant(context, { permission, objectType, objectId });
  const result = await requestCascadingApproval({
    resolvedSource,
    approvalSource,
    type: "permission",
    sessionName: context.sessionName ?? context.contextId,
    agentId: context.agentId ?? "unknown",
    text,
    timeoutMs: opts.timeoutMs,
    autoApproveWithoutSource: false,
    beforeExternalApproval: opts.beforeExternalApproval,
    ...(grant ? { grant } : {}),
    ...(grant ? requesterUserIdFor(grant, resolvedSource ?? approvalSource) : {}),
    eventData: {
      ...(opts.eventData ?? {}),
      contextId: context.contextId,
      permission,
      objectType,
      objectId,
    },
  });

  if (!result.approved) {
    const reason =
      result.reason ??
      `Permission denied: agent:${context.agentId ?? "unknown"} requires ${permission} on ${objectType}:${objectId}`;
    return denyRuntimeContext(opts, reason, "runtime_context_permission_denied");
  }

  const updated = dbUpdateContextCapabilities(
    context.contextId,
    dedupeCapabilities([...context.capabilities, { permission, objectType, objectId, source: "approval" }]),
  );
  applyContextSnapshot(context, updated);

  return {
    allowed: true,
    approved: true,
    inherited: false,
    reason: result.reason,
    context,
  };
}

function isUnresolvedExternalActor(context: ContextRecord): boolean {
  return context.metadata?.actorResolution === "missing_contact";
}

/**
 * What a Slack denial card may offer for this turn. Only a Slack turn with a
 * canonical chat and a resolvable subject gets grant metadata; every other
 * case keeps today's one-shot approval card.
 */
function buildRuntimePermissionGrant(
  context: ContextRecord,
  capability: { permission: string; objectType: string; objectId: string },
): PermissionGrantMetadata | null {
  const source = context.source;
  if (!source || !isSlackChannel(source.channel)) return null;
  const instanceId = source.instanceId ?? source.accountId;
  try {
    const adminUserIds = listSlackApprovalGrantorUserIds({
      instanceId,
      permission: "admin",
      objectType: "system",
      objectId: "*",
    });
    const denialId = latestOpenDenialId(context, capability);
    return buildPermissionGrantMetadata({
      context,
      capability,
      adminUserIds,
      ...(typeof denialId === "number" ? { denialId } : {}),
    });
  } catch (error) {
    log.warn("Could not build permission grant metadata", {
      contextId: context.contextId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function latestOpenDenialId(
  context: ContextRecord,
  capability: { permission: string; objectType: string; objectId: string },
): number | undefined {
  const agentId = context.agentId;
  if (!agentId) return undefined;
  const provenance = buildAuditContextProvenance({ context });
  const scope = {
    chatId: provenance?.source?.chatId ?? context.source?.chatId ?? undefined,
    contactId: contactIdFromPrincipal(provenance?.actorPrincipal),
  };
  const open = listPermissionDenials({ subjectType: "agent", subjectId: agentId, resolved: false });
  for (let index = open.length - 1; index >= 0; index -= 1) {
    const denial = open[index];
    if (
      denial.relation === capability.permission &&
      denial.objectType === capability.objectType &&
      denial.objectId === capability.objectId &&
      denialMatchesScope(denial, scope)
    ) {
      return denial.id;
    }
  }
  return undefined;
}

interface DenialScopeFilter {
  readonly chatId?: string;
  readonly contactId?: string;
}

/**
 * A denial is only attributable to a scope when its provenance says so. A
 * denial with no provenance is kept: it cannot be assigned to another chat.
 */
function denialMatchesScope(denial: PermissionDenial, scope: DenialScopeFilter): boolean {
  const context = denialProvenanceContext(denial);
  const denialChatId = stringValue(nestedValue(context, "source", "chatId"));
  if (scope.chatId && denialChatId && denialChatId !== scope.chatId) return false;
  const denialContactId = contactIdFromPrincipal(stringValue(context?.actorPrincipal));
  if (scope.contactId && denialContactId && denialContactId !== scope.contactId) return false;
  return true;
}

/**
 * Which open denials a grant may close. A chat grant only covers its own chat;
 * a contact or chat-tag grant covers the requester's denials; an agent-only
 * grant stays agent-wide.
 */
function denialScopeSelector(
  grant: PermissionGrantMetadata,
  request: ApprovalRequestRecord,
  scope: PermissionGrantScopeValue | null,
): DenialScopeFilter {
  if (!scope) return {};
  if (scope === "chat") {
    const chatId = request.chatId?.trim();
    return chatId ? { chatId } : {};
  }
  const contactId = grant.targets.contactId;
  return contactId ? { contactId } : {};
}

function denialProvenanceContext(denial: PermissionDenial): Record<string, unknown> | null {
  const context = denial.detail?.context;
  return context && typeof context === "object" && !Array.isArray(context)
    ? (context as Record<string, unknown>)
    : null;
}

function nestedValue(record: Record<string, unknown> | null, ...path: string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function contactIdFromPrincipal(principal: string | undefined): string | undefined {
  const normalized = principal?.trim();
  if (!normalized?.startsWith("contact:")) return undefined;
  const contactId = normalized.slice("contact:".length).trim();
  return contactId.length > 0 ? contactId : undefined;
}

function requesterUserIdFor(
  grant: PermissionGrantMetadata,
  source: ApprovalTarget | undefined,
): { requesterUserId?: string } {
  const contactId = grant.targets.contactId;
  if (!contactId) return {};
  const userId = findSlackUserIdForContact({ contactId, instanceId: source?.instanceId ?? source?.accountId });
  return userId ? { requesterUserId: userId } : {};
}

function denyRuntimeContext(
  opts: ContextAuthorizationOptions,
  reason: string,
  blockType: string,
): ContextAuthorizationResult {
  const { context, permission, objectType, objectId } = opts;
  const provenance = buildAuditContextProvenance({ context });
  recordAndEmitPermissionDenial({
    subjectType: "agent",
    subjectId: context.agentId ?? undefined,
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    sessionName: context.sessionName,
    contextId: context.contextId,
    relation: permission,
    objectType,
    objectId,
    reason,
    detail: provenance ? { context: provenance } : undefined,
    audit: {
      type: permissionDeniedAuditType(objectType),
      agentId: context.agentId ?? "unknown",
      denied: `${objectType}:${objectId}`,
      reason,
      blockType,
      ...(provenance ? { context: provenance } : {}),
    },
  });
  return {
    allowed: false,
    approved: false,
    inherited: false,
    reason,
    context,
  };
}

function permissionDeniedAuditType(objectType: string): string {
  if (objectType === "tool") return "tool";
  if (objectType === "executable") return "executable";
  if (objectType === "session") return "session_scope";
  return "scope";
}

function buildReactionApprovalText(
  type: ApprovalRequestType,
  text: string,
  agentId: string | undefined,
  delegated: boolean,
): string {
  const label = type === "plan" ? "Plano pendente" : type === "spec" ? "Spec pendente" : "Permissão solicitada";
  if (delegated) {
    return `📋 *${label}* (de _${agentId ?? "unknown"}_)\n\n${text}\n\n_Reaja com 👍 ou ❤️ pra aprovar, ou responda pra rejeitar._`;
  }
  return `📋 *${label}*\n\n${text}\n\n_Reaja com 👍 ou ❤️ pra aprovar, ou responda pra rejeitar._`;
}

function buildPermissionRequestText(
  permission: string,
  objectType: string,
  objectId: string,
  context: ContextRecord,
): string {
  const sessionLabel = context.sessionName ?? context.sessionKey ?? context.contextId;
  const capability = { permission, objectType, objectId };
  const guidance = buildAuthorizationGuidance({
    capability,
    subject: context.agentId ? { type: "agent", id: context.agentId } : undefined,
    scope: "current-context",
    includeProviderOwnedTags: true,
  });
  return [
    `Sessão: ${sessionLabel}`,
    `Capability: ${formatCanonicalCapability(capability)}`,
    "Escopo: contexto atual",
    "",
    "Autorizar só para este contexto?",
    `Recorrente: ${guidance.preferredPath.message}`,
    `Fallback técnico: ${guidance.rawCapabilityFallback}`,
  ].join("\n");
}

async function waitForApprovalResponse(
  requestId: string,
  timeoutMs: number,
): Promise<{ approved: boolean; reason?: string }> {
  const stream = approvalServiceDependencies.nats.subscribe(
    "ravi.inbound.interaction",
    "ravi.inbound.reaction",
    "ravi.inbound.reply",
  );

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      stream.return?.(undefined);
    };

    const finish = (result: { approved: boolean; reason?: string }) => {
      if (settled) return;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      const now = approvalServiceDependencies.now();
      const expired = expireApprovalRequest(requestId, now);
      if (expired) {
        void finalizeApprovalMessage(expired, "expired").catch((error) => {
          log.warn("Failed to finalize expired Slack approval message", { requestId, error });
        });
      }
      log.warn("Approval timed out", { requestId });
      finish({ approved: false, reason: "Timeout — nenhuma resposta em 5 minutos." });
    }, timeoutMs);

    (async () => {
      try {
        for await (const event of stream) {
          const evaluation = evaluateApprovalInboundEvent(
            { topic: event.topic, data: event.data as Record<string, unknown> },
            approvalServiceDependencies.now(),
          );
          if (evaluation.kind === "ignore") {
            log.info("Ignoring inbound approval event", {
              requestId,
              topic: event.topic,
              reason: evaluation.reason,
            });
            continue;
          }
          if (evaluation.request.id !== requestId) continue;

          if (evaluation.kind === "scope") {
            setApprovalCardScope({
              requestId,
              userId: evaluation.actorId,
              scope: evaluation.scope,
              now: approvalServiceDependencies.now(),
            });
            await reRenderGrantCard(
              evaluation.request,
              evaluation.actorId,
              evaluation.scope,
              evaluation.responseUrlId,
            ).catch((error) => log.warn("Failed to re-render the grant card scope", { requestId, error }));
            continue;
          }

          const claimed = claimApprovalDecision({
            id: requestId,
            decision: evaluation.decision,
            decidedBy: evaluation.actorId,
            reason: evaluation.reason,
            ...(evaluation.grant ? { grantIntent: evaluation.grant.intent } : {}),
            ...(evaluation.grant?.scope ? { grantScope: evaluation.grant.scope } : {}),
            now: approvalServiceDependencies.now(),
          });
          if (!claimed) {
            log.info("Approval decision lost the single-use claim", { requestId });
            continue;
          }

          const grantOutcome = await applyGrantForDecision(claimed, evaluation).catch((error) => {
            log.warn("Failed to apply a permission grant", { requestId, error });
            return { detail: "grant failed", failed: true };
          });

          await finalizeApprovalMessage(
            claimed,
            claimed.decision ?? evaluation.decision,
            { actorId: evaluation.actorId, responseUrlId: evaluation.responseUrlId },
            grantOutcome?.detail,
          ).catch((error) => {
            log.warn("Failed to finalize Slack approval message", { requestId, error });
          });
          // A grant click that could not write the grant does not let the
          // blocked call through: the next denial opens a fresh card.
          if (grantOutcome?.failed) {
            finish({ approved: false, reason: "The permission grant could not be applied." });
            return;
          }
          finish({
            approved: claimed.decision === "approved",
            ...(claimed.decision === "rejected" ? { reason: claimed.reason ?? evaluation.reason } : {}),
          });
          return;
        }
      } catch (err) {
        finish({ approved: false, reason: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

/**
 * Apply the grant a click chose, then close the denial ledger row. The click's
 * scope was validated against the stored grant before the claim, so the only
 * thing left here is the durable write and its audit trail.
 */
async function applyGrantForDecision(
  request: ApprovalRequestRecord,
  evaluation: Extract<ApprovalInboundEvaluation, { kind: "decide" }>,
): Promise<{ detail?: string; failed?: boolean } | null> {
  const grant = readPermissionGrantMetadata(request);
  const click = evaluation.grant;
  if (!grant || !click || request.decision !== "approved") return null;

  const scopeRef = click.scope ? resolveGrantScopeRef(click.scope, grant.targets.chatId) : null;
  const scopeLabel = click.scope ?? null;
  const idempotencyKey = `permission-grant:${request.id}:${click.intent}:${scopeLabel ?? "agent"}`;
  const now = approvalServiceDependencies.now();

  let applied: ReturnType<typeof applyPermissionGrant> | null = null;
  let errorText: string | undefined;
  try {
    applied = applyPermissionGrant({
      intent: click.intent,
      scope: scopeRef,
      capability: grant.capability,
      ...(grant.targets.contactId ? { contactId: grant.targets.contactId } : {}),
      ...(grant.targets.agentId ? { agentId: grant.targets.agentId } : {}),
      actor: {
        channel: request.channel,
        ...(request.decidedBy ? { userId: request.decidedBy } : {}),
        ...(grant.targets.contactId ? { contactId: grant.targets.contactId } : {}),
      },
      requestId: request.id,
      ...(typeof grant.denialId === "number" ? { denialId: grant.denialId } : {}),
      idempotencyKey,
      createdBy: "approval.grant-card",
      now,
    });
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error);
    log.warn("Permission grant could not be applied", { requestId: request.id, error: errorText });
  }

  let resolvedDenials = 0;
  if (applied) {
    const denialSubjectId = grant.targets.agentId ?? request.agentId;
    const denialScope = denialScopeSelector(grant, request, click.scope);
    resolvedDenials = resolvePermissionDenials({
      relation: grant.capability.permission,
      objectType: grant.capability.objectType,
      objectId: grant.capability.objectId,
      ...(denialSubjectId ? { subjectType: "agent", subjectId: denialSubjectId } : {}),
      ...denialScope,
      now,
    });
  }

  emitPermissionGrantAudit({
    agentId: request.agentId ?? grant.targets.agentId ?? "unknown",
    requestId: request.id,
    ...(typeof grant.denialId === "number" ? { denialId: grant.denialId } : {}),
    capability: formatCanonicalCapability(grant.capability),
    intent: click.intent,
    scope: scopeLabel ?? "agent",
    clicker: {
      channel: request.channel,
      userId: request.decidedBy,
      ...(evaluation.actorId ? { actorId: evaluation.actorId } : {}),
    },
    profile: applied?.profile ?? null,
    capabilities: applied?.capabilities.map(formatCanonicalCapability) ?? [],
    agentCeiling: {
      agentId: grant.targets.agentId ?? null,
      changed: applied?.operations.some((op) => op.kind === "agent-ceiling" && op.status === "applied") ?? false,
    },
    changed: applied?.changed ?? false,
    replay: applied?.replay ?? false,
    applied: Boolean(applied),
    resolvedDenials,
    operations: applied?.operations ?? [],
    ...(errorText ? { error: errorText } : {}),
    timestamp: new Date(now).toISOString(),
  });

  if (!applied) return { detail: "grant failed", failed: true };
  const target = scopeLabel ? ` in ${describeGrantScope(scopeLabel)}` : " (agent ceiling)";
  return {
    detail:
      click.intent === "full-access"
        ? `Full access${target}`
        : `Granted ${formatCanonicalCapability(grant.capability)}${target}`,
  };
}

/** Re-render one person's private card after they picked a scope. */
async function reRenderGrantCard(
  request: ApprovalRequestRecord,
  actorId: string,
  scope: PermissionGrantScopeValue,
  responseUrlId: string | undefined,
): Promise<void> {
  const grant = readPermissionGrantMetadata(request);
  if (!grant || !responseUrlId) return;
  const requesterUserId = grant.targets.contactId
    ? findSlackUserIdForContact({
        contactId: grant.targets.contactId,
        instanceId: request.instanceId ?? request.accountId,
      })
    : null;
  const payload = buildSlackPermissionGrantMessage({
    requestId: request.id,
    ...(requesterUserId ? { requesterUserId } : {}),
    capabilityText: formatCanonicalCapability(grant.capability),
    ...(grant.reason ? { reason: grant.reason } : {}),
    ...(request.agentId ? { agentId: request.agentId } : {}),
    ...(request.sessionName ? { sessionName: request.sessionName } : {}),
    adminUserIds: grant.adminUserIds,
    allowed: grant.allowed,
    scopes: grant.scopes,
    selectedScope: scope,
  });
  log.info("Re-rendering the grant card scope", { requestId: request.id, actorId, scope });
  await approvalServiceDependencies.respondSlackInteraction({
    responseUrlId,
    payload: { replace_original: true, text: payload.text, blocks: payload.blocks },
  });
}

function compactReason(value: string | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 300 ? `${compact.slice(0, 297)}...` : compact;
}

/**
 * Takes the buttons away once a request is settled. Private cards: the clicker's
 * own card is replaced through its `response_url`, DM cards are edited in place.
 * Other people's ephemeral cards cannot be edited by the app; a later click on
 * one is answered privately with the outcome (see slack-click-feedback).
 */
async function finalizeApprovalMessage(
  request: ApprovalRequestRecord,
  outcome: "approved" | "rejected" | "expired",
  clicker?: { readonly actorId?: string; readonly responseUrlId?: string },
  detail?: string,
): Promise<void> {
  if (!isSlackChannel(request.channel) || !request.messageId) return;
  const message = buildSlackApprovalFinalMessage({
    type: request.type,
    outcome,
    reason: request.reason ?? undefined,
    decidedBy: outcome === "expired" ? undefined : (request.decidedBy ?? undefined),
    ...(outcome === "approved" && detail ? { detail } : {}),
  });
  const deliveries = listApprovalDeliveries(request.id);
  if (deliveries.length === 0) {
    await approvalServiceDependencies.finalizeSlackApproval({
      accountId: request.accountId,
      chatId: request.chatId,
      messageId: request.messageId,
      text: message.text,
      blocks: message.blocks,
    });
    return;
  }

  const clickerId = clicker?.actorId?.toUpperCase();
  const updates: Array<Promise<void>> = [];
  for (const delivery of deliveries) {
    if (delivery.kind === "dm") {
      updates.push(
        approvalServiceDependencies.finalizeSlackApproval({
          accountId: request.accountId,
          chatId: delivery.chatId,
          messageId: delivery.messageId,
          text: message.text,
          blocks: message.blocks,
        }),
      );
      continue;
    }
    if (clicker?.responseUrlId && clickerId && delivery.userId.toUpperCase() === clickerId) {
      updates.push(
        approvalServiceDependencies.respondSlackInteraction({
          responseUrlId: clicker.responseUrlId,
          payload: { replace_original: true, text: message.text, blocks: message.blocks },
        }),
      );
    }
  }
  const results = await Promise.allSettled(updates);
  for (const result of results) {
    if (result.status === "rejected") {
      log.warn("Failed to update a private Slack approval card", { requestId: request.id, error: result.reason });
    }
  }
}

async function waitForPollAnswer(
  messageId: string,
  timeoutMs: number,
): Promise<{ selectedLabels: string[] } | { freeText: string }> {
  const stream = approvalServiceDependencies.nats.subscribe("ravi.inbound.reply", "ravi.inbound.pollVote");

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      stream.return?.(undefined);
    };

    const timer = setTimeout(() => {
      cleanup();
      log.warn("Poll answer timed out", { messageId });
      resolve({ freeText: "Timeout — nenhuma resposta." });
    }, timeoutMs);

    (async () => {
      try {
        for await (const event of stream) {
          if (event.topic === "ravi.inbound.reply") {
            const data = event.data as { targetMessageId?: string; text?: string };
            if (data.targetMessageId !== messageId) continue;
            clearTimeout(timer);
            cleanup();
            resolve({ freeText: data.text ?? "" });
            return;
          }

          const data = event.data as { pollMessageId?: string; votes?: Array<{ name: string; voters: string[] }> };
          if (data.pollMessageId !== messageId) continue;
          const selected = (data.votes ?? []).filter((vote) => vote.voters.length > 0).map((vote) => vote.name);
          if (selected.length === 0) continue;
          clearTimeout(timer);
          cleanup();
          resolve({ selectedLabels: selected });
          return;
        }
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        resolve({ freeText: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

function toApprovalTarget(source: ContextRecord["source"]): ApprovalTarget | undefined {
  if (!source) return undefined;
  return {
    channel: source.channel,
    accountId: source.accountId,
    chatId: source.chatId,
    ...(source.threadId ? { threadId: source.threadId } : {}),
  };
}

function getApprovalSourceFromMetadata(context: ContextRecord): ApprovalTarget | undefined {
  const approvalSource = context.metadata?.approvalSource;
  if (!approvalSource || typeof approvalSource !== "object") return undefined;
  const candidate = approvalSource as Record<string, unknown>;
  if (
    typeof candidate.channel !== "string" ||
    typeof candidate.accountId !== "string" ||
    typeof candidate.chatId !== "string"
  ) {
    return undefined;
  }

  return {
    channel: candidate.channel,
    accountId: candidate.accountId,
    chatId: candidate.chatId,
    ...(typeof candidate.threadId === "string" ? { threadId: candidate.threadId } : {}),
    ...(typeof candidate.instanceId === "string" ? { instanceId: candidate.instanceId } : {}),
  };
}

function dedupeCapabilities(capabilities: ContextCapability[]): ContextCapability[] {
  const seen = new Set<string>();
  const result: ContextCapability[] = [];
  for (const capability of capabilities) {
    const key = `${capability.permission}:${capability.objectType}:${capability.objectId}:${capability.source ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capability);
  }
  return result;
}

function applyContextSnapshot(target: ContextRecord, updated: ContextRecord): void {
  target.capabilities = updated.capabilities;
  target.lastUsedAt = updated.lastUsedAt;
  target.revokedAt = updated.revokedAt;
  target.expiresAt = updated.expiresAt;
  target.metadata = updated.metadata;
}

function isSlackChannel(channel: string): boolean {
  return channel.trim().toLowerCase() === "slack";
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
