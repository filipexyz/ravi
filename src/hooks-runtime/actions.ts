import { parseDeliveryBarrier } from "../delivery-barriers.js";
import { saveMessage } from "../db.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { commentTask } from "../tasks/index.js";
import { logger } from "../utils/logger.js";
import { resolveHookTemplate } from "./template.js";
import type {
  AppendHistoryActionPayload,
  CommentTaskActionPayload,
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
    ...(payload.deliveryBarrier ? { deliveryBarrier: parseDeliveryBarrier(payload.deliveryBarrier) } : {}),
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
    ...(payload.deliveryBarrier ? { deliveryBarrier: parseDeliveryBarrier(payload.deliveryBarrier) } : {}),
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
  }

  return {
    hookId: hook.id,
    hookName: hook.name,
    eventName: event.eventName,
  };
}
