import { describe, expect, it } from "bun:test";
import { enrichBasesRowPayload } from "./bases-enrichment.js";
import type { InboxNatsPayload } from "./types.js";

const row = {
  rowId: "row_c1",
  version: 3,
  values: { topic_id: ["row_t1"], text: "oi" },
  body: "long body",
  archivedAt: null,
};

describe("bases row inbox payload enrichment", () => {
  it("adds the row values (no body) read with the item's project, base and row ids", async () => {
    const calls: unknown[] = [];
    const result = await enrichBasesRowPayload(makePayload(), async (input) => {
      calls.push(input);
      return { row, users: {}, idempotentReplay: false } as never;
    });

    expect(calls).toEqual([{ projectId: "proj_1", baseId: "base_1", rowId: "row_c1", includeArchived: false }]);
    expect(result.payload).toEqual({
      ...makePayload().payload,
      row: { rowId: "row_c1", version: 3, values: { topic_id: ["row_t1"], text: "oi" }, archivedAt: null },
      rowEnrichment: { status: "ok" },
    });
  });

  it("reads archived rows for bases.row.archived", async () => {
    let includeArchived: boolean | undefined;
    await enrichBasesRowPayload(makePayload({ eventType: "bases.row.archived" }), async (input) => {
      includeArchived = input.includeArchived;
      return { row, users: {}, idempotentReplay: false } as never;
    });
    expect(includeArchived).toBe(true);
  });

  it("keeps the metadata-only payload and records the failure code when the read fails", async () => {
    const result = await enrichBasesRowPayload(makePayload(), async () => {
      throw Object.assign(new Error("forbidden"), { code: "FORBIDDEN" });
    });
    expect(result.payload).toEqual({
      ...makePayload().payload,
      rowEnrichment: { status: "failed", code: "FORBIDDEN" },
    });
  });

  it("leaves other events, including bulk changes, untouched", async () => {
    const read = async () => {
      throw new Error("must not read");
    };
    const bulk = makePayload({ eventType: "bases.rows.bulk_changed" });
    expect(await enrichBasesRowPayload(bulk, read)).toBe(bulk);
    const mail = makePayload({ eventType: "mail.message.received" });
    expect(await enrichBasesRowPayload(mail, read)).toBe(mail);
  });

  it("does not read without a row reference", async () => {
    const result = await enrichBasesRowPayload(makePayload({ payload: { baseId: "base_1" } }), async () => {
      throw new Error("must not read");
    });
    expect(result.payload?.rowEnrichment).toEqual({ status: "failed", code: "row_ref_missing" });
  });

  it("does not read a row of a project other than the item's", async () => {
    const base = makePayload();
    const result = await enrichBasesRowPayload(
      makePayload({ payload: { ...base.payload, projectId: "proj_other" } }),
      async () => {
        throw new Error("must not read");
      },
    );
    expect(result.payload?.row).toBeUndefined();
    expect(result.payload?.rowEnrichment).toEqual({ status: "failed", code: "row_ref_mismatch" });
  });
});

function makePayload(overrides: Partial<InboxNatsPayload> = {}): InboxNatsPayload {
  return {
    version: 1,
    eventId: "item_1",
    sequence: 1,
    dedupeKey: "bases:row:row_c1:v3:created:ins_1",
    eventType: "bases.row.created",
    category: "bases",
    severity: "info",
    sensitivity: "metadata",
    title: "Base row created",
    summary: null,
    organization: { id: "org_1" },
    project: { id: "proj_1" },
    source: { type: "base_row", id: "row_c1" },
    actor: { type: null, id: null },
    target: { type: "local_installation", id: "ins_1" },
    payload: {
      baseId: "base_1",
      baseSlug: "comentarios",
      projectId: "proj_1",
      rowId: "row_c1",
      version: 3,
      schemaVersion: 2,
      changedPropertyCount: 2,
      surface: "page",
    },
    links: null,
    delivery: {
      subscriptionId: "sub_1",
      installationId: "ins_1",
      pollId: "poll_1",
      leaseId: "lease_1",
      localDeliveredAt: "2026-10-08T12:00:00.000Z",
    },
    occurredAt: "2026-10-08T11:59:00.000Z",
    createdAt: "2026-10-08T11:59:00.000Z",
    ...overrides,
  };
}
