import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateCost, prewarmPricingCatalog } from "../costs/pricing-catalog.js";
import { projectChannelRuntimeEvent } from "../channels/runtime-events.js";
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
import { compactionAnnouncementForTurn } from "./compaction-announcement.js";
import { classifyRuntimeCredentialFailure } from "./credential-classifier.js";
import {
  reportRuntimeIntelligenceAttemptFeedback,
  type RuntimeIntelligenceAttemptFeedbackResult,
  type RuntimeIntelligenceEffectState,
} from "./intelligence-identity-client.js";
import { mergeRuntimeCredentialSessionMetadata } from "./credential-resolver.js";
import { refreshRuntimeCredential } from "./credential-refresh.js";
import {
  completeRuntimeCredentialAttempt,
  recordRuntimeCredentialFailure,
  recordRuntimeCredentialSuccess,
} from "./credential-store.js";
import type { RuntimeCredentialFailureSignal } from "./credential-types.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { hasRuntimeTurnAttemptInputMutation, type RuntimeTurnAttemptTerminalStatus } from "./crash-recovery-store.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import {
  LEGACY_RUNTIME_PROVIDER_ID,
  getCrashRecoveryReplayablePendingRuntimeMessages,
  getRuntimeTurnReplaySafety,
  runtimeTurnAttemptTerminalEventType,
  shutdownRuntimeStreamingSession,
  stashCurrentTurnRuntimeMessages,
  stashPendingRuntimeMessages,
  type RuntimeHostStreamingSession,
  type RuntimeUserMessage,
} from "./host-session.js";
import { resolveSessionOutputTarget } from "./session-output-target.js";
import { resolveRuntimeIdleSessionTtlMs } from "./session-pool.js";
import { markRuntimeLiveIdle, updateRuntimeLiveState } from "./live-state.js";
import { formatUserFacingTurnFailure, publicRuntimeFailureDetail } from "./public-failure.js";
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
import { classifyTurnProvenance } from "./turn-provenance.js";
import { buildRuntimeToolPresentation } from "./tool-presentation.js";
import type { ResponseContentPart, ResponseMediaAttachment } from "./message-types.js";
import { createToolLivenessLease, DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS } from "./tool-liveness.js";

const log = logger.child("bot");

const MAX_OUTPUT_LENGTH = 1000;
const MAX_TURN_FAILURE_LOG_DETAIL = 1800;
const PROVIDER_INACTIVE_AFTER_TOOL_REASON = "provider_inactive";
const PROVIDER_TURN_INACTIVITY_REASON = "provider_turn_inactive";
const TOOL_INACTIVITY_REASON = "tool_inactive";
const IDLE_SESSION_TTL_REASON = "idle_session_ttl";
const RUNTIME_SESSION_CLOSE_TIMEOUT_MS = 5_000;
const USER_FACING_LIMIT_SUPPRESSION_DEFAULT_MS = 60 * 60_000;
const USER_FACING_LIMIT_SUPPRESSION_MAX_MS = 24 * 60 * 60_000;
const USER_FACING_LIMIT_SUPPRESSION_RESET_GRACE_MS = 60_000;
const GENERATED_IMAGE_ITEM_TYPE = "imageGeneration";
const GENERATED_MEDIA_FILE_PREFIX = "ravi-generated-media";
const MAX_GENERATED_MEDIA_BYTES = 50 * 1024 * 1024;

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

function appendAssistantResponse(current: string, next: string): string {
  const trimmed = next.trim();
  if (!trimmed) return current;
  return current ? `${current}\n\n${trimmed}` : trimmed;
}

function isCommentaryResponse(metadata: RuntimeEventMetadata | undefined): boolean {
  return metadata?.item?.phase === "commentary";
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

function isGeneratedImageToolCompletion(event: Extract<RuntimeEvent, { type: "tool.completed" }>): boolean {
  return event.isError !== true && event.metadata?.item?.type === GENERATED_IMAGE_ITEM_TYPE;
}

function extractGeneratedImagePayload(content: unknown): { id?: string; base64: string } | null {
  if (typeof content === "string" && content.trim()) {
    return { base64: content.trim() };
  }

  const record = asRecord(content);
  if (!record) return null;

  const base64 = firstString(record.result, record.image, record.base64, record.b64_json, record.data);
  if (!base64) return null;

  return {
    base64,
    ...(firstString(record.id, record.imageId, record.itemId)
      ? { id: firstString(record.id, record.imageId, record.itemId) }
      : {}),
  };
}

function decodeBase64ImagePayload(value: string): Buffer | null {
  const trimmed = value.trim();
  const dataUrlMatch = /^data:[^;,]+;base64,(.*)$/s.exec(trimmed);
  if (trimmed.startsWith("data:") && !dataUrlMatch) return null;
  const payload = dataUrlMatch?.[1] ?? trimmed;
  const normalized = payload.replace(/\s+/g, "");
  if (!normalized) return null;

  const estimatedBytes = Math.floor((normalized.length * 3) / 4);
  if (estimatedBytes > MAX_GENERATED_MEDIA_BYTES) return null;

  const bytes = Buffer.from(normalized, "base64");
  return bytes.byteLength > 0 && bytes.byteLength <= MAX_GENERATED_MEDIA_BYTES ? bytes : null;
}

function inferImageFormat(bytes: Buffer): { mimeType: string; extension: string } | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: "webp" };
  }
  const gifHeader = bytes.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return { mimeType: "image/gif", extension: "gif" };
  }
  return null;
}

