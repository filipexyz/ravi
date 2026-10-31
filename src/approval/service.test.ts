import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { withoutRaviRuntimeContextEnv } from "../test/ravi-state.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  dbCreateAgent,
  dbCreateContext,
  dbDeleteContext,
  dbGetContext,
  dbUpdateAgent,
  dbUpsertChat,
  dbUpsertChatParticipant,
  getDb,
} from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import {
  authorizeRuntimeContext,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  emitApprovalResponseOnce,
  setApprovalServiceDependenciesForTest,
  type ApprovalFinalizeSlackInput,
  type ApprovalRespondSlackInput,
  type ApprovalServiceDependencies,
} from "./service.js";
import { setApprovalGrantorRouterConfigForTest } from "./grantor.js";
import {
  SLACK_APPROVAL_ACTION_APPROVE,
  SLACK_APPROVAL_ACTION_REJECT,
  SLACK_PERMISSION_GRANT_ACTION_EXACT,
  SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS,
  SLACK_PERMISSION_GRANT_ACTION_SCOPE,
} from "./slack-blocks.js";
import { attachApprovalRequestMessageId, createApprovalRequest } from "./store.js";
import { sameGrantTuple } from "./grant-metadata.js";
import { dbGetContactChatGrant, dbListContactChatGrants } from "../permissions/contact-chat-grants.js";
import { getContact } from "../contacts.js";
import { readAgentRuntimePermissionsConfig } from "../permissions/agent-default-capabilities-provider.js";
import { recordPermissionDenial } from "../permissions/denials.js";
import { dbCreateTagDefinition } from "../tags/index.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS as APPROVAL_TIMEOUT_FROM_TIMEOUTS } from "./timeouts.js";
import { APPROVAL_GATED_TOOL_TIMEOUT_MS } from "../runtime/tool-liveness.js";
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

let requestReplyResult: { messageId?: string; deliveries?: Array<Record<string, unknown>> } = { messageId: "msg_1" };
let subscribeEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
let emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
let auditEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
let deliveredRequests: Array<{ topic: string; data: Record<string, unknown> }> = [];
let finalizedSlack: ApprovalFinalizeSlackInput[] = [];
let respondedSlack: ApprovalRespondSlackInput[] = [];
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

function seedSlackOwner(instanceId = "main"): ReturnType<typeof seedApprovalContact> {
  const contact = seedApprovalContact({
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
  return contact;
}

function createSlackApprovalContext(id: string, chatId = "C123") {
  const context = dbCreateContext({
    contextId: id,
    contextKey: `r${id}`,
    kind: "agent-runtime",
    sessionName: "dev-main",
    capabilities: [],
    metadata: {
      approvalSource: {
        channel: "slack",
        accountId: "main",
        chatId,
        threadId: "1784000000.000001",
      },
    },
    createdAt: 1000,
  });
  createdContextIds.add(context.contextId);
  return context;
}

function slackClick(input: { userId: string; channelId?: string; messageTs?: string; actionId?: string }): {
  topic: string;
  data: Record<string, unknown>;
} {
  return {
    topic: "ravi.inbound.interaction",
    data: {
      provider: "slack",
      accountId: "main",
      instanceId: "main",
      channelId: input.channelId ?? "C123",
      messageTs: input.messageTs ?? "eph_1",
      userId: input.userId,
      actionId: input.actionId ?? SLACK_APPROVAL_ACTION_APPROVE,
      value: "$requestId",
      responseUrlId: "resp_1",
    },
  };
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
      if (typeof value === "string" && value.trim()) return value.trim().split("|")[0];
    }
  }
  return "";
}

function hydrateEvent(event: { topic: string; data: Record<string, unknown> }): {
  topic: string;
  data: Record<string, unknown>;
} {
  const value = event.data.value;
  if (typeof value !== "string" || !value.startsWith("$requestId")) return event;
  return {
    topic: event.topic,
    data: { ...event.data, value: `${extractDeliveredRequestId()}${value.slice("$requestId".length)}` },
  };
}

