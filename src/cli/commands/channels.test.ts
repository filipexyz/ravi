import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbGetChannel } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { buildRunnerPm2Env, ChannelsCommands } from "./channels.js";

const ORIGINAL_ENV = { ...process.env };
let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-channels-cli-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
  process.env = { ...ORIGINAL_ENV };
});

describe("channels command runner env", () => {
  it("does not use Slack connection env as runner configuration", () => {
    process.env.RAVI_SLACK_CONNECTION = "ravi-rbbt-slack";
    process.env.RAVI_SLACK_CONNECTIONS = "ravi-rbbt-slack,hana-slack";
    process.env.RAVI_SLACK_CREDENTIAL_CONNECTION = "legacy";

    const env = buildRunnerPm2Env();

    expect(env).not.toHaveProperty("RAVI_SLACK_CONNECTION");
    expect(env).not.toHaveProperty("RAVI_SLACK_CONNECTIONS");
    expect(env).not.toHaveProperty("RAVI_SLACK_CREDENTIAL_CONNECTION");
  });

  it("preserves channel runner behavior flags", () => {
    process.env.RAVI_CHANNELS_CONSUME_OUTBOUND = "0";
    process.env.RAVI_SLACK_THREAD_REPLY_MODE = "thread";

    expect(buildRunnerPm2Env()).toMatchObject({
      RAVI_CHANNELS_CONSUME_OUTBOUND: "0",
      RAVI_SLACK_THREAD_REPLY_MODE: "thread",
    });
  });
});

describe("channels config commands", () => {
  it("creates and updates native channel config without instances", () => {
    const commands = new ChannelsCommands();

    const created = commands.create("ravi-rbbt-slack", "slack", undefined, true);

    expect(created.channel).toMatchObject({
      name: "ravi-rbbt-slack",
      provider: "slack",
      enabled: true,
    });
    expect(dbGetChannel("ravi-rbbt-slack")).toMatchObject({
      name: "ravi-rbbt-slack",
      provider: "slack",
      enabled: true,
    });

    const updated = commands.set("ravi-rbbt-slack", "enabled", "false", true);

    expect(updated.channel.enabled).toBe(false);
    expect(commands.show("ravi-rbbt-slack", true).enabled).toBe(false);
    expect(commands.list("slack", true)).toMatchObject({
      total: 1,
      channels: [
        {
          name: "ravi-rbbt-slack",
          provider: "slack",
          enabled: false,
        },
      ],
    });
  });

  it("stores provider defaults on channel config", () => {
    const commands = new ChannelsCommands();

    commands.create("ravi-rbbt-slack", "slack", undefined, true);
    const updated = commands.set("ravi-rbbt-slack", "defaults", '{"subscriptionScope":"chat_and_thread"}', true);

    expect(updated.channel.defaults).toEqual({ subscriptionScope: "chat_and_thread" });
    expect(dbGetChannel("ravi-rbbt-slack")?.defaults).toEqual({ subscriptionScope: "chat_and_thread" });
  });
});
