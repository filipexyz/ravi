import { describe, expect, it, mock } from "bun:test";
import type { ChannelOutputEnvelope, ChannelOutputSink } from "../backend.js";
import type { ChannelOutboundJob } from "../outbound-stream.js";
import {
  ChannelOutboundPublishHandoffError,
  channelOutboundPublishRequestFingerprint,
  type ChannelOutboundActivePublishRecord,
} from "../outbound-publish-outbox.js";
import { CHANNEL_OUTPUT_HANDOFF_CAPABILITY, createChannelOutputHandoffIdentity } from "../output-handoff.js";
import type { ChannelRuntimeEventSink } from "../runtime-events.js";
import {
  createSlackNativeChannelDriver,
  renderSlackBackendOutput,
  renderSlackContent,
  renderSlackSafeError,
  type SlackNativeChannelDriverOptions,
} from "./driver.js";

const binding = {
  channelInstanceId: "slack-a",
  agentId: "agent-a",
  chatId: "chat-a",
  messageId: "message-a",
  sessionId: "session-a",
  turnId: "turn-a",
};

describe("renderSlackContent", () => {
  it("keeps the agent's Markdown for Slack delivery to render as Block Kit", () => {
    expect(
      renderSlackContent([
        {
          type: "text",
          text: "# Status\nRead the **guide** and [docs](https://example.com).",
        },
      ]),
    ).toBe("# Status\nRead the **guide** and [docs](https://example.com).");
  });

  it("joins text and attachment placeholders", () => {
    expect(
      renderSlackContent([
        { type: "text", text: "See **screenshot**" },
        { type: "artifact", artifactId: "art_1", name: "shot.png" },
      ]),
    ).toBe("See **screenshot**\n[Attachment: shot.png]");
  });
});

describe("renderSlackBackendOutput", () => {
  it("keeps safe-error copy as plain Slack text", () => {
    expect(
      renderSlackBackendOutput({
        protocol: "ravi.channel.backend",
        schemaVersion: 1,
        outputId: "output-err",
        correlationId: "correlation-a",
        binding,
        target: {
          channelKind: "slack",
          connectionId: "slack-a",
          conversationId: "C123",
        },
        kind: "safe_error",
        error: { code: "INTERNAL", category: "internal", retryable: false },
        emittedAt: "2026-09-22T12:00:00.000Z",
      }),
    ).toBe("The agent could not complete this request because of an internal error.");
  });
});

describe("renderSlackSafeError", () => {
  it("warns about completed work for replay-unsafe capacity without inviting a retry", () => {
    const rendered = renderSlackSafeError({ code: "OVERLOADED", category: "capacity", retryable: false });
    expect(rendered).toBe(
      "The agent's model provider is overloaded right now. Your session and completed work are preserved; this turn was not repeated to avoid duplicate actions.",
    );
    expect(rendered).not.toContain("try again");
    expect(renderSlackSafeError({ code: "OVERLOADED", category: "capacity", retryable: true })).toBe(
      "The agent's model provider is overloaded right now. Please try again shortly.",
    );
  });

  it("renders a readable sentence per code", () => {
    expect(renderSlackSafeError({ code: "UNAVAILABLE", category: "availability", retryable: false })).toBe(
      "The agent is unavailable because of a problem with its model provider account. Please contact the operator.",
    );
    expect(renderSlackSafeError({ code: "UNAVAILABLE", category: "availability", retryable: true })).toBe(
      "The agent is temporarily unavailable. Please try again later.",
    );
    expect(renderSlackSafeError({ code: "RATE_LIMITED", category: "capacity", retryable: true })).toContain(
      "rate limiting",
    );
    expect(renderSlackSafeError({ code: "OVERLOADED", category: "capacity", retryable: true })).toContain("overloaded");
    expect(renderSlackSafeError({ code: "INTERNAL", category: "internal", retryable: true })).toBe(
      "The agent could not complete this request because of an internal error. Please try again.",
    );
    expect(renderSlackSafeError(undefined)).toBe(
      "The agent could not complete this request because of an internal error.",
    );
  });
});

