import { describe, expect, it, mock } from "bun:test";
import { JSONCodec } from "nats";
import {
  NATIVE_CHANNEL_DRIVER_PROTOCOL,
  NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
  NativeInboundChannelActionRequestSchema,
  NativeInboundChannelActionResultSchema,
  type NativeInboundChannelActionHandler,
  type NativeInboundChannelActionRequest,
  type NativeInboundChannelActionResult,
} from "./native/driver.js";
import {
  configuredNativeInboundActionNames,
  dispatchNativeInboundChannelAction,
  NATIVE_INBOUND_CHANNEL_ACTION_SUBJECT,
  requestNativeInboundChannelAction,
  startNativeInboundChannelActionResponder,
  type NativeInboundChannelActionMessage,
  type NativeInboundChannelActionSubscription,
} from "./inbound-actions.js";

const codec = JSONCodec<unknown>();

function request(action = "account.connect"): NativeInboundChannelActionRequest {
  return NativeInboundChannelActionRequestSchema.parse({
    protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
    schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
    requestId: "channel-action-request-a",
    action,
    hasArguments: false,
    identity: {
      channelKind: "example",
      accountId: "account-a",
      conversationId: "conversation-a",
      senderId: "sender-a",
      messageId: "message-a",
    },
    requestedAt: "2026-07-24T18:00:01.000Z",
  });
}

function result(requestId: string, disposition: "handled" | "pass"): NativeInboundChannelActionResult {
  return NativeInboundChannelActionResultSchema.parse({
    protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
    schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
    requestId,
    disposition,
    ...(disposition === "handled" ? { text: "Action completed." } : {}),
    completedAt: "2026-07-24T18:00:02.000Z",
  });
}

class TestSubscription implements NativeInboundChannelActionSubscription {
  private readonly messages: NativeInboundChannelActionMessage[] = [];
  private waiter: (() => void) | null = null;
  private stopped = false;
  unsubscribe = mock(() => {
    this.stopped = true;
    this.waiter?.();
  });

