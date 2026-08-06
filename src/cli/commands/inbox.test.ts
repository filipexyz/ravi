import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  getItemById,
  publishInboxNatsEvents,
  upsertDeliveredItem,
  upsertLocalInboxItem,
  type InboxNatsPayload,
} from "../../inbox/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
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

    const result = await command.replay(String(row.id), true, true);

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

    expect(command.replay(String(row.id), true, true)).rejects.toThrow("flush failed");
    expect(getItemById(row.id)?.replayCount).toBe(0);
  });

  it("resolves a unique remote item id from the item's own Console and organization scope", async () => {
    const row = seedWatchItem();
    const command = new InboxCommands({
      publishInboxNatsEvents: async () => ["ravi.console.inbox.item"],
    });

    const result = await command.replay(row.itemId, true, true);

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

// ---------------------------------------------------------------------------
// Agent-first contract (Manual v2): write brake on replay, INBOX_ITEM_NOT_FOUND
// envelopes and compact --fields mode. `runWithContext({}, ...)` makes
// hasContext() true so the contract helpers throw ContractError instead of
// exiting the process.
// ---------------------------------------------------------------------------

describe("inbox agent-first contract", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-inbox-contract-test-");
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    mock.restore();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  async function expectContractError(
    run: () => Promise<unknown> | unknown,
    code: string,
    exitCode: number,
  ): Promise<InstanceType<typeof ContractError>> {
    let caught: unknown;
    try {
      await runWithContext({}, () => run());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContractError);
    const contractError = caught as InstanceType<typeof ContractError>;
    expect(contractError.code).toBe(code);
    expect(contractError.exitCode).toBe(exitCode);
    return contractError;
  }

  it("replay without --execute is a dry-run: exit 3, no publish, replay count unchanged", async () => {
    const row = seedWatchItem();
    const publishCalls: string[] = [];
    const command = new InboxCommands({
      publishInboxNatsEvents: async () => {
        publishCalls.push("publish");
        return ["ravi.console.inbox.item"];
      },
    });

    const error = await expectContractError(
      () => command.replay(String(row.id), true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      ref: String(row.id),
      itemId: row.itemId,
      sequence: row.sequence,
      subject: "ravi.console.inbox.item",
      nextReplayCount: 1,
    });
    expect(publishCalls).toHaveLength(0);
    expect(getItemById(row.id)?.replayCount).toBe(0);
  });

  it("replay on an unknown ref exits 1 with INBOX_ITEM_NOT_FOUND before the brake, with mirror suggestions", async () => {
    const row = seedWatchItem();
    const publishCalls: string[] = [];
    const command = new InboxCommands({
      publishInboxNatsEvents: async () => {
        publishCalls.push("publish");
        return ["ravi.console.inbox.item"];
      },
    });

    const error = await expectContractError(() => command.replay("999", true, undefined), "INBOX_ITEM_NOT_FOUND", 1);

    expect(error.details.suggestions).toContain(row.itemId);
    expect(error.details.suggestedAction).toContain("ravi inbox items");
    expect(publishCalls).toHaveLength(0);
  });

  it("read on an unknown local item exits 1 with INBOX_ITEM_NOT_FOUND", async () => {
    const command = new InboxCommands();
    const error = await expectContractError(() => command.read("li_missing", true), "INBOX_ITEM_NOT_FOUND", 1);
    expect(error.details.suggestedAction).toContain("ravi inbox list");
  });

  it("done on an unknown local item exits 1 with INBOX_ITEM_NOT_FOUND and suggestions from the local list", async () => {
    const seeded = upsertLocalInboxItem({
      sourceDomain: "mail",
      sourceType: "mail_message",
      sourceId: "msg_1",
      dedupeKey: "mail:msg_1",
      title: "Fatura de julho",
    });
    const command = new InboxCommands();

    const error = await expectContractError(() => command.done("li_missing", true), "INBOX_ITEM_NOT_FOUND", 1);
    expect(error.details.suggestions).toContain(seeded.item.id);
  });

  it("list --fields narrows each local item to the requested fields", async () => {
    upsertLocalInboxItem({
      sourceDomain: "mail",
      sourceType: "mail_message",
      sourceId: "msg_1",
      dedupeKey: "mail:msg_1",
      title: "Fatura de julho",
    });
    const command = new InboxCommands();

    const payload = await runWithContext({}, () =>
      command.list(undefined, undefined, undefined, undefined, undefined, true, "id,status"),
    );

    expect(payload.items).toHaveLength(1);
    for (const item of payload.items as unknown as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["id", "status"]);
    }
  });

  it("items --fields narrows each mirror item to the requested fields", async () => {
    seedWatchItem();
    const command = new InboxCommands();

    const payload = await runWithContext({}, () => command.items(undefined, true, "itemId,sequence"));

    if (!payload) throw new Error("expected an items payload");
    expect(payload.total).toBe(1);
    for (const item of payload.items as unknown as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["itemId", "sequence"]);
    }
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
