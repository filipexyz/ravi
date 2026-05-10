export const CLOUD_AUTH_ERROR_CODES = [
  "AUTH_REQUIRED",
  "AUTH_PENDING",
  "AUTH_EXPIRED",
  "INSTALLATION_REVOKED",
  "ORG_ACCESS_DENIED",
  "PROJECT_ACCESS_DENIED",
  "PUBLISH_NOT_ALLOWED",
  "PAYLOAD_INVALID",
  "RATE_LIMITED",
  "SERVER_UNAVAILABLE",
  "CREDENTIALS_INVALID",
  "CLOUD_PUBLISH_NOT_IMPLEMENTED",
] as const;

export type CloudAuthErrorCode = (typeof CLOUD_AUTH_ERROR_CODES)[number];

const KNOWN_CODES = new Set<string>(CLOUD_AUTH_ERROR_CODES);

export class CloudAuthError extends Error {
  readonly code: CloudAuthErrorCode;
  readonly status?: number;
  readonly exitCode: number;

  constructor(
    code: CloudAuthErrorCode,
    message: string,
    options: { status?: number; exitCode?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CloudAuthError";
    this.code = code;
    this.status = options.status;
    this.exitCode = options.exitCode ?? defaultExitCode(code);
  }

  toJSON(): { code: CloudAuthErrorCode; message: string; status?: number } {
    return {
      code: this.code,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
    };
  }
}

export function isCloudAuthError(error: unknown): error is CloudAuthError {
  return error instanceof CloudAuthError;
}

export function normalizeCloudAuthErrorCode(value: unknown, fallback: CloudAuthErrorCode): CloudAuthErrorCode {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
  return KNOWN_CODES.has(normalized) ? (normalized as CloudAuthErrorCode) : fallback;
}

export function cloudAuthErrorFromUnknown(error: unknown): CloudAuthError {
  if (isCloudAuthError(error)) return error;
  return new CloudAuthError("SERVER_UNAVAILABLE", error instanceof Error ? error.message : String(error), {
    cause: error,
  });
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

function defaultExitCode(code: CloudAuthErrorCode): number {
  switch (code) {
    case "AUTH_REQUIRED":
    case "AUTH_PENDING":
    case "AUTH_EXPIRED":
    case "INSTALLATION_REVOKED":
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
