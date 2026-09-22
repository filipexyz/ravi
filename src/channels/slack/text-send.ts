import { configStore } from "../../config-store.js";
import type { ChannelConfig } from "../../router/router-db.js";
import { findNativeChannelAccount } from "../account-resolution.js";
import { SlackWebApiClient } from "./client.js";
import { resolveSlackCredentialConfigFromEnv, type SlackCredentialResolver } from "./credentials.js";

export interface SlackTextSendInput {
  readonly accountId: string;
  readonly chatId: string;
  readonly text: string;
  readonly threadId?: string;
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
  readonly status: "sent";
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

  const channels = dependencies.channels ?? configStore.getConfig().channels ?? {};
  const channel = resolveSlackNativeChannel(channels, input.accountId);
  if (!channel) {
    throw new Error(`Slack channel not configured for account "${input.accountId}".`);
  }

  const credentials = await resolveSlackCredentialConfigFromEnv(process.env, {
    action: "chat.postMessage",
    channel,
    channels,
    resolveSecret: dependencies.resolveSecret,
  });
  if (!credentials) {
    throw new Error(`Slack credentials not configured for channel "${channel.name}".`);
  }

  const client = new SlackWebApiClient({
    appToken: credentials.appToken,
    botToken: credentials.botToken,
    apiBaseUrl: dependencies.apiBaseUrl ?? credentials.apiBaseUrl,
    fileProxyUrl: credentials.fileProxyUrl,
    defaultHeaders: credentials.requestHeaders,
    fetchImpl: dependencies.fetchImpl,
  });
  const result = await client.postMessage({
    channel: input.chatId,
    text,
    ...(input.threadId ? { threadTs: input.threadId } : {}),
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
