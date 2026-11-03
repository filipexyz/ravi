/**
 * Coarse public error codes returned to CLI/UI clients. Detailed provider
 * errors stay in Worker logs only — never in this surface.
 */
export type ConnectorPublicErrorCode =
  | "connector_unauthorized"
  | "connector_unavailable"
  | "connector_permission_required"
  | "connector_capability_unsupported"
  | "connector_rate_limited"
  | "connector_provider_error"
  | "connector_reauth_required"
  | "connector_stepup_required"
  | "connector_stepup_rejected"
  | "connector_disabled_by_org"
  | "connector_forbidden"
  | "connector_connect_unavailable"
  | "connector_group_blocked"
  | "connector_speaker_not_owner"
  | "connector_tool_blocked"
  | "connector_approval_required"
  | "connector_approval_pending"
  | "connector_approval_denied"
  | "connector_approval_invalid"
  | "connector_consent_required"
  | "connector_not_linked"
  | "connector_connection_required"
  | "connector_policy_above_ceiling"
  | "connector_exec_context_invalid"
  | "payload_invalid"
  | "method_not_allowed"
  | "not_implemented"
  | "not_found"
  | "internal_error";

export class ConnectorHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ConnectorPublicErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "ConnectorHttpError";
  }
}

export function jsonError(
  status: number,
  code: ConnectorPublicErrorCode,
  requestId: string,
  details?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({ error: code, requestId, ...(details ?? {}) }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-Ravi-Request-Id": requestId,
      },
    },
  );
}

export function jsonSuccess(body: unknown, requestId: string, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "Content-Type": "application/json",
      "X-Ravi-Request-Id": requestId,
    },
  });
}
