/**
 * Audio Transcription via OpenAI Whisper API
 */

import OpenAI from "openai";
import { logger } from "../utils/logger.js";

const log = logger.child("transcribe:openai");

export interface TranscriptionResult {
  text: string;
  duration?: number;
}

/**
 * Transcribe audio using OpenAI Whisper API
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimetype: string
): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const client = new OpenAI({ apiKey });

  // Determine file extension from mimetype
  const extMap: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/ogg; codecs=opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
  };
  const ext = extMap[mimetype] ?? "ogg";
  const filename = `audio.${ext}`;

  log.debug("Transcribing audio", { mimetype, size: buffer.length, filename });

  const file = new File([buffer], filename, { type: mimetype });

  const response = await client.audio.transcriptions.create({
    file,
    model: "gpt-4o-transcribe",
    language: "pt",
  });

  log.info("Transcription complete", { textLength: response.text.length });

  return { text: response.text };
}
