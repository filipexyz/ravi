/**
 * Audio Generation (TTS) via ElevenLabs API
 *
 * Converts text to speech using ElevenLabs voices.
 * Returns generated audio saved as local files.
 */

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { logger } from "../utils/logger.js";

const log = logger.child("audio");

const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_MODEL = "eleven_multilingual_v2";

function getClient(): ElevenLabsClient {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error("ELEVENLABS_API_KEY not configured. Add it to ~/.ravi/.env");
  }
  return new ElevenLabsClient({ apiKey: key });
}

export interface GeneratedAudio {
  filePath: string;
  mimeType: string;
  text: string;
  sizeBytes: number;
  provider: "elevenlabs";
  voiceId: string;
  modelId: string;
  outputFormat: string;
}

export interface ElevenLabsVoiceSummary {
  voiceId: string;
  name: string;
  category?: string;
  description?: string;
  previewUrl?: string;
  labels?: Record<string, string>;
  isOwner?: boolean;
  isLegacy?: boolean;
  highQualityBaseModelIds?: string[];
  verifiedLanguages?: Array<{
    language?: string;
    locale?: string;
    accent?: string;
    previewUrl?: string;
  }>;
}

export interface ListElevenLabsVoicesOptions {
  search?: string;
  limit?: number;
  category?: string;
  voiceType?: string;
}

export interface GenerateAudioOptions {
  /** ElevenLabs voice ID */
  voice?: string;
  /** Alias for ElevenLabs voice ID */
  voiceId?: string;
  /** Model: "eleven_multilingual_v2", "eleven_turbo_v2_5", etc */
  model?: string;
  /** Alias for ElevenLabs model ID */
  modelId?: string;
  /** Output format: "mp3_44100_128" (default), "mp3_22050_32", "pcm_16000", etc */
  format?: string;
  /** Alias for ElevenLabs output format */
  outputFormat?: string;
  /** Speech speed: 0.5-2.0 (default 1.0) */
  speed?: number;
  /** Language code (ISO 639-1), e.g. "pt", "en" */
  lang?: string;
  /** Alias for ElevenLabs language code */
  languageCode?: string;
  /** Custom output directory */
  outputDir?: string;
  /** Convert output to OGG/Opus for WhatsApp voice notes (PTT) */
  ptt?: boolean;
  /** Per-request ElevenLabs voice settings. */
  voiceSettings?: {
    stability?: number;
    similarityBoost?: number;
    style?: number;
    useSpeakerBoost?: boolean;
    speed?: number;
  };
  /** ElevenLabs request passthrough fields. */
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

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function listElevenLabsVoices(opts: ListElevenLabsVoicesOptions = {}): Promise<{
  voices: ElevenLabsVoiceSummary[];
  hasMore: boolean;
  totalCount?: number;
  nextPageToken?: string;
}> {
  const client = getClient();
  const pageSize = Math.max(1, Math.min(Math.floor(opts.limit ?? 40), 100));
  const result = await client.voices.search({
    pageSize,
    includeTotalCount: true,
    ...(opts.search ? { search: opts.search } : {}),
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.voiceType ? { voiceType: opts.voiceType } : {}),
  });
  const voices = Array.isArray(result.voices) ? result.voices : [];
  return {
    voices: voices.map(normalizeVoiceSummary).filter((voice): voice is ElevenLabsVoiceSummary => Boolean(voice)),
    hasMore: Boolean(result.hasMore),
    ...(Number.isFinite(result.totalCount) ? { totalCount: result.totalCount } : {}),
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  };
}

function normalizeVoiceSummary(voice: unknown): ElevenLabsVoiceSummary | null {
  if (!voice || typeof voice !== "object") return null;
  const data = voice as Record<string, unknown>;
  const voiceId = readString(data.voiceId);
  if (!voiceId) return null;
  const labels = normalizeStringRecord(data.labels);
  const verifiedLanguages = Array.isArray(data.verifiedLanguages)
    ? data.verifiedLanguages
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const inner = item as Record<string, unknown>;
          const out = {
            ...(readString(inner.language) ? { language: readString(inner.language) } : {}),
            ...(readString(inner.locale) ? { locale: readString(inner.locale) } : {}),
            ...(readString(inner.accent) ? { accent: readString(inner.accent) } : {}),
            ...(readString(inner.previewUrl) ? { previewUrl: readString(inner.previewUrl) } : {}),
          };
          return Object.keys(out).length ? out : null;
        })
        .filter(
          (
            item,
          ): item is {
            language?: string;
            locale?: string;
            accent?: string;
            previewUrl?: string;
          } => Boolean(item),
        )
    : undefined;
  const uniqueVerifiedLanguages = dedupeVerifiedLanguages(verifiedLanguages);
  return {
    voiceId,
    name: readString(data.name) ?? voiceId,
    ...(readString(data.category) ? { category: readString(data.category) } : {}),
    ...(readString(data.description) ? { description: readString(data.description) } : {}),
    ...(readString(data.previewUrl) ? { previewUrl: readString(data.previewUrl) } : {}),
    ...(labels ? { labels } : {}),
    ...(typeof data.isOwner === "boolean" ? { isOwner: data.isOwner } : {}),
    ...(typeof data.isLegacy === "boolean" ? { isLegacy: data.isLegacy } : {}),
    ...(Array.isArray(data.highQualityBaseModelIds)
      ? {
          highQualityBaseModelIds: data.highQualityBaseModelIds.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : {}),
    ...(uniqueVerifiedLanguages.length ? { verifiedLanguages: uniqueVerifiedLanguages } : {}),
  };
}

