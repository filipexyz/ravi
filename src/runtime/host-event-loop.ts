import { calculateCost } from "../constants.js";
import { backfillProviderSessionId, saveMessage } from "../db.js";
import { HEARTBEAT_OK } from "../heartbeat/index.js";
import { getToolSafety } from "../hooks/tool-safety.js";
import { nats } from "../nats.js";
import { SILENT_TOKEN } from "../prompt-builder.js";
import {
  dbInsertCostEvent,
  deleteSession,
  getAnnounceCompaction,
  getSession,
  updateProviderSession,
  updateRuntimeProviderState,
  updateTokens,
  type AgentConfig,
  type SessionEntry,
} from "../router/index.js";
import { recordRuntimeTraceEvent, recordTerminalTurnTrace } from "../session-trace/runtime-trace.js";
import { logger } from "../utils/logger.js";
import { revokeAgentRuntimeContextsForSession } from "./context-registry.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
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
  RuntimeEventMetadata,
  RuntimeProviderId,
  RuntimeSessionHandle,
  RuntimeSkillVisibilitySnapshot,
} from "./types.js";

const log = logger.child("bot");

const MAX_OUTPUT_LENGTH = 1000;
const MAX_TURN_FAILURE_LOG_DETAIL = 1800;
const MAX_TURN_FAILURE_RESPONSE = 320;

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
  defaultRuntimeProviderId: RuntimeProviderId,
): string | null {
  const explicitModel = executionModel?.trim();
  if (explicitModel) {
    return explicitModel;
  }

  return runtimeProvider === defaultRuntimeProviderId ? configuredModel : null;
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
    defaultRuntimeProviderId,
    streamingSessions,
    stashedMessages,
    safeEmit,
    drainPendingStarts,
  } = options;
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
  const PROVIDER_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
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
    log.info("Emitting response", {
      sessionName,
      emitId,
      textLen: text.length,
    });
    await nats.emit(`ravi.session.${sessionName}.response`, {
      response: text,
      target: streaming.agentMode === "sentinel" ? undefined : streaming.currentSource,
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

  try {
    for await (const event of runtimeSession.events) {
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

      const logLevel = event.type === "text.delta" ? "debug" : "info";
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
        log.info("Compaction status", {
          sessionName,
          compacting: streaming.compacting,
        });
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
          streamingSessions.delete(sessionName);
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

        const runtimeSessionDisplayId = event.session?.displayId ?? event.providerSessionId;
        // Skill gates can be persisted by the Codex Bash hook in a separate process.
        // Refresh before merging the provider's terminal snapshot so those marks survive turn.complete.
        refreshRuntimeSessionParamsFromDb();
        const runtimeSessionParams = mergeRuntimeSessionParams(event.session?.params ?? undefined);
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
        updateTokens(session.sessionKey, inputTokens, outputTokens);

        const executionModel = resolveCostTrackingModel(
          runtimeSession.provider,
          event.execution?.model,
          model,
          defaultRuntimeProviderId,
        );
        const cost = executionModel
          ? calculateCost(executionModel, {
              inputTokens,
              outputTokens,
              cacheRead,
              cacheCreation,
            })
          : null;
        if (cost && executionModel) {
          dbInsertCostEvent({
            sessionKey: session.sessionKey,
            agentId: agent.id,
            model: executionModel,
            inputTokens,
            outputTokens,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
            inputCostUsd: cost.inputCost,
            outputCostUsd: cost.outputCost,
            cacheCostUsd: cost.cacheCost,
            totalCostUsd: cost.totalCost,
            createdAt: Date.now(),
          });
        }
        recordTerminalTraceOnce({
          status: "complete",
          eventType: "turn.complete",
          providerSessionIdAfter: persistedSessionId ?? event.providerSessionId ?? null,
          usage: event.usage,
          costUsd: cost?.totalCost ?? null,
          responseChars: responseText.trim().length,
          payloadJson: {
            execution: event.execution ?? null,
            session: event.session ?? null,
            metadata: event.metadata ?? null,
            promptTooLongReset: streaming._promptTooLong ?? false,
          },
        });
        flushObservationEvents("turn.complete", {
          provider: runtimeSession.provider,
          usage: event.usage,
          costUsd: cost?.totalCost ?? null,
          responseChars: responseText.trim().length,
          providerSessionIdAfter: persistedSessionId ?? event.providerSessionId ?? null,
          promptTooLongReset: streaming._promptTooLong ?? false,
        });

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
        streaming.lastToolFailure = undefined;
        streaming.pendingAbort = false;
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
        streaming.lastToolFailure = undefined;
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
        } else {
          await emitRuntimeEvent({
            ...event,
            provider: runtimeSession.provider,
          });
        }
        recordTerminalTraceOnce({
          status: suppressedRecoverable ? "interrupted" : "failed",
          eventType: suppressedRecoverable ? "turn.interrupted" : "turn.failed",
          abortReason: suppressedRecoverable ? (internalAbortReason ?? "recoverable_interrupt_failure") : null,
          error: suppressedRecoverable ? null : event.error,
          payloadJson: {
            recoverable: event.recoverable ?? true,
            suppressedRecoverable,
            failureDetails: formatRuntimeFailureDetails(event) ?? null,
            rawEvent: rawEventSummary ?? null,
            metadata: event.metadata ?? null,
          },
        });
        flushObservationEvents(suppressedRecoverable ? "turn.interrupt" : "turn.failed", {
          provider: runtimeSession.provider,
          recoverable: event.recoverable ?? true,
          suppressedRecoverable,
          error: suppressedRecoverable ? null : event.error,
          abortReason: suppressedRecoverable ? (internalAbortReason ?? "recoverable_interrupt_failure") : null,
        });

        responseText = "";
        clearActiveToolState();
        streaming.lastToolFailure = undefined;
        streaming.pendingAbort = false;
        streaming.turnActive = false;
        streaming.internalAbortReason = undefined;
        clearTraceTurnState();

        if (suppressedRecoverable) {
          markRuntimeLiveIdle(sessionName, "turn interrupted");
          log.info("Suppressing recoverable interrupted turn failure", {
            runId,
            sessionName,
            internalAbortReason,
            error: event.error,
          });
          signalTurnComplete();
          continue;
        }

        if (streaming.agentMode !== "sentinel") {
          await emitResponse(formatUserFacingTurnFailure(event.error));
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

    streaming.done = true;
    streaming.starting = false;

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

    streamingSessions.delete(sessionName);
    drainPendingStarts();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
