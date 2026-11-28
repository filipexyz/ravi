import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { generateAudio } from "../../audio/generator.js";
import { transcribeAudio } from "../../transcribe/openai.js";
import type { ClipSpeechEngine, VoiceEngineDescriptor } from "./types.js";
import { envHas, estimateSpokenSeconds } from "./types.js";

const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";

/** ElevenLabs `eleven_multilingual_v2`: about US$ 0.08 per 1,000 characters. */
const TTS_USD_PER_CHAR = 0.08 / 1000;
/**
 * Transcription prices per second of audio, by provider and model. A model missing from the table is
 * priced at its provider's most expensive known model, so a spend cap never relies on a cheaper rate.
 */
const STT_USD_PER_SECOND: Record<string, Record<string, number>> = {
  groq: {
    "whisper-large-v3-turbo": 0.04 / 3600,
    "whisper-large-v3": 0.111 / 3600,
    "distil-whisper-large-v3-en": 0.02 / 3600,
  },
  openai: {
    "whisper-1": 0.006 / 60,
    "gpt-4o-transcribe": 0.006 / 60,
    "gpt-4o-mini-transcribe": 0.003 / 60,
  },
};
const STT_DEFAULT_MODEL: Record<string, string> = { groq: "whisper-large-v3-turbo", openai: "whisper-1" };

export interface PushEngineDeps {
  transcribe?: typeof transcribeAudio;
  synthesize?: typeof generateAudio;
  env?: NodeJS.ProcessEnv;
}

export function createPushEngine(deps: PushEngineDeps = {}): VoiceEngineDescriptor & ClipSpeechEngine {
  const transcribe = deps.transcribe ?? transcribeAudio;
  const synthesize = deps.synthesize ?? generateAudio;
  return {
    id: "push",
    label: "Apertar para falar (Whisper + ElevenLabs)",
    connectionKind: "none",
    capabilities: {
      bargeIn: false,
      streamingAudio: false,
      exactSpeech: true,
      serverAudio: true,
      needs: ["ELEVENLABS_API_KEY", "GROQ_API_KEY or OPENAI_API_KEY"],
    },
    costPerMinuteUsd: 0,
    check(env = deps.env ?? process.env) {
      const missing: string[] = [];
      const notes: string[] = [];
      if (!envHas(env, "ELEVENLABS_API_KEY")) missing.push("ELEVENLABS_API_KEY");
      if (!envHas(env, "GROQ_API_KEY") && !envHas(env, "OPENAI_API_KEY"))
        missing.push("GROQ_API_KEY or OPENAI_API_KEY");
      if (!envHas(env, "GROQ_API_KEY") && envHas(env, "OPENAI_API_KEY")) {
        notes.push("STT falls back to OpenAI whisper-1, which shuts down on 2027-02-26; set GROQ_API_KEY.");
      }
      return { engine: "push", ready: missing.length === 0, missing, notes };
    },
    async transcribe({ bytes, mime, language, stt }) {
      const env = deps.env ?? process.env;
      const result = await transcribe(Buffer.from(bytes), mime, {
        language: language.split("-")[0],
        ...(stt?.provider ? { provider: stt.provider } : {}),
        ...(stt?.model ? { model: stt.model } : {}),
      });
      const provider = result.provider ?? (envHas(env, "GROQ_API_KEY") ? "groq" : "openai");
      const durationSec = result.duration ?? estimateSpokenSeconds(result.text);
      const model = result.model ?? stt?.model;
      return { text: result.text.trim(), durationSec, provider, ...(model ? { model } : {}) };
    },
    async synthesize({ text, profile }) {
      if (!text.trim()) return null;
      const generated = await synthesize(text, {
        ...(profile.voice ? { voice: profile.voice } : {}),
        model: profile.ttsModel ?? DEFAULT_TTS_MODEL,
        lang: profile.language,
        outputDir: tmpdir(),
      });
      try {
        const bytes = new Uint8Array(readFileSync(generated.filePath));
        return {
          bytes,
          mime: generated.mimeType,
          characters: text.length,
          costUsd: text.length * TTS_USD_PER_CHAR,
          durationSec: estimateSpokenSeconds(text),
        };
      } finally {
        rmSync(generated.filePath, { force: true });
      }
    },
  };
}

export function estimateSttCostUsd(provider: string, seconds: number, model?: string): number {
  const rates = STT_USD_PER_SECOND[provider] ?? STT_USD_PER_SECOND.openai;
  const known = rates[model ?? STT_DEFAULT_MODEL[provider] ?? "whisper-1"];
  const rate = known ?? Math.max(...Object.values(rates));
  return Math.max(0, seconds) * rate;
}

export const pushEngine = createPushEngine();
