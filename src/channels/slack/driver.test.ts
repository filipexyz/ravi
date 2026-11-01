import { describe, expect, it, mock } from "bun:test";
import type { ChannelOutputSink } from "../backend.js";
import type { ChannelOutboundJob } from "../outbound-stream.js";
import {
  createSlackNativeChannelDriver,
  renderSlackBackendOutput,
  renderSlackContent,
  renderSlackSafeError,
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
        registerRuntimeEventSink: mock(() => mock(() => {})),
      } as never,
    });

    await outputSink!.emit({
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

    expect(published).toHaveLength(1);
    expect(published[0]?.request.origin.traceTurnId).toBe("turn-physical");
    expect(published[0]?.request.content).toEqual({
      type: "text",
      text: "**Ready.** See [runbook](https://example.com/runbook).",
      format: "markdown",
    });
  });
});
