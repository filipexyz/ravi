export class WatchApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly exitCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { status?: number; exitCode?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WatchApiError";
    this.code = code;
    this.status = options.status;
    this.exitCode = options.exitCode ?? defaultExitCode(code);
    this.details = options.details;
  }

  toJSON(): { code: string; message: string; status?: number; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isWatchApiError(error: unknown): error is WatchApiError {
  return error instanceof WatchApiError;
}

function defaultExitCode(code: string): number {
  switch (code) {
    case "AUTH_REQUIRED":
    case "AUTH_EXPIRED":
    case "LOCAL_INSTALLATION_REVOKED":
      return 2;
    case "WATCH_UNSUPPORTED_EVENT":
    case "PAYLOAD_INVALID":
      return 3;
    case "RATE_LIMITED":
      return 4;
    case "SERVER_UNAVAILABLE":
    case "WEBHOOK_UNHEALTHY":
      return 5;
    default:
      return 1;
  }
}
