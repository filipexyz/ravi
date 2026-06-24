/**
 * Audio Transcription via OpenAI or Groq API
 * Supports chunked transcription for long audio files.
 */

import OpenAI from "openai";
import { logger } from "../utils/logger.js";
import { getAudioDuration, splitAudioChunks } from "./chunker.js";

const log = logger.child("transcribe");

export interface TranscriptionResult {
  text: string;
  provider?: string;
  model?: string;
  duration?: number;
  chunks?: number;
  segments?: TranscriptionSegment[];
}

export interface TranscriptionSegment {
  index: number;
  text: string;
  startSec: number;
  endSec?: number;
  duration?: number;
  provider: string;
  model: string;
}

interface ProviderTranscriptionSegment {
  text: string;
  startSec: number;
  endSec?: number;
}

interface TranscribeChunkResult {
  text: string;
  duration?: number;
  segments?: ProviderTranscriptionSegment[];
}

const EXT_MAP: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/ogg; codecs=opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/webm;codecs=opus": "webm",
  "audio/webm; codecs=opus": "webm",
};

interface TranscribeProvider {
  name: string;
  client: OpenAI;
  model: string;
}

/** Max duration in seconds before chunking (10 minutes) */
const CHUNK_THRESHOLD_SEC = 600;

export interface TranscriptionOptions {
  language?: string;
}

function getProvider(): TranscribeProvider {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    return {
      name: "groq",
      client: new OpenAI({ apiKey: groqKey, baseURL: "https://api.groq.com/openai/v1" }),
      model: "whisper-large-v3-turbo",
    };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      name: "openai",
      client: new OpenAI({ apiKey: openaiKey }),
      model: "whisper-1",
    };
  }

  throw new Error("No transcription API key configured (GROQ_API_KEY or OPENAI_API_KEY)");
}

/**
 * Transcribe a single audio buffer (no chunking).
 */
async function transcribeChunk(
  provider: TranscribeProvider,
  buffer: Buffer,
  mimetype: string,
  options: TranscriptionOptions = {},
): Promise<TranscribeChunkResult> {
  const ext = extensionForMimeType(mimetype);
  const filename = `audio.${ext}`;
  const file = new File([buffer], filename, { type: mimetype });

  const response = await provider.client.audio.transcriptions.create({
    file,
    model: provider.model,
    language: options.language ?? "pt",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });

  return normalizeTranscriptionResponse(response);
}

function extensionForMimeType(mimetype: string): string {
  const normalized = mimetype.toLowerCase().replace(/\s*;\s*/g, "; ");
  const base = normalized.split(";")[0]?.trim();
  return EXT_MAP[mimetype] ?? EXT_MAP[normalized] ?? (base ? EXT_MAP[base] : undefined) ?? "ogg";
}

function isAudioTooShortError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /audio file is too short|minimum audio length/i.test(message);
}

function normalizeTranscriptionResponse(response: unknown): TranscribeChunkResult {
  if (!isRecord(response)) return { text: "" };
  const text = typeof response.text === "string" ? response.text : "";
  return {
    text,
    ...(typeof response.duration === "number" && Number.isFinite(response.duration)
      ? { duration: response.duration }
      : {}),
    segments: normalizeProviderSegments(response.segments),
  };
}

function normalizeProviderSegments(value: unknown): ProviderTranscriptionSegment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((segment): ProviderTranscriptionSegment | null => {
      if (!isRecord(segment)) return null;
      const text = typeof segment.text === "string" ? segment.text.trim() : "";
      const start = typeof segment.start === "number" && Number.isFinite(segment.start) ? segment.start : undefined;
      const end = typeof segment.end === "number" && Number.isFinite(segment.end) ? segment.end : undefined;
      if (!text || start === undefined) return null;
      return { text, startSec: start, ...(end !== undefined ? { endSec: end } : {}) };
    })
    .filter((segment): segment is ProviderTranscriptionSegment => Boolean(segment));
}

