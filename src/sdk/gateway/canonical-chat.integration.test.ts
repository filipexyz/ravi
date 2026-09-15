/**
 * End-to-end integration test for canonical chat/message writes over the SDK gateway.
 *
 * Exercises the real registry, HTTP transport, dispatcher authorization, command
 * handlers, and SQLite storage against isolated Ravi state.
 */

import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ChatMessageCommands, ChatsCommands } from "../../cli/commands/chats.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import type { ContextCapability, ContextRecord } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { startGateway, type GatewayHandle } from "./server.js";

const registry = buildRegistry([ChatsCommands, ChatMessageCommands]);
const actorId = "actor-gateway-test";
const agentId = "main";

let stateDir: string | null = null;
let handle: GatewayHandle | null = null;
let ensuredChatId: string | null = null;

function context(contextKey: string, capabilities: ContextCapability[]): ContextRecord {
  return {
    contextId: contextKey.replace(/^rctx_/, "ctx_"),
    contextKey,
    kind: "test-runtime",
    agentId: "gateway-test-agent",
    capabilities,
    metadata: { authorityMode: "delegated" },
    createdAt: Date.now(),
  };
}

const ensureExactContext = context("rctx_chat_ensure_exact", [
  { permission: "mutate", objectType: "agent", objectId: agentId, source: "test" },
]);
const ensureSemanticContext = context("rctx_chat_ensure_semantic", [
  { permission: "mutate", objectType: "agent", objectId: "ensure-chat", source: "test" },
]);
const messageSemanticContext = context("rctx_chat_message_semantic", [
  { permission: "mutate", objectType: "chat", objectId: "create-message", source: "test" },
]);
const messageWrongChatContext = context("rctx_chat_message_wrong", [
  { permission: "mutate", objectType: "chat", objectId: "chat_000000000000000000000000", source: "test" },
]);

function messageExactContext(): ContextRecord | null {
  if (!ensuredChatId) return null;
  return context("rctx_chat_message_exact", [
    { permission: "mutate", objectType: "chat", objectId: ensuredChatId, source: "test" },
  ]);
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sdk-gateway-canonical-chat-");
  ensuredChatId = null;
  handle = startGateway({
    host: "127.0.0.1",
    port: 0,
    registry,
    auth: {
      resolveContext(token) {
        if (token === ensureExactContext.contextKey) return { ...ensureExactContext };
        if (token === ensureSemanticContext.contextKey) return { ...ensureSemanticContext };
        if (token === messageSemanticContext.contextKey) return { ...messageSemanticContext };
        if (token === messageWrongChatContext.contextKey) return { ...messageWrongChatContext };
        if (token === "rctx_chat_message_exact") return messageExactContext();
        return null;
      },
    },
  });
});

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
  ensuredChatId = null;
});

async function post(path: string, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${handle!.url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("gateway — canonical chat and message writes", () => {
  it("requires the concrete agent grant when ensuring a chat", async () => {
    const meta = await fetch(`${handle!.url}/api/v1/_meta/registry`);
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as { commands: Array<{ fullName: string; path: string }> };
    expect(metaBody.commands.find((command) => command.fullName === "chats.messages.create")).toMatchObject({
      fullName: "chats.messages.create",
      path: "/api/v1/chats/messages/create",
    });
    expect(metaBody.commands.some((command) => command.fullName === "chats.messages")).toBe(false);

    const denied = await post("/api/v1/chats/ensure", ensureSemanticContext.contextKey, {
      actorId,
      agentId,
      clientRequestId: "request-denied",
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()) as { error: string }).toMatchObject({
      error: "PermissionDenied",
    });

    const allowed = await post("/api/v1/chats/ensure", ensureExactContext.contextKey, {
      actorId,
      agentId,
      clientRequestId: "request-allowed",
    });
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as {
      disposition: string;
      clientRequestId: string;
      chat: { id: string; actorId?: string; agentId?: string };
    };
    expect(body.disposition).toBe("created");
    expect(body.clientRequestId).toBe("request-allowed");
    expect(body.chat.id).toMatch(/^chat_[0-9a-f]{24}$/);
    expect(body.chat.actorId).toBe(actorId);
    expect(body.chat.agentId).toBe(agentId);
  });

  it("roundtrips idempotent chat and message creation with concrete grants", async () => {
    const firstEnsure = await post("/api/v1/chats/ensure", ensureExactContext.contextKey, {
      actorId,
      agentId,
      clientRequestId: "request-1",
    });
    expect(firstEnsure.status).toBe(200);
    const firstEnsureBody = (await firstEnsure.json()) as {
      disposition: string;
      chat: { id: string };
    };
    ensuredChatId = firstEnsureBody.chat.id;
    expect(firstEnsureBody.disposition).toBe("created");

    const retryEnsure = await post("/api/v1/chats/ensure", ensureExactContext.contextKey, {
      actorId,
      agentId,
      clientRequestId: "request-1",
    });
    expect(retryEnsure.status).toBe(200);
    const retryEnsureBody = (await retryEnsure.json()) as {
      disposition: string;
      chat: { id: string };
    };
    expect(retryEnsureBody.disposition).toBe("existing");
    expect(retryEnsureBody.chat.id).toBe(ensuredChatId);

    const deniedSemantic = await post("/api/v1/chats/messages/create", messageSemanticContext.contextKey, {
      chatId: ensuredChatId,
      actorId,
      clientMessageId: "message-semantic-denied",
      content: "not written",
    });
    expect(deniedSemantic.status).toBe(403);

    const deniedWrongChat = await post("/api/v1/chats/messages/create", messageWrongChatContext.contextKey, {
      chatId: ensuredChatId,
      actorId,
      clientMessageId: "message-wrong-chat-denied",
      content: "not written",
    });
    expect(deniedWrongChat.status).toBe(403);

    const firstMessage = await post("/api/v1/chats/messages/create", "rctx_chat_message_exact", {
      chatId: ensuredChatId,
      actorId,
      clientMessageId: "message-1",
      content: "Hello from the gateway",
    });
    expect(firstMessage.status).toBe(200);
    const firstMessageBody = (await firstMessage.json()) as {
      disposition: string;
      clientMessageId: string;
      messageId: string;
      message: {
        id: string;
        chatId: string;
        actorId?: string;
        revision?: number;
        state?: string;
        content?: Record<string, unknown>;
      };
    };
    expect(firstMessageBody.disposition).toBe("created");
    expect(firstMessageBody.clientMessageId).toBe("message-1");
    expect(firstMessageBody.messageId).toBe(firstMessageBody.message.id);
    expect(firstMessageBody.message.chatId).toBe(ensuredChatId);
    expect(firstMessageBody.message.actorId).toBe(actorId);
    expect(firstMessageBody.message.revision).toBe(1);
    expect(firstMessageBody.message.state).toBe("created");
    expect(firstMessageBody.message.content).toEqual({
      text: "Hello from the gateway",
      type: "text",
    });

    const retryMessage = await post("/api/v1/chats/messages/create", "rctx_chat_message_exact", {
      chatId: ensuredChatId,
      actorId,
      clientMessageId: "message-1",
      content: "Hello from the gateway",
    });
    expect(retryMessage.status).toBe(200);
    const retryMessageBody = (await retryMessage.json()) as {
      disposition: string;
      messageId: string;
    };
    expect(retryMessageBody.disposition).toBe("duplicate");
    expect(retryMessageBody.messageId).toBe(firstMessageBody.messageId);
  });
});
