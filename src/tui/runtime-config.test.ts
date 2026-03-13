import { describe, expect, it } from "bun:test";
import { applyAgentRuntimeSelection } from "./runtime-config.js";

describe("applyAgentRuntimeSelection", () => {
  it("updates the agent and session override before publishing config changed", async () => {
    const calls: string[] = [];

    await applyAgentRuntimeSelection(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "codex",
        model: "gpt-5.4",
      },
      {
        updateAgent(id, updates) {
          calls.push(`updateAgent:${id}:${updates.provider}:${updates.model}`);
        },
        updateSessionModelOverride(sessionKey, model) {
          calls.push(`updateSession:${sessionKey}:${model}`);
        },
        async publish(topic, data) {
          calls.push(`publish:${topic}:${JSON.stringify(data)}`);
        },
      },
    );

    expect(calls).toEqual([
      "updateAgent:main:codex:gpt-5.4",
      "updateSession:agent:main:main:gpt-5.4",
      "publish:ravi.config.changed:{}",
    ]);
  });
});
