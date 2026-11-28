import type { VoiceConnectionKind, VoiceMode, VoiceProfile, VoiceSttProvider } from "../types.js";

export interface VoiceEngineCapabilities {
  /** The person can talk over the agent and the agent stops speaking. */
  bargeIn: boolean;
  /** Audio flows continuously (no push-to-talk clips). */
  streamingAudio: boolean;
  /** The door can make the engine say an exact text. */
  exactSpeech: boolean;
  /** The daemon produces audio the app fetches with `calls audio`. */
  serverAudio: boolean;
  /** Environment variables the engine needs. */
  needs: string[];
}

export interface VoiceEngineCheck {
  engine: VoiceMode;
  ready: boolean;
  missing: string[];
  notes: string[];
}

export interface VoiceEngineDescriptor {
  id: VoiceMode;
  label: string;
  connectionKind: VoiceConnectionKind;
  capabilities: VoiceEngineCapabilities;
  /** Estimated vendor cost per engine minute (connection time), in USD. */
  costPerMinuteUsd: number;
  check(env?: NodeJS.ProcessEnv): VoiceEngineCheck;
}

export interface SpeechToTextResult {
  text: string;
  durationSec: number;
  provider: string;
  /** The model that transcribed, when the provider reports it; metering prices by it. */
  model?: string;
}

export interface TextToSpeechResult {
  bytes: Uint8Array;
  mime: string;
  characters: number;
  /** Estimated cost in USD for this synthesis. */
  costUsd: number;
  /** Rough spoken duration (seconds), for metering. */
  durationSec: number;
}

/** Ears and mouth for clip-based engines (push, mock). */
export interface ClipSpeechEngine {
  transcribe(input: {
    bytes: Uint8Array;
    mime: string;
    language: string;
    /** From the profile: pinned transcription provider and model. */
    stt?: { provider?: VoiceSttProvider; model?: string };
  }): Promise<SpeechToTextResult>;
  synthesize(input: { text: string; profile: VoiceProfile }): Promise<TextToSpeechResult | null>;
}

export function envHas(env: NodeJS.ProcessEnv, name: string): boolean {
  return Boolean(env[name]?.trim());
}

/** Portuguese speech runs about 14 characters per second. */
export function estimateSpokenSeconds(text: string): number {
  return Math.round((text.length / 14) * 10) / 10;
}
