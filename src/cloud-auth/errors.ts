import { isNetworkIsolationError, type ExecutionPlaneSnapshot } from "../isolation/execution-plane.js";
import type { PublicValidationIssue } from "../cli/redaction.js";

export const CLOUD_AUTH_ERROR_CODES = [
  "AUTH_REQUIRED",
  "AUTH_PENDING",
  "AUTH_EXPIRED",
  "INSTALLATION_REVOKED",
  "ORG_ACCESS_DENIED",
  "PROJECT_ACCESS_DENIED",
  "PUBLISH_NOT_ALLOWED",
  "DOMAIN_SETUP_REQUIRED",
  "PAYLOAD_INVALID",
  "RATE_LIMITED",
  "SERVER_UNAVAILABLE",
  "HOST_UNREACHABLE",
  "CREDENTIALS_INVALID",
  "CLOUD_PUBLISH_NOT_IMPLEMENTED",
  "CONTACT_REQUIRED",
  "ACTOR_BINDING_CONFLICT",
  "LOCAL_INSTALLATION_MISSING",
  "INSTALLATION_MISMATCH",
  "LINK_APPROVAL_REQUIRED",
  "LINK_REQUESTS_UNAVAILABLE",
  "LINK_DM_UNSUPPORTED",
  "LINK_DM_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "VERSION_CONFLICT",
  "CONNECTOR_GROUP_BLOCKED",
  "CONNECTOR_SPEAKER_NOT_OWNER",
  "CONNECTOR_DISABLED_BY_ORG",
  "CONNECTOR_TOOL_BLOCKED",
  "CONNECTOR_APPROVAL_REQUIRED",
  "CONNECTOR_APPROVAL_PENDING",
  "CONNECTOR_APPROVAL_DENIED",
  "CONNECTOR_APPROVAL_INVALID",
  "CONNECTOR_CONSENT_REQUIRED",
  "CONNECTOR_NOT_LINKED",
  "CONNECTOR_CONNECTION_REQUIRED",
  "CONNECTOR_REAUTH_REQUIRED",
  "CONNECTOR_PERMISSION_REQUIRED",
  "CONNECTOR_POLICY_ABOVE_CEILING",
  "CONNECTOR_FORBIDDEN",
] as const;

export type CloudAuthErrorCode = (typeof CLOUD_AUTH_ERROR_CODES)[number];

/**
 * Single source of truth for retryable Console auth failures.
 * The CLI exit contract (`retryable`) and `ravi login` polling both use this set.
 */
export const RETRYABLE_CLOUD_AUTH_CODES: ReadonlySet<CloudAuthErrorCode> = new Set([
  "AUTH_PENDING",
  "RATE_LIMITED",
  "SERVER_UNAVAILABLE",
]);

/**
 * Connector policy blocks. They are the system working (exit 3), not failures:
 * the turn, the organization or the account owner decided this call does not
 * run as asked.
 */
export const CONNECTOR_POLICY_CODES: ReadonlySet<CloudAuthErrorCode> = new Set([
  "CONNECTOR_GROUP_BLOCKED",
  "CONNECTOR_SPEAKER_NOT_OWNER",
  "CONNECTOR_DISABLED_BY_ORG",
  "CONNECTOR_TOOL_BLOCKED",
  "CONNECTOR_APPROVAL_REQUIRED",
  "CONNECTOR_APPROVAL_PENDING",
  "CONNECTOR_APPROVAL_DENIED",
  "CONNECTOR_CONSENT_REQUIRED",
  "CONNECTOR_NOT_LINKED",
]);

export function isConnectorPolicyCode(code: CloudAuthErrorCode): boolean {
  return CONNECTOR_POLICY_CODES.has(code);
}

export function isRetryableCloudAuthCode(code: CloudAuthErrorCode): boolean {
  return RETRYABLE_CLOUD_AUTH_CODES.has(code);
}

/**
 * Retryability of a concrete error. An explicit `retryable` on the error wins
 * over its code, so a misconfiguration reported as `SERVER_UNAVAILABLE` is not
 * retried.
 */
export function isRetryableCloudAuthError(error: CloudAuthError): boolean {
  return error.retryable ?? isRetryableCloudAuthCode(error.code);
}

const KNOWN_CODES = new Set<string>(CLOUD_AUTH_ERROR_CODES);

/** Console `/api/cli/link` codes → CLI codes already exposed to agents. */
const CONSOLE_LINK_ERROR_ALIASES: Record<string, CloudAuthErrorCode> = {
  CONFLICT: "ACTOR_BINDING_CONFLICT",
  NOT_MEMBER: "ORG_ACCESS_DENIED",
  INSTALLATION_ORG_MISMATCH: "ORG_ACCESS_DENIED",
};

