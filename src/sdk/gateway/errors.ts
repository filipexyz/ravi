/**
 * Shared JSON response helpers for the gateway.
 */

import {
  contractFailureOutcome,
  type ContractError,
  type ContractErrorEnvelope,
  type ContractFailureOutcome,
} from "../../cli/agent-contract.js";

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

export interface GatewayContractErrorBody extends ContractErrorEnvelope {
  /** CLI-compatible exit taxonomy, retained for non-CLI consumers. */
  exitCode: number;
  outcome: ContractFailureOutcome | "denied";
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

/**
 * Translate a CLI contract failure without flattening it into InternalError.
 * HTTP status communicates the broad class; the body remains the canonical
 * contract envelope and carries the original CLI exit code losslessly.
 */
export function contractErrorResponse(
  error: ContractError,
  statusOverride?: number,
  outcomeOverride?: GatewayContractErrorBody["outcome"],
): Response {
  const status = statusOverride ?? (error.exitCode === 2 ? 400 : error.exitCode === 3 ? 409 : 422);
  const body: GatewayContractErrorBody = {
    ...error.envelope(),
    exitCode: error.exitCode,
    outcome: outcomeOverride ?? contractFailureOutcome(error),
  };
  return json(status, body);
}

export function returnShapeError(issues: JsonIssue[]): Response {
  return errorResponse(500, "ReturnShapeError", { issues });
}

export function badRequest(message: string): Response {
  return errorResponse(400, "BadRequest", { message });
}
