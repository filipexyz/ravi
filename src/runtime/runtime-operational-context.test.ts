import { describe, expect, it } from "bun:test";
import { buildRootOperationalHelp, buildRuntimeOperationalContextContent } from "./runtime-operational-context.js";

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
    expect(text).toContain("agent source: context-registry");
    expect(text).toContain("session: `task-work`");
    expect(text).toContain("session source: context-registry");
    expect(text).toContain("context: `ctx_public` (agent-runtime)");
    expect(text).toContain("tool capabilities: 1");
    expect(text).toContain("command-group capabilities: 1");
    expect(text).toContain("ravi self permissions --json");
    expect(text).not.toContain("rctx_");
    expect(text).not.toContain("contextKey");
  });

  it("keeps registry identity and capabilities authoritative over ambient env", () => {
    const text = buildRootOperationalHelp(
      {
        RAVI_AGENT_ID: "ambient-agent",
        RAVI_SESSION_NAME: "ambient-session",
        RAVI_CHANNEL: "ambient-channel",
        RAVI_CHAT_ID: "ambient-chat",
        PWD: "/repo",
      },
      {
        contextId: "ctx_registry",
        kind: "admin-bootstrap",
        agentId: "registry-agent",
        sessionKey: "agent:registry-agent:main",
        sessionName: "registry-session",
        source: { channel: "slack", accountId: "main", chatId: "chat_registry" },
        capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
      },
    );

    expect(text).toContain("agent: `registry-agent`");
    expect(text).toContain("agent source: context-registry");
    expect(text).toContain("session: `registry-session`");
    expect(text).toContain("capabilities: 1");
    expect(text).toContain("context source: `slack | account=main | chat=chat_registry`");
    expect(text).toContain("invocation source: `ambient-channel`");
    expect(text).not.toContain("agent: `ambient-agent`");
  });

  it("labels legacy env as fallback and does not invent capabilities", () => {
    const text = buildRootOperationalHelp(
      { RAVI_AGENT_ID: "ambient-agent", RAVI_SESSION_NAME: "ambient-session", PWD: "/repo" },
      null,
    );

    expect(text).toContain("agent: `ambient-agent`");
    expect(text).toContain("agent source: legacy-environment");
    expect(text).toContain("session source: legacy-environment");
    expect(text).toContain("capabilities: unavailable because no runtime context was resolved");
    expect(text).not.toContain("capabilities: none materialized");
  });
});
