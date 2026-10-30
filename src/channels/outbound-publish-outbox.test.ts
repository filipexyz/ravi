import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS,
  getChannelOutboundPublishJob,
  markChannelOutboundPublishJobPublished,
  prunePublishedChannelOutboundPublishJobs,
  reconcileDueChannelOutboundPublishes,
  saveChannelOutboundPublishJob,
} from "./outbound-publish-outbox.js";
import type { ChannelOutboundJob } from "./outbound-stream.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-channel-publish-outbox-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("channel outbound publish outbox retention", () => {
  it("removes expired published jobs while preserving old pending jobs", () => {
    const now = Date.UTC(2026, 6, 22);
    const expired = now - CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS - 1;
    const pendingKey = "runtime:ravi-channels:pending-old:slack:T1:C123:root";
    const publishedKey = "runtime:ravi-channels:published-old:slack:T1:C123:root";

    saveChannelOutboundPublishJob(makeJob(pendingKey, "pending-old"), expired);
    saveChannelOutboundPublishJob(makeJob(publishedKey, "published-old"), expired);
    markChannelOutboundPublishJobPublished(publishedKey, expired);

    expect(prunePublishedChannelOutboundPublishJobs(now - CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS, now)).toBe(1);

    expect(getChannelOutboundPublishJob(publishedKey)).toBeNull();
    expect(getChannelOutboundPublishJob(pendingKey)).toMatchObject({
      idempotencyKey: pendingKey,
      status: "pending",
      createdAt: expired,
    });
  });

  it("preserves published jobs inside the retention window", () => {
    const now = Date.UTC(2026, 6, 22);
    const recent = now - CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS + 1;
    const recentKey = "runtime:ravi-channels:published-recent:slack:T1:C123:root";

    saveChannelOutboundPublishJob(makeJob(recentKey, "published-recent"), recent);
    markChannelOutboundPublishJobPublished(recentKey, recent);

    expect(prunePublishedChannelOutboundPublishJobs(now - CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS, now)).toBe(0);
    expect(getChannelOutboundPublishJob(recentKey)).toMatchObject({
      idempotencyKey: recentKey,
      status: "published",
      publishedAt: recent,
    });
  });
});

function makeJob(
  idempotencyKey: string,
  emitId: string,
  options: { text?: string; chatId?: string } = {},
): ChannelOutboundJob {
  return {
    jobId: `runtime:ravi-channels:${emitId}`,
    status: "queued",
    attemptCount: 0,
    createdAt: 1782920000000,
    updatedAt: 1782920000000,
    request: {
      requestId: `runtime:ravi-channels:${emitId}`,
      channelId: "slack",
      instanceId: "slack-main",
      accountId: "T1",
      targetChatId: options.chatId ?? "C123",
      origin: {
        sessionName: "ravi-channels",
        emitId,
      },
      content: {
        type: "text",
        text: options.text ?? "hello Slack",
      },
      idempotencyKey,
      target: {
        channel: "slack",
        accountId: "T1",
        instanceId: "slack-main",
        chatId: options.chatId ?? "C123",
      },
    },
  };
}

describe("channel outbound publish outbox coalescing", () => {
  const unavailableText = "Error: The agent is temporarily unavailable. Please try again later.";

  it("discards duplicate provider-unavailable notices for the same channel and chat", async () => {
    const now = Date.UTC(2026, 9, 27, 13, 36);
    const keys = [1, 2, 3].map((n) => `runtime:ravi-channels:burst-${n}:slack:T1:C123:root`);
    keys.forEach((key, index) => {
      saveChannelOutboundPublishJob(makeJob(key, `burst-${index + 1}`, { text: unavailableText }), now - 1_000 + index);
    });

    const published: string[] = [];
    const result = await reconcileDueChannelOutboundPublishes({
      now: () => now + 60_000,
      publisher: async (job) => {
        published.push(job.request.requestId);
      },
      emitEvent: async () => {},
    });

    expect(published).toEqual(["runtime:ravi-channels:burst-1"]);
    expect(result).toEqual({ attempted: 1, published: 1, failed: 0, coalesced: 2 });
    expect(getChannelOutboundPublishJob(keys[0]!)).toMatchObject({ status: "published" });
    for (const key of keys.slice(1)) {
      expect(getChannelOutboundPublishJob(key!)).toMatchObject({
        status: "published",
        supersededBy: keys[0]!,
      });
    }
  });

  it("never coalesces ordinary chat text that happens to repeat", async () => {
    const now = Date.UTC(2026, 9, 27, 13, 36);
    const keys = [1, 2].map((n) => `runtime:ravi-channels:same-${n}:slack:T1:C123:root`);
    keys.forEach((key, index) => {
      saveChannelOutboundPublishJob(makeJob(key, `same-${index + 1}`, { text: "oi" }), now - 1_000 + index);
    });

    const published: string[] = [];
    const result = await reconcileDueChannelOutboundPublishes({
      now: () => now + 60_000,
      publisher: async (job) => {
        published.push(job.request.requestId);
      },
      emitEvent: async () => {},
    });

    expect(published).toHaveLength(2);
    expect(result).toEqual({ attempted: 2, published: 2, failed: 0, coalesced: 0 });
  });

  it("keeps provider-unavailable notices for different chats and different texts", async () => {
    const now = Date.UTC(2026, 9, 27, 13, 36);
    saveChannelOutboundPublishJob(
      makeJob("runtime:ravi-channels:chat-a:slack:T1:C123:root", "chat-a", { text: unavailableText, chatId: "C123" }),
      now - 1_000,
    );
    saveChannelOutboundPublishJob(
      makeJob("runtime:ravi-channels:chat-b:slack:T1:C999:root", "chat-b", { text: unavailableText, chatId: "C999" }),
      now - 999,
    );
    saveChannelOutboundPublishJob(
      makeJob("runtime:ravi-channels:other-text:slack:T1:C123:root", "other-text", {
        text: "outra falha",
        chatId: "C123",
      }),
      now - 998,
    );

    const published: string[] = [];
    const result = await reconcileDueChannelOutboundPublishes({
      now: () => now + 60_000,
      publisher: async (job) => {
        published.push(job.request.requestId);
      },
      emitEvent: async () => {},
    });

    expect(published).toHaveLength(3);
    expect(result).toEqual({ attempted: 3, published: 3, failed: 0, coalesced: 0 });
  });
});
