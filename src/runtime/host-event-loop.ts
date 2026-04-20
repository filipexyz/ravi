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
  updateProviderSession,
  updateTokens,
  type AgentConfig,
  type SessionEntry,
} from "../router/index.js";
import { recordRuntimeTraceEvent, recordTerminalTurnTrace } from "../session-trace/runtime-trace.js";
import { logger } from "../utils/logger.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import type { RuntimeCapabilities, RuntimeEventMetadata, RuntimeProviderId, RuntimeSessionHandle } from "./types.js";

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
        return { ...item, text: item.text.slice(0, MAX_OUTPUT_LENGTH) + `... [truncated]` };
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
    recordRuntimeTraceEvent({
      sessionKey: session.sessionKey,
      sessionName,
      agentId: agent.id,
      runId,
      ...input,
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

  // Timeout watchdog
  const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (longer for streaming)
  const watchdog = setInterval(() => {
    const elapsed = Date.now() - streaming.lastActivity;
    if (elapsed > SESSION_TIMEOUT_MS) {
      log.warn("Streaming session idle timeout", { sessionName, elapsedMs: elapsed });
      streaming.internalAbortReason = "idle_timeout";
      recordTraceEvent({
        turnId: streaming.currentTraceTurnId,
        provider: runtimeSession.provider,
        model,
        eventType: "session.timeout",
        eventGroup: "session",
        status: "timeout",
        source: streaming.currentSource,
        payloadJson: {
          elapsedMs: elapsed,
          timeoutMs: SESSION_TIMEOUT_MS,
        },
      });
      recordTerminalTraceOnce({
        status: "timeout",
        eventType: "turn.interrupted",
        abortReason: "idle_timeout",
        completedAt: Date.now(),
        payloadJson: {
          elapsedMs: elapsed,
          timeoutMs: SESSION_TIMEOUT_MS,
        },
      });
      safeEmit(`ravi.session.${sessionName}.runtime`, {
        type: "session.timeout",
        sessionName,
        elapsedMs: elapsed,
        timeoutMs: SESSION_TIMEOUT_MS,
        timestamp: new Date().toISOString(),
      }).catch((error) => {
        log.warn("Failed to emit session timeout audit event", { sessionName, error });
      });
      streaming.done = true;
      if (streaming.pushMessage) {
        streaming.pushMessage(null);
        streaming.pushMessage = null;
      }
      streaming.abortController.abort();
      streamingSessions.delete(sessionName);
      clearInterval(watchdog);
    }
  }, 30000);

  let providerRawEventCount = 0;
  let responseText = "";
  const clearActiveToolState = () => {
    streaming.toolRunning = false;
    streaming.currentToolId = undefined;
    streaming.currentToolName = undefined;
    streaming.toolStartTime = undefined;
    streaming.currentToolSafety = null;
  };
  const signalTurnComplete = () => {
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

  const emitResponse = async (text: string) => {
    const emitId = Math.random().toString(36).slice(2, 8);
    log.info("Emitting response", { sessionName, emitId, textLen: text.length });
    await nats.emit(`ravi.session.${sessionName}.response`, {
      response: text,
      target: streaming.agentMode === "sentinel" ? undefined : streaming.currentSource,
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
      providerRawEventCount++;
      streaming.lastActivity = Date.now();

      const logLevel = event.type === "text.delta" ? "debug" : "info";
      log[logLevel]("Runtime event", {
        runId,
        seq: providerRawEventCount,
        type: event.type,
        sessionName,
      });

      if (event.type === "text.delta") {
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
            ? { type: "provider.raw", provider: runtimeSession.provider, metadata: event.metadata }
            : { ...event, provider: runtimeSession.provider },
        );
      }

      // Track compaction status - block interrupts while compacting
      if (event.type === "status") {
        const status = event.status;
        const wasCompacting = streaming.compacting;
        streaming.compacting = status === "compacting";
        log.info("Compaction status", { sessionName, compacting: streaming.compacting });
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

        if (getAnnounceCompaction() && streaming.currentSource && streaming.agentMode !== "sentinel") {
          if (streaming.compacting && !wasCompacting) {
            emitResponse("🧠 Compactando memória... um momento.").catch(() => {});
          } else if (!streaming.compacting && wasCompacting) {
            emitResponse("🧠 Memória compactada. Pronto pra continuar.").catch(() => {});
          }
        }
      }

      if (event.type === "tool.started") {
        streaming.toolRunning = true;
        streaming.currentToolId = event.toolUse.id;
        streaming.currentToolName = event.toolUse.name;
        streaming.toolStartTime = Date.now();
        streaming.currentToolSafety = getToolSafety(
          event.toolUse.name,
          (event.toolUse.input as Record<string, unknown> | undefined) ?? {},
        );
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
        continue;
      }

      // Handle assistant messages
      if (event.type === "assistant.message") {
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
            log.info("Discarding interrupted response", { sessionName, textLen: messageText.length });
          } else if (!messageText) {
            // After stripping SILENT_TOKEN, nothing left
            log.info("Silent response (stripped)", { sessionName });
            await emitLegacyProviderEvent({ type: "silent" });
            await emitRuntimeEvent({ type: "silent", provider: runtimeSession.provider });
          } else {
            responseText += messageText;
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
              log.warn("Prompt too long - will auto-reset session", { sessionName });
              streaming._promptTooLong = true;
              await emitLegacyProviderEvent({ type: "silent" });
              await emitRuntimeEvent({ type: "silent", provider: runtimeSession.provider });
            } else if (messageText.trim().endsWith(HEARTBEAT_OK)) {
              log.info("Heartbeat OK", { sessionName });
              await emitLegacyProviderEvent({ type: "silent" });
              await emitRuntimeEvent({ type: "silent", provider: runtimeSession.provider });
            } else if (
              trimmed === "no response requested." ||
              trimmed === "no response requested" ||
              trimmed === "no response needed." ||
              trimmed === "no response needed"
            ) {
              log.info("Silent response (no response requested)", { sessionName });
              await emitLegacyProviderEvent({ type: "silent" });
              await emitRuntimeEvent({ type: "silent", provider: runtimeSession.provider });
            } else {
              await emitResponse(messageText);
            }
          }
        }
        continue;
      }

      // Handle tool results
      if (event.type === "tool.completed") {
        const durationMs = streaming.toolStartTime ? Date.now() - streaming.toolStartTime : undefined;
        recordTraceEvent({
          turnId: streaming.currentTraceTurnId,
          provider: runtimeSession.provider,
          model,
          eventType: "tool.end",
          eventGroup: "tool",
          status: event.isError ? "failed" : "complete",
          durationMs,
          payloadJson: {
            toolId: streaming.currentToolId ?? event.toolUseId ?? "unknown",
            toolName: streaming.currentToolName ?? event.toolName ?? "unknown",
            output: truncateOutput(event.content),
            isError: event.isError ?? false,
            metadata: event.metadata,
          },
          preview: streaming.currentToolName ?? event.toolName ?? "unknown",
        });

        safeEmit(`ravi.session.${sessionName}.tool`, {
          event: "end",
          toolId: streaming.currentToolId ?? event.toolUseId ?? "unknown",
          toolName: streaming.currentToolName ?? event.toolName ?? "unknown",
          output: truncateOutput(event.content),
          isError: event.isError ?? false,
          durationMs,
          timestamp: new Date().toISOString(),
          sessionName,
          agentId: agent.id,
          metadata: event.metadata,
        }).catch((err) => log.warn("Failed to emit tool end", { error: err }));

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
          log.info("Executing deferred abort after unsafe tool completed", { sessionName });
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
        const runtimeSessionParams = event.session?.params ?? undefined;
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

        // Auto-reset session when prompt is too long (compact failed)
        if (streaming._promptTooLong) {
          log.warn("Auto-resetting session due to 'Prompt is too long'", { sessionName });
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
          saveMessage(sessionName, "assistant", responseText.trim(), sdkId);
        }

        // Reset for next turn
        responseText = "";
        clearActiveToolState();
        streaming.pendingAbort = false;
        streaming.turnActive = false;
        clearTraceTurnState();

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
        streaming.interrupted = true;
        responseText = "";
        clearActiveToolState();
        streaming.turnActive = false;
        clearTraceTurnState();
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
          await emitRuntimeEvent({ ...event, provider: runtimeSession.provider });
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

        responseText = "";
        clearActiveToolState();
        streaming.pendingAbort = false;
        streaming.turnActive = false;
        streaming.internalAbortReason = undefined;
        clearTraceTurnState();

        if (suppressedRecoverable) {
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

        signalTurnComplete();
      }
    }
  } finally {
    log.info("Streaming session ended", { runId, sessionName });
    clearInterval(watchdog);

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
