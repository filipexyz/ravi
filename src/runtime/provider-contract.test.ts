import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeRuntimeProvider } from "./claude-provider.js";
import { createCodexRuntimeProvider } from "./codex-provider.js";
import { createPiRuntimeProvider } from "./pi-provider.js";
import type { RuntimeCapabilities, RuntimeHostServices, RuntimePrepareSessionResult } from "./types.js";

const ALLOWED_START_REQUEST_KEYS = ["approveRuntimeRequest", "dynamicTools", "handleRuntimeToolCall"] as const;

const REQUIRED_CAPABILITY_KEYS: Array<keyof RuntimeCapabilities> = [
  "runtimeControl",
  "dynamicTools",
  "execution",
  "sessionState",
  "usage",
  "tools",
  "systemPrompt",
  "terminalEvents",
  "supportsSessionResume",
  "supportsSessionFork",
  "supportsPartialText",
  "supportsToolHooks",
  "supportsPlugins",
  "supportsMcpServers",
  "supportsRemoteSpawn",
];

const REQUIRED_BOOLEAN_CAPABILITY_KEYS: Array<keyof RuntimeCapabilities> = [
  "supportsSessionResume",
  "supportsSessionFork",
  "supportsPartialText",
  "supportsToolHooks",
  "supportsPlugins",
  "supportsMcpServers",
  "supportsRemoteSpawn",
];

function createNoopHostServices(): RuntimeHostServices {
  return {
    authorizeCapability: async () => ({ allowed: true, inherited: false }),
    authorizeCommandExecution: async () => ({ approved: true }),
    authorizeToolUse: async () => ({ approved: true }),
    requestUserInput: async () => ({ approved: true, answers: {} }),
    listDynamicTools: () => [],
    executeDynamicTool: async () => ({ success: true, contentItems: [] }),
  };
}

function expectPrepareSessionShape(result: RuntimePrepareSessionResult | undefined): void {
  if (!result) {
    return;
  }

  if (result.env) {
    for (const [key, value] of Object.entries(result.env)) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("string");
    }
  }

  if (result.startRequest) {
    for (const key of Object.keys(result.startRequest)) {
      expect(ALLOWED_START_REQUEST_KEYS).toContain(key as (typeof ALLOWED_START_REQUEST_KEYS)[number]);
    }

    if (result.startRequest.approveRuntimeRequest !== undefined) {
      expect(typeof result.startRequest.approveRuntimeRequest).toBe("function");
    }
    if (result.startRequest.dynamicTools !== undefined) {
      expect(Array.isArray(result.startRequest.dynamicTools)).toBe(true);
    }
    if (result.startRequest.handleRuntimeToolCall !== undefined) {
      expect(typeof result.startRequest.handleRuntimeToolCall).toBe("function");
    }
  }
}

