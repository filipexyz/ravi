import { createHash } from "node:crypto";
import type { RuntimeLaunchPrompt } from "../message-types.js";
import {
  PROVIDER_CONTINUITY_TRANSLATION_VERSION,
  providerContinuityPortableContextSchema,
  type ProviderContinuityJsonValue,
  type ProviderContinuityPortableContext,
  type ProviderContinuityTarget,
} from "./types.js";
import { providerContinuityFingerprint, redactProviderContinuityValue } from "./events.js";

export interface PortableContextMessageInput {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  createdAt?: number | null;
}

export interface PortableContextToolInput {
  id: string;
  name: string;
  input?: unknown;
  output?: unknown;
  status: "requested" | "started" | "succeeded" | "failed" | "ambiguous";
}

export interface PortableContextAttachmentInput {
  id: string;
  reference: string;
  mediaType?: string | null;
  fingerprint?: string | null;
}

function stableMessageId(message: PortableContextMessageInput, index: number): string {
  if (message.id?.trim()) return message.id.trim();
  return `pcm_${createHash("sha256")
    .update(`${index}\u0000${message.role}\u0000${message.content}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function redactedRecord(value: Record<string, unknown> | undefined): Record<string, ProviderContinuityJsonValue> {
  const redacted = redactProviderContinuityValue(value ?? {});
  return redacted && typeof redacted === "object" && !Array.isArray(redacted) ? redacted : {};
}

export function buildProviderContinuityPortableContext(input: {
  messages: PortableContextMessageInput[];
  toolRecords?: PortableContextToolInput[];
  attachments?: PortableContextAttachmentInput[];
  safetyControls?: Record<string, unknown>;
  runtimeControls?: Record<string, unknown>;
  transformations?: ProviderContinuityPortableContext["transformations"];
  now?: number;
}): ProviderContinuityPortableContext {
  const now = input.now ?? Date.now();
  const messages = input.messages.map((message, index) => ({
    id: stableMessageId(message, index),
    role: message.role,
    content: String(redactProviderContinuityValue(message.content)),
    createdAt: message.createdAt ?? null,
  }));
  const toolRecords = (input.toolRecords ?? []).map((tool) => ({
    id: tool.id.trim(),
    name: tool.name.trim(),
    input: redactProviderContinuityValue(tool.input ?? null),
    output: redactProviderContinuityValue(tool.output ?? null),
    inputFingerprint: tool.input === undefined ? null : providerContinuityFingerprint(tool.input),
    outputFingerprint: tool.output === undefined ? null : providerContinuityFingerprint(tool.output),
    status: tool.status,
  }));
  const attachments = (input.attachments ?? []).map((attachment) => ({
    id: attachment.id.trim(),
    reference: String(redactProviderContinuityValue(attachment.reference)),
    mediaType: attachment.mediaType?.trim() || null,
    fingerprint: attachment.fingerprint ?? null,
  }));
  const contextWithoutFingerprint = {
    translationVersion: PROVIDER_CONTINUITY_TRANSLATION_VERSION,
    messages,
    toolRecords,
    attachments,
    safetyControls: redactedRecord(input.safetyControls),
    runtimeControls: redactedRecord(input.runtimeControls),
    transformations: input.transformations ?? [],
    forbiddenLosses: [] as string[],
    createdAt: now,
  };
  return providerContinuityPortableContextSchema.parse({
    ...contextWithoutFingerprint,
    fingerprint: providerContinuityFingerprint(contextWithoutFingerprint),
  });
}

export function buildProviderContinuityContextFromPrompt(input: {
  prompt: RuntimeLaunchPrompt;
  agentId: string;
  sessionName: string;
  historyMessages?: PortableContextMessageInput[];
  now?: number;
}): ProviderContinuityPortableContext {
  const sourceMessageId = input.prompt.context?.messageId ?? input.prompt.source?.sourceMessageId;
  const messages: PortableContextMessageInput[] = [
    ...(input.historyMessages ?? []),
    {
      id: sourceMessageId,
      role: "user",
      content: input.prompt.prompt,
      createdAt: input.prompt.context?.timestamp ?? input.now ?? Date.now(),
    },
  ];
  return buildProviderContinuityPortableContext({
    messages,
    safetyControls: {
      deliveryBarrier: input.prompt.deliveryBarrier ?? null,
      deliveryBarrierSource: input.prompt.deliveryBarrierSource ?? null,
      taskBarrierTaskId: input.prompt.taskBarrierTaskId ?? null,
      approvalRoutingPresent: Boolean(input.prompt._approvalSource),
    },
    runtimeControls: {
      agentId: input.agentId,
      sessionName: input.sessionName,
      observation: Boolean(input.prompt._observation),
      heartbeat: input.prompt._heartbeat === true,
      cron: input.prompt._cron === true,
      trigger: input.prompt._trigger === true,
      sessionFollowup: input.prompt._sessionFollowup === true,
    },
    transformations: messages.map((_, index) => ({
      path: `messages[${index}]`,
      action: "preserved",
      reason: "Canonical Ravi message.",
      approvedLoss: false,
    })),
    now: input.now,
  });
}

export interface ProviderContinuityContextTranslation {
  eligible: boolean;
  target: ProviderContinuityTarget;
  context: ProviderContinuityPortableContext;
  rejectionReasons: string[];
}

export function translateProviderContinuityContext(input: {
  context: ProviderContinuityPortableContext;
  target: ProviderContinuityTarget;
  unsupportedPaths?: string[];
  approvedLossPaths?: string[];
}): ProviderContinuityContextTranslation {
  const unsupported = [...new Set(input.unsupportedPaths ?? [])];
  const approved = new Set(input.approvedLossPaths ?? []);
  const forbidden: string[] = [];
  const transformations = [...input.context.transformations];

  for (const path of unsupported) {
    const isSafetyOrTool =
      path === "safetyControls" ||
      path.startsWith("safetyControls.") ||
      path === "toolRecords" ||
      path.startsWith("toolRecords.");
    const approvedLoss = approved.has(path) && !isSafetyOrTool;
    transformations.push({
      path,
      action: "dropped",
      reason: approvedLoss ? "Explicitly allowlisted compatible loss." : "Target cannot preserve required context.",
      approvedLoss,
    });
    if (!approvedLoss) forbidden.push(path);
  }

  const withoutFingerprint = {
    ...input.context,
    transformations,
    forbiddenLosses: forbidden,
  };
  const context = providerContinuityPortableContextSchema.parse({
    ...withoutFingerprint,
    fingerprint: providerContinuityFingerprint({
      ...withoutFingerprint,
      fingerprint: undefined,
    }),
  });
  return {
    eligible: forbidden.length === 0,
    target: input.target,
    context,
    rejectionReasons: forbidden.map((path) => `forbidden_context_loss:${path}`),
  };
}

export function appendProviderContinuityToolRecord(input: {
  context: ProviderContinuityPortableContext;
  tool: PortableContextToolInput;
}): ProviderContinuityPortableContext {
  const existing = input.context.toolRecords.find((record) => record.id === input.tool.id);
  const next = input.context.toolRecords.filter((record) => record.id !== input.tool.id);
  next.push({
    id: input.tool.id,
    name: input.tool.name,
    input: input.tool.input === undefined ? (existing?.input ?? null) : redactProviderContinuityValue(input.tool.input),
    output:
      input.tool.output === undefined ? (existing?.output ?? null) : redactProviderContinuityValue(input.tool.output),
    inputFingerprint:
      input.tool.input === undefined
        ? (existing?.inputFingerprint ?? null)
        : providerContinuityFingerprint(input.tool.input),
    outputFingerprint:
      input.tool.output === undefined
        ? (existing?.outputFingerprint ?? null)
        : providerContinuityFingerprint(input.tool.output),
    status: input.tool.status,
  });
  const withoutFingerprint = { ...input.context, toolRecords: next };
  return providerContinuityPortableContextSchema.parse({
    ...withoutFingerprint,
    fingerprint: providerContinuityFingerprint({ ...withoutFingerprint, fingerprint: undefined }),
  });
}

export function resumePromptFromPortableContext(context: ProviderContinuityPortableContext): string {
  const lastUserMessage = [...context.messages].reverse().find((message) => message.role === "user");
  if (!lastUserMessage) {
    throw new Error("Portable context has no canonical user message to resume.");
  }
  if (context.messages.length === 1 && context.toolRecords.length === 0 && context.attachments.length === 0) {
    return lastUserMessage.content;
  }
  const portableSnapshot = {
    translationVersion: context.translationVersion,
    messages: context.messages,
    toolRecords: context.toolRecords,
    attachments: context.attachments,
    safetyControls: context.safetyControls,
    runtimeControls: context.runtimeControls,
    transformations: context.transformations,
    forbiddenLosses: context.forbiddenLosses,
    fingerprint: context.fingerprint,
  };
  return [
    "Resume the same Ravi logical request from this redacted, host-owned portable context.",
    "Preserve message roles, tool outcomes, safety controls, and stable identifiers. Do not repeat terminal effects.",
    JSON.stringify(portableSnapshot),
    `Current user request: ${lastUserMessage.content}`,
  ].join("\n\n");
}
