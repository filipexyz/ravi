import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

interface FakeLeaderRecord {
  revision: number;
  value: Uint8Array;
}

interface MutationGate {
  entered: Promise<void>;
  release(): void;
}

const leaderValues = new Map<string, FakeLeaderRecord>();
const deleteCalls: Array<{ role: string; previousSeq: number | undefined }> = [];
let nextRevision = 0;
let mutationGate: MutationGate | null = null;
let signalMutationEntered: (() => void) | null = null;
let renewalCallbacks: Array<() => Promise<void> | void> = [];

function installLeader(role: string, value: string): FakeLeaderRecord {
  const record = {
    revision: ++nextRevision,
    value: new TextEncoder().encode(value),
  };
  leaderValues.set(role, record);
  return record;
}

async function waitAtMutationGate(): Promise<void> {
  signalMutationEntered?.();
  signalMutationEntered = null;
  await mutationGate?.entered;
}

const fakeKv = {
  create: mock(async (role: string, value: Uint8Array) => {
    if (leaderValues.has(role)) throw new Error("leadership already held");
    const revision = ++nextRevision;
    leaderValues.set(role, { revision, value });
    return revision;
  }),
  get: mock(async (role: string) => {
    const record = leaderValues.get(role);
    return record ? { revision: record.revision, value: record.value } : null;
  }),
  put: mock(async (role: string, value: Uint8Array) => {
    await waitAtMutationGate();
    const revision = ++nextRevision;
    leaderValues.set(role, { revision, value });
    return revision;
  }),
  update: mock(async (role: string, value: Uint8Array, expectedRevision: number) => {
    await waitAtMutationGate();
    const current = leaderValues.get(role);
    if (!current || current.revision !== expectedRevision) throw new Error("wrong last sequence");
    const revision = ++nextRevision;
    leaderValues.set(role, { revision, value });
    return revision;
  }),
  delete: mock(async (role: string, options?: { previousSeq?: number }) => {
    deleteCalls.push({ role, previousSeq: options?.previousSeq });
    const current = leaderValues.get(role);
    if (options?.previousSeq !== undefined && current?.revision !== options.previousSeq) {
      throw new Error("wrong last sequence");
    }
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

const { releaseLeadership, startLeadershipRenewal, tryAcquireLeadership, watchForLeadershipVacancy } = await import(
  "./index.js"
);

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

beforeEach(() => {
  leaderValues.clear();
  deleteCalls.length = 0;
  nextRevision = 0;
  mutationGate = null;
  signalMutationEntered = null;
  renewalCallbacks = [];
  globalThis.setInterval = ((callback: () => Promise<void> | void) => {
    renewalCallbacks.push(callback);
    return renewalCallbacks.length as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;
});

afterAll(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  mock.restore();
});

function createMutationGate(): { entered: Promise<void>; release(): void } {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  signalMutationEntered = markEntered;
  mutationGate = { entered: blocked, release };
  return { entered, release };
}

async function runRenewalTick(): Promise<void> {
  const callback = renewalCallbacks.at(-1);
  if (!callback) throw new Error("leadership renewal timer was not started");
  await callback();
}

describe("leadership vacancy watcher", () => {
  test("rejects a negative polling interval", () => {
    expect(() =>
      watchForLeadershipVacancy("invalid-poll-role", async () => undefined, { pollIntervalMs: -1 }),
    ).toThrow("pollIntervalMs must be a finite non-negative number");
  });

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

describe("leadership ownership fencing", () => {
  test("a stale renewal and release cannot overwrite or delete a successor", async () => {
    const role = "stale-leader-role";
    const leadershipLosses: unknown[] = [];
    expect(await tryAcquireLeadership(role)).toBe(true);
    startLeadershipRenewal(role, async (error) => {
      leadershipLosses.push(error);
    });

    const successor = installLeader(role, "successor-daemon");
    await runRenewalTick();
    await releaseLeadership(role);

    expect(new TextDecoder().decode(leaderValues.get(role)?.value)).toBe("successor-daemon");
    expect(leaderValues.get(role)?.revision).toBe(successor.revision);
    expect(deleteCalls.filter((call) => call.role === role)).toHaveLength(0);
    expect(leadershipLosses).toHaveLength(1);
  });

  test("release drains an in-flight renewal and deletes its latest revision conditionally", async () => {
    const role = "in-flight-renewal-role";
    expect(await tryAcquireLeadership(role)).toBe(true);
    startLeadershipRenewal(role);
    const gate = createMutationGate();

    const renewal = runRenewalTick();
    await gate.entered;
    let releaseSettled = false;
    const release = releaseLeadership(role).then(() => {
      releaseSettled = true;
    });
    await Promise.resolve();

    expect(releaseSettled).toBe(false);
    expect(deleteCalls.filter((call) => call.role === role)).toHaveLength(0);

    gate.release();
    await renewal;
    await release;

    expect(leaderValues.has(role)).toBe(false);
    expect(deleteCalls.filter((call) => call.role === role)).toEqual([{ role, previousSeq: 2 }]);
  });
});
