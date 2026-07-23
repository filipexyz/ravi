import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { generateAudio, type GenerateAudioOptions } from "./generator.js";
import { getAgent } from "../router/config.js";
import type { AgentConfig } from "../router/types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("tts");

export const RAVI_TTS_TOPIC = "ravi.tts";
export const RAVI_TTS_STARTED_TOPIC = "ravi.tts.started";
export const RAVI_TTS_READY_TOPIC = "ravi.tts.ready";
export const RAVI_TTS_FAILED_TOPIC = "ravi.tts.failed";

const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";
const DEFAULT_TTS_LANG = "pt-br";
const DEFAULT_TTS_FORMAT = "mp3_44100_128";
const MAX_TTS_ITEMS = 80;
const MAX_TTS_TEXT_PREVIEW = 220;

export interface RaviTtsTarget {
  channel?: string;
  accountId?: string;
  instanceId?: string;
  chatId?: string;
  threadId?: string;
  canonicalChatId?: string;
}

export interface RaviTtsVoiceSettings {
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
}

export interface RaviTtsElevenLabsOptions {
  enableLogging?: boolean;
  optimizeStreamingLatency?: number;
  pronunciationDictionaryLocators?: unknown[];
  seed?: number;
  previousText?: string;
  nextText?: string;
  previousRequestIds?: string[];
  nextRequestIds?: string[];
  usePvcAsIvc?: boolean;
  applyTextNormalization?: "auto" | "on" | "off";
  applyLanguageTextNormalization?: boolean;
}

export interface RaviTtsVoiceConfig {
  provider: "elevenlabs";
  voiceId?: string;
  modelId: string;
  lang: string;
  outputFormat: string;
  voiceSettings?: RaviTtsVoiceSettings;
  elevenlabs?: RaviTtsElevenLabsOptions;
}

export interface RaviTtsRequest {
  id?: string;
  requestId?: string;
  text: string;
  agentId?: string;
  sessionName?: string;
  sessionKey?: string;
  emitId?: string;
  target?: RaviTtsTarget;
  playback?: {
    target?: "extension" | "channel" | "none";
    autoplay?: boolean;
    clientId?: string;
  };
  voice?: Partial<RaviTtsVoiceConfig> & {
    voice?: string;
    model?: string;
    format?: string;
    speed?: number;
  };
  metadata?: Record<string, unknown>;
  createdAt?: number;
  source?: Record<string, unknown>;
}

export interface RaviTtsPlaybackItem {
  id: string;
  requestId: string;
  status: "ready" | "failed";
  createdAt: number;
  readyAt?: number;
  failedAt?: number;
  text: string;
  textPreview: string;
  agentId?: string;
  sessionName?: string;
  sessionKey?: string;
  emitId?: string;
  target?: RaviTtsTarget;
  playback: {
    target: "extension" | "channel" | "none";
    autoplay: boolean;
    clientId?: string;
  };
  voice: RaviTtsVoiceConfig;
  audio?: {
    id: string;
    filePath: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    provider: "elevenlabs";
    voiceId: string;
    modelId: string;
    outputFormat: string;
  };
  error?: string;
  metadata?: Record<string, unknown>;
}

const ttsItems = new Map<string, RaviTtsPlaybackItem>();

type EmitFn = (topic: string, payload: Record<string, unknown>) => Promise<void> | void;

export function shouldAutoTtsForAgent(agent: AgentConfig | null | undefined): boolean {
  const defaults = asRecord(agent?.defaults);
  return (
    readBoolean(defaults?.tts_auto) === true ||
    readBoolean(defaults?.ttsAuto) === true ||
    readBoolean(defaults?.tts_enabled) === true
  );
}

