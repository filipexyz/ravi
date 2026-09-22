import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateAgent, dbCreateContext, dbDeleteContext, dbGetContext, dbUpdateAgent } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import {
  authorizeRuntimeContext,
  emitApprovalResponseOnce,
  setApprovalServiceDependenciesForTest,
  type ApprovalFinalizeSlackInput,
  type ApprovalServiceDependencies,
} from "./service.js";
import { SLACK_APPROVAL_ACTION_APPROVE, SLACK_APPROVAL_ACTION_REJECT } from "./slack-blocks.js";
import {
  flushPermissionAuditEvents,
  listPermissionDenials,
  setPermissionAuditPublisherForTest,
} from "../permissions/denials.js";
import {
  APPROVAL_TEST_NOW_MS,
  APPROVAL_TEST_SLACK_OWNER_PHONE,
  APPROVAL_TEST_SLACK_OWNER_USER,
  APPROVAL_TEST_SLACK_STRANGER_USER,
  APPROVAL_TEST_STRANGER_PHONE,
  APPROVAL_TEST_TIMEOUT_MS,
  APPROVAL_TEST_WA_OWNER_PHONE,
  assertAuthorizedGrantor,
  seedApprovalContact,
} from "./test-support.js";

let requestReplyResult: { messageId?: string } = { messageId: "msg_1" };
let subscribeEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
let emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
let auditEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
let deliveredRequests: Array<{ topic: string; data: Record<string, unknown> }> = [];
let finalizedSlack: ApprovalFinalizeSlackInput[] = [];
let externalOrder: string[] = [];
let stateDir: string | null = null;
let nowMs = APPROVAL_TEST_NOW_MS;
const createdContextIds = new Set<string>();

const OWNER_PHONE = APPROVAL_TEST_WA_OWNER_PHONE;
const OWNER_SLACK_USER = APPROVAL_TEST_SLACK_OWNER_USER;

function seedWhatsAppOwner(): void {
  seedApprovalContact({
    phone: OWNER_PHONE,
    name: "Owner",
    tags: ["permission.admin"],
  });
  assertAuthorizedGrantor({
    channel: "whatsapp",
    accountId: "main",
    senderId: OWNER_PHONE,
    permission: "execute",
    objectType: "group",
    objectId: "daemon",
  });
}

function seedSlackOwner(instanceId = "main"): void {
  seedApprovalContact({
    phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
    name: "Slack Owner",
    tags: ["permission.admin"],
    slack: { userId: OWNER_SLACK_USER, instanceId },
  });
  assertAuthorizedGrantor({
    channel: "slack",
    accountId: instanceId,
    instanceId,
    senderId: OWNER_SLACK_USER,
    permission: "execute",
    objectType: "group",
    objectId: "daemon",
  });
}

