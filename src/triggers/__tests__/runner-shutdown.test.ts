import { expect, it, spyOn } from "bun:test";
import { nats, type SubscribeOptions } from "../../nats.js";
import { stopRuntimeComponents } from "../../runtime/shutdown.js";
import * as triggerDb from "../triggers-db.js";
import { TriggerRunner } from "../runner.js";

type Event = { topic: string; data: Record<string, unknown> };

it("trigger shutdown retains failed health, topic closes and pending reject flush while attempting every sibling", async () => {
  const healthCause = new Error("health unsubscribe failed");
  const flushCause = new Error("reject ledger failed");
  const topicCauses = [new Error("first next failed"), new Error("second return failed")];
  const returns: string[] = [];
  const subscribe = spyOn(nats, "subscribe").mockImplementation((...args) => {
    const topic = args[0] as string;
    const opts = args.at(-1) as SubscribeOptions;
    const waiting = new Promise<IteratorResult<Event>>((resolve, reject) => {
      opts.signal?.addEventListener(
        "abort",
        () => (topic === "first" ? reject(topicCauses[0]) : resolve({ done: true as const, value: undefined })),
        { once: true },
      );
    });
    return {
      next: () => waiting,
      return: async () => {
        returns.push(topic);
        if (topic === "second") throw topicCauses[1];
        return { done: true as const, value: undefined };
      },
      async throw(cause: unknown): Promise<never> {
        throw cause;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    } as ReturnType<typeof nats.subscribe>;
  });
  const recordRejects = spyOn(triggerDb, "dbRecordTriggerFilterRejects").mockImplementation(() => {
    throw flushCause;
  });
  try {
    const runner = new TriggerRunner();
    const internals = runner as unknown as {
      running: boolean;
      publicationHealth: { unsubscribe(): void };
      pendingFilterRejects: Map<string, unknown>;
      topicSubs: Map<string, unknown>;
      subscribeToTopic(topic: string, triggers: never[]): void;
      debouncer: { clear(): number };
    };
    internals.running = true;
    internals.publicationHealth = {
      unsubscribe: () => {
        throw healthCause;
      },
    };
    internals.subscribeToTopic("first", []);
    internals.subscribeToTopic("second", []);
    internals.pendingFilterRejects.set("trigger", { count: 1, topic: "first", lastRejectAt: 1, filter: undefined });
    const clear = spyOn(internals.debouncer, "clear").mockReturnValue(0);
    try {
      const result = await stopRuntimeComponents([{ name: "triggers", stop: () => runner.stop() }], []);
      expect(returns.sort()).toEqual(["first", "second"]);
      expect(recordRejects).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledTimes(1);
      expect(result.exitCode).toBe(1);
      expect(result.drain).toMatchObject({ phase: "blocked", failures: ["triggers"] });
      const aggregate = result.failures[0]?.cause as AggregateError;
      expect(aggregate).toBeInstanceOf(AggregateError);
      const errors = aggregate.errors as Error[];
      expect(errors.map((error) => error.cause)).toEqual(
        expect.arrayContaining([healthCause, ...topicCauses, flushCause]),
      );
      expect(internals.topicSubs.size).toBe(2);
      expect(internals.pendingFilterRejects.size).toBe(1);
    } finally {
      clear.mockRestore();
    }
  } finally {
    subscribe.mockRestore();
    recordRejects.mockRestore();
  }
});
