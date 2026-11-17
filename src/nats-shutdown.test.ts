import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Msg, NatsConnection, Subscription } from "nats";
import * as broker from "./nats.js";

function message(subject: string, value = 1): Msg {
  const body = JSON.stringify({ value });
  return {
    subject,
    sid: 1,
    data: Buffer.from(body),
    respond: () => false,
    json: <T>() => JSON.parse(body) as T,
    string: () => body,
  };
}

function subscription(
  unsubscribeError?: Error,
  delayed?: {
    next?: boolean;
    returned?: Promise<IteratorResult<Msg>>;
  },
) {
  let closed = false;
  let next: { resolve: (result: IteratorResult<Msg>) => void; reject: (cause: unknown) => void } | undefined;
  const iterator = {
    next: mock(() => {
      if (closed) return Promise.resolve({ done: true as const, value: undefined });
      return new Promise<IteratorResult<Msg>>((resolve, reject) => {
        next = { resolve, reject };
      });
    }),
    return: mock(() => delayed?.returned ?? Promise.resolve({ done: true as const, value: undefined })),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const unsubscribe = mock(() => {
    if (unsubscribeError) throw unsubscribeError;
    closed = true;
    if (!delayed?.next) next?.resolve({ done: true, value: undefined });
  });
  return {
    sub: { ...iterator, unsubscribe } as unknown as Subscription,
    unsubscribe,
    read: iterator.next,
    returned: iterator.return,
    finish() {
      next?.resolve({ done: true, value: undefined });
    },
    message(topic = "test.a") {
      next?.resolve({ done: false, value: message(topic) });
    },
    fail(cause: Error) {
      next?.reject(cause);
    },
  };
}

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function connect(subscriptions: ReturnType<typeof subscription>[]) {
  let index = 0;
  const subscribe = mock(() => subscriptions[index++]!.sub);
  spies.push(spyOn(broker, "ensureConnected").mockResolvedValue({ subscribe } as unknown as NatsConnection));
  return subscribe;
}

async function pendingReads(subscriptions: ReturnType<typeof subscription>[]) {
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const sub of subscriptions) expect(sub.read).toHaveBeenCalledTimes(1);
}

function containsCause(error: unknown, expected: Error): boolean {
  if (error === expected) return true;
  if (error instanceof AggregateError && error.errors.some((cause) => containsCause(cause, expected))) return true;
  return error instanceof Error && containsCause(error.cause, expected);
}

