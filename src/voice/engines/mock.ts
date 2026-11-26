import type { ClipSpeechEngine, VoiceEngineDescriptor } from "./types.js";
import { estimateSpokenSeconds } from "./types.js";

/** Text in, text out, no vendor. For apps under development and for CI. */
export const mockEngine: VoiceEngineDescriptor & ClipSpeechEngine = {
  id: "mock",
  label: "Mock (texto, sem fornecedor)",
  connectionKind: "none",
  capabilities: { bargeIn: false, streamingAudio: false, exactSpeech: true, serverAudio: false, needs: [] },
  costPerMinuteUsd: 0,
  check() {
    return { engine: "mock", ready: true, missing: [], notes: ["No audio: clips are read as UTF-8 text."] };
  },
  async transcribe({ bytes }) {
    const text = new TextDecoder().decode(bytes).trim();
    return { text, durationSec: estimateSpokenSeconds(text), provider: "mock" };
  },
  async synthesize() {
    return null;
  },
};
