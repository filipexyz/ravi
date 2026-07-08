import { requireDeliveryBarrier } from "../delivery-barriers.js";
import { saveMessage } from "../db.js";
import { advanceCurationCounter, readMemoryCurationState, writeMemoryCurationState } from "../memory/index.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { getSession, updateRuntimeProviderState } from "../router/index.js";
import { commentTask, createTask, queueOrDispatchTask } from "../tasks/index.js";
import { logger } from "../utils/logger.js";
import { resolveHookTemplate } from "./template.js";
import type {
  AppendHistoryActionPayload,
  CommentTaskActionPayload,
  DispatchTaskActionPayload,
  HookExecutionResult,
  HookRecord,
  InjectContextActionPayload,
  NormalizedHookEvent,
  SendSessionEventActionPayload,
} from "./types.js";

const log = logger.child("hooks:actions");

function resolveOptionalTemplate(value: string | undefined, event: NormalizedHookEvent): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return resolveHookTemplate(value, event).trim();
}

async function handleInjectContext(
  hook: HookRecord,
  payload: InjectContextActionPayload,
  event: NormalizedHookEvent,
): Promise<void> {
  const sessionName = resolveOptionalTemplate(payload.sessionName, event) ?? event.sessionName;
  if (!sessionName) {
    throw new Error(`Hook ${hook.id} inject_context requires a session target`);
  }

  const message = resolveHookTemplate(payload.message, event).trim();
  if (!message) {
    log.debug("Skipping empty inject_context message", { hookId: hook.id, sessionName });
    return;
  }

  await publishSessionPrompt(sessionName, {
    prompt: `[System] Inform: ${message}`,
    deliveryBarrier: payload.deliveryBarrier
      ? requireDeliveryBarrier(payload.deliveryBarrier, "hook deliveryBarrier")
      : "after_response",
    deliveryBarrierSource: payload.deliveryBarrier ? "explicit" : "default",
    _hook: true,
    _hookId: hook.id,
  });
}

async function handleSendSessionEvent(
  hook: HookRecord,
  payload: SendSessionEventActionPayload,
  event: NormalizedHookEvent,
): Promise<void> {
  const sessionName = resolveOptionalTemplate(payload.sessionName, event) ?? event.sessionName;
  if (!sessionName) {
    throw new Error(`Hook ${hook.id} send_session_event requires a session target`);
  }

  const message = resolveHookTemplate(payload.message, event).trim();
  if (!message) {
    log.debug("Skipping empty send_session_event message", { hookId: hook.id, sessionName });
    return;
  }

  await publishSessionPrompt(sessionName, {
    prompt: message,
    deliveryBarrier: payload.deliveryBarrier
      ? requireDeliveryBarrier(payload.deliveryBarrier, "hook deliveryBarrier")
      : "after_response",
    deliveryBarrierSource: payload.deliveryBarrier ? "explicit" : "default",
    _hook: true,
    _hookId: hook.id,
  });
}

async function handleAppendHistory(
  hook: HookRecord,
  payload: AppendHistoryActionPayload,
  event: NormalizedHookEvent,
): Promise<void> {
  const sessionName = resolveOptionalTemplate(payload.sessionName, event) ?? event.sessionName;
  if (!sessionName) {
    throw new Error(`Hook ${hook.id} append_history requires a session target`);
  }

  const message = resolveHookTemplate(payload.message, event).trim();
  if (!message) {
    log.debug("Skipping empty append_history message", { hookId: hook.id, sessionName });
    return;
  }

  saveMessage(sessionName, payload.role === "assistant" ? "assistant" : "user", message);
}

async function handleCommentTask(
  hook: HookRecord,
  payload: CommentTaskActionPayload,
  event: NormalizedHookEvent,
): Promise<void> {
  const taskId = resolveOptionalTemplate(payload.taskId, event) ?? event.taskId;
  if (!taskId) {
    throw new Error(`Hook ${hook.id} comment_task requires a task target`);
  }

  const body = resolveHookTemplate(payload.body, event).trim();
  if (!body) {
    log.debug("Skipping empty comment_task body", { hookId: hook.id, taskId });
    return;
  }

  await commentTask(taskId, {
    author: resolveOptionalTemplate(payload.author, event) ?? `hook:${hook.name}`,
    ...(event.agentId ? { authorAgentId: event.agentId } : {}),
    ...(event.sessionName ? { authorSessionName: event.sessionName } : {}),
    body,
  });
}

