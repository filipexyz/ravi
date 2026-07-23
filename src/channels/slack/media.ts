import { readFile } from "node:fs/promises";
import { configStore } from "../../config-store.js";
import type { ChannelConfig } from "../../router/router-db.js";
import { resolveSlackCredentialConfigFromEnv, type SlackCredentialResolver } from "./credentials.js";

const DEFAULT_SLACK_API_BASE_URL = "https://slack.com/api";
const SLACK_UPLOAD_TIMEOUT_MS = 120_000;

interface SlackApiResponse {
  readonly ok?: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

interface SlackUploadUrlResponse extends SlackApiResponse {
  readonly upload_url?: string;
  readonly file_id?: string;
}

interface SlackCompleteUploadResponse extends SlackApiResponse {
  readonly files?: readonly unknown[];
}

export interface SlackMediaSendInput {
  readonly accountId: string;
  readonly chatId: string;
  readonly filePath: string;
  readonly filename: string;
  readonly caption?: string;
  readonly threadId?: string;
}

export interface SlackMediaSendDependencies {
  readonly channels?: Record<string, ChannelConfig>;
  readonly resolveSecret?: SlackCredentialResolver;
  readonly fetchImpl?: typeof fetch;
  readonly apiBaseUrl?: string;
}

export interface SlackNativeMediaDelivery {
  readonly transport: "slack-native";
  readonly provider: "slack";
  readonly success: true;
  readonly status: "sent";
  readonly fileId: string;
  readonly messageId?: string;
  readonly raw: Record<string, unknown>;
}

export function resolveSlackMediaChannel(
  channels: Record<string, ChannelConfig>,
  accountId: string,
): ChannelConfig | undefined {
  const normalizedAccountId = accountId.trim().toLowerCase();
  if (!normalizedAccountId) return undefined;

  return Object.values(channels).find((channel) => {
    if (channel.enabled === false || channel.provider.toLowerCase() !== "slack") return false;
    return [channel.name, channel.credentialConnection]
      .filter((value): value is string => Boolean(value?.trim()))
      .some((value) => value.trim().toLowerCase() === normalizedAccountId);
  });
}

export async function sendSlackMedia(
  input: SlackMediaSendInput,
  dependencies: SlackMediaSendDependencies = {},
): Promise<SlackNativeMediaDelivery> {
  const channels = dependencies.channels ?? configStore.getConfig().channels ?? {};
  const channel = resolveSlackMediaChannel(channels, input.accountId);
  if (!channel) {
    throw new Error(`Slack channel not configured for account "${input.accountId}".`);
  }

  const credentials = await resolveSlackCredentialConfigFromEnv(process.env, {
    action: "files.getUploadURLExternal",
    channel,
    channels,
    resolveSecret: dependencies.resolveSecret,
  });
  if (!credentials) {
    throw new Error(`Slack credentials not configured for channel "${channel.name}".`);
  }

  const bytes = await readFile(input.filePath);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const apiBaseUrl = (dependencies.apiBaseUrl ?? DEFAULT_SLACK_API_BASE_URL).replace(/\/+$/, "");

  const uploadTicket = await slackFormRequest<SlackUploadUrlResponse>({
    fetchImpl,
    apiBaseUrl,
    method: "files.getUploadURLExternal",
    botToken: credentials.botToken,
    body: {
      filename: input.filename,
      length: String(bytes.byteLength),
    },
  });
  const uploadUrl = uploadTicket.upload_url;
  const ticketFileId = uploadTicket.file_id;
  if (!uploadUrl || !ticketFileId) {
    throw new Error("Slack files.getUploadURLExternal did not return upload_url and file_id.");
  }

  const uploadResponse = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
    },
    body: bytes,
    signal: AbortSignal.timeout(SLACK_UPLOAD_TIMEOUT_MS),
  });
  if (!uploadResponse.ok) {
    throw new Error(`Slack file content upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`.trim());
  }

  const completion = await slackFormRequest<SlackCompleteUploadResponse>({
    fetchImpl,
    apiBaseUrl,
    method: "files.completeUploadExternal",
    botToken: credentials.botToken,
    body: {
      files: JSON.stringify([{ id: ticketFileId, title: input.filename }]),
      channel_id: input.chatId,
      ...(input.caption ? { initial_comment: input.caption } : {}),
      ...(input.threadId ? { thread_ts: input.threadId } : {}),
    },
  });
  const completedFile = firstRecord(completion.files);
  const fileId = firstString(completedFile?.id) ?? ticketFileId;
  const messageId = findSlackFileShareTs(completedFile, input.chatId);

  return {
    transport: "slack-native",
    provider: "slack",
    success: true,
    status: "sent",
    fileId,
    ...(messageId ? { messageId } : {}),
    raw: completion,
  };
}

async function slackFormRequest<T extends SlackApiResponse>(input: {
  readonly fetchImpl: typeof fetch;
  readonly apiBaseUrl: string;
  readonly method: string;
  readonly botToken: string;
  readonly body: Record<string, string>;
}): Promise<T> {
  const response = await input.fetchImpl(`${input.apiBaseUrl}/${input.method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.botToken}`,
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: new URLSearchParams(input.body).toString(),
    signal: AbortSignal.timeout(SLACK_UPLOAD_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload: T;
  try {
    payload = JSON.parse(text) as T;
  } catch {
    throw new Error(`Slack ${input.method} returned a non-JSON response.`);
  }

  if (!response.ok) {
    throw new Error(`Slack ${input.method} failed: ${response.status} ${response.statusText}`.trim());
  }
  if (payload.ok !== true) {
    throw new Error(`Slack ${input.method} failed: ${payload.error || "unknown_error"}`);
  }
  return payload;
}

function firstRecord(values: readonly unknown[] | undefined): Record<string, unknown> | undefined {
  const first = values?.[0];
  return first && typeof first === "object" && !Array.isArray(first) ? (first as Record<string, unknown>) : undefined;
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findSlackFileShareTs(file: Record<string, unknown> | undefined, chatId: string): string | undefined {
  const shares = file?.shares;
  if (!shares || typeof shares !== "object" || Array.isArray(shares)) return undefined;

  for (const scope of Object.values(shares as Record<string, unknown>)) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) continue;
    const entries = (scope as Record<string, unknown>)[chatId];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const ts = firstString((entry as Record<string, unknown>).ts);
      if (ts) return ts;
    }
  }
  return undefined;
}
