import { describe, expect, it, mock } from "bun:test";
import { JSONCodec } from "nats";
import {
  CHANNEL_RUNNER_HEALTH_SCHEMA_VERSION,
  channelRunnerHealthSubject,
  createChannelRunnerHealthSnapshot,
  probeChannelRunnerHealth,
  startChannelRunnerHealthResponder,
  type ChannelRunnerHealthMessage,
  type ChannelRunnerHealthRequestConnection,
  type ChannelRunnerHealthSubscription,
  type ChannelRunnerRuntimeStatus,
} from "./health.js";

const codec = JSONCodec<unknown>();

function runtimeStatus(pid = 4242): ChannelRunnerRuntimeStatus {
  return {
    running: true,
    startedAt: 1_721_563_200_000,
    pid,
    outbound: {
      stream: "CHANNEL_OUTBOUND",
      consumer: "ravi-channels-outbound",
      enabled: true,
      infrastructureReady: true,
      consuming: true,
    },
    adapters: [
      {
        id: "slack:hana-slack",
        channelId: "slack",
        status: "connected",
        connectedAt: 1_721_563_201_000,
        lastPongAt: 1_721_563_202_000,
        reconnectCount: 1,
      },
    ],
  };
}

class TestSubscription implements ChannelRunnerHealthSubscription {
  private readonly messages: ChannelRunnerHealthMessage[] = [];
  private waiter: (() => void) | null = null;
  private stopped = false;
  unsubscribe = mock(() => {
    this.stopped = true;
    this.waiter?.();
  });

  push(message: ChannelRunnerHealthMessage): void {
    this.messages.push(message);
    this.waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ChannelRunnerHealthMessage> {
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

describe("channel runner health contract", () => {
  it("uses a PID-scoped internal NATS subject", () => {
    expect(channelRunnerHealthSubject(4242)).toBe("_RAVI.channels.health.4242");
    expect(() => channelRunnerHealthSubject(0)).toThrow("positive integer");
    expect(() => channelRunnerHealthSubject(1.5)).toThrow("positive integer");
  });

  it("builds an isolated versioned snapshot", () => {
    const status = runtimeStatus();
    const snapshot = createChannelRunnerHealthSnapshot(status, 1_721_563_203_000);

    expect(snapshot).toEqual({
      schemaVersion: CHANNEL_RUNNER_HEALTH_SCHEMA_VERSION,
      observedAt: 1_721_563_203_000,
      ...status,
    });
    status.adapters[0]!.status = "failed";
    expect(snapshot.adapters[0]?.status).toBe("connected");
  });

  it("responds with the current snapshot and stops the subscription", async () => {
    const subscription = new TestSubscription();
    const subscribe = mock((_subject: string) => subscription);
    const getStatus = mock(() => runtimeStatus());
    let response: Uint8Array | undefined;
    const responder = startChannelRunnerHealthResponder({
      pid: 4242,
      getStatus,
      connection: { subscribe },
      now: () => 1_721_563_203_000,
    });

    subscription.push({
      data: codec.encode({}),
      respond(data) {
        response = data;
        return true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(responder.subject).toBe("_RAVI.channels.health.4242");
    expect(subscribe).toHaveBeenCalledWith(responder.subject);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(codec.decode(response!)).toEqual(createChannelRunnerHealthSnapshot(runtimeStatus(), 1_721_563_203_000));

    await responder.stop();
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("channel runner health probe", () => {
  it("accepts a valid snapshot from the exact PM2 PID", async () => {
    const snapshot = createChannelRunnerHealthSnapshot(runtimeStatus(), 1_721_563_203_000);
    const request = mock(async () => ({ data: codec.encode(snapshot) }));

    const result = await probeChannelRunnerHealth({
      pid: 4242,
      timeoutMs: 123,
      connect: async () => ({ request }),
    });

    expect(result).toEqual({ reachable: true, snapshot });
    expect(request).toHaveBeenCalledWith("_RAVI.channels.health.4242", expect.any(Uint8Array), { timeout: 123 });
  });

  it("rejects malformed and mismatched responses", async () => {
    const invalid = await probeChannelRunnerHealth({
      pid: 4242,
      connect: async () => ({
        request: async () => ({ data: codec.encode({ schemaVersion: 1, pid: 4242 }) }),
      }),
    });
    const mismatch = await probeChannelRunnerHealth({
      pid: 4242,
      connect: async () => ({
        request: async () => ({ data: codec.encode(createChannelRunnerHealthSnapshot(runtimeStatus(7777))) }),
      }),
    });

    expect(invalid).toEqual({ reachable: false, reason: "invalid_response" });
    expect(mismatch).toEqual({ reachable: false, reason: "pid_mismatch" });
  });

  it("distinguishes timeout, no responders, and unavailable NATS", async () => {
    const failingConnection = (error: Error & { code?: string }): ChannelRunnerHealthRequestConnection => ({
      request: async () => {
        throw error;
      },
    });
    const timeoutError = Object.assign(new Error("request timeout"), { code: "TIMEOUT" });
    const noRespondersError = Object.assign(new Error("503"), { code: "503" });

    await expect(
      probeChannelRunnerHealth({ pid: 4242, connect: async () => failingConnection(timeoutError) }),
    ).resolves.toEqual({ reachable: false, reason: "timeout" });
    await expect(
      probeChannelRunnerHealth({ pid: 4242, connect: async () => failingConnection(noRespondersError) }),
    ).resolves.toEqual({ reachable: false, reason: "no_responders" });
    await expect(
      probeChannelRunnerHealth({
        pid: 4242,
        connect: async () => {
          throw new Error("NATS down");
        },
      }),
    ).resolves.toEqual({ reachable: false, reason: "nats_unavailable" });
  });
});
