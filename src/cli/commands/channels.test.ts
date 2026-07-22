import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createChannelRunnerHealthSnapshot, type ChannelRunnerRuntimeStatus } from "../../channels/health.js";
import { dbGetChannel } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  buildChannelsLiveStatusJson,
  buildRunnerPm2Env,
  ChannelsCommands,
  classifyChannelRunnerHealth,
} from "./channels.js";

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

function liveRunnerStatus(adapterStatus: ChannelRunnerRuntimeStatus["adapters"][number]["status"] = "connected") {
  return createChannelRunnerHealthSnapshot(
    {
      running: true,
      startedAt: 1_721_563_200_000,
      pid: 4242,
      outbound: {
        stream: "CHANNEL_OUTBOUND",
        consumer: "ravi-channels-outbound",
        enabled: true,
        infrastructureReady: true,
        consuming: true,
      },
      adapters: [
        {
          id: "slack:hana-slack",
          channelId: "slack",
          status: adapterStatus,
          reconnectCount: adapterStatus === "reconnecting" ? 1 : 0,
        },
      ],
    },
    1_721_563_203_000,
  );
}

const ONLINE_CHANNELS_PROCESS = {
  name: "ravi-channels",
  pm_id: 2,
  pid: 4242,
  status: "online",
  cpu: 0,
  memory: 64 * 1024 * 1024,
};

describe("channels live status", () => {
  it("separates PM2 process liveness from runner and Slack readiness", async () => {
    const snapshot = liveRunnerStatus();
    const probe = mock(async () => ({ reachable: true as const, snapshot }));

    const payload = await buildChannelsLiveStatusJson({
      pm2Available: true,
      processes: [ONLINE_CHANNELS_PROCESS],
      probe,
      now: () => 1_721_563_204_000,
    });

    expect(payload).toMatchObject({
      channels: { running: true, status: "online", pid: 4242 },
      health: { status: "ready", reachable: true, checkedAt: 1_721_563_204_000 },
      runner: snapshot,
    });
    expect(probe).toHaveBeenCalledWith({ pid: 4242 });
  });

  it("reports a connected process without a health reply as unreachable", async () => {
    const payload = await buildChannelsLiveStatusJson({
      pm2Available: true,
      processes: [ONLINE_CHANNELS_PROCESS],
      probe: async () => ({ reachable: false, reason: "timeout" }),
      now: () => 1_721_563_204_000,
    });

    expect(payload).toMatchObject({
      channels: { running: true, status: "online" },
      health: { status: "unreachable", reachable: false, reason: "timeout" },
      runner: null,
    });
  });

  it("retries against a new PM2 PID when the runner restarts during the probe", async () => {
    const restartedSnapshot = createChannelRunnerHealthSnapshot({
      ...liveRunnerStatus(),
      pid: 4343,
    });
    const probe = mock(async ({ pid }: { pid: number }) =>
      pid === 4242
        ? ({ reachable: false, reason: "no_responders" } as const)
        : ({ reachable: true, snapshot: restartedSnapshot } as const),
    );
    const refreshProcesses = mock(() => [{ ...ONLINE_CHANNELS_PROCESS, pid: 4343 }]);

    const payload = await buildChannelsLiveStatusJson({
      pm2Available: true,
      processes: [ONLINE_CHANNELS_PROCESS],
      refreshProcesses,
      probe,
      now: () => 1_721_563_204_000,
    });

    expect(payload).toMatchObject({
      channels: { pid: 4343, status: "online" },
      health: { status: "ready", reachable: true },
      runner: { pid: 4343 },
    });
    expect(probe.mock.calls.map((call) => call[0].pid)).toEqual([4242, 4343]);
    expect(refreshProcesses).toHaveBeenCalledTimes(1);
  });

  it("does not run a live probe when the PM2 runner is stopped", async () => {
    const probe = mock(async () => ({ reachable: true as const, snapshot: liveRunnerStatus() }));
    const payload = await buildChannelsLiveStatusJson({
      pm2Available: true,
      processes: [{ ...ONLINE_CHANNELS_PROCESS, status: "stopped", pid: 0 }],
      probe,
      now: () => 1_721_563_204_000,
    });

    expect(payload).toMatchObject({
      health: { status: "stopped", reachable: false, reason: "not_running" },
      runner: null,
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("classifies adapter recovery and failure independently from PM2", () => {
    expect(classifyChannelRunnerHealth(liveRunnerStatus("reconnecting"))).toBe("starting");
    expect(classifyChannelRunnerHealth(liveRunnerStatus("failed"))).toBe("degraded");
  });
});
