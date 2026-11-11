import { spawn } from "node:child_process";
import { prError } from "./contracts.js";

/** No shell, no synchronous subprocesses in the gateway, bounded output and deadline. */
export function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    maxBytes?: number;
  } = {},
): Promise<{ stdout: Buffer; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 20_000);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 16 * 1024 * 1024)) stop();
      else chunks.push(chunk);
    });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    };
    child.on("error", () => {
      cleanup();
      reject(prError("PUBLICATION_PROCESS_FAILED", `Could not start ${executable}. Check that it is installed.`));
    });
    child.on("close", (code) => {
      cleanup();
      if (stopped)
        reject(
          prError(
            "PUBLICATION_TIMEOUT",
            "Publication exceeded its time or response-size budget; remote effects may need reconciliation.",
            { retryable: true },
          ),
        );
      else resolve({ stdout: Buffer.concat(chunks), code: code ?? 1 });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
