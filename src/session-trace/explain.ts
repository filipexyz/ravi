import type { SessionTraceQueryResult } from "./query.js";
import type { JsonValue, SessionEventRecord, SessionTurnRecord } from "./types.js";

export type SessionTraceFindingSeverity = "info" | "warning" | "error";

export interface SessionTraceFinding {
  severity: SessionTraceFindingSeverity;
  code: string;
  title: string;
  detail: string;
  eventIds?: number[];
  turnId?: string | null;
  runId?: string | null;
  timestamp?: number;
  hint?: string;
}

export interface SessionTraceExplanation {
  status: "ok" | "attention";
  counters: {
    events: number;
    turns: number;
    adapterRequests: number;
    terminalTurns: number;
    responses: number;
    deliveries: number;
  };
  findings: SessionTraceFinding[];
}

const TERMINAL_EVENT_TYPES = new Set(["turn.complete", "turn.failed", "turn.interrupted"]);
const TERMINAL_TURN_STATUSES = new Set(["complete", "completed", "failed", "interrupted", "timeout", "aborted"]);

function isRecord(value: JsonValue | null): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getJsonString(value: JsonValue | null, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return item;
    if (typeof item === "number" || typeof item === "boolean") return String(item);
  }
  return null;
}

function getJsonNumber(value: JsonValue | null, keys: string[]): number | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string" && item.trim() && Number.isFinite(Number(item))) return Number(item);
  }
  return null;
}

function getJsonStringArray(value: JsonValue | null, key: string): string[] {
  if (!isRecord(value)) return [];
  const item = value[key];
  if (!Array.isArray(item)) return [];
  return item.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function relatedByTurnOrRun(a: SessionEventRecord, b: SessionEventRecord): boolean {
  if (a.turnId && b.turnId && a.turnId === b.turnId) return true;
  if (a.runId && b.runId && a.runId === b.runId) return true;
  if (a.messageId && b.messageId && a.messageId === b.messageId) return true;
  return false;
}

function toolCorrelationKey(event: SessionEventRecord): string {
  const payload = event.payloadJson;
  const id =
    getJsonString(payload, [
      "toolId",
      "tool_id",
      "toolCallId",
      "tool_call_id",
      "toolUseId",
      "tool_use_id",
      "callId",
      "id",
    ]) ??
    getJsonString(payload, ["toolName", "tool_name", "name"]) ??
    event.preview ??
    "tool";
  return [event.turnId ?? event.runId ?? event.sessionKey, id].join(":");
}

function uniqueTexts(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim())))).sort();
}

function hasTerminalForTurn(
  turnId: string | null,
  terminalEvents: SessionEventRecord[],
  turnsById: Map<string, SessionTurnRecord>,
): boolean {
  if (!turnId) return false;
  if (terminalEvents.some((event) => event.turnId === turnId)) return true;
  const turn = turnsById.get(turnId);
  return Boolean(turn && TERMINAL_TURN_STATUSES.has(turn.status.toLowerCase()));
}

function addFinding(findings: SessionTraceFinding[], finding: SessionTraceFinding): void {
  findings.push(finding);
}