export function resolveTtsVoiceConfig(input: {
  agentId?: string;
  agent?: AgentConfig | null;
  voice?: RaviTtsRequest["voice"];
}): RaviTtsVoiceConfig {
  const agent = input.agent ?? (input.agentId ? getAgent(input.agentId) : null);
  const defaults = asRecord(agent?.defaults) ?? {};
  const voice = asRecord(input.voice) ?? {};
  const defaultVoiceSettings = {
    ...readRecord(defaults.tts_voice_settings),
    ...readRecord(defaults.ttsVoiceSettings),
  };
  const requestVoiceSettings = readRecord(voice.voiceSettings);
  const speed =
    readNumber(voice.speed) ??
    readNumber(requestVoiceSettings.speed) ??
    readNumber(defaultVoiceSettings.speed) ??
    readNumber(defaults.tts_speed) ??
    readNumber(defaults.ttsSpeed);
  const voiceSettings = compactVoiceSettings({
    ...defaultVoiceSettings,
    ...requestVoiceSettings,
    ...(speed !== undefined ? { speed } : {}),
  });
  const elevenlabs = compactElevenLabsOptions({
    ...readRecord(defaults.tts_elevenlabs),
    ...readRecord(defaults.ttsElevenLabs),
    ...readRecord(defaults.tts_full_api),
    ...readRecord(voice.elevenlabs),
  });

  return {
    provider: "elevenlabs",
    ...((readString(voice.voiceId) ??
    readString(voice.voice) ??
    readString(defaults.tts_voice_id) ??
    readString(defaults.tts_voice))
      ? {
          voiceId:
            readString(voice.voiceId) ??
            readString(voice.voice) ??
            readString(defaults.tts_voice_id) ??
            readString(defaults.tts_voice),
        }
      : {}),
    modelId:
      readString(voice.modelId) ??
      readString(voice.model) ??
      readString(defaults.tts_model_id) ??
      readString(defaults.tts_model) ??
      DEFAULT_TTS_MODEL,
    lang: readString(voice.lang) ?? readString(defaults.tts_lang) ?? DEFAULT_TTS_LANG,
    outputFormat:
      readString(voice.outputFormat) ??
      readString(voice.format) ??
      readString(defaults.tts_output_format) ??
      readString(defaults.tts_format) ??
      DEFAULT_TTS_FORMAT,
    ...(voiceSettings ? { voiceSettings } : {}),
    ...(elevenlabs ? { elevenlabs } : {}),
  };
}

export function buildRaviTtsRequest(input: {
  text: string;
  agent?: AgentConfig | null;
  agentId?: string;
  sessionName?: string;
  sessionKey?: string;
  emitId?: string;
  target?: RaviTtsTarget;
  metadata?: Record<string, unknown>;
  source?: Record<string, unknown>;
}): RaviTtsRequest {
  const agentId = input.agentId ?? input.agent?.id;
  return {
    id: randomUUID(),
    text: input.text,
    ...(agentId ? { agentId } : {}),
    ...(input.sessionName ? { sessionName: input.sessionName } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.emitId ? { emitId: input.emitId } : {}),
    ...(input.target ? { target: input.target } : {}),
    playback: { target: "extension", autoplay: true },
    voice: resolveTtsVoiceConfig({ agentId, agent: input.agent }),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.source ? { source: input.source } : {}),
    createdAt: Date.now(),
  };
}

