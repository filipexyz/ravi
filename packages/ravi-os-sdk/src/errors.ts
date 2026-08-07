/**
 * Error hierarchy thrown by `@ravi-os/sdk` transports.
 *
 * Both the HTTP and in-process transports normalise gateway responses into
 * these classes so callers can write provider-agnostic catch blocks.
 *
 *   try {
 *     await client.artifacts.show("art_x");
 *   } catch (e) {
 *     if (e instanceof RaviValidationError) {
 *       for (const issue of e.issues) console.log(issue.path, issue.message);
 *     } else if (e instanceof RaviAuthError) {
 *       // refresh context key, retry, etc.
 *     }
 *   }
 */

export type AuthFailureReason = "missing" | "malformed" | "unknown" | "revoked" | "expired" | null;

export interface RaviIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

export interface RaviErrorBody {
  error: string;
  message?: string;
  issues?: RaviIssue[];
  reason?: string;
  [key: string]: unknown;
}

export type RaviContractOutcome = "blocked" | "usage_error" | "failed";

export interface RaviContractErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  [key: string]: unknown;
}

/** Canonical command-contract failure returned by the Ravi gateway. */
export interface RaviContractErrorBody {
  success: false;
  op: string;
  error: RaviContractErrorPayload;
  exitCode: 1 | 2 | 3;
  outcome: RaviContractOutcome;
  [key: string]: unknown;
}

/** Legacy gateway errors and the canonical command-contract envelope. */
export type RaviGatewayErrorBody = RaviErrorBody | RaviContractErrorBody;

/** Base class for every error raised by SDK transports. */
export class RaviError extends Error {
  /** Numeric HTTP status code if the error came from the gateway. */
  public readonly status: number;
  /** Raw body of the gateway response (parsed JSON, when available). */
  public readonly body: RaviGatewayErrorBody | null;
  /** Logical command path that triggered the error, e.g. `"artifacts.show"`. */
  public readonly command: string | null;

  constructor(message: string, status: number, body: RaviGatewayErrorBody | null = null, command: string | null = null) {
    super(message);
    this.name = "RaviError";
    this.status = status;
    this.body = body;
    this.command = command;
  }
}

/** Structured CLI-contract failure preserved by both SDK transports. */
export class RaviContractError extends RaviError {
  public readonly op: string;
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly exitCode: 1 | 2 | 3;
  public readonly outcome: RaviContractOutcome;
  public readonly contractBody: RaviContractErrorBody;

  constructor(status: number, body: RaviContractErrorBody, command: string | null = null) {
    super(body.error.message, status, body, command);
    this.name = "RaviContractError";
    this.op = body.op;
    this.code = body.error.code;
    this.retryable = body.error.retryable;
    this.exitCode = body.exitCode;
    this.outcome = body.outcome;
    this.contractBody = body;
  }
}

/** 401 — missing, malformed, expired, or revoked context-key. */
export class RaviAuthError extends RaviError {
  public readonly reason: AuthFailureReason;
  constructor(message: string, body: RaviErrorBody | null = null, command: string | null = null) {
    super(message, 401, body, command);
    this.name = "RaviAuthError";
    const reason = body && typeof body.reason === "string" ? body.reason : null;
    this.reason = mapReason(reason);
  }
}

/** 403 — scope check denied the request. */
export class RaviPermissionError extends RaviError {
  public readonly reason: string;
  constructor(message: string, body: RaviErrorBody | null = null, command: string | null = null) {
    super(message, 403, body, command);
    this.name = "RaviPermissionError";
    this.reason = body && typeof body.reason === "string" ? body.reason : message;
  }
}

/** 4xx (other than 401/403) — usually 400 ValidationError with `issues[]`. */
export class RaviValidationError extends RaviError {
  public readonly issues: RaviIssue[];
  constructor(
    message: string,
    issues: RaviIssue[],
    status = 400,
    body: RaviErrorBody | null = null,
    command: string | null = null,
  ) {
    super(message, status, body, command);
    this.name = "RaviValidationError";
    this.issues = issues;
  }
}

/** 5xx — internal failure inside the gateway or the underlying handler. */
export class RaviInternalError extends RaviError {
  constructor(message: string, body: RaviErrorBody | null = null, status = 500, command: string | null = null) {
    super(message, status, body, command);
    this.name = "RaviInternalError";
  }
}

/** Network failure, timeout, or unexpected gateway response shape. */
export class RaviTransportError extends RaviError {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown, command: string | null = null) {
    super(message, 0, null, command);
    this.name = "RaviTransportError";
    if (cause !== undefined) this.cause = cause;
  }
}

function mapReason(value: string | null): AuthFailureReason {
  switch (value) {
    case "missing":
    case "malformed":
    case "unknown":
    case "revoked":
    case "expired":
      return value;
    default:
      return null;
  }
}

/**
 * Build the right error subclass from a gateway error response.
 * Internal helper used by transports to keep mapping in one place.
 */
export function buildErrorFromGateway(
  status: number,
  body: RaviGatewayErrorBody | null,
  command: string | null,
): RaviError {
  if (isRaviContractErrorBody(body)) return new RaviContractError(status, body, command);
  const message = pickMessage(body) ?? `Ravi gateway returned status ${status}`;
  if (status === 401) return new RaviAuthError(message, body, command);
  if (status === 403) return new RaviPermissionError(message, body, command);
  if (status >= 400 && status < 500) {
    const issues = Array.isArray(body?.issues) ? (body!.issues as RaviIssue[]) : [];
    return new RaviValidationError(message, issues, status, body, command);
  }
  if (status >= 500) return new RaviInternalError(message, body, status, command);
  return new RaviError(message, status, body, command);
}

/** Runtime guard for consumers that inspect raw SDK error bodies. */
export function isRaviContractErrorBody(body: RaviGatewayErrorBody | null): body is RaviContractErrorBody {
  if (!body || body.success !== false || typeof body.op !== "string") return false;
  if (body.exitCode !== 1 && body.exitCode !== 2 && body.exitCode !== 3) return false;
  if (body.outcome !== "blocked" && body.outcome !== "usage_error" && body.outcome !== "failed") return false;
  if (typeof body.error !== "object" || body.error === null) return false;
  return (
    typeof body.error.code === "string" &&
    typeof body.error.message === "string" &&
    typeof body.error.retryable === "boolean"
  );
}

function pickMessage(body: RaviErrorBody | null): string | null {
  if (!body) return null;
  if (typeof body.message === "string" && body.message) return body.message;
  if (typeof body.reason === "string" && body.reason) return body.reason;
  if (typeof body.error === "string" && body.error) return body.error;
  return null;
}
