export type ChannelPublicErrorCode =
  | "channel_unauthorized"
  | "channel_permission_required"
  | "channel_host_unavailable"
  | "channel_instance_not_found"
  | "channel_instance_unavailable"
  | "channel_idempotency_required"
  | "channel_operation_conflict"
  | "channel_rate_limited"
  | "channel_payload_invalid"
  | "channel_qr_unavailable"
  | "channel_pairing_unavailable"
  | "channel_key_rotation_failed"
  | "channel_provider_error"
  | "not_found"
  | "internal_error";

export class ChannelHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ChannelPublicErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "ChannelHttpError";
  }
}

export function jsonError(
  status: number,
  code: ChannelPublicErrorCode,
  requestId: string,
  details?: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({ error: code, requestId, ...(details ?? {}) }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Ravi-Request-Id": requestId,
    },
  });
}

export function jsonSuccess(body: unknown, requestId: string, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Ravi-Request-Id": requestId,
    },
  });
}
