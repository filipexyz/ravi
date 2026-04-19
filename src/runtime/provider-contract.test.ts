import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeRuntimeProvider } from "./claude-provider.js";
import { createCodexRuntimeProvider } from "./codex-provider.js";
import type { RuntimeCapabilities, RuntimeHostServices, RuntimePrepareSessionResult } from "./types.js";

const ALLOWED_START_REQUEST_KEYS = ["approveRuntimeRequest", "dynamicTools", "handleRuntimeToolCall"] as const;

const REQUIRED_CAPABILITY_KEYS: Array<keyof RuntimeCapabilities> = [
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
  ] as const;

  it("keeps built-in providers behind the shared runtime contract", () => {
    for (const { providerId, createProvider } of builtInProviders) {
      const provider = createProvider();
      expect(provider.id).toBe(providerId);
      expect(typeof provider.startSession).toBe("function");
      expect(typeof provider.getCapabilities).toBe("function");

      const capabilities = provider.getCapabilities();
      for (const key of REQUIRED_CAPABILITY_KEYS) {
        expect(typeof capabilities[key]).toBe("boolean");
      }
    }
  });

  it("keeps the current provider capability matrix explicit", () => {
    expect(createClaudeRuntimeProvider().getCapabilities()).toMatchObject({
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
