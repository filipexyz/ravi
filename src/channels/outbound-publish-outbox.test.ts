import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS,
  getChannelOutboundPublishJob,
  markChannelOutboundPublishJobPublished,
  markChannelOutboundPublishJobSuppressed,
  publishChannelOutboundJobDurably,
  recordChannelOutboundPublishJobFailure,
  prunePublishedChannelOutboundPublishJobs,
  reconcileDueChannelOutboundPublishes,
  saveChannelOutboundPublishJob,
} from "./outbound-publish-outbox.js";
import type { ChannelOutboundJob } from "./outbound-stream.js";
import { closeRouterDb, getDb } from "../router/router-db.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-channel-publish-outbox-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("channel outbound publish outbox retention", () => {
  it("upgrades an existing publication table without losing pending or published rows", () => {
    const database = getDb();
    database.exec(`CREATE TABLE channel_outbound_publish_jobs (
      idempotency_key TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL,
      job_id TEXT NOT NULL, session_name TEXT NOT NULL, channel_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','published')), payload_json TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error_message TEXT, last_error_at INTEGER, published_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    for (const status of ["pending", "published"] as const) {
      database
        .prepare(`INSERT INTO channel_outbound_publish_jobs
        (idempotency_key,request_fingerprint,job_id,session_name,channel_id,status,payload_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(
          status,
          "legacy-fingerprint",
          status,
          "session",
          "slack",
          status,
          JSON.stringify(makeJob(status, status)),
          100,
          100,
        );
    }
    expect(getChannelOutboundPublishJob("published")).toMatchObject({
      status: "published",
      requestFingerprint: "legacy-fingerprint",
    });
    expect(markChannelOutboundPublishJobSuppressed("pending", "policy", 200)).toMatchObject({
      status: "suppressed",
      suppressionReason: "policy",
      createdAt: 100,
    });
    expect(getChannelOutboundPublishJob("pending")?.publishedAt).toBeUndefined();
  });

  it("keeps policy suppression terminal across publication retries and elapsed cooldown", async () => {
    const key = "runtime:ravi-channels:suppressed:slack:T1:C123:root";
    const job = makeJob(key, "suppressed");
    saveChannelOutboundPublishJob(job, 100);
    const closed = markChannelOutboundPublishJobSuppressed(key, "slack_bot_reply_cooldown", 200);
    expect(closed).toMatchObject({ status: "suppressed", suppressionReason: "slack_bot_reply_cooldown" });
    expect(closed.publishedAt).toBeUndefined();
    expect(markChannelOutboundPublishJobPublished(key, 300)).toEqual(closed);
    expect(recordChannelOutboundPublishJobFailure(key, new Error("late failure"), 400)).toEqual(closed);
    const calls: ChannelOutboundJob[] = [];
    const publisher = async (candidate: ChannelOutboundJob) => {
      calls.push(candidate);
    };
    const retried = await publishChannelOutboundJobDurably(job, { publisher, now: () => 900_000 });
    expect(retried).toMatchObject({
      ok: true,
      disposition: "suppressed",
      publishedNow: false,
      record: { status: "suppressed" },
    });
    expect(await reconcileDueChannelOutboundPublishes({ publisher, now: () => 900_000 })).toMatchObject({
      attempted: 0,
      published: 0,
      failed: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it("prunes suppressed payloads but keeps permanent tombstones through restart and explicit retry", async () => {
    const key = "suppressed-forever";
    const job = makeJob(key, key, { text: "content eligible for removal" });
    saveChannelOutboundPublishJob(job, 100);
    const suppressed = markChannelOutboundPublishJobSuppressed(key, "slack_bot_reply_cooldown", 101);
    if (suppressed.status !== "suppressed") throw new Error("expected terminal suppression");
    const now = 30 * 24 * 60 * 60 * 1_000;
    expect(prunePublishedChannelOutboundPublishJobs(now - CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS, now)).toBe(1);
    expect(
      getDb().prepare("SELECT payload_json FROM channel_outbound_publish_jobs WHERE idempotency_key = ?").get(key),
    ).toBeNull();
    const columns = getDb().prepare("PRAGMA table_info(channel_outbound_publish_suppressions)").all() as Array<{
      name: string;
    }>;
    expect(columns.map(({ name }) => name)).not.toContain("payload_json");
    closeRouterDb();
    expect(getChannelOutboundPublishJob(key)).toEqual(suppressed);
    expect(getChannelOutboundPublishJob(key)).not.toHaveProperty("job");
    const calls: ChannelOutboundJob[] = [];
    const publisher = async (candidate: ChannelOutboundJob) => {
      calls.push(candidate);
    };
    expect(await publishChannelOutboundJobDurably(job, { publisher, now: () => now })).toEqual({
      ok: true,
      disposition: "suppressed",
      record: suppressed,
      publishedNow: false,
    });
    expect(saveChannelOutboundPublishJob(job, now)).toEqual(suppressed);
    expect(() => saveChannelOutboundPublishJob(makeJob(key, key, { text: "changed content" }), now)).toThrow(
      "conflict",
    );
    expect(markChannelOutboundPublishJobPublished(key, now)).toEqual(suppressed);
    expect(recordChannelOutboundPublishJobFailure(key, new Error("late failure"), now)).toEqual(suppressed);
    expect(await reconcileDueChannelOutboundPublishes({ publisher, now: () => now })).toMatchObject({ attempted: 0 });
    expect(calls).toHaveLength(0);
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM channel_outbound_publish_jobs WHERE idempotency_key = ?").get(key),
    ).toEqual({ count: 0 });
  });

  it("backfills compact tombstones from already-suppressed rows before pruning their payload", () => {
    const key = "suppressed-before-tombstone-schema";
    saveChannelOutboundPublishJob(makeJob(key, key), 100);
    markChannelOutboundPublishJobSuppressed(key, "policy", 101);
    // Reproduce the preceding schema: terminal rows exist, tombstones do not.
    getDb().exec("DROP TABLE channel_outbound_publish_suppressions");
    closeRouterDb();
    expect(getChannelOutboundPublishJob(key)).toMatchObject({ status: "suppressed", suppressionReason: "policy" });
    expect(prunePublishedChannelOutboundPublishJobs(200, 201)).toBe(1);
    closeRouterDb();
    expect(getChannelOutboundPublishJob(key)).toMatchObject({ status: "suppressed", suppressionReason: "policy" });
  });

  it("rolls back suppression if its permanent tombstone cannot be written", () => {
    const key = "atomic-suppression";
    saveChannelOutboundPublishJob(makeJob(key, key), 100);
    getDb().exec(`CREATE TRIGGER reject_tombstone BEFORE INSERT ON channel_outbound_publish_suppressions
      BEGIN SELECT RAISE(ABORT, 'injected tombstone failure'); END`);
    expect(() => markChannelOutboundPublishJobSuppressed(key, "policy", 101)).toThrow("injected tombstone failure");
    expect(getChannelOutboundPublishJob(key)?.status).toBe("pending");
    getDb().exec("DROP TRIGGER reject_tombstone");
    expect(markChannelOutboundPublishJobSuppressed(key, "policy", 102).status).toBe("suppressed");
  });

  it("returns terminal suppression when it races an in-flight publisher success or failure", async () => {
    for (const fail of [false, true]) {
      const key = `publisher-race-${fail}`;
      const job = makeJob(key, key);
      const result = await publishChannelOutboundJobDurably(job, {
        now: () => 100,
        publisher: async () => {
          markChannelOutboundPublishJobSuppressed(key, "policy", 101);
          if (fail) throw new Error("late transport failure");
        },
      });
      expect(result).toMatchObject({
        ok: true,
        disposition: "suppressed",
        publishedNow: false,
        record: { status: "suppressed" },
      });
    }
  });

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
  options: { text?: string; chatId?: string; threadId?: string; accountId?: string } = {},
): ChannelOutboundJob {
  const accountId = options.accountId ?? "T1";
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
      accountId,
      targetChatId: options.chatId ?? "C123",
      ...(options.threadId ? { targetThreadId: options.threadId } : {}),
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
        accountId,
        instanceId: "slack-main",
        chatId: options.chatId ?? "C123",
        ...(options.threadId ? { threadId: options.threadId } : {}),
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

  it("keeps provider-unavailable notices for different threads of the same chat", async () => {
    const now = Date.UTC(2026, 9, 27, 13, 36);
    saveChannelOutboundPublishJob(
      makeJob("runtime:ravi-channels:thread-a:slack:T1:C123:root", "thread-a", {
        text: unavailableText,
        threadId: "1111.2222",
      }),
      now - 1_000,
    );
    saveChannelOutboundPublishJob(
      makeJob("runtime:ravi-channels:thread-b:slack:T1:C123:root", "thread-b", {
        text: unavailableText,
        threadId: "3333.4444",
      }),
      now - 999,
    );

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

  it("keeps provider-unavailable notices for different Slack accounts sharing a chat id", async () => {
    const now = Date.UTC(2026, 9, 27, 13, 36);
    saveChannelOutboundPublishJob(
      makeJob("runtime:ravi-channels:account-a:slack:T1:C123:root", "account-a", {
        text: unavailableText,
        accountId: "T1",
      }),
      now - 1_000,
    );
    saveChannelOutboundPublishJob(
      makeJob("runtime:ravi-channels:account-b:slack:T2:C123:root", "account-b", {
        text: unavailableText,
        accountId: "T2",
      }),
      now - 999,
    );

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

  it("coalesces a notice backlog larger than one due batch across two reconciles", async () => {
    const now = Date.UTC(2026, 9, 27, 13, 36);
    const keys = Array.from(
      { length: 26 },
      (_, index) => `runtime:ravi-channels:backlog-${index + 1}:slack:T1:C123:root`,
    );
    keys.forEach((key, index) => {
      saveChannelOutboundPublishJob(
        makeJob(key, `backlog-${index + 1}`, { text: unavailableText }),
        now - 1_000 + index,
      );
    });

    const published: string[] = [];
    const publisher = async (job: ChannelOutboundJob) => {
      published.push(job.request.requestId);
    };

    const first = await reconcileDueChannelOutboundPublishes({
      now: () => now + 60_000,
      publisher,
      emitEvent: async () => {},
    });
    const second = await reconcileDueChannelOutboundPublishes({
      now: () => now + 120_000,
      publisher,
      emitEvent: async () => {},
    });

    expect(published).toEqual(["runtime:ravi-channels:backlog-1"]);
    expect(first).toEqual({ attempted: 1, published: 1, failed: 0, coalesced: 25 });
    expect(second).toEqual({ attempted: 0, published: 0, failed: 0, coalesced: 0 });
    expect(getChannelOutboundPublishJob(keys[25]!)).toMatchObject({
      status: "published",
      supersededBy: keys[0]!,
    });
  });
});
