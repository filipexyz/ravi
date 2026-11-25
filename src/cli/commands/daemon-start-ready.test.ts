import { describe, expect, it } from "bun:test";
import type { DaemonSchemaPhase } from "../../db/daemon-schema-owner.js";
import {
  type DaemonStartCandidate,
  type DaemonStartReadyDeps,
  DEFAULT_DAEMON_START_READY_TIMEOUT_MS,
  waitForDaemonStateReady,
} from "../daemon-start-ready.js";

/** A clock that moves only when the wait sleeps, so no test waits in real time. */
function fakeClock() {
  let at = 1_000;
  const sleeps: number[] = [];
  return {
    now: () => at,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      at += ms;
    },
    sleeps,
  };
}

/** One entry per poll, in order; the last one repeats once the script runs out. */
function scripted(polls: Array<{ daemon?: DaemonStartCandidate; phase?: DaemonSchemaPhase | null }>) {
  const clock = fakeClock();
  const phaseCalls: Array<{ pid: number; startedAt?: number }> = [];
  let index = -1;
  const deps: DaemonStartReadyDeps = {
    daemon: () => {
      index = Math.min(index + 1, polls.length - 1);
      return polls[index]?.daemon;
    },
    phase: (candidate) => {
      phaseCalls.push(candidate);
      return polls[index]?.phase ?? null;
    },
    now: clock.now,
    sleep: clock.sleep,
    pollMs: 1_000,
    timeoutMs: 10_000,
  };
  return { deps, clock, phaseCalls };
}

const online = (extra: Partial<DaemonStartCandidate> = {}): DaemonStartCandidate => ({
  pid: 42,
  status: "online",
  startedAt: 900,
  ...extra,
});

describe("waitForDaemonStateReady", () => {
  it("returns at once when PM2 lists the daemon online and this incarnation published ready", async () => {
    const { deps, clock, phaseCalls } = scripted([{ daemon: online(), phase: "ready" }]);

    expect(await waitForDaemonStateReady(deps)).toEqual({ ready: true, waitedMs: 0 });
    expect(clock.sleeps).toEqual([]);
    // The receipt is asked for exactly this PID and start, so another incarnation's receipt cannot count.
    expect(phaseCalls).toEqual([{ pid: 42, startedAt: 900 }]);
  });

  it("keeps polling while the daemon boots and returns when the ready receipt appears", async () => {
    const { deps, clock } = scripted([
      { daemon: undefined },
      { daemon: online(), phase: null },
      { daemon: online(), phase: "waiting" },
      { daemon: online(), phase: "owned" },
      { daemon: online(), phase: "ready" },
    ]);

    expect(await waitForDaemonStateReady(deps)).toEqual({ ready: true, waitedMs: 4_000 });
    expect(clock.sleeps).toEqual([1_000, 1_000, 1_000, 1_000]);
  });

  it("does not take PM2 online for ready: with no receipt the wait ends at the bound", async () => {
    const { deps, phaseCalls } = scripted([{ daemon: online(), phase: null }]);

    expect(await waitForDaemonStateReady({ ...deps, timeoutMs: 5_000 })).toEqual({
      ready: false,
      reason: "timeout",
      waitedMs: 5_000,
    });
    expect(phaseCalls.length).toBeGreaterThan(1);
  });

  it("does not take owned or waiting for ready", async () => {
    for (const phase of ["waiting", "owned"] as const) {
      const { deps } = scripted([{ daemon: online(), phase }]);
      const result = await waitForDaemonStateReady({ ...deps, timeoutMs: 3_000 });
      expect(result).toEqual({ ready: false, reason: "timeout", waitedMs: 3_000 });
    }
  });

  it("asks for the receipt without a start time when PM2 reports none", async () => {
    const { deps, phaseCalls } = scripted([{ daemon: online({ startedAt: null }), phase: "ready" }]);

    await waitForDaemonStateReady(deps);

    expect(phaseCalls).toEqual([{ pid: 42, startedAt: undefined }]);
  });

  it("ignores a ready receipt of a process PM2 does not report online", async () => {
    const { deps } = scripted([{ daemon: online({ status: "launching" }), phase: "ready" }]);

    expect(await waitForDaemonStateReady({ ...deps, timeoutMs: 2_000 })).toEqual({
      ready: false,
      reason: "timeout",
      waitedMs: 2_000,
    });
  });

  it("gives up at once when PM2 says the daemon stopped or errored", async () => {
    for (const status of ["errored", "stopped"]) {
      const { deps, clock } = scripted([{ daemon: online({ status }), phase: null }]);
      expect(await waitForDaemonStateReady(deps)).toEqual({ ready: false, reason: "stopped", waitedMs: 0 });
      expect(clock.sleeps).toEqual([]);
    }
  });

  it("treats a daemon PM2 does not list as not ready yet, and never sleeps past the bound", async () => {
    const { deps, clock } = scripted([{ daemon: undefined }]);

    expect(await waitForDaemonStateReady({ ...deps, timeoutMs: 3_500 })).toEqual({
      ready: false,
      reason: "timeout",
      waitedMs: 3_500,
    });
    expect(clock.sleeps).toEqual([1_000, 1_000, 1_000, 500]);
  });

  it("counts a ready receipt that appears at the last check, exactly at the bound", async () => {
    const { deps } = scripted([
      { daemon: online(), phase: null },
      { daemon: online(), phase: null },
      { daemon: online(), phase: "ready" },
    ]);

    expect(await waitForDaemonStateReady({ ...deps, timeoutMs: 2_000 })).toEqual({ ready: true, waitedMs: 2_000 });
  });

  it("checks once and does not sleep when the bound is zero", async () => {
    const { deps, clock } = scripted([{ daemon: online(), phase: null }]);

    expect(await waitForDaemonStateReady({ ...deps, timeoutMs: 0 })).toEqual({
      ready: false,
      reason: "timeout",
      waitedMs: 0,
    });
    expect(clock.sleeps).toEqual([]);

    const ready = scripted([{ daemon: online(), phase: "ready" }]);
    expect(await waitForDaemonStateReady({ ...ready.deps, timeoutMs: 0 })).toEqual({ ready: true, waitedMs: 0 });
  });

  it("covers the state guard's PM2 bound plus boot by default", () => {
    // Shorter than a PM2 registry read that is allowed to be slow would report a booting daemon as failed.
    expect(DEFAULT_DAEMON_START_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
  });
});
