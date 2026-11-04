import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  dbAcceptChannelBackendIngress,
  dbCreateAgent,
  dbUpsertChat,
  dbUpsertChatMessage,
  type ChannelBackendIngressReceiptRecord,
  type ChatMessageRecord,
} from "../../router/router-db.js";
import type { ChannelBackendPromptMetadata } from "../../runtime/message-types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { resolveOutboundAccount, type OutboundAccountConfig } from "../account-resolution.js";
import { buildChannelOutboundJobFromResponse, buildChannelTextOutboundJob } from "../outbound-stream.js";
import {
  createChannelBackendAutomaticOutputOrigin,
  resolveSlackAutomaticOutputContext,
  resolveSlackAutomaticOutputContextFromBinding,
  SlackAutomaticOutputOriginError,
} from "./automatic-output-origin.js";

const config: OutboundAccountConfig = {
  channels: {
    local: { name: "local", provider: "slack", credentialConnection: "installation-a", createdAt: 0, updatedAt: 0 },
    other: { name: "other", provider: "slack", credentialConnection: "installation-b", createdAt: 0, updatedAt: 0 },
  },
  instances: {
    local: {
      name: "local",
      instanceId: "instance-alias",
      channel: "slack",
      dmPolicy: "open",
      groupPolicy: "open",
      contactIntakeMode: "off",
      createdAt: 0,
      updatedAt: 0,
    },
  },
  instanceToAccount: { "instance-alias": "local" },
};

function fixture() {
  const binding: ChannelBackendPromptMetadata["binding"] = {
    channelInstanceId: "local",
    agentId: "agent-a",
    chatId: "chat-a",
    messageId: "input-a",
    sessionId: "session-a",
    turnId: "turn-a",
  };
  const receipt: ChannelBackendIngressReceiptRecord = {
    id: "receipt-a",
    channelInstanceId: binding.channelInstanceId,
    idempotencyKey: "ingress-a",
    requestFingerprint: "fingerprint-a",
    initialRequestId: "request-a",
    localActorId: "unknown-bot-a",
    agentId: binding.agentId,
    chatId: binding.chatId,
    messageId: binding.messageId,
    sessionKey: "agent:agent-a:slack:local:group:C123",
    sessionName: binding.sessionId,
    turnId: binding.turnId,
    external: {
      channelKind: "slack",
      connectionId: "installation-a",
      conversationId: "C123~1.000001",
      senderId: "B123",
      messageId: "1.000001",
    },
    state: "published",
    acceptedAt: 10_000,
    updatedAt: 99_000,
  };
  const message: ChatMessageRecord = {
    id: binding.messageId,
    chatId: binding.chatId,
    channel: "slack",
    instanceId: binding.channelInstanceId,
    providerMessageId: receipt.external.messageId,
    rawChatId: "C123",
    actorType: "unknown",
    rawProvenance: { source: "slack.socket_mode", senderKind: "bot" },
    providerTimestamp: 1,
    ingestedAt: 9_000,
    createdAt: 9_000,
    updatedAt: 99_000,
  };
  const dependencies = {
    getReceipt: () => receipt,
    getMessage: () => message,
    resolveAccount: (accountId: string) => resolveOutboundAccount(accountId, { channel: "slack", config }),
  };
  return { binding, receipt, message, dependencies };
}