describe("createSlackNativeChannelDriver", () => {
  it("publishes the agent's Markdown, marked for rendering, on the backend Slack text egress path", async () => {
    const published: ChannelOutboundJob[] = [];
    const driver = createSlackNativeChannelDriver(
      {},
      {
        createRuntime: mock(async () => ({
          id: "slack-a",
          accountId: "slack-a",
          instanceId: "slack-a",
          connection: "connection-a",
          delivery: {
            channelId: "slack",
            supports: () => true,
            deliverText: mock(async () => ({ provider: "slack" })),
          },
          actions: {
            channelId: "slack",
            supports: () => true,
            executeChatAction: mock(async () => ({ provider: "slack" })),
          },
          presence: {
            channelId: "slack",
            supports: () => true,
            sendPresence: mock(async () => ({ provider: "slack", status: "active" as const })),
          },
          socketMode: {
            start: mock(() => {}),
            stop: mock(async () => {}),
            status: mock(() => ({ state: "connected" as const, reconnectCount: 0 })),
          } as never,
        })),
        publishOutbound: mock(async (job: ChannelOutboundJob) => {
          published.push(job);
          return undefined;
        }),
        resolveCanonicalMessageId: mock(() => "message-assistant-a"),
        now: () => 1_782_920_000_000,
      },
    );

    let outputSink: ChannelOutputSink | undefined;
    let runtimeEventSink: ChannelRuntimeEventSink | undefined;
    await driver.createRuntime({
      channel: {
        name: "slack-a",
        provider: "slack",
        credentialConnection: "connection-a",
      },
      host: {
        registerOutputSink: mock((_target, sink: ChannelOutputSink) => {
          outputSink = sink;
          return mock(() => {});
        }),
        registerRuntimeEventSink: mock((_target, sink: ChannelRuntimeEventSink) => {
          runtimeEventSink = sink;
          return mock(() => {});
        }),
      } as never,
    });

    const confirmation = await outputSink!.emit({
      protocol: "ravi.channel.backend",
      schemaVersion: 1,
      outputId: "output-md",
      traceTurnId: "turn-physical",
      correlationId: "correlation-a",
      binding,
      target: {
        channelKind: "slack",
        connectionId: "slack-a",
        conversationId: "C123~1713000000.000100",
      },
      kind: "assistant_message",
      content: [
        {
          type: "text",
          text: "**Ready.** See [runbook](https://example.com/runbook).",
        },
      ],
      emittedAt: "2026-09-22T12:00:00.000Z",
    });

    expect(confirmation).toBeUndefined();
    expect(published).toHaveLength(1);
    expect(published[0]?.request.origin.traceTurnId).toBe("turn-physical");
    expect(published[0]?.request.content).toEqual({
      type: "text",
      text: "**Ready.** See [runbook](https://example.com/runbook).",
      format: "markdown",
    });
    expect(published[0]?.request.origin.automatic).toEqual({ kind: "channel_backend", binding });
    expect(published[0]?.request.origin.automatic?.binding).not.toBe(binding);

    await runtimeEventSink!.emit(
      {
        eventId: "commentary-a",
        kind: "turn.assistant_message",
        correlation: { binding },
        payload: { phase: "commentary", content: [{ type: "text", text: "Working" }] },
      } as never,
      { channelKind: "slack", connectionId: "slack-a", conversationId: "C123~1713000000.000100" },
    );
    expect(published[1]?.request.origin).toMatchObject({
      responsePhase: "commentary",
      automatic: { kind: "channel_backend", binding },
    });
    await outputSink!.emit({
      protocol: "ravi.channel.backend",
      schemaVersion: 1,
      outputId: "safe-error-a",
      correlationId: "correlation-a",
      binding,
      target: { channelKind: "slack", connectionId: "slack-a", conversationId: "C123~1713000000.000100" },
      kind: "safe_error",
      error: { code: "INTERNAL", category: "internal", retryable: false },
      emittedAt: "2026-09-22T12:00:00.000Z",
    });
    expect(published[2]?.request.origin).toMatchObject({
      responsePhase: "safe_error",
      automatic: { kind: "channel_backend", binding },
    });
  });

  it("pins the actual prepared request and rejects a changed canonical identity before another save", async () => {
    let canonicalId = "assistant-a";
    let fingerprint = "";
    const publishOutbound = mock(async (job: ChannelOutboundJob) => {
      fingerprint = channelOutboundPublishRequestFingerprint(job);
      throw new ChannelOutboundPublishHandoffError({
        idempotencyKey: job.request.idempotencyKey,
        requestFingerprint: fingerprint,
        disposition: "finished_pre_save_missing",
        operationFinished: true,
        code: "SQLITE_BUSY",
      });
    });
    const sink = await createOutputSink({ publishOutbound, resolveCanonicalMessageId: () => canonicalId });
    await expect(sink.emit(terminalOutput)).rejects.toMatchObject({
      evidence: {
        disposition: "finished_pre_save_missing",
        identity: createChannelOutputHandoffIdentity(terminalOutput),
        idempotencyKey: terminalOutput.outputId,
        operationFinished: true,
        code: "SQLITE_BUSY",
      },
    });
    expect(fingerprint).toHaveLength(64);
    canonicalId = "assistant-b";
    await expect(
      sink.emit(terminalOutput, {
        capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
        expectedRequestFingerprint: fingerprint,
      }),
    ).rejects.toMatchObject({
      evidence: {
        disposition: "conflict",
        code: "REQUEST_FINGERPRINT_CONFLICT",
      },
    });
    expect(publishOutbound).toHaveBeenCalledTimes(1);
  });

  it("confirms durable deferred ownership without claiming provider delivery", async () => {
    let job: ChannelOutboundJob | undefined;
    const publishOutbound = mock(async (input: ChannelOutboundJob) => {
      job = input;
      return {
        ok: false as const,
        disposition: "deferred" as const,
        record: publishRecord(input),
        error: new Error("publication bookkeeping failed"),
        nextAttemptAt: 2,
        bookkeepingUncertain: true as const,
      };
    });
    const sink = await createOutputSink({ publishOutbound });
    const confirmation = await sink.emit(terminalOutput);
    expect(confirmation).toEqual({
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      schemaVersion: 1,
      identity: createChannelOutputHandoffIdentity(terminalOutput),
      idempotencyKey: terminalOutput.outputId,
      requestFingerprint: channelOutboundPublishRequestFingerprint(job!),
      durableSaveConfirmed: true,
      disposition: "deferred",
    });
    expect(publishOutbound).toHaveBeenCalledTimes(1);
  });

  it("classifies coalesced publication as suppression", async () => {
    const sink = await createOutputSink({
      publishOutbound: async (job) => ({
        ok: true,
        disposition: "published",
        record: { ...publishRecord(job), status: "published", supersededBy: "other-output" },
        publishedNow: false,
      }),
    });
    await expect(sink.emit(terminalOutput)).resolves.toMatchObject({
      durableSaveConfirmed: true,
      disposition: "suppressed",
    });
  });
});

