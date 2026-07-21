import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { writeCloudCredentials } from "../cloud-auth/storage.js";
import { getDb } from "../router/router-db.js";
import {
  countPendingItems,
  ensureSubscriptionRow,
  getItemByItemId,
  getSubscriptionByOrg,
  inboxPollLockKey,
  markSubscriptionPolled,
  updateSubscriptionRemoteId,
  upsertDeliveredItem,
} from "./inbox-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { ConsoleInboxItem, InboxNatsPayload } from "./types.js";
import {
  InboxRunner,
  computeInboxDeliveryProgress,
  isCompleteInboxAck,
  publishInboxNatsEvents,
} from "./inbox-runner.js";

let stateDir: string | null = null;
let originalFetch: typeof fetch;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-inbox-runner-test-");
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  mock.restore();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("inbox runner delivery progress", () => {
  it("advances the local cursor when every contiguous item was delivered and acked", () => {
    expect(
      computeInboxDeliveryProgress(10, [
        { sequence: 11, delivered: true },
        { sequence: 12, delivered: true },
      ]),
    ).toEqual({ lastSequence: 12, hadDeliveryFailure: false });
  });

  it("orders delivery results before advancing the cursor", () => {
    expect(
      computeInboxDeliveryProgress(10, [
        { sequence: 12, delivered: true },
        { sequence: 11, delivered: true },
      ]),
    ).toEqual({ lastSequence: 12, hadDeliveryFailure: false });
  });

  it("does not advance past a delivery failure", () => {
    expect(
      computeInboxDeliveryProgress(10, [
        { sequence: 11, delivered: true },
        { sequence: 12, delivered: false },
        { sequence: 13, delivered: true },
      ]),
    ).toEqual({ lastSequence: 11, hadDeliveryFailure: true });
  });

  it("does not advance across a sequence gap", () => {
    expect(
      computeInboxDeliveryProgress(10, [
        { sequence: 11, delivered: true },
        { sequence: 13, delivered: true },
      ]),
    ).toEqual({ lastSequence: 11, hadDeliveryFailure: true });
  });

  it("advances nothing when the remote ack was partial or failed", () => {
    expect(
      computeInboxDeliveryProgress(
        10,
        [
          { sequence: 11, delivered: true },
          { sequence: 12, delivered: true },
        ],
        false,
      ),
    ).toEqual({ lastSequence: 10, hadDeliveryFailure: true });

    expect(computeInboxDeliveryProgress(10, [{ sequence: 10, delivered: true }], false)).toEqual({
      lastSequence: 10,
      hadDeliveryFailure: true,
    });
    expect(computeInboxDeliveryProgress(10, [], false)).toEqual({
      lastSequence: 10,
      hadDeliveryFailure: true,
    });
  });
});

