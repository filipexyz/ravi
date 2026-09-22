import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateAgent, dbCreateContext, dbDeleteContext, dbGetContext, dbUpdateAgent } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import {
  authorizeRuntimeContext,
  emitApprovalResponseOnce,
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
let externalOrder: string[] = [];
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
    externalOrder = [];
    setPermissionAuditPublisherForTest(async (topic, data) => {
      auditEvents.push({ topic, data });
    });
    setApprovalServiceDependenciesForTest({
      requestReply: (async <T>(topic: string, data: Record<string, unknown>) => {
        externalOrder.push("outbound.deliver");
        deliveredRequests.push({ topic, data });
        return requestReplyResult as T;
      }) satisfies ApprovalServiceDependencies["requestReply"],
      nats: {
        emit: async (topic: string, data: Record<string, unknown>) => {
          externalOrder.push(topic);
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
      beforeExternalApproval: () => externalOrder.push("before-external-approval"),
    });

    expect(result).toMatchObject({
      allowed: true,
      approved: false,
      inherited: true,
    });
    expect(emitted).toHaveLength(0);
    expect(externalOrder).toEqual([]);
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
      beforeExternalApproval: () => externalOrder.push("before-external-approval"),
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
    const approvalResponse = emitted.find((entry) => entry.topic === "ravi.approval.response");
    expect(typeof approvalResponse?.data._emitId).toBe("string");
    expect(String(approvalResponse?.data._emitId ?? "").length).toBeGreaterThan(0);
    expect(externalOrder).toEqual([
      "before-external-approval",
      "ravi.approval.request",
      "outbound.deliver",
      "ravi.approval.response",
    ]);
  });

  it("approves Slack short-name reactions after emoji normalization", async () => {
    subscribeEvents = [
      {
        topic: "ravi.inbound.reaction",
        data: { targetMessageId: "msg_1", emoji: "+1" },
      },
    ];

    const context = dbCreateContext({
      contextId: "ctx_slack_shortname",
      contextKey: "rctx_slack_shortname",
      kind: "agent-runtime",
      sessionName: "dev-main",
      capabilities: [],
      metadata: {
        approvalSource: {
          channel: "slack",
          accountId: "main",
          chatId: "C123",
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
  });

  it("rejects when a matching inbound reply arrives", async () => {
    subscribeEvents = [
      {
        topic: "ravi.inbound.reply",
        data: { targetMessageId: "msg_1", text: "não" },
      },
    ];

    const context = dbCreateContext({
      contextId: "ctx_reply_reject",
      contextKey: "rctx_reply_reject",
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
      allowed: false,
      approved: false,
      inherited: false,
    });
    expect(result.reason).toBe("não");
    expect(dbGetContext(context.contextId)?.capabilities).toEqual([]);
  });

  it("publishes approval.response once per messageId even when reaction traffic retries", async () => {
    const first = await emitApprovalResponseOnce({
      type: "permission",
      sessionName: "demo-agent",
      agentId: "demo-agent",
      approved: true,
      messageId: "msg_approval_1",
    });
    const second = await emitApprovalResponseOnce({
      type: "permission",
      sessionName: "demo-agent",
      agentId: "demo-agent",
      approved: true,
      messageId: "msg_approval_1",
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(emitted.filter((entry) => entry.topic === "ravi.approval.response")).toHaveLength(1);
    expect(emitted[0]?.data._emitId).toBeTruthy();
    expect(emitted[0]?.data.messageId).toBe("msg_approval_1");
  });

  it("denies chat-only tool and exec requests before approval escalation", async () => {
    dbCreateAgent({ id: "reception", cwd: "/tmp/reception" });
    dbUpdateAgent("reception", { defaults: { runtimePermissions: { profile: "chat-only" } } });
    getOrCreateSession("agent:reception:main", "reception", "/tmp/reception", { name: "main" });
    const context = dbCreateContext({
      contextId: "ctx_chat_only",
      contextKey: "rctx_chat_only",
      kind: "agent-runtime",
      agentId: "reception",
      sessionKey: "agent:reception:main",
      sessionName: "main",
      capabilities: [{ permission: "use", objectType: "tool", objectId: "*" }],
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

    const tool = await authorizeRuntimeContext({
      context,
      permission: "use",
      objectType: "tool",
      objectId: "Read",
      beforeExternalApproval: () => externalOrder.push("before-external-approval"),
    });
    const exec = await authorizeRuntimeContext({
      context,
      permission: "execute",
      objectType: "executable",
      objectId: "curl",
      beforeExternalApproval: () => externalOrder.push("before-external-approval"),
    });

    expect(tool).toMatchObject({
      allowed: false,
      approved: false,
      inherited: false,
    });
    expect(tool.reason ?? "").toMatch(/chat-only/);
    expect(exec.allowed).toBe(false);
    expect(exec.reason ?? "").toMatch(/chat-only/);
    expect(emitted).toHaveLength(0);
    expect(deliveredRequests).toHaveLength(0);
    expect(externalOrder).toEqual([]);
    expect(listPermissionDenials({ subjectType: "agent", subjectId: "reception", resolved: false })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "reception",
          relation: "use",
          objectType: "tool",
          objectId: "Read",
        }),
        expect.objectContaining({
          agentId: "reception",
          relation: "execute",
          objectType: "executable",
          objectId: "curl",
        }),
      ]),
    );
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
      beforeExternalApproval: () => externalOrder.push("before-external-approval"),
    });

    expect(result).toMatchObject({
      allowed: false,
      approved: false,
      inherited: false,
      reason: "No approval source available.",
    });
    expect(emitted).toHaveLength(0);
    expect(externalOrder).toEqual([]);
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

  it("stops before external approval emission when its boundary fence fails", async () => {
    const context = dbCreateContext({
      contextId: "ctx_boundary_failure",
      contextKey: "rctx_boundary_failure",
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

    await expect(
      authorizeRuntimeContext({
        context,
        permission: "execute",
        objectType: "group",
        objectId: "daemon",
        beforeExternalApproval: () => {
          externalOrder.push("before-external-approval");
          throw new Error("durable output marker unavailable");
        },
      }),
    ).rejects.toThrow("durable output marker unavailable");

    expect(externalOrder).toEqual(["before-external-approval"]);
    expect(emitted).toEqual([]);
    expect(deliveredRequests).toEqual([]);
    expect(dbGetContext(context.contextId)?.capabilities).toEqual([]);
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
          reason: "[REDACTED:content length=29]",
          denialId: expect.any(Number),
          dedupeKey: "audit.denied:scope:dev:group:daemon:[REDACTED:content length=29]",
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
