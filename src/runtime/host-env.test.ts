import { describe, expect, it } from "bun:test";
import { buildRuntimeEnv } from "./host-env.js";
import type { RuntimeCapabilities } from "./types.js";

const capabilities: RuntimeCapabilities = {
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
});
