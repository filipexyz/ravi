import { KIMI_CODE_PROVIDER_ID, type KimiCodeModel } from "./kimi-code-models.js";
import type {
  RuntimePrepareSessionRequest,
  RuntimePrepareSessionResult,
  RuntimeSessionHandle,
  RuntimeStartRequest,
  SessionRuntimeProvider,
} from "./types.js";

export { KIMI_CODE_CREDENTIAL_ENV_KEY } from "./kimi-code-models.js";
export {
  buildKimiCodeRequest,
  createKimiCodeHttpTransport,
  type KimiCodeStreamEvent,
  type KimiCodeTransport,
  type KimiCodeTransportRequest,
} from "./kimi-code-transport.js";

export interface KimiCodeRuntimeProvider extends SessionRuntimeProvider {
  id: typeof KIMI_CODE_PROVIDER_ID;
  startSession(input: RuntimeStartRequest): RuntimeSessionHandle;
}

export interface CreateKimiCodeRuntimeProviderOptions {
  defaultModel?: KimiCodeModel["id"];
}

export function createKimiCodeRuntimeProvider(
  _options: CreateKimiCodeRuntimeProviderOptions = {},
): KimiCodeRuntimeProvider {
  return {
    id: KIMI_CODE_PROVIDER_ID,
    getCapabilities() {
      return {
        runtimeControl: { supported: false, operations: [] },
        dynamicTools: { mode: "host" },
        execution: { mode: "external-service" },
        sessionState: { mode: "file-backed", requiresCwdMatch: true },
        usage: { semantics: "terminal-event" },
        tools: { permissionMode: "ravi-host", accessRequirement: "tool_surface", supportsParallelCalls: false },
        systemPrompt: { mode: "append" },
        terminalEvents: { guarantee: "adapter" },
        skillVisibility: { availability: "none", loadedState: "none" },
        supportsSessionResume: true,
        supportsSessionFork: false,
        supportsPartialText: true,
        supportsToolHooks: false,
        supportsHostSessionHooks: false,
        supportsPlugins: false,
        supportsMcpServers: false,
        supportsRemoteSpawn: false,
        toolAccessRequirement: "tool_surface",
      };
    },
    prepareSession(input: RuntimePrepareSessionRequest): RuntimePrepareSessionResult {
      const hostServices = input.hostServices;
      if (!hostServices) {
        return { startRequest: { dynamicTools: [] } };
      }
      return {
        startRequest: {
          dynamicTools: hostServices.listDynamicTools(),
          handleRuntimeToolCall: (request) => hostServices.executeDynamicTool(request),
        },
      };
    },
    startSession(input: RuntimeStartRequest): RuntimeSessionHandle {
      return createUnavailableKimiCodeSession(input);
    },
  };
}

function createUnavailableKimiCodeSession(input: RuntimeStartRequest): RuntimeSessionHandle {
  let interrupted = false;
  return {
    provider: KIMI_CODE_PROVIDER_ID,
    events: (async function* () {
      for await (const _prompt of input.prompt) {
        if (interrupted || input.abortController.signal.aborted) {
          yield { type: "turn.interrupted", metadata: { provider: KIMI_CODE_PROVIDER_ID } } as const;
          continue;
        }
        yield {
          type: "turn.failed",
          error: "Kimi Code transport is not configured",
          recoverable: true,
          metadata: { provider: KIMI_CODE_PROVIDER_ID },
        } as const;
      }
    })(),
    interrupt: async () => {
      interrupted = true;
    },
  };
}
