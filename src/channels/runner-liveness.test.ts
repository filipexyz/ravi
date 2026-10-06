import { describe, expect, it, mock } from "bun:test";
import { createChannelRunnerHealthSnapshot } from "./health.js";
import {
  decideChannelRunnerStartAction,
  inspectManagedChannelRunner,
  isStaleChannelRunnerHealthReason,
  scheduleChannelRunnerLivenessReport,
  STALE_CHANNEL_RUNNER_HEALTH_REASONS,
} from "./runner-liveness.js";

const HEALTHY_SNAPSHOT = createChannelRunnerHealthSnapshot({
  running: true,
  startedAt: 1,
  pid: 5661,
  outbound: {
    stream: "CHANNEL_OUTBOUND",
    consumer: "ravi-channels-outbound",
    enabled: true,
    infrastructureReady: true,
    consuming: true,
  },
  adapters: [{ id: "slack:main", channelId: "slack", status: "connected" }],
});

function onlineProcess(pid = 5661) {
  return { name: "ravi-channels", pm_id: 2, pid, status: "online", cpu: 0, memory: 0 };
}

describe("channel runner liveness decision", () => {
  it("treats only timeout, no_responders and pid_mismatch as stale", () => {
    expect(STALE_CHANNEL_RUNNER_HEALTH_REASONS).toEqual(["timeout", "no_responders", "pid_mismatch"]);
    expect(isStaleChannelRunnerHealthReason("timeout")).toBe(true);
    expect(isStaleChannelRunnerHealthReason("no_responders")).toBe(true);
    expect(isStaleChannelRunnerHealthReason("pid_mismatch")).toBe(true);
    expect(isStaleChannelRunnerHealthReason("nats_unavailable")).toBe(false);
    expect(isStaleChannelRunnerHealthReason("invalid_response")).toBe(false);
  });

  it("starts when PM2 is not online and keeps a reachable runner", () => {
    expect(decideChannelRunnerStartAction({ pm2Online: false })).toEqual({ action: "start" });
    expect(
      decideChannelRunnerStartAction({
        pm2Online: true,
        pid: 5661,
        health: { reachable: true, snapshot: HEALTHY_SNAPSHOT },
      }),
    ).toEqual({ action: "already_running", pid: 5661 });
  });

  it("bounces a PM2-online runner whose health subject is dead", () => {
    for (const reason of STALE_CHANNEL_RUNNER_HEALTH_REASONS) {
      expect(
        decideChannelRunnerStartAction({ pm2Online: true, pid: 5661, health: { reachable: false, reason } }),
      ).toEqual({ action: "bounce", pid: 5661, reason });
    }
    expect(decideChannelRunnerStartAction({ pm2Online: true, pid: 0 })).toEqual({
      action: "bounce",
      pid: null,
      reason: "pid_mismatch",
    });
  });

  it("does not bounce when health cannot be confirmed", () => {
    expect(
      decideChannelRunnerStartAction({
        pm2Online: true,
        pid: 5661,
        health: { reachable: false, reason: "nats_unavailable" },
      }),
    ).toEqual({ action: "unconfirmed", pid: 5661, reason: "nats_unavailable" });
    expect(
      decideChannelRunnerStartAction({
        pm2Online: true,
        pid: 5661,
        health: { reachable: false, reason: "invalid_response" },
      }),
    ).toEqual({ action: "unconfirmed", pid: 5661, reason: "invalid_response" });
  });
});

describe("inspectManagedChannelRunner", () => {
  it("probes the PM2 PID and reports a stale runner", async () => {
    const probe = mock(async () => ({ reachable: false as const, reason: "no_responders" as const }));
    const result = await inspectManagedChannelRunner({
      isAvailable: () => true,
      getProcess: () => onlineProcess(),
      probe,
    });
    expect(result).toEqual({ action: "bounce", pid: 5661, reason: "no_responders", pm2Available: true });
    expect(probe).toHaveBeenCalledWith({ pid: 5661 });
  });

  it("reports a healthy runner as already running", async () => {
    const result = await inspectManagedChannelRunner({
      isAvailable: () => true,
      getProcess: () => onlineProcess(),
      probe: async () => ({ reachable: true, snapshot: HEALTHY_SNAPSHOT }),
    });
    expect(result).toEqual({ action: "already_running", pid: 5661, pm2Available: true });
  });

  it("does not probe when PM2 is unavailable or the runner is not online", async () => {
    const probe = mock(async () => ({ reachable: true as const, snapshot: HEALTHY_SNAPSHOT }));
    expect(await inspectManagedChannelRunner({ isAvailable: () => false, probe })).toEqual({
      action: "start",
      pm2Available: false,
    });
    expect(
      await inspectManagedChannelRunner({
        isAvailable: () => true,
        getProcess: () => ({ ...onlineProcess(0), status: "stopped" }),
        probe,
      }),
    ).toEqual({ action: "start", pm2Available: true });
    expect(await inspectManagedChannelRunner({ isAvailable: () => true, getProcess: () => undefined, probe })).toEqual({
      action: "start",
      pm2Available: true,
    });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("scheduleChannelRunnerLivenessReport", () => {
  async function runOnce(options: {
    decision: Awaited<ReturnType<typeof inspectManagedChannelRunner>>;
    isStopping?: () => boolean;
  }) {
    const report = mock(() => {});
    const inspect = mock(async () => options.decision);
    scheduleChannelRunnerLivenessReport({ delayMs: 0, inspect, report, isStopping: options.isStopping });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { report, inspect };
  }

  it("reports a stale or unconfirmed runner and never bounces it", async () => {
    const stale = await runOnce({
      decision: { action: "bounce", pid: 5661, reason: "timeout", pm2Available: true },
    });
    expect(stale.report).toHaveBeenCalledWith(expect.objectContaining({ action: "bounce", pid: 5661 }));

    const unconfirmed = await runOnce({
      decision: { action: "unconfirmed", pid: 5661, reason: "invalid_response", pm2Available: true },
    });
    expect(unconfirmed.report).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for a healthy or absent runner and while the daemon is stopping", async () => {
    const healthy = await runOnce({ decision: { action: "already_running", pid: 5661, pm2Available: true } });
    expect(healthy.report).not.toHaveBeenCalled();

    const absent = await runOnce({ decision: { action: "start", pm2Available: true } });
    expect(absent.report).not.toHaveBeenCalled();

    const stopping = await runOnce({
      decision: { action: "bounce", pid: 5661, reason: "timeout", pm2Available: true },
      isStopping: () => true,
    });
    expect(stopping.inspect).not.toHaveBeenCalled();
    expect(stopping.report).not.toHaveBeenCalled();
  });
});