describe("inbox runner pending lease recovery", () => {
  it("does not commit generation or retain ETag when a pending pulse polls an empty batch", async () => {
    writeCloudCredentials(makeCredentials());
    const requestHeaders: Headers[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/cli/inbox/subscriptions/global") {
        return jsonResponse({ subscription: makeSubscription() });
      }
      if (url.pathname === "/api/cli/inbox/pulse") {
        requestHeaders.push(new Headers(init?.headers));
        return jsonResponse(
          {
            version: 1,
            changed: true,
            subscribed: true,
            subscription: makeSubscription(),
            watermark: {
              organizationId: "org_1",
              generation: 7,
              latestSequence: 1,
              latestItemAt: "2026-07-21T12:00:00.000Z",
              cacheKey: "generation:7",
              updatedAt: "2026-07-21T12:00:00.000Z",
            },
          },
          { ETag: '"generation-7"' },
        );
      }
      if (url.pathname === "/api/cli/inbox/poll") {
        return jsonResponse({
          version: 1,
          hasMore: false,
          items: [],
          leaseId: "lease_1",
          leaseSeconds: 60,
          pollId: "poll_1",
          serverTime: "2026-07-21T12:00:00.000Z",
          subscription: makeSubscription(),
        });
      }
      throw new Error(`Unexpected inbox request: ${url.pathname}`);
    }) as unknown as typeof fetch;

    const runner = new InboxRunner();
    await runner.tickOnce();
    expect(getSubscriptionByOrg("https://console.ravi.bot", "org_1")).toMatchObject({
      lastGeneration: null,
      lastSequence: 0,
    });

    await runner.tickOnce();
    expect(requestHeaders).toHaveLength(2);
    expect(requestHeaders[1]?.has("If-None-Match")).toBe(false);
    expect(getSubscriptionByOrg("https://console.ravi.bot", "org_1")?.lastGeneration).toBeNull();
  });

  it("continues a multi-batch watermark without committing generation or reusing its ETag", async () => {
    writeCloudCredentials(makeCredentials());
    const requestHeaders: Headers[] = [];
    let pulseAttempts = 0;
    let pollAttempts = 0;
    let ackAttempts = 0;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/cli/inbox/subscriptions/global") {
        return jsonResponse({ subscription: makeSubscription() });
      }
      if (url.pathname === "/api/cli/inbox/pulse") {
        requestHeaders.push(new Headers(init?.headers));
        pulseAttempts += 1;
        return jsonResponse(
          makePendingPulse({
            latestSequence: 2,
            subscription: makeSubscription({ lastDeliveredSequence: pulseAttempts - 1 }),
          }),
          { ETag: '"generation-7"' },
        );
      }
      if (url.pathname === "/api/cli/inbox/poll") {
        pollAttempts += 1;
        return jsonResponse(
          makePoll({
            hasMore: pollAttempts === 1,
            items: [makeInboxItem(pollAttempts)],
            subscription: makeSubscription({ lastDeliveredSequence: pollAttempts - 1 }),
          }),
        );
      }
      if (url.pathname === "/api/cli/inbox/ack") {
        ackAttempts += 1;
        return jsonResponse({ acked: 1 });
      }
      throw new Error(`Unexpected inbox request: ${url.pathname}`);
    }) as unknown as typeof fetch;

    const runner = new InboxRunner({
      nats: { publish: async () => {}, flush: async () => {} },
    });
    await runner.tickOnce();

    expect(getSubscriptionByOrg("https://console.ravi.bot", "org_1")).toMatchObject({
      lastGeneration: null,
      lastSequence: 1,
    });

    await runner.tickOnce();

    expect(pulseAttempts).toBe(2);
    expect(pollAttempts).toBe(2);
    expect(ackAttempts).toBe(2);
    expect(requestHeaders[1]?.has("If-None-Match")).toBe(false);
    expect(requestHeaders[1]?.has("X-Ravi-Inbox-Generation")).toBe(false);
    expect(requestHeaders[1]?.get("X-Ravi-Inbox-Last-Delivered-Sequence")).toBe("1");
    expect(getSubscriptionByOrg("https://console.ravi.bot", "org_1")).toMatchObject({
      lastGeneration: 7,
      lastSequence: 2,
    });
  });

  it("heals a delivered row from an advanced Console cursor after a partial ack response", async () => {
    writeCloudCredentials(makeCredentials());
    const actions: string[] = [];
    let pulseAttempts = 0;
    let ackAttempts = 0;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/cli/inbox/subscriptions/global") {
        return jsonResponse({ subscription: makeSubscription() });
      }
      if (url.pathname === "/api/cli/inbox/pulse") {
        pulseAttempts += 1;
        return jsonResponse(
          makePendingPulse({
            changed: pulseAttempts === 1,
            latestSequence: 1,
            subscription: makeSubscription({ lastDeliveredSequence: pulseAttempts === 1 ? 0 : 1 }),
          }),
          { ETag: '"generation-7"' },
        );
      }
      if (url.pathname === "/api/cli/inbox/poll") {
        return jsonResponse(makePoll({ items: [makeInboxItem(1)] }));
      }
      if (url.pathname === "/api/cli/inbox/ack") {
        ackAttempts += 1;
        const row = getItemByItemId("https://console.ravi.bot", "org_1", "item_1");
        expect(row?.deliveredAt).not.toBeNull();
        expect(row?.ackedAt).toBeNull();
        actions.push("delivered");
        actions.push("ack");
        // Model a response lost/under-counted after Console advanced its
        // authoritative cursor. The next pulse must heal the local mirror.
        return jsonResponse({ acked: 0 });
      }
      throw new Error(`Unexpected inbox request: ${url.pathname}`);
    }) as unknown as typeof fetch;

    const runner = new InboxRunner({
      nats: {
        publish: async () => {
          const row = getItemByItemId("https://console.ravi.bot", "org_1", "item_1");
          expect(row).not.toBeNull();
          expect(row?.deliveredAt).toBeNull();
          actions.push("persist");
          actions.push("publish");
        },
        flush: async () => {
          expect(getItemByItemId("https://console.ravi.bot", "org_1", "item_1")?.deliveredAt).toBeNull();
          actions.push("flush");
        },
      },
    });

    await runner.tickOnce();
    expect(actions).toEqual(["persist", "publish", "flush", "delivered", "ack"]);
    expect(ackAttempts).toBe(1);
    expect(countPendingItems({ consoleUrl: "https://console.ravi.bot", organizationId: "org_1" })).toEqual({
      undelivered: 0,
      unacked: 1,
    });
    expect(getSubscriptionByOrg("https://console.ravi.bot", "org_1")).toMatchObject({
      lastGeneration: null,
      lastSequence: 0,
    });

    await runner.tickOnce();
    expect(countPendingItems({ consoleUrl: "https://console.ravi.bot", organizationId: "org_1" })).toEqual({
      undelivered: 0,
      unacked: 0,
    });
    expect(getSubscriptionByOrg("https://console.ravi.bot", "org_1")).toMatchObject({
      lastGeneration: 7,
      lastSequence: 1,
    });
  });

  it("retries only the ack for an already-delivered item without rewriting or enriching it", async () => {
    writeCloudCredentials(makeCredentials());
    seedExistingSubscription({ subscriptionId: "sub_1", generation: 6, sequence: 10 });
    const preservedPayload = JSON.stringify({ exact: "published-envelope", delivery: { pollId: "original" } });
    const existing = upsertDeliveredItem({
      consoleUrl: "https://console.ravi.bot",
      organizationId: "org_1",
      subscriptionId: "original_subscription",
      itemId: "item_11",
      sequence: 11,
      eventType: "mail.message.received",
      category: "mail",
      severity: "info",
      dedupeKey: "original_dedupe",
      natsSubject: "ravi.console.inbox.item",
      natsPayloadJson: preservedPayload,
      deliveredAt: 123_456,
    }).row;
    let ackAttempts = 0;
    let publishAttempts = 0;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/cli/inbox/pulse") {
        return jsonResponse(
          makePendingPulse({
            latestSequence: 11,
            subscription: makeSubscription({ lastDeliveredSequence: 10 }),
          }),
        );
      }
      if (url.pathname === "/api/cli/inbox/poll") {
        return jsonResponse(
          makePoll({
            items: [
              makeInboxItem(11, {
                eventType: "mail.message.received",
                category: "mail",
                dedupeKey: "retry_dedupe",
              }),
            ],
            subscription: makeSubscription({ lastDeliveredSequence: 10 }),
          }),
        );
      }
      if (url.pathname === "/api/cli/inbox/ack") {
        ackAttempts += 1;
        return jsonResponse({ acked: 1 });
      }
      throw new Error(`Unexpected inbox request: ${url.pathname}`);
    }) as unknown as typeof fetch;

    const enrich = mock(async () => {
      throw new Error("enrichment must not run for ack-only retry");
    });
    const runner = new InboxRunner({
      nats: {
        publish: async () => {
          publishAttempts += 1;
        },
        flush: async () => {},
      },
    });
    Object.defineProperty(runner, "enrichLocalPayload", { value: enrich });

    await runner.tickOnce();

    expect(enrich).not.toHaveBeenCalled();
    expect(publishAttempts).toBe(0);
    expect(ackAttempts).toBe(1);
    expect(getItemByItemId("https://console.ravi.bot", "org_1", "item_11")).toMatchObject({
      id: existing.id,
      subscriptionId: "original_subscription",
      dedupeKey: "original_dedupe",
      natsPayloadJson: preservedPayload,
      deliveredAt: 123_456,
    });
  });

  it("coalesces concurrent tickOnce calls on the same runner instance", async () => {
    writeCloudCredentials(makeCredentials());
    let subscriptionAttempts = 0;
    let pulseAttempts = 0;
    let signalPulseStarted!: () => void;
    let completePulse!: (response: Response) => void;
    const pulseStarted = new Promise<void>((resolve) => {
      signalPulseStarted = resolve;
    });
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/cli/inbox/subscriptions/global") {
        subscriptionAttempts += 1;
        return jsonResponse({ subscription: makeSubscription() });
      }
      if (url.pathname === "/api/cli/inbox/pulse") {
        pulseAttempts += 1;
        signalPulseStarted();
        return await new Promise<Response>((resolve) => {
          completePulse = resolve;
        });
      }
      throw new Error(`Unexpected inbox request: ${url.pathname}`);
    }) as unknown as typeof fetch;

    const runner = new InboxRunner();
    const first = runner.tickOnce();
    await pulseStarted;
    const second = runner.tickOnce();
    completePulse(
      jsonResponse(
        makePendingPulse({
          changed: false,
          latestSequence: 0,
          subscription: makeSubscription({ lastDeliveredSequence: 0 }),
        }),
      ),
    );
    await Promise.all([first, second]);

    expect(subscriptionAttempts).toBe(1);
    expect(pulseAttempts).toBe(1);
  });

  it("drops a fresh pending ETag when poll throws so the next tick can resume", async () => {
    writeCloudCredentials(makeCredentials());
    const requestHeaders: Headers[] = [];
    let pollAttempts = 0;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/cli/inbox/subscriptions/global") {
        return jsonResponse({ subscription: makeSubscription() });
      }
      if (url.pathname === "/api/cli/inbox/pulse") {
        requestHeaders.push(new Headers(init?.headers));
        return jsonResponse(makePendingPulse(), { ETag: '"generation-7"' });
      }
      if (url.pathname === "/api/cli/inbox/poll") {
        pollAttempts += 1;
        if (pollAttempts === 1) throw new Error("poll transport failed");
        return jsonResponse(makeEmptyPoll());
      }
      throw new Error(`Unexpected inbox request: ${url.pathname}`);
    }) as unknown as typeof fetch;

    const runner = new InboxRunner();
    await runner.tickOnce();
    await runner.tickOnce();

    expect(pollAttempts).toBe(2);
    expect(requestHeaders).toHaveLength(2);
    expect(requestHeaders[0]?.has("If-None-Match")).toBe(false);
    expect(requestHeaders[1]?.has("If-None-Match")).toBe(false);
    expect(getSubscriptionByOrg("https://console.ravi.bot", "org_1")?.lastGeneration).toBeNull();
  });

  it("resets an old cursor when the pulse adopts a different pending subscription", async () => {
    writeCloudCredentials(makeCredentials());
    seedExistingSubscription({ subscriptionId: "sub_old", generation: 6, sequence: 42 });
    const requestHeaders: Headers[] = [];
    let pollAttempts = 0;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/cli/inbox/pulse") {
        requestHeaders.push(new Headers(init?.headers));
        return jsonResponse(
          makePendingPulse({ subscription: makeSubscription({ id: "sub_new", lastDeliveredSequence: 0 }) }),
          { ETag: '"generation-7"' },
        );
      }
      if (url.pathname === "/api/cli/inbox/poll") {
        pollAttempts += 1;
        if (pollAttempts === 1) throw new Error("poll failed after subscription drift");
        return jsonResponse(makeEmptyPoll({ subscription: makeSubscription({ id: "sub_new" }) }));
      }
      throw new Error(`Unexpected inbox request: ${url.pathname}`);
    }) as unknown as typeof fetch;

    const runner = new InboxRunner();
    await runner.tickOnce();
    expect(getSubscriptionByOrg("https://console.ravi.bot", "org_1")).toMatchObject({
      subscriptionId: "sub_new",
      lastGeneration: null,
      lastSequence: null,
    });

    await runner.tickOnce();
    expect(pollAttempts).toBe(2);
    expect(requestHeaders[1]?.has("If-None-Match")).toBe(false);
    expect(requestHeaders[1]?.has("X-Ravi-Inbox-Generation")).toBe(false);
  });

  it("resets the cursor when a missing remote subscription is recreated", async () => {
    writeCloudCredentials(makeCredentials());
    seedExistingSubscription({ subscriptionId: "sub_missing", generation: 6, sequence: 42 });
    const requestHeaders: Headers[] = [];
    let pulseAttempts = 0;
    let pollAttempts = 0;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/cli/inbox/subscriptions/global") {
        return jsonResponse({ subscription: makeSubscription({ id: "sub_recreated" }) });
      }
      if (url.pathname === "/api/cli/inbox/pulse") {
        requestHeaders.push(new Headers(init?.headers));
        pulseAttempts += 1;
        return jsonResponse(
          makePendingPulse({
            subscription: pulseAttempts === 1 ? null : makeSubscription({ id: "sub_recreated" }),
          }),
          { ETag: '"generation-7"' },
        );
      }
      if (url.pathname === "/api/cli/inbox/poll") {
        pollAttempts += 1;
        if (pollAttempts === 1) throw new Error("poll failed after subscription recreation");
        return jsonResponse(makeEmptyPoll({ subscription: makeSubscription({ id: "sub_recreated" }) }));
      }
      throw new Error(`Unexpected inbox request: ${url.pathname}`);
    }) as unknown as typeof fetch;

    const runner = new InboxRunner();
    await runner.tickOnce();
    expect(getSubscriptionByOrg("https://console.ravi.bot", "org_1")).toMatchObject({
      subscriptionId: "sub_recreated",
      lastGeneration: null,
      lastSequence: null,
    });

    await runner.tickOnce();
    expect(pollAttempts).toBe(2);
    expect(requestHeaders[1]?.has("If-None-Match")).toBe(false);
    expect(requestHeaders[1]?.has("X-Ravi-Inbox-Generation")).toBe(false);
  });

  it("does not commit a pulse after poll ownership is lost while the request is in flight", async () => {
    writeCloudCredentials(makeCredentials());
    seedExistingSubscription({ subscriptionId: "sub_1", generation: 6, sequence: 0 });
    let signalPulseStarted!: () => void;
    let completePulse!: (response: Response) => void;
    const pulseStarted = new Promise<void>((resolve) => {
      signalPulseStarted = resolve;
    });

    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/api/cli/inbox/pulse") {
        signalPulseStarted();
        return await new Promise<Response>((resolve) => {
          completePulse = resolve;
        });
      }
      throw new Error(`Unexpected inbox request: ${url.pathname}`);
    }) as unknown as typeof fetch;

    const runner = new InboxRunner();
    const tick = runner.tickOnce();
    await pulseStarted;

    const lockKey = inboxPollLockKey("https://console.ravi.bot", "org_1");
    getDb()
      .prepare(
        `UPDATE console_inbox_poll_locks
         SET owner_id = ?, expires_at = ?
         WHERE lock_key = ?`,
      )
      .run("takeover-runner", Date.now() + 60_000, lockKey);
    completePulse(
      jsonResponse(
        makePendingPulse({
          changed: false,
          generation: 7,
          latestSequence: 0,
          subscription: makeSubscription({ lastDeliveredSequence: 0 }),
        }),
        { ETag: '"generation-7"' },
      ),
    );
    await tick;

    expect(getSubscriptionByOrg("https://console.ravi.bot", "org_1")).toMatchObject({
      lastGeneration: 6,
      lastSequence: 0,
    });
  });
});

