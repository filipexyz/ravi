import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateSchemaNotReadyError } from "../db/schema-owner.js";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { runThreadMutation } from "../threads/schema-fence.js";
import {
  ChannelOutboundPublishReconciler,
  ensureChannelOutboundPublishOutboxSchema,
} from "./outbound-publish-outbox.js";
import {
  RUNNER_RELEASE_DRIFT_EXIT_CODE,
  RUNNER_RELEASE_REFUSAL_THRESHOLD,
  RunnerReleaseGuard,
  type RunnerReleaseRelaunch,
  readInstalledRunnerVersion,
} from "./runner-release-guard.js";

const refusal = () => new StateSchemaNotReadyError("channel-outbound-publish");

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("RunnerReleaseGuard", () => {
  it("relaunches at the threshold when the installed release differs from the running one, once", () => {
    const relaunches: RunnerReleaseRelaunch[] = [];
    const guard = new RunnerReleaseGuard({
      runningVersion: "3.261119.6",
      readInstalledVersion: () => "3.261119.9",
      onRelaunch: (relaunch) => relaunches.push(relaunch),
    });

    for (let pass = 1; pass < RUNNER_RELEASE_REFUSAL_THRESHOLD; pass++)
      expect(guard.recordFailure(refusal())).toBeNull();
    const decision = guard.recordFailure(refusal());

    expect(decision).toEqual({
      runningVersion: "3.261119.6",
      installedVersion: "3.261119.9",
      refusals: RUNNER_RELEASE_REFUSAL_THRESHOLD,
    });
    // Later refusals while the process drains must not ask again.
    expect(guard.recordFailure(refusal())).toBeNull();
    expect(relaunches).toHaveLength(1);
    expect(RUNNER_RELEASE_DRIFT_EXIT_CODE).toBe(75);
  });

  it("never relaunches when restarting could not help", () => {
    const relaunches: RunnerReleaseRelaunch[] = [];
    // The bundle on disk is the one already running: the daemon has not prepared this release yet.
    const sameRelease = new RunnerReleaseGuard({
      runningVersion: "3.261119.9",
      readInstalledVersion: () => "3.261119.9",
      onRelaunch: (relaunch) => relaunches.push(relaunch),
    });
    for (let pass = 0; pass < RUNNER_RELEASE_REFUSAL_THRESHOLD * 4; pass++) {
      expect(sameRelease.recordFailure(refusal())).toBeNull();
    }
    // The installed release cannot be read: staleness is unknown, so it is not acted on.
    const unknownDisk = new RunnerReleaseGuard({
      runningVersion: "3.261119.6",
      readInstalledVersion: () => null,
      onRelaunch: (relaunch) => relaunches.push(relaunch),
    });
    for (let pass = 0; pass < RUNNER_RELEASE_REFUSAL_THRESHOLD * 2; pass++) {
      expect(unknownDisk.recordFailure(refusal())).toBeNull();
    }
    expect(relaunches).toEqual([]);
  });

  it("ignores failures that are not state refusals and restarts the count after a passing reconcile", () => {
    const guard = new RunnerReleaseGuard({
      runningVersion: "3.261119.6",
      readInstalledVersion: () => "3.261119.9",
    });
    for (let pass = 0; pass < RUNNER_RELEASE_REFUSAL_THRESHOLD * 3; pass++) {
      expect(guard.recordFailure(new Error("NATS_TIMEOUT"))).toBeNull();
    }

    guard.recordFailure(refusal());
    guard.recordFailure(refusal());
    guard.recordSuccess();
    // Two more refusals are only two in a row: not enough.
    expect(guard.recordFailure(refusal())).toBeNull();
    expect(guard.recordFailure(refusal())).toBeNull();
    expect(guard.recordFailure(refusal())).not.toBeNull();
  });

  it("recognizes a refusal that arrives wrapped in another error", () => {
    const guard = new RunnerReleaseGuard({
      runningVersion: "3.261119.6",
      readInstalledVersion: () => "3.261119.9",
      threshold: 1,
    });
    expect(guard.recordFailure(new Error("reconcile failed", { cause: refusal() }))).not.toBeNull();
  });
});

