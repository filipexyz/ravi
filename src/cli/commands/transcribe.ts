/**
 * Transcribe Commands - Audio transcription
 */

import "reflect-metadata";
import { realpathSync, statSync } from "node:fs";
import { z } from "zod";
import { Group, Command, CommandAccess, Arg, Option, Returns } from "../decorators.js";
import { fail, hasRuntimeInvocationContext } from "../context.js";
import { ContractError, contractFail } from "../agent-contract.js";
import { resolveCallerPath } from "../caller-cwd.js";
import { MAX_AUDIO_BYTES } from "../../utils/media.js";
import {
  MAX_TRANSCRIBE_FILE_BYTES,
  SUPPORTED_AUDIO_EXTENSIONS,
  TranscribeFileError,
  inferAudioMimeType,
  transcribeFile,
} from "../../transcribe/service.js";

/**
 * Size cap for `transcribe file`. Agent/gateway callers get the same 20MB audio
 * cap as inbound channel audio; a human on the local CLI gets the service ceiling.
 */
export function transcribeFileMaxBytes(): number {
  return hasRuntimeInvocationContext() ? MAX_AUDIO_BYTES : MAX_TRANSCRIBE_FILE_BYTES;
}

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
  @CommandAccess({ kind: "mutate", resource: "transcribe", action: "file", risk: "high" })
  @Returns(transcribeFileReturnSchema)
  async file(
    @Arg("path", { description: "Path to audio file" }) filePath: string,
    @Option({ flags: "--lang <lang>", description: "Language code (default: pt)", defaultValue: "pt" }) _lang?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    // Validate local input before any provider call.
    const mimetype = inferAudioMimeType(filePath);
    if (!mimetype) {
      fail(`Unsupported audio format. Supported: ${SUPPORTED_AUDIO_EXTENSIONS.join(", ")}`);
    }
    // Gateway/tool dispatch runs inside the daemon: resolve relative paths
    // against the caller cwd, never the daemon's.
    const absPath = resolveCallerPath(filePath);
    let realPath: string;
    let sizeBytes: number;
    try {
      // Follow symlinks so an audio-named link to a non-audio host file cannot
      // pass the extension check.
      realPath = realpathSync(absPath);
      const stats = statSync(realPath);
      if (!stats.isFile()) {
        contractFail("transcribe file", "INVALID_FILE", "Audio path must be a regular file.", {
          asJson,
          exitCode: 2,
          details: { suggestedAction: "Pass a regular audio file, not a directory or device" },
        });
      }
      sizeBytes = stats.size;
    } catch (error) {
      if (error instanceof ContractError) throw error;
      contractFail("transcribe file", "FILE_NOT_FOUND", "Audio file was not found.", {
        asJson,
        details: {
          suggestedAction: "Check the local audio file path and re-run",
        },
      });
    }
    // Use the resolved file's type: `voice.mp3` may link to `recording.wav`.
    const resolvedMimeType = inferAudioMimeType(realPath);
    if (!resolvedMimeType) {
      contractFail("transcribe file", "INVALID_FILE", "Audio path must resolve to a supported audio file.", {
        asJson,
        exitCode: 2,
        details: { suggestedAction: `Pass a real audio file (${SUPPORTED_AUDIO_EXTENSIONS.join(", ")})` },
      });
    }
    const maxBytes = transcribeFileMaxBytes();
    if (sizeBytes > maxBytes) {
      contractFail("transcribe file", "FILE_TOO_LARGE", "Audio file exceeds the transcription size limit.", {
        asJson,
        exitCode: 2,
        details: {
          sizeBytes,
          maxBytes,
          suggestedAction: "Trim or compress the audio below the size limit and retry",
        },
      });
    }

    if (!asJson) {
      console.log(`Transcribing ${absPath} (${resolvedMimeType})...`);
    }

    let result: Awaited<ReturnType<typeof transcribeFile>>;
    try {
      result = await transcribeFile({
        filePath: realPath,
        mimeType: resolvedMimeType,
        language: _lang ?? "pt",
        maxBytes,
      });
    } catch (error) {
      // The file changed after the checks above (grew, or was swapped): same envelope, not retryable.
      if (error instanceof TranscribeFileError) {
        if (error.code === "FILE_TOO_LARGE") {
          contractFail("transcribe file", "FILE_TOO_LARGE", "Audio file exceeds the transcription size limit.", {
            asJson,
            exitCode: 2,
            details: {
              ...error.details,
              suggestedAction: "Trim or compress the audio below the size limit and retry",
            },
          });
        }
        contractFail("transcribe file", "INVALID_FILE", "Audio path must be a regular file.", {
          asJson,
          exitCode: 2,
          details: { suggestedAction: "Pass a regular audio file, not a directory or device" },
        });
      }
      contractFail("transcribe file", "TRANSCRIBE_FAILED", "Audio transcription failed.", {
        asJson,
        details: {
          retryable: true,
          suggestedAction: "Check OPENAI_API_KEY and the audio file, then retry",
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
