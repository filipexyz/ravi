/**
 * Audio Transcription via OpenAI or Groq API
 */

import OpenAI from "openai";
import { logger } from "../utils/logger.js";

const log = logger.child("transcribe");

export interface TranscriptionResult {
  text: string;
  duration?: number;
}

const EXT_MAP: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/ogg; codecs=opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

interface TranscribeProvider {
  name: string;
  client: OpenAI;
  model: string;
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
      model: "gpt-4o-transcribe",
    };
  }

  throw new Error("No transcription API key configured (GROQ_API_KEY or OPENAI_API_KEY)");
}

/**
 * Transcribe audio using Groq (preferred) or OpenAI
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimetype: string
): Promise<TranscriptionResult> {
  const provider = getProvider();

  const ext = EXT_MAP[mimetype] ?? "ogg";
  const filename = `audio.${ext}`;

  log.debug("Transcribing audio", { provider: provider.name, model: provider.model, mimetype, size: buffer.length });

  const file = new File([buffer], filename, { type: mimetype });

  const response = await provider.client.audio.transcriptions.create({
    file,
    model: provider.model,
    language: "pt",
  });

  log.info("Transcription complete", { provider: provider.name, textLength: response.text.length });

  return { text: response.text };
}