function transcriptionSegmentsFromChunk(input: {
  chunk: TranscribeChunkResult;
  provider: TranscribeProvider;
  offsetSec: number;
  fallbackDuration?: number;
  startIndex?: number;
}): TranscriptionSegment[] {
  const startIndex = input.startIndex ?? 0;
  const providerSegments = input.chunk.segments ?? [];
  if (providerSegments.length > 0) {
    return providerSegments.map((segment, index) => ({
      index: startIndex + index,
      text: segment.text,
      startSec: input.offsetSec + segment.startSec,
      ...(segment.endSec !== undefined
        ? {
            endSec: input.offsetSec + segment.endSec,
            duration: Math.max(0, segment.endSec - segment.startSec),
          }
        : {}),
      provider: input.provider.name,
      model: input.provider.model,
    }));
  }

  const text = input.chunk.text.trim();
  if (!text) return [];
  return [
    {
      index: startIndex,
      text,
      startSec: input.offsetSec,
      ...(input.fallbackDuration !== undefined
        ? { endSec: input.offsetSec + input.fallbackDuration, duration: input.fallbackDuration }
        : {}),
      provider: input.provider.name,
      model: input.provider.model,
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Transcribe audio using Groq (preferred) or OpenAI.
 * Automatically chunks audio longer than 10 minutes.
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimetype: string,
  options: TranscriptionOptions = {},
): Promise<TranscriptionResult> {
  const provider = getProvider();
  const ext = extensionForMimeType(mimetype);

  log.debug("Transcribing audio", { provider: provider.name, model: provider.model, mimetype, size: buffer.length });

  // Check duration to decide if chunking is needed
  let duration: number | undefined;
  try {
    duration = await getAudioDuration(buffer, ext);
    log.debug("Audio duration detected", { duration });
  } catch (err) {
    log.warn("Could not detect audio duration, attempting direct transcription", { error: err });
  }

  // Short audio or unknown duration — transcribe directly
  if (!duration || duration <= CHUNK_THRESHOLD_SEC) {
    const chunkResult = await transcribeChunk(provider, buffer, mimetype, options);
    const text = chunkResult.text;
    const detectedDuration = duration ?? chunkResult.duration;
    const segments = transcriptionSegmentsFromChunk({
      chunk: chunkResult,
      provider,
      offsetSec: 0,
      fallbackDuration: detectedDuration,
    });
    log.info("Transcription complete", { provider: provider.name, textLength: text.length, duration });
    return {
      text,
      provider: provider.name,
      model: provider.model,
      duration: detectedDuration,
      chunks: 1,
      segments,
    };
  }

  // Long audio — split into chunks and transcribe each
  log.info("Audio exceeds threshold, chunking", { duration, threshold: CHUNK_THRESHOLD_SEC });
  const chunks = await splitAudioChunks(buffer, ext, {
    chunkDuration: CHUNK_THRESHOLD_SEC,
    overlap: 15,
  });

  const texts: string[] = [];
  const segments: TranscriptionSegment[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    log.debug("Transcribing chunk", {
      index: i,
      totalChunks: chunks.length,
      size: chunk.buffer.length,
      startSec: chunk.startSec,
    });
    let chunkResult: TranscribeChunkResult;
    try {
      chunkResult = await transcribeChunk(provider, chunk.buffer, chunk.mimetype ?? mimetype, options);
    } catch (err) {
      if (isAudioTooShortError(err)) {
        log.warn("Skipping too-short audio chunk rejected by provider", {
          index: i,
          startSec: chunk.startSec,
          duration: chunk.duration,
          error: err,
        });
        continue;
      }
      throw err;
    }
    const trimmed = chunkResult.text.trim();
    if (trimmed) {
      texts.push(trimmed);
      segments.push(
        ...transcriptionSegmentsFromChunk({
          chunk: chunkResult,
          provider,
          offsetSec: chunk.startSec,
          fallbackDuration: chunk.duration,
          startIndex: segments.length,
        }),
      );
    }
    log.debug("Chunk transcribed", { index: i, textLength: chunkResult.text.length });
  }

  const fullText = texts.join(" ");
  log.info("Chunked transcription complete", {
    provider: provider.name,
    chunks: chunks.length,
    textLength: fullText.length,
    duration,
  });

  return {
    text: fullText,
    provider: provider.name,
    model: provider.model,
    duration,
    chunks: chunks.length,
    segments,
  };
}