  push(message: NativeInboundChannelActionMessage): void {
    this.messages.push(message);
    this.waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<NativeInboundChannelActionMessage> {
    while (!this.stopped) {
      const message = this.messages.shift();
      if (message) {
        yield message;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = null;
    }
  }
}

describe("native inbound channel actions", () => {
  it("derives the sorted action union only from explicit module declarations", () => {
    expect(
      configuredNativeInboundActionNames(
        JSON.stringify([
          {
            protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
            schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
            provider: "example-b",
            moduleSpecifier: "@example/driver-b",
            inboundActions: ["workspace.open", "account.connect"],
          },
          {
            protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
            schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
            provider: "example-a",
            moduleSpecifier: "@example/driver-a",
            inboundActions: ["account.connect"],
          },
        ]),
      ),
    ).toEqual(["account.connect", "workspace.open"]);
    expect(configuredNativeInboundActionNames(undefined)).toEqual([]);
  });

  it("dispatches only to the sole supporting handler", async () => {
    const ignored = {
      supports: mock(() => false),
      handle: mock(async () => result("channel-action-request-a", "handled")),
    } satisfies NativeInboundChannelActionHandler;
    const handling = {
      supports: mock(() => true),
      handle: mock(async (input: NativeInboundChannelActionRequest) => result(input.requestId, "handled")),
    } satisfies NativeInboundChannelActionHandler;

    await expect(dispatchNativeInboundChannelAction([ignored, handling], request())).resolves.toEqual(
      result("channel-action-request-a", "handled"),
    );
    expect(ignored.handle).not.toHaveBeenCalled();
    expect(handling.handle).toHaveBeenCalledTimes(1);
  });

  it("returns null when no runtime owns the action and pass when owners decline it", async () => {
    const unsupported = {
      supports: () => false,
      handle: async () => result("channel-action-request-a", "handled"),
    } satisfies NativeInboundChannelActionHandler;
    const passing = {
      supports: () => true,
      handle: async (input: NativeInboundChannelActionRequest) => result(input.requestId, "pass"),
    } satisfies NativeInboundChannelActionHandler;

    await expect(dispatchNativeInboundChannelAction([unsupported], request())).resolves.toBeNull();
    await expect(dispatchNativeInboundChannelAction([passing], request())).resolves.toMatchObject({
      requestId: "channel-action-request-a",
      disposition: "pass",
    });
  });

  it("replaces thrown details and mismatched responses with a safe internal error", async () => {
    const sensitive = "private-handler-detail";
    const throwing = {
      supports: () => true,
      handle: async () => {
        throw new Error(sensitive);
      },
    } satisfies NativeInboundChannelActionHandler;
    const mismatched = {
      supports: () => true,
      handle: async () => result("different-request", "handled"),
    } satisfies NativeInboundChannelActionHandler;

    const thrownResult = await dispatchNativeInboundChannelAction([throwing], request());
    const mismatchedResult = await dispatchNativeInboundChannelAction([mismatched], request());

    expect(thrownResult).toMatchObject({
      requestId: "channel-action-request-a",
      disposition: "handled",
      error: { code: "INTERNAL", retryable: false },
    });
    expect(mismatchedResult).toMatchObject({
      requestId: "channel-action-request-a",
      disposition: "handled",
      error: { code: "INTERNAL", retryable: false },
    });
    expect(JSON.stringify([thrownResult, mismatchedResult])).not.toContain(sensitive);
  });

  it("fails closed before side effects when multiple runtimes claim the same action", async () => {
    const first = {
      supports: mock(() => true),
      handle: mock(async (input: NativeInboundChannelActionRequest) => result(input.requestId, "handled")),
    } satisfies NativeInboundChannelActionHandler;
    const second = {
      supports: mock(() => true),
      handle: mock(async (input: NativeInboundChannelActionRequest) => result(input.requestId, "handled")),
    } satisfies NativeInboundChannelActionHandler;

    await expect(dispatchNativeInboundChannelAction([first, second], request())).resolves.toMatchObject({
      disposition: "handled",
      error: { code: "INTERNAL", retryable: false },
    });
    expect(first.handle).not.toHaveBeenCalled();
    expect(second.handle).not.toHaveBeenCalled();
  });

  it("serves supported actions over an ephemeral core NATS request/reply subject", async () => {
    const subscription = new TestSubscription();
    const subscribe = mock((_subject: string) => subscription);
    const handler = {
      supports: () => true,
      handle: async (input: NativeInboundChannelActionRequest) => result(input.requestId, "handled"),
    } satisfies NativeInboundChannelActionHandler;
    const responder = startNativeInboundChannelActionResponder({
      connection: { subscribe },
      handlers: [handler],
    });
    let response: Uint8Array | undefined;

    subscription.push({
      data: codec.encode(request()),
      reply: "_INBOX.reply",
      respond(data) {
        response = data;
        return true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(subscribe).toHaveBeenCalledWith(NATIVE_INBOUND_CHANNEL_ACTION_SUBJECT);
    expect(codec.decode(response!)).toEqual(result("channel-action-request-a", "handled"));
    await responder.stop();
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("validates request/reply results and rejects mismatched correlation", async () => {
    const requestCall = mock(async () => ({
      data: codec.encode(result("channel-action-request-a", "handled")),
    }));

    await expect(
      requestNativeInboundChannelAction(request(), {
        connection: { request: requestCall },
        timeoutMs: 250,
      }),
    ).resolves.toEqual(result("channel-action-request-a", "handled"));
    expect(requestCall).toHaveBeenCalledWith(NATIVE_INBOUND_CHANNEL_ACTION_SUBJECT, expect.any(Uint8Array), {
      timeout: 250,
    });

    await expect(
      requestNativeInboundChannelAction(request(), {
        connection: {
          request: async () => ({
            data: codec.encode(result("different-request", "handled")),
          }),
        },
      }),
    ).resolves.toBeNull();
  });
});