function safeFileComponent(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

async function materializeGeneratedImageAttachment(input: {
  sessionKey: string;
  sessionName: string;
  provider: RuntimeProviderId;
  toolUseId?: string;
  content: unknown;
  metadata?: RuntimeEventMetadata;
}): Promise<ResponseMediaAttachment | null> {
  const payload = extractGeneratedImagePayload(input.content);
  if (!payload) return null;

  const bytes = decodeBase64ImagePayload(payload.base64);
  if (!bytes) return null;

  const format = inferImageFormat(bytes);
  if (!format) return null;

  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const itemId = payload.id ?? input.metadata?.item?.id ?? input.toolUseId ?? "image";
  const filename = `${GENERATED_MEDIA_FILE_PREFIX}-${safeFileComponent(input.sessionName, "session")}-${safeFileComponent(itemId, "image")}-${hash}.${format.extension}`;
  const filePath = join(tmpdir(), filename);
  await writeFile(filePath, bytes);

  return {
    type: "image",
    filePath,
    filename,
    mimeType: format.mimeType,
    idempotencyKey: `runtime.generated_media:${input.sessionKey}:${itemId}:${hash}`,
    source: "runtime.generated_media",
    metadata: {
      provider: input.provider,
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      ...(payload.id ? { providerOutputId: payload.id } : {}),
      ...(input.metadata?.item?.id ? { providerItemId: input.metadata.item.id } : {}),
    },
  };
}

function summarizeGeneratedImageToolOutput(input: {
  content: unknown;
  attachment?: ResponseMediaAttachment | null;
  metadata?: RuntimeEventMetadata;
}): Record<string, unknown> {
  const payload = extractGeneratedImagePayload(input.content);
  return {
    type: "generated_image",
    ...(input.attachment !== undefined ? { materialized: input.attachment !== null } : {}),
    ...(input.attachment
      ? {
          filename: input.attachment.filename,
          mimeType: input.attachment.mimeType,
          idempotencyKey: input.attachment.idempotencyKey,
        }
      : {}),
    ...(payload?.id ? { providerOutputId: payload.id } : {}),
    ...(input.metadata?.item?.id ? { providerItemId: input.metadata.item.id } : {}),
  };
}

function redactGeneratedImageProviderRawEvent(
  rawEvent: Record<string, unknown>,
  metadata: RuntimeEventMetadata | undefined,
): Record<string, unknown> {
  if (metadata?.item?.type !== GENERATED_IMAGE_ITEM_TYPE) return rawEvent;

  const payloadKeys = new Set(["result", "image", "base64", "b64_json", "data"]);
  const redact = (value: unknown, key?: string): unknown => {
    if (key && payloadKeys.has(key) && typeof value === "string") {
      return "[generated image payload redacted]";
    }
    if (Array.isArray(value)) return value.map((item) => redact(item));
    const record = asRecord(value);
    if (!record) return value;
    return Object.fromEntries(
      Object.entries(record).map(([nestedKey, nestedValue]) => [nestedKey, redact(nestedValue, nestedKey)]),
    );
  };

  return redact(rawEvent) as Record<string, unknown>;
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

async function recordRuntimeCredentialTurnSuccess(
  streaming: RuntimeHostStreamingSession,
  effectState: RuntimeIntelligenceEffectState,
): Promise<void> {
  const credential = streaming.currentRuntimeCredential;
  const credentialId = credential?.credentialId;
  if (!credentialId) return;
  try {
    if (credential.authMethod === "hub-proxy") {
      await reportHubIntelligenceFeedback(credential, "succeeded", effectState);
      credential.intelligenceAttemptTerminal = true;
      return;
    }
    recordRuntimeCredentialSuccess(credentialId);
    completeRuntimeCredentialAttempt(credential?.attemptId, {
      status: "succeeded",
    });
  } catch (error) {
    log.warn("Failed to record runtime credential success", {
      credentialId,
      error,
    });
  }
}

function clearRuntimeCredentialAttempt(streaming: RuntimeHostStreamingSession, attemptId: string | undefined): void {
  if (!attemptId) return;
  if (streaming.currentRuntimeCredential?.authMethod === "hub-proxy") return;
  if (streaming.currentRuntimeCredential?.attemptId === attemptId) {
    streaming.currentRuntimeCredential.attemptId = undefined;
  }
}

async function recordRuntimeCredentialTurnFailure(input: {
  streaming: RuntimeHostStreamingSession;
  provider: RuntimeProviderId;
  model: string;
  error: string;
  rawEvent?: Record<string, unknown>;
  effectState: RuntimeIntelligenceEffectState;
}): Promise<
  | {
      signal: RuntimeCredentialFailureSignal;
      hubFeedback?: RuntimeIntelligenceAttemptFeedbackResult;
    }
  | undefined
> {
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
    if (credential.authMethod === "hub-proxy") {
      const hubFeedback = await reportHubIntelligenceFeedback(
        credential,
        signal.retryableByCredential ? "credential_failed" : "provider_failed",
        input.effectState,
        signal.kind,
      );
      credential.intelligenceAttemptTerminal = true;
      return { signal, hubFeedback };
    }
    recordRuntimeCredentialFailure(credential.credentialId, signal);
    completeRuntimeCredentialAttempt(credential.attemptId, { status: "failed", signal });
  } catch (error) {
    log.warn("Failed to record runtime credential failure", {
      credentialId: credential.credentialId,
      kind: signal.kind,
      error,
    });
  }
  return { signal };
}

async function reportHubIntelligenceFeedback(
  credential: NonNullable<RuntimeHostStreamingSession["currentRuntimeCredential"]>,
  outcome: "succeeded" | "credential_failed" | "provider_failed",
  effectState: RuntimeIntelligenceEffectState,
  failureKind?: string,
): Promise<RuntimeIntelligenceAttemptFeedbackResult> {
  if (
    !credential.attemptId ||
    !credential.intelligenceGrantId ||
    !credential.intelligenceRuntimeId ||
    !credential.intelligenceSessionKey ||
    !credential.connectionId
  ) {
    throw new Error("Hub intelligence attempt is missing authoritative feedback metadata.");
  }
  return reportRuntimeIntelligenceAttemptFeedback({
    attemptId: credential.attemptId,
    grantId: credential.intelligenceGrantId,
    runtimeId: credential.intelligenceRuntimeId,
    connectionId: credential.connectionId,
    sessionKey: credential.intelligenceSessionKey,
    outcome,
    effectState,
    ...(failureKind ? { failureKind } : {}),
  });
}

function resolveIntelligenceEffectState(safety: {
  inputMutated: boolean;
  startedTool: boolean;
  materializedOutput: boolean;
}): RuntimeIntelligenceEffectState {
  if (safety.materializedOutput) return "output_materialized";
  if (safety.startedTool) return "tool_started";
  if (safety.inputMutated) return "input_mutated";
  return "none";
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

function stripRuntimeRawEvent<T extends RuntimeEvent>(event: T): T {
  const safeEvent: Record<string, unknown> = { ...event };
  delete safeEvent.rawEvent;
  if (event.type === "tool.completed" && isGeneratedImageToolCompletion(event)) {
    safeEvent.content = summarizeGeneratedImageToolOutput({
      content: event.content,
      metadata: event.metadata,
    });
  }
  return safeEvent as T;
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
  return eventType === "text.delta" ||
    eventType === "provider.raw" ||
    eventType === "status" ||
    eventType === "tool.progress"
    ? "debug"
    : "info";
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
  crashRecovery?: RuntimeCrashRecoveryCoordinator;
  model: string;
  instanceId: string;
  defaultRuntimeProviderId: RuntimeProviderId;
  streamingSessions: Map<string, RuntimeHostStreamingSession>;
  stashedMessages: Map<string, RuntimeUserMessage[]>;
  safeEmit: RuntimeSafeEmit;
  drainPendingStarts(): void;
  restartStashedSession?(input: { sessionName: string; reason: string }): void | Promise<void>;
  onToolBarrierReleased?(sessionName: string): void | Promise<void>;
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
    crashRecovery,
    model,
    instanceId,
    streamingSessions,
    stashedMessages,
    safeEmit,
    drainPendingStarts,
    restartStashedSession,
    onToolBarrierReleased,
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
  const terminalizeCurrentCrashRecoveryAttempt = (
    status: RuntimeTurnAttemptTerminalStatus,
    requestedCompletedAt?: number,
  ) => {
    if (streaming.currentCrashRecoveryTerminal) {
      return streaming.currentCrashRecoveryTerminal;
    }

    const completedAt = requestedCompletedAt ?? Date.now();
    const crashRecoveryAttemptId = streaming.currentCrashRecoveryAttemptId;
    const activeAttempt =
      crashRecoveryAttemptId && crashRecovery ? crashRecovery.getActiveTurnAttempt?.(crashRecoveryAttemptId) : null;
    let terminalAttempt = activeAttempt;
    if (!crashRecoveryAttemptId && crashRecovery?.ownershipFailure) {
      // Ownership loss means this process cannot prove a first-terminal ledger
      // write. Do not fabricate an in-memory terminal latch that could later be
      // projected or recorded as though durability had succeeded.
      return undefined;
    }
    if (!crashRecoveryAttemptId && streaming.currentTraceTurnId && crashRecovery && !crashRecovery.ownershipFailure) {
      throw new Error("Crash recovery attempt binding missing before terminal provider state");
    }
    if (crashRecoveryAttemptId) {
      if (!crashRecovery) {
        throw new Error(`Crash recovery coordinator missing for active attempt ${crashRecoveryAttemptId}`);
      }
      terminalAttempt = crashRecovery.terminalizeTurnAttempt({
        attemptId: crashRecoveryAttemptId,
        status,
        completedAt,
      });
      if (terminalAttempt.status !== status || terminalAttempt.completedAt !== completedAt) {
        throw new Error(
          `Crash recovery attempt ${crashRecoveryAttemptId} terminalized with an unexpected first-terminal state`,
        );
      }
      // Release the in-memory binding only after the terminal ledger write is durable.
      streaming.currentCrashRecoveryAttemptId = undefined;
    }
    const terminal = {
      status,
      completedAt,
      startedTool: terminalAttempt?.startedTool === true || streaming.currentTurnToolStarted === true,
      materializedOutput: terminalAttempt?.materializedOutput === true,
      inputMutated:
        (terminalAttempt ? hasRuntimeTurnAttemptInputMutation(terminalAttempt) : false) ||
        streaming.currentTurnInputMutated === true,
    };
    streaming.currentCrashRecoveryTerminal = terminal;
    return terminal;
  };
  const recordTerminalTraceOnce = (
    input: Omit<
      Parameters<typeof recordTerminalTurnTrace>[0],
      "sessionKey" | "sessionName" | "agentId" | "runId" | "turnId" | "provider" | "model" | "startedAt"
    >,
  ) => {
    const terminal = terminalizeCurrentCrashRecoveryAttempt(input.status, input.completedAt);
    if (!terminal) return;

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
      status: terminal.status,
      eventType: runtimeTurnAttemptTerminalEventType(terminal.status),
      abortReason: terminal.status === "complete" ? null : input.abortReason,
      completedAt: terminal.completedAt,
    });
    streaming.currentTraceTurnTerminalRecorded = true;
  };
  const clearTraceTurnState = () => {
    if (streaming.currentCrashRecoveryAttemptId) {
      throw new Error(
        `Cannot clear trace state while crash recovery attempt ${streaming.currentCrashRecoveryAttemptId} is running`,
      );
    }
    streaming.currentTraceTurnId = undefined;
    streaming.currentTraceTurnStartedAt = undefined;
    streaming.currentTraceUserPromptSha256 = undefined;
    streaming.currentTraceSystemPromptSha256 = undefined;
    streaming.currentTraceRequestBlobSha256 = undefined;
    streaming.currentTraceTurnTerminalRecorded = false;
  };
  const markCurrentTurnAttemptSafety = (input: { startedTool?: true; materializedOutput?: true }) => {
    const attemptId = streaming.currentCrashRecoveryAttemptId;
    if (!crashRecovery) {
      if (!attemptId) return;
      throw new Error(`Crash recovery coordinator missing for active attempt ${attemptId}`);
    }
    if (!attemptId) {
      throw new Error("Crash recovery attempt binding missing before provider side effect");
    }
    crashRecovery.markTurnAttemptSafety({ attemptId, ...input });
  };

  let providerRawEventCount = 0;
  let responseText = "";
  let channelResponseText = "";
  let pendingGeneratedMedia: ResponseMediaAttachment[] = [];
  const generatedMediaKeys = new Set<string>();
  const clearPendingGeneratedMedia = () => {
    pendingGeneratedMedia = [];
    generatedMediaKeys.clear();
  };
  const queueGeneratedMedia = (attachment: ResponseMediaAttachment): boolean => {
    const key = attachment.idempotencyKey ?? attachment.filePath;
    if (generatedMediaKeys.has(key)) return false;
    generatedMediaKeys.add(key);
    pendingGeneratedMedia.push(attachment);
    return true;
  };
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
      turn: streaming.currentTurnProvenance ?? classifyTurnProvenance({ source: streaming.currentSource }),
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
  // Tight timeout for the well-known codex bug: after we deliver a tool result,
  // codex's app-server occasionally drops the JSON-RPC callback and never asks
  // the model for the next step. The agent can't make progress until we abort.
  // 3 minutes is enough for legitimate xhigh thinking on most workloads while
  // recovering quickly from the silent hang.
  // Override via `RAVI_RUNTIME_PROVIDER_INACTIVITY_MS`.
  const PROVIDER_INACTIVITY_TIMEOUT_MS = Math.max(
    1_000,
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
  const IDLE_SESSION_TTL_MS = resolveRuntimeIdleSessionTtlMs();
  let providerInactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const toolLivenessLease = createToolLivenessLease({
    inactivityTimeoutMs: DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS,
    onInactive: (toolUseId) => {
      if (!streaming.toolRunning || streaming.currentToolId !== toolUseId) return;
      const inactiveTool = streaming.currentToolName ?? "unknown";
      log.warn("Tool inactive — aborting session", {
        sessionName,
        tool: inactiveTool,
        toolId: toolUseId,
        timeoutMs: DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS,
      });
      pushObservationEvent("tool.inactive", {
        preview: inactiveTool,
        payload: {
          toolId: toolUseId,
          toolName: inactiveTool,
          timeoutMs: DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS,
        },
      });
      safeEmit(`ravi.session.${sessionName}.runtime`, {
        type: "tool.inactive",
        reason: TOOL_INACTIVITY_REASON,
        tool: inactiveTool,
        toolId: toolUseId,
        timeoutMs: DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS,
        sessionName,
      }).catch(() => {});
      updateRuntimeLiveState(sessionName, {
        activity: "blocked",
        summary: `${inactiveTool} inactive`,
        agentId: agent.id,
        runId,
        provider: runtimeSession.provider,
        model,
        toolName: inactiveTool,
        source: streaming.currentSource,
      });
      if (!streaming.abortController.signal.aborted) {
        streaming.internalAbortReason = TOOL_INACTIVITY_REASON;
        streaming.abortController.abort();
      }
    },
  });
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
        streaming.internalAbortReason = PROVIDER_INACTIVE_AFTER_TOOL_REASON;
        streaming.abortController.abort();
      }
    }, PROVIDER_INACTIVITY_TIMEOUT_MS);
  };
  const clearIdleSessionEvictionTimer = () => {
    if (streaming.idleSessionEvictionTimer) {
      clearTimeout(streaming.idleSessionEvictionTimer);
      streaming.idleSessionEvictionTimer = undefined;
    }
  };
  const scheduleIdleSessionEviction = () => {
    if (IDLE_SESSION_TTL_MS <= 0) {
      return;
    }
    clearIdleSessionEvictionTimer();
    streaming.idleSessionEvictionTimer = setTimeout(() => {
      streaming.idleSessionEvictionTimer = undefined;
      if (
        streaming.done ||
        streaming.starting ||
        streaming.turnActive ||
        streaming.compacting ||
        streaming.toolRunning ||
        streaming.pendingMessages.length > 0
      ) {
        return;
      }

      log.info("Evicting idle runtime session", {
        runId,
        sessionName,
        timeoutMs: IDLE_SESSION_TTL_MS,
      });
      recordTraceEvent({
        provider: runtimeSession.provider,
        model,
        eventType: "session.idle_evicted",
        eventGroup: "session",
        status: "evicted",
        source: streaming.currentSource,
        payloadJson: {
          reason: IDLE_SESSION_TTL_REASON,
          timeoutMs: IDLE_SESSION_TTL_MS,
          lastActivity: streaming.lastActivity,
        },
      });
      shutdownRuntimeStreamingSession(streaming, IDLE_SESSION_TTL_REASON);
    }, IDLE_SESSION_TTL_MS);
    streaming.idleSessionEvictionTimer.unref?.();
  };
  const clearActiveToolState = () => {
    toolLivenessLease.clear();
    streaming.toolRunning = false;
    streaming.toolResultDeliveryPending = false;
    streaming.currentToolId = undefined;
    streaming.currentToolName = undefined;
    streaming.currentToolInput = undefined;
    streaming.toolStartTime = undefined;
    streaming.currentToolSafety = null;
  };
  const finishActiveToolBarrier = async () => {
    clearActiveToolState();

    if (streaming.pendingAbort) {
      if (streaming.pendingMessages.length > 0) {
        log.info("Stashing aborted messages (deferred)", {
          sessionName,
          count: streaming.pendingMessages.length,
        });
        stashPendingRuntimeMessages(sessionName, streaming, stashedMessages, { crashRecovery });
      }
      log.info("Executing deferred abort after tool barrier released", {
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
      return;
    }

    try {
      await onToolBarrierReleased?.(sessionName);
    } catch (error) {
      log.warn("Failed to release queued prompts after tool completion", {
        sessionName,
        error,
      });
    }
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
    const augmented = {
      ...event,
      ...(streaming.currentTurnProvenance ? { _turnProvenance: streaming.currentTurnProvenance } : {}),
      ...((event.type === "result" || event.type === "silent") && streaming.currentSource
        ? { _source: streaming.currentSource }
        : {}),
    };
    await safeEmit(`ravi.session.${sessionName}.${legacyEventTopicSuffix}`, augmented);
  };

  const emitRuntimeEvent = async (event: Record<string, unknown>) => {
    const augmented = {
      ...event,
      ...(streaming.currentSource ? { _source: streaming.currentSource } : {}),
      ...(streaming.currentTurnProvenance ? { _turnProvenance: streaming.currentTurnProvenance } : {}),
    };
    await safeEmit(`ravi.session.${sessionName}.runtime`, augmented);
  };

  interface PendingProviderRawEvent {
    event: Extract<RuntimeEvent, { type: "provider.raw" }>;
    safetyFenced: boolean;
  }

  const pendingProviderRawEvents: PendingProviderRawEvent[] = [];
  let suppressProviderRawForCurrentTurn = false;
  const canReleaseProviderRawEvent = () =>
    crashRecovery?.acceptingDeliveries === true && !crashRecovery.ownershipFailure;
  const removePendingProviderRawEvent = (pending: PendingProviderRawEvent) => {
    const index = pendingProviderRawEvents.indexOf(pending);
    if (index >= 0) pendingProviderRawEvents.splice(index, 1);
  };
  const releasePendingProviderRawEvent = async (pending: PendingProviderRawEvent | undefined) => {
    if (!pending) return;
    removePendingProviderRawEvent(pending);
    if (suppressProviderRawForCurrentTurn || !pending.safetyFenced || !canReleaseProviderRawEvent()) return;

    await emitLegacyProviderEvent(redactGeneratedImageProviderRawEvent(pending.event.rawEvent, pending.event.metadata));
    await emitRuntimeEvent(
      buildProviderRawRuntimeEvent(runtimeSession.provider, pending.event.rawEvent, pending.event.metadata),
    );
  };
  const settlePreviousProviderRawEvents = async () => {
    const previous = pendingProviderRawEvents.splice(0);
    for (const pending of previous) {
      // Structural lifecycle events such as item.started/item.completed/status
      // do not prove that assistant content or tool arguments crossed a durable
      // replay-safety fence. Drop their raw envelopes fail-closed.
      if (!pending.safetyFenced || suppressProviderRawForCurrentTurn || !canReleaseProviderRawEvent()) continue;
      await emitLegacyProviderEvent(
        redactGeneratedImageProviderRawEvent(pending.event.rawEvent, pending.event.metadata),
      );
      await emitRuntimeEvent(
        buildProviderRawRuntimeEvent(runtimeSession.provider, pending.event.rawEvent, pending.event.metadata),
      );
    }
  };
  const correlatePendingProviderRawEvent = (event: RuntimeEvent): PendingProviderRawEvent | undefined => {
    if (!("rawEvent" in event) || !event.rawEvent) return undefined;
    for (let index = pendingProviderRawEvents.length - 1; index >= 0; index--) {
      const pending = pendingProviderRawEvents[index];
      if (pending?.event.rawEvent !== event.rawEvent) continue;
      return pending;
    }
    return undefined;
  };
  const fencePendingProviderRawEvent = (pending: PendingProviderRawEvent | undefined) => {
    if (pending) pending.safetyFenced = true;
  };

  const projectRuntimeEventToChannel = async (event: RuntimeEvent, projectedResponseText?: string) => {
    const metadata = streaming.currentChannelBackend;
    if (!metadata) return;
    const toolProjection =
      event.type === "tool.started"
        ? {
            toolPresentation: buildRuntimeToolPresentation(event.toolUse.name, event.toolUse.input),
          }
        : event.type === "tool.completed"
          ? {
              toolPresentation: buildRuntimeToolPresentation(
                streaming.currentToolName ?? event.toolName ?? "tool",
                streaming.currentToolInput,
              ),
              ...(streaming.toolStartTime === undefined
                ? {}
                : {
                    toolDurationMs: Date.now() - streaming.toolStartTime,
                  }),
            }
          : {};
    try {
      await projectChannelRuntimeEvent({
        metadata,
        event: stripRuntimeRawEvent(event),
        ...(projectedResponseText !== undefined ? { responseText: projectedResponseText } : {}),
        ...toolProjection,
      });
    } catch (error) {
      log.warn("Channel runtime event projection failed", {
        sessionName,
        turnId: metadata.binding.turnId,
        eventType: event.type,
        errorKind: error instanceof Error ? error.name : typeof error,
      });
    }
  };

  const recordProviderTurnInactivityTimeout = (idleMs: number, autoRecovered: boolean) => {
    const currentTurnId = streaming.currentTraceTurnId;
    if ((!currentTurnId || streaming.currentTraceTurnTerminalRecorded) && !streaming.currentCrashRecoveryAttemptId) {
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
        autoRecovered,
      },
    });
    flushObservationEvents("turn.failed", {
      provider: runtimeSession.provider,
      reason: PROVIDER_TURN_INACTIVITY_REASON,
      timeoutMs: PROVIDER_TURN_INACTIVITY_TIMEOUT_MS,
      idleMs,
      autoRecovered,
    });
  };

  const recordUnterminatedTurnExit = () => {
    const currentTurnId = streaming.currentTraceTurnId;
    if (crashRecovery?.ownershipFailure && !streaming.currentCrashRecoveryAttemptId) {
      return;
    }
    if ((!currentTurnId || streaming.currentTraceTurnTerminalRecorded) && !streaming.currentCrashRecoveryAttemptId) {
      return;
    }

    const reason =
      streaming.internalAbortReason ??
      (streaming.abortController.signal.aborted ? "runtime_aborted" : "runtime_event_loop_closed");
    const timedOut =
      reason === PROVIDER_INACTIVE_AFTER_TOOL_REASON ||
      reason === PROVIDER_TURN_INACTIVITY_REASON ||
      reason === TOOL_INACTIVITY_REASON;
    const status = streaming.currentCrashRecoveryTerminal?.status ?? (timedOut ? "timeout" : "aborted");
    const eventType = runtimeTurnAttemptTerminalEventType(status);

    log.warn("Runtime event loop ended with unterminated active turn", {
      runId,
      sessionName,
      turnId: currentTurnId,
      reason,
      status,
      toolRunning: streaming.toolRunning,
      compacting: streaming.compacting,
      pendingMessages: streaming.pendingMessages.length,
      currentTurnPendingIds: streaming.currentTurnPendingIds ?? [],
    });

    recordTraceEvent({
      turnId: currentTurnId,
      provider: runtimeSession.provider,
      model,
      eventType: "session.unterminated_turn",
      eventGroup: "session",
      status,
      source: streaming.currentSource,
      payloadJson: {
        reason,
        phase: "runtime.event_loop.finally",
        activeTurn: streaming.turnActive,
        toolRunning: streaming.toolRunning,
        compacting: streaming.compacting,
        pendingMessages: streaming.pendingMessages.length,
        currentTurnPendingIds: streaming.currentTurnPendingIds ?? [],
      },
    });

    recordTerminalTraceOnce({
      status,
      eventType,
      abortReason: status === "complete" ? null : reason,
      error: timedOut ? `Runtime ended without a terminal provider event after ${reason}.` : null,
      completedAt: streaming.currentCrashRecoveryTerminal?.completedAt,
      payloadJson: {
        reason,
        phase: "runtime.event_loop.finally",
        autoRecovered: Boolean(restartStashedReason),
        providerTerminalRecorded: Boolean(streaming.currentCrashRecoveryTerminal),
      },
    });
  };

  const prepareUnterminatedTurnRecovery = () => {
    if (streaming.durableTurnPreparationFailed) {
      if (!restartStashedReason) {
        // The prompt was never yielded to the provider. Preserve it even when
        // the failed attempt write made the coordinator reject new work;
        // shutdown snapshots still need the exact original envelope.
        stashPendingRuntimeMessages(sessionName, streaming, stashedMessages, { crashRecovery });
      }
      if (restartStashedReason || !crashRecovery?.acceptingDeliveries) {
        return;
      }
      const stashedCount = stashedMessages.get(sessionName)?.length ?? 0;
      if (stashedCount === 0) {
        return;
      }
      restartStashedReason = "runtime_event_loop_closed";
      log.warn("Retrying runtime after durable turn preparation failed", {
        runId,
        sessionName,
        reason: restartStashedReason,
        stashedMessages: stashedCount,
      });
      return;
    }

    const currentTurnId = streaming.currentTraceTurnId;
    if (
      !currentTurnId ||
      streaming.currentTraceTurnTerminalRecorded ||
      streaming.currentCrashRecoveryTerminal ||
      restartStashedReason
    ) {
      return;
    }

    const reason =
      streaming.internalAbortReason ??
      (streaming.abortController.signal.aborted ? "runtime_aborted" : "runtime_event_loop_closed");

    if (reason !== "runtime_event_loop_closed") {
      return;
    }
    if (streaming.pendingMessages.length === 0 || streaming.toolRunning) {
      return;
    }

    const attemptId = streaming.currentCrashRecoveryAttemptId;
    if (!attemptId || !crashRecovery?.acceptingDeliveries) {
      return;
    }
    const activeAttempt = crashRecovery.getActiveTurnAttempt(attemptId);
    if (!activeAttempt) {
      return;
    }
    const safety = getRuntimeTurnReplaySafety(streaming, crashRecovery);
    const reconcileCurrentTurn = runtimeSession.ambiguousTurnRecoveryStrategy === "reconcile_by_client_message_id";
    const stashedCount = stashCurrentTurnRuntimeMessages(sessionName, streaming, stashedMessages, {
      crashRecovery,
      reconcileCurrentTurn,
    });
    if (stashedCount === 0) {
      return;
    }

    restartStashedReason = reason;
    log.warn("Recovering unterminated runtime turn by replaying pending messages", {
      runId,
      sessionName,
      turnId: currentTurnId,
      reason,
      stashedMessages: stashedCount,
      recoveryStrategy: reconcileCurrentTurn ? "provider_reconciliation" : "safe_replay",
      terminalReplayAllowed: safety.replayable,
    });
  };

  const projectUnterminatedChannelTurn = async (terminalRecordedBeforeFinalization: boolean) => {
    if (
      !streaming.currentChannelBackend ||
      terminalRecordedBeforeFinalization ||
      restartStashedReason ||
      (crashRecovery?.ownershipFailure && !streaming.currentCrashRecoveryAttemptId)
    ) {
      return;
    }
    const reason =
      streaming.internalAbortReason ??
      (streaming.abortController.signal.aborted ? "runtime_aborted" : "runtime_event_loop_closed");
    const timedOut =
      reason === PROVIDER_INACTIVE_AFTER_TOOL_REASON ||
      reason === PROVIDER_TURN_INACTIVITY_REASON ||
      reason === TOOL_INACTIVITY_REASON;
    await projectRuntimeEventToChannel(
      timedOut
        ? {
            type: "turn.failed",
            error: "Runtime ended before a terminal provider event",
            recoverable: true,
          }
        : { type: "turn.interrupted" },
    );
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
    const mediaParts = isCommentaryResponse(metadata) ? [] : pendingGeneratedMedia.splice(0);
    const channelBackendOwnsText = streaming.currentChannelBackend !== undefined;
    if (channelBackendOwnsText && mediaParts.length === 0) {
      log.debug("Channel backend response deferred to terminal projection", {
        sessionName,
        turnId: streaming.currentChannelBackend?.binding.turnId,
      });
      return;
    }
    const responseText = channelBackendOwnsText ? "" : text;
    const emitId =
      mediaParts.length > 0
        ? `media-${createHash("sha256")
            .update(mediaParts.map((media) => media.idempotencyKey ?? media.filePath).join("\n"))
            .digest("hex")
            .slice(0, 16)}`
        : Math.random().toString(36).slice(2, 8);
    // Resolve the target chat per `.ravi/specs/sessions/attach/SPEC.md`.
    // Attach selects the chat that receives this session's external output.
    // Sentinel agents observe silently → no target.
    let resolvedTarget = undefined as ReturnType<typeof resolveSessionOutputTarget>["target"] | undefined;
    let resolvedSource: ReturnType<typeof resolveSessionOutputTarget>["source"] = "unresolved";
    if (streaming.agentMode !== "sentinel") {
      if (streaming.currentReplyTarget !== undefined) {
        resolvedTarget = streaming.currentReplyTarget;
        resolvedSource = resolvedTarget ? (streaming.currentSource ? "source-chat" : "attached-output") : "unresolved";
      } else {
        const resolution = resolveSessionOutputTarget({
          sessionKey: session.sessionKey,
          fallback: streaming.currentSource,
        });
        resolvedTarget = resolution.target;
        resolvedSource = resolution.source;
      }
      if (!resolvedTarget) {
        log.warn("Response target unresolved — dropping emit", {
          sessionName,
          source: resolvedSource,
        });
        clearPendingGeneratedMedia();
        return;
      }
    }
    const content =
      mediaParts.length > 0
        ? ([
            ...mediaParts.map((media) => ({ type: "media" as const, media })),
            ...(responseText.trim() ? [{ type: "text" as const, text: responseText }] : []),
          ] satisfies ResponseContentPart[])
        : undefined;
    log.info("Emitting response", {
      sessionName,
      emitId,
      textLen: responseText.length,
      mediaCount: mediaParts.length,
      targetSource: resolvedSource,
      channelBackendOwnsText,
    });
    await nats.emit(`ravi.session.${sessionName}.response`, {
      response: responseText,
      ...(content ? { content } : {}),
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
  let runtimeSessionClosePromise: Promise<void> | null = null;
  const closeRuntimeSession = (): Promise<void> => {
    if (runtimeSessionClosePromise) {
      return runtimeSessionClosePromise;
    }

    const closeResources = async () => {
      if (streaming.internalAbortReason === PROVIDER_TURN_INACTIVITY_REASON) {
        try {
          // Inactivity is a turn-level failure. Give the provider a chance to
          // terminate that turn before releasing its transport so a resumed
          // session does not inherit an ambiguous in-flight operation.
          await runtimeSession.interrupt();
        } catch (error) {
          log.warn("Failed to interrupt inactive provider turn before close", {
            runId,
            sessionName,
            provider: runtimeSession.provider,
            error,
          });
        }
      }
      await Promise.all([
        (async () => {
          try {
            await runtimeSession.close?.();
          } catch (error) {
            log.warn("Failed to close runtime session handle", {
              runId,
              sessionName,
              provider: runtimeSession.provider,
              error,
            });
          }
        })(),
        (async () => {
          try {
            await runtimeEventIterator.return?.();
          } catch (error) {
            log.warn("Failed to close runtime event iterator", {
              runId,
              sessionName,
              provider: runtimeSession.provider,
              error,
            });
          }
        })(),
      ]);
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    runtimeSessionClosePromise = Promise.race([
      closeResources(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          log.warn("Timed out closing runtime session resources", {
            runId,
            sessionName,
            provider: runtimeSession.provider,
            timeoutMs: RUNTIME_SESSION_CLOSE_TIMEOUT_MS,
          });
          resolve();
        }, RUNTIME_SESSION_CLOSE_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    return runtimeSessionClosePromise;
  };
  const readNextRuntimeEvent = async (): Promise<IteratorResult<RuntimeEvent>> => {
    const nextEvent = runtimeEventIterator.next();
    let interval: ReturnType<typeof setInterval> | undefined;
    let removeAbortListener: (() => void) | undefined;
    let timedOut = false;
    const timeout = new Promise<IteratorResult<RuntimeEvent>>((resolve) => {
      interval = setInterval(() => {
        if (timedOut || streaming.done || streaming.abortController.signal.aborted) return;
        if (!streaming.turnActive || streaming.toolRunning || streaming.compacting) return;

        const idleMs = Date.now() - streaming.lastActivity;
        if (idleMs < PROVIDER_TURN_INACTIVITY_TIMEOUT_MS) return;

        timedOut = true;
        const safety = getRuntimeTurnReplaySafety(streaming, crashRecovery);
        const reconcileCurrentTurn = runtimeSession.ambiguousTurnRecoveryStrategy === "reconcile_by_client_message_id";
        const stashedCount = stashPendingRuntimeMessages(sessionName, streaming, stashedMessages, {
          crashRecovery,
          reconcileCurrentTurn,
        });
        recordProviderTurnInactivityTimeout(idleMs, stashedCount > 0);
        if (stashedCount > 0) {
          restartStashedReason = PROVIDER_TURN_INACTIVITY_REASON;
          if (reconcileCurrentTurn && !safety.replayable) {
            log.warn("Provider inactivity recovery will reconcile without terminal replay authority", {
              runId,
              sessionName,
              startedTool: safety.startedTool,
              materializedOutput: safety.materializedOutput,
              durableBinding: safety.durableBinding,
            });
          }
        } else {
          log.warn("Skipping provider inactivity replay because the current turn is not replay-safe", {
            runId,
            sessionName,
            startedTool: safety.startedTool,
            materializedOutput: safety.materializedOutput,
            durableBinding: safety.durableBinding,
          });
        }
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
        void closeRuntimeSession();
        resolve({ done: true, value: undefined as never });
      }, PROVIDER_TURN_INACTIVITY_CHECK_MS);
      interval.unref?.();
    });
    const abort = new Promise<IteratorResult<RuntimeEvent>>((resolve) => {
      const signal = streaming.abortController.signal;
      if (signal.aborted) {
        resolve({ done: true, value: undefined as never });
        return;
      }
      const onAbort = () => resolve({ done: true, value: undefined as never });
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });

    try {
      return await Promise.race([nextEvent, timeout, abort]);
    } finally {
      if (interval) clearInterval(interval);
      removeAbortListener?.();
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
      const awaitsToolResultDelivery =
        event.type === "tool.completed" &&
        runtimeSession.provider === "codex" &&
        event.metadata?.item?.type === "dynamic_tool_call";
      if (awaitsToolResultDelivery) {
        // Codex queues the synthetic completion before its JSON-RPC callback
        // write resolves. Close every interrupt lane before asynchronous event
        // projection gives another inbound dispatch a chance to run.
        streaming.toolResultDeliveryPending = true;
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

      // Provider adapters commonly surface the native envelope before its
      // canonical assistant/tool event. Hold that raw envelope until the
      // canonical event has crossed its durable write-ahead fence.
      if (event.type === "provider.raw") {
        await settlePreviousProviderRawEvents();
        pendingProviderRawEvents.push({ event, safetyFenced: false });
        continue;
      }
      const correlatedProviderRawEvent = correlatePendingProviderRawEvent(event);

      // Safety markers are write-ahead fences for crash classification. A
      // completed/delivered tool event defensively proves that a tool started
      // even if the provider omitted or Ravi missed the corresponding start.
      if (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.result_delivered") {
        markCurrentTurnAttemptSafety({ startedTool: true });
        fencePendingProviderRawEvent(correlatedProviderRawEvent);
      }

      if (event.type === "tool.progress") {
        if (!toolLivenessLease.progress(event.toolUseId)) {
          log.debug("Ignoring progress for inactive tool", {
            sessionName,
            toolId: event.toolUseId,
          });
        }
        continue;
      }

      const receivedFailureClassification =
        event.type === "turn.failed"
          ? (() => {
              const interruptedRecoverable = streaming.interrupted && isRecoverableInterruptionFailure(event);
              const internalAbortReason = streaming.internalAbortReason;
              const internalRecoverable = Boolean(internalAbortReason) && isRecoverableInterruptionFailure(event);
              return {
                internalAbortReason,
                suppressedRecoverable: interruptedRecoverable || internalRecoverable,
              };
            })()
          : undefined;

      // Provider terminal events fence the physical delivery before any
      // projection, stream flush, persistence, or other asynchronous work.
      // The richer trace write below reuses this exact completion timestamp.
      const receivedTerminalStatus: RuntimeTurnAttemptTerminalStatus | undefined =
        event.type === "turn.complete"
          ? "complete"
          : event.type === "turn.interrupted"
            ? "interrupted"
            : event.type === "turn.failed"
              ? receivedFailureClassification?.suppressedRecoverable
                ? "interrupted"
                : "failed"
              : undefined;
      if (receivedTerminalStatus) {
        const terminal = terminalizeCurrentCrashRecoveryAttempt(receivedTerminalStatus);
        if (!terminal) {
          log.warn("Ignoring provider terminal event after crash recovery ownership loss", {
            runId,
            sessionName,
            providerEvent: event.type,
            providerStatus: receivedTerminalStatus,
          });
          break;
        }
        if (terminal.status !== receivedTerminalStatus) {
          log.info("Ignoring provider terminal event after another terminal path won", {
            runId,
            sessionName,
            providerEvent: event.type,
            providerStatus: receivedTerminalStatus,
            winningStatus: terminal.status,
            completedAt: terminal.completedAt,
          });
          break;
        }
        if (receivedTerminalStatus !== "complete") {
          // Interrupted/failed native envelopes may contain partial assistant
          // content that was never accepted by response policy.
          suppressProviderRawForCurrentTurn = true;
        }
      }

      if (event.type === "text.delta") {
        // The chunk can be queued for external emission below, so persist the
        // replay-safety fence before any projection or async work.
        markCurrentTurnAttemptSafety({ materializedOutput: true });
        fencePendingProviderRawEvent(correlatedProviderRawEvent);
        if (streaming.agentMode !== "sentinel" && !streaming.interrupted) {
          // Raw deltas arrive before whole-message response policy can classify
          // silent, heartbeat, no-response, or prompt-too-long content. They
          // may advance the externally visible turn to running, but content is
          // projected only after the complete assistant message is authorized.
          await projectRuntimeEventToChannel({
            type: "status",
            status: "thinking",
            metadata: event.metadata,
          });
        }
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

      if (event.type !== "turn.failed" && event.type !== "assistant.message") {
        await projectRuntimeEventToChannel(
          event,
          event.type === "turn.complete" && streaming.agentMode !== "sentinel" ? channelResponseText : undefined,
        );
      }

      if (event.type !== "turn.failed" && event.type !== "assistant.message") {
        await emitRuntimeEvent({ ...stripRuntimeRawEvent(event), provider: runtimeSession.provider });
      }

      if (event.type === "turn.complete" || event.type === "turn.interrupted") {
        await releasePendingProviderRawEvent(correlatedProviderRawEvent);
        suppressProviderRawForCurrentTurn = false;
      }

      // Track compaction status - block interrupts while compacting
      if (event.type === "status") {
        const status = event.status;
        const wasCompacting = streaming.compacting;
        streaming.compacting = status === "compacting";
        const compactionChanged = streaming.compacting !== wasCompacting;
        // Snapshot whether compaction announcements may be externalized for the
        // turn effectively executing. Falls back to source-only classification
        // if a per-turn snapshot was not recorded (e.g. resumed stashed turn).
        const compactionAnnouncement = compactionAnnouncementForTurn(
          streaming.currentTurnProvenance ?? classifyTurnProvenance({ source: streaming.currentSource }),
        );
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
            externalAnnouncementsAllowed: compactionAnnouncement.externalAnnouncementsAllowed,
            announcementOrigin: compactionAnnouncement.origin,
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

        const liveActivity = status === "idle" ? "idle" : streaming.compacting ? "compacting" : "thinking";
        patchLiveState(
          {
            activity: liveActivity,
            summary: status === "idle" ? "runtime idle" : streaming.compacting ? "compacting" : "runtime active",
            agentId: agent.id,
            runId,
            provider: runtimeSession.provider,
            model,
            source: streaming.currentSource,
          },
          statusSkillVisibility,
        );

        // External compaction announcements are user-facing runtime responses.
        // They are suppressed for automation-originated turns (cron, trigger,
        // session followup, heartbeat, and other background automation) while
        // human/channel turns keep them when enabled and not in sentinel mode.
        // Internal status/trace/live-state/skill-visibility handling above is
        // preserved for every origin.
        if (
          getAnnounceCompaction() &&
          streaming.currentSource &&
          streaming.agentMode !== "sentinel" &&
          compactionAnnouncement.externalAnnouncementsAllowed
        ) {
          if (streaming.compacting && !wasCompacting) {
            markCurrentTurnAttemptSafety({ materializedOutput: true });
            emitResponse("🧠 Compactando memória... um momento.").catch(() => {});
          } else if (!streaming.compacting && wasCompacting) {
            markCurrentTurnAttemptSafety({ materializedOutput: true });
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
        // Expire only after a full inactivity window. Provider progress events
        // renew this lease without exposing their output to channels or traces.
        toolLivenessLease.start(event.toolUse.id);
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
          ...(streaming.currentTurnProvenance ? { _turnProvenance: streaming.currentTurnProvenance } : {}),
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
            suppressProviderRawForCurrentTurn = true;
            log.info("Discarding interrupted response", {
              sessionName,
              textLen: messageText.length,
            });
          } else if (!messageText) {
            // After stripping SILENT_TOKEN, nothing left
            suppressProviderRawForCurrentTurn = true;
            log.info("Silent response (stripped)", { sessionName });
            await emitLegacyProviderEvent({ type: "silent" });
            await emitRuntimeEvent({
              type: "silent",
              provider: runtimeSession.provider,
            });
          } else {
            const trimmed = messageText.trim().toLowerCase();
            const promptTooLong = trimmed === "prompt is too long";
            const heartbeatResponse = messageText.trim().endsWith(HEARTBEAT_OK);
            const noResponseRequested =
              trimmed === "no response requested." ||
              trimmed === "no response requested" ||
              trimmed === "no response needed." ||
              trimmed === "no response needed";
            const commentaryResponse = isCommentaryResponse(event.metadata);
            const recordAssistantState = (observe: boolean) => {
              if (observe) {
                ensureCurrentTurnUserObservation();
                pushObservationEvent("message.assistant", {
                  preview: truncateObservationPreview(messageText),
                  payload: {
                    chars: messageText.length,
                    metadata: event.metadata ?? null,
                  },
                });
              }
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
              if (!commentaryResponse) {
                responseText = appendAssistantResponse(responseText, messageText);
              }
            };
            if (promptTooLong) {
              suppressProviderRawForCurrentTurn = true;
              // Retain the provider outcome in local history/trace, but do not
              // publish a realtime observation or advance the output fence.
              recordAssistantState(false);
              log.warn("Prompt too long - will auto-reset session", {
                sessionName,
              });
              streaming._promptTooLong = true;
              await emitLegacyProviderEvent({ type: "silent" });
              await emitRuntimeEvent({
                type: "silent",
                provider: runtimeSession.provider,
              });
            } else if (heartbeatResponse) {
              suppressProviderRawForCurrentTurn = true;
              recordAssistantState(false);
              log.info("Heartbeat OK", { sessionName });
              await emitLegacyProviderEvent({ type: "silent" });
              await emitRuntimeEvent({
                type: "silent",
                provider: runtimeSession.provider,
              });
            } else if (noResponseRequested) {
              suppressProviderRawForCurrentTurn = true;
              recordAssistantState(false);
              log.info("Silent response (no response requested)", {
                sessionName,
              });
              await emitLegacyProviderEvent({ type: "silent" });
              await emitRuntimeEvent({
                type: "silent",
                provider: runtimeSession.provider,
              });
            } else {
              // This content will be persisted/projected/emitted. Fence replay
              // before any of those effects; silent and discarded responses do
              // not advance the materialized-output marker.
              markCurrentTurnAttemptSafety({ materializedOutput: true });
              fencePendingProviderRawEvent(correlatedProviderRawEvent);
              recordAssistantState(true);
              await emitRuntimeEvent({
                type: "assistant.message",
                provider: runtimeSession.provider,
                text: messageText,
                ...(event.metadata ? { metadata: event.metadata } : {}),
              });
              if (!commentaryResponse) {
                channelResponseText = appendAssistantResponse(channelResponseText, messageText);
              } else if (streaming.agentMode !== "sentinel") {
                await projectRuntimeEventToChannel({
                  ...event,
                  text: messageText,
                });
              }
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
        toolLivenessLease.clear();
        // Arm provider inactivity watchdog: catches cases where the provider
        // (e.g. codex's API call to OpenAI) hangs silently with no further events.
        armProviderInactivityWatch();
        if (streaming.toolResultDeliveryPending || streaming.toolRunning) {
          await finishActiveToolBarrier();
        }
        continue;
      }

      if (event.type === "tool.completed") {
        const durationMs = streaming.toolStartTime ? Date.now() - streaming.toolStartTime : undefined;
        const toolId = streaming.currentToolId ?? event.toolUseId ?? "unknown";
        const toolName = streaming.currentToolName ?? event.toolName ?? "unknown";
        const toolInput = streaming.currentToolInput;
        const generatedImageCompletion = isGeneratedImageToolCompletion(event);
        let generatedImageAttachment: ResponseMediaAttachment | null = null;
        if (generatedImageCompletion) {
          try {
            generatedImageAttachment = await materializeGeneratedImageAttachment({
              sessionKey: session.sessionKey,
              sessionName,
              provider: runtimeSession.provider,
              toolUseId: toolId,
              content: event.content,
              metadata: event.metadata,
            });
            if (generatedImageAttachment) {
              const queued = queueGeneratedMedia(generatedImageAttachment);
              log.info(queued ? "Generated image queued for next response" : "Duplicate generated image ignored", {
                sessionName,
                toolId,
                filename: generatedImageAttachment.filename,
                idempotencyKey: generatedImageAttachment.idempotencyKey,
              });
            } else {
              log.warn("Generated image tool completed without materializable image payload", {
                sessionName,
                toolId,
              });
            }
          } catch (error) {
            log.warn("Failed to materialize generated image", { sessionName, toolId, error });
          }
        }
        const output = generatedImageCompletion
          ? summarizeGeneratedImageToolOutput({
              content: event.content,
              attachment: generatedImageAttachment,
              metadata: event.metadata,
            })
          : truncateOutput(event.content);
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
          ...(streaming.currentTurnProvenance ? { _turnProvenance: streaming.currentTurnProvenance } : {}),
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
        // Dynamic Codex callbacks finish on the later result-delivered marker.
        if (!awaitsToolResultDelivery) {
          await finishActiveToolBarrier();
        }
        continue;
      }

      // Handle result (turn complete - save and wait for next message)
      if (event.type === "turn.complete") {
        const proxyCredential = streaming.currentRuntimeCredential;
        if (proxyCredential?.authMethod === "hub-proxy") {
          const providerPrefix = proxyCredential.upstreamProvider ? `${proxyCredential.upstreamProvider}/` : "";
          event.execution = {
            provider: proxyCredential.upstreamProvider ?? null,
            model: providerPrefix && model.startsWith(providerPrefix) ? model.slice(providerPrefix.length) : model,
            billingType: "api",
          };
        }
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
        await recordRuntimeCredentialTurnSuccess(
          streaming,
          resolveIntelligenceEffectState(getRuntimeTurnReplaySafety(streaming, crashRecovery)),
        );

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
        updateTokens(session.sessionKey, inputTokens, outputTokens, inputTokens + cacheRead + cacheCreation);

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
                : {
                    status: resolvedCost?.pricingStatus ?? "skipped",
                    error: resolvedCost?.pricingError ?? null,
                  },
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
          applyTaskSessionTtlForAgent(session, agent.id, {
            source: "runtime.turn.complete",
          });
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

        if (!streaming.interrupted && pendingGeneratedMedia.length > 0) {
          markCurrentTurnAttemptSafety({ materializedOutput: true });
          await emitResponse("", event.metadata);
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
        channelResponseText = "";
        clearPendingGeneratedMedia();
        clearActiveToolState();
        streaming.compacting = false;
        streaming.lastToolFailure = undefined;
        streaming.pendingAbort = false;
        streaming.currentTurnToolStarted = false;
        streaming.currentTurnInputMutated = false;
        streaming.turnActive = false;
        streaming.currentChannelBackend = undefined;
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
        scheduleIdleSessionEviction();
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
        channelResponseText = "";
        clearPendingGeneratedMedia();
        clearActiveToolState();
        streaming.compacting = false;
        streaming.lastToolFailure = undefined;
        streaming.currentTurnToolStarted = false;
        streaming.currentTurnInputMutated = false;
        streaming.currentChannelBackend = undefined;
        streaming.turnActive = false;
        const interruptedReplaySafety = getRuntimeTurnReplaySafety(streaming, crashRecovery);
        if (!interruptedReplaySafety.replayable) {
          const queuedBefore = streaming.pendingMessages.length;
          streaming.pendingMessages = getCrashRecoveryReplayablePendingRuntimeMessages(streaming, crashRecovery);
          log.info("Discarding unsafe interrupted turn while preserving queued successors", {
            runId,
            sessionName,
            discarded: queuedBefore - streaming.pendingMessages.length,
            remaining: streaming.pendingMessages.length,
            startedTool: interruptedReplaySafety.startedTool,
            materializedOutput: interruptedReplaySafety.materializedOutput,
            durableBinding: interruptedReplaySafety.durableBinding,
          });
        }
        clearTraceTurnState();
        markRuntimeLiveIdle(sessionName, "turn interrupted");
        signalTurnComplete();
        continue;
      }

      if (event.type === "turn.failed") {
        const internalAbortReason = receivedFailureClassification?.internalAbortReason;
        const suppressedRecoverable = receivedFailureClassification?.suppressedRecoverable ?? false;
        const rawEventSummary = summarizeRuntimeFailureRawEvent(event.rawEvent);
        const currentTurnReplaySafety = getRuntimeTurnReplaySafety(streaming, crashRecovery);
        const currentTurnHadToolStarted = currentTurnReplaySafety.startedTool;
        const currentTurnHadMaterializedOutput = currentTurnReplaySafety.materializedOutput;
        const credentialFailureRecord = !suppressedRecoverable
          ? await recordRuntimeCredentialTurnFailure({
              streaming,
              provider: runtimeSession.provider,
              model,
              error: event.error,
              rawEvent: event.rawEvent,
              effectState: resolveIntelligenceEffectState(currentTurnReplaySafety),
            })
          : undefined;
        const credentialFailureSignal = credentialFailureRecord?.signal;
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
          await projectRuntimeEventToChannel({
            type: "turn.interrupted",
            metadata: event.metadata,
          });
          await emitRuntimeEvent({
            type: "turn.interrupted",
            provider: runtimeSession.provider,
            reason: internalAbortReason ?? "recoverable_interrupt_failure",
            metadata: event.metadata,
          });
          await releasePendingProviderRawEvent(correlatedProviderRawEvent);
          suppressProviderRawForCurrentTurn = false;
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
        channelResponseText = "";
        clearPendingGeneratedMedia();
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
          const stashedCount = stashPendingRuntimeMessages(sessionName, streaming, stashedMessages, { crashRecovery });
          if (stashedCount > 0) {
            restartStashedReason = restartReason;
          } else {
            log.info("Skipping recoverable interrupt replay because the current turn is not replay-safe", {
              runId,
              sessionName,
              startedTool: currentTurnHadToolStarted,
              materializedOutput: currentTurnHadMaterializedOutput,
              durableBinding: currentTurnReplaySafety.durableBinding,
            });
          }
          signalTurnComplete();
          clearTraceTurnState();
          streaming.done = true;
          streaming.currentChannelBackend = undefined;
          break;
        }

        const hubCredentialRetryApproved =
          streaming.currentRuntimeCredential?.authMethod !== "hub-proxy" ||
          credentialFailureRecord?.hubFeedback?.nextAction === "advance";
        if (credentialFailureSignal?.retryableByCredential && hubCredentialRetryApproved) {
          const restartReason = `runtime_credential_${credentialFailureSignal.kind}`;
          const stashedCount = stashCurrentTurnRuntimeMessages(sessionName, streaming, stashedMessages, {
            crashRecovery,
          });
          if (stashedCount > 0 && streaming.currentRuntimeCredential?.credentialId) {
            // This physical delivery is terminal even when the failure is
            // hidden from user-facing channels and retried on a fresh runtime.
            // Close the canonical trace with the attempt's first-terminal
            // status/timestamp before starting the replacement delivery.
            recordTerminalTraceOnce({
              status: "failed",
              eventType: "turn.failed",
              abortReason: restartReason,
              error: truncateLogDetail(event.error),
              payloadJson: {
                recoverable: true,
                autoRecovered: true,
                credentialRetry: true,
                credentialFailureKind: credentialFailureSignal.kind,
                failureDetails: formatRuntimeFailureDetails(event) ?? null,
                rawEvent: rawEventSummary ?? null,
                metadata: event.metadata ?? null,
              },
            });
            if (streaming.currentRuntimeCredential.authMethod !== "hub-proxy") {
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
            streaming.currentTurnInputMutated = false;
            signalTurnComplete();
            clearTraceTurnState();
            streaming.done = true;
            break;
          }
          log.warn("Skipping runtime credential retry because no replay-safe turn messages are available", {
            runId,
            sessionName,
            credentialId: streaming.currentRuntimeCredential?.credentialId,
            kind: credentialFailureSignal.kind,
            startedTool: currentTurnHadToolStarted,
            materializedOutput: currentTurnHadMaterializedOutput,
            durableBinding: currentTurnReplaySafety.durableBinding,
          });
        }

        if (credentialFailureSignal?.retryableByCredential && !hubCredentialRetryApproved) {
          log.warn("Skipping Hub intelligence failover without authoritative pre-effect advance", {
            runId,
            sessionName,
            attemptId: streaming.currentRuntimeCredential?.attemptId,
            effectState: resolveIntelligenceEffectState(currentTurnReplaySafety),
          });
        }

        const contextWindowFailure = classifyRuntimeContextWindowFailure({
          runtimeProvider: runtimeSession.provider,
          error: event.error,
          rawEvent: event.rawEvent,
        });
        if (contextWindowFailure && currentTurnReplaySafety.replayable) {
          await projectRuntimeEventToChannel(event);
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
          streaming.currentTurnInputMutated = false;
          streaming.internalAbortReason = RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON;
          streaming.interrupted = true;
          clearRuntimeCredentialAttempt(streaming, failedCredentialAttemptId);
          signalTurnComplete();
          clearTraceTurnState();
          streaming.done = true;
          streaming.currentChannelBackend = undefined;
          break;
        }
        if (contextWindowFailure) {
          log.warn("Skipping context-window auto-recovery because the current turn is not replay-safe", {
            runId,
            sessionName,
            startedTool: currentTurnHadToolStarted,
            materializedOutput: currentTurnHadMaterializedOutput,
            durableBinding: currentTurnReplaySafety.durableBinding,
          });
        }

        const channelBackendFailure = streaming.currentChannelBackend !== undefined;
        await projectRuntimeEventToChannel(event);
        await emitRuntimeEvent({
          ...stripRuntimeRawEvent(event),
          provider: runtimeSession.provider,
        });
        await releasePendingProviderRawEvent(correlatedProviderRawEvent);
        suppressProviderRawForCurrentTurn = false;
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
          error: publicRuntimeFailureDetail(event.error),
          abortReason: null,
        });
        clearTraceTurnState();

        streaming.currentTurnToolStarted = false;
        streaming.currentTurnInputMutated = false;
        streaming.currentChannelBackend = undefined;
        clearRuntimeCredentialAttempt(streaming, failedCredentialAttemptId);

        if (streaming.agentMode !== "sentinel" && !channelBackendFailure) {
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
          summary: truncateLiveSummary(publicRuntimeFailureDetail(event.error)) || "turn failed",
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
    // Never let an exceptional/ownership-loss path externalize a raw envelope
    // that did not reach its canonical write-ahead boundary.
    pendingProviderRawEvents.length = 0;
    log.info("Streaming session ended", { runId, sessionName });

    try {
      const terminalRecordedBeforeFinalization = Boolean(
        streaming.currentCrashRecoveryTerminal || streaming.currentTraceTurnTerminalRecorded,
      );
      prepareUnterminatedTurnRecovery();
      recordUnterminatedTurnExit();
      await projectUnterminatedChannelTurn(terminalRecordedBeforeFinalization);
    } catch (error) {
      // A lost crash-recovery fence has already made the coordinator reject
      // new work. It must not prevent provider/process cleanup below.
      log.error("Failed to finalize runtime turn before session cleanup", {
        runId,
        sessionName,
        error,
      });
    }
    streaming.currentChannelBackend = undefined;
    if (streaming.currentCrashRecoveryAttemptId && crashRecovery?.ownershipFailure) {
      log.warn("Detaching crash recovery attempt after ownership loss", {
        runId,
        sessionName,
        attemptId: streaming.currentCrashRecoveryAttemptId,
      });
      streaming.currentCrashRecoveryAttemptId = undefined;
    }
    try {
      clearTraceTurnState();
    } catch (error) {
      log.error("Failed to clear runtime trace state during cleanup", {
        runId,
        sessionName,
        error,
      });
    }
    streaming.durableTurnPreparationFailed = false;
    clearProviderInactivityWatch();
    clearIdleSessionEvictionTimer();
    toolLivenessLease.clear();
    streaming.done = true;
    streaming.starting = false;
    streaming.turnActive = false;
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
    await closeRuntimeSession();

    const stillOwnsRuntimeSlot = streamingSessions.get(sessionName) === streaming;
    if (stillOwnsRuntimeSlot) {
      streamingSessions.delete(sessionName);
    }
    try {
      const finalCredential = streaming.currentRuntimeCredential;
      if (
        finalCredential?.authMethod === "hub-proxy" &&
        finalCredential.attemptId &&
        finalCredential.intelligenceAttemptTerminal !== true
      ) {
        await reportHubIntelligenceAbandoned(
          finalCredential,
          resolveIntelligenceEffectState(getRuntimeTurnReplaySafety(streaming, crashRecovery)),
        );
        finalCredential.intelligenceAttemptTerminal = true;
      } else if (finalCredential?.authMethod !== "hub-proxy") {
        completeRuntimeCredentialAttempt(finalCredential?.attemptId, {
          status: "abandoned",
          metadata: { phase: "runtime.event_loop.finally" },
        });
      }
    } catch (error) {
      log.warn("Failed to abandon runtime credential attempt during cleanup", {
        runId,
        sessionName,
        error,
      });
    }
    if (stillOwnsRuntimeSlot) {
      try {
        if (restartStashedReason && restartStashedSession) {
          await restartStashedSession({
            sessionName,
            reason: restartStashedReason,
          });
        }
      } finally {
        drainPendingStarts();
      }
    }
  }
}

async function reportHubIntelligenceAbandoned(
  credential: NonNullable<RuntimeHostStreamingSession["currentRuntimeCredential"]>,
  effectState: RuntimeIntelligenceEffectState,
): Promise<RuntimeIntelligenceAttemptFeedbackResult> {
  if (
    !credential.attemptId ||
    !credential.intelligenceGrantId ||
    !credential.intelligenceRuntimeId ||
    !credential.intelligenceSessionKey ||
    !credential.connectionId
  ) {
    throw new Error("Hub intelligence attempt is missing authoritative abandonment metadata.");
  }
  return reportRuntimeIntelligenceAttemptFeedback({
    attemptId: credential.attemptId,
    grantId: credential.intelligenceGrantId,
    runtimeId: credential.intelligenceRuntimeId,
    connectionId: credential.connectionId,
    sessionKey: credential.intelligenceSessionKey,
    outcome: "abandoned",
    effectState,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
