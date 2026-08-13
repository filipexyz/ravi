import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createChannelRunnerHealthSnapshot, type ChannelRunnerRuntimeStatus } from "../../channels/health.js";
import { dbGetChannel } from "../../router/router-db.js";
import {
  cleanupIsolatedRaviState,
  createIsolatedRaviState,
  withoutRaviRuntimeContextEnv,
} from "../../test/ravi-state.js";

// Manual v2 contract: hasContext() true makes the contract helpers throw
// ContractError instead of process.exit, which is what tests need.
const actualContext = await import("../context.js");
mock.module("../context.js", () => ({
  ...actualContext,
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const {
  buildChannelsLiveStatusJson,
  buildRunnerPm2Env,
  ChannelsCommands,
  classifyChannelRunnerHealth,
  validateChannelRunnerRuntimeTarget,
} = await import("./channels.js");
const { ContractError } = await import("../agent-contract.js");

afterAll(() => mock.restore());

const ORIGINAL_ENV = { ...process.env };
const tempDirs: string[] = [];
let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-channels-cli-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
  process.env = { ...ORIGINAL_ENV };
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
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

describe("channels runner lifecycle", () => {
  it("recreates a stopped PM2 entry from the current bundle and persists it", () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-channels-restart-"));
    tempDirs.push(root);
    const runtimeRoot = join(root, "runtime");
    const bundlePath = join(runtimeRoot, "dist", "bundle", "index.js");
    const fakeBinDir = join(root, "bin");
    const fakePm2Path = join(fakeBinDir, "pm2");
    const pm2LogPath = join(root, "pm2.log");

    mkdirSync(join(bundlePath, ".."), { recursive: true });
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ name: "ravi.bot", version: "test" }), "utf8");
    writeFileSync(bundlePath, "", "utf8");
    writeFileSync(
      fakePm2Path,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$CHANNELS_TEST_PM2_LOG"',
        'if [ "$1" = "jlist" ]; then',
        `  printf '%s\\n' '${JSON.stringify([
          {
            name: "ravi",
            pm_id: 1,
            pid: 1234,
            pm2_env: {
              status: "online",
              pm_exec_path: bundlePath,
              pm_cwd: runtimeRoot,
              args: ["daemon", "run"],
              env: {},
            },
            monit: { cpu: 0, memory: 0 },
          },
          {
            name: "ravi-channels",
            pm_id: 2,
            pid: 0,
            pm2_env: {
              status: "stopped",
              pm_exec_path: "/old/bun",
              pm_cwd: "/old",
              args: ["/old/index.js", "channels", "run"],
              env: {},
            },
            monit: { cpu: 0, memory: 0 },
          },
        ])}'`,
        "fi",
        "exit 0",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakePm2Path, 0o755);

    const result = spawnSync("bun", ["src/cli/index.ts", "channels", "restart", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...withoutRaviRuntimeContextEnv(process.env),
        HOME: join(root, "home"),
        PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ""}`,
        RAVI_STATE_DIR: join(root, "state"),
        RAVI_CREDENTIALS_PATH: join(root, "missing-credentials.json"),
        RAVI_BUNDLE: bundlePath,
        RAVI_DAEMON_CWD: runtimeRoot,
        RAVI_SUPPRESS_AUDIT_EVENTS: "1",
        CHANNELS_TEST_PM2_LOG: pm2LogPath,
      },
    });
    const pm2Log = readFileSync(pm2LogPath, "utf8");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(pm2Log).toContain("delete ravi-channels");
    expect(pm2Log).toContain(`start bun --name ravi-channels -- ${realpathSync(bundlePath)} channels run`);
    expect(pm2Log).toContain("save --force");
  }, 20_000);
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

// Manual v2 agent-first contract for the CONFIG commands only (create/set are
// declared unbraked reversible writes; start/stop/restart/run/logs stay
// process infrastructure outside this contract).
describe("channels config contract", () => {
  it("show on an unknown channel exits 1 with CHANNEL_NOT_FOUND and suggestions from local config names", async () => {
    const commands = new ChannelsCommands();
    await silenced(() => commands.create("ravi-rbbt-slack", "slack", undefined, true));

    const error = await expectContractError(() => commands.show("rbbt-slack", true), "CHANNEL_NOT_FOUND", 1);

    expect(error.details.suggestions).toContain("ravi-rbbt-slack");
    expect(error.details.suggestedAction).toContain("ravi channels list");
  });

  it("set on an unknown channel exits 1 with CHANNEL_NOT_FOUND and does not write", async () => {
    const commands = new ChannelsCommands();
    await expectContractError(() => commands.set("ghost", "enabled", "false", true), "CHANNEL_NOT_FOUND", 1);

    expect(dbGetChannel("ghost")).toBeNull();
  });

  it("create with an unknown credential connection exits 1 with CREDENTIAL_CONNECTION_NOT_FOUND and does not write", async () => {
    const commands = new ChannelsCommands();
    const error = await expectContractError(
      () => commands.create("ravi-rbbt-slack", "slack", "missing-connection", true),
      "CREDENTIAL_CONNECTION_NOT_FOUND",
      1,
    );

    expect(error.details.suggestedAction).toContain("ravi credentials connections add");
    expect(dbGetChannel("ravi-rbbt-slack")).toBeNull();
  });

  it("list --fields narrows each channel to the requested fields", async () => {
    const commands = new ChannelsCommands();
    await silenced(() => commands.create("ravi-rbbt-slack", "slack", undefined, true));
    await silenced(() => commands.create("hana-slack", "slack", undefined, true));

    const payload = await silenced(() => commands.list(undefined, true, undefined, undefined, "name,provider"));

    expect(payload.items).toHaveLength(2);
    for (const item of payload.items as unknown as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["name", "provider"]);
    }
  });
});

async function silenced<T>(run: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<InstanceType<typeof ContractError>> {
  let caught: unknown;
  await silenced(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as InstanceType<typeof ContractError>;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

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

  it("classifies outbound consumer loop errors as degraded", () => {
    const snapshot = createChannelRunnerHealthSnapshot({
      ...liveRunnerStatus(),
      outbound: {
        ...liveRunnerStatus().outbound,
        lastError: {
          phase: "consume_loop",
          message: "JetStream consumer unavailable",
          at: 1_721_563_204_000,
        },
      },
    });

    expect(classifyChannelRunnerHealth(snapshot)).toBe("degraded");
  });

  it("classifies native publish outbox failures as degraded", () => {
    const snapshot = createChannelRunnerHealthSnapshot({
      ...liveRunnerStatus(),
      outbound: {
        ...liveRunnerStatus().outbound,
        publishOutbox: {
          pendingCount: 1,
          nextAttemptAt: 1_721_563_234_000,
          lastError: {
            message: "503 no space left on device",
            at: 1_721_563_204_000,
          },
        },
      },
    });

    expect(classifyChannelRunnerHealth(snapshot)).toBe("degraded");
  });
});

describe("channels runner runtime target parity", () => {
  it("accepts the daemon-authoritative bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-channels-target-"));
    tempDirs.push(root);
    const bundlePath = join(root, "dist", "bundle", "index.js");
    mkdirSync(join(bundlePath, ".."), { recursive: true });
    writeFileSync(bundlePath, "", "utf8");

    const validation = validateChannelRunnerRuntimeTarget(
      { bundlePath, cwd: root },
      {
        inspectRuntimeTarget: () =>
          ({
            daemon: {
              online: true,
              execPath: bundlePath,
              cwd: root,
              matchesCli: true,
            },
          }) as never,
      },
    );

    expect(validation).toEqual({ ok: true });
  });

  it("rejects a channel runner bundle that diverges from the live daemon", () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-channels-target-mismatch-"));
    tempDirs.push(root);
    const daemonBundle = join(root, "daemon", "dist", "bundle", "index.js");
    const targetBundle = join(root, "stale", "dist", "bundle", "index.js");
    mkdirSync(join(daemonBundle, ".."), { recursive: true });
    mkdirSync(join(targetBundle, ".."), { recursive: true });
    writeFileSync(daemonBundle, "", "utf8");
    writeFileSync(targetBundle, "", "utf8");

    const validation = validateChannelRunnerRuntimeTarget(
      { bundlePath: targetBundle, cwd: join(root, "stale") },
      {
        inspectRuntimeTarget: () =>
          ({
            daemon: {
              online: true,
              execPath: daemonBundle,
              cwd: join(root, "daemon"),
              matchesCli: false,
            },
          }) as never,
      },
    );

    expect(validation).toMatchObject({
      ok: false,
      targetBundle: realpathSync(targetBundle).toLowerCase(),
      daemonBundle: realpathSync(daemonBundle).toLowerCase(),
    });
    if (!validation.ok) {
      expect(validation.message).toContain("Refusing to start channel runner");
    }
  });
});