const terminalOutput: ChannelOutputEnvelope = {
  protocol: "ravi.channel.backend",
  schemaVersion: 1,
  outputId: "output-handoff",
  correlationId: "correlation-a",
  binding,
  target: { channelKind: "slack", connectionId: "slack-a", conversationId: "C123~1713000000.000100" },
  kind: "assistant_message",
  content: [{ type: "text", text: "Finished" }],
  emittedAt: "2026-09-22T12:00:00.000Z",
};

function publishRecord(job: ChannelOutboundJob): ChannelOutboundActivePublishRecord {
  return {
    idempotencyKey: job.request.idempotencyKey,
    requestFingerprint: channelOutboundPublishRequestFingerprint(job),
    jobId: job.jobId,
    sessionName: job.request.origin.sessionName,
    channelId: job.request.channelId,
    status: "pending",
    job,
    attemptCount: 1,
    nextAttemptAt: 2,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Captures only the registered sink; no connection or provider is started. */
async function createOutputSink(
  options: Pick<SlackNativeChannelDriverOptions, "publishOutbound" | "resolveCanonicalMessageId">,
): Promise<ChannelOutputSink> {
  let sink: ChannelOutputSink | undefined;
  const driver = createSlackNativeChannelDriver(
    {},
    {
      ...options,
      resolveCanonicalMessageId: options.resolveCanonicalMessageId ?? (() => "assistant-a"),
      createRuntime: async () =>
        ({
          id: "slack-a",
          accountId: "slack-a",
          instanceId: "slack-a",
          connection: "connection-a",
          delivery: {},
          actions: {},
          presence: {},
          socketMode: {},
        }) as never,
      now: () => 1,
    },
  );
  await driver.createRuntime({
    channel: { name: "slack-a", provider: "slack" },
    host: {
      registerOutputSink: (_target: unknown, outputSink: ChannelOutputSink) => {
        sink = outputSink;
        return () => {};
      },
      registerRuntimeEventSink: () => () => {},
    } as never,
  });
  return sink!;
}
