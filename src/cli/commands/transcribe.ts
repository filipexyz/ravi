/**
 * Transcribe Commands - Audio transcription
 */

import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { transcribeAudio } from "../../transcribe/openai.js";

const EXT_MIME: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg; codecs=opus",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

@Group({
  name: "transcribe",
  description: "Audio transcription",
  scope: "open",
})
export class TranscribeCommands {
  @Command({ name: "file", description: "Transcribe a local audio file" })
  async file(
    @Arg("path", { description: "Path to audio file" }) filePath: string,
    @Option({ flags: "--lang <lang>", description: "Language code (default: pt)", defaultValue: "pt" }) _lang?: string,
  ) {
    const ext = extname(filePath).toLowerCase();
    const mimetype = EXT_MIME[ext];
    if (!mimetype) {
      fail(`Unsupported audio format: ${ext}. Supported: ${Object.keys(EXT_MIME).join(", ")}`);
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(filePath);
    } catch (err) {
      fail(`Cannot read file: ${filePath}`);
    }

    const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
    console.log(`Transcribing ${filePath} (${sizeMB}MB, ${mimetype})...`);

    const result = await transcribeAudio(buffer, mimetype);

    if (result.chunks && result.chunks > 1) {
      console.log(`\n✓ Transcribed in ${result.chunks} chunks (${result.duration?.toFixed(0)}s total)\n`);
    } else {
      console.log(`\n✓ Transcribed${result.duration ? ` (${result.duration.toFixed(0)}s)` : ""}\n`);
    }

    console.log(result.text);

    return {
      text: result.text,
      duration: result.duration,
      chunks: result.chunks,
    };
  }
}
