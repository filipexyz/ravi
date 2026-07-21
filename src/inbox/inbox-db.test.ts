import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeCloudCredentials } from "../cloud-auth/storage.js";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  acquireInboxPollLock,
  countPendingItems,
  ensureSubscriptionRow,
  getItemByItemId,
  getSubscriptionByOrg,
  inboxPollLockKey,
  markSubscriptionPolled,
  releaseInboxPollLock,
  reconcileDeliveredItemsAckedThroughSequence,
  renewInboxPollLock,
  upsertDeliveredItem,
} from "./inbox-db.js";
import { setEnabledForCurrentOrg } from "./inbox-runner.js";

let stateDir: string | null = null;

describe("console inbox delivery state", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-console-inbox-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("creates the complete delivery schema in a fresh Ravi state", () => {
    const rows = getDb()
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'console_inbox_subscriptions',
           'console_inbox_items',
           'console_inbox_poll_locks'
         )
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual([
      "console_inbox_items",
      "console_inbox_poll_locks",
      "console_inbox_subscriptions",
    ]);
  });

  it("resumes an already-enabled paused subscription idempotently", () => {
    writeCloudCredentials(makeCredentials());
    const row = ensureSubscriptionRow({
      consoleUrl: "https://console.ravi.bot",
      organizationId: "org_1",
      installationId: "ins_1",
    });
    markSubscriptionPolled(row.id, { status: "paused", errorCode: "CREDENTIALS_INVALID" });

    expect(setEnabledForCurrentOrg(true)).toEqual({ changed: true });
    expect(getSubscriptionByOrg(row.consoleUrl, row.organizationId)).toMatchObject({
      enabled: true,
      status: "active",
      lastErrorCode: null,
      lastErrorAt: null,
    });
    expect(setEnabledForCurrentOrg(true)).toEqual({ changed: false });
  });

  it("reactivates a paused subscription after installation rotation", () => {
    const row = ensureSubscriptionRow({
      consoleUrl: "https://console.ravi.bot",
      organizationId: "org_1",
      installationId: "ins_1",
    });
    markSubscriptionPolled(row.id, {
      generation: 7,
      lastSequence: 42,
      status: "paused",
      errorCode: "INSTALLATION_REVOKED",
    });

    expect(
      ensureSubscriptionRow({
        consoleUrl: row.consoleUrl,
        organizationId: row.organizationId,
        installationId: "ins_2",
      }),
    ).toMatchObject({
      installationId: "ins_2",
      subscriptionId: null,
      status: "active",
      lastGeneration: null,
      lastSequence: null,
      lastErrorCode: null,
      lastErrorAt: null,
    });
  });

  it("allows one poll owner and permits takeover only after release or expiry", () => {
    const lockKey = inboxPollLockKey("https://console.ravi.bot/", "org_1");
    expect(lockKey).toBe(inboxPollLockKey("https://console.ravi.bot", "org_1"));

    expect(acquireInboxPollLock({ lockKey, ownerId: "runner_a", ttlMs: 1_000, now: 1_000 })).toBe(true);
    expect(acquireInboxPollLock({ lockKey, ownerId: "runner_b", ttlMs: 1_000, now: 1_500 })).toBe(false);
    expect(renewInboxPollLock({ lockKey, ownerId: "runner_b", ttlMs: 1_000, now: 1_500 })).toBe(false);
    expect(renewInboxPollLock({ lockKey, ownerId: "runner_a", ttlMs: 1_000, now: 1_600 })).toBe(true);
    expect(releaseInboxPollLock(lockKey, "runner_b")).toBe(false);
    expect(releaseInboxPollLock(lockKey, "runner_a")).toBe(true);
    expect(acquireInboxPollLock({ lockKey, ownerId: "runner_b", ttlMs: 1_000, now: 1_700 })).toBe(true);
    expect(acquireInboxPollLock({ lockKey, ownerId: "runner_c", ttlMs: 1_000, now: 2_700 })).toBe(true);
  });

  it("counts pending items by the local Console+organization mirror", () => {
    const subscription = ensureSubscriptionRow({
      consoleUrl: "https://console.ravi.bot",
      organizationId: "org_1",
      installationId: "ins_1",
    });
    upsertDeliveredItem({
      consoleUrl: subscription.consoleUrl,
      organizationId: subscription.organizationId,
      subscriptionId: "remote_sub_1",
      itemId: "item_1",
      sequence: 1,
      eventType: "task.created",
      category: "task",
      severity: "info",
      dedupeKey: "task:item_1",
      natsSubject: "ravi.console.inbox.item",
      natsPayloadJson: "{}",
      deliveredAt: null,
    });

    expect(
      countPendingItems({
        consoleUrl: subscription.consoleUrl,
        organizationId: subscription.organizationId,
      }),
    ).toEqual({ undelivered: 1, unacked: 1 });
  });

  it("keeps a flushed item's payload and subscription provenance immutable on redelivery", () => {
    const original = upsertDeliveredItem({
      consoleUrl: "https://console.ravi.bot",
      organizationId: "org_1",
      subscriptionId: "sub_original",
      itemId: "item_immutable",
      sequence: 9,
      eventType: "task.created",
      category: "task",
      severity: "info",
      dedupeKey: "dedupe_original",
      natsSubject: "ravi.console.inbox.item",
      natsPayloadJson: '{"delivery":{"pollId":"original"}}',
      deliveredAt: 10_000,
    }).row;

    const retry = upsertDeliveredItem({
      consoleUrl: original.consoleUrl,
      organizationId: original.organizationId,
      subscriptionId: "sub_retry",
      itemId: original.itemId,
      sequence: 99,
      eventType: "task.changed",
      category: "changed",
      severity: "warning",
      dedupeKey: "dedupe_retry",
      natsSubject: "ravi.changed",
      natsPayloadJson: '{"delivery":{"pollId":"retry"}}',
      deliveredAt: null,
    });

    expect(retry.created).toBe(false);
    expect(retry.row).toMatchObject({
      id: original.id,
      subscriptionId: "sub_original",
      sequence: 9,
      eventType: "task.created",
      category: "task",
      severity: "info",
      dedupeKey: "dedupe_original",
      natsSubject: "ravi.console.inbox.item",
      natsPayloadJson: '{"delivery":{"pollId":"original"}}',
      deliveredAt: 10_000,
    });
  });

  it("reconciles only delivered rows in the authoritative Console and organization scope", () => {
    const seed = (input: {
      consoleUrl: string;
      organizationId: string;
      itemId: string;
      sequence: number;
      deliveredAt: number | null;
    }) =>
      upsertDeliveredItem({
        ...input,
        subscriptionId: `sub_${input.organizationId}`,
        eventType: "task.created",
        category: "task",
        severity: "info",
        dedupeKey: `dedupe_${input.itemId}`,
        natsSubject: "ravi.console.inbox.item",
        natsPayloadJson: "{}",
      }).row;

    const delivered = seed({
      consoleUrl: "https://console.ravi.bot",
      organizationId: "org_1",
      itemId: "item_delivered",
      sequence: 4,
      deliveredAt: 1_000,
    });
    const undelivered = seed({
      consoleUrl: "https://console.ravi.bot",
      organizationId: "org_1",
      itemId: "item_undelivered",
      sequence: 5,
      deliveredAt: null,
    });
    const otherOrganization = seed({
      consoleUrl: "https://console.ravi.bot",
      organizationId: "org_2",
      itemId: "item_other_org",
      sequence: 4,
      deliveredAt: 1_000,
    });

    expect(
      reconcileDeliveredItemsAckedThroughSequence({
        consoleUrl: "https://console.ravi.bot",
        organizationId: "org_1",
        sequence: 5,
        ackedAt: 2_000,
      }),
    ).toBe(1);
    expect(getItemByItemId(delivered.consoleUrl, delivered.organizationId, delivered.itemId)?.ackedAt).toBe(2_000);
    expect(getItemByItemId(undelivered.consoleUrl, undelivered.organizationId, undelivered.itemId)?.ackedAt).toBeNull();
    expect(
      getItemByItemId(otherOrganization.consoleUrl, otherOrganization.organizationId, otherOrganization.itemId)
        ?.ackedAt,
    ).toBeNull();
  });
});

function makeCredentials() {
  const now = new Date().toISOString();
  return {
    version: 1 as const,
    consoleUrl: "https://console.ravi.bot",
    installationId: "ins_1",
    accessToken: "access-test",
    refreshToken: "refresh-test",
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scopes: [],
    organization: { id: "org_1" },
    user: { id: "user_1" },
    createdAt: now,
    updatedAt: now,
  };
}