describe("trusted Slack automatic output origin", () => {
  it("uses canonical bot provenance and local receipt acceptance time, including unknown bots", () => {
    const { binding, dependencies } = fixture();
    expect(resolveSlackAutomaticOutputContextFromBinding(binding, dependencies)).toEqual({
      turnId: "turn-a",
      sourceId: "input-a",
      sourceReceivedAt: 10_000,
      senderKind: "bot",
      scope: JSON.stringify(["slack", "installation-a", "C123"]),
      target: {
        channel: "slack",
        accountId: "local",
        instanceId: "local",
        chatId: "C123",
        threadId: "1.000001",
        canonicalChatId: "chat-a",
      },
    });
  });

  it("keeps unknown humans human and never treats actor authority as sender kind", () => {
    const { binding, message, dependencies } = fixture();
    message.rawProvenance = { source: "slack.socket_mode", senderKind: "user" };
    for (const actorType of ["unknown", "contact", "agent", "system"]) {
      message.actorType = actorType;
      expect(resolveSlackAutomaticOutputContextFromBinding(binding, dependencies)).toBeNull();
    }
  });

  it("fails closed for missing/malformed native provenance and every mismatching binding field", () => {
    const { binding, message, dependencies } = fixture();
    for (const field of Object.keys(binding) as Array<keyof typeof binding>) {
      expect(() =>
        resolveSlackAutomaticOutputContextFromBinding({ ...binding, [field]: "changed" }, dependencies),
      ).toThrow(SlackAutomaticOutputOriginError);
    }
    for (const rawProvenance of [{}, { source: "slack.socket_mode" }, { source: "untrusted", senderKind: "bot" }]) {
      message.rawProvenance = rawProvenance;
      expect(() => resolveSlackAutomaticOutputContextFromBinding(binding, dependencies)).toThrow(
        SlackAutomaticOutputOriginError,
      );
    }
    expect(() =>
      resolveSlackAutomaticOutputContextFromBinding(binding, { ...dependencies, getReceipt: () => null }),
    ).toThrow(SlackAutomaticOutputOriginError);
  });

  it("validates the canonical input independently of the receipt", () => {
    for (const field of ["id", "chatId", "instanceId", "channel", "providerMessageId", "rawChatId"] as const) {
      const { binding, message, dependencies } = fixture();
      message[field] = "changed";
      expect(() => resolveSlackAutomaticOutputContextFromBinding(binding, dependencies)).toThrow(
        SlackAutomaticOutputOriginError,
      );
    }
  });

  it("shares installation/channel scope across aliases, sessions, roots and threads", () => {
    const { binding, receipt, message, dependencies } = fixture();
    const original = resolveSlackAutomaticOutputContextFromBinding(binding, dependencies)!;
    for (const alias of ["local", "installation-a", "instance-alias", "LOCAL"]) {
      receipt.external.connectionId = alias;
      for (const conversationId of ["C123", "C123~2.000001"]) {
        receipt.external.conversationId = conversationId;
        const context = resolveSlackAutomaticOutputContextFromBinding(binding, dependencies)!;
        expect(context.scope).toBe(original.scope);
        expect(context.target.threadId).toBe(conversationId.includes("~") ? "2.000001" : undefined);
      }
    }
    binding.sessionId = receipt.sessionName = "renamed-session";
    expect(resolveSlackAutomaticOutputContextFromBinding(binding, dependencies)!.scope).toBe(original.scope);
    receipt.external.connectionId = "other";
    expect(() => resolveSlackAutomaticOutputContextFromBinding(binding, dependencies)).toThrow(
      SlackAutomaticOutputOriginError,
    );
    binding.channelInstanceId = receipt.channelInstanceId = message.instanceId = "other";
    expect(resolveSlackAutomaticOutputContextFromBinding(binding, dependencies)!.scope).not.toBe(original.scope);
  });

  it("propagates a copied source binding independently of response target and later turn changes", () => {
    const { binding, dependencies } = fixture();
    const originalBinding = { ...binding };
    const context = resolveSlackAutomaticOutputContextFromBinding(binding, dependencies)!;
    const origin = createChannelBackendAutomaticOutputOrigin(binding);
    const result = buildChannelOutboundJobFromResponse("session-a", {
      response: "Late answer",
      _emitId: "emit-a",
      target: context.target,
      _automaticOutputOrigin: origin,
      _automaticTerminalResponseId: "terminal-a",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    binding.turnId = "newer-human-turn";
    expect(result.job.request.origin.automatic?.binding).toEqual(originalBinding);
    expect(result.job.request.origin.automaticTerminalResponseId).toBe("terminal-a");
    expect(resolveSlackAutomaticOutputContext(result.job, dependencies)?.turnId).toBe("turn-a");
  });

  it("accepts destination aliases but rejects rerouting and new thread escapes", () => {
    const { binding, dependencies } = fixture();
    const context = resolveSlackAutomaticOutputContextFromBinding(binding, dependencies)!;
    const job = buildChannelTextOutboundJob({
      requestId: "request",
      sessionName: "session",
      emitId: "emit",
      idempotencyKey: "unit",
      target: { ...context.target, accountId: "installation-a", instanceId: "instance-alias" },
      text: "Terminal",
      automatic: createChannelBackendAutomaticOutputOrigin(binding),
    });
    expect(resolveSlackAutomaticOutputContext(job, dependencies)).toEqual(context);
    for (const target of [
      { ...job.request.target, chatId: "C456" },
      { ...job.request.target, threadId: "9.999999" },
      { ...job.request.target, accountId: "other" },
    ]) {
      expect(() =>
        resolveSlackAutomaticOutputContext({ ...job, request: { ...job.request, target } }, dependencies),
      ).toThrow(SlackAutomaticOutputOriginError);
    }
  });

  it("leaves explicit actions and unrelated native outputs outside the automatic projection", () => {
    const { binding, receipt, dependencies } = fixture();
    const job = buildChannelTextOutboundJob({
      requestId: "explicit",
      sessionName: "session",
      emitId: "explicit",
      idempotencyKey: "explicit",
      target: { channel: "slack", accountId: "local", chatId: "C123" },
      text: "Authorized direct action",
    });
    expect(resolveSlackAutomaticOutputContext(job, dependencies)).toBeNull();
    receipt.external.channelKind = "other";
    expect(resolveSlackAutomaticOutputContextFromBinding(binding, dependencies)).toBeNull();
    job.request.origin.automaticTerminalResponseId = "forged-terminal";
    expect(() => resolveSlackAutomaticOutputContext(job, dependencies)).toThrow(SlackAutomaticOutputOriginError);
  });
});

describe("durable native input resolution", () => {
  let stateDir: string | null = null;
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("slack-output-origin-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("leaves generic actor-authored backend input outside Socket Mode automatic replies", () => {
    dbCreateAgent({ id: "agent-a", name: "Agent A", cwd: "/tmp/slack-output-origin" });
    const { receipt } = fixture();
    const accepted = dbAcceptChannelBackendIngress({
      channelInstanceId: "local",
      idempotencyKey: "generic",
      requestFingerprint: "fingerprint",
      requestId: "request",
      localActorId: "local-actor",
      agentId: "agent-a",
      clientMessageId: "client",
      sessionKey: receipt.sessionKey,
      sessionName: "session-a",
      turnId: "turn-a",
      external: receipt.external,
      content: { text: "Generic local actor input" },
      receivedAt: 1,
    });
    const saved = accepted.receipt;
    expect(
      resolveSlackAutomaticOutputContextFromBinding({
        channelInstanceId: saved.channelInstanceId,
        agentId: saved.agentId,
        chatId: saved.chatId,
        messageId: saved.messageId,
        sessionId: saved.sessionName,
        turnId: saved.turnId,
      }),
    ).toBeNull();
  });

  it("reads the ingress receipt and canonical message instead of session latest source", () => {
    dbCreateAgent({ id: "agent-a", name: "Agent A", cwd: "/tmp/slack-output-origin" });
    const chat = dbUpsertChat({ channel: "slack", instanceId: "local", platformChatId: "C123", chatType: "group" });
    const message = dbUpsertChatMessage({
      chatId: chat.id,
      channel: "slack",
      instanceId: "local",
      providerMessageId: "1.000001",
      rawChatId: "C123",
      actorType: "unknown",
      rawProvenance: { source: "slack.socket_mode", senderKind: "bot" },
    });
    const { receipt, dependencies } = fixture();
    const accepted = dbAcceptChannelBackendIngress({
      channelInstanceId: "local",
      idempotencyKey: "input",
      requestFingerprint: "fingerprint",
      requestId: "request",
      localActorId: "bot",
      agentId: "agent-a",
      clientMessageId: "client",
      sessionKey: receipt.sessionKey,
      sessionName: "session-a",
      turnId: "turn-a",
      external: receipt.external,
      content: {},
      receivedAt: 1,
      acceptedAt: 20_000,
      canonical: { chatId: chat.id, messageId: message.canonicalMessageId },
    });
    expect(accepted.status).toBe("accepted");
    const binding = {
      channelInstanceId: "local",
      agentId: "agent-a",
      chatId: chat.id,
      messageId: message.canonicalMessageId,
      sessionId: "session-a",
      turnId: "turn-a",
    };
    const context = resolveSlackAutomaticOutputContextFromBinding(binding, {
      resolveAccount: dependencies.resolveAccount,
    });
    expect(context?.sourceId).toBe(message.canonicalMessageId);
    expect(context?.sourceReceivedAt).toBe(20_000);
  });
});
