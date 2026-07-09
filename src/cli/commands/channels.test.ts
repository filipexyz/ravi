import { describe, expect, it } from "bun:test";
import { buildRunnerPm2ProcessEnv, chooseSlackRunnerConnection } from "./channels.js";

describe("channels command runner env", () => {
  it("uses an explicit Slack connection first", () => {
    expect(
      chooseSlackRunnerConnection({
        explicit: "  ravi-rbbt-slack  ",
        env: { RAVI_SLACK_CONNECTION: "other" },
      }),
    ).toBe("ravi-rbbt-slack");
  });

  it("preserves a Slack connection already present in the current env", () => {
    expect(
      chooseSlackRunnerConnection({
        env: { RAVI_SLACK_CONNECTION: "ravi-rbbt-slack" },
      }),
    ).toBe("ravi-rbbt-slack");
  });

  it("supports the legacy Slack credential connection env name", () => {
    expect(
      chooseSlackRunnerConnection({
        env: { RAVI_SLACK_CREDENTIAL_CONNECTION: "ravi-rbbt-slack" },
      }),
    ).toBe("ravi-rbbt-slack");
  });

  it("does not synthesize a Slack connection from credentials or routes", () => {
    expect(
      chooseSlackRunnerConnection({
        env: {},
      }),
    ).toBeUndefined();
  });

  it("strips runtime context and Slack token env from the persistent PM2 runner", () => {
    const env = buildRunnerPm2ProcessEnv({
      baseEnv: {
        NATS_URL: "nats://127.0.0.1:4222",
        PATH: "/usr/bin",
        RAVI_AGENT_ID: "main",
        RAVI_CHANNEL: "whatsapp-baileys",
        RAVI_CONTEXT_KEY: "rctx_secret",
        RAVI_SESSION_KEY: "agent:main:main",
        RAVI_SLACK_BOT_TOKEN: "xoxb-secret",
        RAVI_WEBHOOK_PUBLIC_BASE_URL: "https://example.test",
      },
      envOverrides: {
        RAVI_SLACK_CONNECTIONS: "ravi-rbbt-slack,hana-slack",
      },
    });

    expect(env).toMatchObject({
      NATS_URL: "nats://127.0.0.1:4222",
      PATH: "/usr/bin",
      RAVI_SLACK_CONNECTIONS: "ravi-rbbt-slack,hana-slack",
      RAVI_WEBHOOK_PUBLIC_BASE_URL: "https://example.test",
    });
    expect(env.RAVI_CONTEXT_KEY).toBeUndefined();
    expect(env.RAVI_SESSION_KEY).toBeUndefined();
    expect(env.RAVI_AGENT_ID).toBeUndefined();
    expect(env.RAVI_CHANNEL).toBeUndefined();
    expect(env.RAVI_SLACK_BOT_TOKEN).toBeUndefined();
  });
});
