import type { VoiceMode } from "../types.js";
import { handsfreeEngine } from "./handsfree.js";
import { liveEngine } from "./live.js";
import { mockEngine } from "./mock.js";
import { pushEngine } from "./push.js";
import type { VoiceEngineCheck, VoiceEngineDescriptor } from "./types.js";

export type { ClipSpeechEngine, VoiceEngineCheck, VoiceEngineDescriptor } from "./types.js";

const ENGINES: Record<VoiceMode, VoiceEngineDescriptor> = {
  push: pushEngine,
  live: liveEngine,
  handsfree: handsfreeEngine,
  mock: mockEngine,
};

export function getVoiceEngine(mode: VoiceMode): VoiceEngineDescriptor {
  return ENGINES[mode];
}

export function listVoiceEngines(): VoiceEngineDescriptor[] {
  return [ENGINES.push, ENGINES.live, ENGINES.handsfree, ENGINES.mock];
}

export function checkVoiceEngines(env: NodeJS.ProcessEnv = process.env): VoiceEngineCheck[] {
  return listVoiceEngines().map((engine) => engine.check(env));
}
