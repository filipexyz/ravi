/**
 * Sandboxed app scripts (spec apps/router, "Script Operations").
 *
 * An app script is plain JavaScript run inside QuickJS compiled to
 * WebAssembly. The interpreter has no modules, no `std`/`os`, no timers and no
 * host functions: the script cannot touch the disk, the network, the
 * environment or another process. It receives one JSON value and returns one
 * JSON value; the router decides what, if anything, happens with the result.
 * Memory, stack, run time and input/output size are bounded.
 */

import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";

export const APP_SCRIPT_LIMITS = Object.freeze({
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  timeoutMs: 5_000,
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

let modulePromise: Promise<QuickJSWASMModule> | null = null;

function quickjs(): Promise<QuickJSWASMModule> {
  // A fresh module per process; every run still gets its own runtime and context.
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant as never);
  return modulePromise;
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
  const module = await quickjs();
  const runtime = module.newRuntime();
  try {
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    const deadline = Date.now() + limits.timeoutMs;
    let interrupted = false;
    runtime.setInterruptHandler(() => {
      if (Date.now() > deadline) interrupted = true;
      return interrupted;
    });
    const context = runtime.newContext();
    try {
      const evaluate = (code: string, filename: string) => {
        const result = context.evalCode(code, filename, { type: "global", strict: true });
        if (result.error) {
          const dumped = context.dump(result.error);
          result.error.dispose();
          if (interrupted) {
            throw new AppScriptError("APP_SCRIPT_LIMIT", `The script ran longer than ${limits.timeoutMs} ms.`);
          }
          const message = isRecord(dumped)
            ? `${String(dumped.name ?? "Error")}: ${String(dumped.message ?? "")}`
            : String(dumped);
          if (/out of memory|stack overflow/i.test(message)) {
            throw new AppScriptError("APP_SCRIPT_LIMIT", `The script hit a sandbox limit: ${truncate(message, 200)}`);
          }
          throw new AppScriptError("APP_SCRIPT_FAILED", `The script failed: ${truncate(message, 500)}`);
        }
        return result.value;
      };

      evaluate(source, "app-script.js").dispose();
      const inputHandle = context.newString(inputJson);
      context.setProp(context.global, "__raviInput", inputHandle);
      inputHandle.dispose();
      const output = evaluate(
        `(() => {
          if (typeof main !== "function") throw new TypeError("the script must define a global function main(input)");
          const input = JSON.parse(globalThis.__raviInput);
          delete globalThis.__raviInput;
          const value = main(input);
          if (value && typeof value.then === "function") throw new TypeError("main must return synchronously");
          const text = JSON.stringify(value === undefined ? {} : value);
          if (typeof text !== "string") throw new TypeError("main must return a JSON object");
          return text;
        })()`,
        "ravi-script-entry.js",
      );
      const raw = context.getString(output);
      output.dispose();
      return checkOutput(raw, limits);
    } finally {
      context.dispose();
    }
  } finally {
    runtime.dispose();
  }
}
