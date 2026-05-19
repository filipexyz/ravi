/**
 * Audio chunking via ffmpeg for long audio transcription.
 * Splits audio into segments with overlap to avoid cutting words at boundaries.
 */

import { execFile } from "node:child_process";
import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);
const log = logger.child("chunker");

const CHUNK_DIR = "/tmp/ravi-audio-chunks";

interface ChunkOptions {
  /** Chunk duration in seconds (default: 600 = 10 min) */
  chunkDuration?: number;
  /** Overlap in seconds added before and after each chunk (default: 15) */
  overlap?: number;
}

export interface AudioChunk {
  buffer: Buffer;
  startSec: number;
  duration?: number;
  mimetype?: string;
}

const MIN_TRANSCRIBABLE_DURATION_SEC = 0.1;
const CHUNK_OUTPUT_EXT = "mp3";
const CHUNK_OUTPUT_MIMETYPE = "audio/mpeg";

/**
 * Get audio duration in seconds using ffprobe.
 */
export async function getAudioDuration(buffer: Buffer, ext: string): Promise<number> {
  await mkdir(CHUNK_DIR, { recursive: true });
  const tmpFile = join(CHUNK_DIR, `probe-${Date.now()}.${ext}`);
  try {
    await writeFile(tmpFile, buffer);
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "quiet",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      tmpFile,
    ]);
    return parseFloat(stdout.trim());
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

/**
 * Split audio buffer into overlapping chunks using ffmpeg.
 * Returns array of { buffer, startSec } for each chunk.
 */
export async function splitAudioChunks(buffer: Buffer, ext: string, opts: ChunkOptions = {}): Promise<AudioChunk[]> {
  const chunkDuration = opts.chunkDuration ?? 600;
  const overlap = opts.overlap ?? 15;
  if (chunkDuration <= overlap) {
    throw new Error("chunkDuration must be greater than overlap");
  }

  await mkdir(CHUNK_DIR, { recursive: true });
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inputFile = join(CHUNK_DIR, `input-${sessionId}.${ext}`);

  try {
    await writeFile(inputFile, buffer);

    // Get total duration
    const duration = await getAudioDuration(buffer, ext);
    log.debug("Audio duration", { duration, chunkDuration, overlap });

    // If short enough, no need to split
    if (duration <= chunkDuration + overlap) {
      return [{ buffer, startSec: 0 }];
    }

    const chunks: AudioChunk[] = [];
    const step = chunkDuration - overlap; // advance by chunkDuration minus overlap
    let start = 0;
    let index = 0;

    while (start < duration) {
      const chunkFile = join(CHUNK_DIR, `chunk-${sessionId}-${index}.${CHUNK_OUTPUT_EXT}`);
      const startSec = Math.max(0, start - (index === 0 ? 0 : overlap));
      const segmentDuration = Math.min(chunkDuration, duration - startSec);

      try {
        await execFileAsync("ffmpeg", [
          "-y",
          "-nostdin",
          "-ss",
          String(startSec),
          "-i",
          inputFile,
          "-t",
          String(segmentDuration),
          "-vn",
          "-map",
          "0:a:0",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "32k",
          "-v",
          "quiet",
          chunkFile,
        ]);

        const chunkBuffer = await readFile(chunkFile);
        let chunkDurationSec: number | undefined;
        try {
          chunkDurationSec = await getAudioDuration(chunkBuffer, CHUNK_OUTPUT_EXT);
        } catch (err) {
          log.warn("Could not detect chunk duration, keeping chunk", { index, startSec, error: err });
        }

        if (chunkDurationSec !== undefined && chunkDurationSec < MIN_TRANSCRIBABLE_DURATION_SEC) {
          log.warn("Skipping too-short audio chunk", { index, startSec, duration: chunkDurationSec });
        } else {
          chunks.push({
            buffer: chunkBuffer,
            startSec,
            duration: chunkDurationSec,
            mimetype: CHUNK_OUTPUT_MIMETYPE,
          });
          log.debug("Chunk created", {
            index,
            startSec,
            duration: chunkDurationSec ?? segmentDuration,
            size: chunkBuffer.length,
            mimetype: CHUNK_OUTPUT_MIMETYPE,
          });
        }
      } finally {
        await unlink(chunkFile).catch(() => {});
      }

      start += step;
      index++;
    }

    log.info("Audio split into chunks", { totalChunks: chunks.length, totalDuration: duration });
    return chunks;
  } finally {
    await unlink(inputFile).catch(() => {});
  }
}
