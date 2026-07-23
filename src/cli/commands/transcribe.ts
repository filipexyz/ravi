/**
 * Transcribe Commands - Audio transcription
 */

import "reflect-metadata";
import { z } from "zod";
import { Group, Command, CommandAccess, Arg, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { SUPPORTED_AUDIO_EXTENSIONS, inferAudioMimeType, transcribeFile } from "../../transcribe/service.js";

const transcribeFileReturnSchema = z.object({
  success: z.literal(true),
  transcription: z
    .object({
      text: z.string(),
      provider: z.string().optional(),
      model: z.string().optional(),
      duration: z.number().optional(),
      chunks: z.number().optional(),
      segments: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .passthrough(),
  source: z.object({
    filePath: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
    sizeMB: z.number(),
  }),
  options: z.object({
    lang: z.string(),
  }),
});

@Group({
  name: "transcribe",
  description: "Audio transcription",
  scope: "open",
})
export class TranscribeCommands {
  @Command({ name: "file", description: "Transcribe a local audio file" })
  @CommandAccess({ kind: "read", resource: "transcribe", action: "file", risk: "low" })
  @Returns(transcribeFileReturnSchema)
  async file(
    @Arg("path", { description: "Path to audio file" }) filePath: string,
    @Option({ flags: "--lang <lang>", description: "Language code (default: pt)", defaultValue: "pt" }) _lang?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const mimetype = inferAudioMimeType(filePath);
    if (!mimetype) {
      fail(`Unsupported audio format. Supported: ${SUPPORTED_AUDIO_EXTENSIONS.join(", ")}`);
    }

    if (!asJson) {
      console.log(`Transcribing ${filePath} (${mimetype})...`);
    }

    let result: Awaited<ReturnType<typeof transcribeFile>>;
    try {
      result = await transcribeFile({ filePath, mimeType: mimetype, language: _lang ?? "pt" });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }

    const payload = {
      success: true,
      transcription: {
        text: result.text,
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.model ? { model: result.model } : {}),
        ...(result.duration !== undefined ? { duration: result.duration } : {}),
        ...(result.chunks !== undefined ? { chunks: result.chunks } : {}),
        ...(result.segments !== undefined ? { segments: result.segments } : {}),
      },
      source: result.source,
      options: {
        lang: _lang ?? "pt",
      },
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      if (result.chunks && result.chunks > 1) {
        console.log(`\n✓ Transcribed in ${result.chunks} chunks (${result.duration?.toFixed(0)}s total)\n`);
      } else {
        console.log(`\n✓ Transcribed${result.duration ? ` (${result.duration.toFixed(0)}s)` : ""}\n`);
      }

      console.log(result.text);
    }

    return payload;
  }
}
