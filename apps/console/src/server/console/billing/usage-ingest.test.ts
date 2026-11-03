import { describe, expect, test } from "bun:test";

import { normalizeUsageEvents, UsageIngestValidationError } from "./usage-ingest";

const orgId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";

describe("usage ingest validation", () => {
  test("accepts provider-neutral worker usage events", () => {
    const events = normalizeUsageEvents({
      events: [
        {
          organizationId: orgId,
          projectId,
          source: "pages_worker",
          eventType: "pages.request_served",
          metricKey: "pages.requests.public",
          quantity: 1,
          unit: "count",
          dimensionsJson: {
            service: "pages",
            host: "demo.ravi.page",
            requestPath: "/",
          },
          measurementsJson: {
            statusCode: 200,
          },
          evidenceJson: {
            resolver: "edge_manifest",
          },
          metadataJson: {},
          idempotencyKey: "req_1:request",
        },
      ],
    }, "req_1");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: orgId,
      projectId,
      source: "pages_worker",
      metricKey: "pages.requests.public",
      quantity: "1",
      requestId: "req_1",
    });
  });

  test("rejects provider details and raw object keys case-insensitively", () => {
    expect(() =>
      normalizeUsageEvents({
        events: [
          {
            organizationId: orgId,
            source: "pages_worker",
            eventType: "pages.bytes_served",
            metricKey: "pages.bytes_served",
            quantity: 100,
            unit: "bytes",
            dimensionsJson: { R2Key: "org/raw/key" },
          },
        ],
      }, "req_2"),
    ).toThrow(UsageIngestValidationError);
  });

  test("rejects Console-owned publish metrics on the worker ingest endpoint", () => {
    expect(() =>
      normalizeUsageEvents({
        events: [
          {
            organizationId: orgId,
            source: "pages_worker",
            eventType: "pages.asset_stored",
            metricKey: "pages.asset.bytes_stored",
            quantity: 100,
            unit: "bytes",
          },
        ],
      }, "req_4"),
    ).toThrow(UsageIngestValidationError);
  });

  test("rejects unknown metrics", () => {
    expect(() =>
      normalizeUsageEvents({
        events: [
          {
            organizationId: orgId,
            source: "pages_worker",
            eventType: "pages.request_served",
            metricKey: "provider.requests",
            quantity: 1,
            unit: "count",
          },
        ],
      }, "req_3"),
    ).toThrow(UsageIngestValidationError);
  });
});
