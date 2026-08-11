import { describe, expect, test } from "bun:test";
import { createKimiCodeRuntimeProvider } from "./kimi-code-provider.js";
import { buildKimiCodeRequest } from "./kimi-code-transport.js";
import { listRegisteredRuntimeProviderIds, unregisterRuntimeProvider } from "./provider-registry.js";
import type { RuntimeHostServices } from "./types.js";

function createHostServices(): RuntimeHostServices {
  return {
    authorizeCapability: async () => ({ allowed: true, inherited: false }),
    authorizeCommandExecution: async () => ({ approved: true }),
    authorizeToolUse: async () => ({ approved: true }),
    requestUserInput: async () => ({ approved: true, answers: {} }),
    listDynamicTools: () => [
      {
        name: "lookup_order",
        description: "Looks up a synthetic order.",
        inputSchema: { type: "object" },
      },
    ],
    executeDynamicTool: async (request) => ({
      success: request.toolName === "lookup_order",
      contentItems: [{ type: "inputText", text: `handled:${request.toolName}` }],
    }),
  };
}

describe("createKimiCodeRuntimeProvider", () => {
  test("exports the transport request boundary for its provider-specific mapping", () => {
    expect(typeof buildKimiCodeRequest).toBe("function");
  });

  test("declares the conservative Kimi Code v1 capability contract", () => {
    expect(createKimiCodeRuntimeProvider().getCapabilities()).toEqual({
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
    });
  });

  test("prepares the host dynamic-tool bridge without enabling legacy tool hooks", async () => {
    const provider = createKimiCodeRuntimeProvider();
    const prepared = await provider.prepareSession?.({
      agentId: "kimi-agent",
      cwd: "C:/synthetic-workspace",
      hostServices: createHostServices(),
    });

    expect(provider.getCapabilities().supportsToolHooks).toBe(false);
    expect(prepared?.startRequest?.dynamicTools).toEqual([
      {
        name: "lookup_order",
        description: "Looks up a synthetic order.",
        inputSchema: { type: "object" },
      },
    ]);
    expect(await prepared?.startRequest?.handleRuntimeToolCall?.({ toolName: "lookup_order" })).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "handled:lookup_order" }],
    });
  });

  test("is registered as a built-in provider and cannot be unregistered", () => {
    expect(listRegisteredRuntimeProviderIds()).toContain("kimi-code");
    expect(() => unregisterRuntimeProvider("kimi-code")).toThrow(
      "Cannot unregister built-in runtime provider 'kimi-code'",
    );
  });
});