async function handleDispatchTask(
  hook: HookRecord,
  payload: DispatchTaskActionPayload,
  event: NormalizedHookEvent,
): Promise<void> {
  const profileId = resolveOptionalTemplate(payload.profileId, event) ?? payload.profileId;
  if (!profileId?.trim()) {
    throw new Error(`Hook ${hook.id} dispatch_task requires a profileId`);
  }

  const title = resolveHookTemplate(payload.title, event).trim();
  if (!title) {
    log.debug("Skipping empty dispatch_task title", { hookId: hook.id });
    return;
  }

  if (typeof payload.cadenceTurns === "number" && payload.cadenceTurns > 0) {
    if (!event.sessionKey) {
      log.warn("dispatch_task cadenceTurns requires event.sessionKey; ignoring cadence", {
        hookId: hook.id,
        cadenceTurns: payload.cadenceTurns,
      });
    } else {
      const cadenceDecision = advanceSessionCadence(event.sessionKey, payload.cadenceTurns);
      if (!cadenceDecision.shouldCurate) {
        log.debug("dispatch_task cadence gate: skip this turn", {
          hookId: hook.id,
          sessionKey: event.sessionKey,
          turnCount: cadenceDecision.turnCount,
          cadenceTurns: payload.cadenceTurns,
        });
        return;
      }
    }
  }

  const targetAgentId = resolveOptionalTemplate(payload.targetAgentId, event) ?? event.agentId;
  const instructions = resolveOptionalTemplate(payload.instructions, event);

  let profileInput: Record<string, string> | undefined;
  if (payload.profileInputJson?.trim()) {
    const rendered = resolveHookTemplate(payload.profileInputJson, event);
    try {
      const parsed = JSON.parse(rendered) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("profileInputJson must render to a JSON object");
      }
      profileInput = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        profileInput[key] = typeof value === "string" ? value : JSON.stringify(value);
      }
    } catch (err) {
      throw new Error(
        `Hook ${hook.id} dispatch_task profileInputJson invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const created = createTask({
    title,
    instructions: instructions ?? title,
    profileId: profileId.trim(),
    createdBy: `hook:${hook.name}`,
    ...(event.agentId ? { createdByAgentId: event.agentId } : {}),
    ...(event.sessionName ? { createdBySessionName: event.sessionName } : {}),
    ...(profileInput ? { profileInput } : {}),
  });

  if (targetAgentId) {
    try {
      await queueOrDispatchTask(created.task.id, {
        agentId: targetAgentId,
        sessionName: event.sessionName ?? `hook-${hook.name}`,
        assignedBy: `hook:${hook.name}`,
        ...(event.agentId ? { assignedByAgentId: event.agentId } : {}),
        ...(event.sessionName ? { assignedBySessionName: event.sessionName } : {}),
      });
    } catch (err) {
      log.warn("dispatch_task created task but dispatch failed", {
        hookId: hook.id,
        taskId: created.task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("Dispatched task from hook", {
    hookId: hook.id,
    taskId: created.task.id,
    profileId,
    targetAgentId,
  });
}

function advanceSessionCadence(sessionKey: string, cadenceTurns: number): { shouldCurate: boolean; turnCount: number } {
  const session = getSession(sessionKey);
  if (!session) {
    log.warn("dispatch_task cadence: session not found; treating as skip", { sessionKey });
    return { shouldCurate: false, turnCount: 0 };
  }
  const current = readMemoryCurationState(session, cadenceTurns);
  // Honor a cadence change made after the hook was persisted with a different value.
  const withRequestedCadence = current.cadenceTurns === cadenceTurns ? current : { ...current, cadenceTurns };
  const advanced = advanceCurationCounter(withRequestedCadence);
  const nextParams = writeMemoryCurationState(session, advanced.next);
  updateRuntimeProviderState(sessionKey, session.runtimeProvider, {
    runtimeSessionParams: nextParams,
  });
  return { shouldCurate: advanced.shouldCurate, turnCount: advanced.next.turnCount };
}

export async function executeHookAction(hook: HookRecord, event: NormalizedHookEvent): Promise<HookExecutionResult> {
  switch (hook.actionType) {
    case "inject_context":
      await handleInjectContext(hook, hook.actionPayload as InjectContextActionPayload, event);
      break;
    case "send_session_event":
      await handleSendSessionEvent(hook, hook.actionPayload as SendSessionEventActionPayload, event);
      break;
    case "append_history":
      await handleAppendHistory(hook, hook.actionPayload as AppendHistoryActionPayload, event);
      break;
    case "comment_task":
      await handleCommentTask(hook, hook.actionPayload as CommentTaskActionPayload, event);
      break;
    case "dispatch_task":
      await handleDispatchTask(hook, hook.actionPayload as DispatchTaskActionPayload, event);
      break;
  }

  return {
    hookId: hook.id,
    hookName: hook.name,
    eventName: event.eventName,
  };
}
