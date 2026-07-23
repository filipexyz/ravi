import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateAgent, dbCreateContext, dbDeleteContext, dbGetContext } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import {
  authorizeRuntimeContext,
  setApprovalServiceDependenciesForTest,
  type ApprovalServiceDependencies,
} from "./service.js";
import {
  flushPermissionAuditEvents,
  listPermissionDenials,
  setPermissionAuditPublisherForTest,
} from "../permissions/denials.js";

let requestReplyResult: { messageId?: string } = { messageId: "msg_1" };
let subscribeEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
let emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
let auditEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
let deliveredRequests: Array<{ topic: string; data: Record<string, unknown> }> = [];
let stateDir: string | null = null;
const createdContextIds = new Set<string>();

describe("approval service", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-approval-service-test-");
    requestReplyResult = { messageId: "msg_1" };
    subscribeEvents = [];
    emitted = [];
    auditEvents = [];
    deliveredRequests = [];
    setPermissionAuditPublisherForTest(async (topic, data) => {
      auditEvents.push({ topic, data });
    });
    setApprovalServiceDependenciesForTest({
      requestReply: (async <T>(topic: string, data: Record<string, unknown>) => {
        deliveredRequests.push({ topic, data });
        return requestReplyResult as T;
      }) satisfies ApprovalServiceDependencies["requestReply"],
      nats: {
        emit: async (topic: string, data: Record<string, unknown>) => {
          emitted.push({ topic, data });
        },
        subscribe: ((...args: unknown[]) => {
          const topics = args.filter((arg): arg is string => typeof arg === "string");
          return (async function* () {
            for (const event of subscribeEvents) {
              if (topics.includes(event.topic)) {
                yield event;
              }
            }
          })();
        }) satisfies ApprovalServiceDependencies["nats"]["subscribe"],
      },
    });
  });

  afterEach(async () => {
    setApprovalServiceDependenciesForTest();
    setPermissionAuditPublisherForTest();
    for (const contextId of createdContextIds) {
      dbDeleteContext(contextId);
    }
    createdContextIds.clear();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("returns inherited access when the context already has the capability", async () => {
    const context = dbCreateContext({
      contextId: "ctx_1",
      contextKey: "rctx_1",
      kind: "agent-runtime",
      sessionName: "dev-main",
      capabilities: [{ permission: "execute", objectType: "group", objectId: "context" }],
      createdAt: 1000,
    });
    createdContextIds.add(context.contextId);

    const result = await authorizeRuntimeContext({
      context,
      permission: "execute",
      objectType: "group",
      objectId: "context",
    });

    expect(result).toMatchObject({
      allowed: true,
      approved: false,
      inherited: true,
    });
    expect(emitted).toHaveLength(0);
  });

  it("requests approval through metadata.approvalSource and persists the granted capability", async () => {
    subscribeEvents = [
      {
        topic: "ravi.inbound.reaction",
        data: { targetMessageId: "msg_1", emoji: "👍" },
      },
    ];

    const context = dbCreateContext({
      contextId: "ctx_2",
      contextKey: "rctx_2",
      kind: "agent-runtime",
      sessionName: "dev-main",
      capabilities: [],
      metadata: {
        approvalSource: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "5511999999999",
        },
      },
      createdAt: 1000,
    });
    createdContextIds.add(context.contextId);

    const result = await authorizeRuntimeContext({
      context,
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
      timeoutMs: 20,
    });

    expect(result).toMatchObject({
      allowed: true,
      approved: true,
      inherited: false,
    });
    expect(result.context.capabilities).toContainEqual({
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
      source: "approval",
    });
    expect(dbGetContext(context.contextId)?.capabilities).toContainEqual({
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
      source: "approval",
    });
    const deliveredText = String(deliveredRequests[0]?.data.text ?? "");
    expect(deliveredRequests[0]?.topic).toBe("ravi.outbound.deliver");
    expect(deliveredText).toContain("Capability: execute:group:daemon");
    expect(deliveredText).toContain("Escopo: contexto atual");
    expect(deliveredText).toContain("Recorrente: Use a provider-owned permission profile/tag");
    expect(deliveredText).toContain("Fallback técnico: Use raw capability execute:group:daemon");
    expect(emitted.map((entry) => entry.topic)).toEqual(["ravi.approval.request", "ravi.approval.response"]);
  });

  it("fails closed when no approval source is available", async () => {
    dbCreateAgent({ id: "dev", cwd: "/tmp/dev" });
    getOrCreateSession("agent:dev:dev-main", "dev", "/tmp/dev", { name: "dev-main" });
    const context = dbCreateContext({
      contextId: "ctx_3",
      contextKey: "rctx_3",
      kind: "agent-runtime",
      agentId: "dev",
      sessionKey: "agent:dev:dev-main",
      sessionName: "dev-main",
      capabilities: [],
      createdAt: 1000,
    });
    createdContextIds.add(context.contextId);

    const result = await authorizeRuntimeContext({
      context,
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
    });

    expect(result).toMatchObject({
      allowed: false,
      approved: false,
      inherited: false,
      reason: "No approval source available.",
    });
    expect(emitted).toHaveLength(0);
    expect(listPermissionDenials({ subjectType: "agent", subjectId: "dev", resolved: false })).toContainEqual(
      expect.objectContaining({
        agentId: "dev",
        sessionKey: "agent:dev:dev-main",
        sessionName: "dev-main",
        contextId: "ctx_3",
        relation: "execute",
        objectType: "group",
        objectId: "daemon",
      }),
    );
  });

  it("publishes audit denied events for runtime context denials", async () => {
    delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    dbCreateAgent({ id: "dev", cwd: "/tmp/dev" });
    getOrCreateSession("agent:dev:dev-main", "dev", "/tmp/dev", { name: "dev-main" });
    const context = dbCreateContext({
      contextId: "ctx_audit_denied",
      contextKey: "rctx_audit_denied",
      kind: "agent-runtime",
      agentId: "dev",
      sessionKey: "agent:dev:dev-main",
      sessionName: "dev-main",
      capabilities: [],
      createdAt: 1000,
    });
    createdContextIds.add(context.contextId);

    const result = await authorizeRuntimeContext({
      context,
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
    });
    await flushPermissionAuditEvents();

    expect(result.allowed).toBe(false);
    expect(auditEvents).toEqual([
      {
        topic: "ravi.audit.denied",
        data: expect.objectContaining({
          type: "scope",
          agentId: "dev",
          denied: "group:daemon",
          reason: "No approval source available.",
          denialId: expect.any(Number),
          dedupeKey: "audit.denied:scope:dev:group:daemon:No approval source available.",
          context: expect.objectContaining({
            contextId: "ctx_audit_denied",
            sessionName: "dev-main",
          }),
        }),
      },
    ]);
    expect(listPermissionDenials({ subjectType: "agent", subjectId: "dev", resolved: false })[0]?.notifiedAt).toEqual(
      expect.any(Number),
    );
  });
});
