import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { SyncRunner } from "./runner.js";

let stateDir: string;
let originalSyncRunnerEnabled: string | undefined;

beforeEach(async () => {
  originalSyncRunnerEnabled = process.env.RAVI_SYNC_RUNNER_ENABLED;
  delete process.env.RAVI_SYNC_RUNNER_ENABLED;
  stateDir = await createIsolatedRaviState("ravi-sync-runner-test-");
});

afterEach(async () => {
  if (originalSyncRunnerEnabled === undefined) delete process.env.RAVI_SYNC_RUNNER_ENABLED;
  else process.env.RAVI_SYNC_RUNNER_ENABLED = originalSyncRunnerEnabled;
  await cleanupIsolatedRaviState(stateDir);
});

describe("SyncRunner", () => {
  it("is disabled by default and enabled only with RAVI_SYNC_RUNNER_ENABLED=1", async () => {
    let pushCalls = 0;
    const bridge = {
      push: async () => {
        pushCalls += 1;
        return { linked: true, status: "noop", attempted: 0, sent: 0, acked: 0, failed: 0 };
      },
      pull: async () => ({
        linked: true,
        status: "noop",
        downloaded: 0,
        enqueued: 0,
        applied: 0,
        skipped: 0,
        failed: 0,
        cursor: null,
      }),
    };

    const defaultRunner = new SyncRunner({ bridge: bridge as never, intervalMs: 60_000 });
    await defaultRunner.start();
    await new Promise((resolve) => setImmediate(resolve));
    await defaultRunner.stop();
    expect(pushCalls).toBe(0);

    process.env.RAVI_SYNC_RUNNER_ENABLED = "1";
    const enabledRunner = new SyncRunner({ bridge: bridge as never, intervalMs: 60_000 });
    await enabledRunner.start();
    await new Promise((resolve) => setImmediate(resolve));
    await enabledRunner.stop();
    expect(pushCalls).toBe(1);
  });

  it("does not block start on the first best-effort tick", async () => {
    let pushStarted = false;
    let pullCalls = 0;
    let releasePush!: () => void;
    const bridge = {
      push: async () => {
        pushStarted = true;
        await new Promise<void>((resolve) => {
          releasePush = resolve;
        });
        return { linked: true, status: "noop", attempted: 0, sent: 0, acked: 0, failed: 0 };
      },
      pull: async () => {
        pullCalls += 1;
        return {
          linked: true,
          status: "noop",
          downloaded: 0,
          enqueued: 0,
          applied: 0,
          skipped: 0,
          failed: 0,
          cursor: null,
        };
      },
    };
    const runner = new SyncRunner({ bridge: bridge as never, intervalMs: 60_000, enabled: true });

    await runner.start();
    expect(pushStarted).toBe(true);
    releasePush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(pullCalls).toBe(0);
    await runner.stop();
  });

  it("does not call pull without configured domains and uses organization scope when configured", async () => {
    const pullOptions: unknown[] = [];
    const bridge = {
      push: async () => ({ linked: true, status: "noop", attempted: 0, sent: 0, acked: 0, failed: 0 }),
      pull: async (options: unknown) => {
        pullOptions.push(options);
        return {
          linked: true,
          status: "noop",
          downloaded: 0,
          enqueued: 0,
          applied: 0,
          skipped: 0,
          failed: 0,
          cursor: null,
        };
      },
    };

    const defaultRunner = new SyncRunner({ bridge: bridge as never, intervalMs: 60_000, enabled: true });
    await defaultRunner.start();
    await new Promise((resolve) => setImmediate(resolve));
    await defaultRunner.stop();
    expect(pullOptions).toEqual([]);

    const configuredRunner = new SyncRunner({
      bridge: bridge as never,
      intervalMs: 60_000,
      enabled: true,
      pullDomains: ["rules", "contacts"],
    });
    await configuredRunner.start();
    await new Promise((resolve) => setImmediate(resolve));
    await configuredRunner.stop();
    expect(pullOptions).toEqual([
      { domain: "rules", scope: "organization" },
      { domain: "contacts", scope: "organization" },
    ]);
  });
});
