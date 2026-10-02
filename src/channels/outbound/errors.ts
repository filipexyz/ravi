/**
 * Transport-neutral outbound errors.
 *
 * `status` is HTTP-like and is the retry contract shared by every channel transport:
 * 5xx is retryable unless the error says otherwise.
 */

export const CHANNEL_TRANSPORT_ERROR_CODES = {
  /** 503, not retryable: the instance needs the legacy bridge and none is configured. */
  legacyBridgeNotConfigured: "LEGACY_BRIDGE_NOT_CONFIGURED",
  /** 404, not retryable: no instances record (default-deny). */
  instanceNotFound: "INSTANCE_NOT_FOUND",
  /** 422, not retryable: a WhatsApp-family provider ravi does not serve (twilio-whatsapp, gupshup, …). */
  providerUnsupported: "CHANNEL_PROVIDER_UNSUPPORTED",
  /** 400. */
  invalidRequest: "INVALID_REQUEST",
} as const;

export interface ChannelTransportErrorInit {
  status: number;
  code: string;
  /** Default: status >= 500. */
  retryable?: boolean;
  /** Minimum wait before a retry, when the transport asked for one (e.g. rate limiting). */
  retryAfterMs?: number;
  details?: unknown;
  cause?: unknown;
}

export class ChannelTransportError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: unknown;

  constructor(message: string, init: ChannelTransportErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ChannelTransportError";
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable ?? init.status >= 500;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (init.details !== undefined) this.details = init.details;
  }
}

/**
 * ChannelTransportError → err.retryable. TypeError → true (network). Any other object with numeric
 * `status` → status >= 500 (the legacy bridge client's HTTP errors keep their behaviour). Everything
 * else → false.
 */
export function isRetryableTransportError(err: unknown): boolean {
  if (err instanceof ChannelTransportError) return err.retryable;
  if (err instanceof TypeError) return true;
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: unknown }).status;
    return typeof status === "number" && status >= 500;
  }
  return false;
}