export function explainSessionTrace(trace: SessionTraceQueryResult): SessionTraceExplanation {
  const findings: SessionTraceFinding[] = [];
  const events = trace.events;
  const turns = trace.turns;
  const adapterRequests = events.filter((event) => event.eventType === "adapter.request");
  const promptEvents = events.filter(
    (event) =>
      event.eventGroup === "prompt" &&
      (event.eventType === "prompt.received" ||
        event.eventType === "prompt.published" ||
        event.eventType === "prompt.debounce.flushed"),
  );
  const terminalEvents = events.filter((event) => TERMINAL_EVENT_TYPES.has(event.eventType));
  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));
  const responses = events.filter((event) => event.eventType === "response.emitted");
  const deliveries = events.filter((event) => event.eventGroup === "delivery");

  for (const prompt of promptEvents) {
    const nextPromptAt =
      promptEvents.find((candidate) => candidate.timestamp > prompt.timestamp)?.timestamp ?? Infinity;
    const promptHasRuntimeCorrelation = Boolean(prompt.turnId || prompt.runId);
    const adapter = adapterRequests.find(
      (candidate) =>
        candidate.timestamp >= prompt.timestamp &&
        candidate.timestamp < nextPromptAt &&
        (relatedByTurnOrRun(prompt, candidate) ||
          (!promptHasRuntimeCorrelation && candidate.sessionKey === prompt.sessionKey)),
    );
    if (!adapter) {
      addFinding(findings, {
        severity: "warning",
        code: "prompt-without-adapter-request",
        title: "Prompt did not reach adapter boundary",
        detail: `${prompt.eventType} was recorded without a following adapter.request in the same prompt window.`,
        eventIds: [prompt.id],
        timestamp: prompt.timestamp,
        hint: "Check dispatch queue, task barriers, debounce, or runtime startup failures before provider handoff.",
      });
    }
  }

  for (const adapter of adapterRequests) {
    if (!hasTerminalForTurn(adapter.turnId, terminalEvents, turnsById)) {
      addFinding(findings, {
        severity: "warning",
        code: "adapter-request-without-terminal-turn",
        title: "Adapter request has no terminal turn",
        detail:
          "The provider request was built, but no turn.complete/turn.failed/turn.interrupted or terminal turn snapshot was found.",
        eventIds: [adapter.id],
        turnId: adapter.turnId,
        runId: adapter.runId,
        timestamp: adapter.timestamp,
        hint: "Look for adapter process exits, timeout handling, or lost runtime events after provider handoff.",
      });
    }
  }

  for (const response of responses) {
    const emitId = getJsonString(response.payloadJson, ["emitId", "emit_id"]);
    const delivery = deliveries.find((candidate) => {
      if (candidate.timestamp < response.timestamp) return false;
      const deliveryEmitId = getJsonString(candidate.payloadJson, ["emitId", "emit_id"]);
      if (emitId && deliveryEmitId) return emitId === deliveryEmitId;
      return (
        (Boolean(response.canonicalChatId) && response.canonicalChatId === candidate.canonicalChatId) ||
        (Boolean(response.sourceChatId) && response.sourceChatId === candidate.sourceChatId) ||
        (Boolean(response.messageId) && response.messageId === candidate.messageId)
      );
    });
    if (!delivery) {
      addFinding(findings, {
        severity: "warning",
        code: "response-without-delivery",
        title: "Response was emitted without delivery observation",
        detail: "An assistant response reached the response bus, but no delivery event followed in the trace.",
        eventIds: [response.id],
        turnId: response.turnId,
        runId: response.runId,
        timestamp: response.timestamp,
        hint: "Inspect channel delivery, target routing, and outbound queue state.",
      });
    }
  }

  for (const delivery of deliveries) {
    if (delivery.eventType === "delivery.failed" || delivery.eventType === "delivery.dropped") {
      addFinding(findings, {
        severity: "error",
        code: delivery.eventType === "delivery.failed" ? "delivery-failed" : "delivery-dropped",
        title: delivery.eventType === "delivery.failed" ? "Delivery failed" : "Delivery dropped",
        detail: delivery.error ?? delivery.preview ?? `${delivery.eventType} was recorded.`,
        eventIds: [delivery.id],
        timestamp: delivery.timestamp,
        hint: "Use the delivery payload and channel instance status/config to inspect the final outbound hop.",
      });
    }
  }

  for (const event of events) {
    if (event.eventType === "session.stalled") {
      addFinding(findings, {
        severity: "error",
        code: "runtime-stalled",
        title: "Runtime stalled and recovered",
        detail: event.error ?? event.preview ?? "The runtime stopped receiving provider events during an active turn.",
        eventIds: [event.id],
        turnId: event.turnId,
        runId: event.runId,
        timestamp: event.timestamp,
        hint: "Inspect the preceding tool/runtime events. A stalled turn is closed as failed without resetting session history.",
      });
    }

    if (
      event.eventType === "turn.interrupted" ||
      event.eventType === "session.abort" ||
      event.eventType === "dispatch.interrupt_requested"
    ) {
      addFinding(findings, {
        severity: event.eventType === "turn.interrupted" ? "warning" : "info",
        code: "interruption-or-abort",
        title: "Interruption or abort observed",
        detail: event.error ?? event.preview ?? `${event.eventType} was recorded before normal completion.`,
        eventIds: [event.id],
        turnId: event.turnId,
        runId: event.runId,
        timestamp: event.timestamp,
      });
    }

    if (event.eventType === "session.timeout" || getJsonString(event.payloadJson, ["status"]) === "timeout") {
      addFinding(findings, {
        severity: "warning",
        code: "timeout",
        title: "Timeout observed",
        detail: event.error ?? event.preview ?? `${event.eventType} recorded timeout state.`,
        eventIds: [event.id],
        turnId: event.turnId,
        runId: event.runId,
        timestamp: event.timestamp,
      });
    }
  }

  for (const turn of turns) {
    if (turn.status.toLowerCase() === "timeout") {
      addFinding(findings, {
        severity: "warning",
        code: "timeout",
        title: "Turn timed out",
        detail: turn.error ?? turn.abortReason ?? "The turn snapshot is in timeout state.",
        turnId: turn.turnId,
        runId: turn.runId,
        timestamp: turn.updatedAt,
      });
    }
  }

  for (const adapter of adapterRequests) {
    const resume = getJsonString(adapter.payloadJson, ["resume"]);
    const before = getJsonString(adapter.payloadJson, ["provider_session_id_before"]);
    if (resume === "false" && before) {
      addFinding(findings, {
        severity: "warning",
        code: "resume-disabled-with-provider-session",
        title: "Resume disabled despite existing provider session",
        detail: "adapter.request had resume=false with a provider_session_id_before value.",
        eventIds: [adapter.id],
        turnId: adapter.turnId,
        runId: adapter.runId,
        timestamp: adapter.timestamp,
      });
    }
  }

  for (const turn of turns) {
    if (!turn.resume && turn.providerSessionIdBefore) {
      addFinding(findings, {
        severity: "warning",
        code: "resume-disabled-with-provider-session",
        title: "Resume disabled despite existing provider session",
        detail: `turn ${turn.turnId} had resume=false with a providerSessionIdBefore value.`,
        turnId: turn.turnId,
        runId: turn.runId,
        timestamp: turn.startedAt,
      });
    }
  }

  const toolStarts = events.filter((event) => event.eventType === "tool.start");
  const toolEnds = events.filter((event) => event.eventType === "tool.end");
  const endedToolKeys = new Set(toolEnds.map(toolCorrelationKey));
  for (const start of toolStarts) {
    const key = toolCorrelationKey(start);
    if (!endedToolKeys.has(key)) {
      addFinding(findings, {
        severity: "warning",
        code: "tool-start-without-end",
        title: "Tool start has no matching end",
        detail: start.preview ?? "A tool.start event did not have a matching tool.end event.",
        eventIds: [start.id],
        turnId: start.turnId,
        runId: start.runId,
        timestamp: start.timestamp,
        hint: "Check for interrupted tool execution, adapter stream loss, or missing tool instrumentation.",
      });
    }
  }

  for (const event of events) {
    const taskBarrier = getJsonString(event.payloadJson, ["taskBarrierTaskId", "task_barrier_task_id"]);
    if (taskBarrier) {
      addFinding(findings, {
        severity: "info",
        code: "prompt-held-by-task-barrier",
        title: "Task barrier present",
        detail: `${event.eventType} referenced task barrier ${taskBarrier}.`,
        eventIds: [event.id],
        turnId: event.turnId,
        runId: event.runId,
        timestamp: event.timestamp,
      });
    }

    if (event.eventType === "prompt.debounce.flushed") {
      addFinding(findings, {
        severity: "info",
        code: "debounce-merged-messages",
        title: "Debounce flush observed",
        detail: event.preview ?? "Prompt debounce flushed one or more queued messages.",
        eventIds: [event.id],
        timestamp: event.timestamp,
      });
    }

    const queuedMessageCount = getJsonNumber(event.payloadJson, ["queued_message_count", "queuedMessageCount"]);
    const pendingIds = getJsonStringArray(event.payloadJson, "pending_ids");
    if ((queuedMessageCount ?? 0) > 1 || pendingIds.length > 1) {
      addFinding(findings, {
        severity: "info",
        code: "debounce-merged-messages",
        title: "Multiple queued messages reached one request",
        detail: `adapter.request included ${queuedMessageCount ?? pendingIds.length} queued messages.`,
        eventIds: [event.id],
        turnId: event.turnId,
        runId: event.runId,
        timestamp: event.timestamp,
      });
    }
  }

  for (const event of events) {
    if (event.eventType === "session.model_changed") {
      addFinding(findings, {
        severity: "info",
        code: "model-provider-changed",
        title: "Session model changed",
        detail: event.preview ?? event.error ?? "session.model_changed was recorded.",
        eventIds: [event.id],
        timestamp: event.timestamp,
      });
    }
  }

  const models = uniqueTexts([...adapterRequests.map((event) => event.model), ...turns.map((turn) => turn.model)]);
  const providers = uniqueTexts([
    ...adapterRequests.map((event) => event.provider),
    ...turns.map((turn) => turn.provider),
  ]);
  if (models.length > 1 || providers.length > 1) {
    addFinding(findings, {
      severity: "info",
      code: "model-provider-changed",
      title: "Model or provider varied across trace",
      detail: `providers=${providers.join(", ") || "(none)"} models=${models.join(", ") || "(none)"}`,
      timestamp: events[0]?.timestamp ?? turns[0]?.startedAt,
    });
  }

  const systemPromptShas = uniqueTexts([
    ...turns.map((turn) => turn.systemPromptSha256),
    ...adapterRequests.map((event) => getJsonString(event.payloadJson, ["system_prompt_sha256"])),
  ]);
  if (systemPromptShas.length > 1) {
    addFinding(findings, {
      severity: "info",
      code: "system-prompt-changed",
      title: "System prompt changed between turns",
      detail: `Observed ${systemPromptShas.length} distinct system prompt hashes.`,
      timestamp: events[0]?.timestamp ?? turns[0]?.startedAt,
      hint: "Compare turns with --show-system-prompt for intentional prompt changes.",
    });
  }

  const severityOrder: Record<SessionTraceFindingSeverity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => {
    const severity = severityOrder[a.severity] - severityOrder[b.severity];
    if (severity !== 0) return severity;
    return (a.timestamp ?? 0) - (b.timestamp ?? 0);
  });

  return {
    status: findings.length > 0 ? "attention" : "ok",
    counters: {
      events: events.length,
      turns: turns.length,
      adapterRequests: adapterRequests.length,
      terminalTurns:
        terminalEvents.length + turns.filter((turn) => TERMINAL_TURN_STATUSES.has(turn.status.toLowerCase())).length,
      responses: responses.length,
      deliveries: deliveries.length,
    },
    findings,
  };
}
