import { describe, expect, it, mock } from "bun:test";
import {
  credentialConnectionForChannel,
  isSlackGatewayChannel,
  parseSlackSecretPayload,
  resolveSlackCredentialConfigFromEnv,
} from "./credentials.js";

describe("Slack credential config", () => {
  it("does not expose malformed credential JSON in diagnostics", async () => {
    const failure = await resolveSlackCredentialConfigFromEnv(
      {},
      {
        channel: slackChannel({ name: "fixture-slack", credentialConnection: "fixture" }),
        resolveSecret: async () => ({ secret: '{"botToken": "xoxb-never-log-fixture" malformed}' }),
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Slack credential JSON secret is invalid.");
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain("xoxb-never-log-fixture");
  });

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

  it("forwards explicit host authority without inferring it for ordinary resolution", async () => {
    const resolveSecret = mock(async () => ({
      secret: JSON.stringify({ appToken: "xapp-test", botToken: "xoxb-test" }),
    }));
    const channel = slackChannel({ name: "test-slack", credentialConnection: "test-connection" });
    const authority = { kind: "internal-service", service: "slack-channel-runtime" } as const;

    await resolveSlackCredentialConfigFromEnv({}, { channel, resolveSecret, authority });
    expect(resolveSecret).toHaveBeenLastCalledWith({
      provider: "slack",
      connection: "test-connection",
      action: "socket_mode.connect",
      authority,
    });

    await resolveSlackCredentialConfigFromEnv({}, { channel, resolveSecret, action: "users.info" });
    expect(resolveSecret).toHaveBeenLastCalledWith({
      provider: "slack",
      connection: "test-connection",
      action: "users.info",
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

  it("resolves the Hub gateway without hydrating Slack tokens", async () => {
    const resolveSecret = mock(async () => {
      throw new Error("broker must not be called");
    });
    const channel = slackChannel({
      name: "slack-main",
      defaults: { transport: "hub_gateway_v1" },
    });
    const credential = "runtime-credential-".padEnd(48, "x");

    const config = await resolveSlackCredentialConfigFromEnv(
      {
        RAVI_SLACK_GATEWAY_URL: "https://ravi.example.test/",
        RAVI_RUNTIME_ID: "11111111-1111-4111-8111-111111111111",
        RAVI_RUNTIME_CREDENTIAL: credential,
      },
      { channel, channels: { "slack-main": channel }, resolveSecret },
    );

    expect(resolveSecret).not.toHaveBeenCalled();
    expect(isSlackGatewayChannel(channel)).toBeTrue();
    expect(config).toMatchObject({
      source: "gateway",
      accountId: "slack-main",
      apiBaseUrl: "https://ravi.example.test/api/runtime/v1/slack/web-api",
      fileProxyUrl: "https://ravi.example.test/api/runtime/v1/slack/files",
      requestHeaders: {
        authorization: `Bearer ${credential}`,
        "x-ravi-runtime-id": "11111111-1111-4111-8111-111111111111",
      },
    });
  });

  it("rejects an insecure remote Hub gateway", async () => {
    const channel = slackChannel({ name: "slack-main", defaults: { transport: "hub_gateway_v1" } });
    await expect(
      resolveSlackCredentialConfigFromEnv(
        {
          RAVI_SLACK_GATEWAY_URL: "http://ravi.example.test",
          RAVI_RUNTIME_ID: "11111111-1111-4111-8111-111111111111",
          RAVI_RUNTIME_CREDENTIAL: "runtime-credential-".padEnd(48, "x"),
        },
        { channel },
      ),
    ).rejects.toThrow("must use HTTPS");
  });
});

function slackChannel(input: {
  name: string;
  credentialConnection?: string;
  enabled?: boolean;
  defaults?: Record<string, unknown>;
}) {
  return {
    name: input.name,
    provider: "slack",
    enabled: input.enabled ?? true,
    ...(input.credentialConnection ? { credentialConnection: input.credentialConnection } : {}),
    ...(input.defaults ? { defaults: input.defaults } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}
