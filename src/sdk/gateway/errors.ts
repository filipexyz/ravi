/**
 * Shared JSON response helpers for the gateway.
 */

import {
  ContractError,
  CONTRACT_EXIT_ERROR,
  contractFailureOutcome,
  sanitizePublicContractMessage,
  type ContractErrorEnvelope,
  type ContractFailureOutcome,
} from "../../cli/agent-contract.js";
import { logGatewayFailure } from "./diagnostics.js";
import { gatewayRequestContext } from "./request-context.js";

export interface JsonIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

export interface GatewayContractErrorBody extends ContractErrorEnvelope {
  error: ContractErrorEnvelope["error"] & { requestId: string; diagnosticRequestId?: string };
  /** CLI-compatible exit taxonomy, retained for non-CLI consumers. */
  exitCode: number;
  outcome: ContractFailureOutcome | "denied";
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS } });
}

export function errorResponse(status: number, error: string, extras: Record<string, unknown> = {}): Response {
  const catalog: Record<string, [string, string, string]> = {
    NotFound: ["ROUTE_NOT_FOUND", "Gateway route not found.", "Check the operation in /api/v1/_meta/registry"],
    MethodNotAllowed: [
      "METHOD_NOT_ALLOWED",
      "HTTP method is not supported for this route.",
      "Use POST for commands and GET for metadata or streams",
    ],
    ValidationError: ["VALIDATION_ERROR", "Request input is invalid.", "Correct the fields listed in issues"],
    PermissionDenied: [
      "PERMISSION_DENIED",
      "Gateway access denied.",
      "Request the required permission before retrying",
    ],
    ConsoleAuthorityRequired: [
      "CONSOLE_AUTHORITY_REQUIRED",
      "This command requires signed authority on the dedicated Console listener.",
      "Use the dedicated Console listener with a valid signed delegation",
    ],
    Unauthorized: [
      "AUTH_REQUIRED",
      "Gateway authentication failed.",
      "Refresh the runtime context credential before retrying",
    ],
    PayloadTooLarge: [
      "PAYLOAD_TOO_LARGE",
      "Request body exceeds the gateway size limit.",
      "Reduce the request body size before retrying",
    ],
    BadRequest: ["BAD_REQUEST", "Request body is invalid.", "Send a flat JSON object with valid command fields"],
    InternalError: [
      "UNHANDLED_ERROR",
      "Gateway processing failed.",
      "Report this requestId to the operator; do not automatically retry the command",
    ],
  };
  const [code, message, suggestedAction] = catalog[error] ?? [
    "GATEWAY_ERROR",
    `Gateway rejected the request (HTTP ${status}).`,
    "Report this requestId to the operator",
  ];
  // Transport reasons can contain caller values. Only explicit public message/issue fields cross.
  const publicMessage =
    status < 500 && typeof extras.message === "string" ? sanitizePublicContractMessage(extras.message) : undefined;
  return contractErrorResponse(
    new ContractError(
      gatewayRequestContext().op,
      code,
      publicMessage ?? message,
      [400, 405, 413, 422].includes(status) ? 2 : 1,
      {
        suggestedAction,
        ...(Array.isArray(extras.issues) ? { issues: extras.issues } : {}),
        ...(typeof extras.limitBytes === "number" ? { limitBytes: extras.limitBytes } : {}),
      },
    ),
    status,
  );
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
  const status =
    statusOverride ??
    (error.code === "PERMISSION_DENIED"
      ? 403
      : error.code === "VALIDATION_ERROR"
        ? 422
        : error.exitCode === 2
          ? 400
          : error.exitCode === 3
            ? 409
            : 422);
  const { requestId, diagnosticRequestId } = gatewayRequestContext();
  const envelope = error.envelope();
  const safeMessage = sanitizePublicContractMessage(envelope.error.message);
  const legacyGeneric =
    /^(?:Remote command failed\.?|Command could not be completed\.?|Command failed unexpectedly\.?)$/.test(
      safeMessage ?? "",
    );
  const safeAction = sanitizePublicContractMessage(envelope.error.suggestedAction);
  const body: GatewayContractErrorBody = {
    ...envelope,
    error: {
      ...envelope.error,
      message:
        error.code === "UNHANDLED_ERROR"
          ? `${error.op} failed internally. Report the requestId to the operator before retrying.`
          : ((!legacyGeneric ? safeMessage : undefined) ??
            `${error.op} failed (${error.code}). Report this requestId to the operator.`),
      suggestedAction:
        error.code === "UNHANDLED_ERROR"
          ? "Report the operation and requestId to the operator; do not automatically retry the command"
          : ((safeAction && !/^Inspect redacted (?:remote|runtime) logs/.test(safeAction) ? safeAction : undefined) ??
            `Check '${error.op} --help' and correct the input before retrying`),
      requestId,
      ...(diagnosticRequestId ? { diagnosticRequestId } : {}),
    },
    exitCode: error.exitCode,
    outcome: outcomeOverride ?? contractFailureOutcome(error),
  };
  const response = json(status, body);
  response.headers.set("x-request-id", requestId);
  return response;
}

export function returnShapeError(op: string, issues: JsonIssue[]): Response {
  const error = new ContractError(
    op,
    "RETURN_SHAPE_ERROR",
    "Command returned an invalid response shape.",
    CONTRACT_EXIT_ERROR,
    {
      suggestedAction: "Report the invalid SDK return contract to the command owner",
      issues,
    },
  );
  logGatewayFailure(error, error.code);
  return contractErrorResponse(error, 500);
}

export function badRequest(message: string): Response {
  return errorResponse(400, "BadRequest", { message });
}
