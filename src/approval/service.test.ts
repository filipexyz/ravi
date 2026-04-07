import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let requestReplyResult: { messageId?: string } = { messageId: "msg_1" };
let subscribeEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
let emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
const createdContextIds = new Set<string>();

mock.module("../utils/request-reply.js", () => ({
  requestReply: async () => requestReplyResult,
}));

mock.module("../nats.js", () => ({
  nats: {
    emit: async (topic: string, data: Record<string, unknown>) => {
      emitted.push({ topic, data });
    },
    subscribe: (...topics: string[]) =>
      (async function* () {
        for (const event of subscribeEvents) {
          if (topics.includes(event.topic)) {
            yield event;
          }
        }
      })(),
  },
}));

const { authorizeRuntimeContext } = await import("./service.js");
const { dbCreateContext, dbDeleteContext, dbGetContext } = await import("../router/router-db.js");

describe("approval service", () => {
  beforeEach(() => {
    requestReplyResult = { messageId: "msg_1" };
    subscribeEvents = [];
    emitted = [];
  });

  afterEach(() => {
    for (const contextId of createdContextIds) {
      dbDeleteContext(contextId);
    }
    createdContextIds.clear();
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
    expect(emitted.map((entry) => entry.topic)).toEqual(["ravi.approval.request", "ravi.approval.response"]);
  });

  it("fails closed when no approval source is available", async () => {
    const context = dbCreateContext({
      contextId: "ctx_3",
      contextKey: "rctx_3",
      kind: "agent-runtime",
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
  });
});
