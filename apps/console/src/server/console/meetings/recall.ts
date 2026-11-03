// Recall.ai, the vendor behind the cloud meeting bot. Raw vendor shapes stop
// in this file and in transcript.ts: the rest of the Console and the OSS only
// see Ravi's meeting shape.

import { createHmac, timingSafeEqual } from "node:crypto";

export const RECALL_PROVIDER = "recall";
const DEFAULT_RECALL_REGION = "us-east-1";
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
/** API calls and JSON downloads; media streams in openMeetingMedia have no cap. */
const RECALL_REQUEST_TIMEOUT_MS = 15_000;

export type RecallConfig = {
  apiKey: string;
  baseUrl: string;
};

export function getRecallConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RecallConfig | null {
  const apiKey = env.RAVI_RECALL_API_KEY?.trim();
  if (!apiKey) return null;
  const region = env.RAVI_RECALL_REGION?.trim() || DEFAULT_RECALL_REGION;
  const baseUrl = (env.RAVI_RECALL_API_BASE_URL?.trim() || `https://${region}.recall.ai`).replace(/\/+$/, "");
  return { apiKey, baseUrl };
}

export function getRecallWebhookSecret(env: NodeJS.ProcessEnv = process.env) {
  return env.RAVI_RECALL_WEBHOOK_SECRET?.trim() || null;
}

export type RecallArtifactStatus = { code?: string | null; sub_code?: string | null; updated_at?: string | null };

export type RecallMediaShortcut = {
  id?: string;
  status?: RecallArtifactStatus | null;
  format?: string | null;
  data?: {
    download_url?: string | null;
    participant_events_download_url?: string | null;
    participants_download_url?: string | null;
  } | null;
};

export type RecallRecording = {
  id: string;
  started_at?: string | null;
  completed_at?: string | null;
  expires_at?: string | null;
  status?: RecallArtifactStatus | null;
  media_shortcuts?: {
    video_mixed?: RecallMediaShortcut | null;
    audio_mixed?: RecallMediaShortcut | null;
    transcript?: RecallMediaShortcut | null;
    participant_events?: RecallMediaShortcut | null;
    meeting_metadata?: RecallMediaShortcut | null;
  } | null;
};

export type RecallBot = {
  id: string;
  status_changes?: Array<{ code: string; sub_code?: string | null; message?: string | null; created_at: string }>;
  recordings?: RecallRecording[];
  metadata?: Record<string, string> | null;
};

export type RecallCreateBotInput = {
  meetingUrl: string;
  botName: string;
  joinAt: Date | null;
  language: string;
  maxRecordingSeconds: number;
  announcement: string | null;
  metadata: Record<string, string>;
};

export class RecallApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type RecallClient = {
  createBot(input: RecallCreateBotInput): Promise<RecallBot>;
  getBot(botId: string): Promise<RecallBot>;
  leaveCall(botId: string): Promise<void>;
  /** Reads a vendor download URL (pre-signed, no auth) as JSON. */
  downloadJson(url: string): Promise<unknown>;
};

/**
 * Body for POST /api/v1/bot/. The bot joins under a visible name, says in the
 * chat that it is recording, records mixed video and audio, transcribes with
 * speakers, and leaves on its own when the room empties or the cap is hit.
 */
export function buildRecallCreateBotBody(input: RecallCreateBotInput) {
  return {
    meeting_url: input.meetingUrl,
    bot_name: input.botName,
    ...(input.joinAt ? { join_at: input.joinAt.toISOString() } : {}),
    metadata: input.metadata,
    recording_config: {
      transcript: {
        provider: { recallai_streaming: { mode: "prioritize_accuracy", language_code: input.language } },
      },
      video_mixed_mp4: {},
      audio_mixed_mp3: {},
      participant_events: {},
      meeting_metadata: {},
    },
    automatic_leave: {
      waiting_room_timeout: 600,
      noone_joined_timeout: 900,
      everyone_left_timeout: { timeout: 30 },
      in_call_recording_timeout: input.maxRecordingSeconds,
    },
    ...(input.announcement
      ? { chat: { on_bot_join: { send_to: "everyone", message: input.announcement, pin: true } } }
      : {}),
  };
}