describe("runtime provider contract", () => {
  const builtInProviders = [
    { providerId: "claude", createProvider: createClaudeRuntimeProvider },
    { providerId: "codex", createProvider: createCodexRuntimeProvider },
    { providerId: "pi", createProvider: createPiRuntimeProvider },
  ] as const;

  it("keeps built-in providers behind the shared runtime contract", () => {
    for (const { providerId, createProvider } of builtInProviders) {
      const provider = createProvider();
      expect(provider.id).toBe(providerId);
      expect(typeof provider.startSession).toBe("function");
      expect(typeof provider.getCapabilities).toBe("function");

      const capabilities = provider.getCapabilities();
      for (const key of REQUIRED_CAPABILITY_KEYS) {
        expect(capabilities[key]).toBeDefined();
      }
      for (const key of REQUIRED_BOOLEAN_CAPABILITY_KEYS) {
        expect(typeof capabilities[key]).toBe("boolean");
      }
      expect(typeof capabilities.runtimeControl.supported).toBe("boolean");
      expect(Array.isArray(capabilities.runtimeControl.operations)).toBe(true);
      expect(["none", "host"]).toContain(capabilities.dynamicTools.mode);
      expect(typeof capabilities.execution.mode).toBe("string");
      expect(typeof capabilities.sessionState.mode).toBe("string");
      expect(typeof capabilities.usage.semantics).toBe("string");
      expect(typeof capabilities.tools.permissionMode).toBe("string");
      expect(typeof capabilities.tools.accessRequirement).toBe("string");
      expect(typeof capabilities.tools.supportsParallelCalls).toBe("boolean");
      expect(typeof capabilities.systemPrompt.mode).toBe("string");
      expect(typeof capabilities.terminalEvents.guarantee).toBe("string");
    }
  });

  it("keeps the current provider capability matrix explicit", () => {
    expect(createClaudeRuntimeProvider().getCapabilities()).toMatchObject({
      runtimeControl: {
        supported: false,
        operations: [],
      },
      dynamicTools: {
        mode: "none",
      },
      execution: {
        mode: "sdk",
      },
      sessionState: {
        mode: "provider-session-id",
      },
      usage: {
        semantics: "terminal-event",
      },
      tools: {
        permissionMode: "ravi-host",
        accessRequirement: "tool_and_executable",
        supportsParallelCalls: false,
      },
      systemPrompt: {
        mode: "append",
      },
      terminalEvents: {
        guarantee: "adapter",
      },
      supportsSessionResume: true,
      supportsSessionFork: true,
      supportsPartialText: true,
      supportsToolHooks: true,
      supportsHostSessionHooks: true,
      supportsPlugins: true,
      supportsMcpServers: true,
      supportsRemoteSpawn: true,
      legacyEventTopicSuffix: "claude",
    });

    expect(createCodexRuntimeProvider().getCapabilities()).toMatchObject({
      runtimeControl: {
        supported: true,
        operations: ["thread.list", "thread.read", "thread.rollback", "thread.fork", "turn.steer", "turn.interrupt"],
      },
      dynamicTools: {
        mode: "host",
      },
      execution: {
        mode: "subprocess-rpc",
      },
      sessionState: {
        mode: "thread-id",
        requiresCwdMatch: true,
      },
      usage: {
        semantics: "terminal-event",
      },
      tools: {
        permissionMode: "ravi-host",
        accessRequirement: "tool_surface",
        supportsParallelCalls: false,
      },
      systemPrompt: {
        mode: "append",
      },
      terminalEvents: {
        guarantee: "adapter",
      },
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsPartialText: true,
      supportsToolHooks: true,
      supportsHostSessionHooks: false,
      supportsPlugins: false,
      supportsMcpServers: false,
      supportsRemoteSpawn: false,
      toolAccessRequirement: "tool_surface",
    });

    expect(createPiRuntimeProvider().getCapabilities()).toMatchObject({
      runtimeControl: {
        supported: true,
        operations: [
          "session.new",
          "session.read",
          "session.switch",
          "session.compact",
          "turn.steer",
          "turn.follow_up",
          "turn.interrupt",
          "model.set",
          "thinking.set",
        ],
      },
      dynamicTools: {
        mode: "none",
      },
      execution: {
        mode: "subprocess-rpc",
      },
      sessionState: {
        mode: "file-backed",
        requiresCwdMatch: true,
      },
      usage: {
        semantics: "terminal-event",
      },
      tools: {
        permissionMode: "provider-native",
        accessRequirement: "tool_and_executable",
        supportsParallelCalls: false,
      },
      systemPrompt: {
        mode: "append",
      },
      terminalEvents: {
        guarantee: "adapter",
      },
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsPartialText: true,
      supportsToolHooks: false,
      supportsHostSessionHooks: false,
      supportsPlugins: false,
      supportsMcpServers: false,
      supportsRemoteSpawn: false,
      toolAccessRequirement: "tool_and_executable",
    });
  });

  it("keeps prepareSession constrained to env/startRequest adapter output", async () => {
    const originalHome = process.env.HOME;
    for (const { providerId, createProvider } of builtInProviders) {
      const provider = createProvider();
      const cwd = mkdtempSync(join(tmpdir(), `ravi-provider-contract-${providerId}-`));
      const home = mkdtempSync(join(tmpdir(), `ravi-provider-contract-home-${providerId}-`));

      try {
        process.env.HOME = home;
        const result = await provider.prepareSession?.({
          agentId: "contract-agent",
          cwd,
          plugins: [],
          hostServices: createNoopHostServices(),
        });

        expectPrepareSessionShape(result);
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }
  });
});
