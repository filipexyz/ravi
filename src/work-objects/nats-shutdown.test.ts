import { expect, it, spyOn } from "bun:test";
import * as nats from "../nats.js";
import { stopRuntimeComponents } from "../runtime/shutdown.js";
import { startWorkObjectNatsService } from "./nats.js";

type Event = { topic: string; data: Record<string, unknown> };

it.each(["return", "pending next"] as const)(
  "work object %s failure is preserved in shutdown result and latch",
  async (failureAt) => {
    const cause = new Error(`work object ${failureAt} failed`);
    const subscribe = spyOn(nats, "subscribe").mockImplementation((...args) => {
      const opts = args.at(-1) as nats.SubscribeOptions;
      const waiting = new Promise<IteratorResult<Event>>((resolve, reject) => {
        opts.signal?.addEventListener(
          "abort",
          () => (failureAt === "pending next" ? reject(cause) : resolve({ done: true as const, value: undefined })),
          { once: true },
        );
      });
      return {
        next: () => waiting,
        return: async () => {
          if (failureAt === "return") throw cause;
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
    try {
      const service = startWorkObjectNatsService();
      const result = await stopRuntimeComponents([{ name: "work-objects", stop: () => service.stop() }], []);
      expect(result.exitCode).toBe(1);
      expect(result.drain).toMatchObject({ phase: "blocked", failures: ["work-objects"] });
      const aggregate = result.failures[0]?.cause as AggregateError;
      expect(aggregate).toBeInstanceOf(AggregateError);
      expect(aggregate.errors.some((error: Error) => error.cause === cause)).toBe(true);
      await expect(service.stop()).rejects.toThrow("Work Object shutdown failed");
    } finally {
      subscribe.mockRestore();
    }
  },
);

it("work object shutdown waits for the pending loop even after return resolves", async () => {
  let finishLoop!: () => void;
  const waiting = new Promise<IteratorResult<Event>>((resolve) => {
    finishLoop = () => resolve({ done: true as const, value: undefined });
  });
  const subscribe = spyOn(nats, "subscribe").mockReturnValue({
    next: () => waiting,
    return: async () => ({ done: true as const, value: undefined }),
    async throw(cause: unknown): Promise<never> {
      throw cause;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as ReturnType<typeof nats.subscribe>);
  try {
    const service = startWorkObjectNatsService();
    let finished = false;
    const stopping = stopRuntimeComponents([{ name: "work-objects", stop: () => service.stop() }], []).then(
      (result) => {
        finished = true;
        return result;
      },
    );
    await Promise.resolve();
    expect(finished).toBe(false);
    finishLoop();
    expect(await stopping).toMatchObject({ exitCode: 0, drain: { phase: "drained" } });
  } finally {
    finishLoop();
    subscribe.mockRestore();
  }
});

it("work object reply failure during shutdown is latched even when its handler catches it", async () => {
  const cause = new Error("reply publication failed");
  let entered!: () => void;
  const publishing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let failReply!: (cause: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => {
    failReply = reject;
  });
  let first = true;
  const subscribe = spyOn(nats, "subscribe").mockReturnValue({
    next: async () => {
      if (!first) return { done: true as const, value: undefined };
      first = false;
      return {
        done: false as const,
        value: { topic: "unknown-work-object-operation", data: { replyTopic: "isolated.reply" } },
      };
    },
    return: async () => ({ done: true as const, value: undefined }),
    async throw(cause: unknown): Promise<never> {
      throw cause;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as ReturnType<typeof nats.subscribe>);
  const publish = spyOn(nats, "publish").mockImplementation(async () => {
    entered();
    await pending;
  });
  try {
    const service = startWorkObjectNatsService();
    await publishing;
    let finished = false;
    const stopping = stopRuntimeComponents([{ name: "work-objects", stop: () => service.stop() }], []).then(
      (result) => {
        finished = true;
        return result;
      },
    );
    await Promise.resolve();
    expect(finished).toBe(false);
    failReply(cause);
    const result = await stopping;
    expect(result.exitCode).toBe(1);
    expect(result.drain).toMatchObject({ phase: "blocked", failures: ["work-objects"] });
    const aggregate = result.failures[0]?.cause as AggregateError;
    expect(aggregate.errors[0].cause).toBe(cause);
    expect(publish).toHaveBeenCalledTimes(1);
  } finally {
    subscribe.mockRestore();
    publish.mockRestore();
  }
});
