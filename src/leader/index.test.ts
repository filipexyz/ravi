import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const leaderValues = new Map<string, Uint8Array>();
const fakeKv = {
  create: mock(async (role: string, value: Uint8Array) => {
    if (leaderValues.has(role)) throw new Error("leadership already held");
    leaderValues.set(role, value);
    return 1;
  }),
  get: mock(async (role: string) => {
    const value = leaderValues.get(role);
    return value ? { value } : null;
  }),
  put: mock(async (role: string, value: Uint8Array) => {
    leaderValues.set(role, value);
    return 1;
  }),
  delete: mock(async (role: string) => {
    leaderValues.delete(role);
  }),
};

mock.module("../nats.js", () => ({
  getNats: () => ({
    jetstream: () => ({
      views: {
        kv: async () => fakeKv,
      },
    }),
  }),
}));

const { watchForLeadershipVacancy } = await import("./index.js");

beforeEach(() => {
  leaderValues.clear();
});

afterAll(() => mock.restore());

describe("leadership vacancy watcher", () => {
  test("cancel stops polling before it can touch NATS or invoke takeover", async () => {
    let takeoverCalls = 0;
    const watcher = watchForLeadershipVacancy("cancelled-test-role", async () => {
      takeoverCalls += 1;
    });

    watcher.cancel();
    await watcher.done;

    expect(watcher.signal.aborted).toBe(true);
    expect(takeoverCalls).toBe(0);
  });

  test("an external abort signal stops polling", async () => {
    const controller = new AbortController();
    const watcher = watchForLeadershipVacancy("externally-cancelled-test-role", async () => undefined, {
      signal: controller.signal,
    });

    controller.abort();
    await watcher.done;

    expect(watcher.signal.aborted).toBe(true);
  });

  test("releases acquired leadership and rejects when takeover startup fails", async () => {
    const controller = new AbortController();
    const startupError = new Error("takeover startup failed");
    const watcher = watchForLeadershipVacancy(
      "failing-takeover-role",
      async () => {
        controller.abort();
        throw startupError;
      },
      { signal: controller.signal, pollIntervalMs: 0 },
    );

    let observedError: unknown;
    await watcher.done.catch((error) => {
      observedError = error;
    });

    expect(observedError).toBe(startupError);
    expect(leaderValues.has("failing-takeover-role")).toBe(false);
  });

  test("releases acquired leadership when takeover is cancelled after startup", async () => {
    const controller = new AbortController();
    const watcher = watchForLeadershipVacancy(
      "cancelled-takeover-role",
      async () => {
        controller.abort();
      },
      { signal: controller.signal, pollIntervalMs: 0 },
    );

    await watcher.done;

    expect(watcher.signal.aborted).toBe(true);
    expect(leaderValues.has("cancelled-takeover-role")).toBe(false);
  });
});
