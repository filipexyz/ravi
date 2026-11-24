import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { SyncRunner } from "./runner.js";
import { listPendingOutboxBatch } from "./db.js";
import { writeCloudCredentials } from "../cloud-auth/storage.js";
import { closeCredentialsDb, upsertCredentialConnection } from "../credentials/store.js";

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

describe("SyncRunner credential inventory", () => {
  const noopBridge = {
    isLinked: () => false,
    push: async () => ({ linked: true, status: "noop", attempted: 0, sent: 0, acked: 0, failed: 0 }),
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
  let originalInventoryFlag: string | undefined;

  beforeEach(() => {
    originalInventoryFlag = process.env.RAVI_SYNC_CREDENTIALS_INVENTORY;
    writeCloudCredentials({
      version: 1,
      consoleUrl: "https://console.ravi.bot",
      installationId: "ins_1",
      accessToken: "access-test",
      refreshToken: "refresh-test",
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scopes: ["console.sync.write"],
      organization: { id: "org_1" },
      user: { id: "user_1" },
      createdAt: "2026-11-24T12:00:00.000Z",
      updatedAt: "2026-11-24T12:00:00.000Z",
    } as never);
    upsertCredentialConnection({
      provider: "github",
      connection: "ci",
      backend: "file",
      secretRef: "file:github/ci",
      status: "active",
    });
  });

  afterEach(() => {
    if (originalInventoryFlag === undefined) delete process.env.RAVI_SYNC_CREDENTIALS_INVENTORY;
    else process.env.RAVI_SYNC_CREDENTIALS_INVENTORY = originalInventoryFlag;
    closeCredentialsDb();
  });

  function makeRunner(options: { credentialInventory?: () => Promise<unknown>; bridge?: unknown } = {}) {
    const runner = new SyncRunner({
      bridge: (options.bridge ?? noopBridge) as never,
      intervalMs: 60_000,
      enabled: true,
      ...(options.credentialInventory ? { credentialInventory: options.credentialInventory } : {}),
    });
    (runner as unknown as { running: boolean }).running = true;
    return runner;
  }

  async function tickOnce(): Promise<void> {
    const runner = makeRunner();
    await runner.tick();
    await runner.credentialInventoryInFlight;
  }

  it("enqueues the inventory on a linked tick only when RAVI_SYNC_CREDENTIALS_INVENTORY=1", async () => {
    delete process.env.RAVI_SYNC_CREDENTIALS_INVENTORY;
    await tickOnce();
    expect(listPendingOutboxBatch({ domain: "credentials", limit: 10 }).items).toHaveLength(0);

    process.env.RAVI_SYNC_CREDENTIALS_INVENTORY = "1";
    await tickOnce();
    const rows = listPendingOutboxBatch({ domain: "credentials", limit: 10 }).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("credentials.inventory");
  });
});

describe("SyncRunner credential inventory never holds the tick", () => {
  function pushCountingBridge() {
    let pushes = 0;
    return {
      get pushes() {
        return pushes;
      },
      isLinked: () => false,
      push: async () => {
        pushes += 1;
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
  }

  beforeEach(() => {
    writeCloudCredentials({
      version: 1,
      consoleUrl: "https://console.example",
      installationId: "ins_1",
      accessToken: "access-test",
      refreshToken: "refresh-test",
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scopes: ["console.sync.write"],
      organization: { id: "org_1" },
      user: { id: "user_1" },
      createdAt: "2026-11-24T12:00:00.000Z",
      updatedAt: "2026-11-24T12:00:00.000Z",
    } as never);
  });

  function runnerWith(bridge: unknown, credentialInventory: () => Promise<unknown>) {
    const runner = new SyncRunner({ bridge: bridge as never, intervalMs: 60_000, enabled: true, credentialInventory });
    (runner as unknown as { running: boolean }).running = true;
    return runner;
  }

  it("a Vault that never answers does not delay push, and only one snapshot runs at a time (N1)", async () => {
    const bridge = pushCountingBridge();
    let started = 0;
    const hanging = () => {
      started += 1;
      return new Promise<never>(() => {});
    };
    const runner = runnerWith(bridge, hanging);
    await runner.tick();
    await runner.tick();
    await runner.tick();
    expect(bridge.pushes).toBe(3);
    expect(started).toBe(1);
  });

  it("a snapshot that throws or rejects never stops the tick, and the next tick tries again (N3)", async () => {
    for (const failing of [
      () => {
        throw new Error("sync throw with /home/ravi/.ravi path");
      },
      () => Promise.reject(new Error("db locked")),
    ]) {
      const bridge = pushCountingBridge();
      let calls = 0;
      const runner = runnerWith(bridge, () => {
        calls += 1;
        return (failing as () => Promise<unknown>)();
      });
      await runner.tick();
      await runner.credentialInventoryInFlight;
      await runner.tick();
      await runner.credentialInventoryInFlight;
      expect(bridge.pushes).toBe(2);
      expect(calls).toBe(2);
    }
  });
});
