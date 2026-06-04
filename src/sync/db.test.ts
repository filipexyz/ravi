import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  applyInboxBatch,
  enqueueRemoteEvent,
  enqueueSyncEvent,
  getSyncCursor,
  getSyncStatusSummary,
  inspectSyncRecord,
  listPendingOutboxBatch,
  markOutboxAcked,
  markOutboxFailed,
  retryOutbox,
  setSyncCursor,
} from "./db.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sync-db-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

describe("sync db", () => {
  it("lazy-inits sync tables", () => {
    const rows = getDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sync_outbox','sync_inbox','sync_cursors','sync_dead_letters') ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual(["sync_cursors", "sync_dead_letters", "sync_inbox", "sync_outbox"]);
  });

  it("enqueues outbox events idempotently", () => {
    const first = enqueueSyncEvent({
      domain: "crm",
      eventType: "crm.activity.logged",
      entityType: "activity",
      entityId: "act_1",
      idempotencyKey: "crm:act_1:1",
      payload: { note: "hello", accessToken: "secret-token" },
    });
    const second = enqueueSyncEvent({
      domain: "crm",
      eventType: "crm.activity.logged",
      entityType: "activity",
      entityId: "act_1",
      idempotencyKey: "crm:act_1:1",
      payload: { note: "ignored" },
    });

    expect(first?.id).toBe(second?.id);
    expect((first?.payload as Record<string, unknown>).accessToken).toBe("[REDACTED]");
    expect(getSyncStatusSummary().outbox.pending).toBe(1);
  });

  it("leases pending outbox batches by count and bytes", () => {
    for (let i = 0; i < 3; i++) {
      enqueueSyncEvent({
        domain: "crm",
        eventType: "crm.test",
        entityType: "item",
        entityId: `item_${i}`,
        idempotencyKey: `item:${i}`,
        payload: { text: "x".repeat(50) },
      });
    }

    const batch = listPendingOutboxBatch({ limit: 2, maxBytes: 4096, now: 1000 });
    expect(batch.items).toHaveLength(2);
    expect(batch.items.every((item) => item.status === "leased")).toBe(true);
    expect(getSyncStatusSummary().outbox.leased).toBe(2);
    expect(getSyncStatusSummary().outbox.pending).toBe(1);
  });

  it("tracks sent, acked, failed, dead, and retry states", () => {
    const event = enqueueSyncEvent({
      domain: "crm",
      eventType: "crm.test",
      entityType: "item",
      entityId: "item_1",
      idempotencyKey: "item:1",
      payload: {},
    })!;
    markOutboxFailed({ ids: [event.id], errorCode: "server unavailable", now: 1000 });
    expect(inspectSyncRecord(event.id)?.record.status).toBe("failed");
    retryOutbox({ ids: [event.id], now: 2000 });
    expect(inspectSyncRecord(event.id)?.record.status).toBe("pending");
    markOutboxAcked([event.id], 3000);
    expect(inspectSyncRecord(event.id)?.record.status).toBe("acked");
  });

  it("enqueues and applies inbox events idempotently", async () => {
    const first = enqueueRemoteEvent({
      remoteSequence: 1,
      remoteEventId: "remote_1",
      domain: "crm",
      eventType: "crm.remote",
      entityType: "activity",
      entityId: "act_remote",
      payload: { note: "hello" },
    });
    const second = enqueueRemoteEvent({
      remoteSequence: 1,
      remoteEventId: "remote_1",
      domain: "crm",
      eventType: "crm.remote",
      entityType: "activity",
      entityId: "act_remote",
      payload: { note: "ignored" },
    });
    expect(first.id).toBe(second.id);

    const applied = await applyInboxBatch({
      handlers: {
        crm: () => "applied",
      },
    });
    expect(applied.applied).toBe(1);
    expect(getSyncStatusSummary().inbox.applied).toBe(1);
  });

  it("treats duplicate remote sequence as idempotent even when event id differs", () => {
    const first = enqueueRemoteEvent({
      remoteSequence: 7,
      remoteEventId: "remote_7_a",
      domain: "crm",
      eventType: "crm.remote",
      entityType: "activity",
      entityId: "act_remote",
      payload: { note: "hello" },
    });
    const second = enqueueRemoteEvent({
      remoteSequence: 7,
      remoteEventId: "remote_7_b",
      domain: "crm",
      eventType: "crm.remote",
      entityType: "activity",
      entityId: "act_remote",
      payload: { note: "ignored" },
    });

    expect(second.id).toBe(first.id);
    expect(getSyncStatusSummary().inbox.pending).toBe(1);
  });

  it("stores cursors by domain/key", () => {
    setSyncCursor("crm", "default", "42", { source: "test" }, 123);
    expect(getSyncCursor("crm", "default")).toMatchObject({
      domain: "crm",
      cursorKey: "default",
      cursorValue: "42",
      updatedAt: 123,
      meta: { source: "test" },
    });
  });
});
