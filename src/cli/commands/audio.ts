/**
 * Audio Commands — Generate speech via ElevenLabs TTS
 */

import "reflect-metadata";
import { resolve, basename } from "node:path";
import { Group, Command, Arg, Option } from "../decorators.js";
import { getContext, fail } from "../context.js";
import { nats } from "../../nats.js";
import { generateAudio } from "../../audio/generator.js";
import { getAgent } from "../../router/config.js";

@Group({
  name: "audio",
  description: "Audio generation tools (TTS)",
  scope: "open",
})
export class AudioCommands {
  @Command({
    name: "generate",
    description: "Generate speech from text using ElevenLabs TTS",
  })
  async generate(
    @Arg("text", { description: "Text to convert to speech" })
    text: string,
    @Option({ flags: "--voice <id>", description: "ElevenLabs voice ID" })
    voice?: string,
    @Option({ flags: "--model <model>", description: "Model: eleven_multilingual_v2, eleven_turbo_v2_5, etc" })
    model?: string,
    @Option({ flags: "--speed <speed>", description: "Speech speed 0.5-2.0 (default: 1.0)" })
    speed?: string,
    @Option({ flags: "--lang <code>", description: "Language code: pt, en, es, etc" })
    lang?: string,
    @Option({
      flags: "--format <format>",
      description: "Output format: mp3_44100_128 (default), mp3_22050_32, pcm_16000",
    })
    format?: string,
    @Option({ flags: "-o, --output <path>", description: "Output directory (default: /tmp)" })
    output?: string,
    @Option({ flags: "--send", description: "Auto-send generated audio to the current chat" })
    send?: boolean,
    @Option({ flags: "--caption <text>", description: "Caption when sending (used with --send)" })
    caption?: string,
  ) {
    // Resolve agent defaults (CLI flags take precedence)
    const agentId = getContext()?.agentId;
    const defaults = agentId ? getAgent(agentId)?.defaults : undefined;

    const resolvedVoice = voice ?? (defaults?.tts_voice as string);
    const resolvedModel = model ?? (defaults?.tts_model as string);
    const resolvedSpeed = speed ? Number.parseFloat(speed) : (defaults?.tts_speed as number | undefined);
    const resolvedLang = lang ?? (defaults?.tts_lang as string) ?? "pt-br";

    console.log("Generating audio...");

    const result = await generateAudio(text, {
      voice: resolvedVoice,
      model: resolvedModel,
      speed: resolvedSpeed,
      lang: resolvedLang,
      format,
      outputDir: output ? resolve(output) : undefined,
      ptt: !!send,
    });

    console.log(`\n✓ Audio saved: ${result.filePath}`);
    console.log(`  Send to chat: ravi media send "${result.filePath}"`);
    console.log(`\nText: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
    if (voice) console.log(`Voice: ${voice}`);
    if (speed) console.log(`Speed: ${speed}`);

    if (send) {
      const ctx = getContext()?.source;
      const channel = ctx?.channel;
      const accountId = ctx?.accountId;
      const chatId = ctx?.chatId;

      if (!channel || !accountId || !chatId) {
        fail("No chat context available for --send. Use from a chat session or specify target via media send.");
      }

      await nats.emit("ravi.media.send", {
        channel,
        accountId,
        chatId,
        filePath: result.filePath,
        mimetype: result.mimeType,
        type: "audio",
        filename: basename(result.filePath),
        caption: caption ?? text.slice(0, 100),
        voiceNote: true,
      });
      console.log(`✓ Sent to chat: ${basename(result.filePath)}`);
    }

    return {
      success: true,
      audio: {
        path: result.filePath,
        sendCommand: `ravi media send "${result.filePath}"`,
      },
    };
  }
}