function extractDeliveredRequestId(): string {
  const blocks = deliveredRequests[0]?.data.blocks;
  if (!Array.isArray(blocks)) return "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const elements = (block as { elements?: unknown }).elements;
    if (!Array.isArray(elements)) continue;
    for (const element of elements) {
      if (!element || typeof element !== "object") continue;
      const value = (element as { value?: unknown }).value;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

function hydrateEvent(event: { topic: string; data: Record<string, unknown> }): {
  topic: string;
  data: Record<string, unknown>;
} {
  if (event.data.value !== "$requestId") return event;
  return { topic: event.topic, data: { ...event.data, value: extractDeliveredRequestId() } };
}

describe("approval service", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-approval-service-test-");
    requestReplyResult = { messageId: "msg_1" };
    subscribeEvents = [];
    emitted = [];
    auditEvents = [];
    deliveredRequests = [];
    finalizedSlack = [];
    externalOrder = [];
    nowMs = APPROVAL_TEST_NOW_MS;
    setPermissionAuditPublisherForTest(async (topic, data) => {
      auditEvents.push({ topic, data });
    });
    setApprovalServiceDependenciesForTest({
      now: () => nowMs,
      requestReply: (async <T>(topic: string, data: Record<string, unknown>) => {
        externalOrder.push("outbound.deliver");
        deliveredRequests.push({ topic, data });
        return requestReplyResult as T;
      }) satisfies ApprovalServiceDependencies["requestReply"],
      finalizeSlackApproval: async (input) => {
        finalizedSlack.push(input);
      },
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
                yield hydrateEvent(event);
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
    seedWhatsAppOwner();
    subscribeEvents = [
      {
        topic: "ravi.inbound.reaction",
        data: { targetMessageId: "msg_1", emoji: "👍", senderId: OWNER_PHONE },
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
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
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
    expect(deliveredRequests[0]?.data.blocks).toBeUndefined();
    expect(deliveredText).toContain("Capability: execute:group:daemon");
    expect(deliveredText).toContain("Escopo: contexto atual");
    expect(deliveredText).toContain(
      "Recorrente: Use ravi permissions allow permission-execute-group-daemon --capabilities execute:group:daemon --apply",
    );
    expect(deliveredText).toContain("Fallback técnico: Use raw capability execute:group:daemon");
    expect(deliveredText).toContain("Reaja com 👍 ou ❤️");
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

  it("does not approve Slack reactions even from an authorized grantor", async () => {
    seedSlackOwner();
    subscribeEvents = [
      {
        topic: "ravi.inbound.reaction",
        data: { targetMessageId: "msg_1", emoji: "👍", senderId: OWNER_SLACK_USER },
      },
    ];

    const context = dbCreateContext({
      contextId: "ctx_slack_reaction_ignored",
      contextKey: "rctx_slack_reaction_ignored",
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
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    expect(result).toMatchObject({
      allowed: false,
      approved: false,
      inherited: false,
    });
    expect(result.reason ?? "").toMatch(/Timeout/);
    expect(dbGetContext(context.contextId)?.capabilities).toEqual([]);
    expect(finalizedSlack[0]?.text).toContain("Expired");
  });

  it("approves an authorized Slack Block Kit click and removes the buttons", async () => {
    seedSlackOwner();
    subscribeEvents = [
      {
        topic: "ravi.inbound.interaction",
        data: {
          provider: "slack",
          accountId: "main",
          instanceId: "main",
          channelId: "C123",
          messageTs: "msg_1",
          userId: OWNER_SLACK_USER,
          actionId: SLACK_APPROVAL_ACTION_APPROVE,
          value: "$requestId",
        },
      },
    ];

    const context = dbCreateContext({
      contextId: "ctx_slack_approve",
      contextKey: "rctx_slack_approve",
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
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    expect(result).toMatchObject({
      allowed: true,
      approved: true,
      inherited: false,
    });
    const delivered = deliveredRequests[0]?.data;
    expect(delivered?.text).toBe("Permission requested");
    expect(JSON.stringify(delivered?.blocks)).toContain(SLACK_APPROVAL_ACTION_APPROVE);
    expect(JSON.stringify(delivered?.blocks)).not.toContain("Reaja com");
    expect(JSON.stringify(delivered?.blocks)).not.toContain("react with");
    expect(finalizedSlack).toHaveLength(1);
    expect(finalizedSlack[0]).toMatchObject({
      accountId: "main",
      chatId: "C123",
      messageId: "msg_1",
    });
    expect(JSON.stringify(finalizedSlack[0]?.blocks)).not.toContain('"type":"actions"');
    expect(finalizedSlack[0]?.text).toContain("Approved");
  });

  it("rejects an authorized Slack Block Kit click", async () => {
    seedSlackOwner();
    subscribeEvents = [
      {
        topic: "ravi.inbound.interaction",
        data: {
          provider: "slack",
          accountId: "main",
          channelId: "C123",
          messageTs: "msg_1",
          userId: OWNER_SLACK_USER,
          actionId: SLACK_APPROVAL_ACTION_REJECT,
          value: "$requestId",
        },
      },
    ];

    const context = dbCreateContext({
      contextId: "ctx_slack_reject",
      contextKey: "rctx_slack_reject",
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
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    expect(result).toMatchObject({
      allowed: false,
      approved: false,
      inherited: false,
    });
    expect(dbGetContext(context.contextId)?.capabilities).toEqual([]);
    expect(finalizedSlack[0]?.text).toContain("Rejected");
  });

  it("ignores an unauthorized Slack click and does not grant", async () => {
    seedSlackOwner();
    seedApprovalContact({
      phone: APPROVAL_TEST_STRANGER_PHONE,
      name: "Stranger",
      tags: ["lead"],
      slack: { userId: APPROVAL_TEST_SLACK_STRANGER_USER, instanceId: "main" },
    });
    subscribeEvents = [
      {
        topic: "ravi.inbound.interaction",
        data: {
          provider: "slack",
          accountId: "main",
          channelId: "C123",
          messageTs: "msg_1",
          userId: APPROVAL_TEST_SLACK_STRANGER_USER,
          actionId: SLACK_APPROVAL_ACTION_APPROVE,
          value: "$requestId",
        },
      },
    ];

    const context = dbCreateContext({
      contextId: "ctx_slack_unauth",
      contextKey: "rctx_slack_unauth",
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
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    expect(result).toMatchObject({
      allowed: false,
      approved: false,
      inherited: false,
    });
    expect(result.reason ?? "").toMatch(/Timeout/);
    expect(dbGetContext(context.contextId)?.capabilities).toEqual([]);
    expect(finalizedSlack[0]?.text).toContain("Expired");
  });

  it("keeps the first valid Slack decision and ignores a second click", async () => {
    seedSlackOwner();
    subscribeEvents = [
      {
        topic: "ravi.inbound.interaction",
        data: {
          provider: "slack",
          accountId: "main",
          channelId: "C123",
          messageTs: "msg_1",
          userId: OWNER_SLACK_USER,
          actionId: SLACK_APPROVAL_ACTION_APPROVE,
          value: "$requestId",
        },
      },
      {
        topic: "ravi.inbound.interaction",
        data: {
          provider: "slack",
          accountId: "main",
          channelId: "C123",
          messageTs: "msg_1",
          userId: OWNER_SLACK_USER,
          actionId: SLACK_APPROVAL_ACTION_REJECT,
          value: "$requestId",
        },
      },
    ];

    const context = dbCreateContext({
      contextId: "ctx_slack_single_use",
      contextKey: "rctx_slack_single_use",
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
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    expect(result.approved).toBe(true);
    expect(finalizedSlack).toHaveLength(1);
    expect(dbGetContext(context.contextId)?.capabilities).toContainEqual({
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
      source: "approval",
    });
  });

  it("ignores a Slack click on the wrong message", async () => {
    seedSlackOwner();
    subscribeEvents = [
      {
        topic: "ravi.inbound.interaction",
        data: {
          provider: "slack",
          accountId: "main",
          channelId: "C123",
          messageTs: "msg_other",
          userId: OWNER_SLACK_USER,
          actionId: SLACK_APPROVAL_ACTION_APPROVE,
          value: "$requestId",
        },
      },
    ];

    const context = dbCreateContext({
      contextId: "ctx_slack_wrong_message",
      contextKey: "rctx_slack_wrong_message",
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
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    expect(result.approved).toBe(false);
    expect(result.reason ?? "").toMatch(/Timeout/);
    expect(dbGetContext(context.contextId)?.capabilities).toEqual([]);
  });

  it("rejects when a matching inbound WhatsApp reply arrives from an authorized grantor", async () => {
    seedWhatsAppOwner();
    subscribeEvents = [
      {
        topic: "ravi.inbound.reply",
        data: { targetMessageId: "msg_1", text: "não", senderId: OWNER_PHONE },
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
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    expect(result).toMatchObject({
      allowed: false,
      approved: false,
      inherited: false,
    });
    expect(result.reason).toBe("não");
    expect(dbGetContext(context.contextId)?.capabilities).toEqual([]);
  });

  it("does not let an unauthorized WhatsApp reaction approve", async () => {
    seedWhatsAppOwner();
    seedApprovalContact({
      phone: APPROVAL_TEST_STRANGER_PHONE,
      name: "Stranger",
      tags: ["lead"],
    });
    subscribeEvents = [
      {
        topic: "ravi.inbound.reaction",
        data: { targetMessageId: "msg_1", emoji: "👍", senderId: APPROVAL_TEST_STRANGER_PHONE },
      },
    ];

    const context = dbCreateContext({
      contextId: "ctx_wa_unauth",
      contextKey: "rctx_wa_unauth",
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
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    expect(result.approved).toBe(false);
    expect(result.reason ?? "").toMatch(/Timeout/);
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
