import { calculateCost, prewarmPricingCatalog } from "../costs/pricing-catalog.js";
import { backfillProviderSessionId, getRecentHistory, saveMessage } from "../db.js";
import { HEARTBEAT_OK } from "../heartbeat/index.js";
import { getToolSafety } from "../hooks/tool-safety.js";
import { nats } from "../nats.js";
import { SILENT_TOKEN } from "../prompt-builder.js";
import {
  dbInsertCostEvent,
  deleteSession,
  getAnnounceCompaction,
  getSession,
  resetSession,
  updateProviderSession,
  updateRuntimeProviderState,
  updateTokens,
  type AgentConfig,
  type SessionEntry,
} from "../router/index.js";
import { recordRuntimeTraceEvent, recordTerminalTurnTrace } from "../session-trace/runtime-trace.js";
import { applyTaskSessionTtlForAgent, shouldRefreshTaskSessionTtlOnTurnComplete } from "../tasks/session-retention.js";
import { logger } from "../utils/logger.js";
import { revokeAgentRuntimeContextsForSession } from "./context-registry.js";
import {
  buildRuntimeContextRecoveryPrompt,
  classifyRuntimeContextWindowFailure,
  RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON,
} from "./context-window-recovery.js";
import { classifyRuntimeCredentialFailure } from "./credential-classifier.js";
import { mergeRuntimeCredentialSessionMetadata } from "./credential-resolver.js";
import { refreshRuntimeCredential } from "./credential-refresh.js";
import {
  completeRuntimeCredentialAttempt,
  recordRuntimeCredentialFailure,
  recordRuntimeCredentialSuccess,
} from "./credential-store.js";
import type { RuntimeCredentialFailureSignal } from "./credential-types.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import {
  LEGACY_RUNTIME_PROVIDER_ID,
  stashCurrentTurnRuntimeMessages,
  stashPendingRuntimeMessages,
  type RuntimeHostStreamingSession,
  type RuntimeUserMessage,
} from "./host-session.js";
import { resolveSessionOutputTarget } from "./session-output-target.js";
import { markRuntimeLiveIdle, updateRuntimeLiveState } from "./live-state.js";
import {
  createObservationEvent,
  deliverObservationEvents,
  getObservationDebounceMs,
  logObservationDeliveryFailure,
  type ObservationDeliveryPolicy,
  type ObservationEvent,
} from "./observation-plane.js";
import {
  markLoadedFromRaviSkillToolCall,
  mergeSkillVisibilitySnapshots,
  readSkillVisibilityFromParams,
  resetLoadedSkillVisibilitySnapshot,
} from "./skill-visibility.js";
import type {
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeEventMetadata,
  RuntimeProviderId,
  RuntimeSessionHandle,
  RuntimeSkillVisibilitySnapshot,
} from "./types.js";

const log = logger.child("bot");

const MAX_OUTPUT_LENGTH = 1000;
const MAX_TURN_FAILURE_LOG_DETAIL = 1800;
const MAX_TURN_FAILURE_RESPONSE = 320;
const PROVIDER_TURN_INACTIVITY_REASON = "provider_turn_inactive";
const USER_FACING_LIMIT_SUPPRESSION_DEFAULT_MS = 60 * 60_000;
const USER_FACING_LIMIT_SUPPRESSION_MAX_MS = 24 * 60 * 60_000;
const USER_FACING_LIMIT_SUPPRESSION_RESET_GRACE_MS = 60_000;

const userFacingRuntimeLimitSuppressions = new Map<string, number>();

export type RuntimeSafeEmit = (topic: string, data: Record<string, unknown>) => Promise<void>;

function truncateOutput(output: unknown): unknown {
  if (typeof output === "string" && output.length > MAX_OUTPUT_LENGTH) {
    return output.slice(0, MAX_OUTPUT_LENGTH) + `... [truncated]`;
  }
  if (Array.isArray(output)) {
    return output.map((item) => {
      if (item?.type === "text" && typeof item?.text === "string" && item.text.length > MAX_OUTPUT_LENGTH) {
        return {
          ...item,
          text: item.text.slice(0, MAX_OUTPUT_LENGTH) + `... [truncated]`,
        };
      }
      return item;
    });
  }
  return output;
}

