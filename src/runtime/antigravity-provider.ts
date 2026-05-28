import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { logger } from "../utils/logger.js";
import type {
  RuntimeEvent,
  RuntimePrepareSessionResult,
  RuntimeSessionHandle,
  RuntimeStartRequest,
  SessionRuntimeProvider,
} from "./types.js";
import { createRuntimeTerminalEventTracker } from "./terminality.js";
import { emptySkillVisibilitySnapshot } from "./skill-visibility.js";

const log = logger.child("antigravity");

const DEFAULT_AGY_COMMAND = "agy";
const DEFAULT_AGY_MODEL = "gemini-3.5-pro";
const DEFAULT_AGY_TIMEOUT_MS = 60_000;

export interface CreateAntigigravityRuntimeProviderOptions {
  command?: string;
  model?: string;
  timeoutMs?: number;
}

export interface AntigigravityRuntimeProvider extends SessionRuntimeProvider {
  startSession(input: RuntimeStartRequest): RuntimeSessionHandle;
}

/**
 * Minimal Antigravity CLI provider (option B: text-only, manual auth).
 *
 * Spawns `agy -p "<prompt>"` and captures plain text output.
 * Auth: OAuth headless with manual code entry (30s timeout).
 * Cost tracking: not available from `agy` output.
 * Conversation resume: not yet implemented.
 *
 * See docs/proposals/antigravity-provider-prd.md for viability assessment.
 */
export function createAntigigravityRuntimeProvider(
  options: CreateAntigigravityRuntimeProviderOptions = {},
): AntigigravityRuntimeProvider {
  const command = options.command ?? DEFAULT_AGY_COMMAND;
  const model = options.model ?? DEFAULT_AGY_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGY_TIMEOUT_MS;

  // Verify agy binary is available
  const agyBinaryPath = join(homedir(), ".local", "bin", "agy");
  if (!existsSync(agyBinaryPath) && !isCommandInPath(command)) {
    log.warn("antigravity CLI not found at ~/.local/bin/agy; provider will fail at startSession", {
      expectedPath: agyBinaryPath,
    });
  }

  const caps: import("./types.js").RuntimeCapabilities = {
    runtimeControl: {
      supported: false,
      operations: [],
    },
    dynamicTools: {
      mode: "none",
    },
    execution: {
      mode: "subprocess-cli",
    },
    sessionState: {
      mode: "none",
    },
    usage: {
      semantics: "unavailable",
    },
    tools: {
      permissionMode: "provider-native",
      accessRequirement: "tool_surface",
      supportsParallelCalls: false,
    },
    systemPrompt: {
      mode: "append",
    },
    terminalEvents: {
      guarantee: "adapter",
    },
    skillVisibility: {
      availability: "none",
      loadedState: "none",
    },
    supportsSessionResume: false,
    supportsSessionFork: false,
    supportsPartialText: false,
    supportsToolHooks: false,
    supportsHostSessionHooks: false,
    supportsPlugins: false,
    supportsMcpServers: false,
    supportsRemoteSpawn: false,
  };

  return {
    id: "antigravity",
    getCapabilities() {
      return caps;
    },
    prepareSession(): RuntimePrepareSessionResult {
      return {};
    },
    startSession(input: RuntimeStartRequest): RuntimeSessionHandle {
      const skillVisibility = emptySkillVisibilitySnapshot();
      let agyProcess: ChildProcessWithoutNullStreams | null = null;
      let _interrupted = false;

      return {
        provider: "antigravity",
        skillVisibility,
        events: runAgyTurns(input, command, model, timeoutMs, (state) => {
          agyProcess = state.process;
          _interrupted = state.interrupted;
        }),
        interrupt: async () => {
          _interrupted = true;
          if (agyProcess) {
            agyProcess.kill("SIGTERM");
          }
        },
      };
    },
  };
}

interface AgyState {
  process: ChildProcessWithoutNullStreams | null;
  interrupted: boolean;
}

async function* runAgyTurns(
  input: RuntimeStartRequest,
  command: string,
  model: string,
  timeoutMs: number,
  setState: (state: AgyState) => void,
): AsyncGenerator<RuntimeEvent> {
  let promptIndex = 0;

  for await (const message of input.prompt) {
    if (input.abortController.signal.aborted) {
      break;
    }

    const promptText = extractPromptText(message);
    if (!promptText.trim()) {
      continue;
    }

    log.debug("agy prompt", { index: promptIndex, model, promptLength: promptText.length });

    const agyProcess = spawn(command, ["-p", promptText, "--print-timeout", "60s"], {
      env: {
        ...globalThis.process.env,
        AGY_NON_INTERACTIVE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }) as any;

    setState({ process: agyProcess, interrupted: false });

    const terminalTracker = createRuntimeTerminalEventTracker();
    let output = "";
    let errors = "";
    const decoder = new StringDecoder("utf8");

    // Collect output
    if (agyProcess.stdout) {
      agyProcess.stdout.on("data", (chunk: Buffer) => {
        output += decoder.write(chunk);
      });
    }

    if (agyProcess.stderr) {
      agyProcess.stderr.on("data", (chunk: Buffer) => {
        errors += decoder.write(chunk);
      });
    }

    // Wait for completion
    const _exitCode = await new Promise<number>((resolve) => {
      const timeout = setTimeout(() => {
        log.warn("agy timeout", { timeoutMs });
        agyProcess.kill("SIGTERM");
        resolve(1);
      }, timeoutMs);

      agyProcess.on("exit", (code: number | null) => {
        clearTimeout(timeout);
        resolve(code ?? 1);
      });

      agyProcess.on("error", (err: Error) => {
        clearTimeout(timeout);
        log.error("agy spawn error", { error: err.message });
        resolve(1);
      });
    });

    if (errors) {
      log.warn("agy stderr", { stderr: errors.slice(0, 200) });
    }

    // Emit collected output as assistant message
    const finalOutput = output.trim() || errors.trim() || "(no output)";
    yield {
      type: "assistant.message",
      text: finalOutput,
    };

    // Emit terminal event
    if (terminalTracker.accept({ type: "turn.complete" } as any)) {
      yield {
        type: "turn.complete",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    promptIndex++;
    setState({ process: null, interrupted: false });
  }
}

function extractPromptText(message: { message: { content: unknown } }): string {
  const content = message.message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) return (item as { text: string }).text;
        return "";
      })
      .join("\n");
  }
  return "";
}

function isCommandInPath(command: string): boolean {
  const pathEnv = globalThis.process.env.PATH ?? "";
  const paths = pathEnv.split(":");
  for (const dir of paths) {
    const fullPath = join(dir, command);
    if (existsSync(fullPath)) {
      return true;
    }
  }
  return false;
}
