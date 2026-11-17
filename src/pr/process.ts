import { spawn } from "node:child_process";
import { PUBLICATION_REQUEST_TIMEOUT_MS, PUBLICATION_TIMEOUT_ENV } from "./budget.js";
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
    /** Deadline of this subprocess; the caller's signal still bounds the whole publication. */
    timeoutMs?: number;
  } = {},
): Promise<{ stdout: Buffer; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    // The first limit to stop the subprocess names the failure: the three are different conditions for the caller.
    let stopped: "deadline" | "request" | "response" | undefined;
    const stop = (limit: "deadline" | "request" | "response") => {
      stopped ??= limit;
      child.kill("SIGKILL");
    };
    const requestMs = options.timeoutMs ?? PUBLICATION_REQUEST_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    const timer = setTimeout(() => stop("request"), requestMs);
    const onAbort = () => stop("deadline");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) stop("deadline");
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop("response");
      else chunks.push(chunk);
    });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", () => {
      cleanup();
      reject(prError("PUBLICATION_PROCESS_FAILED", `Could not start ${executable}. Check that it is installed.`));
    });
    child.on("close", (code) => {
      cleanup();
      if (stopped === "deadline")
        reject(
          prError(
            "PUBLICATION_TIMEOUT",
            "Publication exceeded its time budget; remote effects may need reconciliation.",
            {
              retryable: true,
            },
          ),
        );
      else if (stopped === "request")
        reject(
          prError(
            "PUBLICATION_REQUEST_TIMEOUT",
            `One ${executable} request exceeded its own ${Math.round(requestMs / 1000)}s limit while the publication still had budget left. ` +
              `That limit follows the size of the request; ${PUBLICATION_TIMEOUT_ENV} does not change it. ` +
              "Rerun with the same --expect-sha: objects GitHub already holds are skipped.",
            { retryable: true },
          ),
        );
      else if (stopped === "response")
        reject(
          prError(
            "PUBLICATION_RESPONSE_TOO_LARGE",
            `One ${executable} response exceeded the ${Math.round(maxBytes / (1024 * 1024))} MiB output limit. ` +
              `This is not a time budget: ${PUBLICATION_TIMEOUT_ENV} and a plain rerun do not change it.`,
          ),
        );
      else resolve({ stdout: Buffer.concat(chunks), code: code ?? 1 });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
