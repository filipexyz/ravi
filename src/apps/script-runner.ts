/**
 * Child-process side of app scripts (spec apps/router, "Script Operations").
 *
 * The host (`script-sandbox.ts`) starts this file in a fresh `bun` process for
 * every run, writes one JSON request to stdin and kills the process on a host
 * timer. Here QuickJS runs on its own WebAssembly instance whose memory has a
 * hard maximum, so neither a runaway loop inside a native builtin nor a flood
 * of small allocations can outlive the run or reach the caller's process.
 *
 * Request: { source, input, limits }. Reply on stdout, one JSON line:
 * { ok: true, raw } with the script's JSON text, or { ok: false, code, message }.
 */

import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";

const WASM_PAGE = 64 * 1024;
/** Room for QuickJS's own data, the shadow stack and allocator overhead above the heap limit. */
const WASM_HEADROOM = 32 * 1024 * 1024;

interface RunnerRequest {
  source: string;
  input: string;
  limits: { memoryBytes: number; stackBytes: number; timeoutMs: number; outputBytes: number };
}

type RunnerReply = { ok: true; raw: string } | { ok: false; code: string; message: string };

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitReply(message: string): RunnerReply {
  return { ok: false, code: "APP_SCRIPT_LIMIT", message };
}

async function run(request: RunnerRequest): Promise<RunnerReply> {
  const { limits } = request;
  const maximum = Math.ceil((limits.memoryBytes + WASM_HEADROOM) / WASM_PAGE);
  const wasmMemory = new WebAssembly.Memory({ initial: Math.min(256, maximum), maximum });
  const module = await newQuickJSWASMModuleFromVariant(newVariant(variant as never, { wasmMemory }));
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  const deadline = Date.now() + limits.timeoutMs;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) interrupted = true;
    return interrupted;
  });
  const context = runtime.newContext();

  const evaluate = (code: string, filename: string): RunnerReply | { value: string } => {
    const result = context.evalCode(code, filename, { type: "global", strict: true });
    if (result.error) {
      const dumped = context.dump(result.error);
      result.error.dispose();
      if (interrupted) return limitReply(`The script ran longer than ${limits.timeoutMs} ms.`);
      const message = isRecord(dumped)
        ? `${String(dumped.name ?? "Error")}: ${String(dumped.message ?? "")}`
        : String(dumped);
      if (/out of memory|stack overflow|too much recursion/i.test(message)) {
        return limitReply(`The script hit a sandbox limit: ${truncate(message, 200)}`);
      }
      return { ok: false, code: "APP_SCRIPT_FAILED", message: `The script failed: ${truncate(message, 500)}` };
    }
    const value = context.getString(result.value);
    result.value.dispose();
    return { value };
  };

  const loaded = evaluate(`${request.source}\n;"loaded"`, "app-script.js");
  if ("ok" in loaded) return loaded;
  const inputHandle = context.newString(request.input);
  context.setProp(context.global, "__raviInput", inputHandle);
  inputHandle.dispose();
  // The size check runs inside the guest, so an oversized result is never copied out.
  const output = evaluate(
    `(() => {
      if (typeof main !== "function") throw new TypeError("the script must define a global function main(input)");
      const input = JSON.parse(globalThis.__raviInput);
      delete globalThis.__raviInput;
      const value = main(input);
      if (value && typeof value.then === "function") throw new TypeError("main must return synchronously");
      const text = JSON.stringify(value === undefined ? {} : value);
      if (typeof text !== "string") throw new TypeError("main must return a JSON object");
      if (text.length > ${Math.floor(limits.outputBytes)}) throw new RangeError("__ravi_output_limit__");
      return text;
    })()`,
    "ravi-script-entry.js",
  );
  if ("ok" in output) {
    if (!output.ok && output.message.includes("__ravi_output_limit__")) {
      return limitReply(`The script returned more than ${limits.outputBytes} bytes.`);
    }
    return output;
  }
  return { ok: true, raw: output.value };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function mainEntry(): Promise<void> {
  let reply: RunnerReply;
  try {
    reply = await run(JSON.parse(await readStdin()) as RunnerRequest);
  } catch (error) {
    // A host exception out of the interpreter (the engine's own stack, an abort) ends this process; nothing is reused.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    reply = /call stack|recursion|out of memory|memory access|Aborted/i.test(message)
      ? limitReply(`The script hit a sandbox limit: ${truncate(message, 200)}`)
      : { ok: false, code: "APP_SCRIPT_FAILED", message: `The script failed: ${truncate(message, 500)}` };
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`, () => process.exit(0));
}

void mainEntry();
