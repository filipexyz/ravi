import { describe, expect, it } from "bun:test";
import { buildRuntimeEnv } from "./host-env.js";
import type { RuntimeCapabilities } from "./types.js";

const capabilities: RuntimeCapabilities = {
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "none" },
  execution: { mode: "sdk" },
  sessionState: { mode: "provider-session-id" },
  usage: { semantics: "terminal-event" },
  tools: {
    permissionMode: "ravi-host",
    accessRequirement: "tool_and_executable",
    supportsParallelCalls: false,
  },
  systemPrompt: { mode: "append" },
  terminalEvents: { guarantee: "adapter" },
  skillVisibility: { availability: "none", loadedState: "none" },
  supportsSessionResume: true,
  supportsSessionFork: true,
  supportsPartialText: true,
  supportsToolHooks: true,
  supportsPlugins: true,
  supportsMcpServers: true,
  supportsRemoteSpawn: true,
};

describe("runtime host env", () => {
  it("keeps Ravi-owned env authoritative over base and provider bootstrap env", () => {
    const env = buildRuntimeEnv(
      {
        PATH: "/usr/bin",
        RAVI_TASK_ID: "stale-task",
        RAVI_CONTEXT_KEY: "stale-context",
      },
      {
        RAVI_CONTEXT_KEY: "runtime-context",
        RAVI_SESSION_NAME: "runtime-session",
      },
      {
        RAVI_CONTEXT_KEY: "provider-context",
        RAVI_SESSION_NAME: "provider-session",
        PROVIDER_FLAG: "1",
      },
      capabilities,
    );

    expect(env.RAVI_CONTEXT_KEY).toBe("runtime-context");
    expect(env.RAVI_SESSION_NAME).toBe("runtime-session");
    expect(env.RAVI_TASK_ID).toBeUndefined();
    expect(env.PROVIDER_FLAG).toBe("1");
  });

  it("removes every known upstream credential in Hub proxy mode even when hooks exist", () => {
    const env = buildRuntimeEnv(
      {
        OPENAI_API_KEY: "secret-openai",
        ANTHROPIC_AUTH_TOKEN: "secret-anthropic",
        OPENROUTER_API_KEY: "secret-openrouter",
        AWS_SECRET_ACCESS_KEY: "secret-aws",
        PATH: "/usr/bin",
      },
      { RAVI_CONTEXT_KEY: "runtime-context" },
      { RAVI_INTELLIGENCE_BINDING_HANDLE: "binding_a" },
      capabilities,
      true,
    );
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.RAVI_INTELLIGENCE_BINDING_HANDLE).toBe("binding_a");
  });
});
