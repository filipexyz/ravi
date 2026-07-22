import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS,
  getChannelOutboundPublishJob,
  markChannelOutboundPublishJobPublished,
  prunePublishedChannelOutboundPublishJobs,
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

function makeJob(idempotencyKey: string, emitId: string): ChannelOutboundJob {
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
      targetChatId: "C123",
      origin: {
        sessionName: "ravi-channels",
        emitId,
      },
      content: {
        type: "text",
        text: "hello Slack",
      },
      idempotencyKey,
      target: {
        channel: "slack",
        accountId: "T1",
        instanceId: "slack-main",
        chatId: "C123",
      },
    },
  };
}
