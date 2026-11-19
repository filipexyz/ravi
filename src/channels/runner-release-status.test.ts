import { describe, expect, it } from "bun:test";
import { PREPARE_STATE_COMMAND } from "../db/state-readiness.js";
import type { ManagedRuntimeMemberIdentity } from "../managed-runtime.js";
import type { ChannelAdapterHealth } from "./health.js";
import {
  RUNNER_RELEASE_GUARD_ADAPTER_ID,
  describeRunnerRelease,
  inspectRunnerRelease,
  runnerReleaseGuardAdapter,
  runnerReleaseHealthReason,
  runnerReleaseWarning,
} from "./runner-release-status.js";

function member(overrides: Partial<ManagedRuntimeMemberIdentity> = {}): ManagedRuntimeMemberIdentity {
  return {
    name: "ravi",
    managed: true,
    online: true,
    status: "online",
    pid: 100,
    bundlePath: "/pkg/dist/bundle/index.js",
    cwd: "/pkg",
    runningVersion: "3.261119.9",
    diskVersion: "3.261119.9",
    startedAt: 1_000,
    stale: false,
    codeStale: false,
    envStale: false,
    identityVerified: true,
    warnings: [],
    matchesCli: true,
    ...overrides,
  };
}

const runtime = (
  daemon: Partial<ManagedRuntimeMemberIdentity> = {},
  channels: Partial<ManagedRuntimeMemberIdentity> = {},
) => ({
  daemon: member(daemon),
  channels: member({ name: "ravi-channels", pid: 200, ...channels }),
});

const refusedRunner: ChannelAdapterHealth[] = [runnerReleaseGuardAdapter()];

describe("inspectRunnerRelease", () => {
  it("is aligned when both processes booted with the same release", () => {
    expect(inspectRunnerRelease(runtime())).toEqual({ state: "aligned", version: "3.261119.9" });
  });

  it("names the 2026-11-19 incident: daemon restarted onto the installed release, runner left on the previous one", () => {
    const verdict = inspectRunnerRelease(
      runtime({}, { runningVersion: "3.261119.6", diskVersion: "3.261119.9", codeStale: true, stale: true }),
    );

    expect(verdict).toEqual({
      state: "drift",
      runnerVersion: "3.261119.6",
      daemonVersion: "3.261119.9",
      fix: "ravi channels restart",
    });
    expect(runnerReleaseHealthReason(verdict)).toBe("release_drift");
  });

  it("restarts the daemon when the daemon is the side behind the installed release", () => {
    const verdict = inspectRunnerRelease(
      runtime({ runningVersion: "3.261119.6", diskVersion: "3.261119.9" }, { runningVersion: "3.261119.9" }),
    );

    expect(verdict).toMatchObject({ state: "drift", fix: 'ravi daemon restart -m "reconcile runtime"' });
  });

  it("reconciles both, daemon first, when it cannot tell which side is behind", () => {
    const bothBehind = inspectRunnerRelease(
      runtime(
        { runningVersion: "3.261119.7", diskVersion: "3.261119.9" },
        { runningVersion: "3.261119.6", diskVersion: "3.261119.9" },
      ),
    );
    const diskUnknown = inspectRunnerRelease(
      runtime({ runningVersion: "3.261119.7", diskVersion: null }, { runningVersion: "3.261119.6", diskVersion: null }),
    );

    for (const verdict of [bothBehind, diskUnknown]) {
      expect(verdict).toMatchObject({
        state: "drift",
        fix: 'ravi daemon restart -m "reconcile runtime", then ravi channels restart',
      });
    }
  });

  it("reports drift as the cause even when the runner also says it is refused", () => {
    const verdict = inspectRunnerRelease(runtime({}, { runningVersion: "3.261119.6" }), refusedRunner);

    expect(verdict.state).toBe("drift");
  });

  it("reports a refusal with matching releases as refused, to be fixed by preparing state, not by restarting the runner", () => {
    const verdict = inspectRunnerRelease(runtime(), refusedRunner);

    expect(verdict).toEqual({
      state: "refused",
      runnerVersion: "3.261119.9",
      daemonVersion: "3.261119.9",
      fix: PREPARE_STATE_COMMAND,
    });
    expect(runnerReleaseHealthReason(verdict)).toBe("state_refused");
  });

  it("reports a refusal even when a release is unknown, and sends the operator to start a daemon that is down", () => {
    expect(inspectRunnerRelease(runtime({}, { runningVersion: null }), refusedRunner)).toMatchObject({
      state: "refused",
      runnerVersion: null,
      fix: PREPARE_STATE_COMMAND,
    });
    expect(
      inspectRunnerRelease(runtime({ online: false, status: "stopped", runningVersion: null }), refusedRunner),
    ).toMatchObject({ state: "refused", daemonVersion: null, fix: "ravi daemon start" });
  });

  it("only counts the guard entry when it is degraded", () => {
    const healthy: ChannelAdapterHealth[] = [{ ...runnerReleaseGuardAdapter(), status: "connected" }];
    const otherAdapter: ChannelAdapterHealth[] = [
      { id: "slack:ravi-slack", channelId: "slack", status: "degraded", reason: "state_refused" },
    ];

    expect(inspectRunnerRelease(runtime(), healthy).state).toBe("aligned");
    expect(inspectRunnerRelease(runtime(), otherAdapter).state).toBe("aligned");
  });

  it("never calls a release it cannot verify drift: a status read before the new process wrote its receipt", () => {
    expect(inspectRunnerRelease(runtime({}, { runningVersion: null }))).toEqual({
      state: "unverified",
      why: "version_unknown",
    });
    expect(inspectRunnerRelease(runtime({ runningVersion: null }, {}))).toEqual({
      state: "unverified",
      why: "version_unknown",
    });
  });

  it("has nothing to compare when a process is not online", () => {
    expect(inspectRunnerRelease(runtime({}, { online: false, status: "stopped", runningVersion: null }))).toEqual({
      state: "unverified",
      why: "runner_not_online",
    });
    // A stopped daemon reports no running version, so the old runner's release must not be called drift against it.
    expect(
      inspectRunnerRelease(runtime({ online: false, status: "stopped", runningVersion: "3.261119.6" }, {})),
    ).toEqual({ state: "unverified", why: "daemon_not_online" });
  });
});

