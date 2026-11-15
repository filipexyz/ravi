import { describe, expect, it, spyOn } from "bun:test";
import { Gateway } from "./gateway.js";
import { nats } from "./nats.js";
import * as lifecycle from "./channels/slack/thread-lifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function gatewayHarness() {
  const gateway = new Gateway({ omniSender: {} as never, omniConsumer: {} as never });
  const internals = gateway as unknown as {
    running: boolean;
    subscribe(key: string, topics: string[], handler: () => Promise<void>): void;
    reconcileSlackThreads(): Promise<void>;
  };
  internals.running = true;
  return { gateway, internals };
}

describe("gateway drain", () => {
  it("waits for an admitted callback and refuses a reply arriving after admission closes", async () => {
    const entered = deferred();
    const finish = deferred();
    const secondEvent = deferred();
    const subscription = spyOn(nats, "subscribe").mockImplementation(
      () =>
        (async function* () {
          yield { topic: "test.callback", data: {} };
          await secondEvent.promise;
          yield { topic: "test.reply", data: {} };
        })() as never,
    );
    try {
      const { gateway, internals } = gatewayHarness();
      let calls = 0;
      internals.subscribe("test", ["test.*"], async () => {
        calls += 1;
        entered.resolve();
        await finish.promise;
      });
      await entered.promise;
      const draining = gateway.requestDrain();
      secondEvent.resolve();
      await Promise.resolve();
      expect(gateway.drainStatus()).toMatchObject({ phase: "draining", pending: 1 });
      expect(calls).toBe(1);
      finish.resolve();
      expect(await draining).toMatchObject({ accepted: 1, completed: 1 });
    } finally {
      subscription.mockRestore();
    }
  });

  it("awaits active Slack reconciliation instead of certifying timer cancellation", async () => {
    const finish = deferred();
    const reconcile = spyOn(lifecycle, "reconcileSlackThreadLifecycle").mockImplementation(async () => {
      await finish.promise;
      return { creations: 1, parentReturns: 0, failures: 0 };
    });
    try {
      const { gateway, internals } = gatewayHarness();
      const active = internals.reconcileSlackThreads();
      const draining = gateway.requestDrain();
      expect(gateway.drainStatus()).toMatchObject({ phase: "draining", pending: 1 });
      finish.resolve();
      await active;
      expect(await draining).toMatchObject({ accepted: 1, completed: 1 });
    } finally {
      reconcile.mockRestore();
    }
  });

  it("blocks on a reconciliation failure even after its promise resolves", async () => {
    const reconcile = spyOn(lifecycle, "reconcileSlackThreadLifecycle").mockResolvedValue({
      creations: 0,
      parentReturns: 0,
      failures: 1,
    });
    try {
      const { gateway, internals } = gatewayHarness();
      await internals.reconcileSlackThreads();
      expect(gateway.drainStatus().pending).toBe(0);
      await expect(gateway.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
    } finally {
      reconcile.mockRestore();
    }
  });
});
