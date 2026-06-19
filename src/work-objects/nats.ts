import { publish, subscribe } from "../nats.js";
import { logger } from "../utils/logger.js";
import {
  createWorkObjectRequestContext,
  executeWorkObjectAction,
  resolveWorkObject,
  suggestWorkObjectOptions,
  updateWorkObject,
} from "./service.js";
import { ALL_WORK_OBJECT_NATS_SUBJECTS, WORK_OBJECT_NATS_COMPAT_SUBJECTS, WORK_OBJECT_NATS_SUBJECTS } from "./types.js";
import type {
  WorkObjectActionInput,
  WorkObjectExternalRef,
  WorkObjectRequestContext,
  WorkObjectResolveInput,
  WorkObjectSuggestionInput,
  WorkObjectUpdatePatch,
} from "./types.js";

const log = logger.child("work-objects:nats");

export interface WorkObjectNatsServiceHandle {
  stop(): Promise<void>;
}

type WorkObjectOperation = keyof typeof WORK_OBJECT_NATS_SUBJECTS;

export function startWorkObjectNatsService(): WorkObjectNatsServiceHandle {
  let running = true;
  const stream = subscribe(...ALL_WORK_OBJECT_NATS_SUBJECTS, { queue: "ravi-work-objects" });

  const loop = (async () => {
    for await (const message of stream) {
      if (!running) break;
      await handleWorkObjectNatsMessage(message.topic, message.data).catch((error) => {
        log.error("Work Object NATS request failed", { topic: message.topic, error });
      });
    }
  })();

  return {
    async stop() {
      running = false;
      await stream.return?.(undefined);
      await loop.catch(() => {});
    },
  };
}

async function handleWorkObjectNatsMessage(topic: string, payload: Record<string, unknown>): Promise<void> {
  const replyTopic = readString(payload.replyTopic);
  if (!replyTopic) {
    log.warn("Ignoring Work Object NATS request without replyTopic", { topic });
    return;
  }

  try {
    const operation = operationForTopic(topic);
    if (!operation) throw new Error(`Unsupported Work Object topic: ${topic}`);
    const response = await dispatchWorkObjectOperation(operation, payload);
    await publish(replyTopic, { ok: true, providerId: response.providerId, result: response.result });
  } catch (error) {
    await publish(replyTopic, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function dispatchWorkObjectOperation(operation: WorkObjectOperation, payload: Record<string, unknown>) {
  const requestId = readString(payload.requestId);
  const context =
    parseContext(payload.context) ?? createWorkObjectRequestContext(requestId ? { requestId } : undefined);

  if (operation === "resolve") {
    const input = (isObject(payload.input) ? payload.input : payload) as WorkObjectResolveInput;
    const result = await resolveWorkObject(input, context);
    if (!result) throw new Error("Work Object not found");
    return result;
  }

  const ref = parseRef(payload.ref ?? payload.externalRef);
  if (!ref) throw new Error("Work Object request requires ref or externalRef");

  if (operation === "update") {
    const patch = parsePatch(payload.patch);
    const result = await updateWorkObject(ref, patch, context);
    if (!result) throw new Error("Work Object update not handled");
    return result;
  }

  if (operation === "action") {
    const action = parseAction(payload.action);
    const result = await executeWorkObjectAction(ref, action, context);
    if (!result) throw new Error("Work Object action not handled");
    return result;
  }

  const suggestion = parseSuggestion(payload.suggestion);
  const result = await suggestWorkObjectOptions(ref, suggestion, context);
  if (!result) throw new Error("Work Object suggestions not handled");
  return result;
}

function operationForTopic(topic: string): WorkObjectOperation | null {
  for (const subjects of [WORK_OBJECT_NATS_SUBJECTS, WORK_OBJECT_NATS_COMPAT_SUBJECTS]) {
    for (const [operation, subject] of Object.entries(subjects)) {
      if (topic === subject) return operation as WorkObjectOperation;
    }
  }
  return null;
}

function parseContext(input: unknown): WorkObjectRequestContext | null {
  if (!isObject(input)) return null;
  return createWorkObjectRequestContext(input as Partial<WorkObjectRequestContext>);
}

function parseRef(input: unknown): WorkObjectExternalRef | null {
  if (!isObject(input)) return null;
  const id = readString(input.id);
  if (!id) return null;
  const type = readString(input.type);
  return {
    id,
    ...(type ? { type } : {}),
  };
}

function parsePatch(input: unknown): WorkObjectUpdatePatch {
  if (!isObject(input)) return { values: {} };
  const values = isObject(input.values) ? input.values : {};
  const revision = readString(input.revision);
  return {
    values,
    ...(revision ? { revision } : {}),
    ...(isObject(input.rawPayload) ? { rawPayload: input.rawPayload } : {}),
  };
}

function parseAction(input: unknown): WorkObjectActionInput {
  if (!isObject(input)) throw new Error("Work Object action request requires action");
  const actionId = readString(input.actionId);
  if (!actionId) throw new Error("Work Object action request requires action.actionId");
  const value = readString(input.value);
  return {
    actionId,
    ...(value ? { value } : {}),
    ...(isObject(input.rawPayload) ? { rawPayload: input.rawPayload } : {}),
  };
}

function parseSuggestion(input: unknown): WorkObjectSuggestionInput {
  if (!isObject(input)) throw new Error("Work Object suggestion request requires suggestion");
  const fieldId = readString(input.fieldId);
  if (!fieldId) throw new Error("Work Object suggestion request requires suggestion.fieldId");
  const query = readString(input.query);
  return {
    fieldId,
    ...(query ? { query } : {}),
    ...(isObject(input.rawPayload) ? { rawPayload: input.rawPayload } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
