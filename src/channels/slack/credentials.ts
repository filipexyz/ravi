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
  source: "broker" | "gateway";
  apiBaseUrl?: string;
  fileProxyUrl?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  gateway?: {
    claimUrl: string;
    completionBaseUrl: string;
    requestHeaders: Readonly<Record<string, string>>;
  };
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
  env: NodeJS.ProcessEnv = process.env,
  options: {
    resolveSecret?: SlackCredentialResolver;
    action?: string;
    channel?: ChannelConfig;
    channels?: Record<string, ChannelConfig>;
  } = {},
): Promise<SlackCredentialConfig | null> {
  const channel = options.channel;
  if (channel && isSlackGatewayChannel(channel)) {
    return resolveSlackGatewayCredentialConfig(env, channel);
  }
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

export function isSlackGatewayChannel(channel: ChannelConfig | null | undefined): boolean {
  return (
    Boolean(channel) &&
    channel?.enabled !== false &&
    channel?.provider === "slack" &&
    channel.defaults?.transport === "hub_gateway_v1"
  );
}

function resolveSlackGatewayCredentialConfig(env: NodeJS.ProcessEnv, channel: ChannelConfig): SlackCredentialConfig {
  const hubUrl = validatedHubUrl(env.RAVI_SLACK_GATEWAY_URL);
  const runtimeId = env.RAVI_RUNTIME_ID?.trim() ?? "";
  const credential = env.RAVI_RUNTIME_CREDENTIAL?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runtimeId)) {
    throw new Error("RAVI_RUNTIME_ID is required for the Slack Hub gateway.");
  }
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(credential)) {
    throw new Error("RAVI_RUNTIME_CREDENTIAL is invalid for the Slack Hub gateway.");
  }
  const requestHeaders = Object.freeze({
    authorization: `Bearer ${credential}`,
    "x-ravi-runtime-id": runtimeId,
  });
  return {
    appToken: credential,
    botToken: credential,
    accountId: channel.name,
    routeAccountId: channel.name,
    channel: channel.name,
    instanceId: channel.name,
    connection: `hub-gateway:${runtimeId}`,
    source: "gateway",
    apiBaseUrl: `${hubUrl}/api/runtime/v1/slack/web-api`,
    fileProxyUrl: `${hubUrl}/api/runtime/v1/slack/files`,
    requestHeaders,
    gateway: {
      claimUrl: `${hubUrl}/api/runtime/v1/slack/events/claim`,
      completionBaseUrl: `${hubUrl}/api/runtime/v1/slack/events`,
      requestHeaders,
    },
  };
}

function validatedHubUrl(value: string | undefined): string {
  const normalized = value?.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("RAVI_SLACK_GATEWAY_URL is required for the Slack Hub gateway.");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("RAVI_SLACK_GATEWAY_URL must be a valid URL.");
  }
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) || url.username || url.password) {
    throw new Error("RAVI_SLACK_GATEWAY_URL must use HTTPS.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("RAVI_SLACK_GATEWAY_URL must be an origin without a path.");
  }
  return url.origin;
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
