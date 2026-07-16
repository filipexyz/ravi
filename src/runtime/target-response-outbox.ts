import type { MessageTarget, ResponseMessage } from "./message-types.js";
import { sha256Text } from "../session-trace/session-trace-db.js";
import type { JsonValue, SessionEventRecord } from "../session-trace/types.js";

export interface RuntimeTargetResponseOutbox {
  emitId: string;
  response: string;
  target: MessageTarget;
  metadata?: ResponseMessage["metadata"];
  instanceId: string;
  version: number;
}

// This outbox is intentionally at-least-once. It prevents a committed logical
// response from being lost before dispatch, but a process crash after provider
// success and before acknowledgement can cause the same event to be delivered
// again. Provider-level exactly-once delivery is outside target failover.

export function createRuntimeTargetResponseEmitId(logicalTurnId: string): string {
  return `rt_${sha256Text(logicalTurnId).slice(0, 24)}`;
}

export function readRuntimeTargetResponseOutbox(
  event: SessionEventRecord,
): { sessionName: string; response: ResponseMessage; instanceId: string } | null {
  if (!event.sessionName || !isRecord(event.payloadJson)) return null;
  const value = event.payloadJson.responseOutbox;
  if (!isRecord(value)) return null;
  const emitId = readString(value.emitId);
  const response = readString(value.response);
  const instanceId = readString(value.instanceId);
  const version = typeof value.version === "number" && Number.isFinite(value.version) ? value.version : 2;
  if (!emitId || !response || !instanceId || !isMessageTarget(value.target)) return null;
  return {
    sessionName: event.sessionName,
    instanceId,
    response: {
      response,
      target: value.target as unknown as MessageTarget,
      ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
      _emitId: emitId,
      _v: version,
    } as ResponseMessage,
  };
}

function isMessageTarget(value: JsonValue | undefined): boolean {
  return (
    isRecord(value) &&
    Boolean(readString(value.channel)) &&
    Boolean(readString(value.accountId)) &&
    Boolean(readString(value.chatId))
  );
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