describe("inbox ack completeness", () => {
  it("accepts only an exact full ack", () => {
    expect(isCompleteInboxAck({ acked: 2 }, 2)).toBe(true);
    expect(isCompleteInboxAck({ acked: 1 }, 2)).toBe(false);
    expect(isCompleteInboxAck({ acked: 3 }, 2)).toBe(false);
    expect(isCompleteInboxAck({ acked: 0 }, 0)).toBe(false);
  });
});

describe("inbox NATS delivery", () => {
  it("checks the lease before every subject and flushes after canonical and watch publishes", async () => {
    const actions: string[] = [];
    const subjects = await publishInboxNatsEvents(
      {
        payload: makePayload("watch.github.release.published"),
        inboxItemId: 42,
        beforePublish: () => {
          actions.push("lease");
        },
      },
      {
        publish: async (subject, payload) => {
          actions.push(`publish:${subject}`);
          if (subject.startsWith("ravi.watch.")) {
            expect(payload).toMatchObject({
              eventId: "item_1",
              watchId: "watch_1",
              delivery: { inboxItemId: 42 },
            });
          }
        },
        flush: async () => {
          actions.push("flush");
        },
      },
    );

    expect(subjects).toEqual(["ravi.console.inbox.item", "ravi.watch.github.release.published"]);
    expect(actions).toEqual([
      "lease",
      "publish:ravi.console.inbox.item",
      "lease",
      "publish:ravi.watch.github.release.published",
      "flush",
    ]);
  });

  it("publishes only the canonical subject for non-watch items", async () => {
    const actions: string[] = [];
    const subjects = await publishInboxNatsEvents(
      { payload: makePayload("task.created") },
      {
        publish: async (subject) => {
          actions.push(`publish:${subject}`);
        },
        flush: async () => {
          actions.push("flush");
        },
      },
    );

    expect(subjects).toEqual(["ravi.console.inbox.item"]);
    expect(actions).toEqual(["publish:ravi.console.inbox.item", "flush"]);
  });

  it("does not resolve delivery when the NATS flush fails", async () => {
    expect(
      publishInboxNatsEvents(
        { payload: makePayload("task.created") },
        {
          publish: async () => {},
          flush: async () => {
            throw new Error("flush failed");
          },
        },
      ),
    ).rejects.toThrow("flush failed");
  });

  it("stops before a watch publish when the lease check fails", async () => {
    const actions: string[] = [];
    let checks = 0;

    expect(
      publishInboxNatsEvents(
        {
          payload: makePayload("watch.github.release.published"),
          beforePublish: () => {
            checks += 1;
            actions.push("lease");
            if (checks === 2) throw new Error("lease lost");
          },
        },
        {
          publish: async (subject) => {
            actions.push(`publish:${subject}`);
          },
          flush: async () => {
            actions.push("flush");
          },
        },
      ),
    ).rejects.toThrow("lease lost");
    expect(actions).toEqual(["lease", "publish:ravi.console.inbox.item", "lease"]);
  });
});

