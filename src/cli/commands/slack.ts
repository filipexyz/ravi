/**
 * Slack Commands - native Slack operations through Ravi channel credentials.
 */

import "reflect-metadata";
import { z } from "zod";
import { SlackWebApiClient } from "../../channels/slack/client.js";
import { SlackSocketModeService } from "../../channels/slack/socket-mode.js";
import { buildSlackTopology } from "../../channels/slack/topology.js";
import type { SlackSocketEnvelope } from "../../channels/slack/types.js";
import { configStore } from "../../config-store.js";
import { getContact } from "../../contacts.js";
import { resolveSlackCredentialConfigFromEnv, type SlackCredentialConfig } from "../../channels/slack/credentials.js";
import { dbFindChat, dbFindChatMessage } from "../../router/router-db.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { jsonObjectSchema, jsonValueSchema } from "../return-schemas.js";

const slackPaginationReturnSchema = z
  .object({
    limit: z.number(),
    cursor: z.string().nullable(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();

const slackListReturnSchema = z
  .object({
    ok: z.boolean(),
    provider: z.literal("slack"),
    connection: z.string(),
    source: z.string(),
    items: z.array(jsonValueSchema),
    pagination: slackPaginationReturnSchema,
    raw: jsonObjectSchema.optional(),
  })
  .strict();

const slackObjectReturnSchema = z
  .object({
    ok: z.boolean(),
    provider: z.literal("slack"),
    connection: z.string(),
    source: z.string(),
    item: jsonValueSchema.optional(),
    raw: jsonObjectSchema.optional(),
  })
  .strict();

const slackMutationReturnSchema = z
  .object({
    ok: z.boolean(),
    provider: z.literal("slack"),
    connection: z.string(),
    source: z.string(),
    dryRun: z.boolean(),
    method: z.string(),
    request: jsonObjectSchema,
    item: jsonValueSchema.optional(),
    raw: jsonObjectSchema.optional(),
  })
  .strict();

const slackTopologyReturnSchema = z
  .object({
    ok: z.literal(true),
    provider: z.literal("slack"),
    connection: z.string(),
    source: z.string(),
    accountId: z.string(),
    channels: z.array(jsonValueSchema),
    ungroupedChannelIds: z.array(z.string()),
    capabilities: jsonObjectSchema,
  })
  .strict();

interface SlackOpsContext {
  client: SlackWebApiClient;
  config: SlackCredentialConfig;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`Invalid positive integer: ${value}`);
  return parsed;
}

function buildCredentialEnv(connection?: string): NodeJS.ProcessEnv {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  const context = getContext();
  const sourceConnection =
    context?.source?.channel === "slack" && context.source.accountId ? context.source.accountId : undefined;
  const resolvedConnection = connection?.trim() || env.RAVI_SLACK_CONNECTION || sourceConnection;
  if (resolvedConnection) env.RAVI_SLACK_CONNECTION = resolvedConnection;
  return env;
}

async function createSlackOpsContext(connection: string | undefined, action: string): Promise<SlackOpsContext> {
  const config = await resolveSlackCredentialConfigFromEnv(buildCredentialEnv(connection), { action });
  if (!config) {
    fail("Slack credentials not configured. Set RAVI_SLACK_CONNECTION or run from a Slack-sourced context.");
  }
  return {
    config,
    client: new SlackWebApiClient({
      appToken: config.appToken,
      botToken: config.botToken,
    }),
  };
}

function connectionLabel(config: SlackCredentialConfig): string {
  return config.accountId || config.instanceId;
}

function pagination(limit: number, cursor: string | undefined, nextCursor: unknown, hasMore?: boolean) {
  const next = typeof nextCursor === "string" && nextCursor.trim() ? nextCursor.trim() : undefined;
  return {
    limit,
    cursor: cursor || null,
    nextCursor: next ?? null,
    hasMore: Boolean(hasMore ?? next),
  };
}

function summarizeConversation(item: unknown): string {
  if (!item || typeof item !== "object") return String(item);
  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "?";
  const name = typeof record.name === "string" ? record.name : typeof record.user === "string" ? record.user : "";
  const flags = [
    record.is_channel ? "channel" : null,
    record.is_group ? "private" : null,
    record.is_im ? "dm" : null,
    record.is_archived ? "archived" : null,
  ].filter(Boolean);
  return [id, name, flags.length ? `(${flags.join(",")})` : ""].filter(Boolean).join(" ");
}

function parseCsvOption(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

function parseRequiredCsvOption(value: string, label: string): string[] {
  const items = parseCsvOption(value);
  if (!items) fail(`Missing ${label}`);
  return items;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function slackTsToEventTime(ts: string): number {
  const parsed = Number(ts);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : Math.trunc(Date.now() / 1000);
}

async function fetchSlackMessageByTs(
  client: SlackWebApiClient,
  channel: string,
  ts: string,
): Promise<Record<string, unknown> | null> {
  const raw = await client.conversationsHistory({
    channel,
    latest: ts,
    oldest: ts,
    inclusive: true,
    limit: 10,
  });
  const messages = raw.messages ?? [];
  return (
    messages.find((message): message is Record<string, unknown> => {
      return Boolean(
        message &&
          typeof message === "object" &&
          !Array.isArray(message) &&
          stringField(message as Record<string, unknown>, "ts") === ts,
      );
    }) ?? null
  );
}

export function buildSlackReplayEnvelope(input: {
  connection: string;
  channel: string;
  message: Record<string, unknown>;
}): SlackSocketEnvelope {
  const ts = stringField(input.message, "ts");
  if (!ts) throw new Error("Slack message is missing ts");
  const event = {
    ...input.message,
    type: stringField(input.message, "type") ?? "message",
    channel: input.channel,
    channel_type: stringField(input.message, "channel_type") ?? "channel",
    ts,
  };
  return {
    envelope_id: `replay:${input.connection}:${input.channel}:${ts}`,
    type: "events_api",
    payload: {
      type: "event_callback",
      team_id: stringField(input.message, "team"),
      event_id: `replay:${input.channel}:${ts}`,
      event_time: slackTsToEventTime(ts),
      event,
    },
  };
}

function summarizeSlackFile(file: unknown): Record<string, unknown> {
  if (!file || typeof file !== "object" || Array.isArray(file)) return { type: typeof file };
  const record = file as Record<string, unknown>;
  return {
    id: stringField(record, "id") ?? null,
    name: stringField(record, "name") ?? null,
    title: stringField(record, "title") ?? null,
    mimeType: stringField(record, "mimetype") ?? null,
    fileType: stringField(record, "filetype") ?? null,
    slackSubtype: stringField(record, "subtype") ?? null,
    mediaDisplayType: stringField(record, "media_display_type") ?? null,
    sizeBytes: numberField(record, "size") ?? null,
    durationMs: numberField(record, "duration_ms") ?? null,
  };
}

function summarizeSlackMessage(message: Record<string, unknown>): Record<string, unknown> {
  const text = stringField(message, "text") ?? "";
  const files = Array.isArray(message.files) ? message.files.map(summarizeSlackFile) : [];
  return {
    ts: stringField(message, "ts") ?? null,
    type: stringField(message, "type") ?? null,
    subtype: stringField(message, "subtype") ?? null,
    user: stringField(message, "user") ?? null,
    threadTs: stringField(message, "thread_ts") ?? null,
    hasText: text.trim().length > 0,
    textLength: text.length,
    files,
  };
}

function findLocalSlackMessage(config: SlackCredentialConfig, channel: string, message: Record<string, unknown>) {
  const ts = stringField(message, "ts");
  if (!ts) return { chat: null, message: null };
  const instanceId = config.instanceId || config.accountId;
  const channelType = stringField(message, "channel_type") ?? "channel";
  const threadTs = stringField(message, "thread_ts");
  const routeThreadTs = threadTs && threadTs !== ts ? threadTs : undefined;
  const chatType = routeThreadTs ? "thread" : channelType === "im" ? "dm" : "group";
  const platformChatId = routeThreadTs ? `${channel}#${routeThreadTs}` : channel;
  const chat = dbFindChat({
    channel: "slack",
    instanceId,
    platformChatId,
    chatType,
  });
  const stored = chat
    ? dbFindChatMessage({
        channel: "slack",
        instanceId,
        chatId: chat.id,
        providerMessageId: ts,
      })
    : null;
  return {
    chat: chat
      ? {
          id: chat.id,
          platformChatId: chat.platformChatId,
          chatType: chat.chatType,
        }
      : null,
    message: stored
      ? {
          id: stored.id,
          providerMessageId: stored.providerMessageId,
          messageType: stored.messageType,
          actorType: stored.actorType,
          ingestedAt: stored.ingestedAt,
          updatedAt: stored.updatedAt,
        }
      : null,
  };
}

@Group({
  name: "slack",
  description: "Native Slack workspace operations",
  scope: "admin",
})
export class SlackCommands {
  @Command({ name: "permissions-list", description: "List OAuth scopes granted to the configured Slack bot token" })
  @CommandAccess({ kind: "read", resource: "slack.permissions", action: "list", risk: "low" })
  @Returns(slackObjectReturnSchema)
  async permissionsList(
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const { client, config } = await createSlackOpsContext(connection, "auth.test");
    const raw = await client.authTest();
    const scopes = raw.scopes ?? [];
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      item: {
        team: raw.team,
        teamId: raw.team_id,
        user: raw.user,
        userId: raw.user_id,
        botId: raw.bot_id,
        scopes,
        acceptedScopes: raw.acceptedScopes ?? [],
      },
      raw,
    };
    if (asJson) printJson(payload);
    else {
      for (const scope of scopes) console.log(scope);
    }
    return payload;
  }

  @Command({ name: "channels-list", description: "List Slack conversations visible to the configured bot" })
  @CommandAccess({ kind: "read", resource: "slack.channels", action: "list", risk: "low" })
  @Returns(slackListReturnSchema)
  async channelsList(
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({
      flags: "--types <types>",
      description: "Slack conversation types",
      defaultValue: "public_channel,private_channel,im,mpim",
    })
    types?: string,
    @Option({ flags: "--limit <n>", description: "Page size", defaultValue: "100" }) limitValue?: string,
    @Option({ flags: "--cursor <cursor>", description: "Slack pagination cursor" }) cursor?: string,
    @Option({ flags: "--include-archived", description: "Include archived conversations" }) includeArchived?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const limit = parsePositiveInt(limitValue, 100);
    const { client, config } = await createSlackOpsContext(connection, "conversations.list");
    const raw = await client.conversationsList({
      types,
      limit,
      cursor,
      excludeArchived: !includeArchived,
    });
    const items = raw.channels ?? [];
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      items,
      pagination: pagination(limit, cursor, raw.response_metadata?.next_cursor),
      raw,
    };
    if (asJson) printJson(payload);
    else {
      for (const item of items) console.log(summarizeConversation(item));
    }
    return payload;
  }

  @Command({ name: "messages-send", description: "Send a Slack message; dry-run unless --execute is set" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.messages",
    action: "send",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async messagesSend(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("text", { description: "Message text" }) text: string,
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({ flags: "--thread-ts <ts>", description: "Send inside a Slack thread" }) threadTs?: string,
    @Option({ flags: "--execute", description: "Perform the mutation; default is dry-run" }) execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const request = { channel, text, ...(threadTs ? { threadTs } : {}) };
    const { client, config } = await createSlackOpsContext(connection, "chat.postMessage");
    if (!execute) return this.printMutationDryRun(config, "chat.postMessage", request, asJson);
    const raw = await client.postMessage(request);
    const payload = this.mutationPayload(config, false, "chat.postMessage", request, raw, raw.raw);
    if (asJson) printJson(payload);
    else console.log(`${raw.channel} ${raw.ts}`);
    return payload;
  }

  @Command({ name: "channels-info", description: "Show Slack conversation metadata" })
  @CommandAccess({ kind: "read", resource: "slack.channels", action: "info", risk: "low" })
  @Returns(slackObjectReturnSchema)
  async channelsInfo(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const { client, config } = await createSlackOpsContext(connection, "conversations.info");
    const raw = await client.conversationsInfo({ channel });
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      item: raw.channel,
      raw,
    };
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(raw.channel, null, 2));
    return payload;
  }

  @Command({ name: "channels-history", description: "Read Slack conversation history" })
  @CommandAccess({ kind: "read", resource: "slack.channels", action: "history", risk: "medium" })
  @Returns(slackListReturnSchema)
  async channelsHistory(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({ flags: "--limit <n>", description: "Page size", defaultValue: "20" }) limitValue?: string,
    @Option({ flags: "--cursor <cursor>", description: "Slack pagination cursor" }) cursor?: string,
    @Option({ flags: "--latest <ts>", description: "Latest Slack timestamp" }) latest?: string,
    @Option({ flags: "--oldest <ts>", description: "Oldest Slack timestamp" }) oldest?: string,
    @Option({ flags: "--inclusive", description: "Include boundary timestamps" }) inclusive?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const limit = parsePositiveInt(limitValue, 20);
    const { client, config } = await createSlackOpsContext(connection, "conversations.history");
    const raw = await client.conversationsHistory({ channel, limit, cursor, latest, oldest, inclusive });
    const items = raw.messages ?? [];
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      items,
      pagination: pagination(limit, cursor, raw.response_metadata?.next_cursor, raw.has_more),
      raw,
    };
    if (asJson) printJson(payload);
    else {
      for (const item of items) console.log(JSON.stringify(item));
    }
    return payload;
  }

  @Command({ name: "messages-inspect", description: "Inspect whether a Slack message exists in Slack and Ravi" })
  @CommandAccess({ kind: "read", resource: "slack.messages", action: "inspect", risk: "medium" })
  @Returns(slackObjectReturnSchema)
  async messagesInspect(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("ts", { description: "Slack message timestamp" }) ts: string,
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const { client, config } = await createSlackOpsContext(connection, "conversations.history");
    const message = await fetchSlackMessageByTs(client, channel, ts);
    const local = message ? findLocalSlackMessage(config, channel, message) : { chat: null, message: null };
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      item: {
        channel,
        ts,
        foundInSlack: Boolean(message),
        foundInRavi: Boolean(local.message),
        slackMessage: message ? summarizeSlackMessage(message) : null,
        local,
      },
    };
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(payload.item, null, 2));
    return payload;
  }

  @Command({ name: "messages-replay", description: "Replay a Slack message through the native Ravi channel pipeline" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.messages",
    action: "replay",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async messagesReplay(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("ts", { description: "Slack message timestamp" }) ts: string,
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({ flags: "--force", description: "Replay even when the message is already in Ravi" }) force?: boolean,
    @Option({ flags: "--execute", description: "Perform the replay; default is dry-run" }) execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const { client, config } = await createSlackOpsContext(connection, "slack.messages.replay");
    const message = await fetchSlackMessageByTs(client, channel, ts);
    if (!message) fail(`Slack message not found: ${channel} ${ts}`);

    const localBefore = findLocalSlackMessage(config, channel, message);
    const request = { channel, ts, force: Boolean(force) };
    const dryRunItem = {
      status: localBefore.message && !force ? "already_ingested" : "ready",
      slackMessage: summarizeSlackMessage(message),
      localBefore,
    };
    if (!execute) return this.printMutationDryRun(config, "slack.messages.replay", request, asJson, dryRunItem);

    if (localBefore.message && !force) {
      const payload = this.mutationPayload(config, false, "slack.messages.replay", request, {
        status: "skipped",
        reason: "already_ingested",
        slackMessage: summarizeSlackMessage(message),
        localBefore,
      });
      if (asJson) printJson(payload);
      else console.log(JSON.stringify(payload.item, null, 2));
      return payload;
    }

    const envelope = buildSlackReplayEnvelope({
      connection: connectionLabel(config),
      channel,
      message,
    });
    const service = new SlackSocketModeService({
      appToken: config.appToken,
      botToken: config.botToken,
      accountId: config.accountId,
      routeAccountId: config.routeAccountId ?? config.accountId,
      instanceId: config.instanceId,
      webClient: client,
    });
    const replayStatus = await service.handleEnvelope(envelope);
    const localAfter = findLocalSlackMessage(config, channel, message);
    const payload = this.mutationPayload(config, false, "slack.messages.replay", request, {
      status: replayStatus,
      slackMessage: summarizeSlackMessage(message),
      localBefore,
      localAfter,
    });
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(payload.item, null, 2));
    return payload;
  }

  @Command({ name: "members-list", description: "List Slack conversation members" })
  @CommandAccess({ kind: "read", resource: "slack.members", action: "list", risk: "medium" })
  @Returns(slackListReturnSchema)
  async membersList(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({ flags: "--limit <n>", description: "Page size", defaultValue: "100" }) limitValue?: string,
    @Option({ flags: "--cursor <cursor>", description: "Slack pagination cursor" }) cursor?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const limit = parsePositiveInt(limitValue, 100);
    const { client, config } = await createSlackOpsContext(connection, "conversations.members");
    const raw = await client.conversationsMembers({ channel, limit, cursor });
    const items = raw.members ?? [];
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      items,
      pagination: pagination(limit, cursor, raw.response_metadata?.next_cursor),
      raw,
    };
    if (asJson) printJson(payload);
    else {
      for (const member of items) console.log(member);
    }
    return payload;
  }

  @Command({ name: "files-list", description: "List Slack files visible to the configured bot" })
  @CommandAccess({ kind: "read", resource: "slack.files", action: "list", risk: "medium" })
  @Returns(slackListReturnSchema)
  async filesList(
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({ flags: "--channel <id>", description: "Restrict to a Slack channel/conversation ID" }) channel?: string,
    @Option({ flags: "--user <id>", description: "Restrict to a Slack user ID" }) user?: string,
    @Option({ flags: "--limit <n>", description: "Page size", defaultValue: "20" }) limitValue?: string,
    @Option({ flags: "--cursor <cursor>", description: "Slack pagination cursor" }) cursor?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const limit = parsePositiveInt(limitValue, 20);
    const { client, config } = await createSlackOpsContext(connection, "files.list");
    const raw = await client.filesList({ channel, user, limit, cursor });
    const items = raw.files ?? [];
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      items,
      pagination: pagination(limit, cursor, raw.response_metadata?.next_cursor),
      raw,
    };
    if (asJson) printJson(payload);
    else {
      for (const item of items) console.log(JSON.stringify(item));
    }
    return payload;
  }

  @Command({ name: "topology", description: "Show Slack channels and Ravi route/session ownership" })
  @CommandAccess({ kind: "read", resource: "slack.topology", action: "read", risk: "medium" })
  @Returns(slackTopologyReturnSchema)
  async topology(
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({
      flags: "--types <types>",
      description: "Slack conversation types",
      defaultValue: "public_channel,private_channel",
    })
    types?: string,
    @Option({ flags: "--limit <n>", description: "Conversation page size", defaultValue: "200" }) limitValue?: string,
    @Option({ flags: "--cursor <cursor>", description: "Slack pagination cursor" }) cursor?: string,
    @Option({ flags: "--include-archived", description: "Include archived conversations" }) includeArchived?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const limit = parsePositiveInt(limitValue, 200);
    const { client, config } = await createSlackOpsContext(connection, "slack.topology");
    const accountId = connectionLabel(config);
    const conversations = await client.conversationsList({
      types,
      limit,
      cursor,
      excludeArchived: !includeArchived,
    });

    const topology = buildSlackTopology({
      accountId,
      channels: conversations.channels ?? [],
      routerConfig: configStore.getConfig(),
      getContactStatus: ({ peerId }) => getContact(peerId)?.status,
    });
    const payload = {
      ...topology,
      connection: accountId,
      source: config.source,
      pagination: pagination(limit, cursor, conversations.response_metadata?.next_cursor),
    };
    if (asJson) printJson(payload);
    else this.printTopologySummary(payload);
    return payload;
  }

  @Command({ name: "channels-create", description: "Create a Slack channel; dry-run unless --execute is set" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.channels",
    action: "create",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async channelsCreate(
    @Arg("name", { description: "New Slack channel name" }) name: string,
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({ flags: "--private", description: "Create a private channel" }) isPrivate?: boolean,
    @Option({ flags: "--execute", description: "Perform the mutation; default is dry-run" }) execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const request = { name, isPrivate: Boolean(isPrivate) };
    const { client, config } = await createSlackOpsContext(connection, "conversations.create");
    if (!execute) return this.printMutationDryRun(config, "conversations.create", request, asJson);
    const raw = await client.conversationsCreate(request);
    const payload = this.mutationPayload(config, false, "conversations.create", request, raw.channel, raw);
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(raw.channel, null, 2));
    return payload;
  }

  @Command({ name: "channels-rename", description: "Rename a Slack channel; dry-run unless --execute is set" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.channels",
    action: "rename",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async channelsRename(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("name", { description: "New Slack channel name" }) name: string,
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({ flags: "--execute", description: "Perform the mutation; default is dry-run" }) execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const request = { channel, name };
    const { client, config } = await createSlackOpsContext(connection, "conversations.rename");
    if (!execute) return this.printMutationDryRun(config, "conversations.rename", request, asJson);
    const raw = await client.conversationsRename(request);
    const payload = this.mutationPayload(config, false, "conversations.rename", request, raw.channel, raw);
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(raw.channel, null, 2));
    return payload;
  }

  @Command({ name: "channels-invite", description: "Invite Slack users to a channel; dry-run unless --execute is set" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.channels",
    action: "invite",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async channelsInvite(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("users", { description: "Comma-separated Slack user IDs" }) usersValue: string,
    @Option({ flags: "--connection <name>", description: "Slack credential connection" }) connection?: string,
    @Option({ flags: "--execute", description: "Perform the mutation; default is dry-run" }) execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const request = { channel, userIds: parseRequiredCsvOption(usersValue, "Slack user ids") };
    const { client, config } = await createSlackOpsContext(connection, "conversations.invite");
    if (!execute) return this.printMutationDryRun(config, "conversations.invite", request, asJson);
    const raw = await client.conversationsInvite(request);
    const payload = this.mutationPayload(config, false, "conversations.invite", request, raw.channel, raw);
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(raw.channel, null, 2));
    return payload;
  }

  private printMutationDryRun(
    config: SlackCredentialConfig,
    method: string,
    request: Record<string, unknown>,
    asJson?: boolean,
    item?: unknown,
  ) {
    const payload = this.mutationPayload(config, true, method, request, item);
    if (asJson) printJson(payload);
    else console.log(`Dry-run ${method}: ${JSON.stringify(request)}`);
    return payload;
  }

  private mutationPayload(
    config: SlackCredentialConfig,
    dryRun: boolean,
    method: string,
    request: Record<string, unknown>,
    item?: unknown,
    raw?: Record<string, unknown>,
  ) {
    return {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      dryRun,
      method,
      request,
      ...(item !== undefined ? { item } : {}),
      ...(raw ? { raw } : {}),
    };
  }

  private printTopologySummary(payload: {
    channels: Array<{
      id: string;
      name: string;
      ravi: {
        matched: boolean;
        agentId?: string;
        routeSession?: string;
        sessionKey?: string;
        policyGate?: { inboundAllowed: boolean; reason: string };
      };
    }>;
  }): void {
    console.log(`channels: ${payload.channels.length}`);
    for (const channel of payload.channels) {
      const routeLabel = channel.ravi.matched
        ? `${channel.ravi.agentId ?? "?"}${channel.ravi.routeSession ? ` session=${channel.ravi.routeSession}` : ""}`
        : "unrouted";
      const gate = channel.ravi.policyGate;
      const gateLabel = gate && !gate.inboundAllowed ? ` blocked=${gate.reason}` : "";
      console.log(`  ${channel.id} ${channel.name} route=${routeLabel}${gateLabel}`);
    }
  }
}
