import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS,
  claimChannelOutboundReceipt,
  getChannelOutboundReceipt,
  markChannelOutboundReceiptComplete,
  markChannelOutboundReceiptPersisted,
  markChannelOutboundReceiptTerminalError,
  markChannelOutboundReceiptTraceRecorded,
  pruneExpiredChannelOutboundReceipts,
  recordChannelOutboundReceiptError,
  recordChannelOutboundSent,
  releaseChannelOutboundReceiptClaim,
} from "./outbound-receipts.js";

describe("channel outbound receipt ledger", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-outbound-ledger-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("claims atomically, rejects active contenders, and lets an expired claim resume", () => {
    const first = claim({ owner: "runner-1", now: 100, leaseMs: 50 });
    expect(first).toMatchObject({
      status: "acquired",
      receipt: {
        state: "claimed",
        requestFingerprint: "fingerprint-1",
        claimOwner: "runner-1",
        claimExpiresAt: 150,
      },
    });

    expect(claim({ owner: "runner-2", now: 149, leaseMs: 50 })).toMatchObject({
      status: "busy",
      receipt: { claimOwner: "runner-1" },
    });

    const resumed = claim({ owner: "runner-2", now: 150, leaseMs: 50 });
    expect(resumed).toMatchObject({
      status: "acquired",
      receipt: { claimOwner: "runner-2", claimExpiresAt: 200 },
    });

    expect(() => sent({ owner: "runner-1", sentAt: 151 })).toThrow("claim lost");
    expect(sent({ owner: "runner-2", sentAt: 152 })).toMatchObject({
      state: "sent",
      platformMessageId: "1713000000.000100",
      sentAt: 152,
    });
    expect(getChannelOutboundReceipt("idem-1")?.claimOwner).toBeUndefined();
  });

  it("fails closed when an idempotency key is reused for another request fingerprint", () => {
    claim({ owner: "runner-1", now: 100, leaseMs: 50 });

    expect(claim({ owner: "runner-2", requestFingerprint: "different", now: 200 })).toMatchObject({
      status: "conflict",
      receipt: {
        requestFingerprint: "fingerprint-1",
        claimOwner: "runner-1",
      },
    });
  });

  it("stores claim metadata without retaining provider responses or a false telemetry marker", () => {
    claim({ owner: "runner-1", now: 100 });

    const columns = (
      getDb().prepare("PRAGMA table_info(channel_outbound_receipts)").all() as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(columns).toContain("request_fingerprint");
    expect(columns).toContain("claim_owner");
    expect(columns).toContain("claim_expires_at");
    expect(columns).not.toContain("provider_raw_json");
    expect(columns).not.toContain("telemetry_emitted_at");
    const indexes = (
      getDb().prepare("PRAGMA index_list(channel_outbound_receipts)").all() as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(indexes).toContain("idx_channel_outbound_receipts_updated");
  });

  it("upgrades the pre-claim receipt schema before installing claim indexes", () => {
    if (!stateDir) throw new Error("isolated Ravi state was not created");
    const legacyDb = new Database(join(stateDir, "ravi.db"));
    legacyDb.exec(`
      CREATE TABLE channel_outbound_receipts (
        idempotency_key       TEXT PRIMARY KEY,
        job_id                TEXT NOT NULL,
        request_id            TEXT NOT NULL,
        session_name          TEXT NOT NULL,
        state                 TEXT NOT NULL CHECK(state IN ('sent','persisted','complete')),
        provider              TEXT NOT NULL,
        delivery_message_id   TEXT,
        platform_message_id   TEXT,
        provider_timestamp    INTEGER,
        provider_raw_json     TEXT,
        canonical_message_id  TEXT,
        sent_at               INTEGER NOT NULL,
        persisted_at          INTEGER,
        trace_recorded_at     INTEGER,
        telemetry_emitted_at  INTEGER,
        completed_at          INTEGER,
        last_error_phase      TEXT,
        last_error_message    TEXT,
        last_error_at         INTEGER,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );
      INSERT INTO channel_outbound_receipts (
        idempotency_key, job_id, request_id, session_name, state, provider,
        delivery_message_id, platform_message_id, provider_timestamp,
        provider_raw_json, canonical_message_id, sent_at, created_at, updated_at
      ) VALUES (
        'legacy-idem', 'legacy-job', 'legacy-request', 'legacy-session', 'sent', 'slack',
        'slack:C123:1', '1.000100', 1000, '{"ok":true}', 'legacy-canonical', 1000, 900, 1000
      )
    `);
    legacyDb.close();

    const database = getDb();
    const columns = (
      database.prepare("PRAGMA table_info(channel_outbound_receipts)").all() as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(columns).toContain("request_fingerprint");
    expect(columns).toContain("claim_owner");
    expect(columns).toContain("claim_expires_at");
    expect(columns).not.toContain("provider_raw_json");
    expect(columns).not.toContain("telemetry_emitted_at");
    expect(
      (database.prepare("PRAGMA index_list(channel_outbound_receipts)").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).toContain("idx_channel_outbound_receipts_claim");
    expect(getChannelOutboundReceipt("legacy-idem")).toMatchObject({
      requestFingerprint: "legacy:legacy-idem",
      jobId: "legacy-job",
      state: "sent",
      platformMessageId: "1.000100",
      canonicalMessageId: "legacy-canonical",
    });
    expect(
      claim({
        idempotencyKey: "legacy-idem",
        requestFingerprint: "current-request",
        owner: "runner-current",
        now: 2000,
      }),
    ).toMatchObject({ status: "conflict" });
    expect(
      claim({
        idempotencyKey: "new-idem",
        requestFingerprint: "new-request",
        owner: "runner-current",
        now: 2000,
      }),
    ).toMatchObject({
      status: "acquired",
      receipt: { state: "claimed", claimExpiresAt: 302000 },
    });
  });

  it("releases a failed send claim for immediate retry without changing its fingerprint", () => {
    claim({ owner: "runner-1", now: 100, leaseMs: 500 });
    expect(
      releaseChannelOutboundReceiptClaim({
        idempotencyKey: "idem-1",
        requestFingerprint: "fingerprint-1",
        owner: "runner-1",
        error: "provider unavailable",
        releasedAt: 110,
      }),
    ).toMatchObject({
      state: "claimed",
      requestFingerprint: "fingerprint-1",
      claimExpiresAt: 110,
      lastErrorPhase: "send",
    });
    expect(claim({ owner: "runner-2", now: 110 })).toMatchObject({
      status: "acquired",
      receipt: { claimOwner: "runner-2", requestFingerprint: "fingerprint-1" },
    });
  });

  it("advances durable post-send phases and keeps the provider receipt immutable", () => {
    claim({ owner: "runner-1", now: 90 });
    expect(sent({ owner: "runner-1", sentAt: 100 })).toMatchObject({
      state: "sent",
      provider: "slack",
      platformMessageId: "1713000000.000100",
      providerTimestamp: 1_713_000_000_000,
      sentAt: 100,
    });

    expect(recordChannelOutboundReceiptError("idem-1", "canonical_persist", "busy", 110)).toMatchObject({
      state: "sent",
      lastErrorPhase: "canonical_persist",
      lastErrorMessage: "busy",
      lastErrorAt: 110,
    });
    expect(
      markChannelOutboundReceiptPersisted("idem-1", {
        canonicalMessageId: "cm_123",
        providerTimestamp: 999,
        persistedAt: 120,
      }),
    ).toMatchObject({
      state: "persisted",
      canonicalMessageId: "cm_123",
      providerTimestamp: 1_713_000_000_000,
      persistedAt: 120,
    });
    expect(markChannelOutboundReceiptTraceRecorded("idem-1", 130)).toMatchObject({
      traceRecordedAt: 130,
    });
    expect(markChannelOutboundReceiptComplete("idem-1", 140)).toMatchObject({
      state: "complete",
      completedAt: 140,
    });
    expect(getChannelOutboundReceipt("idem-1")).toMatchObject({
      state: "complete",
      canonicalMessageId: "cm_123",
      platformMessageId: "1713000000.000100",
    });
  });

  it("terminalizes a permanent post-send error without claiming canonical persistence", () => {
    claim({ owner: "runner-1", now: 90 });
    sent({ owner: "runner-1", sentAt: 100 });

    expect(
      markChannelOutboundReceiptTerminalError(
        "idem-1",
        "canonical_persist",
        "Canonical outbound message not found",
        120,
      ),
    ).toMatchObject({
      state: "complete",
      completedAt: 120,
      lastErrorPhase: "canonical_persist",
      lastErrorMessage: "Canonical outbound message not found",
      lastErrorAt: 120,
    });
    expect(getChannelOutboundReceipt("idem-1")?.persistedAt).toBeUndefined();
  });

  it("prunes every stale state at the 14-day cutoff without deleting recent or active receipts", () => {
    const now = 30 * 24 * 60 * 60 * 1_000;
    const cutoff = now - CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS;
    complete("complete-old", "fingerprint-complete-old", cutoff - 1);
    complete("complete-boundary", "fingerprint-complete-boundary", cutoff);
    claim({
      idempotencyKey: "claimed-old",
      requestFingerprint: "fingerprint-claimed-old",
      owner: "runner-claimed-old",
      now: cutoff - 1,
    });
    claim({
      idempotencyKey: "sent-old",
      requestFingerprint: "fingerprint-sent-old",
      owner: "runner-sent-old",
      now: 1,
    });
    sent({
      idempotencyKey: "sent-old",
      requestFingerprint: "fingerprint-sent-old",
      owner: "runner-sent-old",
      sentAt: cutoff - 1,
    });
    claim({
      idempotencyKey: "persisted-old",
      requestFingerprint: "fingerprint-persisted-old",
      owner: "runner-persisted-old",
      now: 1,
    });
    sent({
      idempotencyKey: "persisted-old",
      requestFingerprint: "fingerprint-persisted-old",
      owner: "runner-persisted-old",
      sentAt: 2,
    });
    markChannelOutboundReceiptPersisted("persisted-old", { persistedAt: cutoff - 1 });
    claim({
      idempotencyKey: "claimed-recent",
      requestFingerprint: "fingerprint-claimed-recent",
      owner: "runner-claimed-recent",
      now: cutoff + 1,
    });
    claim({
      idempotencyKey: "claimed-active",
      requestFingerprint: "fingerprint-claimed-active",
      owner: "runner-claimed-active",
      now: cutoff - 1,
      leaseMs: CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS + 2,
    });
    complete("complete-recent", "fingerprint-complete-recent", cutoff + 1);

    expect(pruneExpiredChannelOutboundReceipts(cutoff, now)).toBe(5);
    expect(getChannelOutboundReceipt("complete-old")).toBeNull();
    expect(getChannelOutboundReceipt("complete-boundary")).toBeNull();
    expect(getChannelOutboundReceipt("claimed-old")).toBeNull();
    expect(getChannelOutboundReceipt("sent-old")).toBeNull();
    expect(getChannelOutboundReceipt("persisted-old")).toBeNull();
    expect(getChannelOutboundReceipt("claimed-recent")).toMatchObject({ state: "claimed" });
    expect(getChannelOutboundReceipt("claimed-active")).toMatchObject({ state: "claimed" });
    expect(getChannelOutboundReceipt("complete-recent")).toMatchObject({ state: "complete" });
  });
});

function claim(
  overrides: Partial<Parameters<typeof claimChannelOutboundReceipt>[0]> = {},
): ReturnType<typeof claimChannelOutboundReceipt> {
  return claimChannelOutboundReceipt({
    idempotencyKey: "idem-1",
    requestFingerprint: "fingerprint-1",
    owner: "runner-1",
    jobId: "job-1",
    requestId: "request-1",
    sessionName: "session-1",
    provider: "slack",
    ...overrides,
  });
}

function sent(
  overrides: Partial<Parameters<typeof recordChannelOutboundSent>[0]> = {},
): ReturnType<typeof recordChannelOutboundSent> {
  return recordChannelOutboundSent({
    idempotencyKey: "idem-1",
    requestFingerprint: "fingerprint-1",
    owner: "runner-1",
    provider: "slack",
    deliveryMessageId: "slack:C123:1713000000.000100",
    platformMessageId: "1713000000.000100",
    providerTimestamp: 1_713_000_000_000,
    sentAt: 100,
    ...overrides,
  });
}

function complete(idempotencyKey: string, requestFingerprint: string, completedAt: number): void {
  claim({ idempotencyKey, requestFingerprint, owner: `runner-${idempotencyKey}`, now: 1 });
  sent({ idempotencyKey, requestFingerprint, owner: `runner-${idempotencyKey}`, sentAt: 2 });
  markChannelOutboundReceiptPersisted(idempotencyKey, { persistedAt: 3 });
  markChannelOutboundReceiptComplete(idempotencyKey, completedAt);
}
