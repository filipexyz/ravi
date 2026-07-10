import { describe, expect, it, mock } from "bun:test";
import {
  credentialConnectionForChannel,
  parseSlackSecretPayload,
  resolveSlackCredentialConfigFromEnv,
} from "./credentials.js";

describe("Slack credential config", () => {
  it("parses JSON broker secrets", () => {
    expect(
      parseSlackSecretPayload(
        JSON.stringify({
          appToken: "xapp-test",
          botToken: "xoxb-test",
        }),
      ),
    ).toEqual({
      appToken: "xapp-test",
      botToken: "xoxb-test",
    });
  });

  it("parses dotenv broker secrets", () => {
    expect(
      parseSlackSecretPayload(`
        SLACK_APP_TOKEN="xapp-test"
        SLACK_BOT_TOKEN='xoxb-test'
      `),
    ).toMatchObject({
      appToken: "xapp-test",
      botToken: "xoxb-test",
    });
  });

  it("resolves broker credentials from the enabled Slack channel", async () => {
    const resolveSecret = mock(async () => ({
      secret: JSON.stringify({
        appToken: "xapp-broker",
        botToken: "xoxb-broker",
      }),
      connection: { connection: "ravi-rbbt-slack" },
    }));

    const config = await resolveSlackCredentialConfigFromEnv(
      {},
      {
        resolveSecret,
        channel: slackChannel({
          name: "ravi-rbbt-slack",
          credentialConnection: "ravi-rbbt-slack",
        }),
        channels: {
          "ravi-rbbt-slack": slackChannel({
            name: "ravi-rbbt-slack",
            credentialConnection: "ravi-rbbt-slack",
          }),
        },
      },
    );

    expect(resolveSecret).toHaveBeenCalledWith({
      provider: "slack",
      connection: "ravi-rbbt-slack",
      action: "socket_mode.connect",
    });
    expect(config).toMatchObject({
      appToken: "xapp-broker",
      botToken: "xoxb-broker",
      accountId: "ravi-rbbt-slack",
      routeAccountId: "ravi-rbbt-slack",
      channel: "ravi-rbbt-slack",
      instanceId: "ravi-rbbt-slack",
      connection: "ravi-rbbt-slack",
      source: "broker",
    });
  });

  it("uses the channel credential connection when configured", async () => {
    const resolveSecret = mock(async () => ({
      secret: JSON.stringify({
        appToken: "xapp-broker",
        botToken: "xoxb-broker",
      }),
      connection: { connection: "rbbt-secret" },
    }));

    const config = await resolveSlackCredentialConfigFromEnv(
      {},
      {
        resolveSecret,
        channel: slackChannel({
          name: "ravi-rbbt-slack",
          credentialConnection: "rbbt-secret",
        }),
        channels: {
          "ravi-rbbt-slack": slackChannel({
            name: "ravi-rbbt-slack",
            credentialConnection: "rbbt-secret",
          }),
        },
      },
    );

    expect(resolveSecret).toHaveBeenCalledWith({
      provider: "slack",
      connection: "rbbt-secret",
      action: "socket_mode.connect",
    });
    expect(config).toMatchObject({
      accountId: "ravi-rbbt-slack",
      routeAccountId: "ravi-rbbt-slack",
      channel: "ravi-rbbt-slack",
      instanceId: "ravi-rbbt-slack",
      connection: "rbbt-secret",
      source: "broker",
    });
  });

  it("does not guess a broker connection from channel names", async () => {
    const resolveSecret = mock(async () => ({
      secret: JSON.stringify({ appToken: "xapp-broker", botToken: "xoxb-broker" }),
    }));

    const config = await resolveSlackCredentialConfigFromEnv(
      {},
      {
        resolveSecret,
        channels: {
          "ravi-rbbt-slack": slackChannel({ name: "ravi-rbbt-slack" }),
        },
      },
    );

    expect(config).toBeNull();
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("maps Slack channels to broker connection ids", () => {
    expect(
      credentialConnectionForChannel(
        slackChannel({
          name: "ravi-rbbt-slack",
          credentialConnection: "rbbt-secret",
        }),
      ),
    ).toBe("rbbt-secret");
    expect(credentialConnectionForChannel(slackChannel({ name: "ravi-rbbt-slack" }))).toBeUndefined();
  });
});

function slackChannel(input: { name: string; credentialConnection?: string; enabled?: boolean }) {
  return {
    name: input.name,
    provider: "slack",
    enabled: input.enabled ?? true,
    ...(input.credentialConnection ? { credentialConnection: input.credentialConnection } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}
