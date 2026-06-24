import { stat, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { transcribeAudio, type TranscriptionOptions, type TranscriptionResult } from "./openai.js";

const EXT_MIME: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg; codecs=opus",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

export const SUPPORTED_AUDIO_EXTENSIONS = Object.keys(EXT_MIME);

export interface TranscribeFileInput extends TranscriptionOptions {
  filePath: string;
  mimeType?: string;
}

export interface TranscribeFileResult extends TranscriptionResult {
  source: {
    filePath: string;
    mimeType: string;
    sizeBytes: number;
    sizeMB: number;
  };
}

export function inferAudioMimeType(filePath: string): string | undefined {
  return EXT_MIME[extname(filePath).toLowerCase()];
}

export async function transcribeFile(input: TranscribeFileInput): Promise<TranscribeFileResult> {
  const mimeType = input.mimeType ?? inferAudioMimeType(input.filePath);
  if (!mimeType) {
    throw new Error(`Unsupported audio format: ${extname(input.filePath) || "<none>"}`);
  }

  const [stats, buffer] = await Promise.all([stat(input.filePath), readFile(input.filePath)]);
  const result = await transcribeAudio(buffer, mimeType, { language: input.language });
  return {
    ...result,
    source: {
      filePath: input.filePath,
      mimeType,
      sizeBytes: stats.size,
      sizeMB: Number((stats.size / 1024 / 1024).toFixed(1)),
    },
  };
}
