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
}

export interface GenerateAudioOptions {
  /** ElevenLabs voice ID */
  voice?: string;
  /** Model: "eleven_multilingual_v2", "eleven_turbo_v2_5", etc */
  model?: string;
  /** Output format: "mp3_44100_128" (default), "mp3_22050_32", "pcm_16000", etc */
  format?: string;
  /** Speech speed: 0.5-2.0 (default 1.0) */
  speed?: number;
  /** Language code (ISO 639-1), e.g. "pt", "en" */
  lang?: string;
  /** Custom output directory */
  outputDir?: string;
  /** Convert output to OGG/Opus for WhatsApp voice notes (PTT) */
  ptt?: boolean;
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

export async function generateAudio(text: string, opts: GenerateAudioOptions = {}): Promise<GeneratedAudio> {
  const client = getClient();
  const voiceId = opts.voice ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE;
  const modelId = opts.model ?? DEFAULT_MODEL;
  const outputFormat = opts.format ?? "mp3_44100_128";
  const outDir = opts.outputDir ?? tmpdir();

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
    ...(opts.lang ? { languageCode: opts.lang.split("-")[0] } : {}),
    ...(opts.speed ? { voiceSettings: { speed: opts.speed } } : {}),
  });

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
      return { filePath: oggPath, mimeType: "audio/ogg", text };
    } catch (err) {
      log.warn("ffmpeg conversion failed, using original MP3", { error: err });
    }
  }

  const mimeType = ext === "mp3" ? "audio/mpeg" : ext === "pcm" ? "audio/pcm" : "audio/wav";
  return { filePath, mimeType, text };
}
