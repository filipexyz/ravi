import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { getItemById, publishInboxNatsEvents, upsertDeliveredItem, type InboxNatsPayload } from "../../inbox/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { runWithContext } from "../context.js";
import { getCommandAccessMetadata } from "../decorators.js";
import { InboxCommands } from "./inbox.js";

let stateDir: string | null = null;

describe("inbox replay", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-inbox-replay-test-");
    spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    mock.restore();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("uses the delivery publisher and increments replay count only after flush", async () => {
    const row = seedWatchItem();
    const actions: string[] = [];
    const command = new InboxCommands({
      publishInboxNatsEvents: (input) =>
        publishInboxNatsEvents(input, {
          publish: async (subject, payload) => {
            actions.push(`publish:${subject}`);
            if (subject === "ravi.console.inbox.item") {
              expect(payload).toMatchObject({
                eventId: "item_1",
                sequence: 11,
                dedupeKey: "dedupe_1",
                eventType: "watch.github.release.published",
                delivery: { replayed: true, replayCount: 1 },
              });
            } else {
              expect(payload).toMatchObject({
                eventId: "item_1",
                watchId: "watch_1",
                eventType: "release.published",
                delivery: { replayed: true, replayCount: 1, inboxItemId: row.id },
              });
            }
          },
          flush: async () => {
            actions.push("flush");
            expect(getItemById(row.id)?.replayCount).toBe(0);
          },
        }),
    });

    const result = await command.replay(String(row.id), true);

    expect(result).toMatchObject({
      ok: true,
      itemId: "item_1",
      sequence: 11,
      subject: "ravi.console.inbox.item",
    });
    expect(actions).toEqual([
      "publish:ravi.console.inbox.item",
      "publish:ravi.watch.github.release.published",
      "flush",
    ]);
    expect(getItemById(row.id)?.replayCount).toBe(1);
  });

  it("does not increment replay count when delivery flush fails", async () => {
    const row = seedWatchItem();
    const command = new InboxCommands({
      publishInboxNatsEvents: (input) =>
        publishInboxNatsEvents(input, {
          publish: async () => {},
          flush: async () => {
            throw new Error("flush failed");
          },
        }),
    });

    expect(command.replay(String(row.id), true)).rejects.toThrow("flush failed");
    expect(getItemById(row.id)?.replayCount).toBe(0);
  });

  it("resolves a unique remote item id from the item's own Console and organization scope", async () => {
    const row = seedWatchItem();
    const command = new InboxCommands({
      publishInboxNatsEvents: async () => ["ravi.console.inbox.item"],
    });

    const result = await command.replay(row.itemId, true);

    expect(result).toMatchObject({ ok: true, itemId: row.itemId, sequence: row.sequence });
    expect(getItemById(row.id)?.replayCount).toBe(1);
  });

  it("fails closed when a remote item id exists in more than one Console organization", async () => {
    seedWatchItem();
    const payload = makePayload();
    upsertDeliveredItem({
      consoleUrl: "https://other-console.ravi.bot",
      organizationId: "org_2",
      subscriptionId: "sub_2",
      itemId: payload.eventId,
      sequence: payload.sequence,
      eventType: payload.eventType,
      category: payload.category,
      severity: payload.severity,
      dedupeKey: payload.dedupeKey,
      natsSubject: "ravi.console.inbox.item",
      natsPayloadJson: JSON.stringify(payload),
      deliveredAt: Date.parse(payload.delivery.localDeliveredAt),
    });
    const command = new InboxCommands();

    await expect(runWithContext({}, () => command.replay(payload.eventId, true))).rejects.toThrow(
      "ambiguous across Console organizations",
    );
  });
});

describe("inbox command access", () => {
  it("classifies poll and replay as mutating operations", () => {
    const access = getCommandAccessMetadata(InboxCommands);
    expect(access.get("poll")).toMatchObject({ kind: "mutate", resource: "inbox", risk: "medium" });
    expect(access.get("replay")).toMatchObject({ kind: "mutate", resource: "inbox", risk: "medium" });
  });
});

function seedWatchItem() {
  const payload = makePayload();
  return upsertDeliveredItem({
    consoleUrl: "https://console.ravi.bot",
    organizationId: "org_1",
    subscriptionId: "sub_1",
    itemId: payload.eventId,
    sequence: payload.sequence,
    eventType: payload.eventType,
    category: payload.category,
    severity: payload.severity,
    dedupeKey: payload.dedupeKey,
    natsSubject: "ravi.console.inbox.item",
    natsPayloadJson: JSON.stringify(payload),
    deliveredAt: Date.parse(payload.delivery.localDeliveredAt),
  }).row;
}

function makePayload(): InboxNatsPayload {
  return {
    version: 1,
    eventId: "item_1",
    sequence: 11,
    dedupeKey: "dedupe_1",
    eventType: "watch.github.release.published",
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
    payload: { watch: { id: "watch_1", placement: "console" } },
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
