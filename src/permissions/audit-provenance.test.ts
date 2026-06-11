import { describe, expect, it } from "bun:test";
import { buildAuditContextProvenance } from "./audit-provenance.js";

describe("audit context provenance", () => {
  it("preserves serialized turn capabilities for denial explanation", () => {
    const provenance = buildAuditContextProvenance({
      context: {
        contextId: "ctx_1",
        contextKey: "key_1",
        kind: "turn-runtime",
        agentId: "reviewer",
        capabilities: [],
        metadata: {
          authorityMode: "delegated",
          turnCapabilityCount: 1,
          turnCapabilities: [
            {
              permission: "execute",
              objectType: "group",
              objectId: "observer_report",
              source: "observer-rule",
            },
          ],
        },
        createdAt: 1,
      },
    });

    expect(provenance?.turnCapabilities).toEqual([
      {
        permission: "execute",
        objectType: "group",
        objectId: "observer_report",
        source: "observer-rule",
      },
    ]);
  });
});
