export class CliExpectedError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly suggestedAction?: string;

  constructor(message: string, code = "COMMAND_FAILED", exitCode = 1, suggestedAction?: string) {
    super(message);
    this.name = "CliExpectedError";
    this.code = code;
    this.exitCode = exitCode;
    this.suggestedAction = suggestedAction;
  }
}
