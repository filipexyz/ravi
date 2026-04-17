import { nats } from "../nats.js";
import { canWithCapabilityContext } from "../permissions/engine.js";
import { dbUpdateContextCapabilities, type ContextCapability, type ContextRecord } from "../router/router-db.js";
import { requestReply } from "../utils/request-reply.js";
import { logger } from "../utils/logger.js";

const log = logger.child("approval:service");
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ApprovalTarget {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string;
}

export interface CascadingApprovalOptions {
  resolvedSource?: ApprovalTarget;
  approvalSource?: ApprovalTarget;
  type: "plan" | "spec" | "permission";
  sessionName: string;
  agentId: string;
  text: string;
  timeoutMs?: number;
  autoApproveWithoutSource?: boolean;
  eventData?: Record<string, unknown>;
}

export interface ContextAuthorizationOptions {
  context: ContextRecord;
  permission: string;
  objectType: string;
  objectId: string;
  timeoutMs?: number;
}

export interface ContextAuthorizationResult {
  allowed: boolean;
  approved: boolean;
  inherited: boolean;
  reason?: string;
  context: ContextRecord;
}

export async function requestApproval(
  source: ApprovalTarget,
  text: string,
  options?: { timeoutMs?: number },
): Promise<{ approved: boolean; reason?: string }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let sendResult: { messageId?: string };
  try {
    sendResult = await requestReply<{ messageId?: string }>(
      "ravi.outbound.deliver",
      {
        channel: source.channel,
        accountId: source.accountId,
        to: source.chatId,
        text,
      },
      timeoutMs,
    );
  } catch (err) {
    log.warn("Failed to send approval request", { error: err });
    return { approved: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (!sendResult.messageId) {
    log.warn("Approval request returned without messageId");
    return { approved: false, reason: "Falha ao enviar mensagem de aprovação." };
  }

  log.info("Waiting for approval response", { messageId: sendResult.messageId });
  return waitForApprovalResponse(sendResult.messageId, timeoutMs);
}

export async function requestPollAnswer(
  source: ApprovalTarget,
  pollName: string,
  optionLabels: string[],
  options?: { timeoutMs?: number; selectableCount?: number },
): Promise<{ selectedLabels: string[] } | { freeText: string }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let sendResult: { messageId?: string };
  try {
    sendResult = await requestReply<{ messageId?: string }>(
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
  log.info(`${opts.type} approval requested`, { sessionName: opts.sessionName, isDelegated });

  nats
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

  const approvalText = buildApprovalText(opts.type, opts.text, opts.agentId, isDelegated);
  const result = await requestApproval(targetSource, approvalText, { timeoutMs: opts.timeoutMs });

  nats
    .emit("ravi.approval.response", {
      type: opts.type,
      sessionName: opts.sessionName,
      agentId: opts.agentId,
      approved: result.approved,
      reason: result.reason,
      timestamp: Date.now(),
      ...(opts.eventData ?? {}),
    })
    .catch(() => {});

  return { ...result, isDelegated };
}

export async function authorizeRuntimeContext(opts: ContextAuthorizationOptions): Promise<ContextAuthorizationResult> {
  const { context, permission, objectType, objectId } = opts;

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
    eventData: {
      contextId: context.contextId,
      permission,
      objectType,
      objectId,
    },
  });

  if (!result.approved) {
    return {
      allowed: false,
      approved: false,
      inherited: false,
      reason: result.reason,
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

function buildApprovalText(
  type: CascadingApprovalOptions["type"],
  text: string,
  agentId: string,
  delegated: boolean,
): string {
  const label = type === "plan" ? "Plano pendente" : type === "spec" ? "Spec pendente" : "Permissão solicitada";
  if (delegated) {
    return `📋 *${label}* (de _${agentId}_)\n\n${text}\n\n_Reaja com 👍 ou ❤️ pra aprovar, ou responda pra rejeitar._`;
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
  return [
    `Sessão: ${sessionLabel}`,
    `Ação: ${permission}`,
    `Objeto: ${objectType}:${objectId}`,
    "",
    "Autorizar esta capability para o contexto atual?",
  ].join("\n");
}

async function waitForApprovalResponse(
  messageId: string,
  timeoutMs: number,
): Promise<{ approved: boolean; reason?: string }> {
  const stream = nats.subscribe("ravi.inbound.reaction", "ravi.inbound.reply");

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      stream.return?.(undefined);
    };

    const timer = setTimeout(() => {
      cleanup();
      log.warn("Approval timed out", { messageId });
      resolve({ approved: false, reason: "Timeout — nenhuma resposta em 5 minutos." });
    }, timeoutMs);

    (async () => {
      try {
        for await (const event of stream) {
          if (event.topic === "ravi.inbound.reaction") {
            const data = event.data as { targetMessageId?: string; emoji?: string };
            if (data.targetMessageId !== messageId) continue;
            clearTimeout(timer);
            cleanup();
            const approved = data.emoji === "👍" || data.emoji === "❤️" || data.emoji === "❤";
            resolve({ approved });
            return;
          }

          const data = event.data as { targetMessageId?: string; text?: string };
          if (data.targetMessageId !== messageId) continue;
          clearTimeout(timer);
          cleanup();
          resolve({ approved: false, reason: data.text });
          return;
        }
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        resolve({ approved: false, reason: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

async function waitForPollAnswer(
  messageId: string,
  timeoutMs: number,
): Promise<{ selectedLabels: string[] } | { freeText: string }> {
  const stream = nats.subscribe("ravi.inbound.reply", "ravi.inbound.pollVote");

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
