import type { DeliveryBarrier } from "../delivery-barriers.js";
import type { RuntimeMessageTarget } from "../runtime/host-session.js";
import type {
  RuntimeCapabilities,
  RuntimeEffort,
  RuntimeThinking,
  RuntimeToolAccessMode,
  RuntimeUsage,
} from "../runtime/types.js";
import { logger } from "../utils/logger.js";
import { recordSessionBlob, recordSessionEvent, sha256Text, upsertSessionTurn } from "./session-trace-db.js";

const log = logger.child("session-trace:runtime");
const PREVIEW_CHARS = 240;

export interface RuntimeTraceIdentity {
  sessionKey: string;
  sessionName?: string | null;
  agentId?: string | null;
  runId?: string | null;
  turnId?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface RuntimeTraceTurnStartResult {
  turnId: string;
  startedAt: number;
  userPromptSha256: string;
  systemPromptSha256: string;
  requestBlobSha256: string;
}

export interface RuntimeTracePromptSectionMetadata {
  id: string;
  title: string;
  source: string;
  priority?: number | null;
  order?: number | null;
  chars: number;
  sha256: string;
}

export interface RuntimeTraceAdapterRequestInput extends RuntimeTraceIdentity {
  turnId: string;
  prompt: string;
  systemPrompt: string;
  systemPromptSectionMetadata?: RuntimeTracePromptSectionMetadata[];
  cwd: string;
  effort?: RuntimeEffort | null;
  thinking?: RuntimeThinking | null;
  resume: boolean;
  fork: boolean;
  providerSessionIdBefore?: string | null;
  contextId?: string | null;
  source?: RuntimeMessageTarget | null;
  deliveryBarrier?: DeliveryBarrier | null;
  taskBarrierTaskId?: string | null;
  settingSources?: string[];
  hasHooks: boolean;
  pluginNames: string[];
  mcpServerNames: string[];
  hasRemoteSpawn: boolean;
  toolAccessMode?: RuntimeToolAccessMode | null;
  capabilitySummary?: Record<string, unknown>;
  queuedMessageCount?: number;
  pendingIds?: string[];
}

export interface RuntimeTraceTerminalTurnInput extends RuntimeTraceIdentity {
  status: "complete" | "failed" | "interrupted" | "timeout" | "aborted";
  eventType: "turn.complete" | "turn.failed" | "turn.interrupted";
  error?: string | null;
  abortReason?: string | null;
  providerSessionIdAfter?: string | null;
  usage?: RuntimeUsage | null;
  costUsd?: number | null;
  responseChars?: number;
  payloadJson?: Record<string, unknown>;
  startedAt?: number | null;
  completedAt?: number;
}

export interface RuntimeTraceEventInput extends RuntimeTraceIdentity {
  eventType: string;
  eventGroup: string;
  status?: string | null;
  source?: RuntimeMessageTarget | null;
  messageId?: string | null;
  payloadJson?: unknown;
  preview?: string | null;
  error?: string | null;
  durationMs?: number | null;
  timestamp?: number;
}

export function createSessionTraceRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createSessionTraceTurnId(): string {
  return `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function summarizeRuntimeCapabilities(capabilities: RuntimeCapabilities): Record<string, unknown> {
  return {
    runtimeControl: capabilities.runtimeControl,
    dynamicTools: capabilities.dynamicTools,
    execution: capabilities.execution,
    sessionState: capabilities.sessionState,
    usage: capabilities.usage,
    tools: capabilities.tools,
    systemPrompt: capabilities.systemPrompt,
    terminalEvents: capabilities.terminalEvents,
    supportsSessionResume: capabilities.supportsSessionResume,
    supportsSessionFork: capabilities.supportsSessionFork,
    supportsPartialText: capabilities.supportsPartialText,
    supportsToolHooks: capabilities.supportsToolHooks,
    supportsHostSessionHooks: capabilities.supportsHostSessionHooks ?? false,
    supportsPlugins: capabilities.supportsPlugins,
    supportsMcpServers: capabilities.supportsMcpServers,
    supportsRemoteSpawn: capabilities.supportsRemoteSpawn,
    toolAccessRequirement: capabilities.toolAccessRequirement ?? null,
    legacyEventTopicSuffix: capabilities.legacyEventTopicSuffix ?? null,
  };
}

function sourceTraceFields(source: RuntimeMessageTarget | null | undefined) {
  return {
    sourceChannel: source?.channel,
    sourceAccountId: source?.accountId,
    sourceChatId: source?.chatId,
    sourceThreadId: source?.threadId,
    canonicalChatId: source?.canonicalChatId,
    actorType: source?.actorType,
    contactId: source?.contactId,
    actorAgentId: source?.actorAgentId,
    platformIdentityId: source?.platformIdentityId,
    rawSenderId: source?.rawSenderId,
    normalizedSenderId: source?.normalizedSenderId,
    identityConfidence: source?.identityConfidence,
    identityProvenance: source?.identityProvenance,
  };
}

export function recordRuntimeTraceEvent(input: RuntimeTraceEventInput): void {
  safeTrace("record runtime trace event", () => {
    recordSessionEvent({
      sessionKey: input.sessionKey,
      sessionName: input.sessionName,
      agentId: input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      eventType: input.eventType,
      eventGroup: input.eventGroup,
      status: input.status,
      ...sourceTraceFields(input.source),
      messageId: input.messageId ?? input.source?.sourceMessageId,
      provider: input.provider,
      model: input.model,
      payloadJson: input.payloadJson,
      preview: input.preview,
      error: input.error,
      durationMs: input.durationMs,
      timestamp: input.timestamp,
    });
  });
}

export function recordAdapterRequestTrace(input: RuntimeTraceAdapterRequestInput): RuntimeTraceTurnStartResult | null {
  return safeTrace("record adapter request trace", () => {
    const now = Date.now();
    const systemPromptSections = extractSystemPromptSections(input.systemPrompt);
    const systemPrompt = recordSessionBlob({
      kind: "system_prompt",
      contentText: input.systemPrompt,
      createdAt: now,
    });
    const userPrompt = recordSessionBlob({
      kind: "user_prompt",
      contentText: input.prompt,
      createdAt: now,
    });
    const requestPayload = {
      run_id: input.runId ?? null,
      turn_id: input.turnId,
      session_key: input.sessionKey,
      session_name: input.sessionName ?? null,
      agent_id: input.agentId ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      thinking: input.thinking ?? null,
      cwd: input.cwd,
      resume: input.resume,
      fork: input.fork,
      provider_session_id_before: input.providerSessionIdBefore ?? null,
      context_id: input.contextId ?? null,
      source: input.source ?? null,
      delivery_barrier: input.deliveryBarrier ?? null,
      task_barrier_task_id: input.taskBarrierTaskId ?? null,
      system_prompt_sha256: systemPrompt.sha256,
      system_prompt_chars: input.systemPrompt.length,
      system_prompt_sections: systemPromptSections,
      system_prompt_section_metadata:
        input.systemPromptSectionMetadata?.map((section) => normalizePromptSectionMetadata(section)) ?? [],
      user_prompt_sha256: userPrompt.sha256,
      user_prompt_chars: input.prompt.length,
      settings_sources: input.settingSources ?? [],
      has_hooks: input.hasHooks,
      plugin_count: input.pluginNames.length,
      plugin_names: input.pluginNames,
      mcp_server_names: input.mcpServerNames,
      has_remote_spawn: input.hasRemoteSpawn,
      tool_access_mode: input.toolAccessMode ?? null,
      capability_summary: input.capabilitySummary ?? {},
      queued_message_count: input.queuedMessageCount ?? null,
      pending_ids: input.pendingIds ?? [],
    };
    const request = recordSessionBlob({
      kind: "adapter_request",
      contentJson: requestPayload,
      createdAt: now,
    });
    const payloadJson = {
      ...requestPayload,
      request_blob_sha256: request.sha256,
    };

    recordSessionEvent({
      sessionKey: input.sessionKey,
      sessionName: input.sessionName,
      agentId: input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      eventType: "adapter.request",
      eventGroup: "adapter",
      status: "built",
      ...sourceTraceFields(input.source),
      messageId: input.source?.sourceMessageId,
      provider: input.provider,
      model: input.model,
      payloadJson,
      preview: previewText(input.prompt),
      timestamp: now,
      createdAt: now,
    });

    upsertSessionTurn({
      turnId: input.turnId,
      sessionKey: input.sessionKey,
      sessionName: input.sessionName,
      runId: input.runId,
      agentId: input.agentId,
      provider: input.provider,
      model: input.model,
      effort: input.effort ?? null,
      thinking: input.thinking ?? null,
      cwd: input.cwd,
      status: "running",
      resume: input.resume,
      fork: input.fork,
      providerSessionIdBefore: input.providerSessionIdBefore ?? null,
      userPromptSha256: userPrompt.sha256,
      systemPromptSha256: systemPrompt.sha256,
      requestBlobSha256: request.sha256,
      startedAt: now,
      updatedAt: now,
    });

    return {
      turnId: input.turnId,
      startedAt: now,
      userPromptSha256: userPrompt.sha256,
      systemPromptSha256: systemPrompt.sha256,
      requestBlobSha256: request.sha256,
    };
  });
}

function normalizePromptSectionMetadata(section: RuntimeTracePromptSectionMetadata): RuntimeTracePromptSectionMetadata {
  return {
    id: section.id,
    title: section.title,
    source: section.source,
    priority: section.priority ?? null,
    order: section.order ?? null,
    chars: section.chars,
    sha256: section.sha256,
  };
}

export function buildRuntimeTracePromptSectionMetadata(
  sections: Array<{ id: string; title: string; content: string; source: string; priority?: number; order?: number }>,
): RuntimeTracePromptSectionMetadata[] {
  return sections.map((section) => ({
    id: section.id,
    title: section.title,
    source: section.source,
    priority: section.priority ?? null,
    order: section.order ?? null,
    chars: section.content.length,
    sha256: sha256Text(section.content),
  }));
}

export function recordTerminalTurnTrace(input: RuntimeTraceTerminalTurnInput): void {
  safeTrace("record terminal turn trace", () => {
    const completedAt = input.completedAt ?? Date.now();
    const durationMs = input.startedAt ? completedAt - input.startedAt : undefined;
    const usage = input.usage;
    const payloadJson = {
      ...(input.payloadJson ?? {}),
      status: input.status,
      abort_reason: input.abortReason ?? null,
      provider_session_id_after: input.providerSessionIdAfter ?? null,
      usage: usage ?? null,
      cost_usd: input.costUsd ?? null,
      response_chars: input.responseChars ?? null,
    };

    recordSessionEvent({
      sessionKey: input.sessionKey,
      sessionName: input.sessionName,
      agentId: input.agentId,
      runId: input.runId,
      turnId: input.turnId,
      eventType: input.eventType,
      eventGroup: "runtime",
      status: input.status,
      provider: input.provider,
      model: input.model,
      payloadJson,
      error: input.error,
      durationMs,
      timestamp: completedAt,
      createdAt: completedAt,
    });

    if (input.turnId) {
      upsertSessionTurn({
        turnId: input.turnId,
        sessionKey: input.sessionKey,
        sessionName: input.sessionName,
        runId: input.runId,
        agentId: input.agentId,
        provider: input.provider,
        model: input.model,
        status: input.status,
        providerSessionIdAfter: input.providerSessionIdAfter ?? null,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
        costUsd: input.costUsd ?? 0,
        error: input.error ?? null,
        abortReason: input.abortReason ?? null,
        completedAt,
        updatedAt: completedAt,
      });
    }
  });
}

function extractSystemPromptSections(systemPrompt: string): string[] {
  const sections: string[] = [];
  for (const line of systemPrompt.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match?.[2]) {
      sections.push(match[2]);
    }
  }
  return sections;
}

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > PREVIEW_CHARS ? `${normalized.slice(0, PREVIEW_CHARS)}...` : normalized;
}

function safeTrace<T>(description: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (error) {
    log.warn(description, { error });
    return null;
  }
}
