export class CliExpectedError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, code = "COMMAND_FAILED", exitCode = 1) {
    super(message);
    this.name = "CliExpectedError";
    this.code = code;
    this.exitCode = exitCode;
  }
}