function makePayload(eventType: string): InboxNatsPayload {
  return {
    version: 1,
    eventId: "item_1",
    sequence: 11,
    dedupeKey: "dedupe_1",
    eventType,
    category: "source_control",
    severity: "info",
    sensitivity: "private",
    title: "Release published",
    summary: "v1.0.0",
    organization: { id: "org_1" },
    project: { id: "project_1" },
    source: { type: "github", id: "repo_1" },
    actor: { type: "user", id: "user_1" },
    target: { type: "release", id: "release_1" },
    payload: {
      watch: { id: "watch_1", placement: "console" },
      tag: "v1.0.0",
    },
    links: [{ label: "release", url: "https://example.com/release" }],
    delivery: {
      subscriptionId: "sub_1",
      installationId: "ins_1",
      pollId: "poll_1",
      leaseId: "lease_1",
      localDeliveredAt: "2026-07-21T12:00:00.000Z",
    },
    occurredAt: "2026-07-21T11:59:00.000Z",
    createdAt: "2026-07-21T12:00:00.000Z",
  };
}

function makeCredentials() {
  const now = "2026-07-21T12:00:00.000Z";
  return {
    version: 1 as const,
    consoleUrl: "https://console.ravi.bot",
    installationId: "ins_1",
    accessToken: "access-test",
    refreshToken: "refresh-test",
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scopes: ["console.inbox.read", "console.inbox.subscribe", "console.inbox.deliver", "console.inbox.ack"],
    organization: { id: "org_1" },
    user: { id: "user_1" },
    createdAt: now,
    updatedAt: now,
  };
}