export function createRecallClient(config: RecallConfig, fetchImpl: typeof fetch = fetch): RecallClient {
  // The timeout covers the response body too, so a body read that aborts is
  // normalized like a stalled request.
  async function timed<T>(url: string, init: RequestInit, read: (response: Response) => Promise<T>) {
    try {
      return await read(await fetchImpl(url, { ...init, signal: AbortSignal.timeout(RECALL_REQUEST_TIMEOUT_MS) }));
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new RecallApiError(503, "The meeting bot provider timed out.");
      }
      throw error;
    }
  }

  async function call(method: string, path: string, body?: unknown) {
    const { response, text } = await timed(
      `${config.baseUrl}${path}`,
      {
        method,
        headers: {
          accept: "application/json",
          authorization: `Token ${config.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      async (response) => ({ response, text: await response.text() }),
    );
    if (!response.ok) {
      throw new RecallApiError(response.status, recallErrorMessage(response.status, text));
    }
    return text ? (JSON.parse(text) as unknown) : null;
  }

  return {
    async createBot(input) {
      return parseRecallBot(await call("POST", "/api/v1/bot/", buildRecallCreateBotBody(input)));
    },
    async getBot(botId) {
      return parseRecallBot(await call("GET", `/api/v1/bot/${encodeURIComponent(botId)}/`));
    },
    async leaveCall(botId) {
      await call("POST", `/api/v1/bot/${encodeURIComponent(botId)}/leave_call/`);
    },
    async downloadJson(url) {
      return timed(url, { headers: { accept: "application/json" } }, async (response) => {
        if (!response.ok) throw new RecallApiError(response.status, `Recording download failed (${response.status}).`);
        return (await response.json()) as unknown;
      });
    },
  };
}

function parseRecallBot(value: unknown): RecallBot {
  if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") {
    throw new RecallApiError(502, "The meeting bot provider returned a bot without an id.");
  }
  return value as RecallBot;
}

// Vendor error bodies can echo the meeting URL; keep only a short, generic detail.
function recallErrorMessage(status: number, body: string) {
  if (status === 507) return "No cloud meeting bot is available right now. Try again in a few minutes.";
  if (status === 429) return "The meeting bot provider is rate limiting requests.";
  if (status === 401 || status === 403) return "The meeting bot provider rejected the Console credentials.";
  if (status === 400) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const fields = Object.keys(parsed).filter((key) => key !== "detail").slice(0, 5);
      if (fields.length > 0) return `The meeting bot provider rejected: ${fields.join(", ")}.`;
    } catch {
      // fall through
    }
    return "The meeting bot provider rejected the request.";
  }
  return `The meeting bot provider failed (${status}).`;
}

/**
 * Recall signs webhooks Standard Webhooks style: HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the base64 key after `whsec_`, sent as
 * space-separated `v1,<base64>` entries. Older workspaces send the same under
 * `svix-*` header names.
 */
export function verifyRecallWebhookSignature(input: {
  body: string;
  headers: Headers;
  secret: string;
  now?: Date;
}): boolean {
  const id = input.headers.get("webhook-id") ?? input.headers.get("svix-id");
  const timestamp = input.headers.get("webhook-timestamp") ?? input.headers.get("svix-timestamp");
  const signatures = input.headers.get("webhook-signature") ?? input.headers.get("svix-signature");
  if (!id || !timestamp || !signatures || !input.secret.startsWith("whsec_")) return false;

  const seconds = Number(timestamp);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const key = Buffer.from(input.secret.slice("whsec_".length), "base64");
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${input.body}`).digest();

  for (const entry of signatures.split(" ")) {
    const [version, signature] = entry.split(",");
    if (version !== "v1" || !signature) continue;
    const received = Buffer.from(signature, "base64");
    if (received.length === expected.length && timingSafeEqual(received, expected)) return true;
  }
  return false;
}

export function recallWebhookDeliveryId(headers: Headers) {
  return (headers.get("webhook-id") ?? headers.get("svix-id"))?.trim() || null;
}

export type RecallWebhookEvent = {
  event: string;
  botId: string;
  code: string | null;
  subCode: string | null;
  updatedAt: Date | null;
  metadata: Record<string, string>;
};

export function parseRecallWebhookEvent(body: string): RecallWebhookEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { event?: unknown; data?: Record<string, unknown> };
  if (typeof record.event !== "string" || !record.data || typeof record.data !== "object") return null;
  const bot = record.data.bot as { id?: unknown; metadata?: unknown } | undefined;
  if (!bot || typeof bot.id !== "string") return null;
  const status = (record.data.data ?? {}) as { code?: unknown; sub_code?: unknown; updated_at?: unknown };
  const updatedAt = typeof status.updated_at === "string" ? new Date(status.updated_at) : null;
  const metadata: Record<string, string> = {};
  if (bot.metadata && typeof bot.metadata === "object") {
    for (const [key, value] of Object.entries(bot.metadata as Record<string, unknown>)) {
      if (typeof value === "string") metadata[key] = value;
    }
  }
  return {
    event: record.event,
    botId: bot.id,
    code: typeof status.code === "string" ? status.code : null,
    subCode: typeof status.sub_code === "string" ? status.sub_code : null,
    updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null,
    metadata,
  };
}
