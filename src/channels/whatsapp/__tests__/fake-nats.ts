/**
 * In-memory stand-in for the NATS connection surface used by the WhatsApp RPC
 * server and the runner config watch: `subscribe()` returns an async-iterable
 * subscription fed by `deliver()`, and replies are captured per request.
 */

import { JSONCodec } from "nats";

const codec = JSONCodec<unknown>();

export interface FakeNatsMessage {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly reply?: string;
  respond(data: Uint8Array): boolean;
}

export interface FakeSubscription extends AsyncIterable<FakeNatsMessage> {
  readonly subject: string;
  readonly options?: { queue?: string };
  unsubscribe(): void;
  readonly closed: boolean;
}

export function createFakeNats() {
  const subscriptions: Array<FakeSubscription & { push(message: FakeNatsMessage): void }> = [];

  function subscribe(subject: string, options?: { queue?: string }) {
    const queue: FakeNatsMessage[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const subscription = {
      subject,
      options,
      get closed() {
        return closed;
      },
      push(message: FakeNatsMessage) {
        if (closed) return;
        queue.push(message);
        wake?.();
      },
      unsubscribe() {
        closed = true;
        wake?.();
      },
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift() as FakeNatsMessage;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      },
    };
    subscriptions.push(subscription);
    return subscription;
  }

  /** Deliver a raw payload to every open subscription of `subject`. */
  function deliver(subject: string, data: Uint8Array, options: { reply?: boolean } = {}) {
    const replies: Uint8Array[] = [];
    let respondError: Error | null = null;
    const message: FakeNatsMessage = {
      subject,
      data,
      ...(options.reply === false ? {} : { reply: `_INBOX.${Math.random().toString(36).slice(2)}` }),
      respond(payload: Uint8Array) {
        if (respondError) {
          const error = respondError;
          respondError = null;
          throw error;
        }
        replies.push(payload);
        return true;
      },
    };
    for (const subscription of subscriptions) {
      if (subscription.subject === subject && !subscription.closed) subscription.push(message);
    }
    return {
      replies,
      decoded: () => replies.map((reply) => codec.decode(reply)),
      failNextRespond(error: Error) {
        respondError = error;
      },
    };
  }

  /** Send a JSON request and wait (polling) until a reply arrives. */
  async function request(subject: string, body: unknown, timeoutMs = 2_000): Promise<unknown> {
    const delivery = deliver(subject, codec.encode(body));
    const deadline = Date.now() + timeoutMs;
    while (delivery.replies.length === 0) {
      if (Date.now() > deadline) throw new Error(`no reply on ${subject}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return codec.decode(delivery.replies[0] as Uint8Array);
  }

  return { subscribe, deliver, request, subscriptions };
}

export type FakeNats = ReturnType<typeof createFakeNats>;
