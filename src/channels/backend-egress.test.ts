import { describe, expect, it, mock } from "bun:test";
import { JSONCodec } from "nats";
import { z } from "zod";
import type {
  ChannelBackendEgressMessage,
  ChannelBackendEgressRequestConnection,
  ChannelBackendEgressResponderConnection,
  ChannelBackendEgressSubscription,
} from "./backend-egress.js";
import {
  CHANNEL_BACKEND_EGRESS_PROTOCOL,
  CHANNEL_BACKEND_EGRESS_SUBJECT,
  createChannelBackendEgressRequester,
  startChannelBackendEgressResponder,
} from "./backend-egress.js";
import {
  CHANNEL_BACKEND_PROTOCOL,
  CHANNEL_BACKEND_SCHEMA_VERSION,
  ChannelOutputEnvelopeSchema,
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
import {
  CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
  ChannelOutputHandoffError,
  createChannelOutputHandoffIdentity,
  type ChannelOutputEmissionContext,
} from "./output-handoff.js";
import { handoffTerminalOutputWithRecovery, type TerminalOutputHandoffState } from "./terminal-output-handoff.js";

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

  it("never downgrades a restricted v2 request after an old v1 receiver rejects it before dispatch", async () => {
    const codec = JSONCodec<unknown>();
    const oldRequest = z.object({
      protocol: z.literal(CHANNEL_BACKEND_EGRESS_PROTOCOL),
      schemaVersion: z.literal(1),
      kind: z.literal("output"),
      envelope: ChannelOutputEnvelopeSchema,
    });
    const sink = mock(async () => {});
    const request = mock(async (_subject: string, data: Uint8Array) => {
      const parsed = oldRequest.safeParse(codec.decode(data));
      if (parsed.success) await sink();
      return {
        data: codec.encode({
          protocol: CHANNEL_BACKEND_EGRESS_PROTOCOL,
          schemaVersion: 1,
          ok: false,
          reason: "invalid_request",
        }),
      };
    });
    const requester = createChannelBackendEgressRequester({ connect: async () => ({ request }) });
    await expect(
      requester.emitOutput(outputEnvelope, {
        capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
        expectedRequestFingerprint: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ evidence: { disposition: "unknown", code: "TRANSPORT_FAILED" } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects old requests and unknown restricted sink capability without invoking a sink", async () => {
    const connection = new InMemoryRequestReplyConnection();
    const outputSinks = new ChannelOutputSinkRegistry();
    const emit = mock(async () => {});
    outputSinks.register(target, { emit });
    const responder = startChannelBackendEgressResponder({ connection, outputSinks });
    const requester = createChannelBackendEgressRequester({ connect: async () => connection });
    const codec = JSONCodec<unknown>();
    try {
      const response = await connection.request(
        CHANNEL_BACKEND_EGRESS_SUBJECT,
        codec.encode({
          protocol: CHANNEL_BACKEND_EGRESS_PROTOCOL,
          schemaVersion: 1,
          kind: "output",
          envelope: outputEnvelope,
        }),
        { timeout: 1000 },
      );
      expect(codec.decode(response.data)).toMatchObject({ ok: false, reason: "invalid_request" });
      await expect(
        requester.emitOutput(outputEnvelope, {
          capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
          expectedRequestFingerprint: "a".repeat(64),
        }),
      ).rejects.toMatchObject({
        evidence: {
          disposition: "not_started",
          code: "UNSUPPORTED_CAPABILITY",
          operationFinished: true,
        },
      });
      expect(emit).not.toHaveBeenCalled();
    } finally {
      await responder.stop();
    }
  });

  it("carries exact prepared evidence and a pinned deferred confirmation through the real responder", async () => {
    const connection = new InMemoryRequestReplyConnection();
    const outputSinks = new ChannelOutputSinkRegistry();
    const contexts: Array<ChannelOutputEmissionContext | undefined> = [];
    const prepared = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      schemaVersion: 1 as const,
      identity: createChannelOutputHandoffIdentity(outputEnvelope),
      idempotencyKey: outputEnvelope.outputId,
      requestFingerprint: "a".repeat(64),
    };
    outputSinks.register(target, {
      handoffCapability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      async emit(_envelope, context) {
        contexts.push(context);
        if (contexts.length === 1)
          throw new ChannelOutputHandoffError({
            ...prepared,
            disposition: "finished_pre_save_missing",
            operationFinished: true,
            code: "SQLITE_BUSY",
          });
        return { ...prepared, durableSaveConfirmed: true, disposition: "deferred" };
      },
    });
    const responder = startChannelBackendEgressResponder({ connection, outputSinks });
    const requester = createChannelBackendEgressRequester({ connect: async () => connection });
    try {
      await expect(requester.emitOutput(outputEnvelope)).rejects.toMatchObject({
        evidence: {
          ...prepared,
          disposition: "finished_pre_save_missing",
          code: "SQLITE_BUSY",
        },
      });
      const context = {
        capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
        expectedRequestFingerprint: prepared.requestFingerprint,
      };
      await expect(requester.emitOutput(outputEnvelope, context)).resolves.toEqual({
        ...prepared,
        durableSaveConfirmed: true,
        disposition: "deferred",
      });
      expect(contexts).toEqual([undefined, context]);
    } finally {
      await responder.stop();
    }
  });

  for (const scenario of ["no pin", "matching pin", "different pin"] as const) {
    it(`preserves unfinished evidence through the real wire with ${scenario}`, async () => {
      const connection = new InMemoryRequestReplyConnection();
      const outputSinks = new ChannelOutputSinkRegistry();
      const contexts: Array<ChannelOutputEmissionContext | undefined> = [];
      const evidence = {
        capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
        schemaVersion: 1 as const,
        identity: createChannelOutputHandoffIdentity(outputEnvelope),
        idempotencyKey: outputEnvelope.outputId,
        requestFingerprint: (scenario === "different pin" ? "b" : "a").repeat(64),
        disposition: "unknown" as const,
        operationFinished: false,
        code: "OUTCOME_UNKNOWN" as const,
      };
      const context =
        scenario === "no pin"
          ? undefined
          : {
              capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
              expectedRequestFingerprint: "a".repeat(64),
            };
      outputSinks.register(target, {
        handoffCapability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
        async emit(_output, restriction) {
          contexts.push(restriction);
          throw new ChannelOutputHandoffError(evidence);
        },
      });
      const responder = startChannelBackendEgressResponder({ connection, outputSinks });
      const responses: unknown[] = [];
      const request = mock(async (subject: string, data: Uint8Array, options: { timeout: number }) => {
        const response = await connection.request(subject, data, options);
        responses.push(JSONCodec<unknown>().decode(response.data));
        return response;
      });
      const requester = createChannelBackendEgressRequester({ connect: async () => ({ request }) });
      try {
        await expect(requester.emitOutput(outputEnvelope, context)).rejects.toHaveProperty("evidence", evidence);
        expect(responses).toHaveLength(1);
        expect(responses[0]).toHaveProperty("evidence", evidence);
        expect(contexts).toEqual([context]);
        expect(context?.expectedRequestFingerprint).toBe(scenario === "no pin" ? undefined : "a".repeat(64));
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        await responder.stop();
      }
    });
  }

  it("stops after a pinned retry receives unfinished different-fingerprint evidence without certifying completion", async () => {
    const connection = new InMemoryRequestReplyConnection();
    const outputSinks = new ChannelOutputSinkRegistry();
    const contexts: Array<ChannelOutputEmissionContext | undefined> = [];
    const states: TerminalOutputHandoffState[] = [];
    const prepared = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      schemaVersion: 1 as const,
      identity: createChannelOutputHandoffIdentity(outputEnvelope),
      idempotencyKey: outputEnvelope.outputId,
    };
    const unfinished = {
      ...prepared,
      requestFingerprint: "b".repeat(64),
      disposition: "unknown" as const,
      operationFinished: false,
      code: "OUTCOME_UNKNOWN" as const,
    };
    outputSinks.register(target, {
      handoffCapability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      async emit(_output, context) {
        contexts.push(context);
        if (contexts.length === 1)
          throw new ChannelOutputHandoffError({
            ...prepared,
            requestFingerprint: "a".repeat(64),
            disposition: "finished_pre_save_missing",
            operationFinished: true,
            code: "SQLITE_BUSY",
          });
        throw new ChannelOutputHandoffError(unfinished);
      },
    });
    const responder = startChannelBackendEgressResponder({ connection, outputSinks });
    const request = mock(connection.request.bind(connection));
    const requester = createChannelBackendEgressRequester({ connect: async () => ({ request }) });
    try {
      let failure: unknown;
      try {
        await handoffTerminalOutputWithRecovery(outputEnvelope, requester.emitOutput, {
          mayEmit: () => true,
          onState: (state) => states.push(state),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        outcome: { status: "non_retryable", errorCode: "OUTPUT_OR_REQUEST_CONFLICT", attempt: 2 },
      });
      expect(failure).toHaveProperty("cause.evidence", unfinished);
      expect(contexts).toEqual([
        undefined,
        {
          capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
          expectedRequestFingerprint: "a".repeat(64),
        },
      ]);
      expect(states.map((state) => state.status)).toEqual(["retry_scheduled", "non_retryable"]);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      await responder.stop();
    }
  });

  it("keeps generic success and untyped unavailable errors nonauthorizing", async () => {
    const connection = new InMemoryRequestReplyConnection();
    const outputSinks = new ChannelOutputSinkRegistry();
    const emit = mock(async () => {});
    const unregister = outputSinks.register(target, { emit });
    const responder = startChannelBackendEgressResponder({ connection, outputSinks });
    const requester = createChannelBackendEgressRequester({ connect: async () => connection });
    try {
      await expect(requester.emitOutput(outputEnvelope)).resolves.toBeUndefined();
      expect(emit).toHaveBeenCalledTimes(1);
      unregister();
      const failing = mock(async () => {
        throw new Error("unavailable: SQLITE_BUSY");
      });
      outputSinks.register(target, { emit: failing });
      await expect(requester.emitOutput(outputEnvelope)).rejects.toMatchObject({
        evidence: {
          disposition: "unknown",
          code: "UNCLASSIFIED",
        },
      });
      expect(failing).toHaveBeenCalledTimes(1);
    } finally {
      await responder.stop();
    }
  });

  it("rejects a mismatching or malformed confirmation without a second request", async () => {
    const codec = JSONCodec<unknown>();
    const confirmation = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      schemaVersion: 1,
      identity: createChannelOutputHandoffIdentity(outputEnvelope),
      idempotencyKey: outputEnvelope.outputId,
      requestFingerprint: "b".repeat(64),
      durableSaveConfirmed: true,
      disposition: "deferred",
    };
    const request = mock(async () => ({
      data: codec.encode({
        protocol: CHANNEL_BACKEND_EGRESS_PROTOCOL,
        schemaVersion: 2,
        ok: true,
        confirmation,
      }),
    }));
    const requester = createChannelBackendEgressRequester({ connect: async () => ({ request }) });
    const context = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      expectedRequestFingerprint: "a".repeat(64),
    };
    await expect(requester.emitOutput(outputEnvelope, context)).rejects.toMatchObject({
      evidence: {
        disposition: "unknown",
        code: "INVALID_CONFIRMATION",
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    confirmation.durableSaveConfirmed = false;
    await expect(requester.emitOutput(outputEnvelope, context)).rejects.toMatchObject({
      evidence: {
        disposition: "unknown",
        code: "TRANSPORT_FAILED",
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refuses executable context fields before transport serialization", async () => {
    const request = mock(async () => ({ data: new Uint8Array() }));
    const requester = createChannelBackendEgressRequester({ connect: async () => ({ request }) });
    await expect(
      requester.emitOutput(outputEnvelope, {
        capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
        expectedRequestFingerprint: "a".repeat(64),
        ownerStillCurrent: () => true,
      } as never),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(request).not.toHaveBeenCalled();
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
