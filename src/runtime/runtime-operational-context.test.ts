import { describe, expect, it } from "bun:test";
import { buildRuntimeOperationalContextContent } from "./runtime-operational-context.js";

describe("buildRuntimeOperationalContextContent", () => {
  it("keeps the operational context markdown compact and secret-safe", () => {
    const text = buildRuntimeOperationalContextContent({
      agentId: "dev",
      sessionName: "task-work",
      cwd: "/repo",
      runtimeContext: {
        contextId: "ctx_public",
        kind: "agent-runtime",
        agentId: "dev",
        sessionKey: "agent:dev:main",
        sessionName: "task-work",
        source: { channel: "whatsapp", accountId: "main", chatId: "chat_123" },
        capabilities: [
          { permission: "use", objectType: "tool", objectId: "Bash" },
          { permission: "execute", objectType: "group", objectId: "tasks" },
        ],
      },
    });

    expect(text).toContain("agent: `dev`");
    expect(text).toContain("session: `task-work`");
    expect(text).toContain("context: `ctx_public` (agent-runtime)");
    expect(text).toContain("tool capabilities: 1");
    expect(text).toContain("command-group capabilities: 1");
    expect(text).toContain("ravi self permissions --json");
    expect(text).not.toContain("rctx_");
    expect(text).not.toContain("contextKey");
  });
});