export async function handleRaviTtsRequest(payload: unknown, emit: EmitFn): Promise<RaviTtsPlaybackItem> {
  const request = normalizeTtsRequest(payload);
  const voice = resolveTtsVoiceConfig({ agentId: request.agentId, voice: request.voice });
  const id = request.id ?? request.requestId ?? randomUUID();
  const requestId = request.requestId ?? id;
  const createdAt = request.createdAt ?? Date.now();
  const playback = {
    target: request.playback?.target ?? "extension",
    autoplay: request.playback?.autoplay !== false,
    ...(request.playback?.clientId ? { clientId: request.playback.clientId } : {}),
  };

  await emit(RAVI_TTS_STARTED_TOPIC, {
    id,
    requestId,
    textPreview: previewText(request.text),
    ...(request.agentId ? { agentId: request.agentId } : {}),
    ...(request.sessionName ? { sessionName: request.sessionName } : {}),
    ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
    ...(request.emitId ? { emitId: request.emitId } : {}),
    ...(request.target ? { target: request.target } : {}),
    playback,
    voice,
    createdAt,
  });

  try {
    const audio = await generateAudio(request.text, toGenerateAudioOptions(voice));
    const sizeBytes = statSize(audio.filePath) ?? audio.sizeBytes;
    const item: RaviTtsPlaybackItem = {
      id,
      requestId,
      status: "ready",
      createdAt,
      readyAt: Date.now(),
      text: request.text,
      textPreview: previewText(request.text),
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.sessionName ? { sessionName: request.sessionName } : {}),
      ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
      ...(request.emitId ? { emitId: request.emitId } : {}),
      ...(request.target ? { target: request.target } : {}),
      playback,
      voice,
      audio: {
        id,
        filePath: audio.filePath,
        filename: basename(audio.filePath),
        mimeType: audio.mimeType,
        sizeBytes,
        provider: audio.provider,
        voiceId: audio.voiceId,
        modelId: audio.modelId,
        outputFormat: audio.outputFormat,
      },
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
    rememberTtsItem(item);
    await emit(RAVI_TTS_READY_TOPIC, item as unknown as Record<string, unknown>);
    return item;
  } catch (error) {
    const item: RaviTtsPlaybackItem = {
      id,
      requestId,
      status: "failed",
      createdAt,
      failedAt: Date.now(),
      text: request.text,
      textPreview: previewText(request.text),
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.sessionName ? { sessionName: request.sessionName } : {}),
      ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
      ...(request.emitId ? { emitId: request.emitId } : {}),
      ...(request.target ? { target: request.target } : {}),
      playback,
      voice,
      error: error instanceof Error ? error.message : String(error),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
    rememberTtsItem(item);
    await emit(RAVI_TTS_FAILED_TOPIC, item as unknown as Record<string, unknown>);
    log.warn("TTS request failed", { id, agentId: request.agentId, error });
    return item;
  }
}

export function listTtsPlaybackItems(
  filter: {
    id?: string;
    requestId?: string;
    since?: number;
    sessionName?: string;
    sessionKey?: string;
    chatId?: string;
    agentId?: string;
    clientId?: string;
    limit?: number;
    includeFailed?: boolean;
  } = {},
): RaviTtsPlaybackItem[] {
  const since = Number.isFinite(filter.since) ? Number(filter.since) : 0;
  const limit = Math.max(1, Math.min(Math.floor(filter.limit ?? 10), 25));
  const items = [...ttsItems.values()]
    .filter((item) => (filter.includeFailed ? true : item.status === "ready"))
    .filter((item) => !filter.id || item.id === filter.id)
    .filter((item) => !filter.requestId || item.requestId === filter.requestId)
    .filter((item) => (item.readyAt ?? item.failedAt ?? item.createdAt) >= since)
    .filter((item) => !filter.sessionName || item.sessionName === filter.sessionName)
    .filter((item) => !filter.sessionKey || item.sessionKey === filter.sessionKey)
    .filter((item) => !filter.agentId || item.agentId === filter.agentId)
    .filter((item) => !filter.clientId || item.playback?.clientId === filter.clientId)
    .filter(
      (item) =>
        !filter.chatId || item.target?.chatId === filter.chatId || item.target?.canonicalChatId === filter.chatId,
    )
    .sort(
      (left, right) =>
        (left.readyAt ?? left.failedAt ?? left.createdAt) - (right.readyAt ?? right.failedAt ?? right.createdAt),
    );
  return items.slice(-limit);
}

export function getTtsPlaybackItem(id: string): RaviTtsPlaybackItem | null {
  return ttsItems.get(id) ?? null;
}

export function readTtsPlaybackAudio(
  id: string,
): { item: RaviTtsPlaybackItem; bytes: Buffer; mimeType: string } | null {
  const item = getTtsPlaybackItem(id);
  if (!item?.audio?.filePath) return null;
  try {
    return {
      item,
      bytes: readFileSync(item.audio.filePath),
      mimeType: item.audio.mimeType,
    };
  } catch (error) {
    log.warn("TTS audio file is unavailable", { id, filePath: item.audio.filePath, error });
    return null;
  }
}

function rememberTtsItem(item: RaviTtsPlaybackItem): void {
  const previous = ttsItems.get(item.id);
  if (previous?.audio?.filePath && previous.audio.filePath !== item.audio?.filePath) {
    deleteTtsAudioFile(previous);
  }
  ttsItems.set(item.id, item);
  while (ttsItems.size > MAX_TTS_ITEMS) {
    const first = ttsItems.keys().next().value;
    if (!first) break;
    const evicted = ttsItems.get(first);
    if (evicted) deleteTtsAudioFile(evicted);
    ttsItems.delete(first);
  }
}

