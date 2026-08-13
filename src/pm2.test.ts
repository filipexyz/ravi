import { describe, expect, it } from "bun:test";

import { buildPm2Env } from "./pm2.js";

describe("buildPm2Env", () => {
  it("strips runtime context identity from PM2 child processes", () => {
    const env = buildPm2Env({
      RAVI_CONTEXT_KEY: "rctx_child",
      RAVI_INTERNAL_UPDATE_RUNTIME_REBIND: "internal-request",
      RAVI_SESSION_KEY: "session_key",
      RAVI_SESSION_NAME: "main",
      RAVI_AGENT_ID: "agent-main",
      RAVI_CHANNEL: "slack",
      RAVI_ACCOUNT_ID: "account",
      RAVI_CHAT_ID: "chat",
      RAVI_THREAD_ID: "thread",
      RAVI_SLACK_CONNECTION: "old-single",
      RAVI_SLACK_CONNECTIONS: "old-a,old-b",
      RAVI_SLACK_CREDENTIAL_CONNECTION: "old-credential",
    });

    expect(env).not.toHaveProperty("RAVI_CONTEXT_KEY");
    expect(env).not.toHaveProperty("RAVI_INTERNAL_UPDATE_RUNTIME_REBIND");
    expect(env).not.toHaveProperty("RAVI_SESSION_KEY");
    expect(env).not.toHaveProperty("RAVI_SESSION_NAME");
    expect(env).not.toHaveProperty("RAVI_AGENT_ID");
    expect(env).not.toHaveProperty("RAVI_CHANNEL");
    expect(env).not.toHaveProperty("RAVI_ACCOUNT_ID");
    expect(env).not.toHaveProperty("RAVI_CHAT_ID");
    expect(env).not.toHaveProperty("RAVI_THREAD_ID");
    expect(env).not.toHaveProperty("RAVI_SLACK_CONNECTION");
    expect(env).not.toHaveProperty("RAVI_SLACK_CONNECTIONS");
    expect(env).not.toHaveProperty("RAVI_SLACK_CREDENTIAL_CONNECTION");
  });
});
