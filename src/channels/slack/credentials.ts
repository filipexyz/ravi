import { resolveCredentialSecret } from "../../credentials/index.js";
import type { ChannelConfig } from "../../router/router-db.js";

export interface SlackCredentialConfig {
  appToken: string;
  botToken: string;
  accountId: string;
  routeAccountId?: string;
  channel: string;
  instanceId: string;
  connection: string;
  source: "broker";
}

export interface SlackSecretPayload {
  appToken: string;
  botToken: string;
}

export type SlackCredentialResolver = (input: {
  provider: string;
  connection: string;
  action: string;
}) => Promise<{ secret: string; connection?: { connection: string } }>;

export async function resolveSlackCredentialConfigFromEnv(
  _env: NodeJS.ProcessEnv = process.env,
  options: {
    resolveSecret?: SlackCredentialResolver;
    action?: string;
    channel?: ChannelConfig;
    channels?: Record<string, ChannelConfig>;
  } = {},
): Promise<SlackCredentialConfig | null> {
  const channel = options.channel;
  const connection = credentialConnectionForChannel(channel);
  if (connection) {
    const resolved = await (options.resolveSecret ?? resolveCredentialSecret)({
      provider: "slack",
      connection,
      action: options.action ?? "socket_mode.connect",
    });
    const payload = parseSlackSecretPayload(resolved.secret);
    const channelName = channel?.name ?? resolved.connection?.connection ?? connection;
    const accountId = channelName;
    return {
      appToken: payload.appToken,
      botToken: payload.botToken,
      accountId,
      routeAccountId: channelName,
      channel: channelName,
      instanceId: channelName,
      connection,
      source: "broker",
    };
  }

  return null;
}

export function credentialConnectionForChannel(channel: ChannelConfig | null | undefined): string | undefined {
  if (!channel || channel.enabled === false || channel.provider !== "slack") return undefined;
  return channel.credentialConnection?.trim() || undefined;
}

export function parseSlackSecretPayload(secret: string): SlackSecretPayload {
  const trimmed = secret.trim();
  if (!trimmed) throw new Error("Slack credential secret is empty.");

  const record = trimmed.startsWith("{") ? parseJsonSecret(trimmed) : parseEnvSecret(trimmed);
  const appToken = stringField(record, "appToken", "app_token", "SLACK_APP_TOKEN");
  const botToken = stringField(record, "botToken", "bot_token", "SLACK_BOT_TOKEN");
  if (!appToken || !botToken) {
    throw new Error("Slack credential secret must include appToken and botToken.");
  }

  return {
    appToken,
    botToken,
  };
}

function parseJsonSecret(secret: string): Record<string, unknown> {
  const parsed = JSON.parse(secret) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Slack credential JSON secret must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function parseEnvSecret(secret: string): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const line of secret.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    record[key] = stripQuotes(value);
  }
  return record;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
