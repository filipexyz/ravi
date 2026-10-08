import { describe, expect, it } from "bun:test";
import { publishInboxNatsEvents } from "../inbox/inbox-runner.js";
import { INBOX_NATS_SUBJECT, type InboxNatsPayload } from "../inbox/types.js";

// Bases row events reach the runtime through the existing inbox bridge. The
// runner forwards the Console item unchanged and derives no extra subject.
describe("Bases events on the inbox bridge", () => {
  it("publishes a bases item only on ravi.console.inbox.item, unchanged", async () => {
    const published: Array<{ subject: string; payload: Record<string, unknown> }> = [];
    const payload = makeBasesPayload();
    const snapshot = structuredClone(payload);

    const subjects = await publishInboxNatsEvents(
      { payload, inboxItemId: 9 },
      {
        publish: async (subject, data) => {
          published.push({ subject, payload: data });
        },
        flush: async () => {},
      },
    );

    expect(INBOX_NATS_SUBJECT).toBe("ravi.console.inbox.item");
    expect(subjects).toEqual([INBOX_NATS_SUBJECT]);
    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toEqual(snapshot as unknown as Record<string, unknown>);
    expect(published[0]?.payload).toMatchObject({ category: "bases", eventType: "bases.row.updated" });
  });
});

function makeBasesPayload(): InboxNatsPayload {
  return {
    version: 1,
    eventId: "evt_1",
    sequence: 3,
    dedupeKey: "bases:row:row_1:v4:updated:ins_1",
    eventType: "bases.row.updated",
    category: "bases",
    severity: "info",
    sensitivity: "metadata",
    title: null,
    summary: null,
    organization: { id: "org_1" },
    project: { id: "project_1" },
    source: { type: "base", id: "base_1" },
    actor: { type: "user", id: "user_1" },
    target: { type: "base_row", id: "row_1" },
    payload: {
      baseId: "base_1",
      baseSlug: "crm",
      projectId: "project_1",
      rowId: "row_1",
      version: 4,
      schemaVersion: 2,
      changedPropertyCount: 1,
      surface: "console",
    },
    links: null,
    delivery: {
      subscriptionId: "sub_1",
      installationId: "ins_1",
      pollId: "poll_1",
      leaseId: "lease_1",
      localDeliveredAt: "2026-10-06T12:00:00.000Z",
    },
    occurredAt: "2026-10-06T11:59:00.000Z",
    createdAt: "2026-10-06T12:00:00.000Z",
  };
}
