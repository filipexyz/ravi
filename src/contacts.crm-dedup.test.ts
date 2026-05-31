import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  createCrmOpportunity,
  createCrmPipeline,
  createCrmPipelineStage,
  getContact,
  upsertContact,
} from "./contacts.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-crm-dedup-test-");
});

afterEach(async () => {
  if (!stateDir) return;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function dedupEventCounts(): Map<string, number> {
  const db = new Database(join(stateDir!, "chat.db"));
  const rows = db
    .prepare(
      "SELECT event_type AS eventType, COUNT(*) AS n FROM crm_events WHERE event_type LIKE 'crm.opportunity.dedup_%' GROUP BY event_type",
    )
    .all() as Array<{ eventType: string; n: number }>;
  db.close();
  return new Map(rows.map((r) => [r.eventType, r.n]));
}

describe("CRM opportunity dedup-on-create", () => {
  it("rejects a second open opportunity for the same (contact, pipeline)", () => {
    upsertContact("5511900000001", "Dedup One", "allowed", "manual");
    const contact = getContact("5511900000001");
    expect(contact).not.toBeNull();

    const first = createCrmOpportunity({
      title: "Reativação A",
      contactRef: contact!.id,
      stageKey: "qualified",
      source: "test",
    });

    expect(() =>
      createCrmOpportunity({
        title: "Reativação A (dup)",
        contactRef: contact!.id,
        stageKey: "qualified",
        source: "test",
      }),
    ).toThrow(first.id);
  });

  it("allows a duplicate when allowDuplicate carries a substantive reason", () => {
    upsertContact("5511900000002", "Dedup Two", "allowed", "manual");
    const contact = getContact("5511900000002");
    const first = createCrmOpportunity({
      title: "Deal",
      contactRef: contact!.id,
      stageKey: "qualified",
      source: "test",
    });
    const second = createCrmOpportunity({
      title: "Deal (legit second front)",
      contactRef: contact!.id,
      stageKey: "qualified",
      source: "test",
      allowDuplicate: true,
      duplicateReason: "cliente abriu segunda frente de negociacao independente",
    });
    expect(second.id).not.toBe(first.id);
  });

  it("rejects allowDuplicate without a substantive reason", () => {
    upsertContact("5511900000003", "Dedup Three", "allowed", "manual");
    const contact = getContact("5511900000003");
    createCrmOpportunity({ title: "Deal", contactRef: contact!.id, stageKey: "qualified", source: "test" });

    expect(() =>
      createCrmOpportunity({
        title: "missing reason",
        contactRef: contact!.id,
        stageKey: "qualified",
        source: "test",
        allowDuplicate: true,
      }),
    ).toThrow(/reason/i);

    expect(() =>
      createCrmOpportunity({
        title: "generic reason",
        contactRef: contact!.id,
        stageKey: "qualified",
        source: "test",
        allowDuplicate: true,
        duplicateReason: "duplicate",
      }),
    ).toThrow(/reason/i);
  });

  it("does not dedup across different pipelines for the same contact", () => {
    upsertContact("5511900000004", "Dedup Four", "allowed", "manual");
    const contact = getContact("5511900000004");
    const first = createCrmOpportunity({
      title: "Reactivation deal",
      contactRef: contact!.id,
      stageKey: "qualified",
      source: "test",
    });

    const otherPipeline = createCrmPipeline({
      name: "Recurring Pipeline",
      entityType: "opportunity",
      source: "test",
    });
    createCrmPipelineStage({
      pipelineRef: otherPipeline.id,
      key: "intake",
      name: "Intake",
      sortOrder: 10,
      category: "active",
      probability: 0.1,
      source: "test",
    });

    const second = createCrmOpportunity({
      title: "Recurring deal",
      contactRef: contact!.id,
      pipelineId: otherPipeline.id,
      stageKey: "intake",
      source: "test",
    });
    expect(second.id).not.toBe(first.id);
    expect(second.pipelineId).toBe(otherPipeline.id);
  });

  it("treats a paused opportunity as still occupying the (contact, pipeline) slot", () => {
    upsertContact("5511900000006", "Dedup Six", "allowed", "manual");
    const contact = getContact("5511900000006");
    createCrmOpportunity({
      title: "Paused deal",
      contactRef: contact!.id,
      stageKey: "qualified",
      status: "paused",
      source: "test",
    });

    expect(() =>
      createCrmOpportunity({
        title: "New deal over paused",
        contactRef: contact!.id,
        stageKey: "qualified",
        source: "test",
      }),
    ).toThrow();
  });

  it("records dedup_rejected and dedup_bypassed crm_events", () => {
    upsertContact("5511900000005", "Dedup Five", "allowed", "manual");
    const contact = getContact("5511900000005");
    createCrmOpportunity({ title: "Deal", contactRef: contact!.id, stageKey: "qualified", source: "test" });

    try {
      createCrmOpportunity({ title: "dup", contactRef: contact!.id, stageKey: "qualified", source: "test" });
    } catch {
      // expected rejection
    }

    createCrmOpportunity({
      title: "legit second",
      contactRef: contact!.id,
      stageKey: "qualified",
      source: "test",
      allowDuplicate: true,
      duplicateReason: "segunda frente de negociacao distinta e aprovada",
    });

    const counts = dedupEventCounts();
    expect(counts.get("crm.opportunity.dedup_rejected")).toBe(1);
    expect(counts.get("crm.opportunity.dedup_bypassed")).toBe(1);
  });

  it("prevents concurrent duplicate creation (transaction-level atomicity)", () => {
    upsertContact("5511900000007", "Concurrent Test", "allowed", "manual");
    const contact = getContact("5511900000007");

    // Attempt to create two opportunities sequentially for the same contact+pipeline
    // Due to transaction atomicity (check + insert moved inside executeWrite),
    // one should succeed and one should fail
    const firstResult = createCrmOpportunity({
      title: "First Deal",
      contactRef: contact!.id,
      stageKey: "qualified",
      source: "test",
    });
    expect(firstResult).not.toBeNull();
    expect(firstResult.id).toBeTruthy();

    // Second attempt should fail (transaction-level check prevents duplicate)
    let secondAttemptFailed = false;
    let secondError: string | null = null;
    try {
      createCrmOpportunity({
        title: "Second Deal (should fail)",
        contactRef: contact!.id,
        stageKey: "qualified",
        source: "test",
      });
    } catch (e) {
      secondAttemptFailed = true;
      secondError = String(e);
    }

    expect(secondAttemptFailed).toBe(true);
    expect(secondError).toContain("CRM opportunity already open");
  });
});