describe("describing a release problem", () => {
  it("states the fact, why it matters and the command, for drift", () => {
    const verdict = inspectRunnerRelease(runtime({}, { runningVersion: "3.261119.6", diskVersion: "3.261119.9" }));

    expect(describeRunnerRelease(verdict)).toEqual({
      problem:
        "ravi-channels runs 3.261119.6 but the daemon runs 3.261119.9: the state guard refuses a runner on another release, so replies stay queued while PM2 still reports it online",
      fix: "ravi channels restart",
    });
    expect(runnerReleaseWarning(verdict)).toEndWith("Run: ravi channels restart");
  });

  it("states a refusal with its releases when both are known", () => {
    const described = describeRunnerRelease(inspectRunnerRelease(runtime(), refusedRunner));

    expect(described?.problem).toBe(
      "ravi-channels is refused by its state guard (runner 3.261119.9, daemon 3.261119.9): state is not prepared for its release, so replies stay queued",
    );
    expect(described?.fix).toBe(PREPARE_STATE_COMMAND);
  });

  it("is silent when there is no problem", () => {
    for (const verdict of [
      inspectRunnerRelease(runtime()),
      inspectRunnerRelease(runtime({}, { runningVersion: null })),
    ]) {
      expect(describeRunnerRelease(verdict)).toBeNull();
      expect(runnerReleaseWarning(verdict)).toBeNull();
      expect(runnerReleaseHealthReason(verdict)).toBeNull();
    }
  });
});

describe("the runner's own report of a refused guard", () => {
  it("is a degraded entry of the health snapshot that an older reader already treats as unhealthy", () => {
    expect(runnerReleaseGuardAdapter()).toEqual({
      id: RUNNER_RELEASE_GUARD_ADAPTER_ID,
      channelId: "runner",
      status: "degraded",
      reason: "state_refused",
      detail: "STATE_SCHEMA_NOT_READY",
    });
  });
});