export class CloudAuthError extends Error {
  readonly code: CloudAuthErrorCode;
  readonly status?: number;
  /** Wait hint from Retry-After or a provider body. Omitted when the server did not say how long to wait. */
  readonly retryAfterMs?: number;
  /** Overrides the code's default retryability. Omitted when the code decides. */
  readonly retryable?: boolean;
  readonly issues?: PublicValidationIssue[];
  /** Structured `error.details` from the Console CLI envelope. Never serialized by `toJSON`. */
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;
  readonly exitCode: number;

  constructor(
    code: CloudAuthErrorCode,
    message: string,
    options: {
      status?: number;
      exitCode?: number;
      cause?: unknown;
      issues?: PublicValidationIssue[];
      retryAfterMs?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      requestId?: string;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CloudAuthError";
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = normalizeRetryAfterMs(options.retryAfterMs);
    this.retryable = options.retryable;
    this.issues = options.issues;
    this.details = options.details;
    this.requestId = options.requestId;
    this.exitCode = options.exitCode ?? defaultExitCode(code);
  }

  toJSON(): { code: CloudAuthErrorCode; message: string; status?: number; issues?: PublicValidationIssue[] } {
    return {
      code: this.code,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.issues ? { issues: this.issues } : {}),
    };
  }
}

export function isCloudAuthError(error: unknown): error is CloudAuthError {
  return error instanceof CloudAuthError;
}

/**
 * `linkAliases: false` keeps Console codes such as `CONFLICT` as-is. Only
 * `/api/cli/link` responses use the link aliases.
 */
export function normalizeCloudAuthErrorCode(
  value: unknown,
  fallback: CloudAuthErrorCode,
  options: { linkAliases?: boolean } = {},
): CloudAuthErrorCode {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
  const mapped = options.linkAliases === false ? normalized : (CONSOLE_LINK_ERROR_ALIASES[normalized] ?? normalized);
  return KNOWN_CODES.has(mapped) ? (mapped as CloudAuthErrorCode) : fallback;
}

export function cloudAuthErrorFromUnknown(error: unknown): CloudAuthError {
  if (isCloudAuthError(error)) return error;
  return new CloudAuthError("SERVER_UNAVAILABLE", "Cloud service request failed.", {
    cause: error,
  });
}

/**
 * Classify a Console HTTPS/fetch failure. Provider sandboxes that cannot
 * reach Console get `HOST_UNREACHABLE` instead of a misleading "Console is
 * down" `SERVER_UNAVAILABLE`. Host processes keep `SERVER_UNAVAILABLE`.
 *
 * Isolation is an explicit snapshot so unused built-in providers such as `pi`
 * never influence this code.
 */
export function classifyConsoleNetworkError(
  error: unknown,
  isolation: Pick<ExecutionPlaneSnapshot, "plane"> = { plane: "host" },
): CloudAuthError {
  if (isCloudAuthError(error)) return error;
  if (isolation.plane === "provider-sandbox" && isNetworkIsolationError(error)) {
    return new CloudAuthError(
      "HOST_UNREACHABLE",
      "Console is unreachable from this provider sandbox. The host CLI can reach Console.",
      { cause: error, exitCode: 1 },
    );
  }
  return new CloudAuthError("SERVER_UNAVAILABLE", `Console request failed: ${consoleErrorMessage(error)}`, {
    cause: error,
  });
}

function consoleErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function formatCloudAuthError(error: CloudAuthError): {
  success: false;
  error: ReturnType<CloudAuthError["toJSON"]>;
} {
  return {
    success: false,
    error: error.toJSON(),
  };
}

function normalizeRetryAfterMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function defaultExitCode(code: CloudAuthErrorCode): number {
  if (isConnectorPolicyCode(code)) return 3;
  switch (code) {
    case "AUTH_REQUIRED":
    case "AUTH_PENDING":
    case "AUTH_EXPIRED":
    case "INSTALLATION_REVOKED":
    case "LOCAL_INSTALLATION_MISSING":
    case "INSTALLATION_MISMATCH":
    case "ORG_ACCESS_DENIED":
    case "PROJECT_ACCESS_DENIED":
      return 2;
    case "PAYLOAD_INVALID":
      return 3;
    case "RATE_LIMITED":
      return 4;
    case "SERVER_UNAVAILABLE":
      return 5;
    default:
      return 1;
  }
}
