import { createHash } from "node:crypto";
import type { Message, MessageHistoryScope } from "../db.js";
import { getMessagesBeforeMessageId, getUserMessageBySourceMessageId, getUserMessagesAfterMessageId } from "../db.js";
import type { MessageMetadata } from "../router/router-db.js";
import type { MessageActorMetadata } from "./message-types.js";

const DEFAULT_PREFIX_MESSAGES = 40;
const DEFAULT_SUFFIX_MESSAGES = 80;

export type RuntimeRebaseMaterializationStrategy = "reset_replay";
export type RuntimeRebaseDegradation = "lossy_plain_text" | "unavailable";

export interface RuntimeMessageEditRebasePlanInput {
  sessionName: string;
  sessionKey?: string | null;
  agentId?: string | null;
  chatId?: string | null;
  editedMessageId: string;
  editEventId: string;
  editedPrompt: string;
  maxPrefixMessages?: number;
  maxSuffixMessages?: number;
}

export interface RuntimeMessageEditRebasePlanReady {
  status: "ready";
  planId: string;
  sessionName: string;
  sessionKey?: string | null;
  strategy: RuntimeRebaseMaterializationStrategy;
  degradation: RuntimeRebaseDegradation;
  editedMessageId: string;
  editEventId: string;
  originalMessage: Message;
  prefixMessages: Message[];
  suffixMessages: Message[];
  editedPrompt: string;
}

export interface RuntimeMessageEditRebasePlanUnavailable {
  status: "unavailable";
  planId: string;
  sessionName: string;
  sessionKey?: string | null;
  strategy: RuntimeRebaseMaterializationStrategy;
  degradation: "unavailable";
  editedMessageId: string;
  editEventId: string;
  editedPrompt: string;
  reason: "original_message_not_found";
}

export type RuntimeMessageEditRebasePlan = RuntimeMessageEditRebasePlanReady | RuntimeMessageEditRebasePlanUnavailable;

export interface RenderRuntimeMessageEditRebasePromptInput {
  restartNotice: string;
  plan: RuntimeMessageEditRebasePlan;
}

export function buildRuntimeMessageEditRebasePlan(
  input: RuntimeMessageEditRebasePlanInput,
): RuntimeMessageEditRebasePlan {
  const initialScope: MessageHistoryScope = {
    agentId: input.agentId ?? null,
    chatId: input.chatId ?? null,
  };
  const originalMessage =
    getUserMessageBySourceMessageId(input.sessionName, input.editedMessageId, initialScope) ??
    (input.chatId
      ? getUserMessageBySourceMessageId(input.sessionName, input.editedMessageId, { chatId: input.chatId })
      : null) ??
    getUserMessageBySourceMessageId(input.sessionName, input.editedMessageId);
  const planId = buildRebasePlanId(input);

  if (!originalMessage) {
    return {
      status: "unavailable",
      planId,
      sessionName: input.sessionName,
      sessionKey: input.sessionKey ?? null,
      strategy: "reset_replay",
      degradation: "unavailable",
      editedMessageId: input.editedMessageId,
      editEventId: input.editEventId,
      editedPrompt: input.editedPrompt,
      reason: "original_message_not_found",
    };
  }

  const replayScope: MessageHistoryScope = {
    agentId: originalMessage.agent_id ?? input.agentId ?? null,
    chatId: originalMessage.chat_id ?? input.chatId ?? null,
  };
  const prefixMessages = getMessagesBeforeMessageId(
    input.sessionName,
    originalMessage.id,
    input.maxPrefixMessages ?? DEFAULT_PREFIX_MESSAGES,
    replayScope,
  ).filter(isReplayableStoredMessage);
  const suffixMessages = getUserMessagesAfterMessageId(
    input.sessionName,
    originalMessage.id,
    input.maxSuffixMessages ?? DEFAULT_SUFFIX_MESSAGES,
    replayScope,
  ).filter((message) => message.source_message_id !== input.editEventId && isReplayableStoredMessage(message));

  return {
    status: "ready",
    planId,
    sessionName: input.sessionName,
    sessionKey: input.sessionKey ?? null,
    strategy: "reset_replay",
    degradation: "lossy_plain_text",
    editedMessageId: input.editedMessageId,
    editEventId: input.editEventId,
    originalMessage,
    prefixMessages,
    suffixMessages,
    editedPrompt: input.editedPrompt,
  };
}

