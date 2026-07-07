import { resolveCredentialSecret } from "../../credentials/index.js";
import type { InstanceConfig } from "../../router/router-db.js";

export interface SlackCredentialConfig {
  appToken: string;
  botToken: string;
  accountId: string;
  routeAccountId?: string;
  instanceId: string;
  connection: string;
  source: "broker" | "env";
}

export interface SlackSecretPayload {
  appToken: string;
  botToken: string;
  accountId?: string;
  routeAccountId?: string;
  instanceId?: string;
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
    instance?: InstanceConfig;
    instances?: Record<string, InstanceConfig>;
  } = {},
): Promise<SlackCredentialConfig | null> {
  const instance = options.instance ?? selectSlackInstance(options.instances, env);
  const connection =
    credentialConnectionForInstance(instance) ||
    env.RAVI_SLACK_CONNECTION?.trim() ||
    env.RAVI_SLACK_CREDENTIAL_CONNECTION?.trim();
  if (connection) {
    const resolved = await (options.resolveSecret ?? resolveCredentialSecret)({
      provider: "slack",
      connection,
      action: options.action ?? "socket_mode.connect",
    });
    const payload = parseSlackSecretPayload(resolved.secret);
    const accountId =
      instance?.name ||
      env.RAVI_SLACK_ACCOUNT?.trim() ||
      payload.accountId ||
      resolved.connection?.connection ||
      connection;
    return {
      appToken: payload.appToken,
      botToken: payload.botToken,
      accountId,
      routeAccountId: instance?.name || env.RAVI_SLACK_ROUTE_ACCOUNT?.trim() || payload.routeAccountId || accountId,
      instanceId:
        instance?.instanceId || instance?.name || env.RAVI_SLACK_INSTANCE?.trim() || payload.instanceId || accountId,
      connection,
      source: "broker",
    };
  }

  if (env.RAVI_SLACK_ALLOW_ENV_CREDENTIALS !== "1" && env.RAVI_SLACK_ALLOW_ENV_CREDENTIALS !== "true") {
    return null;
  }

  const appToken = env.SLACK_APP_TOKEN?.trim();
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  if (!appToken || !botToken) return null;

  const accountId = env.RAVI_SLACK_ACCOUNT?.trim() || "slack";
  return {
    appToken,
    botToken,
    accountId,
    routeAccountId: env.RAVI_SLACK_ROUTE_ACCOUNT?.trim() || undefined,
    instanceId: env.RAVI_SLACK_INSTANCE?.trim() || accountId,
    connection: env.RAVI_SLACK_CREDENTIAL_CONNECTION?.trim() || env.RAVI_SLACK_CONNECTION?.trim() || accountId,
    source: "env",
  };
}

export function credentialConnectionForInstance(instance: InstanceConfig | null | undefined): string | undefined {
  if (!instance || instance.enabled === false || instance.channel !== "slack") return undefined;
  const defaults = instance.defaults ?? {};
  const credentials = asRecord(defaults.credentials);
  return (
    stringField(defaults, "slackCredentialConnection", "credentialConnection") ||
    stringField(credentials, "slackConnection", "slackCredentialConnection", "connection") ||
    instance.name
  );
}

function selectSlackInstance(
  instances: Record<string, InstanceConfig> | undefined,
  env: NodeJS.ProcessEnv,
): InstanceConfig | undefined {
  if (!instances) return undefined;
  const selector = env.RAVI_SLACK_ACCOUNT?.trim() || env.RAVI_SLACK_INSTANCE?.trim();
  const candidates = Object.values(instances).filter(
    (instance) => instance.enabled !== false && instance.channel === "slack",
  );

  if (selector) {
    return candidates.find((instance) => instance.name === selector || instance.instanceId === selector);
  }

  return candidates.length === 1 ? candidates[0] : undefined;
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
    accountId: stringField(record, "accountId", "account_id", "teamId", "team_id", "RAVI_SLACK_ACCOUNT"),
    routeAccountId: stringField(record, "routeAccountId", "route_account_id", "RAVI_SLACK_ROUTE_ACCOUNT"),
    instanceId: stringField(record, "instanceId", "instance_id", "RAVI_SLACK_INSTANCE"),
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
