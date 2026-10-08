/**
 * ExecutorRelay frames (Console `pages/app-gateway/relay` SPEC, Frames).
 *
 * Every frame is one JSON object in a WebSocket text frame. Binary frames,
 * unknown `type` values, extra fields, and frames above the cap are protocol
 * errors: the executor closes with 4003 and reconnects.
 */

import {
  CONTROL_FRAME_MAX_BYTES,
  INVOKE_FRAME_MAX_BYTES,
  type ExecutorErrorCode,
  isAppId,
  isOperationId,
  isUuid,
} from "./constants.js";

export const PING_FRAME = '{"type":"ping"}';
export const PONG_FRAME = '{"type":"pong"}';

export interface RelayReadyFrame {
  type: "relay.ready";
  v: 1;
  installationId: string;
  ticketExpiresAt: number;
  maxFrameBytes: number;
  invokeTimeoutMs: number;
  pingIntervalMs: number;
}

export interface AppsInvokeFrame {
  type: "apps.invoke";
  v: 1;
  requestId: string;
  appId: string;
  operation: string;
  assertion: string;
  grant: string;
  body: Record<string, unknown>;
}

export type InboundFrame =
  | { kind: "ready"; frame: RelayReadyFrame }
  | { kind: "pong" }
  | { kind: "invoke"; frame: AppsInvokeFrame }
  /** Shape is right but a field fails step 1: answer `payload_invalid` on that request id. */
  | { kind: "invalid-invoke"; requestId: string }
  | { kind: "protocol-error"; reason: string };

const READY_KEYS = [
  "type",
  "v",
  "installationId",
  "ticketExpiresAt",
  "maxFrameBytes",
  "invokeTimeoutMs",
  "pingIntervalMs",
];
const INVOKE_KEYS = ["type", "v", "requestId", "appId", "operation", "assertion", "grant", "body"];
const MAX_ECHOED_REQUEST_ID_CHARS = 128;

/** Parse one inbound frame. `isBinary` frames are always protocol errors. */
export function parseInboundFrame(data: string | Buffer, isBinary: boolean): InboundFrame {
  if (isBinary) return protocolError("binary frame");
  const text = typeof data === "string" ? data : data.toString("utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > INVOKE_FRAME_MAX_BYTES) return protocolError("frame above cap");
  if (text === PONG_FRAME) return { kind: "pong" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return protocolError("frame is not JSON");
  }
  if (!isPlainObject(parsed)) return protocolError("frame is not an object");

  if (parsed.type === "apps.invoke") return parseInvoke(parsed);
  if (bytes > CONTROL_FRAME_MAX_BYTES) return protocolError("control frame above cap");
  if (parsed.type === "relay.ready") return parseReady(parsed);
  if (parsed.type === "pong") {
    return Object.keys(parsed).length === 1 ? { kind: "pong" } : protocolError("extra fields");
  }
  return protocolError("unknown frame type");
}

function parseReady(frame: Record<string, unknown>): InboundFrame {
  if (!hasExactKeys(frame, READY_KEYS) || frame.v !== 1) return protocolError("relay.ready shape");
  const { installationId, ticketExpiresAt, maxFrameBytes, invokeTimeoutMs, pingIntervalMs } = frame;
  if (
    !isUuid(installationId) ||
    !isPositiveInteger(ticketExpiresAt) ||
    !isPositiveInteger(maxFrameBytes) ||
    !isPositiveInteger(invokeTimeoutMs) ||
    !isPositiveInteger(pingIntervalMs)
  ) {
    return protocolError("relay.ready fields");
  }
  return { kind: "ready", frame: frame as unknown as RelayReadyFrame };
}

function parseInvoke(frame: Record<string, unknown>): InboundFrame {
  const extra = Object.keys(frame).filter((key) => !INVOKE_KEYS.includes(key));
  if (extra.length > 0 || frame.v !== 1) return protocolError("apps.invoke shape");
  const requestId = frame.requestId;
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > MAX_ECHOED_REQUEST_ID_CHARS) {
    return protocolError("apps.invoke requestId");
  }
  if (
    !isUuid(requestId) ||
    !isAppId(frame.appId) ||
    !isOperationId(frame.operation) ||
    typeof frame.assertion !== "string" ||
    typeof frame.grant !== "string" ||
    !isPlainObject(frame.body)
  ) {
    return { kind: "invalid-invoke", requestId };
  }
  return { kind: "invoke", frame: frame as unknown as AppsInvokeFrame };
}

export function serializeResultFrame(requestId: string, body: unknown): string {
  return JSON.stringify({ type: "apps.result", v: 1, requestId, status: 200, body: body ?? null });
}

export function serializeErrorFrame(requestId: string, error: ExecutorErrorCode): string {
  return JSON.stringify({ type: "apps.error", v: 1, requestId, error });
}

function protocolError(reason: string): InboundFrame {
  return { kind: "protocol-error", reason };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
