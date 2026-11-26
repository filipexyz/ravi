/**
 * Sandboxed app scripts (spec apps/router, "Script Operations").
 *
 * An app script is plain JavaScript run inside QuickJS compiled to
 * WebAssembly. The interpreter has no modules, no `std`/`os`, no timers and no
 * host functions: the script cannot touch the disk, the network, the
 * environment or another process. It receives one JSON value and returns one
 * JSON value; the router decides what, if anything, happens with the result.
 *
 * Every run happens in a fresh child process (`script-runner.ts`) on its own
 * WebAssembly instance with a hard memory maximum, and the host kills that
 * process when the time limit passes. QuickJS's own limits are only the polite
 * first line: some native builtins never poll the interrupt handler, and its
 * memory accounting under Emscripten refuses only single oversized allocations.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const APP_SCRIPT_LIMITS = Object.freeze({
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 256 * 1024,
  timeoutMs: 5_000,
  /** Time for the child process to start and load the interpreter, on top of timeoutMs. */
  startupMs: 2_000,
  sourceBytes: 256 * 1024,
  inputBytes: 4 * 1024 * 1024,
  inputFiles: 500,
  outputBytes: 8 * 1024 * 1024,
  outputFiles: 500,
  outputArgs: 32,
  logLines: 100,
  logLineChars: 500,
});

export type AppScriptLimits = typeof APP_SCRIPT_LIMITS;

export interface AppScriptInput {
  args: string[];
  files: Record<string, string>;
}

export interface AppScriptOutput {
  files: Record<string, string>;
  args: string[];
  result: unknown;
  log: string[];
}

export class AppScriptError extends Error {
  readonly code: "APP_SCRIPT_FAILED" | "APP_SCRIPT_LIMIT" | "APP_SCRIPT_OUTPUT_INVALID" | "APP_SCRIPT_INPUT_INVALID";

  constructor(code: AppScriptError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppScriptError";
    this.code = code;
  }
}

