/**
 * Shared JSON response helpers for the gateway.
 */

export interface JsonIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

export interface ErrorBody {
  error: string;
  message?: string;
  issues?: JsonIssue[];
  [key: string]: unknown;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS } });
}

export function errorResponse(status: number, error: string, extras: Record<string, unknown> = {}): Response {
  const body: ErrorBody = { error, ...extras };
  return json(status, body);
}

export function notFound(path: string): Response {
  return errorResponse(404, "NotFound", { path });
}

export function methodNotAllowed(method: string, path: string): Response {
  return errorResponse(405, "MethodNotAllowed", { method, path });
}

export function validationError(issues: JsonIssue[]): Response {
  return errorResponse(400, "ValidationError", { issues });
}

export function permissionDenied(reason: string): Response {
  return errorResponse(403, "PermissionDenied", { reason });
}

export function unauthorized(reason: string): Response {
  return errorResponse(401, "Unauthorized", { reason });
}

export function internalError(message: string): Response {
  return errorResponse(500, "InternalError", { message });
}

export function returnShapeError(issues: JsonIssue[]): Response {
  return errorResponse(500, "ReturnShapeError", { issues });
}

export function badRequest(message: string): Response {
  return errorResponse(400, "BadRequest", { message });
}