describe("readInstalledRunnerVersion", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ravi-runner-release-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the release of the package the running bundle was started from, as it is on disk now", () => {
    const pkg = join(root, "node_modules", "ravi.bot");
    mkdirSync(join(pkg, "dist", "bundle"), { recursive: true });
    const bundle = join(pkg, "dist", "bundle", "index.js");
    writeFileSync(bundle, "");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "ravi.bot", version: "3.261119.6" }));
    expect(readInstalledRunnerVersion(bundle)).toBe("3.261119.6");

    // `bun add -g` replaces the package in place; the same bundle path now reports the new release.
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "ravi.bot", version: "3.261119.9" }));
    expect(readInstalledRunnerVersion(bundle)).toBe("3.261119.9");
  });

  it("is unknown for a path that belongs to no Ravi package", () => {
    const bundle = join(root, "somewhere", "index.js");
    mkdirSync(join(root, "somewhere"), { recursive: true });
    writeFileSync(bundle, "");
    expect(readInstalledRunnerVersion(bundle)).toBeNull();
    expect(readInstalledRunnerVersion("")).toBeNull();
  });
});

describe("a runner left on the previous release after the daemon prepared state for a newer one", () => {
  let stateDir: string | null = null;
  const argv = process.argv;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runner-release-drift-");
  });
  afterEach(async () => {
    process.argv = argv;
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  /** What `ravi daemon restart` onto a newer release does to the state the runner depends on. */
  function daemonMovesToNewerRelease(): void {
    const database = getDb();
    ensureChannelOutboundPublishOutboxSchema(database);
    // The marker sits behind the thread schema fence, so the daemon writes it through the lease.
    runThreadMutation(
      database,
      "UPDATE state_schema_versions SET version = ? WHERE component = ?",
      "1:9999.1.0",
      "channel-outbound-publish",
    );
  }

  function runAsChannelRunner(): void {
    process.argv = [argv[0], argv[1], "channels", "run"];
  }

  it("is refused by the real state guard on every pass and relaunches onto the installed release", async () => {
    daemonMovesToNewerRelease();
    runAsChannelRunner();

    const refusals: unknown[] = [];
    const relaunches: RunnerReleaseRelaunch[] = [];
    const guard = new RunnerReleaseGuard({
      runningVersion: "3.261119.6",
      readInstalledVersion: () => "3.261119.9",
      onRelaunch: (relaunch) => relaunches.push(relaunch),
    });
    const reconciler = new ChannelOutboundPublishReconciler({
      intervalMs: 1,
      onLoopSuccess: () => guard.recordSuccess(),
      onLoopFailure: (error) => {
        refusals.push(error);
        guard.recordFailure(error);
      },
    });
    try {
      reconciler.start();
      await waitFor(() => relaunches.length === 1);
    } finally {
      await reconciler.stop().catch(() => undefined);
    }

    // The production symptom: the same refusal, naming the same component and the same remedy.
    expect(String(refusals[0])).toContain("STATE_SCHEMA_NOT_READY: channel-outbound-publish is not initialized");
    expect(String(refusals[0])).toContain("start ravi-channels with the same release");
    expect(relaunches).toEqual([
      { runningVersion: "3.261119.6", installedVersion: "3.261119.9", refusals: RUNNER_RELEASE_REFUSAL_THRESHOLD },
    ]);
  });

  it("stays up and keeps reporting when the installed release is the one it already runs", async () => {
    daemonMovesToNewerRelease();
    runAsChannelRunner();

    let failures = 0;
    const relaunches: RunnerReleaseRelaunch[] = [];
    const guard = new RunnerReleaseGuard({
      runningVersion: "3.261119.9",
      readInstalledVersion: () => "3.261119.9",
      onRelaunch: (relaunch) => relaunches.push(relaunch),
    });
    const reconciler = new ChannelOutboundPublishReconciler({
      intervalMs: 1,
      onLoopFailure: (error) => {
        failures += 1;
        guard.recordFailure(error);
      },
    });
    try {
      reconciler.start();
      await waitFor(() => failures >= RUNNER_RELEASE_REFUSAL_THRESHOLD * 3);
    } finally {
      await reconciler.stop().catch(() => undefined);
    }
    expect(relaunches).toEqual([]);
  });

  it("does not let a failing observer end the reconcile loop", async () => {
    daemonMovesToNewerRelease();
    runAsChannelRunner();

    let passes = 0;
    const reconciler = new ChannelOutboundPublishReconciler({
      intervalMs: 1,
      onLoopFailure: () => {
        passes += 1;
        throw new Error("observer bug");
      },
    });
    try {
      reconciler.start();
      await waitFor(() => passes >= 3);
    } finally {
      await reconciler.stop().catch(() => undefined);
    }
    expect(passes).toBeGreaterThanOrEqual(3);
  });
});
