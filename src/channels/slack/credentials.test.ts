import { describe, expect, it, mock } from "bun:test";
import {
  credentialConnectionForInstance,
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

  it("resolves broker credentials from the enabled Slack instance", async () => {
    const resolveSecret = mock(async () => ({
      secret: JSON.stringify({
        appToken: "xapp-broker",
        botToken: "xoxb-broker",
        accountId: "T1",
      }),
      connection: { connection: "ravi-rbbt-slack" },
    }));

    const config = await resolveSlackCredentialConfigFromEnv(
      {},
      {
        resolveSecret,
        instances: {
          "ravi-rbbt-slack": slackInstance({
            name: "ravi-rbbt-slack",
            instanceId: "slack-instance-1",
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
      instanceId: "slack-instance-1",
      connection: "ravi-rbbt-slack",
      source: "broker",
    });
  });

  it("uses the instance credential connection default when configured", async () => {
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
        instances: {
          "ravi-rbbt-slack": slackInstance({
            name: "ravi-rbbt-slack",
            instanceId: "slack-instance-1",
            defaults: { slackCredentialConnection: "rbbt-secret" },
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
      instanceId: "slack-instance-1",
      connection: "rbbt-secret",
      source: "broker",
    });
  });

  it("does not guess a broker connection when multiple Slack instances are enabled", async () => {
    const resolveSecret = mock(async () => ({
      secret: JSON.stringify({ appToken: "xapp-broker", botToken: "xoxb-broker" }),
    }));

    const config = await resolveSlackCredentialConfigFromEnv(
      {},
      {
        resolveSecret,
        instances: {
          "ravi-rbbt-slack": slackInstance({ name: "ravi-rbbt-slack" }),
          "ravi-slack-dev": slackInstance({ name: "ravi-slack-dev" }),
        },
      },
    );

    expect(config).toBeNull();
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("resolves broker credentials when an explicit dev connection override is configured", async () => {
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
      connection: "main",
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
      connection: "slack",
      source: "env",
    });
  });

  it("maps Slack instances to broker connection ids", () => {
    expect(
      credentialConnectionForInstance(
        slackInstance({
          name: "ravi-rbbt-slack",
          defaults: { credentials: { slackConnection: "rbbt-secret" } },
        }),
      ),
    ).toBe("rbbt-secret");
    expect(credentialConnectionForInstance(slackInstance({ name: "ravi-rbbt-slack" }))).toBe("ravi-rbbt-slack");
  });
});

function slackInstance(input: {
  name: string;
  instanceId?: string;
  defaults?: Record<string, unknown>;
  enabled?: boolean;
}) {
  return {
    name: input.name,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    channel: "slack",
    dmPolicy: "closed" as const,
    groupPolicy: "allowlist" as const,
    contactIntakeMode: "off" as const,
    enabled: input.enabled ?? true,
    ...(input.defaults ? { defaults: input.defaults } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}