function makeSubscription(
  overrides: Partial<ReturnType<typeof makeSubscriptionBase>> = {},
): ReturnType<typeof makeSubscriptionBase> {
  return { ...makeSubscriptionBase(), ...overrides };
}

function makeSubscriptionBase() {
  return {
    id: "sub_1",
    deliveryMode: "pull",
    lastDeliveredSequence: 0,
    lastPollAt: null,
    localInstallationId: "ins_1",
    name: "global",
    status: "active",
  };
}

function makePendingPulse(
  overrides: {
    subscription?: ReturnType<typeof makeSubscription> | null;
    changed?: boolean;
    generation?: number;
    latestSequence?: number;
  } = {},
) {
  const generation = overrides.generation ?? 7;
  return {
    version: 1,
    changed: overrides.changed ?? true,
    subscribed: true,
    subscription: overrides.subscription === undefined ? makeSubscription() : overrides.subscription,
    watermark: {
      organizationId: "org_1",
      generation,
      latestSequence: overrides.latestSequence ?? 1,
      latestItemAt: "2026-07-21T12:00:00.000Z",
      cacheKey: `generation:${generation}`,
      updatedAt: "2026-07-21T12:00:00.000Z",
    },
  };
}

function makeEmptyPoll(overrides: { subscription?: ReturnType<typeof makeSubscription> } = {}) {
  return {
    version: 1,
    hasMore: false,
    items: [],
    leaseId: "lease_1",
    leaseSeconds: 60,
    pollId: "poll_1",
    serverTime: "2026-07-21T12:00:00.000Z",
    subscription: overrides.subscription ?? makeSubscription(),
  };
}