function truncateLogDetail(value: unknown, maxLength = MAX_TURN_FAILURE_LOG_DETAIL): string | undefined {
  if (value === undefined || value === null) return undefined;

  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 15)}... [truncated]` : text;
}

function truncateLiveSummary(value: unknown, maxLength = 180): string | undefined {
  const text = truncateLogDetail(value, maxLength)?.replace(/\s+/g, " ").trim();
  return text || undefined;
}

function summarizeRuntimeFailureRawEvent(rawEvent?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!rawEvent) return undefined;

  const summary: Record<string, unknown> = {};
  for (const key of ["type", "subtype", "status", "error", "errors", "message", "result", "exitCode"]) {
    if (rawEvent[key] !== undefined) {
      summary[key] = truncateLogDetail(rawEvent[key]);
    }
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function headerValue(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = headerValue(item);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

function readHeaderSource(value: unknown): Record<string, string | number | undefined> | undefined {
  if (!value) return undefined;
  const out: Record<string, string | number | undefined> = {};
  const maybeIterable = value as { entries?: unknown };
  if (typeof maybeIterable.entries === "function") {
    for (const [key, raw] of maybeIterable.entries() as Iterable<[unknown, unknown]>) {
      if (typeof key !== "string") continue;
      const resolved = headerValue(raw);
      if (resolved !== undefined) out[key] = resolved;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  const maybeForEach = value as { forEach?: unknown };
  if (typeof maybeForEach.forEach === "function") {
    (maybeForEach.forEach as (callback: (raw: unknown, key: unknown) => void) => void)((raw, key) => {
      if (typeof key !== "string") return;
      const resolved = headerValue(raw);
      if (resolved !== undefined) out[key] = resolved;
    });
    return Object.keys(out).length > 0 ? out : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const [key, raw] of Object.entries(record)) {
    const resolved = headerValue(raw);
    if (resolved !== undefined) out[key] = resolved;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractRuntimeFailureHeaders(
  rawEvent?: Record<string, unknown>,
): Record<string, string | number | undefined> | undefined {
  if (!rawEvent) return undefined;
  const rawError = asRecord(rawEvent.error);
  const rawResponse = asRecord(rawEvent.response);
  const rawErrorResponse = asRecord(rawError?.response);
  const merged: Record<string, string | number | undefined> = {};
  for (const source of [
    readHeaderSource(rawEvent.headers),
    readHeaderSource(rawResponse?.headers),
    readHeaderSource(rawError?.headers),
    readHeaderSource(rawErrorResponse?.headers),
  ]) {
    if (!source) continue;
    Object.assign(merged, source);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function recordRuntimeCredentialTurnSuccess(streaming: RuntimeHostStreamingSession): void {
  const credential = streaming.currentRuntimeCredential;
  const credentialId = credential?.credentialId;
  if (!credentialId) return;
  try {
    recordRuntimeCredentialSuccess(credentialId);
    completeRuntimeCredentialAttempt(credential?.attemptId, { status: "succeeded" });
  } catch (error) {
    log.warn("Failed to record runtime credential success", { credentialId, error });
  }
}

function clearRuntimeCredentialAttempt(streaming: RuntimeHostStreamingSession, attemptId: string | undefined): void {
  if (!attemptId) return;
  if (streaming.currentRuntimeCredential?.attemptId === attemptId) {
    streaming.currentRuntimeCredential.attemptId = undefined;
  }
}

function recordRuntimeCredentialTurnFailure(input: {
  streaming: RuntimeHostStreamingSession;
  provider: RuntimeProviderId;
  model: string;
  error: string;
  rawEvent?: Record<string, unknown>;
}): RuntimeCredentialFailureSignal | undefined {
  const credential = input.streaming.currentRuntimeCredential;
  if (!credential) return undefined;
  const rawError = asRecord(input.rawEvent?.error);
  const headers = extractRuntimeFailureHeaders(input.rawEvent);
  const signal = classifyRuntimeCredentialFailure({
    runtimeProvider: input.provider,
    upstreamProvider: credential.upstreamProvider,
    model: input.model,
    credentialId: credential.credentialId,
    httpStatus: firstNumber(input.rawEvent?.status, input.rawEvent?.statusCode, rawError?.status, rawError?.statusCode),
    providerCode: firstString(input.rawEvent?.code, rawError?.code),
    providerType: firstString(input.rawEvent?.type, input.rawEvent?.subtype, rawError?.type),
    message: input.error,
    ...(headers ? { headers } : {}),
    requestId: firstString(
      input.rawEvent?.requestId,
      input.rawEvent?.request_id,
      rawError?.requestId,
      rawError?.request_id,
    ),
    source: "sdk-error",
  });

  try {
    recordRuntimeCredentialFailure(credential.credentialId, signal);
    completeRuntimeCredentialAttempt(credential.attemptId, { status: "failed", signal });
  } catch (error) {
    log.warn("Failed to record runtime credential failure", {
      credentialId: credential.credentialId,
      kind: signal.kind,
      error,
    });
  }
  return signal;
}

function buildProviderRawRuntimeEvent(
  provider: RuntimeProviderId,
  rawEvent: Record<string, unknown>,
  metadata?: RuntimeEventMetadata,
): Record<string, unknown> {
  const rawThread = asRecord(rawEvent.thread);
  const rawTurn = asRecord(rawEvent.turn);
  const rawItem = asRecord(rawEvent.item);
  const nativeEvent = firstString(metadata?.nativeEvent, rawEvent.type);
  const model = firstString(rawEvent.model, rawEvent.modelId, rawEvent.model_id);
  const modelProvider = firstString(rawEvent.modelProvider, rawEvent.model_provider);
  const threadId = firstString(metadata?.thread?.id, rawEvent.thread_id, rawEvent.threadId, rawThread?.id);
  const turnId = firstString(metadata?.turn?.id, rawEvent.turn_id, rawEvent.turnId, rawTurn?.id);
  const itemId = firstString(metadata?.item?.id, rawEvent.item_id, rawEvent.itemId, rawItem?.id);

  return {
    type: "provider.raw",
    provider,
    ...(nativeEvent ? { nativeEvent } : {}),
    ...(model ? { model } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function formatRuntimeFailureDetails(event: { error: string; rawEvent?: Record<string, unknown> }): string | undefined {
  const parts: string[] = [];
  const rawEvent = event.rawEvent;

  if (rawEvent?.type !== undefined) parts.push(`raw.type=${String(rawEvent.type)}`);
  if (rawEvent?.subtype !== undefined) parts.push(`raw.subtype=${String(rawEvent.subtype)}`);
  if (rawEvent?.status !== undefined) parts.push(`raw.status=${String(rawEvent.status)}`);

  for (const key of ["error", "errors", "message", "result"]) {
    const detail = truncateLogDetail(rawEvent?.[key]);
    if (detail) parts.push(`raw.${key}=${detail}`);
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function runtimeEventLogLevel(eventType: string): "debug" | "info" {
  return eventType === "text.delta" || eventType === "provider.raw" || eventType === "status" ? "debug" : "info";
}

function isRecoverableInterruptionFailure(event: {
  error?: string;
  recoverable?: boolean;
  rawEvent?: Record<string, unknown>;
}): boolean {
  if (event.recoverable === false) return false;

  const details = [
    event.error,
    event.rawEvent?.error,
    event.rawEvent?.errors,
    event.rawEvent?.message,
    event.rawEvent?.result,
  ]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join("\n")
    .toLowerCase();

  const hasAbortMarker =
    details.includes("request was aborted") ||
    details.includes("operation was aborted") ||
    details.includes("aborterror") ||
    details.includes("aborted by user") ||
    details.includes("process aborted");
  const hasInterruptedDiagnostic =
    details.includes("[ede_diagnostic]") &&
    details.includes("result_type=user") &&
    details.includes("last_content_type=n/a") &&
    (details.includes("stop_reason=null") || details.includes("stop_reason=tool_use"));

  return hasAbortMarker || hasInterruptedDiagnostic;
}

type UserFacingRuntimeLimitFailure = {
  kind: "session_limit";
  windowKey: string;
  expiresAt: number;
};

type UserFacingRuntimeLimitSuppressionDecision =
  | {
      suppressed: false;
      classified?: UserFacingRuntimeLimitFailure;
    }
  | {
      suppressed: true;
      classified: UserFacingRuntimeLimitFailure;
      previousExpiresAt: number;
    };

function firstNonEmptyLine(value: string): string {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function normalizeSuppressionText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractSessionLimitResetDescriptor(error: string): string | undefined {
  const firstLine = firstNonEmptyLine(error);
  const match = firstLine.match(/\breset(?:s|ting)?\s+(.+?)(?:$|[.;])/i);
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  return normalizeSuppressionText(raw.replace(/^at\s+/i, "")).slice(0, 120);
}

function parseResetDescriptorTime(descriptor: string, now: number): number | undefined {
  const match = descriptor.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return undefined;

  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return undefined;
  }

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const resetAt = new Date(now);
  resetAt.setHours(hour, minute, 0, 0);
  if (resetAt.getTime() <= now - USER_FACING_LIMIT_SUPPRESSION_RESET_GRACE_MS) {
    resetAt.setDate(resetAt.getDate() + 1);
  }
  return resetAt.getTime();
}

export function classifyUserFacingRuntimeLimitFailure(
  error: string,
  now = Date.now(),
): UserFacingRuntimeLimitFailure | undefined {
  const normalized = normalizeSuppressionText(error);
  const isExactSessionLimit = /you['’]?ve hit your session limit/i.test(error);
  const isGenericSessionLimitWithReset = /\bsession limit\b/i.test(error) && /\breset(?:s|ting)?\b/i.test(error);
  if (!isExactSessionLimit && !isGenericSessionLimitWithReset) return undefined;

  const resetDescriptor = extractSessionLimitResetDescriptor(error);
  const resetAt = resetDescriptor ? parseResetDescriptorTime(resetDescriptor, now) : undefined;
  const expiresAt = resetAt
    ? Math.min(resetAt + USER_FACING_LIMIT_SUPPRESSION_RESET_GRACE_MS, now + USER_FACING_LIMIT_SUPPRESSION_MAX_MS)
    : now + USER_FACING_LIMIT_SUPPRESSION_DEFAULT_MS;
  const windowKey = resetDescriptor
    ? `reset:${resetDescriptor}`
    : `message:${firstNonEmptyLine(normalized).slice(0, 160)}`;

  return {
    kind: "session_limit",
    windowKey,
    expiresAt,
  };
}

export function resetUserFacingRuntimeLimitSuppressionsForTest(): void {
  userFacingRuntimeLimitSuppressions.clear();
}

function pruneExpiredUserFacingRuntimeLimitSuppressions(now: number): void {
  for (const [key, expiresAt] of userFacingRuntimeLimitSuppressions.entries()) {
    if (expiresAt <= now) {
      userFacingRuntimeLimitSuppressions.delete(key);
    }
  }
}

export function shouldSuppressUserFacingRuntimeLimitFailure(input: {
  error: string;
  scope: string;
  now?: number;
}): UserFacingRuntimeLimitSuppressionDecision {
  const now = input.now ?? Date.now();
  const classified = classifyUserFacingRuntimeLimitFailure(input.error, now);
  if (!classified) return { suppressed: false };

  pruneExpiredUserFacingRuntimeLimitSuppressions(now);
  const key = `${input.scope}:${classified.kind}:${classified.windowKey}`;
  const previousExpiresAt = userFacingRuntimeLimitSuppressions.get(key);
  if (previousExpiresAt !== undefined && previousExpiresAt > now) {
    return { suppressed: true, classified, previousExpiresAt };
  }

  userFacingRuntimeLimitSuppressions.set(key, classified.expiresAt);
  return { suppressed: false, classified };
}

function buildUserFacingFailureSuppressionScope(input: {
  sessionKey: string;
  provider: RuntimeProviderId;
  source?: RuntimeHostStreamingSession["currentSource"];
}): string {
  const source = input.source;
  const outputScope = source
    ? `${source.channel}:${source.accountId ?? ""}:${source.chatId ?? source.canonicalChatId ?? ""}`
    : input.sessionKey;
  return `${input.provider}:${outputScope}`;
}

export function formatUserFacingTurnFailure(error: string): string {
  const firstLine = error
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const detail = firstLine ?? (error.trim() || "unknown error");
  const clipped =
    detail.length > MAX_TURN_FAILURE_RESPONSE
      ? `${detail.slice(0, MAX_TURN_FAILURE_RESPONSE - 15)}... [truncated]`
      : detail;
  return `Error: ${clipped}`;
}

function resolveCostTrackingModel(
  runtimeProvider: RuntimeProviderId,
  executionModel: string | null | undefined,
  configuredModel: string,
): string | null {
  const explicitModel = executionModel?.trim();
  if (explicitModel) {
    return explicitModel;
  }

  // Only the legacy Claude provider backfills the agent's configured model when
  // execution metadata omits one. Subscription-billed providers (codex) report
  // no per-token model and must not be priced against an assumed model.
  return runtimeProvider === LEGACY_RUNTIME_PROVIDER_ID ? configuredModel : null;
}

export interface RunRuntimeEventLoopOptions {
  runId: string;
  sessionName: string;
  session: SessionEntry;
  agent: AgentConfig;
  streaming: RuntimeHostStreamingSession;
  runtimeSession: RuntimeSessionHandle;
  runtimeCapabilities: RuntimeCapabilities;
  model: string;
  instanceId: string;
  defaultRuntimeProviderId: RuntimeProviderId;
  streamingSessions: Map<string, RuntimeHostStreamingSession>;
  stashedMessages: Map<string, RuntimeUserMessage[]>;
  safeEmit: RuntimeSafeEmit;
  drainPendingStarts(): void;
  restartStashedSession?(input: { sessionName: string; reason: string }): void | Promise<void>;
}

/** Process provider events from a streaming runtime session. */
export async function runRuntimeEventLoop(options: RunRuntimeEventLoopOptions): Promise<void> {
  const {
    runId,
    sessionName,
    session,
    agent,
    streaming,
    runtimeSession,
    runtimeCapabilities,
    model,
    instanceId,
    streamingSessions,
    stashedMessages,
    safeEmit,
    drainPendingStarts,
    restartStashedSession,
  } = options;
  prewarmPricingCatalog();
  const recordTraceEvent = (
    input: Omit<Parameters<typeof recordRuntimeTraceEvent>[0], "sessionKey" | "sessionName" | "agentId" | "runId">,
  ) => {
    const source = Object.prototype.hasOwnProperty.call(input, "source") ? input.source : streaming.currentSource;
    recordRuntimeTraceEvent({
      sessionKey: session.sessionKey,
      sessionName,
      agentId: agent.id,
      runId,
      ...input,
      source,
    });
  };
  const recordTerminalTraceOnce = (
    input: Omit<
      Parameters<typeof recordTerminalTurnTrace>[0],
      "sessionKey" | "sessionName" | "agentId" | "runId" | "turnId" | "provider" | "model" | "startedAt"
    >,
  ) => {
    if (!streaming.currentTraceTurnId || streaming.currentTraceTurnTerminalRecorded) {
      return;
    }
    recordTerminalTurnTrace({
      sessionKey: session.sessionKey,
      sessionName,
      agentId: agent.id,
      runId,
      turnId: streaming.currentTraceTurnId,
      provider: runtimeSession.provider,
      model,
      startedAt: streaming.currentTraceTurnStartedAt,
      ...input,
    });
    streaming.currentTraceTurnTerminalRecorded = true;
  };
  const clearTraceTurnState = () => {
    streaming.currentTraceTurnId = undefined;
    streaming.currentTraceTurnStartedAt = undefined;
    streaming.currentTraceUserPromptSha256 = undefined;
    streaming.currentTraceSystemPromptSha256 = undefined;
    streaming.currentTraceRequestBlobSha256 = undefined;
    streaming.currentTraceTurnTerminalRecorded = false;
  };

  let providerRawEventCount = 0;
  let responseText = "";
  let observationSequence = 0;
  let observedUserTurnId: string | undefined;
  let restartStashedReason: string | undefined;
  const observationEvents: ObservationEvent[] = [];
  const debouncedObservationEvents: ObservationEvent[] = [];
  let debounceObservationTimer: ReturnType<typeof setTimeout> | undefined;
  const truncateObservationPreview = (value: string, maxLength = 500): string =>
    value.length > maxLength ? `${value.slice(0, maxLength - 15)}... [truncated]` : value;

  const deliverObservationBatch = (
    events: ObservationEvent[],
    deliveryPolicies: ObservationDeliveryPolicy[],
    reason: string,
  ) => {
    if (events.length === 0) return;
    deliverObservationEvents({
      sourceSessionName: sessionName,
      sourceSession: session,
      agentId: agent.id,
      events,
      deliveryPolicies,
      runId,
    }).catch((error) =>
      logObservationDeliveryFailure(error, {
        sessionName,
        sessionKey: session.sessionKey,
        runId,
        eventCount: events.length,
        deliveryPolicies,
        reason,
      }),
    );
  };

  const drainDebouncedObservationEvents = () => {
    debounceObservationTimer = undefined;
    const batch = debouncedObservationEvents.splice(0, debouncedObservationEvents.length);
    deliverObservationBatch(batch, ["debounce"], "debounce");
  };

  const scheduleDebouncedObservationEvent = (event: ObservationEvent) => {
    const debounceMs = getObservationDebounceMs({
      sourceSessionName: sessionName,
      sourceSession: session,
      agentId: agent.id,
      eventTypes: [event.type],
    });
    if (debounceMs === null) return;
    debouncedObservationEvents.push(event);
    if (debounceObservationTimer !== undefined) {
      clearTimeout(debounceObservationTimer);
    }
    debounceObservationTimer = setTimeout(drainDebouncedObservationEvents, debounceMs);
    debounceObservationTimer.unref?.();
  };

  const pushObservationEvent = (
    type: string,
    input: {
      payload?: Record<string, unknown>;
      preview?: string;
      turnId?: string;
    } = {},
  ) => {
    const event = createObservationEvent({
      runId,
      sequence: ++observationSequence,
      type,
      turnId: input.turnId ?? streaming.currentTraceTurnId,
      preview: input.preview,
      payload: input.payload,
    });
    observationEvents.push(event);
    deliverObservationBatch([event], ["realtime"], "realtime");
    scheduleDebouncedObservationEvent(event);
  };
  const currentTurnPromptText = (): string | undefined => {
    const pendingIds = new Set(streaming.currentTurnPendingIds ?? []);
    if (pendingIds.size === 0) return undefined;
    const messages = streaming.pendingMessages.filter(
      (message) => message.pendingId && pendingIds.has(message.pendingId),
    );
    const text = messages
      .map((message) => message.message.content)
      .join("\n\n")
      .trim();
    return text || undefined;
  };
  const ensureCurrentTurnUserObservation = () => {
    const turnId = streaming.currentTraceTurnId;
    if (!turnId || observedUserTurnId === turnId) return;
    const text = currentTurnPromptText();
    if (!text) return;
    observedUserTurnId = turnId;
    pushObservationEvent("message.user", {
      turnId,
      preview: truncateObservationPreview(text),
      payload: {
        chars: text.length,
        pendingIds: streaming.currentTurnPendingIds ?? [],
      },
    });
  };
  const flushObservationEvents = (terminalType: string, payload: Record<string, unknown>) => {
    ensureCurrentTurnUserObservation();
    pushObservationEvent(terminalType, {
      payload,
      preview: terminalType,
    });
    const batch = observationEvents.splice(0, observationEvents.length);
    deliverObservationBatch(batch, ["end_of_turn"], "end_of_turn");
  };
  updateRuntimeLiveState(sessionName, {
    activity: "thinking",
    summary: "runtime active",
    agentId: agent.id,
    runId,
    provider: runtimeSession.provider,
    model,
    source: streaming.currentSource,
    skills: runtimeSession.skillVisibility?.skills,
    loadedSkills: runtimeSession.skillVisibility?.loadedSkills,
  });
  const STUCK_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
  // Tight timeout for the well-known codex bug: after we deliver a tool result,
  // codex's app-server occasionally drops the JSON-RPC callback and never asks
  // the model for the next step. The agent can't make progress until we abort.
  // 3 minutes is enough for legitimate xhigh thinking on most workloads while
  // recovering quickly from the silent hang.
  // Override via `RAVI_RUNTIME_PROVIDER_INACTIVITY_MS`.
  const PROVIDER_INACTIVITY_TIMEOUT_MS = Math.max(
    30_000,
    Number(process.env.RAVI_RUNTIME_PROVIDER_INACTIVITY_MS) || 3 * 60 * 1000,
  );
  const PROVIDER_TURN_INACTIVITY_TIMEOUT_MS = Math.max(
    1_000,
    Number(process.env.RAVI_RUNTIME_TURN_INACTIVITY_MS) || 15 * 60 * 1000,
  );
  const PROVIDER_TURN_INACTIVITY_CHECK_MS = Math.min(
    30_000,
    Math.max(1_000, Math.floor(PROVIDER_TURN_INACTIVITY_TIMEOUT_MS / 10)),
  );
  let toolStuckTimer: ReturnType<typeof setTimeout> | undefined;
  let providerInactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const clearProviderInactivityWatch = () => {
    if (providerInactivityTimer !== undefined) {
      clearTimeout(providerInactivityTimer);
      providerInactivityTimer = undefined;
    }
  };
  const armProviderInactivityWatch = () => {
    clearProviderInactivityWatch();
    providerInactivityTimer = setTimeout(() => {
      providerInactivityTimer = undefined;
      log.warn("Provider inactive after tool result — aborting session", {
        sessionName,
        timeoutMs: PROVIDER_INACTIVITY_TIMEOUT_MS,
      });
      safeEmit(`ravi.session.${sessionName}.runtime`, {
        type: "provider.inactive",
        timeoutMs: PROVIDER_INACTIVITY_TIMEOUT_MS,
        sessionName,
      }).catch(() => {});
      if (!streaming.abortController.signal.aborted) {
        streaming.internalAbortReason = "provider_inactive";
        streaming.abortController.abort();
      }
    }, PROVIDER_INACTIVITY_TIMEOUT_MS);
  };
  const clearActiveToolState = () => {
    if (toolStuckTimer !== undefined) {
      clearTimeout(toolStuckTimer);
      toolStuckTimer = undefined;
    }
    streaming.toolRunning = false;
    streaming.currentToolId = undefined;
    streaming.currentToolName = undefined;
    streaming.currentToolInput = undefined;
    streaming.toolStartTime = undefined;
    streaming.currentToolSafety = null;
  };
  const signalTurnComplete = () => {
    clearProviderInactivityWatch();
    if (streaming.onTurnComplete) {
      streaming.onTurnComplete();
      streaming.onTurnComplete = null;
    }
  };

  const emitLegacyProviderEvent = async (event: Record<string, unknown>) => {
    const legacyEventTopicSuffix = runtimeCapabilities.legacyEventTopicSuffix;
    if (!legacyEventTopicSuffix) {
      return;
    }

    // Include _source on turn-ending events so any gateway daemon can stop typing.
    // In multi-daemon mode the daemon that processes the prompt may differ from
    // the daemon that received the inbound message (which set activeTargets locally).
    const augmented =
      (event.type === "result" || event.type === "silent") && streaming.currentSource
        ? { ...event, _source: streaming.currentSource }
        : event;
    await safeEmit(`ravi.session.${sessionName}.${legacyEventTopicSuffix}`, augmented);
  };

  const emitRuntimeEvent = async (event: Record<string, unknown>) => {
    const augmented = streaming.currentSource ? { ...event, _source: streaming.currentSource } : event;
    await safeEmit(`ravi.session.${sessionName}.runtime`, augmented);
  };

  const recordProviderTurnInactivityTimeout = (idleMs: number) => {
    const currentTurnId = streaming.currentTraceTurnId;
    if (!currentTurnId || streaming.currentTraceTurnTerminalRecorded) {
      return;
    }

    log.warn("Provider turn inactive — aborting session", {
      runId,
      sessionName,
      turnId: currentTurnId,
      timeoutMs: PROVIDER_TURN_INACTIVITY_TIMEOUT_MS,
      idleMs,
    });
    safeEmit(`ravi.session.${sessionName}.runtime`, {
      type: "provider.inactive",
      reason: PROVIDER_TURN_INACTIVITY_REASON,
      timeoutMs: PROVIDER_TURN_INACTIVITY_TIMEOUT_MS,
      idleMs,
      sessionName,
      turnId: currentTurnId,
    }).catch(() => {});
    recordTraceEvent({
      turnId: currentTurnId,
      provider: runtimeSession.provider,
      model,
      eventType: "session.timeout",
      eventGroup: "session",
      status: "timeout",
      source: streaming.currentSource,
      payloadJson: {
        reason: PROVIDER_TURN_INACTIVITY_REASON,
        timeoutMs: PROVIDER_TURN_INACTIVITY_TIMEOUT_MS,
        idleMs,
        pendingMessages: streaming.pendingMessages.length,
        currentTurnPendingIds: streaming.currentTurnPendingIds ?? [],
      },
    });
    recordTerminalTraceOnce({
      status: "timeout",
      eventType: "turn.failed",
      abortReason: PROVIDER_TURN_INACTIVITY_REASON,
      error: `Provider produced no runtime events for ${PROVIDER_TURN_INACTIVITY_TIMEOUT_MS}ms.`,
      payloadJson: {
        reason: PROVIDER_TURN_INACTIVITY_REASON,
        timeoutMs: PROVIDER_TURN_INACTIVITY_TIMEOUT_MS,
        idleMs,
        autoRecovered: true,
      },
    });
    flushObservationEvents("turn.failed", {
      provider: runtimeSession.provider,
      reason: PROVIDER_TURN_INACTIVITY_REASON,
      timeoutMs: PROVIDER_TURN_INACTIVITY_TIMEOUT_MS,
      idleMs,
      autoRecovered: true,
    });
  };

  const patchLiveState = (
    input: Parameters<typeof updateRuntimeLiveState>[1],
    skillVisibility?: RuntimeSkillVisibilitySnapshot,
  ) =>
    updateRuntimeLiveState(sessionName, {
      ...input,
      ...(skillVisibility
        ? {
            skills: skillVisibility.skills,
            loadedSkills: skillVisibility.loadedSkills,
          }
        : {}),
    });

  const runtimeSkillVisibilityFromParams = (params: Record<string, unknown> | undefined) => {
    if (isRecord(params?.skillVisibility)) {
      return readSkillVisibilityFromParams(params);
    }
    if (isRecord(session.runtimeSessionParams?.skillVisibility)) {
      return readSkillVisibilityFromParams(session.runtimeSessionParams);
    }
    return runtimeSession.skillVisibility;
  };

  const refreshRuntimeSessionParamsFromDb = () => {
    const freshSession = getSession(session.sessionKey);
    if (freshSession?.runtimeSessionParams) {
      session.runtimeSessionParams = freshSession.runtimeSessionParams;
    }
  };

  const mergeRuntimeSessionParams = (
    params: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined => {
    if (!isRecord(session.runtimeSessionParams?.skillVisibility) && !isRecord(params?.skillVisibility)) {
      return params;
    }
    const storedSkillVisibility = isRecord(session.runtimeSessionParams?.skillVisibility)
      ? readSkillVisibilityFromParams(session.runtimeSessionParams)
      : undefined;
    const incomingSkillVisibility = isRecord(params?.skillVisibility)
      ? readSkillVisibilityFromParams(params)
      : undefined;
    const skillVisibility = mergeSkillVisibilitySnapshots(storedSkillVisibility, incomingSkillVisibility);
    return {
      ...(params ?? {}),
      skillVisibility,
    };
  };

  const persistRuntimeSkillVisibility = (skillVisibility: RuntimeSkillVisibilitySnapshot) => {
    const runtimeSessionParams: Record<string, unknown> = {
      ...(isRecord(session.runtimeSessionParams) ? session.runtimeSessionParams : {}),
      skillVisibility,
    };
    const persistedSessionId =
      session.runtimeSessionDisplayId ??
      session.providerSessionId ??
      session.sdkSessionId ??
      (typeof runtimeSessionParams.sessionId === "string" ? runtimeSessionParams.sessionId : undefined);

    session.runtimeSessionParams = runtimeSessionParams;
    runtimeSession.skillVisibility = skillVisibility;
    if (persistedSessionId) {
      updateProviderSession(session.sessionKey, runtimeSession.provider, persistedSessionId, {
        runtimeSessionParams,
        runtimeSessionDisplayId: session.runtimeSessionDisplayId ?? persistedSessionId,
      });
    } else {
      updateRuntimeProviderState(session.sessionKey, runtimeSession.provider, {
        runtimeSessionParams,
      });
    }
    return runtimeSessionParams;
  };

  const emitResponse = async (text: string, metadata?: RuntimeEventMetadata) => {
    const emitId = Math.random().toString(36).slice(2, 8);
    // Resolve the target chat per `.ravi/specs/sessions/attach/SPEC.md`.
    // Attach selects the chat that receives this session's external output.
    // Sentinel agents observe silently → no target.
    let resolvedTarget = undefined as ReturnType<typeof resolveSessionOutputTarget>["target"] | undefined;
    let resolvedSource: ReturnType<typeof resolveSessionOutputTarget>["source"] = "unresolved";
    if (streaming.agentMode !== "sentinel") {
      const resolution = resolveSessionOutputTarget({
        sessionKey: session.sessionKey,
        fallback: streaming.currentSource,
      });
      resolvedTarget = resolution.target;
      resolvedSource = resolution.source;
      if (!resolution.target) {
        log.warn("Response target unresolved — dropping emit", { sessionName, source: resolvedSource });
        return;
      }
    }
    log.info("Emitting response", {
      sessionName,
      emitId,
      textLen: text.length,
      targetSource: resolvedSource,
    });
    await nats.emit(`ravi.session.${sessionName}.response`, {
      response: text,
      target: resolvedTarget,
      ...(metadata ? { metadata } : {}),
      _emitId: emitId,
      _instanceId: instanceId,
      _pid: process.pid,
      _v: 2,
    });
  };

  const emitChunk = async (text: string, metadata?: RuntimeEventMetadata) => {
    await safeEmit(`ravi.session.${sessionName}.stream`, {
      chunk: text,
      ...(streaming.currentSource ? { _source: streaming.currentSource } : {}),
      ...(metadata ? { metadata } : {}),
    });
  };

  let chunkEmitTail: Promise<void> = Promise.resolve();
  const queueChunkEmit = (text: string, metadata?: RuntimeEventMetadata) => {
    chunkEmitTail = chunkEmitTail
      .catch(() => {})
      .then(() => emitChunk(text, metadata))
      .catch((error) => {
        log.warn("Failed to emit stream chunk", { sessionName, error });
      });
  };

  const runtimeEventIterator = runtimeSession.events[Symbol.asyncIterator]();
  const readNextRuntimeEvent = async (): Promise<IteratorResult<RuntimeEvent>> => {
    const nextEvent = runtimeEventIterator.next();
    let interval: ReturnType<typeof setInterval> | undefined;
    let timedOut = false;
    const timeout = new Promise<IteratorResult<RuntimeEvent>>((resolve) => {
      interval = setInterval(() => {
        if (timedOut || streaming.done || streaming.abortController.signal.aborted) return;
        if (!streaming.turnActive || streaming.toolRunning || streaming.compacting) return;

        const idleMs = Date.now() - streaming.lastActivity;
        if (idleMs < PROVIDER_TURN_INACTIVITY_TIMEOUT_MS) return;

        timedOut = true;
        recordProviderTurnInactivityTimeout(idleMs);
        stashPendingRuntimeMessages(sessionName, streaming, stashedMessages);
        restartStashedReason = PROVIDER_TURN_INACTIVITY_REASON;
        streaming.interrupted = true;
        streaming.turnActive = false;
        streaming.internalAbortReason = PROVIDER_TURN_INACTIVITY_REASON;
        clearActiveToolState();
        markRuntimeLiveIdle(sessionName, "provider turn inactive");
        signalTurnComplete();
        clearTraceTurnState();
        streaming.done = true;
        if (!streaming.abortController.signal.aborted) {
          streaming.abortController.abort();
        }
        Promise.resolve(runtimeEventIterator.return?.()).catch((error) => {
          log.warn("Failed to close inactive provider event iterator", { runId, sessionName, error });
        });
        resolve({ done: true, value: undefined as never });
      }, PROVIDER_TURN_INACTIVITY_CHECK_MS);
      interval.unref?.();
    });

    try {
      return await Promise.race([nextEvent, timeout]);
    } finally {
      if (interval) clearInterval(interval);
    }
  };

  try {
    while (!streaming.done) {
      const next = await readNextRuntimeEvent();
      if (next.done) {
        break;
      }
      const event = next.value;
      if (streaming.done) {
        break;
      }
      providerRawEventCount++;
      streaming.lastActivity = Date.now();

      // Any event from the provider counts as activity — reset the inactivity watchdog.
      // The watchdog is only armed after tool.result_delivered, so this is a no-op otherwise.
      if (providerInactivityTimer !== undefined && event.type !== "tool.result_delivered") {
        armProviderInactivityWatch();
      }

      const logLevel = runtimeEventLogLevel(event.type);
      log[logLevel]("Runtime event", {
        runId,
        seq: providerRawEventCount,
        type: event.type,
        sessionName,
      });

      if (event.type === "text.delta") {
        updateRuntimeLiveState(sessionName, {
          activity: "streaming",
          summary: truncateLiveSummary(event.text) || "streaming",
          agentId: agent.id,
          runId,
          provider: runtimeSession.provider,
          model,
          source: streaming.currentSource,
        });
        queueChunkEmit(event.text, event.metadata);
        continue;
      }

      await chunkEmitTail;

      if (event.type === "provider.raw" && event.rawEvent) {
        await emitLegacyProviderEvent(event.rawEvent);
      }

      if (event.type !== "turn.failed") {
        await emitRuntimeEvent(
          event.type === "provider.raw"
            ? buildProviderRawRuntimeEvent(runtimeSession.provider, event.rawEvent, event.metadata)
            : { ...event, provider: runtimeSession.provider },
        );
      }

      // Track compaction status - block interrupts while compacting
      if (event.type === "status") {
        const status = event.status;
        const wasCompacting = streaming.compacting;
        streaming.compacting = status === "compacting";
        const compactionChanged = streaming.compacting !== wasCompacting;
        if (status === "compacting" || compactionChanged) {
          log.info("Compaction status", {
            sessionName,
            status,
            compacting: streaming.compacting,
          });
        } else {
          log.debug("Runtime status", {
            sessionName,
            status,
            compacting: streaming.compacting,
          });
        }
        recordTraceEvent({
          turnId: streaming.currentTraceTurnId,
          provider: runtimeSession.provider,
          model,
          eventType: "runtime.status",
          eventGroup: "runtime",
          status,
          payloadJson: {
            status,
            wasCompacting,
            compacting: streaming.compacting,
            metadata: event.metadata,
          },
        });
        let statusSkillVisibility: RuntimeSkillVisibilitySnapshot | undefined;
        if (streaming.compacting && !wasCompacting) {
          // Re-read runtimeSessionParams from DB before compaction reset so any skill gate marks
          // written during this turn (by persistSkillGateVisibility) are not lost.
          refreshRuntimeSessionParamsFromDb();
          statusSkillVisibility = resetLoadedSkillVisibilitySnapshot(
            runtimeSkillVisibilityFromParams(session.runtimeSessionParams) ?? readSkillVisibilityFromParams(undefined),
          );
          persistRuntimeSkillVisibility(statusSkillVisibility);
          await emitRuntimeEvent({
            type: "skill.visibility.reset",
            provider: runtimeSession.provider,
            reason: "compact",
            skillVisibility: statusSkillVisibility,
            metadata: event.metadata,
          });
        }

        patchLiveState(
          {
            activity: streaming.compacting ? "compacting" : "thinking",
            summary: streaming.compacting ? "compacting" : "runtime active",
            agentId: agent.id,
            runId,
            provider: runtimeSession.provider,
            model,
            source: streaming.currentSource,
          },
          statusSkillVisibility,
        );

        if (getAnnounceCompaction() && streaming.currentSource && streaming.agentMode !== "sentinel") {
          if (streaming.compacting && !wasCompacting) {
            emitResponse("🧠 Compactando memória... um momento.").catch(() => {});
          } else if (!streaming.compacting && wasCompacting) {
            emitResponse("🧠 Memória compactada. Pronto pra continuar.").catch(() => {});
          }
        }
      }

      if (event.type === "tool.started") {
        streaming.lastToolFailure = undefined;
        streaming.currentTurnToolStarted = true;
        streaming.toolRunning = true;
        streaming.currentToolId = event.toolUse.id;
        streaming.currentToolName = event.toolUse.name;
        streaming.currentToolInput = event.toolUse.input;
        streaming.toolStartTime = Date.now();
        log.info("Tool started", {
          sessionName,
          tool: event.toolUse.name,
          toolId: event.toolUse.id,
        });
        // Arm stuck-tool watchdog: if tool.completed never fires within the window, abort the session.
        if (toolStuckTimer !== undefined) clearTimeout(toolStuckTimer);
        toolStuckTimer = setTimeout(() => {
          toolStuckTimer = undefined;
          const stuckTool = streaming.currentToolName ?? "unknown";
          log.warn("Tool stuck — aborting session", {
            sessionName,
            tool: stuckTool,
            timeoutMs: STUCK_TOOL_TIMEOUT_MS,
          });
          safeEmit(`ravi.session.${sessionName}.runtime`, {
            type: "tool.stuck",
            tool: stuckTool,
            timeoutMs: STUCK_TOOL_TIMEOUT_MS,
            sessionName,
          }).catch(() => {});
          if (!streaming.abortController.signal.aborted) {
            streaming.internalAbortReason = "stuck_tool";
            streaming.abortController.abort();
          }
        }, STUCK_TOOL_TIMEOUT_MS);
        streaming.currentToolSafety = getToolSafety(
          event.toolUse.name,
          (event.toolUse.input as Record<string, unknown> | undefined) ?? {},
        );
        ensureCurrentTurnUserObservation();
        pushObservationEvent("tool.start", {
          preview: event.toolUse.name,
          payload: {
            toolId: event.toolUse.id,
            toolName: event.toolUse.name,
            safety: streaming.currentToolSafety,
          },
        });
        recordTraceEvent({
          turnId: streaming.currentTraceTurnId,
          provider: runtimeSession.provider,
          model,
          eventType: "tool.start",
          eventGroup: "tool",
          status: "running",
          payloadJson: {
            toolId: event.toolUse.id,
            toolName: event.toolUse.name,
            safety: streaming.currentToolSafety,
            input: truncateOutput(event.toolUse.input),
            metadata: event.metadata,
          },
          preview: event.toolUse.name,
        });

        safeEmit(`ravi.session.${sessionName}.tool`, {
          event: "start",
          toolId: event.toolUse.id,
          toolName: event.toolUse.name,
          safety: streaming.currentToolSafety,
          input: truncateOutput(event.toolUse.input),
          timestamp: new Date().toISOString(),
          sessionName,
          agentId: agent.id,
          metadata: event.metadata,
        }).catch((err) => log.warn("Failed to emit tool start", { error: err }));
        updateRuntimeLiveState(sessionName, {
          activity: "thinking",
          summary: `${event.toolUse.name} running`,
          agentId: agent.id,
          runId,
          provider: runtimeSession.provider,
          model,
          toolName: event.toolUse.name,
          source: streaming.currentSource,
        });
        continue;
      }

      // Handle assistant messages
      if (event.type === "assistant.message") {
        streaming.lastToolFailure = undefined;
        let messageText = event.text;
        if (messageText) {
          // Strip @@SILENT@@ from anywhere in the text and trim
          messageText = messageText
            .replace(new RegExp(SILENT_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "")
            .trim();
          log.info("Assistant message", {
            runId,
            interrupted: streaming.interrupted,
            text: messageText.slice(0, 100),
          });

          if (streaming.interrupted) {
            // Turn was interrupted - discard response
            log.info("Discarding interrupted response", {
              sessionName,
              textLen: messageText.length,
            });
          } else if (!messageText) {
            // After stripping SILENT_TOKEN, nothing left
            log.info("Silent response (stripped)", { sessionName });
            await emitLegacyProviderEvent({ type: "silent" });
            await emitRuntimeEvent({
              type: "silent",
              provider: runtimeSession.provider,
            });
          } else {
            responseText += messageText;
            ensureCurrentTurnUserObservation();
            pushObservationEvent("message.assistant", {
              preview: truncateObservationPreview(messageText),
              payload: {
                chars: messageText.length,
                metadata: event.metadata ?? null,
              },
            });
            recordTraceEvent({
              turnId: streaming.currentTraceTurnId,
              provider: runtimeSession.provider,
              model,
              eventType: "assistant.message",
              eventGroup: "response",
              status: "received",
              payloadJson: {
                chars: messageText.length,
                metadata: event.metadata,
              },
              preview: messageText,
            });

            const trimmed = messageText.trim().toLowerCase();
            if (trimmed === "prompt is too long") {
              log.warn("Prompt too long - will auto-reset session", {
                sessionName,
              });
              streaming._promptTooLong = true;
              await emitLegacyProviderEvent({ type: "silent" });
              await emitRuntimeEvent({
                type: "silent",
                provider: runtimeSession.provider,
              });
            } else if (messageText.trim().endsWith(HEARTBEAT_OK)) {
              log.info("Heartbeat OK", { sessionName });
              await emitLegacyProviderEvent({ type: "silent" });
              await emitRuntimeEvent({
                type: "silent",
                provider: runtimeSession.provider,
              });
            } else if (
              trimmed === "no response requested." ||
              trimmed === "no response requested" ||
              trimmed === "no response needed." ||
              trimmed === "no response needed"
            ) {
              log.info("Silent response (no response requested)", {
                sessionName,
              });
              await emitLegacyProviderEvent({ type: "silent" });
              await emitRuntimeEvent({
                type: "silent",
                provider: runtimeSession.provider,
              });
            } else {
              updateRuntimeLiveState(sessionName, {
                activity: "streaming",
                summary: truncateLiveSummary(messageText) || "response",
                agentId: agent.id,
                runId,
                provider: runtimeSession.provider,
                model,
                source: streaming.currentSource,
              });
              await emitResponse(messageText, event.metadata);
            }
          }
        }
        continue;
      }

      // Handle tool results
      if (event.type === "tool.result_delivered") {
        // Tool handler finished and result was sent to the runtime provider.
        // The provider is now responsible (model thinking). Clear the stuck-tool watchdog.
        if (toolStuckTimer !== undefined) {
          clearTimeout(toolStuckTimer);
          toolStuckTimer = undefined;
        }
        // Arm provider inactivity watchdog: catches cases where the provider
        // (e.g. codex's API call to OpenAI) hangs silently with no further events.
        armProviderInactivityWatch();
      }

      if (event.type === "tool.completed") {
        const durationMs = streaming.toolStartTime ? Date.now() - streaming.toolStartTime : undefined;
        const toolId = streaming.currentToolId ?? event.toolUseId ?? "unknown";
        const toolName = streaming.currentToolName ?? event.toolName ?? "unknown";
        const toolInput = streaming.currentToolInput;
        const output = truncateOutput(event.content);
        ensureCurrentTurnUserObservation();
        pushObservationEvent("tool.end", {
          preview: toolName,
          payload: {
            toolId,
            toolName,
            isError: event.isError ?? false,
            durationMs,
          },
        });
        recordTraceEvent({
          turnId: streaming.currentTraceTurnId,
          provider: runtimeSession.provider,
          model,
          eventType: "tool.end",
          eventGroup: "tool",
          status: event.isError ? "failed" : "complete",
          durationMs,
          payloadJson: {
            toolId,
            toolName,
            output,
            isError: event.isError ?? false,
            metadata: event.metadata,
          },
          preview: toolName,
        });

        safeEmit(`ravi.session.${sessionName}.tool`, {
          event: "end",
          toolId,
          toolName,
          output,
          isError: event.isError ?? false,
          durationMs,
          timestamp: new Date().toISOString(),
          sessionName,
          agentId: agent.id,
          metadata: event.metadata,
        }).catch((err) => log.warn("Failed to emit tool end", { error: err }));
        updateRuntimeLiveState(sessionName, {
          activity: event.isError ? "blocked" : "thinking",
          summary: event.isError ? `${toolName} failed` : `${toolName} completed`,
          agentId: agent.id,
          runId,
          provider: runtimeSession.provider,
          model,
          toolName,
          source: streaming.currentSource,
        });

        if (!event.isError) {
          const previousSkillVisibility =
            runtimeSkillVisibilityFromParams(session.runtimeSessionParams) ?? readSkillVisibilityFromParams(undefined);
          const nextSkillVisibility = markLoadedFromRaviSkillToolCall(previousSkillVisibility, {
            provider: runtimeSession.provider,
            toolName,
            toolInput,
            output: event.content,
            metadata: event.metadata,
          });
          if (nextSkillVisibility !== previousSkillVisibility) {
            persistRuntimeSkillVisibility(nextSkillVisibility);
            patchLiveState(
              {
                activity: "thinking",
                summary: `${toolName} completed`,
                agentId: agent.id,
                runId,
                provider: runtimeSession.provider,
                model,
                toolName,
                source: streaming.currentSource,
              },
              nextSkillVisibility,
            );
            recordTraceEvent({
              turnId: streaming.currentTraceTurnId,
              provider: runtimeSession.provider,
              model,
              eventType: "skill.visibility.loaded",
              eventGroup: "runtime",
              status: "complete",
              payloadJson: {
                toolId,
                toolName,
                loadedSkills: nextSkillVisibility.loadedSkills,
                skillVisibility: nextSkillVisibility,
                metadata: event.metadata,
              },
              preview: nextSkillVisibility.loadedSkills.join(", "),
            });
            await emitRuntimeEvent({
              type: "skill.visibility.loaded",
              provider: runtimeSession.provider,
              skillVisibility: nextSkillVisibility,
              loadedSkills: nextSkillVisibility.loadedSkills,
              metadata: event.metadata,
            });
          }
        }

        streaming.lastToolFailure = event.isError
          ? {
              at: Date.now(),
              toolId,
              toolName,
              output,
              metadata: event.metadata,
            }
          : undefined;
        clearActiveToolState();

        // Execute deferred abort now that unsafe tool has completed
        if (streaming.pendingAbort) {
          if (streaming.pendingMessages.length > 0) {
            log.info("Stashing aborted messages (deferred)", {
              sessionName,
              count: streaming.pendingMessages.length,
            });
            stashedMessages.set(
              sessionName,
              streaming.pendingMessages.map((message) => ({ ...message })),
            );
          }
          log.info("Executing deferred abort after unsafe tool completed", {
            sessionName,
          });
          streaming.internalAbortReason = streaming.internalAbortReason ?? "deferred_abort";
          recordTraceEvent({
            turnId: streaming.currentTraceTurnId,
            provider: runtimeSession.provider,
            model,
            eventType: "session.abort",
            eventGroup: "session",
            status: "requested",
            source: streaming.currentSource,
            payloadJson: {
              reason: streaming.internalAbortReason,
              deferred: true,
              toolCompleted: true,
            },
          });
          recordTerminalTraceOnce({
            status: "aborted",
            eventType: "turn.interrupted",
            abortReason: streaming.internalAbortReason,
            payloadJson: {
              reason: streaming.internalAbortReason,
              deferred: true,
            },
          });
          revokeAgentRuntimeContextsForSession(session.sessionKey, {
            reason: streaming.internalAbortReason,
          });
          streaming.abortController.abort();
          if (streamingSessions.delete(sessionName)) {
            drainPendingStarts();
          }
        }
        continue;
      }

      // Handle result (turn complete - save and wait for next message)
      if (event.type === "turn.complete") {
        const inputTokens = event.usage.inputTokens;
        const outputTokens = event.usage.outputTokens;
        const cacheRead = event.usage.cacheReadTokens ?? 0;
        const cacheCreation = event.usage.cacheCreationTokens ?? 0;

        log.info("Turn complete", {
          runId,
          interrupted: streaming.interrupted,
          total: inputTokens + cacheRead + cacheCreation,
          new: inputTokens,
          cached: cacheRead,
          written: cacheCreation,
          output: outputTokens,
          sessionId: event.session?.displayId ?? event.providerSessionId,
        });
        const completedCredentialAttemptId = streaming.currentRuntimeCredential?.attemptId;
        recordRuntimeCredentialTurnSuccess(streaming);

        const runtimeSessionDisplayId = event.session?.displayId ?? event.providerSessionId;
        // Skill gates can be persisted by the Codex Bash hook in a separate process.
        // Refresh before merging the provider's terminal snapshot so those marks survive turn.complete.
        refreshRuntimeSessionParamsFromDb();
        const runtimeSessionParams = mergeRuntimeCredentialSessionMetadata(
          mergeRuntimeSessionParams(event.session?.params ?? undefined),
          streaming.currentRuntimeCredential,
        );
        const terminalSkillVisibility = runtimeSkillVisibilityFromParams(runtimeSessionParams);
        const persistedSessionId =
          runtimeSessionDisplayId ??
          (typeof runtimeSessionParams?.sessionId === "string" ? runtimeSessionParams.sessionId : undefined);

        if (persistedSessionId) {
          updateProviderSession(session.sessionKey, runtimeSession.provider, persistedSessionId, {
            runtimeSessionParams,
            runtimeSessionDisplayId,
          });
          backfillProviderSessionId(sessionName, persistedSessionId);
          session.runtimeSessionParams = runtimeSessionParams;
          session.runtimeSessionDisplayId = runtimeSessionDisplayId ?? persistedSessionId;
          session.providerSessionId = runtimeSessionDisplayId ?? persistedSessionId;
          session.sdkSessionId = runtimeSessionDisplayId ?? persistedSessionId;
          session.runtimeProvider = runtimeSession.provider;
        }
        clearRuntimeCredentialAttempt(streaming, completedCredentialAttemptId);
        updateTokens(session.sessionKey, inputTokens, outputTokens);

        const executionModel = resolveCostTrackingModel(runtimeSession.provider, event.execution?.model, model);
        const cost = executionModel
          ? calculateCost(executionModel, {
              inputTokens,
              outputTokens,
              cacheRead,
              cacheCreation,
            })
          : null;
        const resolvedCost = cost ? await cost : null;
        if (resolvedCost && executionModel) {
          dbInsertCostEvent({
            sessionKey: session.sessionKey,
            agentId: agent.id,
            model: executionModel,
            inputTokens,
            outputTokens,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
            inputCostUsd: resolvedCost.inputCost,
            outputCostUsd: resolvedCost.outputCost,
            cacheCostUsd: resolvedCost.cacheCost,
            totalCostUsd: resolvedCost.totalCost,
            pricingStatus: resolvedCost.pricingStatus,
            pricingSource: resolvedCost.pricing?.source ?? null,
            pricingSourceUrl: resolvedCost.pricing?.sourceUrl ?? null,
            pricingSourceVersion: resolvedCost.pricing?.sourceVersion ?? null,
            pricingFetchedAt: resolvedCost.pricing?.fetchedAt ?? null,
            pricingModel: resolvedCost.pricing?.model ?? null,
            pricingError: resolvedCost.pricingError ?? null,
            createdAt: Date.now(),
          });
        }
        recordTerminalTraceOnce({
          status: "complete",
          eventType: "turn.complete",
          providerSessionIdAfter: persistedSessionId ?? event.providerSessionId ?? null,
          usage: event.usage,
          costUsd: resolvedCost?.totalCost ?? null,
          responseChars: responseText.trim().length,
          payloadJson: {
            execution: event.execution ?? null,
            session: event.session ?? null,
            metadata: event.metadata ?? null,
            pricing:
              resolvedCost?.pricingStatus === "priced"
                ? {
                    status: resolvedCost.pricingStatus,
                    source: resolvedCost.pricing?.source ?? null,
                    model: resolvedCost.pricing?.model ?? null,
                    sourceVersion: resolvedCost.pricing?.sourceVersion ?? null,
                    fetchedAt: resolvedCost.pricing?.fetchedAt ?? null,
                    stale: resolvedCost.pricing?.stale ?? null,
                  }
                : { status: resolvedCost?.pricingStatus ?? "skipped", error: resolvedCost?.pricingError ?? null },
            promptTooLongReset: streaming._promptTooLong ?? false,
          },
        });
        flushObservationEvents("turn.complete", {
          provider: runtimeSession.provider,
          usage: event.usage,
          costUsd: resolvedCost?.totalCost ?? null,
          responseChars: responseText.trim().length,
          providerSessionIdAfter: persistedSessionId ?? event.providerSessionId ?? null,
          promptTooLongReset: streaming._promptTooLong ?? false,
        });
        if (
          shouldRefreshTaskSessionTtlOnTurnComplete({
            sessionName,
            taskBarrierTaskId: streaming.currentTaskBarrierTaskId,
          })
        ) {
          applyTaskSessionTtlForAgent(session, agent.id, { source: "runtime.turn.complete" });
        }

        // Auto-reset session when prompt is too long (compact failed)
        if (streaming._promptTooLong) {
          log.warn("Auto-resetting session due to 'Prompt is too long'", {
            sessionName,
          });
          revokeAgentRuntimeContextsForSession(session.sessionKey, {
            reason: "prompt_too_long_reset",
          });
          deleteSession(session.sessionKey);
          streaming._promptTooLong = false;

          // Notify the user that the session was reset (skip for sentinel)
          if (streaming.currentSource && streaming.agentMode !== "sentinel") {
            nats
              .emit("ravi.outbound.deliver", {
                channel: streaming.currentSource.channel,
                accountId: streaming.currentSource.accountId,
                to: streaming.currentSource.chatId,
                text: "⚠️ Sessão resetada (contexto estourou). Pode mandar de novo.",
              })
              .catch((err) => log.warn("Failed to notify session reset", { error: err }));
          }

          // Abort the streaming session so next message creates a fresh one
          streaming.internalAbortReason = "prompt_too_long_reset";
          streaming.abortController.abort();
        }

        if (!streaming.interrupted && responseText.trim()) {
          const sdkId = event.providerSessionId;
          saveMessage(sessionName, "assistant", responseText.trim(), sdkId, {
            agentId: streaming.agentId,
            channel: streaming.currentSource?.channel,
            accountId: streaming.currentSource?.accountId,
            chatId: streaming.currentSource?.chatId,
            sourceMessageId: streaming.currentSource?.sourceMessageId,
          });
        }

        // Reset for next turn
        responseText = "";
        clearActiveToolState();
        streaming.compacting = false;
        streaming.lastToolFailure = undefined;
        streaming.pendingAbort = false;
        streaming.currentTurnToolStarted = false;
        streaming.turnActive = false;
        clearTraceTurnState();
        patchLiveState(
          {
            activity: "idle",
            summary: "turn complete",
            agentId: agent.id,
            runId,
            provider: runtimeSession.provider,
            model,
            source: streaming.currentSource,
          },
          terminalSkillVisibility,
        );

        // Signal generator to continue (it will clear or keep queue based on interrupted flag)
        signalTurnComplete();
        continue;
      }

      if (event.type === "turn.interrupted") {
        log.info("Turn interrupted", { runId, sessionName });
        recordTerminalTraceOnce({
          status: "interrupted",
          eventType: "turn.interrupted",
          abortReason: streaming.internalAbortReason ?? "provider_interrupted",
          payloadJson: {
            metadata: event.metadata ?? null,
            rawEvent: summarizeRuntimeFailureRawEvent(event.rawEvent) ?? null,
          },
        });
        flushObservationEvents("turn.interrupt", {
          provider: runtimeSession.provider,
          reason: streaming.internalAbortReason ?? "provider_interrupted",
          metadata: event.metadata ?? null,
        });
        streaming.interrupted = true;
        responseText = "";
        clearActiveToolState();
        streaming.compacting = false;
        streaming.lastToolFailure = undefined;
        streaming.currentTurnToolStarted = false;
        streaming.turnActive = false;
        clearTraceTurnState();
        markRuntimeLiveIdle(sessionName, "turn interrupted");
        signalTurnComplete();
        continue;
      }

      if (event.type === "turn.failed") {
        const interruptedRecoverable = streaming.interrupted && isRecoverableInterruptionFailure(event);
        const internalAbortReason = streaming.internalAbortReason;
        const internalRecoverable = Boolean(internalAbortReason) && isRecoverableInterruptionFailure(event);
        const suppressedRecoverable = interruptedRecoverable || internalRecoverable;
        const rawEventSummary = summarizeRuntimeFailureRawEvent(event.rawEvent);
        const currentTurnHadToolStarted = streaming.currentTurnToolStarted === true;
        const credentialFailureSignal = !suppressedRecoverable
          ? recordRuntimeCredentialTurnFailure({
              streaming,
              provider: runtimeSession.provider,
              model,
              error: event.error,
              rawEvent: event.rawEvent,
            })
          : undefined;
        const failedCredentialAttemptId = streaming.currentRuntimeCredential?.attemptId;
        log[suppressedRecoverable ? "info" : "warn"](
          suppressedRecoverable ? "Turn interrupted by recoverable runtime failure" : "Turn failed",
          {
            runId,
            sessionName,
            recoverable: event.recoverable ?? true,
            internalAbortReason,
            error: event.error,
            failureDetails: formatRuntimeFailureDetails(event),
            rawEvent: rawEventSummary,
          },
        );

        if (suppressedRecoverable) {
          await emitRuntimeEvent({
            type: "turn.interrupted",
            provider: runtimeSession.provider,
            reason: internalAbortReason ?? "recoverable_interrupt_failure",
            rawEvent: event.rawEvent,
            metadata: event.metadata,
          });
          recordTerminalTraceOnce({
            status: "interrupted",
            eventType: "turn.interrupted",
            abortReason: internalAbortReason ?? "recoverable_interrupt_failure",
            error: null,
            payloadJson: {
              recoverable: event.recoverable ?? true,
              suppressedRecoverable,
              failureDetails: formatRuntimeFailureDetails(event) ?? null,
              rawEvent: rawEventSummary ?? null,
              metadata: event.metadata ?? null,
            },
          });
          flushObservationEvents("turn.interrupt", {
            provider: runtimeSession.provider,
            recoverable: event.recoverable ?? true,
            suppressedRecoverable,
            error: null,
            abortReason: internalAbortReason ?? "recoverable_interrupt_failure",
          });
        }

        responseText = "";
        clearActiveToolState();
        streaming.compacting = false;
        streaming.lastToolFailure = undefined;
        streaming.pendingAbort = false;
        streaming.turnActive = false;
        streaming.internalAbortReason = undefined;

        if (suppressedRecoverable) {
          const restartReason = internalAbortReason ?? "recoverable_interrupt_failure";
          markRuntimeLiveIdle(sessionName, "turn interrupted");
          log.info("Suppressing recoverable interrupted turn failure", {
            runId,
            sessionName,
            internalAbortReason: restartReason,
            error: event.error,
          });
          // End the session instead of `continue`: claude-code can wedge after
          // an interrupt-during-tool_use (`[ede_diagnostic] stop_reason=tool_use`).
          // Subsequent prompts to the wedged subprocess silently no-op while the
          // dispatch queue keeps growing. Closing here forces a fresh SDK spawn
          // immediately; preserve queued/current messages so the next session
          // can drain them instead of losing the interrupted turn.
          stashPendingRuntimeMessages(sessionName, streaming, stashedMessages);
          restartStashedReason = restartReason;
          signalTurnComplete();
          clearTraceTurnState();
          streaming.done = true;
          break;
        }

        if (credentialFailureSignal?.retryableByCredential) {
          const restartReason = `runtime_credential_${credentialFailureSignal.kind}`;
          if (currentTurnHadToolStarted) {
            log.info("Skipping runtime credential retry after tool activity", {
              runId,
              sessionName,
              credentialId: streaming.currentRuntimeCredential?.credentialId,
              kind: credentialFailureSignal.kind,
            });
          } else {
            const stashedCount = stashCurrentTurnRuntimeMessages(sessionName, streaming, stashedMessages);
            if (stashedCount > 0 && streaming.currentRuntimeCredential?.credentialId) {
              try {
                await refreshRuntimeCredential(streaming.currentRuntimeCredential.credentialId, {
                  reason: "retryable_failure",
                });
              } catch (error) {
                log.warn("Runtime credential refresh after failure failed", {
                  runId,
                  sessionName,
                  credentialId: streaming.currentRuntimeCredential.credentialId,
                  error,
                });
              }
              restartStashedReason = restartReason;
              log.info("Closing runtime after retryable credential failure", {
                runId,
                sessionName,
                credentialId: streaming.currentRuntimeCredential.credentialId,
                kind: credentialFailureSignal.kind,
                pendingMessages: streaming.pendingMessages.length,
                stashedMessages: stashedCount,
              });
              streaming.currentTurnToolStarted = false;
              signalTurnComplete();
              clearTraceTurnState();
              streaming.done = true;
              break;
            }
            log.warn("Skipping runtime credential retry because current turn messages are unavailable", {
              runId,
              sessionName,
              credentialId: streaming.currentRuntimeCredential?.credentialId,
              kind: credentialFailureSignal.kind,
            });
          }
        }

        const contextWindowFailure = classifyRuntimeContextWindowFailure({
          runtimeProvider: runtimeSession.provider,
          error: event.error,
          rawEvent: event.rawEvent,
        });
        if (contextWindowFailure) {
          const history = getRecentHistory(sessionName, 48);
          const recovery = buildRuntimeContextRecoveryPrompt({
            sessionName,
            runtimeProvider: runtimeSession.provider,
            model,
            error: event.error,
            history,
          });
          const resetApplied = resetSession(session.sessionKey);
          session.sdkSessionId = undefined;
          session.providerSessionId = undefined;
          session.runtimeProvider = undefined;
          session.runtimeSessionDisplayId = undefined;
          session.runtimeSessionParams = undefined;
          revokeAgentRuntimeContextsForSession(session.sessionKey, {
            reason: RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON,
          });
          const recoveredMessage = createQueuedRuntimeUserMessage({
            prompt: recovery.prompt,
            deliveryBarrier: "after_tool",
            deliveryBarrierSource: "inferred",
            source: streaming.currentSource,
            taskBarrierTaskId: streaming.currentTaskBarrierTaskId,
            _agentId: agent.id,
            _runtimeProviderId: runtimeSession.provider,
          });
          stashedMessages.set(sessionName, [recoveredMessage]);
          restartStashedReason = RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON;

          log.warn("Recovering runtime after context window exhaustion", {
            runId,
            sessionName,
            provider: runtimeSession.provider,
            model,
            matched: contextWindowFailure.matched,
            confidence: contextWindowFailure.confidence,
            resetApplied,
            historyMessages: history.length,
            recoveryPromptChars: recovery.chars,
          });
          recordTerminalTraceOnce({
            status: "failed",
            eventType: "turn.failed",
            abortReason: RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON,
            error: truncateLogDetail(event.error),
            payloadJson: {
              recoverable: event.recoverable ?? true,
              autoRecovered: true,
              matched: contextWindowFailure.matched,
              confidence: contextWindowFailure.confidence,
              failureDetails: formatRuntimeFailureDetails(event) ?? null,
              rawEvent: rawEventSummary ?? null,
              metadata: event.metadata ?? null,
            },
          });
          recordTraceEvent({
            turnId: streaming.currentTraceTurnId,
            provider: runtimeSession.provider,
            model,
            eventType: "session.context_window_exhausted",
            eventGroup: "session",
            status: "recovering",
            source: streaming.currentSource,
            payloadJson: {
              reason: RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON,
              resetApplied,
              matched: contextWindowFailure.matched,
              confidence: contextWindowFailure.confidence,
              historyMessages: history.length,
              recoveryPromptChars: recovery.chars,
              recoveryMessageCount: recovery.messageCount,
              recoveryTruncated: recovery.truncated,
              currentTurnHadToolStarted,
            },
          });
          updateRuntimeLiveState(sessionName, {
            activity: "thinking",
            summary: "recovering context",
            agentId: agent.id,
            runId,
            provider: runtimeSession.provider,
            model,
            source: streaming.currentSource,
          });
          streaming.currentTurnToolStarted = false;
          streaming.internalAbortReason = RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON;
          streaming.interrupted = true;
          clearRuntimeCredentialAttempt(streaming, failedCredentialAttemptId);
          signalTurnComplete();
          clearTraceTurnState();
          streaming.done = true;
          break;
        }

        await emitRuntimeEvent({
          ...event,
          provider: runtimeSession.provider,
        });
        recordTerminalTraceOnce({
          status: "failed",
          eventType: "turn.failed",
          abortReason: null,
          error: event.error,
          payloadJson: {
            recoverable: event.recoverable ?? true,
            suppressedRecoverable,
            failureDetails: formatRuntimeFailureDetails(event) ?? null,
            rawEvent: rawEventSummary ?? null,
            metadata: event.metadata ?? null,
          },
        });
        flushObservationEvents("turn.failed", {
          provider: runtimeSession.provider,
          recoverable: event.recoverable ?? true,
          suppressedRecoverable,
          error: event.error,
          abortReason: null,
        });
        clearTraceTurnState();

        streaming.currentTurnToolStarted = false;
        clearRuntimeCredentialAttempt(streaming, failedCredentialAttemptId);

        if (streaming.agentMode !== "sentinel") {
          const suppression = shouldSuppressUserFacingRuntimeLimitFailure({
            error: event.error,
            scope: buildUserFacingFailureSuppressionScope({
              sessionKey: session.sessionKey,
              provider: runtimeSession.provider,
              source: streaming.currentSource,
            }),
          });
          if (suppression.suppressed) {
            log.info("Suppressing repeated user-facing runtime limit failure", {
              runId,
              sessionName,
              provider: runtimeSession.provider,
              windowKey: suppression.classified.windowKey,
              previousExpiresAt: suppression.previousExpiresAt,
            });
          } else {
            await emitResponse(formatUserFacingTurnFailure(event.error));
          }
        }
        updateRuntimeLiveState(sessionName, {
          activity: "blocked",
          summary: truncateLiveSummary(event.error) || "turn failed",
          agentId: agent.id,
          runId,
          provider: runtimeSession.provider,
          model,
          source: streaming.currentSource,
        });

        signalTurnComplete();
      }
    }
  } finally {
    log.info("Streaming session ended", { runId, sessionName });

    clearProviderInactivityWatch();
    if (toolStuckTimer !== undefined) {
      clearTimeout(toolStuckTimer);
      toolStuckTimer = undefined;
    }
    streaming.done = true;
    streaming.starting = false;
    streaming.compacting = false;

    // Unblock generator if it is waiting (between turns or waiting for turn complete)
    if (streaming.pushMessage) {
      streaming.pushMessage(null);
      streaming.pushMessage = null;
    }
    if (streaming.onTurnComplete) {
      streaming.onTurnComplete();
      streaming.onTurnComplete = null;
    }

    // Abort subprocess if still alive
    if (!streaming.abortController.signal.aborted) {
      streaming.abortController.abort();
    }

    if (streamingSessions.delete(sessionName)) {
      completeRuntimeCredentialAttempt(streaming.currentRuntimeCredential?.attemptId, {
        status: "abandoned",
        metadata: { phase: "runtime.event_loop.finally" },
      });
      if (restartStashedReason && restartStashedSession) {
        await restartStashedSession({ sessionName, reason: restartStashedReason });
      }
      drainPendingStarts();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
