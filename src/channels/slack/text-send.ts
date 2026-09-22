import { configStore } from "../../config-store.js";
import type { ChannelConfig } from "../../router/router-db.js";
import { findNativeChannelAccount } from "../account-resolution.js";
import type { SlackBlockKitBlock } from "./block-kit.js";
import { SlackWebApiClient } from "./client.js";
import { resolveSlackCredentialConfigFromEnv, type SlackCredentialResolver } from "./credentials.js";

export interface SlackTextSendInput {
  readonly accountId: string;
  readonly chatId: string;
  readonly text: string;
  readonly threadId?: string;
  readonly blocks?: readonly SlackBlockKitBlock[];
}

export interface SlackTextUpdateInput {
  readonly accountId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly text: string;
  readonly blocks?: readonly SlackBlockKitBlock[];
}

export interface SlackTextSendDependencies {
  readonly channels?: Record<string, ChannelConfig>;
  readonly resolveSecret?: SlackCredentialResolver;
  readonly fetchImpl?: typeof fetch;
  readonly apiBaseUrl?: string;
}

export interface SlackNativeTextDelivery {
  readonly transport: "slack-native";
  readonly provider: "slack";
  readonly success: true;
  readonly status: "sent" | "updated";
  readonly messageId: string;
  readonly raw: Record<string, unknown>;
}

export function resolveSlackNativeChannel(
  channels: Record<string, ChannelConfig>,
  accountId: string,
): ChannelConfig | undefined {
  return findNativeChannelAccount(channels, accountId, { provider: "slack" });
}

export async function sendSlackText(
  input: SlackTextSendInput,
  dependencies: SlackTextSendDependencies = {},
): Promise<SlackNativeTextDelivery> {
  const text = input.text.trim();
  if (!text) {
    throw new Error("Slack text is required");
  }

  const client = await createSlackTextClient(input.accountId, "chat.postMessage", dependencies);
  const result = await client.postMessage({
    channel: input.chatId,
    text,
    ...(input.threadId ? { threadTs: input.threadId } : {}),
    ...(input.blocks ? { blocks: input.blocks } : {}),
  });

  return {
    transport: "slack-native",
    provider: "slack",
    success: true,
    status: "sent",
    messageId: result.messageId,
    raw: result.raw,
  };
}

export async function updateSlackText(
  input: SlackTextUpdateInput,
  dependencies: SlackTextSendDependencies = {},
): Promise<SlackNativeTextDelivery> {
  const text = input.text.trim();
  if (!text) {
    throw new Error("Slack text is required");
  }
  const messageId = input.messageId.trim();
  if (!messageId) {
    throw new Error("Slack message id is required");
  }

  const client = await createSlackTextClient(input.accountId, "chat.update", dependencies);
  const result = await client.updateMessage({
    channel: input.chatId,
    ts: messageId,
    text,
    ...(input.blocks ? { blocks: input.blocks } : {}),
  });

  return {
    transport: "slack-native",
    provider: "slack",
    success: true,
    status: "updated",
    messageId: result.messageId,
    raw: result.raw,
  };
}

async function createSlackTextClient(
  accountId: string,
  action: "chat.postMessage" | "chat.update",
  dependencies: SlackTextSendDependencies,
): Promise<SlackWebApiClient> {
  const channels = dependencies.channels ?? configStore.getConfig().channels ?? {};
  const channel = resolveSlackNativeChannel(channels, accountId);
  if (!channel) {
    throw new Error(`Slack channel not configured for account "${accountId}".`);
  }

  const credentials = await resolveSlackCredentialConfigFromEnv(process.env, {
    action,
    channel,
    channels,
    resolveSecret: dependencies.resolveSecret,
  });
  if (!credentials) {
    throw new Error(`Slack credentials not configured for channel "${channel.name}".`);
  }

  return new SlackWebApiClient({
    appToken: credentials.appToken,
    botToken: credentials.botToken,
    apiBaseUrl: dependencies.apiBaseUrl ?? credentials.apiBaseUrl,
    fileProxyUrl: credentials.fileProxyUrl,
    defaultHeaders: credentials.requestHeaders,
    fetchImpl: dependencies.fetchImpl,
  });
}
