import { describe, expect, it, mock } from "bun:test";
import {
  bounceManagedChannelRunnerProcess,
  decideChannelRunnerStartAction,
  isStaleChannelRunnerHealthReason,
  reconcileManagedChannelRunner,
  STALE_CHANNEL_RUNNER_HEALTH_REASONS,
} from "./runner-liveness.js";
import { createChannelRunnerHealthSnapshot } from "./health.js";

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

describe("channel runner liveness", () => {
  it("treats timeout, no_responders, and pid_mismatch as stale health", () => {
    expect(STALE_CHANNEL_RUNNER_HEALTH_REASONS).toEqual(["timeout", "no_responders", "pid_mismatch"]);
    expect(isStaleChannelRunnerHealthReason("timeout")).toBe(true);
    expect(isStaleChannelRunnerHealthReason("no_responders")).toBe(true);
    expect(isStaleChannelRunnerHealthReason("pid_mismatch")).toBe(true);
    expect(isStaleChannelRunnerHealthReason("nats_unavailable")).toBe(false);
  });

  it("starts when PM2 is not online and keeps a healthy runner", () => {
    expect(decideChannelRunnerStartAction()).toEqual({ action: "start" });
    expect(
      decideChannelRunnerStartAction({
        pm2Online: true,
        pid: 5661,
        health: { reachable: true, snapshot: HEALTHY_SNAPSHOT },
      }),
    ).toEqual({ action: "already_running" });
  });

  it("bounces stale health and refuses to no-op when NATS is unavailable", () => {
    expect(
      decideChannelRunnerStartAction({
        pm2Online: true,
        pid: 5661,
        health: { reachable: false, reason: "timeout" },
      }),
    ).toEqual({ action: "bounce", pid: 5661, reason: "timeout" });
    expect(
      decideChannelRunnerStartAction({
        pm2Online: true,
        pid: 5661,
        health: { reachable: false, reason: "nats_unavailable" },
      }),
    ).toEqual({ action: "unconfirmed", reason: "nats_unavailable" });
  });

  it("reconciles an online-but-stale runner by bouncing it", async () => {
    const bounce = mock(() => ({
      ok: true,
      pm2Status: 0,
      previousPid: 5661,
      reason: "stale_timeout",
    }));
    const result = await reconcileManagedChannelRunner({
      isAvailable: () => true,
      getProcess: () =>
        ({
          name: "ravi-channels",
          pm_id: 2,
          pid: 5661,
          status: "online",
          cpu: 0,
          memory: 0,
          args: ["/tmp/bundle/index.js", "channels", "run"],
          cwd: "/tmp/bundle",
        }) as never,
      probe: async () => ({ reachable: false, reason: "timeout" }),
      bounce,
      resolveTarget: () => ({ bundlePath: "/tmp/bundle/index.js", cwd: "/tmp/bundle" }),
    });

    expect(result).toEqual({ action: "bounced", previousPid: 5661, reason: "stale_timeout" });
    expect(bounce).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "stale_timeout",
        previousPid: 5661,
      }),
    );
  });

  it("does not bounce a healthy runner and reports unconfirmed NATS", async () => {
    const bounce = mock(() => ({ ok: true, pm2Status: 0, reason: "unused" }));
    const healthy = await reconcileManagedChannelRunner({
      isAvailable: () => true,
      getProcess: () => ({ name: "ravi-channels", pm_id: 2, pid: 5661, status: "online", cpu: 0, memory: 0 }) as never,
      probe: async () => ({ reachable: true, snapshot: HEALTHY_SNAPSHOT }),
      bounce,
    });
    expect(healthy).toEqual({ action: "healthy", pid: 5661 });
    expect(bounce).not.toHaveBeenCalled();

    const unconfirmed = await reconcileManagedChannelRunner({
      isAvailable: () => true,
      getProcess: () => ({ name: "ravi-channels", pm_id: 2, pid: 5661, status: "online", cpu: 0, memory: 0 }) as never,
      probe: async () => ({ reachable: false, reason: "nats_unavailable" }),
      bounce,
      emit: async () => {},
    });
    expect(unconfirmed).toEqual({ action: "unconfirmed", reason: "nats_unavailable" });
  });

  it("reports bounce_failed when PM2 delete/start fails", async () => {
    const result = await reconcileManagedChannelRunner({
      isAvailable: () => true,
      getProcess: () =>
        ({
          name: "ravi-channels",
          pm_id: 2,
          pid: 5661,
          status: "online",
          cpu: 0,
          memory: 0,
        }) as never,
      probe: async () => ({ reachable: false, reason: "no_responders" }),
      bounce: () => ({ ok: false, pm2Status: 1, previousPid: 5661, reason: "stale_no_responders" }),
      resolveTarget: () => ({ bundlePath: "/tmp/bundle/index.js", cwd: "/tmp/bundle" }),
    });
    expect(result).toEqual({
      action: "bounce_failed",
      previousPid: 5661,
      reason: "stale_no_responders",
    });
  });

  it("bounces via PM2 delete + start bun --name ravi-channels", () => {
    const runPm2 = mock((_args: string[]) => {
      return { status: 0 };
    });
    const persistPm2 = mock(() => 0);
    const emit = mock(async () => {});

    const result = bounceManagedChannelRunnerProcess({
      target: { bundlePath: "/repo/dist/bundle/index.js", cwd: "/repo" },
      reason: "stale_timeout",
      previousPid: 5661,
      persist: true,
      runPm2,
      persistPm2,
      emit,
    });

    expect(result).toEqual({
      ok: true,
      pm2Status: 0,
      previousPid: 5661,
      reason: "stale_timeout",
    });
    expect(runPm2.mock.calls.map((call) => call[0])).toEqual([
      ["delete", "ravi-channels"],
      ["start", "bun", "--name", "ravi-channels", "--", "/repo/dist/bundle/index.js", "channels", "run"],
    ]);
    expect(persistPm2).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "ravi.channels.runner.reconcile",
      expect.objectContaining({ action: "bounced", previousPid: 5661 }),
    );
  });
});