function deleteTtsAudioFile(item: RaviTtsPlaybackItem): void {
  const filePath = item.audio?.filePath;
  if (!filePath) return;
  try {
    unlinkSync(filePath);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "ENOENT") {
      log.debug("Failed to delete evicted TTS audio file", { id: item.id, filePath, error });
    }
  }
}

function normalizeTtsRequest(payload: unknown): RaviTtsRequest {
  const data = asRecord(payload);
  const text = readString(data?.text);
  if (!data || !text) {
    throw new Error("ravi.tts requires a non-empty text field");
  }
  return {
    text,
    ...(readString(data.id) ? { id: readString(data.id) } : {}),
    ...(readString(data.requestId) ? { requestId: readString(data.requestId) } : {}),
    ...(readString(data.agentId) ? { agentId: readString(data.agentId) } : {}),
    ...(readString(data.sessionName) ? { sessionName: readString(data.sessionName) } : {}),
    ...(readString(data.sessionKey) ? { sessionKey: readString(data.sessionKey) } : {}),
    ...(readString(data.emitId) ? { emitId: readString(data.emitId) } : {}),
    ...(readTarget(data.target) ? { target: readTarget(data.target) } : {}),
    ...(readPlayback(data.playback) ? { playback: readPlayback(data.playback) } : {}),
    ...(asRecord(data.voice) ? { voice: asRecord(data.voice) as RaviTtsRequest["voice"] } : {}),
    ...(asRecord(data.metadata) ? { metadata: asRecord(data.metadata) } : {}),
    ...(asRecord(data.source) ? { source: asRecord(data.source) } : {}),
    ...(readNumber(data.createdAt) ? { createdAt: readNumber(data.createdAt) } : {}),
  };
}

function toGenerateAudioOptions(voice: RaviTtsVoiceConfig): GenerateAudioOptions {
  return {
    ...(voice.voiceId ? { voiceId: voice.voiceId } : {}),
    modelId: voice.modelId,
    lang: voice.lang,
    outputFormat: voice.outputFormat,
    ...(voice.voiceSettings ? { voiceSettings: voice.voiceSettings } : {}),
    ...(voice.elevenlabs ?? {}),
  };
}

function readTarget(value: unknown): RaviTtsTarget | undefined {
  const data = asRecord(value);
  if (!data) return undefined;
  const target = {
    ...(readString(data.channel) ? { channel: readString(data.channel) } : {}),
    ...(readString(data.accountId) ? { accountId: readString(data.accountId) } : {}),
    ...(readString(data.instanceId) ? { instanceId: readString(data.instanceId) } : {}),
    ...(readString(data.chatId) ? { chatId: readString(data.chatId) } : {}),
    ...(readString(data.threadId) ? { threadId: readString(data.threadId) } : {}),
    ...(readString(data.canonicalChatId) ? { canonicalChatId: readString(data.canonicalChatId) } : {}),
  };
  return Object.keys(target).length ? target : undefined;
}

function readPlayback(value: unknown): RaviTtsRequest["playback"] | undefined {
  const data = asRecord(value);
  if (!data) return undefined;
  return {
    ...(readString(data.target) === "channel" ||
    readString(data.target) === "none" ||
    readString(data.target) === "extension"
      ? { target: readString(data.target) as "extension" | "channel" | "none" }
      : {}),
    ...(readBoolean(data.autoplay) !== undefined ? { autoplay: readBoolean(data.autoplay) } : {}),
    ...(readString(data.clientId) ? { clientId: readString(data.clientId) } : {}),
  };
}

