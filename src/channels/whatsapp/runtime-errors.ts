/**
 * Typed errors thrown by `WhatsAppRuntime` methods.
 *
 * Every method the RPC server calls throws `WhatsAppRuntimeError`, which carries
 * the HTTP-like `status` and the stable `code` from `WHATSAPP_RPC_ERROR_CODES`,
 * so the server can answer `{ok:false, error:{status, code, message}}` without
 * re-classifying anything.
 */

import { ZodError } from "zod";
import { WHATSAPP_RPC_ERROR_CODES, type WhatsAppRpcErrorBody } from "./contract.js";
import { ErrorCode as WhatsAppChannelErrorCode, type ErrorCodeType, mapBaileysError } from "./lib/utils/errors.js";
import { isRateLimitError } from "./lib/utils/rate-limit.js";

export type WhatsAppRuntimeErrorCode = (typeof WHATSAPP_RPC_ERROR_CODES)[keyof typeof WHATSAPP_RPC_ERROR_CODES];

/** HTTP-like status per code. The daemon's WhatsApp sender decides retries from status + code (sender.ts). */
export const WHATSAPP_RUNTIME_ERROR_STATUS: Readonly<Record<WhatsAppRuntimeErrorCode, number>> = {
  [WHATSAPP_RPC_ERROR_CODES.invalidRequest]: 400,
  [WHATSAPP_RPC_ERROR_CODES.notFound]: 404,
  [WHATSAPP_RPC_ERROR_CODES.notBound]: 404,
  [WHATSAPP_RPC_ERROR_CODES.pairingRequired]: 409,
  [WHATSAPP_RPC_ERROR_CODES.rateLimited]: 429,
  [WHATSAPP_RPC_ERROR_CODES.transportError]: 502,
  [WHATSAPP_RPC_ERROR_CODES.notConnected]: 503,
  [WHATSAPP_RPC_ERROR_CODES.runnerUnavailable]: 503,
  [WHATSAPP_RPC_ERROR_CODES.timeout]: 504,
};

export interface WhatsAppRuntimeErrorOptions {
  cause?: unknown;
  /** WhatsApp channel error code (`WHATSAPP_SEND_FAILED`, ...), kept for logs. */
  channelCode?: ErrorCodeType;
  /** Minimum wait before a retry (RATE_LIMITED: the runtime's current backoff). */
  retryAfterMs?: number;
}

export class WhatsAppRuntimeError extends Error {
  readonly status: number;
  readonly code: WhatsAppRuntimeErrorCode;
  readonly channelCode?: ErrorCodeType;
  readonly retryAfterMs?: number;

  constructor(code: WhatsAppRuntimeErrorCode, message: string, options: WhatsAppRuntimeErrorOptions = {}) {
    super(message);
    this.name = "WhatsAppRuntimeError";
    this.code = code;
    this.status = WHATSAPP_RUNTIME_ERROR_STATUS[code];
    if (options.channelCode) this.channelCode = options.channelCode;
    if (options.retryAfterMs !== undefined && Number.isFinite(options.retryAfterMs) && options.retryAfterMs >= 0) {
      this.retryAfterMs = Math.ceil(options.retryAfterMs);
    }
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** The `error` member of a failed `WhatsAppRpcResponse`. */
  toRpcError(): WhatsAppRpcErrorBody {
    return {
      message: this.message,
      status: this.status,
      code: this.code,
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

export function invalidRequest(message: string, cause?: unknown): WhatsAppRuntimeError {
  return new WhatsAppRuntimeError(WHATSAPP_RPC_ERROR_CODES.invalidRequest, message, { cause });
}

export function notConnected(message: string): WhatsAppRuntimeError {
  return new WhatsAppRuntimeError(WHATSAPP_RPC_ERROR_CODES.notConnected, message, {
    channelCode: WhatsAppChannelErrorCode.NOT_CONNECTED,
  });
}

const CHANNEL_CODE_TO_RUNTIME: Partial<Record<ErrorCodeType, WhatsAppRuntimeErrorCode>> = {
  [WhatsAppChannelErrorCode.NOT_CONNECTED]: WHATSAPP_RPC_ERROR_CODES.notConnected,
  [WhatsAppChannelErrorCode.INVALID_JID]: WHATSAPP_RPC_ERROR_CODES.invalidRequest,
  [WhatsAppChannelErrorCode.INVALID_PHONE]: WHATSAPP_RPC_ERROR_CODES.invalidRequest,
  [WhatsAppChannelErrorCode.RATE_LIMITED]: WHATSAPP_RPC_ERROR_CODES.rateLimited,
};

/**
 * Classify any failure from a runtime operation.
 *
 * - `WhatsAppRuntimeError` passes through.
 * - Zod validation failures are 400 `INVALID_REQUEST`.
 * - Baileys/Boom errors go through `mapBaileysError` (lib/utils/errors.ts); rate limits
 *   (429 or a rate-overlimit message) become 429 `RATE_LIMITED`, "not connected" becomes 503,
 *   invalid JID/phone becomes 400, everything else is 502 `TRANSPORT_ERROR` (the
 *   ported REST API answered every failed send with 502 `CHANNEL_SEND_FAILED`).
 */
export function toWhatsAppRuntimeError(error: unknown, options: { retryAfterMs?: number } = {}): WhatsAppRuntimeError {
  if (error instanceof WhatsAppRuntimeError) return error;
  if (error instanceof ZodError) {
    return invalidRequest(error.issues.map((issue) => issue.message).join("; ") || "invalid params", error);
  }
  if (isRateLimitError(error)) {
    return new WhatsAppRuntimeError(WHATSAPP_RPC_ERROR_CODES.rateLimited, errorMessage(error), {
      cause: error,
      channelCode: WhatsAppChannelErrorCode.RATE_LIMITED,
      retryAfterMs: options.retryAfterMs,
    });
  }
  const mapped = mapBaileysError(error);
  const code = CHANNEL_CODE_TO_RUNTIME[mapped.channelCode] ?? WHATSAPP_RPC_ERROR_CODES.transportError;
  return new WhatsAppRuntimeError(code, mapped.message, {
    cause: error,
    channelCode: mapped.channelCode,
    ...(code === WHATSAPP_RPC_ERROR_CODES.rateLimited ? { retryAfterMs: options.retryAfterMs } : {}),
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
