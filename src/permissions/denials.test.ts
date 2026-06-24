import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  flushPermissionAuditEvents,
  listPermissionDenials,
  recordAndEmitPermissionDenial,
  recordPermissionDenial,
  setPermissionAuditPublisherForTest,
} from "./denials.js";

let stateDir: string | null = null;
let auditEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];

describe("permission denials", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-permission-denials-test-");
    auditEvents = [];
    setPermissionAuditPublisherForTest(async (topic, data) => {
      auditEvents.push({ topic, data });
    });
  });

  afterEach(async () => {
    setPermissionAuditPublisherForTest();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("records and lists denied permission checks", () => {
    const denial = recordPermissionDenial({
      subjectType: "agent",
      subjectId: "worker",
      relation: "execute",
      objectType: "group",
      objectId: "contacts",
      agentId: "worker",
      sessionKey: "agent:worker:main",
      sessionName: "worker-main",
      contextId: "ctx_worker",
      reason: "missing capability",
      command: "ravi contacts list",
      detail: { authorityMode: "delegated" },
    });

    expect(denial).toMatchObject({
      subjectType: "agent",
      subjectId: "worker",
      relation: "execute",
      objectType: "group",
      objectId: "contacts",
      resolvedAt: null,
      resolvedRelationId: null,
      notifiedAt: null,
    });
    expect(listPermissionDenials({ subjectType: "agent", subjectId: "worker", resolved: false })).toHaveLength(1);
  });

  it("fails closed for incomplete denial records", () => {
    expect(
      recordPermissionDenial({
        subjectType: "agent",
        subjectId: "",
        relation: "execute",
        objectType: "group",
        objectId: "contacts",
      }),
    ).toBeNull();
    expect(listPermissionDenials()).toEqual([]);
  });

  it("records and publishes denied audit events with the same denial id", async () => {
    delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;

    const denial = recordAndEmitPermissionDenial({
      subjectType: "agent",
      subjectId: "worker",
      relation: "use",
      objectType: "tool",
      objectId: "Bash",
      agentId: "worker",
      reason: "missing tool grant",
      audit: {
        type: "tool",
        agentId: "worker",
        denied: "tool:Bash",
        reason: "missing tool grant",
      },
    });
    await flushPermissionAuditEvents();

    expect(auditEvents).toEqual([
      {
        topic: "ravi.audit.denied",
        data: expect.objectContaining({
          type: "tool",
          agentId: "worker",
          denied: "tool:Bash",
          reason: "missing tool grant",
          denialId: denial?.id,
          dedupeKey: "audit.denied:tool:worker:tool:Bash:missing tool grant",
        }),
      },
    ]);
    expect(listPermissionDenials({ subjectType: "agent", subjectId: "worker", resolved: false })[0]).toEqual(
      expect.objectContaining({
        id: denial?.id,
        notifiedAt: expect.any(Number),
      }),
    );
  });
});
