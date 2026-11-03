export type McpPublicErrorCode =
  | "mcp_unauthorized"
  | "mcp_forbidden"
  | "mcp_rate_limited"
  | "mcp_daemon_offline"
  | "insufficient_scope"
  | "invalid_target"
  | "payload_invalid"
  | "not_found"
  | "method_not_allowed"
  | "internal_error";

export class McpHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: McpPublicErrorCode,
    message?: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message ?? code);
    this.name = "McpHttpError";
  }

  withHeaders(headers: Record<string, string>): McpHttpError {
    return new McpHttpError(this.status, this.code, this.message, { ...this.headers, ...headers });
  }
}

export function jsonError(
  status: number,
  code: McpPublicErrorCode,
  requestId: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: code, requestId }), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
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
      "X-Ravi-Request-Id": requestId,
    },
  });
}
