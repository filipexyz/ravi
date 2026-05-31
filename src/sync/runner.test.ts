import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { SyncRunner } from "./runner.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sync-runner-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

describe("SyncRunner", () => {
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
    const runner = new SyncRunner({ bridge: bridge as never, intervalMs: 60_000 });

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

    const defaultRunner = new SyncRunner({ bridge: bridge as never, intervalMs: 60_000 });
    await defaultRunner.start();
    await new Promise((resolve) => setImmediate(resolve));
    await defaultRunner.stop();
    expect(pullOptions).toEqual([]);

    const configuredRunner = new SyncRunner({
      bridge: bridge as never,
      intervalMs: 60_000,
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