describe("NATS owner shutdown", () => {
  for (const outcome of ["done", "message", "rejected"] as const) {
    it.each([1, 2])(
      `awaits delayed next ${outcome} after successful unsubscribe for %i subscriptions`,
      async (count) => {
        const cause = new Error("late next failure after unsubscribe succeeded");
        const subs = Array.from({ length: count }, () => subscription(undefined, { next: true }));
        connect(subs);
        const controller = new AbortController();
        const stream = broker.subscribe(...Array.from({ length: count }, (_, index) => `test.${index}`), {
          signal: controller.signal,
        });
        let settled = false;
        const pending = stream
          .next()
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            settled = true;
          });
        await pendingReads(subs);
        controller.abort();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        for (const sub of subs) {
          expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
          expect(sub.returned).not.toHaveBeenCalled();
        }
        for (const sub of subs) {
          if (outcome === "rejected") sub.fail(cause);
          else if (outcome === "message") sub.message();
          else sub.finish();
        }
        const result = await pending;
        if (outcome === "rejected")
          expect(containsCause("error" in result ? result.error : undefined, cause)).toBe(true);
        else expect(result).toEqual({ value: { done: true, value: undefined } });
        for (const sub of subs) expect(sub.returned).toHaveBeenCalledTimes(1);
      },
    );
  }

  for (const rejected of [false, true]) {
    it.each([1, 2])(
      `awaits delayed iterator return (${rejected ? "rejected" : "resolved"}) for %i subscriptions`,
      async (count) => {
        const cause = new Error("late return failure");
        let finish!: () => void;
        const returned = new Promise<IteratorResult<Msg>>((resolve, reject) => {
          finish = () => (rejected ? reject(cause) : resolve({ done: true, value: undefined }));
        });
        const subs = Array.from({ length: count }, () => subscription(undefined, { returned }));
        connect(subs);
        const controller = new AbortController();
        const stream = broker.subscribe(...Array.from({ length: count }, (_, index) => `test.${index}`), {
          signal: controller.signal,
        });
        let settled = false;
        const pending = stream
          .next()
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            settled = true;
          });
        await pendingReads(subs);
        controller.abort();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        for (const sub of subs) expect(sub.returned).toHaveBeenCalledTimes(1);
        finish();
        const result = await pending;
        if (rejected) expect(containsCause("error" in result ? result.error : undefined, cause)).toBe(true);
        else expect(result).toEqual({ value: { done: true, value: undefined } });
      },
    );
  }

  it.each([1, 2])("drains queued messages on natural completion of %i finite subscriptions", async (count) => {
    const subs = Array.from({ length: count }, (_, index) => {
      const fixture = subscription();
      let messageIndex = 0;
      const messages = [1, 2, 3].map((value) => message(`test.${index}`, value));
      fixture.read.mockImplementation(() =>
        Promise.resolve(
          messageIndex < messages.length
            ? { done: false, value: messages[messageIndex++]! }
            : { done: true, value: undefined },
        ),
      );
      return fixture;
    });
    connect(subs);
    const controller = new AbortController();
    const received: Array<{ topic: string; data: Record<string, unknown> }> = [];
    for await (const event of broker.subscribe(...Array.from({ length: count }, (_, index) => `test.${index}`), {
      signal: controller.signal,
    })) {
      received.push(event);
      // Let every pump finish while the owner is still consuming its queue.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(received).toHaveLength(3 * count);
    for (let index = 0; index < count; index += 1) {
      expect(received.filter((event) => event.topic === `test.${index}`).map((event) => event.data.value)).toEqual([
        1, 2, 3,
      ]);
      expect(subs[index]!.returned).toHaveBeenCalledTimes(1);
      expect(subs[index]!.unsubscribe).toHaveBeenCalledTimes(1);
    }
  });

  it.each([1, 2])("cancels %i idle subscriptions before awaiting generator return", async (count) => {
    const subs = Array.from({ length: count }, () => subscription());
    connect(subs);
    const controller = new AbortController();
    const stream = broker.subscribe(...Array.from({ length: count }, (_, index) => `test.${index}`), {
      signal: controller.signal,
    });
    const pending = stream.next();
    await pendingReads(subs);
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await stream.return(undefined)).toEqual({ done: true, value: undefined });
    for (const sub of subs) expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])(
    "propagates unsubscribe failure from %i subscriptions instead of throwing from the abort listener",
    async (count) => {
      const cause = new Error("unsubscribe rejected");
      const subs = Array.from({ length: count }, (_, index) => subscription(index === 0 ? cause : undefined));
      connect(subs);
      const controller = new AbortController();
      const stream = broker.subscribe(...Array.from({ length: count }, (_, index) => `test.${index}`), {
        signal: controller.signal,
      });
      const pending = stream.next();
      await pendingReads(subs);
      expect(() => controller.abort()).not.toThrow();
      const error = await pending.then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect(containsCause(error, cause)).toBe(true);
      for (const sub of subs) expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
      // A next() left behind by a failed transport close stays observed.
      subs[0]!.fail(new Error("late iterator rejection"));
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  );

  it.each([1, 2])("consumer return closes %i subscriptions and removes the owner listener", async (count) => {
    const subs = Array.from({ length: count }, () => subscription());
    connect(subs);
    const controller = new AbortController();
    const add = spyOn(controller.signal, "addEventListener");
    const remove = spyOn(controller.signal, "removeEventListener");
    spies.push(add, remove);
    const stream = broker.subscribe(...Array.from({ length: count }, (_, index) => `test.${index}`), {
      signal: controller.signal,
    });
    const pending = stream.next();
    await pendingReads(subs);
    subs[0]!.message();
    expect((await pending).value).toEqual({ topic: "test.a", data: { value: 1 } });
    expect(await stream.return(undefined)).toEqual({ done: true, value: undefined });
    expect(controller.signal.aborted).toBe(false);
    for (const sub of subs) expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
  });

  it("a failed multi-pattern pump wakes the owner and closes its idle siblings", async () => {
    const cause = new Error("subscription failed while next was pending");
    const subs = [subscription(), subscription()];
    connect(subs);
    const controller = new AbortController();
    const stream = broker.subscribe("test.a", "test.b", { signal: controller.signal });
    const pending = stream.next();
    await pendingReads(subs);
    subs[0]!.fail(cause);
    const error = await pending.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(containsCause(error, cause)).toBe(true);
    for (const sub of subs) expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(false);
  });

  it.each([1, 2])("consumer return surfaces close failure for %i subscriptions", async (count) => {
    const cause = new Error("close failed after a delivered message");
    const subs = Array.from({ length: count }, (_, index) => subscription(index === 0 ? cause : undefined));
    connect(subs);
    const controller = new AbortController();
    const stream = broker.subscribe(...Array.from({ length: count }, (_, index) => `test.${index}`), {
      signal: controller.signal,
    });
    const pending = stream.next();
    await pendingReads(subs);
    subs[0]!.message();
    expect((await pending).done).toBe(false);
    const error = await stream.return(undefined).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(containsCause(error, cause)).toBe(true);
    for (const sub of subs) expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    subs[0]!.fail(new Error("late closed iterator"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("retains every sibling unsubscribe failure and preserves queue options", async () => {
    const causes = [new Error("first close failed"), new Error("second close failed")];
    const subs = causes.map((cause) => subscription(cause));
    const subscribe = connect(subs);
    const controller = new AbortController();
    const stream = broker.subscribe("test.a", "test.b", { queue: "test-queue", signal: controller.signal });
    const pending = stream.next();
    await pendingReads(subs);
    controller.abort();
    const error = await pending.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    for (const cause of causes) expect(containsCause(error, cause)).toBe(true);
    expect(subscribe).toHaveBeenNthCalledWith(1, "test.a", { queue: "test-queue" });
    expect(subscribe).toHaveBeenNthCalledWith(2, "test.b", { queue: "test-queue" });
  });

  it("does not connect or create subscriptions for an already stopped owner", async () => {
    const subscribe = connect([]);
    const controller = new AbortController();
    controller.abort();
    expect(await broker.subscribe("test.a", { signal: controller.signal }).next()).toEqual({
      done: true,
      value: undefined,
    });
    expect(subscribe).not.toHaveBeenCalled();
  });
});