/** A relative output or input path: no dot files, no `..`, no backslashes, no empty segments. */
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function isSafeScriptPath(path: string): boolean {
  if (!path || path.length > 200) return false;
  return path.split("/").every((segment) => PATH_SEGMENT.test(segment));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function checkInput(input: AppScriptInput, limits: AppScriptLimits): string {
  const files = Object.entries(input.files);
  if (files.length > limits.inputFiles) {
    throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", `The script input has more than ${limits.inputFiles} files.`);
  }
  for (const [path] of files) {
    if (!isSafeScriptPath(path)) {
      throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", `Unsafe input path: ${truncate(path, 80)}`);
    }
  }
  const json = JSON.stringify({ args: input.args, files: input.files });
  if (byteLength(json) > limits.inputBytes) {
    throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", `The script input is larger than ${limits.inputBytes} bytes.`);
  }
  return json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkOutput(raw: string, limits: AppScriptLimits): AppScriptOutput {
  if (byteLength(raw) > limits.outputBytes) {
    throw new AppScriptError("APP_SCRIPT_LIMIT", `The script returned more than ${limits.outputBytes} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new AppScriptError("APP_SCRIPT_OUTPUT_INVALID", "The script did not return a JSON value.", { cause: error });
  }
  if (!isRecord(value)) {
    throw new AppScriptError("APP_SCRIPT_OUTPUT_INVALID", "The script must return an object.");
  }
  const files: Record<string, string> = {};
  if (value.files !== undefined) {
    if (!isRecord(value.files)) {
      throw new AppScriptError("APP_SCRIPT_OUTPUT_INVALID", "files must map relative paths to text.");
    }
    const entries = Object.entries(value.files);
    if (entries.length > limits.outputFiles) {
      throw new AppScriptError("APP_SCRIPT_LIMIT", `The script returned more than ${limits.outputFiles} files.`);
    }
    for (const [path, content] of entries) {
      if (!isSafeScriptPath(path)) {
        throw new AppScriptError("APP_SCRIPT_OUTPUT_INVALID", `Unsafe output path: ${truncate(path, 80)}`);
      }
      if (typeof content !== "string") {
        throw new AppScriptError("APP_SCRIPT_OUTPUT_INVALID", `files["${truncate(path, 80)}"] must be text.`);
      }
      files[path] = content;
    }
  }
  let args: string[] = [];
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string")) {
      throw new AppScriptError("APP_SCRIPT_OUTPUT_INVALID", "args must be an array of strings.");
    }
    if (value.args.length > limits.outputArgs) {
      throw new AppScriptError("APP_SCRIPT_LIMIT", `The script returned more than ${limits.outputArgs} args.`);
    }
    args = value.args as string[];
  }
  let log: string[] = [];
  if (Array.isArray(value.log)) {
    log = value.log
      .slice(0, limits.logLines)
      .map((line) => truncate(typeof line === "string" ? line : JSON.stringify(line), limits.logLineChars));
  }
  return { files, args, result: value.result ?? null, log };
}

/** The runner file: next to the bundle when built, next to this file in a source checkout. */
function runnerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "app-script-runner.js");
  if (existsSync(bundled)) return bundled;
  const source = join(here, "script-runner.ts");
  if (existsSync(source)) return source;
  throw new AppScriptError("APP_SCRIPT_FAILED", "The app script runner is missing from this Ravi installation.");
}

interface RunnerReply {
  ok: boolean;
  raw?: string;
  code?: string;
  message?: string;
}

function runInChild(request: string, limits: AppScriptLimits): Promise<RunnerReply> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [runnerPath()], {
      cwd: tmpdir(),
      env: {},
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
    });
    const maxReply = limits.outputBytes * 2 + 64 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    let killedFor: "time" | "output" | null = null;
    const timer = setTimeout(() => {
      killedFor = "time";
      child.kill("SIGKILL");
    }, limits.timeoutMs + limits.startupMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxReply) {
        killedFor ??= "output";
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new AppScriptError("APP_SCRIPT_FAILED", "The app script runner could not start.", { cause: error }));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killedFor === "time") {
        reject(new AppScriptError("APP_SCRIPT_LIMIT", `The script ran longer than ${limits.timeoutMs} ms.`));
        return;
      }
      if (killedFor === "output") {
        reject(new AppScriptError("APP_SCRIPT_LIMIT", `The script returned more than ${limits.outputBytes} bytes.`));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      try {
        resolvePromise(JSON.parse(text) as RunnerReply);
      } catch (error) {
        reject(
          new AppScriptError(
            "APP_SCRIPT_LIMIT",
            `The script's sandbox process ended without a result (${signal ?? `exit ${code}`}).`,
            { cause: error },
          ),
        );
      }
    });
    child.stdin.on("error", () => {
      // no-cause: the child exiting early closes stdin; the close handler reports why.
    });
    child.stdin.end(request);
  });
}

/**
 * Run `main(input)` from `source` and return its checked output. The script
 * must define a global function `main` that returns synchronously.
 */
export async function runAppScript(
  source: string,
  input: AppScriptInput,
  overrides: Partial<AppScriptLimits> = {},
): Promise<AppScriptOutput> {
  const limits = { ...APP_SCRIPT_LIMITS, ...overrides };
  if (byteLength(source) > limits.sourceBytes) {
    throw new AppScriptError("APP_SCRIPT_LIMIT", `The script is larger than ${limits.sourceBytes} bytes.`);
  }
  const inputJson = checkInput(input, limits);
  const reply = await runInChild(
    JSON.stringify({
      source,
      input: inputJson,
      limits: {
        memoryBytes: limits.memoryBytes,
        stackBytes: limits.stackBytes,
        timeoutMs: limits.timeoutMs,
        outputBytes: limits.outputBytes,
      },
    }),
    limits,
  );
  if (!reply.ok || typeof reply.raw !== "string") {
    const code =
      reply.code === "APP_SCRIPT_LIMIT" || reply.code === "APP_SCRIPT_FAILED" ? reply.code : "APP_SCRIPT_FAILED";
    throw new AppScriptError(code, String(reply.message ?? "The script failed."));
  }
  return checkOutput(reply.raw, limits);
}
