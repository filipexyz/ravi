import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { generateAudio } from "../../audio/generator.js";
import { transcribeAudio } from "../../transcribe/openai.js";
import type { ClipSpeechEngine, VoiceEngineDescriptor } from "./types.js";
import { envHas, estimateSpokenSeconds } from "./types.js";

const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";

/** ElevenLabs `eleven_multilingual_v2`: about US$ 0.08 per 1,000 characters. */
const TTS_USD_PER_CHAR = 0.08 / 1000;
/** Groq whisper-large-v3-turbo: US$ 0.04/hour; OpenAI whisper-1: US$ 0.006/minute. */
const STT_USD_PER_SECOND = { groq: 0.04 / 3600, openai: 0.006 / 60 } as const;

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
    async transcribe({ bytes, mime, language }) {
      const env = deps.env ?? process.env;
      const result = await transcribe(Buffer.from(bytes), mime, { language: language.split("-")[0] });
      const provider = result.provider ?? (envHas(env, "GROQ_API_KEY") ? "groq" : "openai");
      const durationSec = result.duration ?? estimateSpokenSeconds(result.text);
      return { text: result.text.trim(), durationSec, provider };
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

export function estimateSttCostUsd(provider: string, seconds: number): number {
  const rate = provider === "groq" ? STT_USD_PER_SECOND.groq : STT_USD_PER_SECOND.openai;
  return Math.max(0, seconds) * rate;
}

export const pushEngine = createPushEngine();
