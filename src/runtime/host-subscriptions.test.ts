import { describe, expect, it } from "bun:test";
import { RuntimeHostSubscriptions } from "./host-subscriptions.js";
import type { RuntimeControlNatsRequest } from "./control-host.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeControlRequest, RuntimeControlResult } from "./types.js";
import type { RuntimeSessionDispatcher } from "./session-dispatcher.js";

async function* emptyEvents(): AsyncGenerator<never> {}

function streamingSession(
  control: (request: RuntimeControlRequest) => Promise<RuntimeControlResult>,
): RuntimeHostStreamingSession {
  return {
    agentId: "agent-a",
    queryHandle: { provider: "codex", events: emptyEvents(), interrupt: async () => {}, control },
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentModel: "test-model",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: true,
    onTurnComplete: null,
    compacting: false,
    currentToolSafety: null,
    pendingAbort: false,
  };
}

describe("runtime control subscription lanes", () => {
  it("answers other sessions while one session's provider control hangs", async () => {
    const replies: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const calls: string[] = [];
    let releaseStuck: (result: RuntimeControlResult) => void = () => {};
    const stuck = streamingSession(
      (request) =>
        new Promise<RuntimeControlResult>((resolve) => {
          calls.push(`stuck:${request.operation}`);
          releaseStuck = resolve;
        }),
    );
    const healthy = streamingSession(async (request) => {
      calls.push(`healthy:${request.operation}`);
      return { ok: true, operation: request.operation, data: {} };
    });
    const subscriptions = new RuntimeHostSubscriptions({
      isRunning: () => true,
      dispatcher: {
        streamingSessions: new Map([
          ["stuck-session", stuck],
          ["healthy-session", healthy],
        ]),
      } as unknown as RuntimeSessionDispatcher,
      safeEmit: async (topic, data) => {
        replies.push({ topic, data });
      },
    });
    const enqueue = (data: RuntimeControlNatsRequest) =>
      (
        subscriptions as unknown as { enqueueRuntimeControl(data: RuntimeControlNatsRequest): void }
      ).enqueueRuntimeControl(data);

    enqueue({ sessionName: "stuck-session", replyTopic: "reply.stuck.1", request: { operation: "thread.list" } });
    enqueue({ sessionName: "stuck-session", replyTopic: "reply.stuck.2", request: { operation: "thread.read" } });
    enqueue({ sessionName: "healthy-session", replyTopic: "reply.healthy", request: { operation: "thread.list" } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(replies.find((reply) => reply.topic === "reply.healthy")?.data).toMatchObject({
      result: { ok: true, operation: "thread.list" },
    });
    // Same-session order is kept: the second control waits behind the first.
    expect(calls).toEqual(["stuck:thread.list", "healthy:thread.list"]);

    releaseStuck({ ok: true, operation: "thread.list", data: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual(["stuck:thread.list", "healthy:thread.list", "stuck:thread.read"]);

    releaseStuck({ ok: true, operation: "thread.read", data: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(replies.find((reply) => reply.topic === "reply.stuck.2")?.data).toMatchObject({
      result: { ok: true, operation: "thread.read" },
    });
  });
});
