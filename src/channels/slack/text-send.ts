import { configStore } from "../../config-store.js";
import type { ChannelConfig } from "../../router/router-db.js";
import { findNativeChannelAccount } from "../account-resolution.js";
import type { SlackBlockKitBlock } from "./block-kit.js";
import { SlackWebApiClient } from "./client.js";
import { resolveSlackCredentialConfigFromEnv, type SlackCredentialResolver } from "./credentials.js";
import { postSlackMarkdown, updateSlackMarkdown } from "./markdown-delivery.js";
import { markdownToSlackMrkdwn } from "./mrkdwn.js";

export interface SlackTextSendInput {
  readonly accountId: string;
  readonly chatId: string;
  readonly text: string;
  readonly threadId?: string;
  readonly blocks?: readonly SlackBlockKitBlock[];
  /** Set false so Slack does not fetch links in the message (for single-use URLs). */
  readonly unfurlLinks?: boolean;
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
  if (!input.text.trim()) {
    throw new Error("Slack text is required");
  }

  const client = await createSlackTextClient(input.accountId, "chat.postMessage", dependencies);
  const destination = {
    channel: input.chatId,
    ...(input.threadId ? { threadTs: input.threadId } : {}),
    ...(input.unfurlLinks === false ? { unfurlLinks: false } : {}),
  };
  // Caller-built blocks go as they are; plain Markdown is laid out as Block Kit.
  const result = input.blocks
    ? await client.postMessage({
        ...destination,
        text: markdownToSlackMrkdwn(input.text).trim(),
        blocks: input.blocks,
        ...(input.unfurlLinks === false ? { unfurlMedia: false } : {}),
      })
    : (
        await postSlackMarkdown(client, {
          ...destination,
          markdown: input.text,
          allowDocuments: input.unfurlLinks !== false,
        })
      ).first;

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
  if (!input.text.trim()) {
    throw new Error("Slack text is required");
  }
  const messageId = input.messageId.trim();
  if (!messageId) {
    throw new Error("Slack message id is required");
  }

  const client = await createSlackTextClient(input.accountId, "chat.update", dependencies);
  const result = input.blocks
    ? await client.updateMessage({
        channel: input.chatId,
        ts: messageId,
        text: markdownToSlackMrkdwn(input.text).trim(),
        blocks: input.blocks,
      })
    : await updateSlackMarkdown(client, { channel: input.chatId, ts: messageId, markdown: input.text });

  return {
    transport: "slack-native",
    provider: "slack",
    success: true,
    status: "updated",
    messageId: result.messageId,
    raw: result.raw,
  };
}

export interface SlackPrivateCardInput {
  readonly accountId: string;
  readonly chatId: string;
  readonly threadId?: string;
  readonly userIds: readonly string[];
  readonly text: string;
  readonly blocks: readonly SlackBlockKitBlock[];
}

export interface SlackPrivateCardDelivery {
  readonly userId: string;
  /** `ephemeral`: only that person sees it, in `chatId`. `dm`: in their DM with the app. */
  readonly kind: "ephemeral" | "dm";
  readonly chatId: string;
  readonly messageId: string;
}

export interface SlackPrivateCardResult {
  readonly deliveries: SlackPrivateCardDelivery[];
  readonly failures: Array<{ readonly userId: string; readonly error: string }>;
}

/**
 * Sends one card privately to each person: an ephemeral message in the chat
 * (thread included) when Slack accepts it, otherwise a message in their DM with
 * the app. Nobody else sees the card.
 */
export async function sendSlackPrivateCards(
  input: SlackPrivateCardInput,
  dependencies: SlackTextSendDependencies = {},
): Promise<SlackPrivateCardResult> {
  const text = markdownToSlackMrkdwn(input.text).trim();
  if (!text) {
    throw new Error("Slack text is required");
  }
  const client = await createSlackTextClient(input.accountId, "chat.postEphemeral", dependencies);
  const deliveries: SlackPrivateCardDelivery[] = [];
  const failures: Array<{ userId: string; error: string }> = [];
  for (const userId of input.userIds) {
    let ephemeralError: string | undefined;
    try {
      const ephemeral = await client.postEphemeral({
        channel: input.chatId,
        user: userId,
        text,
        blocks: input.blocks,
        ...(input.threadId ? { threadTs: input.threadId } : {}),
      });
      deliveries.push({ userId, kind: "ephemeral", chatId: input.chatId, messageId: ephemeral.messageId });
      continue;
    } catch (error) {
      // Usually `user_not_in_channel` / `channel_not_found`: the person cannot
      // see the chat. Any refusal still leaves their DM, which stays private.
      ephemeralError = error instanceof Error ? error.message : String(error);
    }
    try {
      // Posting to a user id lands in that person's DM with the app.
      const direct = await client.postMessage({ channel: userId, text, blocks: input.blocks });
      deliveries.push({ userId, kind: "dm", chatId: direct.channel, messageId: direct.messageId });
    } catch (error) {
      const dmError = error instanceof Error ? error.message : String(error);
      failures.push({ userId, error: ephemeralError ? `${ephemeralError}; DM: ${dmError}` : dmError });
    }
  }
  return { deliveries, failures };
}

/**
 * Email on the Slack profile of `userId`, or null when the app cannot read it
 * (no `users:read.email` scope, a bot, or a hidden email).
 */
export async function lookupSlackUserEmail(
  input: { readonly accountId: string; readonly userId: string },
  dependencies: SlackTextSendDependencies = {},
): Promise<string | null> {
  const client = await createSlackTextClient(input.accountId, "users.info", dependencies);
  const response = await client.usersInfo(input.userId);
  const user = asRecord(response.user);
  if (!user || user.is_bot === true || user.deleted === true) return null;
  const email = asRecord(user.profile)?.email;
  return typeof email === "string" && email.includes("@") ? email.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function createSlackTextClient(
  accountId: string,
  action: "chat.postMessage" | "chat.postEphemeral" | "chat.update" | "users.info",
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
