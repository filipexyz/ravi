import { describe, expect, test } from "bun:test";

import { buildKnowledgeUsageEvent, recordKnowledgeUsage } from "./usage";

describe("knowledge usage", () => {
  test("builds a meter-only event with a stable idempotency key", () => {
    const event = buildKnowledgeUsageEvent({
      organizationId: "org-1",
      projectId: "project-1",
      metricKey: "knowledge.searches",
      eventType: "knowledge.search_completed",
      id: "run-1",
      quantity: 1,
      requestId: "req-1",
      dimensions: { audience: "operator" },
    });
    expect(event).toMatchObject({
      organizationId: "org-1",
      projectId: "project-1",
      source: "knowledge",
      eventType: "knowledge.search_completed",
      metricKey: "knowledge.searches",
      quantity: "1",
      unit: "count",
      dimensionsJson: { service: "knowledge", audience: "operator" },
      idempotencyKey: "knowledge.search_completed:run-1:knowledge.searches",
      requestId: "req-1",
    });
  });

  test("chunks stored counts the chunks inserted", () => {
    const event = buildKnowledgeUsageEvent({
      organizationId: "org-1",
      projectId: null,
      metricKey: "knowledge.chunks_stored",
      eventType: "knowledge.document_ingested",
      id: "doc-1",
      quantity: 7,
      requestId: "req-1",
    });
    expect(event.quantity).toBe("7");
    expect(event.idempotencyKey).toBe("knowledge.document_ingested:doc-1:knowledge.chunks_stored");
  });

  test("records nothing for an empty batch", async () => {
    let called = false;
    await recordKnowledgeUsage([], {
      insert: (() => {
        called = true;
        throw new Error("unexpected");
      }) as never,
    });
    expect(called).toBe(false);
  });
});
