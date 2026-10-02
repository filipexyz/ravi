/**
 * Client-side WhatsApp RPC errors.
 *
 * Every failure of a WhatsApp RPC call (runner unavailable, timeout, invalid response,
 * runner-side error body, client-side validation, not bound) surfaces as a
 * `WhatsAppRpcError`. It is a `ChannelTransportError`, so `status` is the retry
 * contract (5xx = retryable unless `retryable` says otherwise) and outbound callers can
 * treat it like any other channel transport failure.
 */

import { ChannelTransportError, type ChannelTransportErrorInit } from "../outbound/errors.js";
import { WHATSAPP_RPC_ERROR_CODES, type WhatsAppRpcMethod } from "./contract.js";

export interface WhatsAppRpcErrorInit extends ChannelTransportErrorInit {
  method?: WhatsAppRpcMethod;
  instanceId?: string;
}

export class WhatsAppRpcError extends ChannelTransportError {
  readonly method?: WhatsAppRpcMethod;
  readonly instanceId?: string;

  constructor(message: string, init: WhatsAppRpcErrorInit) {
    super(message, init);
    this.name = "WhatsAppRpcError";
    if (init.method !== undefined) this.method = init.method;
    if (init.instanceId !== undefined) this.instanceId = init.instanceId;
  }
}

export function isWhatsAppRpcError(err: unknown): err is WhatsAppRpcError {
  return err instanceof WhatsAppRpcError;
}

/** `err` is a WhatsAppRpcError with code WHATSAPP_RUNNER_UNAVAILABLE (no runner answered, or NATS is down). */
export function isWhatsAppRunnerUnavailable(err: unknown): boolean {
  return isWhatsAppRpcError(err) && err.code === WHATSAPP_RPC_ERROR_CODES.runnerUnavailable;
}
