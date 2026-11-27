export class CliExpectedError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly suggestedAction?: string;
  /**
   * Structured fields for the error envelope. Only the control fields that
   * `agent-contract.ts` allowlists (`CONTROL_FIELDS`) ever leave the process.
   */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    code = "COMMAND_FAILED",
    exitCode = 1,
    suggestedAction?: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "CliExpectedError";
    this.code = code;
    this.exitCode = exitCode;
    this.suggestedAction = suggestedAction;
    if (details) this.details = details;
  }
}