function makePoll(
  overrides: { hasMore?: boolean; items?: ConsoleInboxItem[]; subscription?: ReturnType<typeof makeSubscription> } = {},
) {
  return {
    ...makeEmptyPoll({ subscription: overrides.subscription }),
    hasMore: overrides.hasMore ?? false,
    items: overrides.items ?? [],
  };
}

function makeInboxItem(sequence: number, overrides: Partial<ConsoleInboxItem> = {}): ConsoleInboxItem {
  return {
    id: `delivery_${sequence}`,
    itemId: `item_${sequence}`,
    sequence,
    dedupeKey: `dedupe_${sequence}`,
    eventType: "task.created",
    category: "task",
    severity: "info",
    sensitivity: "private",
    title: `Task ${sequence}`,
    summary: null,
    source: { type: "console", id: `source_${sequence}` },
    actor: { type: "user", id: "user_1" },
    target: { type: "task", id: `task_${sequence}` },
    organization: { id: "org_1" },
    project: null,
    payload: null,
    links: null,
    occurredAt: "2026-07-21T11:59:00.000Z",
    createdAt: "2026-07-21T12:00:00.000Z",
    lease: {
      expiresAt: "2026-07-21T12:01:00.000Z",
      id: `lease_${sequence}`,
      seconds: 60,
    },
    ...overrides,
  };
}

function seedExistingSubscription(input: { subscriptionId: string; generation: number; sequence: number }): void {
  const row = ensureSubscriptionRow({
    consoleUrl: "https://console.ravi.bot",
    organizationId: "org_1",
    installationId: "ins_1",
  });
  updateSubscriptionRemoteId(row.id, input.subscriptionId);
  markSubscriptionPolled(row.id, {
    generation: input.generation,
    lastSequence: input.sequence,
    success: true,
    status: "active",
  });
}

function jsonResponse(
  payload: unknown,
  headers?: Headers | Record<string, string> | Array<[string, string]>,
): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}
