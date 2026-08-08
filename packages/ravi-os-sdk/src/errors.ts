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

export type RaviContractOutcome = "blocked" | "usage_error" | "denied" | "failed";

export interface RaviContractErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  suggestedAction?: string;
  suggestions?: string[];
  acceptedFlags?: string[];
  acceptedPositionals?: string[];
  acceptedValues?: string[];
  usage?: string;
  dryRun?: boolean;
  plan?: Record<string, unknown>;
  issues?: RaviIssue[];
  status?: number;
}

/** Canonical command-contract failure returned by the Ravi gateway. */
export interface RaviContractErrorBody {
  success: false;
  op: string;
  error: RaviContractErrorPayload;
  exitCode: 1 | 2 | 3;
  outcome: RaviContractOutcome;
}

/** Legacy gateway errors and the canonical command-contract envelope. */
export type RaviGatewayErrorBody = RaviErrorBody | RaviContractErrorBody;

/** Base class for every error raised by SDK transports. */
export class RaviError extends Error {
  /** Numeric HTTP status code if the error came from the gateway. */
  public readonly status: number;
  /** Parsed gateway body; canonical contract failures are projected to safe public fields. */
  public readonly body: RaviGatewayErrorBody | null;
  /** Logical command path that triggered the error, e.g. `"artifacts.show"`. */
  public readonly command: string | null;

  constructor(
    message: string,
    status: number,
    body: RaviGatewayErrorBody | null = null,
    command: string | null = null,
  ) {
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
    const projectedBody = projectContractErrorBody(body);
    super(projectedBody.error.message, status, projectedBody, command);
    this.name = "RaviContractError";
    this.op = projectedBody.op;
    this.code = projectedBody.error.code;
    this.retryable = projectedBody.error.retryable;
    this.exitCode = projectedBody.exitCode;
    this.outcome = projectedBody.outcome;
    this.contractBody = projectedBody;
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
  const expectedOutcomes =
    body.exitCode === 1 ? ["failed", "denied"] : body.exitCode === 2 ? ["usage_error"] : ["blocked"];
  if (typeof body.outcome !== "string" || !expectedOutcomes.includes(body.outcome)) return false;
  if (typeof body.error !== "object" || body.error === null) return false;
  const validShape =
    typeof body.error.code === "string" &&
    typeof body.error.message === "string" &&
    typeof body.error.retryable === "boolean";
  if (!validShape) return false;
  if (body.outcome === "denied" && body.error.code !== "PERMISSION_DENIED") return false;
  if (body.error.code === "PERMISSION_DENIED" && body.outcome !== "denied") return false;
  return true;
}

const CONTRACT_DETAIL_STRING_KEYS = ["suggestedAction", "usage"] as const;
const CONTRACT_DETAIL_STRING_LIST_KEYS = [
  "suggestions",
  "acceptedFlags",
  "acceptedPositionals",
  "acceptedValues",
] as const;
const CONTRACT_DETAIL_MAX_ITEMS = 64;
const CONTRACT_DETAIL_MAX_DEPTH = 8;
const RCTX_TOKEN_PATTERN = /rctx_[A-Za-z0-9_-]+/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const API_TOKEN_PATTERN = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g;
const REDACTION_MARKER_PATTERN = /^\[REDACTED(?::(?:path|rctx|token|content(?: length=\d+)?))?\]$/;
const CONTENT_KEY_PATTERN = /^(?:body|caption|content|message|output|prompt|text)$/i;
const SECRET_KEY_SEGMENTS = new Set(["password", "passwords", "secret", "secrets", "token", "tokens"]);
const SAFE_NUMERIC_SECRET_SUFFIXES = new Set(["chars", "count", "length"]);
const SECRET_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "contextkey",
  "credentialref",
  "credentialsref",
  "password",
  "refreshtoken",
  "secret",
  "secretref",
  "token",
]);
const RAW_CONTRACT_KEYS = new Set([
  "errorbody",
  "providerbody",
  "providererror",
  "providerresponse",
  "raw",
  "rawbody",
  "rawerror",
  "rawpayload",
  "rawresponse",
  "responsebody",
  "stack",
  "stacktrace",
]);

/** Keep the SDK contract transport-independent without retaining arbitrary gateway fields. */
function projectContractErrorBody(body: RaviContractErrorBody): RaviContractErrorBody {
  const remote = body.error as RaviContractErrorPayload & Record<string, unknown>;
  const error: RaviContractErrorPayload = {
    code: remote.code,
    message: remote.message,
    retryable: remote.retryable,
  };

  for (const key of CONTRACT_DETAIL_STRING_KEYS) {
    const value = remote[key];
    if (typeof value === "string") error[key] = sanitizeContractString(value);
  }
  for (const key of CONTRACT_DETAIL_STRING_LIST_KEYS) {
    const value = boundedContractStringList(remote[key]);
    if (value) error[key] = value;
  }
  if (typeof remote.dryRun === "boolean") error.dryRun = remote.dryRun;
  if (typeof remote.status === "number" && Number.isFinite(remote.status)) error.status = remote.status;
  const issues = projectContractIssues(remote.issues);
  if (issues) error.issues = issues;
  if (isRecord(remote.plan)) {
    error.plan = sanitizeContractPublicValue(remote.plan) as Record<string, unknown>;
  }

  return {
    success: false,
    op: body.op,
    error,
    exitCode: body.exitCode,
    outcome: body.outcome,
  };
}

function boundedContractStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .slice(0, CONTRACT_DETAIL_MAX_ITEMS)
    .map(sanitizeContractString);
  return items.length > 0 ? items : undefined;
}

function projectContractIssues(value: unknown): RaviIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues = value
    .slice(0, CONTRACT_DETAIL_MAX_ITEMS)
    .filter(isRecord)
    .flatMap((issue): RaviIssue[] => {
      if (typeof issue.code !== "string" || typeof issue.message !== "string" || !Array.isArray(issue.path)) return [];
      const path = issue.path
        .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
        .slice(0, CONTRACT_DETAIL_MAX_ITEMS)
        .map((item) => (typeof item === "string" ? sanitizeContractString(item) : item));
      return [
        {
          path,
          code: sanitizeContractString(issue.code),
          message: sanitizeContractPublicValue(issue.message, "message") as string,
        },
      ];
    });
  return issues.length > 0 ? issues : undefined;
}

function sanitizeContractString(value: string): string {
  if (REDACTION_MARKER_PATTERN.test(value)) return value;
  return value
    .replace(RCTX_TOKEN_PATTERN, "[REDACTED:rctx]")
    .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
    .replace(API_TOKEN_PATTERN, "[REDACTED:token]");
}

function sanitizeContractPublicValue(
  value: unknown,
  key?: string,
  parent?: Readonly<Record<string, unknown>>,
  depth = 0,
): unknown {
  if (depth > CONTRACT_DETAIL_MAX_DEPTH) return "[REDACTED]";
  if (typeof value === "string" && REDACTION_MARKER_PATTERN.test(value)) return value;
  if (key && isSecretKey(key) && !isTypedSecretMetadata(key, value)) return "[REDACTED]";
  if (key === "value" && parentNamesSecret(parent, value)) return "[REDACTED]";
  if (key && normalizeKey(key).endsWith("path") && typeof value === "string") return "[REDACTED:path]";
  if (key && CONTENT_KEY_PATTERN.test(key)) {
    return typeof value === "string" ? `[REDACTED:content length=${value.length}]` : "[REDACTED:content]";
  }
  if (typeof value === "string") return sanitizeContractString(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, CONTRACT_DETAIL_MAX_ITEMS)
      .map((item) => sanitizeContractPublicValue(item, undefined, undefined, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([nestedKey]) => !RAW_CONTRACT_KEYS.has(normalizeKey(nestedKey)))
        .slice(0, CONTRACT_DETAIL_MAX_ITEMS)
        .map(([nestedKey, nestedValue]) => [
          nestedKey,
          sanitizeContractPublicValue(nestedValue, nestedKey, value, depth + 1),
        ]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key.replace(/[-_]/g, "").toLowerCase();
}

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[.\s_-]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function isSecretKey(key: string): boolean {
  if (SECRET_KEYS.has(normalizeKey(key))) return true;
  const segments = keySegments(key);
  if (segments.some((segment) => SECRET_KEY_SEGMENTS.has(segment))) return true;
  return segments.some((segment, index) => segment === "key" && ["api", "private"].includes(segments[index - 1] ?? ""));
}

function isTypedSecretMetadata(key: string, value: unknown): boolean {
  const segments = keySegments(key);
  const suffix = segments.at(-1);
  if (typeof value === "number" && SAFE_NUMERIC_SECRET_SUFFIXES.has(suffix ?? "")) return true;
  if (typeof value === "boolean" && segments.length > 1) return true;
  const compoundTokenKey =
    !["token", "tokens"].includes(normalizeKey(key)) &&
    segments.some((segment) => segment === "token" || segment === "tokens");
  return compoundTokenKey && (typeof value === "number" || typeof value === "boolean");
}

function parentNamesSecret(parent: Readonly<Record<string, unknown>> | undefined, value: unknown): boolean {
  return typeof parent?.key === "string" && isSecretKey(parent.key) && !isTypedSecretMetadata(parent.key, value);
}

function pickMessage(body: RaviErrorBody | null): string | null {
  if (!body) return null;
  if (typeof body.message === "string" && body.message) return body.message;
  if (typeof body.reason === "string" && body.reason) return body.reason;
  if (typeof body.error === "string" && body.error) return body.error;
  return null;
}