describe("approval service", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-approval-service-test-");
    setApprovalGrantorRouterConfigForTest(() => ({ instances: {}, instanceToAccount: {} }));
    requestReplyResult = { messageId: "msg_1" };
    subscribeEvents = [];
    emitted = [];
    auditEvents = [];
    deliveredRequests = [];
    finalizedSlack = [];
    respondedSlack = [];
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
      respondSlackInteraction: async (input) => {
        respondedSlack.push(input);
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
    setApprovalGrantorRouterConfigForTest();
    setPermissionAuditPublisherForTest();
    for (const contextId of createdContextIds) {
      dbDeleteContext(contextId);
    }
    createdContextIds.clear();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("keeps the approval timeout inside the lease of tools that wait on it", () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(APPROVAL_TIMEOUT_FROM_TIMEOUTS);
    // requestApproval waits up to the timeout to deliver, then up to the timeout for the answer.
    expect(APPROVAL_GATED_TOOL_TIMEOUT_MS).toBeGreaterThan(2 * DEFAULT_APPROVAL_TIMEOUT_MS);
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

  it("sends the Slack card privately, only to the people who can grant it", async () => {
    seedSlackOwner();
    seedApprovalContact({
      phone: APPROVAL_TEST_STRANGER_PHONE,
      name: "Stranger",
      tags: ["lead"],
      slack: { userId: APPROVAL_TEST_SLACK_STRANGER_USER, instanceId: "main" },
    });
    requestReplyResult = {
      messageId: "eph_1",
      deliveries: [{ userId: OWNER_SLACK_USER, kind: "ephemeral", chatId: "C123", messageId: "eph_1" }],
    };
    subscribeEvents = [slackClick({ userId: OWNER_SLACK_USER, messageTs: "eph_seen_by_slack" })];

    const result = await authorizeRuntimeContext({
      context: createSlackApprovalContext("ctx_slack_private"),
      permission: "execute",
      objectType: "executable",
      objectId: "curl",
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    expect(result).toMatchObject({ allowed: true, approved: true });
    const delivered = deliveredRequests[0]?.data;
    expect(delivered?.privateTo).toEqual([OWNER_SLACK_USER]);
    expect(delivered?.threadId).toBe("1784000000.000001");
    // The clicker's own card loses its buttons through the click's response_url.
    expect(respondedSlack).toHaveLength(1);
    expect(respondedSlack[0]?.responseUrlId).toBe("resp_1");
    expect(respondedSlack[0]?.payload.replace_original).toBe(true);
    expect(String(respondedSlack[0]?.payload.text)).toContain(`Approved by <@${OWNER_SLACK_USER}>`);
    expect(JSON.stringify(respondedSlack[0]?.payload.blocks)).not.toContain('"type":"actions"');
    expect(finalizedSlack).toHaveLength(0);
  });

  it("attributes the approval request to the single human in the chat", async () => {
    const owner = seedSlackOwner();
    const chat = dbUpsertChat({
      channel: "slack",
      instanceId: "main",
      platformChatId: "D-approval-owner",
      chatType: "dm",
    });
    dbUpsertChatParticipant({
      chatId: chat.id,
      contactId: owner.id,
      platformIdentityId: "pi_slack_owner",
      rawPlatformUserId: OWNER_SLACK_USER,
      role: "member",
      source: "inbound_message",
    });
    requestReplyResult = {
      messageId: "eph_1",
      deliveries: [{ userId: OWNER_SLACK_USER, kind: "ephemeral", chatId: chat.id, messageId: "eph_1" }],
    };
    subscribeEvents = [slackClick({ userId: OWNER_SLACK_USER, messageTs: "eph_seen_by_slack" })];

    await authorizeRuntimeContext({
      context: createSlackApprovalContext("ctx_approval_subject", chat.id),
      permission: "execute",
      objectType: "executable",
      objectId: "curl",
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    const row = getDb()
      .prepare(
        "SELECT subject_kind, subject_contact_id, subject_identity_id, subject_channel, subject_raw_id FROM approval_requests",
      )
      .get() as Record<string, string | null> | undefined;

    expect(row?.subject_kind).toBe("contact");
    expect(row?.subject_contact_id).toBe(owner.id);
    expect(row?.subject_identity_id).toBe("pi_slack_owner");
    expect(row?.subject_channel).toBe("slack");
    expect(row?.subject_raw_id).toBe(OWNER_SLACK_USER);
  });

  it("denies at once, without sending any card, when nobody in the Slack can grant it", async () => {
    seedApprovalContact({
      phone: APPROVAL_TEST_STRANGER_PHONE,
      name: "Stranger",
      tags: ["lead"],
      slack: { userId: APPROVAL_TEST_SLACK_STRANGER_USER, instanceId: "main" },
    });

    const startedAt = Date.now();
    const result = await authorizeRuntimeContext({
      context: createSlackApprovalContext("ctx_slack_no_grantor"),
      permission: "execute",
      objectType: "executable",
      objectId: "curl",
      timeoutMs: 60_000,
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result).toMatchObject({ allowed: false, approved: false });
    expect(result.reason ?? "").toContain("Ninguém neste Slack pode aprovar execute:executable:curl");
    expect(deliveredRequests).toHaveLength(0);
    expect(dbGetContext("ctx_slack_no_grantor")?.capabilities).toEqual([]);
  });

  it("edits a DM approval card in place after the decision", async () => {
    seedSlackOwner();
    requestReplyResult = {
      messageId: "dm_1",
      deliveries: [{ userId: OWNER_SLACK_USER, kind: "dm", chatId: "D777", messageId: "dm_1" }],
    };
    subscribeEvents = [slackClick({ userId: OWNER_SLACK_USER, channelId: "D777", messageTs: "dm_1" })];

    const result = await authorizeRuntimeContext({
      context: createSlackApprovalContext("ctx_slack_dm"),
      permission: "execute",
      objectType: "executable",
      objectId: "curl",
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    expect(result.approved).toBe(true);
    expect(finalizedSlack).toHaveLength(1);
    expect(finalizedSlack[0]).toMatchObject({ chatId: "D777", messageId: "dm_1" });
    expect(respondedSlack).toHaveLength(0);
  });

  it("ignores a click from a grantor the private card was not sent to", async () => {
    seedSlackOwner();
    requestReplyResult = {
      messageId: "eph_1",
      deliveries: [{ userId: "USOMEONE1", kind: "ephemeral", chatId: "C123", messageId: "eph_1" }],
    };
    subscribeEvents = [slackClick({ userId: OWNER_SLACK_USER })];

    const result = await authorizeRuntimeContext({
      context: createSlackApprovalContext("ctx_slack_not_recipient"),
      permission: "execute",
      objectType: "executable",
      objectId: "curl",
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    expect(result.approved).toBe(false);
    expect(result.reason ?? "").toMatch(/Timeout/);
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

  it("applies a Console bridge grant before the local chat-only profile, while revoked contexts still deny", () => {
    // A separate process owns the singleton bridge store; no shared runtime state.
    execFileSync(
      process.execPath,
      [
        "--eval",
        `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { getBridgeStore } from "./src/bridge/store.ts";
      import { getOrCreateSession } from "./src/router/sessions.ts";
      import { dbCreateAgent, dbUpdateAgent, dbCreateContext } from "./src/router/router-db.ts";
      import { authorizeRuntimeContext } from "./src/approval/service.ts";
      const store = getBridgeStore(), id = randomUUID(), turn = randomUUID(), enrollment = randomUUID();
      const sessionKey = "agent:bridge-test:console:" + id;
      const cap = {permission:"execute", objectType:"executable", objectId:"printf"};
      dbCreateAgent({id:"bridge-test",cwd:"/tmp/bridge-fixture"});
      dbUpdateAgent("bridge-test",{defaults:{runtimePermissions:{profile:"chat-only"}}});
      store.putEnrollment({id:enrollment,orgId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),issuer:"https://issuer.test",issuerPublicKey:"synthetic",issuerKeyId:"test",epoch:1,active:true});
      const subject=randomUUID(),project=randomUUID();
      store.db.query("INSERT INTO conversations(id,enrollment_id,subject,project_id,agent_id,session_name,session_key,title,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id,enrollment,subject,project,"bridge-test","console-"+id,sessionKey,"Synthetic",Date.now());
      const grant={enrollmentId:enrollment,epoch:1,exp:Math.floor(Date.now()/1000)+30,canSend:true,sub:subject,projectId:project,agents:[{id:"bridge-test",capabilities:[cap],approvalCapabilities:[]}]};
      store.db.query("INSERT INTO turns(id,conversation_id,status,lease_until,authority,created_at) VALUES(?,?,?,?,?,?)").run(turn,id,"running",Date.now()+30000,JSON.stringify(grant),Date.now());
      getOrCreateSession(sessionKey,"bridge-test","/tmp/bridge-fixture",{name:"console-"+id});
      const context=dbCreateContext({contextId:randomUUID(),contextKey:randomUUID(),kind:"turn-runtime",agentId:"bridge-test",sessionKey,sessionName:"console-"+id,capabilities:[],metadata:{bridgeTurnId:turn},createdAt:Date.now()});
      assert.equal((await authorizeRuntimeContext({context,...cap})).allowed,true);
      assert.equal((await authorizeRuntimeContext({context:{...context,revokedAt:Date.now()-1},...cap})).allowed,false);
      store.db.query("UPDATE turns SET lease_until=0 WHERE id=?").run(turn);
      assert.equal((await authorizeRuntimeContext({context,...cap})).allowed,false);
      store.close();
    `,
      ],
      { env: { ...withoutRaviRuntimeContextEnv(), RAVI_STATE_DIR: stateDir! }, stdio: "pipe", timeout: 20000 },
    );
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

  it("denies an unidentified external actor without sending an approval card", async () => {
    // The turn came from a Slack DM whose sender resolved to no contact. Even
    // with an authorized grantor clicking in that DM, the request must never be
    // sent: the card would go back to the unidentified actor's own surface.
    seedSlackOwner("slack-main");
    subscribeEvents = [
      {
        topic: "ravi.inbound.interaction",
        data: {
          provider: "slack",
          accountId: "slack-main",
          instanceId: "slack-main",
          channelId: "D123",
          messageTs: "msg_1",
          userId: OWNER_SLACK_USER,
          actionId: SLACK_APPROVAL_ACTION_APPROVE,
          value: "$requestId",
        },
      },
    ];
    getOrCreateSession("agent:main:slack:dm:U1", "main", "/tmp/main", { name: "main-slack-dm" });
    const context = dbCreateContext({
      contextId: "ctx_unresolved_actor",
      contextKey: "rctx_unresolved_actor",
      kind: "agent-runtime",
      agentId: "main",
      sessionKey: "agent:main:slack:dm:U1",
      sessionName: "main-slack-dm",
      capabilities: [],
      source: { channel: "slack", accountId: "slack-main", chatId: "D123" },
      metadata: {
        authorityMode: "agent-identity",
        actorPrincipal: "unknown",
        actorResolution: "missing_contact",
      },
      createdAt: 1000,
    });
    createdContextIds.add(context.contextId);

    const result = await authorizeRuntimeContext({
      context,
      permission: "use",
      objectType: "tool",
      objectId: "Bash",
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
      beforeExternalApproval: () => externalOrder.push("before-external-approval"),
    });

    expect(result).toMatchObject({ allowed: false, approved: false, inherited: false });
    expect(result.reason ?? "").toMatch(/not identified/);
    expect(deliveredRequests).toEqual([]);
    expect(emitted).toEqual([]);
    expect(externalOrder).toEqual([]);
    expect(dbGetContext(context.contextId)?.capabilities).toEqual([]);
    expect(listPermissionDenials({ subjectType: "agent", subjectId: "main", resolved: false })).toContainEqual(
      expect.objectContaining({
        contextId: "ctx_unresolved_actor",
        relation: "use",
        objectType: "tool",
        objectId: "Bash",
      }),
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

  describe("permission grant card", () => {
    const REQUESTER_SLACK_USER = "UREQTEST9";

    function seedGrantChat() {
      return dbUpsertChat({
        channel: "slack",
        instanceId: "main",
        platformChatId: "C123",
        chatType: "group",
        title: "ops",
      });
    }

    function seedRequester() {
      return seedApprovalContact({
        phone: APPROVAL_TEST_STRANGER_PHONE,
        name: "Requester",
        tags: ["lead"],
        slack: { userId: REQUESTER_SLACK_USER, instanceId: "main" },
      });
    }

    function seedDeniedContext(input: { contextId: string; contactId: string; chatId: string }) {
      try {
        dbCreateAgent({ id: "dev", cwd: "/tmp/dev" });
      } catch {
        // The agent already exists in this isolated state.
      }
      const context = dbCreateContext({
        contextId: input.contextId,
        contextKey: `r${input.contextId}`,
        kind: "agent-runtime",
        agentId: "dev",
        sessionName: "dev-main",
        capabilities: [],
        source: {
          channel: "slack",
          accountId: "main",
          instanceId: "main",
          chatId: "C123",
          canonicalChatId: input.chatId,
        },
        metadata: {
          authorityMode: "agent-identity",
          actorPrincipal: `contact:${input.contactId}`,
          actorResolution: "resolved",
          actorAuthorizationMode: "user-overlay",
          executorAgentId: "dev",
          userOverlay: "active",
          userOverlayChat: `chat:${input.chatId}`,
        },
        createdAt: 1000,
      });
      createdContextIds.add(context.contextId);
      return context;
    }

    it("sends the card to the admin and applies the grant the admin clicked", async () => {
      delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      seedSlackOwner();
      const requester = seedRequester();
      const chat = seedGrantChat();
      const denial = recordPermissionDenial({
        subjectType: "agent",
        subjectId: "dev",
        relation: "use",
        objectType: "tool",
        objectId: "Bash",
        agentId: "dev",
        sessionKey: "agent:dev:dev-main",
        sessionName: "dev-main",
        contextId: "ctx_prior",
        reason: "Permission denied: use tool:Bash",
      });
      expect(denial?.id).toBeGreaterThan(0);

      requestReplyResult = {
        messageId: "eph_1",
        deliveries: [{ userId: OWNER_SLACK_USER, kind: "ephemeral", chatId: "C123", messageId: "eph_1" }],
      };
      subscribeEvents = [
        slackClick({
          userId: OWNER_SLACK_USER,
          messageTs: "eph_seen_by_slack",
          actionId: SLACK_PERMISSION_GRANT_ACTION_EXACT,
        }),
      ];

      const context = seedDeniedContext({ contextId: "ctx_grant_apply", contactId: requester.id, chatId: chat.id });

      const result = await authorizeRuntimeContext({
        context,
        permission: "use",
        objectType: "tool",
        objectId: "Bash",
        timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
      });

      expect(result).toMatchObject({ allowed: true, approved: true });
      // The card went only to the admin, not to the requester.
      expect(deliveredRequests[0]?.data.privateTo).toEqual([OWNER_SLACK_USER]);
      expect(JSON.stringify(deliveredRequests[0]?.data.blocks)).toContain("<@" + OWNER_SLACK_USER + ">");
      expect(JSON.stringify(deliveredRequests[0]?.data.blocks)).toContain("<@" + REQUESTER_SLACK_USER + ">");
      expect(JSON.stringify(deliveredRequests[0]?.data.blocks)).toContain(SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS);
      // The click carried no scope, so the recorded default (this chat) applied.
      expect(
        dbGetContactChatGrant({
          contactId: requester.id,
          profileSlug: "permission-use-tool-bash",
          scopeType: "chat",
          scopeId: chat.id,
        }),
      ).not.toBeNull();
      expect(readAgentRuntimePermissionsConfig("dev")?.capabilities).toEqual([
        { permission: "use", objectType: "tool", objectId: "Bash" },
      ]);
      expect(listPermissionDenials({ subjectType: "agent", subjectId: "dev", resolved: false })).toEqual([]);
      await flushPermissionAuditEvents();
      expect(auditEvents.map((entry) => entry.topic)).toContain("ravi.audit.permission_grant");
      const audit = auditEvents.find((entry) => entry.topic === "ravi.audit.permission_grant");
      expect(audit?.data).toMatchObject({
        requestId: expect.any(String),
        capability: "use:tool:Bash",
        intent: "exact",
        scope: "chat",
        profile: "permission-use-tool-bash",
        applied: true,
        changed: true,
        resolvedDenials: 1,
      });
    });

    it("does not resolve an open denial from another chat when the grant is chat scoped", async () => {
      delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      seedSlackOwner();
      const requester = seedRequester();
      const chat = seedGrantChat();
      dbUpsertChat({
        channel: "slack",
        instanceId: "main",
        platformChatId: "C999",
        chatType: "group",
        title: "other",
      });
      const denialInChat = recordPermissionDenial({
        subjectType: "agent",
        subjectId: "dev",
        relation: "use",
        objectType: "tool",
        objectId: "Bash",
        agentId: "dev",
        contextId: "ctx_prior_chat_a",
        detail: { context: { source: { chatId: "C123" } } },
      });
      const denialOtherChat = recordPermissionDenial({
        subjectType: "agent",
        subjectId: "dev",
        relation: "use",
        objectType: "tool",
        objectId: "Bash",
        agentId: "dev",
        contextId: "ctx_prior_chat_b",
        detail: { context: { source: { chatId: "C999" } } },
      });
      const otherChatDenialId = denialOtherChat?.id ?? -1;
      expect(otherChatDenialId).toBeGreaterThan(0);

      requestReplyResult = {
        messageId: "eph_1",
        deliveries: [{ userId: OWNER_SLACK_USER, kind: "ephemeral", chatId: "C123", messageId: "eph_1" }],
      };
      subscribeEvents = [
        slackClick({
          userId: OWNER_SLACK_USER,
          messageTs: "eph_seen_by_slack",
          actionId: SLACK_PERMISSION_GRANT_ACTION_EXACT,
        }),
      ];

      const context = seedDeniedContext({
        contextId: "ctx_grant_chat_scope",
        contactId: requester.id,
        chatId: chat.id,
      });
      const result = await authorizeRuntimeContext({
        context,
        permission: "use",
        objectType: "tool",
        objectId: "Bash",
        timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
      });

      expect(result).toMatchObject({ allowed: true, approved: true });
      const open = listPermissionDenials({ subjectType: "agent", subjectId: "dev", resolved: false });
      expect(open.map((denial) => denial.id)).toEqual([otherChatDenialId]);
      expect(open.map((denial) => denial.id)).not.toContain(denialInChat?.id);
      await flushPermissionAuditEvents();
      expect(auditEvents.find((entry) => entry.topic === "ravi.audit.permission_grant")?.data).toMatchObject({
        resolvedDenials: 1,
      });
    });

    it("resolves every open denial for the subject and capability, not only the newest one", async () => {
      seedSlackOwner();
      const requester = seedRequester();
      const chat = seedGrantChat();
      const denials = [1, 2, 3].map((index) =>
        recordPermissionDenial({
          subjectType: "agent",
          subjectId: "dev",
          relation: "use",
          objectType: "tool",
          objectId: "Bash",
          agentId: "dev",
          contextId: `ctx_prior_all_${index}`,
          detail: { context: { source: { chatId: "C123" } } },
        }),
      );
      expect(denials.every((denial) => typeof denial?.id === "number")).toBe(true);

      requestReplyResult = {
        messageId: "eph_1",
        deliveries: [{ userId: OWNER_SLACK_USER, kind: "ephemeral", chatId: "C123", messageId: "eph_1" }],
      };
      subscribeEvents = [
        slackClick({
          userId: OWNER_SLACK_USER,
          messageTs: "eph_seen_by_slack",
          actionId: SLACK_PERMISSION_GRANT_ACTION_EXACT,
        }),
      ];

      const context = seedDeniedContext({
        contextId: "ctx_grant_all_denials",
        contactId: requester.id,
        chatId: chat.id,
      });
      const result = await authorizeRuntimeContext({
        context,
        permission: "use",
        objectType: "tool",
        objectId: "Bash",
        timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
      });

      expect(result).toMatchObject({ allowed: true, approved: true });
      expect(listPermissionDenials({ subjectType: "agent", subjectId: "dev", resolved: false })).toEqual([]);
    });

    it("offers Full access to an admin even when the requester is the admin", async () => {
      const owner = seedApprovalContact({
        phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
        name: "Admin requester",
        tags: ["permission.admin"],
        slack: { userId: OWNER_SLACK_USER, instanceId: "main" },
      });
      const chat = seedGrantChat();
      requestReplyResult = {
        messageId: "eph_1",
        deliveries: [{ userId: OWNER_SLACK_USER, kind: "ephemeral", chatId: "C123", messageId: "eph_1" }],
      };
      subscribeEvents = [
        slackClick({
          userId: OWNER_SLACK_USER,
          messageTs: "eph_seen_by_slack",
          actionId: SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS,
        }),
      ];

      const context = seedDeniedContext({ contextId: "ctx_grant_admin", contactId: owner.id, chatId: chat.id });

      const result = await authorizeRuntimeContext({
        context,
        permission: "use",
        objectType: "tool",
        objectId: "Bash",
        timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
      });

      expect(result).toMatchObject({ allowed: true, approved: true });
      expect(deliveredRequests[0]?.data.privateTo).toEqual([OWNER_SLACK_USER]);
      expect(JSON.stringify(deliveredRequests[0]?.data.blocks)).toContain(SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS);
      expect(
        dbGetContactChatGrant({
          contactId: owner.id,
          profileSlug: "permission-admin",
          scopeType: "chat",
          scopeId: chat.id,
        }),
      ).not.toBeNull();
    });

    it("hides Full access when no admin exists, falling back to the exact grantor", async () => {
      dbCreateTagDefinition({
        slug: "permission-use-tool-bash",
        label: "Use Bash",
        kind: "system",
        source: "permissions",
        metadata: { permissions: { capabilities: ["use:tool:Bash"] } },
      });
      seedApprovalContact({
        phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
        name: "Exact grantor",
        tags: ["lead", "permission.use-tool-bash"],
        slack: { userId: OWNER_SLACK_USER, instanceId: "main" },
      });
      const requester = seedRequester();
      const chat = seedGrantChat();
      requestReplyResult = {
        messageId: "eph_1",
        deliveries: [{ userId: OWNER_SLACK_USER, kind: "ephemeral", chatId: "C123", messageId: "eph_1" }],
      };
      subscribeEvents = [
        slackClick({
          userId: OWNER_SLACK_USER,
          messageTs: "eph_seen_by_slack",
          actionId: SLACK_PERMISSION_GRANT_ACTION_EXACT,
        }),
      ];

      const context = seedDeniedContext({ contextId: "ctx_grant_no_admin", contactId: requester.id, chatId: chat.id });

      const result = await authorizeRuntimeContext({
        context,
        permission: "use",
        objectType: "tool",
        objectId: "Bash",
        timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
      });

      expect(result).toMatchObject({ allowed: true, approved: true });
      const blocks = JSON.stringify(deliveredRequests[0]?.data.blocks);
      expect(blocks).not.toContain(SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS);
      expect(blocks).toContain(SLACK_PERMISSION_GRANT_ACTION_EXACT);
      expect(blocks).toContain("Full access is not offered here");
    });

    it("waits on the open card for the same chat, subject and capability instead of sending another", async () => {
      seedSlackOwner();
      const requester = seedRequester();
      const chat = seedGrantChat();
      createApprovalRequest({
        id: "req_existing_grant",
        type: "permission",
        channel: "slack",
        accountId: "main",
        chatId: "C123",
        instanceId: "main",
        sessionName: "dev-main",
        agentId: "dev",
        permission: "use",
        objectType: "tool",
        objectId: "Bash",
        grant: {
          capability: { permission: "use", objectType: "tool", objectId: "Bash" },
          targets: { contactId: requester.id, chatId: chat.id, chatTags: [], agentId: "dev" },
          adminUserIds: [OWNER_SLACK_USER],
          allowed: ["full-access", "exact"],
          scopes: ["chat", "contact"],
        },
        createdAt: APPROVAL_TEST_NOW_MS,
        expiresAt: APPROVAL_TEST_NOW_MS + 9_000,
      });
      attachApprovalRequestMessageId("req_existing_grant", "eph_existing");

      const context = seedDeniedContext({ contextId: "ctx_grant_dedupe", contactId: requester.id, chatId: chat.id });
      const result = await authorizeRuntimeContext({
        context,
        permission: "use",
        objectType: "tool",
        objectId: "Bash",
        timeoutMs: 120,
      });

      expect(deliveredRequests).toEqual([]);
      expect(result).toMatchObject({ allowed: false, approved: false });
      expect(result.reason ?? "").toMatch(/Timeout/);
    });

    it("persists the picked scope and applies the button that follows it", async () => {
      seedSlackOwner();
      const requester = seedRequester();
      const chat = seedGrantChat();
      requestReplyResult = {
        messageId: "eph_1",
        deliveries: [{ userId: OWNER_SLACK_USER, kind: "ephemeral", chatId: "C123", messageId: "eph_1" }],
      };
      subscribeEvents = [
        // The select sends its own interaction; the buttons that follow carry no scope.
        {
          topic: "ravi.inbound.interaction",
          data: {
            provider: "slack",
            accountId: "main",
            instanceId: "main",
            channelId: "C123",
            messageTs: "eph_seen_by_slack",
            userId: OWNER_SLACK_USER,
            actionId: SLACK_PERMISSION_GRANT_ACTION_SCOPE,
            value: "$requestId|contact",
            responseUrlId: "resp_scope",
          },
        },
        slackClick({
          userId: OWNER_SLACK_USER,
          messageTs: "eph_seen_by_slack",
          actionId: SLACK_PERMISSION_GRANT_ACTION_EXACT,
        }),
      ];

      const context = seedDeniedContext({ contextId: "ctx_grant_scope", contactId: requester.id, chatId: chat.id });
      const result = await authorizeRuntimeContext({
        context,
        permission: "use",
        objectType: "tool",
        objectId: "Bash",
        timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
      });

      expect(result).toMatchObject({ allowed: true, approved: true });
      // The card was re-rendered with the picked scope before the button was used.
      expect(respondedSlack.length).toBeGreaterThanOrEqual(1);
      expect(respondedSlack[0]?.responseUrlId).toBe("resp_scope");
      expect(respondedSlack[0]?.payload.replace_original).toBe(true);
      expect(JSON.stringify(respondedSlack[0]?.payload.blocks)).toContain("This contact (all chats)");
      // The decision itself then finalized the clicker's card too.
      expect(respondedSlack[respondedSlack.length - 1]?.payload.text).toContain("Approved by");
      // Contact scope means the global contact tag, not a chat grant.
      expect(getContact(requester.id)?.tags).toContain("permission-use-tool-bash");
      expect(dbListContactChatGrants({ contactId: requester.id })).toEqual([]);
    });

    it("applies the grant once when the same click arrives twice", async () => {
      delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      seedSlackOwner();
      const requester = seedRequester();
      const chat = seedGrantChat();
      requestReplyResult = {
        messageId: "eph_1",
        deliveries: [{ userId: OWNER_SLACK_USER, kind: "ephemeral", chatId: "C123", messageId: "eph_1" }],
      };
      const click = slackClick({
        userId: OWNER_SLACK_USER,
        messageTs: "eph_seen_by_slack",
        actionId: SLACK_PERMISSION_GRANT_ACTION_EXACT,
      });
      subscribeEvents = [click, click];

      const context = seedDeniedContext({ contextId: "ctx_grant_once", contactId: requester.id, chatId: chat.id });
      await authorizeRuntimeContext({
        context,
        permission: "use",
        objectType: "tool",
        objectId: "Bash",
        timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
      });

      const rows = getDb().prepare("SELECT COUNT(*) AS count FROM permission_grant_applications").get() as {
        count: number;
      };
      expect(rows.count).toBe(1);
      await flushPermissionAuditEvents();
      expect(auditEvents.filter((entry) => entry.topic === "ravi.audit.permission_grant")).toHaveLength(1);
    });

    it("does not let the blocked call through when the grant cannot be written", async () => {
      seedSlackOwner();
      const requester = seedRequester();
      const chat = seedGrantChat();
      // A tag with the derived profile name that permissions does not own.
      dbCreateTagDefinition({ slug: "permission-use-tool-bash", label: "Bash fans", kind: "user", source: "manual" });
      requestReplyResult = {
        messageId: "eph_1",
        deliveries: [{ userId: OWNER_SLACK_USER, kind: "ephemeral", chatId: "C123", messageId: "eph_1" }],
      };
      subscribeEvents = [
        slackClick({
          userId: OWNER_SLACK_USER,
          messageTs: "eph_seen_by_slack",
          actionId: SLACK_PERMISSION_GRANT_ACTION_EXACT,
        }),
      ];

      const context = seedDeniedContext({ contextId: "ctx_grant_fails", contactId: requester.id, chatId: chat.id });
      const result = await authorizeRuntimeContext({
        context,
        permission: "use",
        objectType: "tool",
        objectId: "Bash",
        timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
      });

      expect(result).toMatchObject({ allowed: false, approved: false });
      expect(respondedSlack[respondedSlack.length - 1]?.payload.text ?? "").toContain("grant failed");
    });

    it("keeps one card per agent when two agents serve the same contact", () => {
      const base = {
        capability: { permission: "use", objectType: "tool", objectId: "Bash" },
        adminUserIds: [OWNER_SLACK_USER],
        allowed: ["exact"] as const,
        scopes: ["chat"] as const,
      };
      const forAgent = (agentId: string) =>
        ({ ...base, targets: { contactId: "c1", chatId: "chat1", chatTags: [], agentId } }) as never;
      expect(sameGrantTuple(forAgent("dev"), forAgent("dev"))).toBe(true);
      expect(sameGrantTuple(forAgent("dev"), forAgent("ops"))).toBe(false);
    });
  });
});