function dedupeVerifiedLanguages(
  languages:
    | Array<{
        language?: string;
        locale?: string;
        accent?: string;
        previewUrl?: string;
      }>
    | undefined,
): Array<{
  language?: string;
  locale?: string;
  accent?: string;
  previewUrl?: string;
}> {
  if (!languages?.length) return [];
  const seen = new Set<string>();
  const out: Array<{
    language?: string;
    locale?: string;
    accent?: string;
    previewUrl?: string;
  }> = [];
  for (const item of languages) {
    const key = [item.language, item.locale, item.accent, item.previewUrl].filter(Boolean).join("|");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === "string" && inner.trim()) out[key] = inner.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function generateAudio(text: string, opts: GenerateAudioOptions = {}): Promise<GeneratedAudio> {
  const client = getClient();
  const voiceId = opts.voiceId ?? opts.voice ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE;
  const modelId = opts.modelId ?? opts.model ?? DEFAULT_MODEL;
  const outputFormat = opts.outputFormat ?? opts.format ?? "mp3_44100_128";
  const outDir = opts.outputDir ?? tmpdir();
  const languageCode = (opts.languageCode ?? opts.lang)?.split("-")[0];
  const voiceSettings = {
    ...(opts.voiceSettings ?? {}),
    ...(opts.speed ? { speed: opts.speed } : {}),
  };

  log.info("Generating audio", {
    model: modelId,
    voice: voiceId,
    text: text.slice(0, 100),
    format: outputFormat,
    speed: opts.speed,
  });

  const response = await client.textToSpeech.convert(voiceId, {
    text,
    modelId,
    outputFormat: outputFormat as never,
    ...(languageCode ? { languageCode } : {}),
    ...(Object.keys(voiceSettings).length > 0 ? { voiceSettings } : {}),
    ...(opts.enableLogging !== undefined ? { enableLogging: opts.enableLogging } : {}),
    ...(opts.optimizeStreamingLatency !== undefined ? { optimizeStreamingLatency: opts.optimizeStreamingLatency } : {}),
    ...(opts.pronunciationDictionaryLocators
      ? { pronunciationDictionaryLocators: opts.pronunciationDictionaryLocators }
      : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.previousText ? { previousText: opts.previousText } : {}),
    ...(opts.nextText ? { nextText: opts.nextText } : {}),
    ...(opts.previousRequestIds ? { previousRequestIds: opts.previousRequestIds } : {}),
    ...(opts.nextRequestIds ? { nextRequestIds: opts.nextRequestIds } : {}),
    ...(opts.usePvcAsIvc !== undefined ? { usePvcAsIvc: opts.usePvcAsIvc } : {}),
    ...(opts.applyTextNormalization ? { applyTextNormalization: opts.applyTextNormalization as never } : {}),
    ...(opts.applyLanguageTextNormalization !== undefined
      ? { applyLanguageTextNormalization: opts.applyLanguageTextNormalization }
      : {}),
  } as never);

  const buffer = await streamToBuffer(response as unknown as ReadableStream<Uint8Array>);

  if (!buffer.length) {
    throw new Error("ElevenLabs returned empty audio.");
  }

  const ext = outputFormat.startsWith("pcm") ? "pcm" : outputFormat.startsWith("ulaw") ? "wav" : "mp3";
  const timestamp = Date.now();
  const filename = `ravi-audio-${timestamp}.${ext}`;
  const filePath = join(outDir, filename);

  writeFileSync(filePath, buffer);
  log.info("Audio saved", { filePath, size: buffer.length });

  // Convert to OGG/Opus for WhatsApp voice notes (PTT)
  if (opts.ptt) {
    const oggPath = filePath.replace(/\.[^.]+$/, ".ogg");
    try {
      execSync(`ffmpeg -y -i "${filePath}" -c:a libopus -b:a 64k -ar 48000 -ac 1 "${oggPath}"`, {
        stdio: "pipe",
      });
      unlinkSync(filePath);
      log.info("Converted to OGG/Opus for PTT", { oggPath });
      return {
        filePath: oggPath,
        mimeType: "audio/ogg",
        text,
        sizeBytes: buffer.length,
        provider: "elevenlabs",
        voiceId,
        modelId,
        outputFormat,
      };
    } catch (err) {
      log.warn("ffmpeg conversion failed, using original MP3", { error: err });
    }
  }

  const mimeType = ext === "mp3" ? "audio/mpeg" : ext === "pcm" ? "audio/pcm" : "audio/wav";
  return {
    filePath,
    mimeType,
    text,
    sizeBytes: buffer.length,
    provider: "elevenlabs",
    voiceId,
    modelId,
    outputFormat,
  };
}
