import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getCallRequest, getCallResultForRequest, listCallRuns } from "./calls-db.js";
import { handlePostCallWebhook, type PostCallTranscriptionPayload } from "./webhook.js";
import type { CallResult } from "./types.js";

interface ElevenLabsConversationTranscriptItem {
  role?: string;
  time_in_call_secs?: number;
  message?: string | null;
}

interface ElevenLabsConversation {
  status?: string;
  transcript?: ElevenLabsConversationTranscriptItem[];
  analysis?: {
    call_successful?: boolean | string | null;
    call_summary_title?: string | null;
    transcript_summary?: string | null;
    [key: string]: unknown;
  } | null;
  metadata?: {
    call_duration_secs?: number | null;
    termination_reason?: string | null;
    error?: unknown;
    phone_call?: {
      call_sid?: string | null;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  } | null;
}

export interface SyncCallRequestFromElevenLabsOptions {
  apiKey?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface SyncCallRequestFromElevenLabsResult {
  requestId: string;
  runId: string;
  conversationId: string;
  conversationStatus: string | null;
  terminal: boolean;
  persisted: ReturnType<typeof handlePostCallWebhook>;
  result: CallResult | null;
  transcript: string | null;
  summary: string | null;
  durationSecs: number | null;
  terminationReason: string | null;
}

function readRaviEnvApiKey(): string | undefined {
  const envPath = join(process.env.HOME ?? "", ".ravi/.env");
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith("ELEVENLABS_API_KEY="));
  if (!line) return undefined;
  const value = line.split("=").slice(1).join("=").trim();
  return value.replace(/^['"]|['"]$/g, "") || undefined;
}

function resolveElevenLabsApiKey(explicit?: string): string {
  const key = explicit?.trim() || readRaviEnvApiKey() || process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new Error("ELEVENLABS_API_KEY is not configured.");
  return key;
}

function formatTranscript(items: ElevenLabsConversationTranscriptItem[] | undefined): string | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const lines = items
    .filter((item) => typeof item.message === "string" && item.message.trim())
    .map((item) => {
      const role = item.role === "agent" ? "agent" : item.role === "user" ? "user" : (item.role ?? "unknown");
      const time = typeof item.time_in_call_secs === "number" ? `${item.time_in_call_secs}s` : "-";
      return `[${time}] ${role}: ${item.message!.trim()}`;
    });
  return lines.length ? lines.join("\n") : null;
}

function hasCarrierOrVoicemailText(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    "celular estiver disponível",
    "celular esta disponível",
    "celular está disponível",
    "indisponível",
    "indisponivel",
    "caixa postal",
    "fora de área",
    "fora de area",
    "recado",
    "voicemail",
    "not available",
    "unavailable",
  ].some((marker) => normalized.includes(marker));
}

function inferCallSuccessful(conversation: ElevenLabsConversation, transcript: string | null): boolean {
  const explicit = conversation.analysis?.call_successful;
  const joined = [
    transcript ?? "",
    conversation.analysis?.transcript_summary ?? "",
    conversation.analysis?.call_summary_title ?? "",
    conversation.metadata?.termination_reason ?? "",
  ].join("\n");
  if (hasCarrierOrVoicemailText(joined)) return false;

  const userMessages = conversation.transcript?.filter(
    (item) => item.role === "user" && typeof item.message === "string" && item.message.trim(),
  );
  if (userMessages?.length) return true;
  if (explicit === true || explicit === "success" || explicit === "true") return true;
  if (explicit === false || explicit === "failure" || explicit === "false") return false;
  return false;
}

async function fetchConversation(
  conversationId: string,
  options: SyncCallRequestFromElevenLabsOptions,
): Promise<ElevenLabsConversation> {
  const apiKey = resolveElevenLabsApiKey(options.apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`, {
    headers: { "xi-api-key": apiKey },
  });
  const text = await response.text();
  const body = text.trim() ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "detail" in body
        ? JSON.stringify((body as Record<string, unknown>).detail)
        : text;
    throw new Error(`ElevenLabs conversation sync failed (${response.status}): ${message}`);
  }
  return body as ElevenLabsConversation;
}

export async function syncCallRequestFromElevenLabs(
  requestId: string,
  options: SyncCallRequestFromElevenLabsOptions = {},
): Promise<SyncCallRequestFromElevenLabsResult> {
  const request = getCallRequest(requestId);
  if (!request) throw new Error(`Call request not found: ${requestId}`);

  const run = [...listCallRuns(requestId)].reverse().find((item) => item.provider_call_id);
  if (!run?.provider_call_id) throw new Error(`Call request has no provider conversation id: ${requestId}`);

  const conversation = await fetchConversation(run.provider_call_id, options);
  const transcript = formatTranscript(conversation.transcript);
  const summary = conversation.analysis?.transcript_summary ?? conversation.analysis?.call_summary_title ?? null;
  const conversationStatus = conversation.status ?? null;
  const terminal = conversationStatus === "done" || conversationStatus === "failed";

  let persisted: ReturnType<typeof handlePostCallWebhook> = null;
  if (terminal) {
    const payload: PostCallTranscriptionPayload = {
      type: "post_call_transcription",
      conversation_id: run.provider_call_id,
      call_sid: conversation.metadata?.phone_call?.call_sid ?? run.twilio_call_sid ?? undefined,
      call_successful: inferCallSuccessful(conversation, transcript),
      call_duration_secs: conversation.metadata?.call_duration_secs ?? undefined,
      ...(transcript ? { transcript } : {}),
      ...(summary ? { call_summary: summary } : {}),
      ...(conversation.analysis ? { call_analysis: conversation.analysis as Record<string, unknown> } : {}),
    };
    persisted = handlePostCallWebhook(payload);
  }

  return {
    requestId,
    runId: run.id,
    conversationId: run.provider_call_id,
    conversationStatus,
    terminal,
    persisted,
    result: getCallResultForRequest(requestId),
    transcript,
    summary,
    durationSecs: conversation.metadata?.call_duration_secs ?? null,
    terminationReason: conversation.metadata?.termination_reason ?? null,
  };
}
