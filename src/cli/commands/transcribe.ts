/**
 * Transcribe Commands - Audio transcription
 */

import "reflect-metadata";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Group, Command, CommandAccess, Arg, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { contractDryRun, contractFail } from "../agent-contract.js";
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
    @Option({
      flags: "--execute",
      description: "Actually call the paid transcription API; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    // Validation BEFORE the brake: unsupported format and missing file are
    // execution errors (exit 1) — no plan is shown for a call that could never
    // happen.
    const mimetype = inferAudioMimeType(filePath);
    if (!mimetype) {
      fail(`Unsupported audio format. Supported: ${SUPPORTED_AUDIO_EXTENSIONS.join(", ")}`);
    }
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) {
      contractFail("transcribe file", "FILE_NOT_FOUND", `File not found: ${absPath}`, {
        asJson,
        details: {
          suggestedAction: "Check the local audio file path and re-run",
        },
      });
    }

    if (execute !== true) {
      // Write brake (Manual v2 7.8): transcription spends EXTERNAL API money
      // (OpenAI Whisper) — dry-run by default, exit 3 BEFORE any provider call.
      // The plan shows exactly what would be billed.
      const sizeBytes = statSync(absPath).size;
      contractDryRun(
        "transcribe file",
        {
          filePath: absPath,
          mimeType: mimetype,
          sizeBytes,
          sizeMB: Number((sizeBytes / 1024 / 1024).toFixed(1)),
          lang: _lang ?? "pt",
          provider: "openai-whisper",
        },
        { asJson },
      );
    }

    if (!asJson) {
      console.log(`Transcribing ${absPath} (${mimetype})...`);
    }

    let result: Awaited<ReturnType<typeof transcribeFile>>;
    try {
      result = await transcribeFile({ filePath: absPath, mimeType: mimetype, language: _lang ?? "pt" });
    } catch (err) {
      contractFail("transcribe file", "TRANSCRIBE_FAILED", err instanceof Error ? err.message : String(err), {
        asJson,
        details: {
          retryable: true,
          suggestedAction: "Check OPENAI_API_KEY and the audio file, then retry with --execute",
        },
      });
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
