export interface CliExpectedErrorOptions {
  /** The message is deliberately safe to expose to CLI, tool, and gateway consumers. */
  publicMessage?: boolean;
  retryable?: boolean;
  suggestedAction?: string;
  details?: Record<string, unknown>;
}

export class CliExpectedError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly publicMessage: boolean;
  readonly retryable: boolean;
  readonly suggestedAction?: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, code = "COMMAND_FAILED", exitCode = 1, options: CliExpectedErrorOptions = {}) {
    super(message);
    this.name = "CliExpectedError";
    this.code = code;
    this.exitCode = exitCode;
    this.publicMessage = options.publicMessage ?? false;
    this.retryable = options.retryable ?? false;
    this.suggestedAction = options.suggestedAction;
    this.details = options.details ?? {};
  }
}

export function cliUsageError(
  message: string,
  options: Omit<CliExpectedErrorOptions, "publicMessage"> = {},
): CliExpectedError {
  return new CliExpectedError(message, "USAGE_ERROR", 2, {
    ...options,
    publicMessage: true,
  });
}
