import { expect, it, mock, spyOn } from "bun:test";
import { nats, type SubscribeOptions } from "../nats.js";
import { stopRuntimeComponents } from "../runtime/shutdown.js";
import { CronRunner } from "./runner.js";

type Event = { topic: string; data: Record<string, unknown> };

it.each(["return", "pending next"] as const)(
  "cron subscription %s failure reaches the shutdown latch",
  async (failureAt) => {
    const cause = new Error(`cron ${failureAt} failed`);
    let close!: () => void;
    const waiting = new Promise<IteratorResult<Event>>((resolve, reject) => {
      close = () => (failureAt === "pending next" ? reject(cause) : resolve({ done: true as const, value: undefined }));
    });
    const returnStream = mock(async () => {
      if (failureAt === "return") throw cause;
      return { done: true as const, value: undefined };
    });
    const stream = {
      next: () => waiting,
      return: returnStream,
      async throw(cause: unknown): Promise<never> {
        throw cause;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    } as ReturnType<typeof nats.subscribe>;
    const subscribe = spyOn(nats, "subscribe").mockImplementation((...args) => {
      const opts = args.at(-1) as SubscribeOptions;
      opts.signal?.addEventListener("abort", close, { once: true });
      return stream;
    });
    try {
      const runner = new CronRunner();
      const internals = runner as unknown as {
        running: boolean;
        runtimeEventLoop: Promise<void>;
        subscribeToRuntimeEvents(): Promise<void>;
      };
      internals.running = true;
      internals.runtimeEventLoop = internals.subscribeToRuntimeEvents();
      const result = await stopRuntimeComponents([{ name: "cron", stop: () => runner.stop() }], []);
      expect(returnStream).toHaveBeenCalledTimes(1);
      expect(result.exitCode).toBe(1);
      expect(result.drain).toMatchObject({ phase: "blocked", failures: ["cron"] });
      const aggregate = result.failures[0]?.cause as AggregateError;
      expect(aggregate).toBeInstanceOf(AggregateError);
      expect(aggregate.errors.some((error: Error) => error.cause === cause)).toBe(true);
      await expect(runner.stop()).rejects.toThrow("Cron runner shutdown failed");
    } finally {
      subscribe.mockRestore();
    }
  },
);

it("cron shutdown waits for delayed subscription cleanup before reporting success", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = new CronRunner();
  const internals = runner as unknown as { running: boolean; runtimeEventStream: unknown };
  internals.running = true;
  internals.runtimeEventStream = { return: () => pending };
  let finished = false;
  const stopped = stopRuntimeComponents([{ name: "cron", stop: () => runner.stop() }], []).then((result) => {
    finished = true;
    return result;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  release();
  expect(await stopped).toMatchObject({ exitCode: 0, failures: [], drain: { phase: "drained" } });
});

it("cron outcome failure during shutdown is latched even when its handler catches it", async () => {
  const cause = new Error("outcome persistence failed");
  let entered!: () => void;
  const processing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let failOutcome!: (cause: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => {
    failOutcome = reject;
  });
  let first = true;
  const subscribe = spyOn(nats, "subscribe").mockReturnValue({
    next: async () => {
      if (!first) return { done: true as const, value: undefined };
      first = false;
      return { done: false as const, value: { topic: "runtime.event", data: {} } };
    },
    return: async () => ({ done: true as const, value: undefined }),
    async throw(cause: unknown): Promise<never> {
      throw cause;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as ReturnType<typeof nats.subscribe>);
  try {
    const runner = new CronRunner();
    const internals = runner as unknown as {
      running: boolean;
      runtimeEventLoop: Promise<void>;
      subscribeToRuntimeEvents(): Promise<void>;
      handleRuntimeEvent(event: Event): Promise<void>;
    };
    internals.running = true;
    const handle = spyOn(internals, "handleRuntimeEvent").mockImplementation(async () => {
      entered();
      await pending;
    });
    try {
      internals.runtimeEventLoop = internals.subscribeToRuntimeEvents();
      await processing;
      let finished = false;
      const stopping = stopRuntimeComponents([{ name: "cron", stop: () => runner.stop() }], []).then((result) => {
        finished = true;
        return result;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      failOutcome(cause);
      const result = await stopping;
      expect(result.exitCode).toBe(1);
      expect(result.drain).toMatchObject({ phase: "blocked", failures: ["cron"] });
      const aggregate = result.failures[0]?.cause as AggregateError;
      expect(aggregate.errors[0].cause).toBe(cause);
    } finally {
      handle.mockRestore();
    }
  } finally {
    subscribe.mockRestore();
  }
});