function compactVoiceSettings(input: Record<string, unknown>): RaviTtsVoiceSettings | undefined {
  const value = {
    ...(readNumber(input.stability) !== undefined ? { stability: readNumber(input.stability) } : {}),
    ...(readNumber(input.similarityBoost) !== undefined ? { similarityBoost: readNumber(input.similarityBoost) } : {}),
    ...(readNumber(input.similarity_boost) !== undefined
      ? { similarityBoost: readNumber(input.similarity_boost) }
      : {}),
    ...(readNumber(input.style) !== undefined ? { style: readNumber(input.style) } : {}),
    ...(readBoolean(input.useSpeakerBoost) !== undefined
      ? { useSpeakerBoost: readBoolean(input.useSpeakerBoost) }
      : {}),
    ...(readBoolean(input.use_speaker_boost) !== undefined
      ? { useSpeakerBoost: readBoolean(input.use_speaker_boost) }
      : {}),
    ...(readNumber(input.speed) !== undefined ? { speed: readNumber(input.speed) } : {}),
  };
  return Object.keys(value).length ? value : undefined;
}

function compactElevenLabsOptions(input: Record<string, unknown>): RaviTtsElevenLabsOptions | undefined {
  const applyTextNormalization = readString(input.applyTextNormalization) ?? readString(input.apply_text_normalization);
  const normalizedTextNormalization: RaviTtsElevenLabsOptions["applyTextNormalization"] =
    applyTextNormalization === "auto" || applyTextNormalization === "on" || applyTextNormalization === "off"
      ? applyTextNormalization
      : undefined;
  const value = {
    ...(readBoolean(input.enableLogging) !== undefined ? { enableLogging: readBoolean(input.enableLogging) } : {}),
    ...(readBoolean(input.enable_logging) !== undefined ? { enableLogging: readBoolean(input.enable_logging) } : {}),
    ...(readNumber(input.optimizeStreamingLatency) !== undefined
      ? { optimizeStreamingLatency: readNumber(input.optimizeStreamingLatency) }
      : {}),
    ...(readNumber(input.optimize_streaming_latency) !== undefined
      ? { optimizeStreamingLatency: readNumber(input.optimize_streaming_latency) }
      : {}),
    ...(Array.isArray(input.pronunciationDictionaryLocators)
      ? { pronunciationDictionaryLocators: input.pronunciationDictionaryLocators }
      : {}),
    ...(Array.isArray(input.pronunciation_dictionary_locators)
      ? { pronunciationDictionaryLocators: input.pronunciation_dictionary_locators }
      : {}),
    ...(readNumber(input.seed) !== undefined ? { seed: readNumber(input.seed) } : {}),
    ...(readString(input.previousText) ? { previousText: readString(input.previousText) } : {}),
    ...(readString(input.previous_text) ? { previousText: readString(input.previous_text) } : {}),
    ...(readString(input.nextText) ? { nextText: readString(input.nextText) } : {}),
    ...(readString(input.next_text) ? { nextText: readString(input.next_text) } : {}),
    ...(Array.isArray(input.previousRequestIds)
      ? { previousRequestIds: input.previousRequestIds.filter(isString) }
      : {}),
    ...(Array.isArray(input.previous_request_ids)
      ? { previousRequestIds: input.previous_request_ids.filter(isString) }
      : {}),
    ...(Array.isArray(input.nextRequestIds) ? { nextRequestIds: input.nextRequestIds.filter(isString) } : {}),
    ...(Array.isArray(input.next_request_ids) ? { nextRequestIds: input.next_request_ids.filter(isString) } : {}),
    ...(readBoolean(input.usePvcAsIvc) !== undefined ? { usePvcAsIvc: readBoolean(input.usePvcAsIvc) } : {}),
    ...(readBoolean(input.use_pvc_as_ivc) !== undefined ? { usePvcAsIvc: readBoolean(input.use_pvc_as_ivc) } : {}),
    ...(normalizedTextNormalization ? { applyTextNormalization: normalizedTextNormalization } : {}),
    ...(readBoolean(input.applyLanguageTextNormalization) !== undefined
      ? { applyLanguageTextNormalization: readBoolean(input.applyLanguageTextNormalization) }
      : {}),
    ...(readBoolean(input.apply_language_text_normalization) !== undefined
      ? { applyLanguageTextNormalization: readBoolean(input.apply_language_text_normalization) }
      : {}),
  };
  return Object.keys(value).length ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
    if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  }
  return undefined;
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_TTS_TEXT_PREVIEW ? `${normalized.slice(0, MAX_TTS_TEXT_PREVIEW - 1)}...` : normalized;
}

function statSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
