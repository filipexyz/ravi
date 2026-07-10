import { describe, expect, it } from "bun:test";

import { buildPm2Env } from "./pm2.js";

describe("buildPm2Env", () => {
  it("strips runtime context identity from PM2 child processes", () => {
    const env = buildPm2Env({
      RAVI_CONTEXT_KEY: "rctx_child",
      RAVI_SESSION_KEY: "session_key",
      RAVI_SESSION_NAME: "main",
      RAVI_AGENT_ID: "agent-main",
      RAVI_CHANNEL: "slack",
      RAVI_ACCOUNT_ID: "account",
      RAVI_CHAT_ID: "chat",
      RAVI_THREAD_ID: "thread",
    });

    expect(env).not.toHaveProperty("RAVI_CONTEXT_KEY");
    expect(env).not.toHaveProperty("RAVI_SESSION_KEY");
    expect(env).not.toHaveProperty("RAVI_SESSION_NAME");
    expect(env).not.toHaveProperty("RAVI_AGENT_ID");
    expect(env).not.toHaveProperty("RAVI_CHANNEL");
    expect(env).not.toHaveProperty("RAVI_ACCOUNT_ID");
    expect(env).not.toHaveProperty("RAVI_CHAT_ID");
    expect(env).not.toHaveProperty("RAVI_THREAD_ID");
  });

  it("lets a single Slack connection override an inherited multi-connection list", () => {
    const previous = process.env.RAVI_SLACK_CONNECTIONS;
    process.env.RAVI_SLACK_CONNECTIONS = "ravi-rbbt-slack,hana-slack";
    try {
      const env = buildPm2Env({ RAVI_SLACK_CONNECTION: "hana-slack" });
      expect(env.RAVI_SLACK_CONNECTION).toBe("hana-slack");
      expect(env).not.toHaveProperty("RAVI_SLACK_CONNECTIONS");
    } finally {
      if (previous === undefined) delete process.env.RAVI_SLACK_CONNECTIONS;
      else process.env.RAVI_SLACK_CONNECTIONS = previous;
    }
  });

  it("lets a multi Slack connection override inherited single-connection aliases", () => {
    const previousConnection = process.env.RAVI_SLACK_CONNECTION;
    const previousCredentialConnection = process.env.RAVI_SLACK_CREDENTIAL_CONNECTION;
    process.env.RAVI_SLACK_CONNECTION = "old-single";
    process.env.RAVI_SLACK_CREDENTIAL_CONNECTION = "old-credential";
    try {
      const env = buildPm2Env({ RAVI_SLACK_CONNECTIONS: "ravi-rbbt-slack,hana-slack" });
      expect(env.RAVI_SLACK_CONNECTIONS).toBe("ravi-rbbt-slack,hana-slack");
      expect(env).not.toHaveProperty("RAVI_SLACK_CONNECTION");
      expect(env).not.toHaveProperty("RAVI_SLACK_CREDENTIAL_CONNECTION");
    } finally {
      if (previousConnection === undefined) delete process.env.RAVI_SLACK_CONNECTION;
      else process.env.RAVI_SLACK_CONNECTION = previousConnection;
      if (previousCredentialConnection === undefined) delete process.env.RAVI_SLACK_CREDENTIAL_CONNECTION;
      else process.env.RAVI_SLACK_CREDENTIAL_CONNECTION = previousCredentialConnection;
    }
  });
});