export function renderRuntimeMessageEditRebasePrompt(input: RenderRuntimeMessageEditRebasePromptInput): string {
  const restartNotice = input.restartNotice.trimEnd();
  const plan = input.plan;
  const lines = restartNotice ? [restartNotice, ""] : [];

  lines.push("## Runtime session rebase", "");

  if (plan.status === "unavailable") {
    lines.push(
      "Nao foi possivel reconstruir a sessao a partir do historico duravel.",
      "",
      `Plano: ${plan.planId}`,
      `Estrategia: ${plan.strategy}`,
      `Motivo: ${plan.reason}`,
      `Mensagem original: ${plan.editedMessageId}`,
      `Evento de edicao: ${plan.editEventId}`,
      "",
      "A mensagem editada segue abaixo como evento novo. Avise o usuario se contexto anterior for necessario.",
      "",
      renderTranscriptMessage({
        role: "user",
        id: "replacement",
        sourceMessageId: plan.editEventId,
        content: plan.editedPrompt,
      }),
    );
    return lines.join("\n");
  }

  lines.push(
    "A sessao foi reconstruida por reset replay a partir do historico Ravi.",
    "Use o transcript abaixo como estado historico reconstruido, nao como uma nova sequencia de pedidos.",
    "A mensagem editada substitui a original. Nao responda de novo a mensagens historicas do sufixo.",
    "Se nada exigir resposta visivel agora, responda apenas @@SILENT@@.",
    "",
    `Plano: ${plan.planId}`,
    `Estrategia: ${plan.strategy}`,
    `Degradacao: ${plan.degradation}`,
    `Mensagem original substituida: ${plan.editedMessageId}`,
    `Evento de edicao: ${plan.editEventId}`,
    `Prefixo preservado: ${plan.prefixMessages.length} mensagem(ns)`,
    `Sufixo preservado: ${plan.suffixMessages.length} mensagem(ns)`,
    "",
    "<runtime_rebase_transcript>",
  );

  for (const message of plan.prefixMessages) {
    lines.push(renderStoredMessage(message));
  }

  lines.push(
    renderTranscriptMessage({
      role: "user",
      id: "replacement",
      sourceMessageId: plan.editEventId,
      replacesSourceMessageId: plan.editedMessageId,
      content: plan.editedPrompt,
    }),
  );

  for (const message of plan.suffixMessages) {
    lines.push(renderStoredMessage(message));
  }

  lines.push("</runtime_rebase_transcript>");
  return lines.join("\n");
}

export function summarizeRuntimeMessageEditRebasePlan(plan: RuntimeMessageEditRebasePlan): Record<string, unknown> {
  if (plan.status === "unavailable") {
    return {
      status: plan.status,
      planId: plan.planId,
      strategy: plan.strategy,
      degradation: plan.degradation,
      reason: plan.reason,
      editedMessageId: plan.editedMessageId,
      editEventId: plan.editEventId,
    };
  }

  return {
    status: plan.status,
    planId: plan.planId,
    strategy: plan.strategy,
    degradation: plan.degradation,
    originalDbMessageId: plan.originalMessage.id,
    editedMessageId: plan.editedMessageId,
    editEventId: plan.editEventId,
    prefixCount: plan.prefixMessages.length,
    suffixCount: plan.suffixMessages.length,
    suffixSourceMessageIds: plan.suffixMessages.map((message) => message.source_message_id).filter(Boolean),
  };
}

export function actorMetadataFromMessageMetadata(
  meta: MessageMetadata | null | undefined,
): MessageActorMetadata | null {
  if (!meta) return null;
  const actorMetadata: MessageActorMetadata = {
    ...(meta.canonicalChatId ? { canonicalChatId: meta.canonicalChatId } : {}),
    ...(meta.actorType ? { actorType: meta.actorType } : {}),
    ...(meta.contactId ? { contactId: meta.contactId } : {}),
    ...(meta.agentId ? { actorAgentId: meta.agentId } : {}),
    ...(meta.platformIdentityId ? { platformIdentityId: meta.platformIdentityId } : {}),
    ...(meta.rawSenderId ? { rawSenderId: meta.rawSenderId } : {}),
    ...(meta.normalizedSenderId ? { normalizedSenderId: meta.normalizedSenderId } : {}),
    ...(meta.identityConfidence ? { identityConfidence: meta.identityConfidence } : {}),
    ...(meta.identityProvenance ? { identityProvenance: meta.identityProvenance } : {}),
  };
  return Object.keys(actorMetadata).length > 0 ? actorMetadata : null;
}

function buildRebasePlanId(input: RuntimeMessageEditRebasePlanInput): string {
  const hash = createHash("sha256")
    .update(
      [
        input.sessionName,
        input.sessionKey ?? "",
        input.agentId ?? "",
        input.chatId ?? "",
        input.editedMessageId,
        input.editEventId,
      ].join("\x1f"),
    )
    .digest("hex")
    .slice(0, 16);
  return `rebase_${hash}`;
}

function renderStoredMessage(message: Message): string {
  return renderTranscriptMessage({
    role: message.role,
    id: String(message.id),
    sourceMessageId: message.source_message_id ?? undefined,
    providerSessionId: message.sdk_session_id ?? undefined,
    createdAt: message.created_at,
    content: message.content,
  });
}

function isReplayableStoredMessage(message: Message): boolean {
  return !isRuntimeRebaseControlPrompt(message.content);
}

function isRuntimeRebaseControlPrompt(content: string): boolean {
  return content.startsWith("## Mensagem editada detectada pelo Omni") && content.includes("## Runtime session rebase");
}

function renderTranscriptMessage(input: {
  role: string;
  id: string;
  sourceMessageId?: string;
  replacesSourceMessageId?: string;
  providerSessionId?: string;
  createdAt?: string;
  content: string;
}): string {
  const attrs = [
    `role="${escapeXmlAttr(input.role)}"`,
    `id="${escapeXmlAttr(input.id)}"`,
    input.sourceMessageId ? `source_message_id="${escapeXmlAttr(input.sourceMessageId)}"` : undefined,
    input.replacesSourceMessageId
      ? `replaces_source_message_id="${escapeXmlAttr(input.replacesSourceMessageId)}"`
      : undefined,
    input.providerSessionId ? `provider_session_id="${escapeXmlAttr(input.providerSessionId)}"` : undefined,
    input.createdAt ? `created_at="${escapeXmlAttr(input.createdAt)}"` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const content = input.content.endsWith("\n") ? input.content : `${input.content}\n`;
  return `<message ${attrs}>\n${content}</message>`;
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
