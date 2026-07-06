import { describe, expect, it, mock } from "bun:test";
import { parseSlackSecretPayload, resolveSlackCredentialConfigFromEnv } from "./credentials.js";

describe("Slack credential config", () => {
  it("parses JSON broker secrets", () => {
    expect(
      parseSlackSecretPayload(
        JSON.stringify({
          appToken: "xapp-test",
          botToken: "xoxb-test",
          accountId: "T1",
          instanceId: "slack-main",
        }),
      ),
    ).toEqual({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: "T1",
      routeAccountId: undefined,
      instanceId: "slack-main",
    });
  });

  it("parses dotenv broker secrets", () => {
    expect(
      parseSlackSecretPayload(`
        SLACK_APP_TOKEN="xapp-test"
        SLACK_BOT_TOKEN='xoxb-test'
        RAVI_SLACK_ACCOUNT=T1
      `),
    ).toMatchObject({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: "T1",
    });
  });

  it("resolves broker credentials when a Slack connection is configured", async () => {
    const resolveSecret = mock(async () => ({
      secret: JSON.stringify({
        appToken: "xapp-broker",
        botToken: "xoxb-broker",
        accountId: "T1",
      }),
      connection: { connection: "main" },
    }));

    const config = await resolveSlackCredentialConfigFromEnv(
      {
        RAVI_SLACK_CONNECTION: "main",
        RAVI_SLACK_INSTANCE: "slack-main",
      } as NodeJS.ProcessEnv,
      { resolveSecret },
    );

    expect(resolveSecret).toHaveBeenCalledWith({
      provider: "slack",
      connection: "main",
      action: "socket_mode.connect",
    });
    expect(config).toMatchObject({
      appToken: "xapp-broker",
      botToken: "xoxb-broker",
      accountId: "T1",
      instanceId: "slack-main",
      source: "broker",
    });
  });

  it("requires an explicit flag before using raw env credentials", async () => {
    expect(
      await resolveSlackCredentialConfigFromEnv({
        SLACK_APP_TOKEN: "xapp-env",
        SLACK_BOT_TOKEN: "xoxb-env",
      } as NodeJS.ProcessEnv),
    ).toBeNull();

    expect(
      await resolveSlackCredentialConfigFromEnv({
        RAVI_SLACK_ALLOW_ENV_CREDENTIALS: "1",
        SLACK_APP_TOKEN: "xapp-env",
        SLACK_BOT_TOKEN: "xoxb-env",
      } as NodeJS.ProcessEnv),
    ).toMatchObject({
      appToken: "xapp-env",
      botToken: "xoxb-env",
      source: "env",
    });
  });
});
