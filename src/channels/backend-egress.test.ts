import { describe, expect, it } from "bun:test";
import type {
  ChannelBackendEgressMessage,
  ChannelBackendEgressRequestConnection,
  ChannelBackendEgressResponderConnection,
  ChannelBackendEgressSubscription,
} from "./backend-egress.js";
import { createChannelBackendEgressRequester, startChannelBackendEgressResponder } from "./backend-egress.js";
import {
  CHANNEL_BACKEND_PROTOCOL,
  CHANNEL_BACKEND_SCHEMA_VERSION,
  ChannelOutputSinkRegistry,
  type ChannelOutputEnvelope,
  type ExternalChannelTarget,
} from "./backend.js";
import {
  CHANNEL_RUNTIME_EVENTS_PROTOCOL,
  CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
  ChannelRuntimeEventSinkRegistry,
  type KnownChannelRuntimeEvent,
} from "./runtime-events.js";

describe("channel backend cross-process egress", () => {
  it("relays validated runtime events and terminal output to runner-local sinks", async () => {
    const connection = new InMemoryRequestReplyConnection();
    const runtimeEventSinks = new ChannelRuntimeEventSinkRegistry();
    const outputSinks = new ChannelOutputSinkRegistry();
    const runtimeEvents: KnownChannelRuntimeEvent[] = [];
    const runtimeTargets: ExternalChannelTarget[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    const unregisterRuntime = runtimeEventSinks.register(target, {
      async emit(event, externalTarget) {
        if (!externalTarget) throw new Error("runtime event target is required");
        runtimeEvents.push(event);
        runtimeTargets.push(externalTarget);
      },
    });
    const unregisterOutput = outputSinks.register(target, {
      async emit(output) {
        outputs.push(output);
      },
    });
    const responder = startChannelBackendEgressResponder({
      connection,
      runtimeEventSinks,
      outputSinks,
    });
    const requester = createChannelBackendEgressRequester({
      connect: async () => connection,
    });

    try {
      await requester.emitRuntimeEvent(target, runtimeEvent);
      await requester.emitOutput(outputEnvelope);
    } finally {
      await responder.stop();
      unregisterOutput();
      unregisterRuntime();
    }

    expect(runtimeEvents).toEqual([runtimeEvent]);
    expect(runtimeTargets).toEqual([target]);
    expect(outputs).toEqual([outputEnvelope]);
  });

  it("returns a stable failure when the runner has no matching sink", async () => {
    const connection = new InMemoryRequestReplyConnection();
    const responder = startChannelBackendEgressResponder({
      connection,
      runtimeEventSinks: new ChannelRuntimeEventSinkRegistry(),
      outputSinks: new ChannelOutputSinkRegistry(),
    });
    const requester = createChannelBackendEgressRequester({
      connect: async () => connection,
    });

    try {
      await expect(requester.emitRuntimeEvent(target, runtimeEvent)).rejects.toThrow("sink_unavailable");
    } finally {
      await responder.stop();
    }
  });
});

const target: ExternalChannelTarget = {
  channelKind: "example",
  connectionId: "connection-a",
  conversationId: "conversation-a",
};

const binding = {
  channelInstanceId: "example-main",
  agentId: "agent-a",
  chatId: "chat-a",
  messageId: "message-a",
  sessionId: "session-a",
  turnId: "turn-a",
};

const runtimeEvent: KnownChannelRuntimeEvent = {
  protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
  schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
  eventId: "event-a",
  kind: "turn.state_changed",
  occurredAt: "2026-07-25T20:00:00.000Z",
  sequence: 1,
  correlation: {
    correlationId: "correlation-a",
    ingressRequestId: "ingress-a",
    binding,
  },
  payload: {
    state: "running",
  },
};

const outputEnvelope: ChannelOutputEnvelope = {
  protocol: CHANNEL_BACKEND_PROTOCOL,
  schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
  outputId: "output-a",
  correlationId: "correlation-a",
  causationId: "ingress-a",
  binding,
  target,
  kind: "assistant_message",
  content: [{ type: "text", text: "Hello" }],
  emittedAt: "2026-07-25T20:00:01.000Z",
};

class InMemoryRequestReplyConnection
  implements ChannelBackendEgressResponderConnection, ChannelBackendEgressRequestConnection
{
  private subscription?: InMemorySubscription;

  subscribe(): ChannelBackendEgressSubscription {
    this.subscription = new InMemorySubscription();
    return this.subscription;
  }

  async request(
    _subject: string,
    data: Uint8Array,
    options: { timeout: number },
  ): Promise<{ readonly data: Uint8Array }> {
    const subscription = this.subscription;
    if (!subscription || subscription.closed) {
      throw new Error("no responders");
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), options.timeout);
      timer.unref?.();
      subscription.push({
        data,
        respond(response) {
          clearTimeout(timer);
          resolve({ data: response });
          return true;
        },
      });
    });
  }
}

class InMemorySubscription implements ChannelBackendEgressSubscription {
  private readonly messages: ChannelBackendEgressMessage[] = [];
  private wake: (() => void) | undefined;
  closed = false;

  push(message: ChannelBackendEgressMessage): void {
    this.messages.push(message);
    this.wake?.();
    this.wake = undefined;
  }

  unsubscribe(): void {
    this.closed = true;
    this.wake?.();
    this.wake = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ChannelBackendEgressMessage> {
    while (!this.closed || this.messages.length > 0) {
      const message = this.messages.shift();
      if (message) {
        yield message;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
