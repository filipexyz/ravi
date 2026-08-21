type ProcessOutputChunk = string | Uint8Array;
type CliExitCode = number | string;

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

type ProcessOutputStream = Pick<
  NodeJS.WriteStream,
  "destroyed" | "writableEnded" | "writableLength" | "writableNeedDrain" | "write"
>;

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntilFlushed(stream: ProcessOutputStream): Promise<void> {
  while (stream.writableLength > 0 || stream.writableNeedDrain) {
    if (stream.destroyed || stream.writableEnded) {
      throw new Error("CLI output stream became unavailable before pending output completed.");
    }
    await nextEventLoopTurn();
  }
}

async function writeAndWait(stream: ProcessOutputStream, chunk: ProcessOutputChunk): Promise<void> {
  if (stream.destroyed || stream.writableEnded) {
    throw new Error("CLI output stream is unavailable.");
  }

  stream.write(chunk);
  await waitUntilFlushed(stream);
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
export async function flushProcessOutput(): Promise<void> {
  await Promise.all([waitUntilFlushed(process.stdout), waitUntilFlushed(process.stderr)]);
}

export async function terminateCliProcess(code: CliExitCode): Promise<never> {
  await flushProcessOutput();
  process.exit(code);
}
