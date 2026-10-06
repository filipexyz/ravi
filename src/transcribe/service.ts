import { constants } from "node:fs";
import { open } from "node:fs/promises";
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

/**
 * Hard ceiling for any local file handed to transcription. The file is read
 * fully into memory, so callers must never hand an unbounded path here.
 * Callers acting for an agent (gateway/tool) should pass a tighter `maxBytes`.
 */
export const MAX_TRANSCRIBE_FILE_BYTES = 200 * 1024 * 1024;

export type TranscribeFileErrorCode = "NOT_A_REGULAR_FILE" | "FILE_TOO_LARGE";

export class TranscribeFileError extends Error {
  constructor(
    readonly code: TranscribeFileErrorCode,
    message: string,
    readonly details: { sizeBytes?: number; maxBytes?: number } = {},
  ) {
    super(message);
    this.name = "TranscribeFileError";
  }
}

export interface TranscribeFileInput extends TranscriptionOptions {
  filePath: string;
  mimeType?: string;
  /** Upper bound in bytes; defaults to (and is clamped by) MAX_TRANSCRIBE_FILE_BYTES. */
  maxBytes?: number;
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

  // Open once and validate that handle, so the path cannot be swapped between
  // the check and the read. O_NONBLOCK keeps a FIFO from blocking the open;
  // it is rejected as non-regular right after.
  const maxBytes = Math.min(input.maxBytes ?? MAX_TRANSCRIBE_FILE_BYTES, MAX_TRANSCRIBE_FILE_BYTES);
  const file = await open(input.filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  let buffer: Buffer;
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new TranscribeFileError("NOT_A_REGULAR_FILE", "Audio path is not a regular file.");
    }
    if (stats.size > maxBytes) {
      throw new TranscribeFileError("FILE_TOO_LARGE", "Audio file exceeds the transcription size limit.", {
        sizeBytes: stats.size,
        maxBytes,
      });
    }
    // Read to EOF but at most maxBytes + 1, growing the buffer if the file grew
    // after the stat, so a growing file is neither truncated nor read unbounded.
    let chunk = Buffer.alloc(Math.min(stats.size, maxBytes) + 1);
    let total = 0;
    while (true) {
      if (total === chunk.length) {
        if (total > maxBytes) break;
        const grown = Buffer.alloc(Math.min(maxBytes + 1, chunk.length * 2));
        chunk.copy(grown, 0, 0, total);
        chunk = grown;
      }
      const { bytesRead } = await file.read(chunk, total, chunk.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) {
      throw new TranscribeFileError("FILE_TOO_LARGE", "Audio file exceeds the transcription size limit.", {
        sizeBytes: total,
        maxBytes,
      });
    }
    buffer = chunk.subarray(0, total);
  } finally {
    await file.close();
  }
  const result = await transcribeAudio(buffer, mimeType, {
    language: input.language,
    durationHintSec: input.durationHintSec,
  });
  return {
    ...result,
    source: {
      filePath: input.filePath,
      mimeType,
      sizeBytes: buffer.byteLength,
      sizeMB: Number((buffer.byteLength / 1024 / 1024).toFixed(1)),
    },
  };
}
