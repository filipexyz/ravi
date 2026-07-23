/**
 * Audio Commands — Generate speech via ElevenLabs TTS
 */

import "reflect-metadata";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, normalize, relative, resolve } from "node:path";
import { Group, Command, CommandAccess, Arg, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { generateAudio, listElevenLabsVoices } from "../../audio/generator.js";
import { getAgent } from "../../router/config.js";
import { sendMediaWithOmniCli } from "../media-send.js";
import { nats } from "../../nats.js";
import {
  getTtsPlaybackItem,
  listTtsPlaybackItems,
  RAVI_TTS_TOPIC,
  readTtsPlaybackAudio,
  resolveTtsVoiceConfig,
  type RaviTtsRequest,
} from "../../audio/tts.js";
import {
  audioGenerateReturnSchema,
  audioPendingReturnSchema,
  audioTtsReturnSchema,
  audioVoicesReturnSchema,
} from "./operational-return-schemas.js";

const TEXT_FILE_EXTENSIONS = new Set([".md", ".txt"]);

function readTextFileOption(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;

  const rawPath = path.trim();
  if (!rawPath) fail("--text-file cannot be empty.");
  if (rawPath.includes("\0")) fail("--text-file contains an invalid path.");
  if (isAbsolute(rawPath)) fail("--text-file must be a relative path inside the current working directory.");

  const normalizedPath = normalize(rawPath);
  if (normalizedPath === "." || normalizedPath === ".." || normalizedPath.split(/[\\/]+/).includes("..")) {
    fail("--text-file must not contain '..' path segments.");
  }

  const extension = extname(normalizedPath).toLowerCase();
  if (!TEXT_FILE_EXTENSIONS.has(extension)) {
    fail("--text-file must point to a .md or .txt file.");
  }

  const cwd = resolve(process.cwd());
  const absolutePath = resolve(cwd, normalizedPath);
  const cwdRelativePath = relative(cwd, absolutePath);
  if (!cwdRelativePath || cwdRelativePath.startsWith("..") || isAbsolute(cwdRelativePath)) {
    fail("--text-file must be inside the current working directory.");
  }

  let text: string;
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) fail("--text-file must point to a regular file.");
    text = readFileSync(absolutePath, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("--text-file")) throw error;
    fail(`Cannot read --text-file: ${rawPath}`);
  }

  const trimmed = text.trim();
  if (!trimmed) fail("--text-file is empty.");
  return trimmed;
}

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
  @CommandAccess({ kind: "mutate", resource: "audio", action: "generate", risk: "high" })
  @Returns(audioGenerateReturnSchema)
  async generate(
    @Arg("text", { required: false, description: "Text to convert to speech" })
    text?: string,
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
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({
      flags: "--text-file <path>",
      description: "Relative .md or .txt file to convert to speech",
    })
    textFile?: string,
  ) {
    const fileText = readTextFileOption(textFile);
    const inlineText = text?.trim();
    if (fileText && inlineText) fail("Use either text or --text-file, not both.");
    const resolvedText = fileText ?? inlineText;
    if (!resolvedText) fail("Provide text or --text-file.");

    // Resolve agent defaults (CLI flags take precedence)
    const agentId = getContext()?.agentId;
    const defaults = agentId ? getAgent(agentId)?.defaults : undefined;

    const resolvedVoice = voice ?? (defaults?.tts_voice as string);
    const resolvedModel = model ?? (defaults?.tts_model as string);
    const resolvedSpeed = speed ? Number.parseFloat(speed) : (defaults?.tts_speed as number | undefined);
    const resolvedLang = lang ?? (defaults?.tts_lang as string) ?? "pt-br";

    if (!asJson) {
      console.log("Generating audio...");
    }

    const result = await generateAudio(resolvedText, {
      voice: resolvedVoice,
      model: resolvedModel,
      speed: resolvedSpeed,
      lang: resolvedLang,
      format,
      outputDir: output ? resolve(output) : undefined,
      ptt: !!send,
    });

    const sendCommand = `ravi media send "${result.filePath}"`;
    const payload: {
      success: true;
      audio: {
        filePath: string;
        mimeType: string;
        text: string;
        sendCommand: string;
      };
      options: {
        voice?: string;
        model?: string;
        speed?: number;
        lang: string;
        format?: string;
        outputDir?: string;
        voiceNote: boolean;
      };
      sent?: {
        transport: "omni-send";
        channel?: string;
        accountId: string;
        instanceId: string;
        chatId: string;
        threadId?: string;
        filename: string;
        caption: string;
        voiceNote: true;
        messageId?: string;
        status?: string;
      };
    } = {
      success: true,
      audio: {
        filePath: result.filePath,
        mimeType: result.mimeType,
        text: resolvedText,
        sendCommand,
      },
      options: {
        ...(resolvedVoice ? { voice: resolvedVoice } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(resolvedSpeed !== undefined ? { speed: resolvedSpeed } : {}),
        lang: resolvedLang,
        ...(format ? { format } : {}),
        ...(output ? { outputDir: resolve(output) } : {}),
        voiceNote: !!send,
      },
    };

    if (!asJson) {
      console.log(`\n✓ Audio saved: ${result.filePath}`);
      console.log(`  Send to chat: ${sendCommand}`);
      console.log(`\nText: ${resolvedText.slice(0, 200)}${resolvedText.length > 200 ? "..." : ""}`);
      if (voice) console.log(`Voice: ${voice}`);
      if (speed) console.log(`Speed: ${speed}`);
    }

    if (send) {
      const delivered = await sendMediaWithOmniCli({
        filePath: result.filePath,
        caption: caption ?? resolvedText.slice(0, 100),
        type: "audio",
        filename: basename(result.filePath),
        voiceNote: true,
      });
      payload.sent = {
        transport: delivered.delivery.transport,
        ...(delivered.target.channel ? { channel: delivered.target.channel } : {}),
        accountId: delivered.target.accountId,
        instanceId: delivered.target.instanceId,
        chatId: delivered.target.chatId,
        ...(delivered.target.threadId ? { threadId: delivered.target.threadId } : {}),
        filename: delivered.filename,
        caption: caption ?? resolvedText.slice(0, 100),
        voiceNote: true,
        ...(delivered.delivery.messageId ? { messageId: delivered.delivery.messageId } : {}),
        ...(delivered.delivery.status ? { status: delivered.delivery.status } : {}),
      };
      if (!asJson) {
        console.log(`✓ Sent to chat: ${delivered.filename}`);
      }
    }

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    }

    return payload;
  }

  @Command({
    name: "tts",
    description: "Publish a ravi.tts request for ElevenLabs generation and extension playback",
  })
  @CommandAccess({ kind: "mutate", resource: "audio", action: "tts", risk: "high" })
  @Returns(audioTtsReturnSchema)
  async tts(
    @Arg("text", { description: "Text to convert to speech" })
    text: string,
    @Option({ flags: "--id <id>", description: "Playback request id" })
    id?: string,
    @Option({ flags: "--agent <id>", description: "Agent ID used to resolve TTS defaults" })
    agentId?: string,
    @Option({ flags: "--session <name>", description: "Session name" })
    sessionName?: string,
    @Option({ flags: "--session-key <key>", description: "Session key" })
    sessionKey?: string,
    @Option({ flags: "--channel <channel>", description: "Target channel, e.g. whatsapp" })
    channel?: string,
    @Option({ flags: "--account <id>", description: "Target account/instance alias" })
    accountId?: string,
    @Option({ flags: "--chat <id>", description: "Target chat id" })
    chatId?: string,
    @Option({ flags: "--voice <id>", description: "ElevenLabs voice ID override" })
    voice?: string,
    @Option({ flags: "--model <model>", description: "ElevenLabs model ID override" })
    model?: string,
    @Option({ flags: "--speed <speed>", description: "Voice speed override" })
    speed?: string,
    @Option({ flags: "--lang <code>", description: "Language code override" })
    lang?: string,
    @Option({ flags: "--format <format>", description: "ElevenLabs output format override" })
    format?: string,
    @Option({ flags: "--voice-settings <json>", description: "ElevenLabs voiceSettings JSON" })
    voiceSettingsJson?: string,
    @Option({ flags: "--elevenlabs <json>", description: "Additional ElevenLabs request JSON" })
    elevenlabsJson?: string,
    @Option({ flags: "--client-id <id>", description: "Extension playback client id" })
    clientId?: string,
    @Option({ flags: "--no-autoplay", description: "Do not autoplay in extension clients" })
    noAutoplay?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const contextAgentId = getContext()?.agentId;
    const resolvedAgentId = agentId ?? contextAgentId;
    const voiceSettings = parseJsonObjectOption(voiceSettingsJson, "voice-settings");
    const elevenlabs = parseJsonObjectOption(elevenlabsJson, "elevenlabs");
    const request: RaviTtsRequest = {
      ...(id ? { id } : {}),
      text,
      ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
      ...(sessionName ? { sessionName } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(channel || accountId || chatId
        ? {
            target: {
              ...(channel ? { channel } : {}),
              ...(accountId ? { accountId } : {}),
              ...(chatId ? { chatId } : {}),
            },
          }
        : {}),
      playback: {
        target: "extension",
        autoplay: !noAutoplay,
        ...(clientId ? { clientId } : {}),
      },
      voice: resolveTtsVoiceConfig({
        agentId: resolvedAgentId,
        voice: {
          ...(voice ? { voiceId: voice } : {}),
          ...(model ? { modelId: model } : {}),
          ...(speed ? { speed: Number.parseFloat(speed) } : {}),
          ...(lang ? { lang } : {}),
          ...(format ? { outputFormat: format } : {}),
          ...(voiceSettings ? { voiceSettings } : {}),
          ...(elevenlabs ? { elevenlabs } : {}),
        },
      }),
      createdAt: Date.now(),
      metadata: { origin: "cli.audio.tts" },
    };
    await nats.emit(RAVI_TTS_TOPIC, request as unknown as Record<string, unknown>);
    const payload = { ok: true, topic: RAVI_TTS_TOPIC, request };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  @Command({
    name: "voices",
    description: "List available ElevenLabs voices for picker UIs",
  })
  @CommandAccess({ kind: "read", resource: "audio", action: "voices", risk: "low" })
  @Returns(audioVoicesReturnSchema)
  async voices(
    @Option({ flags: "--search <text>", description: "Search by voice name, description or labels" })
    search?: string,
    @Option({ flags: "--limit <n>", description: "Maximum voices to return" })
    limit?: string,
    @Option({ flags: "--category <category>", description: "Voice category filter" })
    category?: string,
    @Option({ flags: "--voice-type <type>", description: "Voice type filter" })
    voiceType?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const result = await listElevenLabsVoices({
      search,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      category,
      voiceType,
    });
    const payload = {
      ok: true as const,
      provider: "elevenlabs" as const,
      generatedAt: Date.now(),
      ...result,
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  @Command({
    name: "pending",
    description: "List generated ravi.tts playback items waiting for extension playback",
  })
  @CommandAccess({ kind: "read", resource: "audio", action: "pending", risk: "low" })
  @Returns(audioPendingReturnSchema)
  pending(
    @Option({ flags: "--id <id>", description: "Filter by playback item id" })
    id?: string,
    @Option({ flags: "--request-id <id>", description: "Filter by playback request id" })
    requestId?: string,
    @Option({ flags: "--since <ms>", description: "Only return TTS items after this Unix ms timestamp" })
    since?: string,
    @Option({ flags: "--session <name>", description: "Filter by session name" })
    sessionName?: string,
    @Option({ flags: "--session-key <key>", description: "Filter by session key" })
    sessionKey?: string,
    @Option({ flags: "--chat <id>", description: "Filter by target chat id" })
    chatId?: string,
    @Option({ flags: "--agent <id>", description: "Filter by agent id" })
    agentId?: string,
    @Option({ flags: "--client-id <id>", description: "Filter by extension playback client id" })
    clientId?: string,
    @Option({ flags: "--limit <n>", description: "Maximum items to return" })
    limit?: string,
    @Option({ flags: "--include-failed", description: "Include failed TTS requests" })
    includeFailed?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const payload = {
      ok: true,
      generatedAt: Date.now(),
      items: listTtsPlaybackItems({
        id,
        requestId,
        since: since ? Number.parseFloat(since) : undefined,
        sessionName,
        sessionKey,
        chatId,
        agentId,
        clientId,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        includeFailed,
      }),
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  @Command({
    name: "blob",
    description: "Return generated TTS audio bytes",
  })
  @CommandAccess({ kind: "read", resource: "audio", action: "blob", risk: "low" })
  @Returns.binary()
  blob(
    @Arg("id", { description: "TTS playback item id" })
    id: string,
  ): Response {
    const audio = readTtsPlaybackAudio(id);
    if (!audio) {
      const known = getTtsPlaybackItem(id);
      return new Response(JSON.stringify({ error: "NotFound", id, status: known?.status ?? "missing" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response(audio.bytes, {
      headers: {
        "content-type": audio.mimeType,
        "content-length": String(audio.bytes.byteLength),
        "cache-control": "no-store",
      },
    });
  }
}

function parseJsonObjectOption(value: string | undefined, label: string): Record<string, unknown> | undefined {
  if (!value?.trim()) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
