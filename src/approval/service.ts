import { randomUUID } from "node:crypto";
import { nats as runtimeNats } from "../nats.js";
import { isChatOnlyAgent, isToolOrExecCapability } from "../permissions/agent-default-capabilities-provider.js";
import { canWithCapabilityContext } from "../permissions/provider-runtime.js";
import { recordAndEmitPermissionDenial } from "../permissions/denials.js";
import { buildAuditContextProvenance } from "../permissions/audit-provenance.js";
import { buildAuthorizationGuidance, formatCanonicalCapability } from "../permissions/authorization-guidance.js";
import { dbUpdateContextCapabilities, type ContextCapability, type ContextRecord } from "../router/router-db.js";
import { updateSlackText } from "../channels/slack/text-send.js";
import { requestReply as runtimeRequestReply } from "../utils/request-reply.js";
import { logger } from "../utils/logger.js";
import { evaluateApprovalInboundEvent } from "./decision.js";
import { buildSlackApprovalFinalMessage, buildSlackApprovalRequestMessage } from "./slack-blocks.js";
import {
  attachApprovalRequestMessageId,
  claimApprovalDecision,
  createApprovalRequest,
  expireApprovalRequest,
  getApprovalRequest,
  type ApprovalRequestRecord,
  type ApprovalRequestType,
} from "./store.js";

const log = logger.child("approval:service");
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export interface ApprovalFinalizeSlackInput {
  readonly accountId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly text: string;
  readonly blocks: readonly Record<string, unknown>[];
}

export interface ApprovalServiceDependencies {
  nats: Pick<typeof runtimeNats, "emit" | "subscribe">;
  requestReply: typeof runtimeRequestReply;
  now: () => number;
  finalizeSlackApproval: (input: ApprovalFinalizeSlackInput) => Promise<void>;
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
  const slackDelivery = slack
    ? buildSlackApprovalRequestMessage({
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
    createdAt: now,
    expiresAt: now + timeoutMs,
  });

  let sendResult: { messageId?: string };
  try {
    sendResult = await approvalServiceDependencies.requestReply<{ messageId?: string }>(
      "ravi.outbound.deliver",
      {
        channel: source.channel,
        accountId: source.accountId,
        to: source.chatId,
        text: deliveryText,
        ...(slackDelivery ? { blocks: slackDelivery.blocks } : {}),
        ...(source.threadId ? { threadId: source.threadId } : {}),
      },
      timeoutMs,
    );
  } catch (err) {
    expireApprovalRequest(requestId, approvalServiceDependencies.now());
    log.warn("Failed to send approval request", { error: err });
    return { approved: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (!sendResult.messageId) {
    expireApprovalRequest(requestId, approvalServiceDependencies.now());
    log.warn("Approval request returned without messageId");
    return { approved: false, reason: "Falha ao enviar mensagem de aprovação." };
  }

  const pending = attachApprovalRequestMessageId(requestId, sendResult.messageId) ?? getApprovalRequest(requestId);
  if (!pending?.messageId) {
    expireApprovalRequest(requestId, approvalServiceDependencies.now());
    return { approved: false, reason: "Falha ao correlacionar pedido de aprovação." };
  }

  log.info("Waiting for approval response", { requestId, messageId: sendResult.messageId, channel: source.channel });
  const result = await waitForApprovalResponse(requestId, timeoutMs);
  return { ...result, messageId: sendResult.messageId };
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
        blockType: "runtime_chat_only_ceiling",
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

  if (canWithCapabilityContext(context, permission, objectType, objectId)) {
    return { allowed: true, approved: false, inherited: true, context };
  }

  const resolvedSource = toApprovalTarget(context.source);
  const approvalSource = resolvedSource ? undefined : getApprovalSourceFromMetadata(context);
  const text = buildPermissionRequestText(permission, objectType, objectId, context);
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
        blockType: "runtime_context_permission_denied",
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

          const claimed = claimApprovalDecision({
            id: requestId,
            decision: evaluation.decision,
            decidedBy: evaluation.actorId,
            reason: evaluation.reason,
            now: approvalServiceDependencies.now(),
          });
          if (!claimed) {
            log.info("Approval decision lost the single-use claim", { requestId });
            continue;
          }

          await finalizeApprovalMessage(claimed, claimed.decision ?? evaluation.decision).catch((error) => {
            log.warn("Failed to finalize Slack approval message", { requestId, error });
          });
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

async function finalizeApprovalMessage(
  request: ApprovalRequestRecord,
  outcome: "approved" | "rejected" | "expired",
): Promise<void> {
  if (!isSlackChannel(request.channel) || !request.messageId) return;
  const message = buildSlackApprovalFinalMessage({
    type: request.type,
    outcome,
    reason: request.reason ?? undefined,
  });
  await approvalServiceDependencies.finalizeSlackApproval({
    accountId: request.accountId,
    chatId: request.chatId,
    messageId: request.messageId,
    text: message.text,
    blocks: message.blocks,
  });
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
