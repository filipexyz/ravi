type ProcessOutputChunk = string | Uint8Array;
type CliExitCode = number | string;
const DEFAULT_OUTPUT_FLUSH_TIMEOUT_MS = 5_000;
const OUTPUT_FLUSH_POLL_INTERVAL_MS = 4;

export class CliTerminationRequest extends Error {
  readonly exitCode: CliExitCode;

  constructor(exitCode: CliExitCode) {
    super("CLI termination requested.");
    this.name = "CliTerminationRequest";
    this.exitCode = exitCode;
  }
}

/**
 * Synchronous adapters such as Commander exit hooks cannot await output. They
 * throw this private control-flow signal so the top-level CLI boundary can
 * flush output and terminate with the requested code.
 */
export function requestCliTermination(code: CliExitCode): never {
  throw new CliTerminationRequest(code);
}

export function rethrowCliTermination(error: unknown): void {
  if (error instanceof CliTerminationRequest) throw error;
}

export type ProcessOutputStream = Pick<
  NodeJS.WriteStream,
  "destroyed" | "writableEnded" | "writableLength" | "writableNeedDrain" | "write"
>;

function waitForOutputProgress(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function waitUntilProcessOutputFlushed(
  stream: ProcessOutputStream,
  timeoutMs = DEFAULT_OUTPUT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  const startedAt = performance.now();
  while (stream.writableLength > 0 || stream.writableNeedDrain) {
    if (stream.destroyed || stream.writableEnded) {
      throw new Error("CLI output stream became unavailable before pending output completed.");
    }
    const remainingMs = timeoutMs - (performance.now() - startedAt);
    if (remainingMs <= 0) {
      throw new Error(`CLI output did not flush within ${timeoutMs}ms.`);
    }
    await waitForOutputProgress(Math.min(OUTPUT_FLUSH_POLL_INTERVAL_MS, remainingMs));
  }
}

async function writeAndWait(stream: ProcessOutputStream, chunk: ProcessOutputChunk): Promise<void> {
  if (stream.destroyed || stream.writableEnded) {
    throw new Error("CLI output stream is unavailable.");
  }

  stream.write(chunk);
  await waitUntilProcessOutputFlushed(stream);
}

export function writeProcessStdout(chunk: ProcessOutputChunk): Promise<void> {
  return writeAndWait(process.stdout, chunk);
}

export function writeProcessStderr(chunk: ProcessOutputChunk): Promise<void> {
  return writeAndWait(process.stderr, chunk);
}

/**
 * Wait until both process output buffers are empty. This keeps console output
 * complete when stdout or stderr is connected to a pipe without relying on
 * write callbacks, which Bun does not consistently invoke for process streams.
 */
export async function flushProcessOutput(timeoutMs = DEFAULT_OUTPUT_FLUSH_TIMEOUT_MS): Promise<void> {
  await Promise.all([
    waitUntilProcessOutputFlushed(process.stdout, timeoutMs),
    waitUntilProcessOutputFlushed(process.stderr, timeoutMs),
  ]);
}

export async function terminateCliProcess(
  code: CliExitCode,
  flushTimeoutMs = DEFAULT_OUTPUT_FLUSH_TIMEOUT_MS,
): Promise<never> {
  try {
    await flushProcessOutput(flushTimeoutMs);
  } finally {
    process.exit(code);
  }
}
