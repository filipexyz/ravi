export const DEFAULT_MEETING_VOICE_RUNTIME_ID = "ravi-native" as const;

export const MEETING_VOICE_RUNTIME_IDS = ["ravi-native", "pipecat", "livekit"] as const;

export type MeetingVoiceRuntimeId = (typeof MEETING_VOICE_RUNTIME_IDS)[number];
export type MeetingVoiceRuntimeAvailability = "ready" | "planned";
export type MeetingVoiceRuntimeKind = "ravi-runtime" | "pipeline-framework" | "room-agent-framework";

export interface MeetingVoiceRuntimeCandidate {
  id: MeetingVoiceRuntimeId;
  label: string;
  availability: MeetingVoiceRuntimeAvailability;
  kind: MeetingVoiceRuntimeKind;
  defaultModel?: string;
  providerRuntime?: string;
  docsUrl: string;
  strengths: string[];
  constraints: string[];
}

export interface MeetingVoiceRuntimeDecision {
  enabled: boolean;
  runtimeId: MeetingVoiceRuntimeId | null;
  candidate: MeetingVoiceRuntimeCandidate | null;
  runnable: boolean;
  reason: string;
  error?: string;
}

export interface ResolveMeetingVoiceRuntimeInput {
  requested?: string;
  live?: boolean;
}

export const MEETING_VOICE_RUNTIME_CANDIDATES: readonly MeetingVoiceRuntimeCandidate[] = [
  {
    id: "ravi-native",
    label: "Ravi native runtime",
    availability: "planned",
    kind: "ravi-runtime",
    providerRuntime: "ravi",
    docsUrl: "https://github.com/filipelabs/ravi.bot",
    strengths: [
      "uses the registered Ravi agent/session as the source of truth",
      "keeps prompt, permissions, tools, observers and artifacts inside the native Ravi runtime",
      "treats Google Meet as channel/provider I/O instead of a separate agent runtime",
      "makes live meeting sessions visible in `ravi sessions list` and traceable with normal Ravi tools",
    ],
    constraints: [
      "requires the meeting channel bridge for speech/text delivery into the room",
      "provider-specific media capture still belongs to the Google Meet adapter",
    ],
  },
  {
    id: "pipecat",
    label: "Pipecat adapter",
    availability: "planned",
    kind: "pipeline-framework",
    docsUrl: "https://docs.pipecat.ai/",
    strengths: [
      "composable STT/LLM/TTS/VAD/transport pipeline",
      "good fit for provider-swapping experiments",
      "natural place to normalize pipeline frames into Ravi runtime or voice events",
    ],
    constraints: [
      "requires a Python worker or service boundary",
      "duplicates context aggregation unless Ravi owns the source-of-truth mapping",
      "not wired to the current Google Meet provider yet",
    ],
  },
  {
    id: "livekit",
    label: "LiveKit Agents adapter",
    availability: "planned",
    kind: "room-agent-framework",
    docsUrl: "https://docs.livekit.io/agents/",
    strengths: [
      "production room, participant, media, telephony, and deployment model",
      "supports AgentSession-style voice pipelines and model plugins",
      "good future fit when LiveKit itself is the meeting/channel provider",
    ],
    constraints: [
      "LiveKit room/session ownership must not replace Ravi session ownership",
      "can become both channel provider and runtime adapter, so ownership boundaries must be explicit",
      "adds room/worker deployment overhead before the current Meet v0 needs it",
    ],
  },
] as const;

const MEETING_VOICE_RUNTIME_ALIASES = new Map<string, MeetingVoiceRuntimeId>([
  ["ravi", "ravi-native"],
  ["native", "ravi-native"],
  ["ravi-native", "ravi-native"],
  ["runtime", "ravi-native"],
  ["voice", "ravi-native"],
  ["meet", "ravi-native"],
  ["pipecat", "pipecat"],
  ["pipe-cat", "pipecat"],
  ["livekit", "livekit"],
  ["livekit-agents", "livekit"],
]);

export function listMeetingVoiceRuntimeCandidates(): readonly MeetingVoiceRuntimeCandidate[] {
  return MEETING_VOICE_RUNTIME_CANDIDATES;
}

export function normalizeMeetingVoiceRuntimeId(value?: string): MeetingVoiceRuntimeId | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return MEETING_VOICE_RUNTIME_ALIASES.get(normalized);
}

export function getMeetingVoiceRuntimeCandidate(id: MeetingVoiceRuntimeId): MeetingVoiceRuntimeCandidate {
  const candidate = MEETING_VOICE_RUNTIME_CANDIDATES.find((item) => item.id === id);
  if (!candidate) {
    throw new Error(`Unknown meeting voice runtime: ${id}`);
  }
  return candidate;
}

export function resolveMeetingVoiceRuntime(input: ResolveMeetingVoiceRuntimeInput): MeetingVoiceRuntimeDecision {
  const enabled = Boolean(input.live);
  const requested = input.requested?.trim();
  const runtimeId = normalizeMeetingVoiceRuntimeId(requested) ?? (enabled ? DEFAULT_MEETING_VOICE_RUNTIME_ID : null);

  if (requested && !runtimeId) {
    return {
      enabled,
      runtimeId: null,
      candidate: null,
      runnable: false,
      reason: "unknown-runtime",
      error: `Unsupported meeting voice runtime: ${requested}. Use '${DEFAULT_MEETING_VOICE_RUNTIME_ID}'.`,
    };
  }

  if (!runtimeId) {
    return {
      enabled: false,
      runtimeId: null,
      candidate: null,
      runnable: true,
      reason: "voice-runtime-inactive",
    };
  }

  const candidate = getMeetingVoiceRuntimeCandidate(runtimeId);
  if (!enabled) {
    return {
      enabled: false,
      runtimeId,
      candidate,
      runnable: true,
      reason: "voice-runtime-selected-but-inactive",
    };
  }

  if (candidate.availability !== "ready") {
    return {
      enabled: true,
      runtimeId,
      candidate,
      runnable: false,
      reason: "voice-runtime-planned",
      error:
        `Meeting voice runtime '${runtimeId}' is planned but not wired yet. ` +
        "The native Meet voice bridge still needs delivery from Ravi session output into the visible meeting provider.",
    };
  }

  return {
    enabled: true,
    runtimeId,
    candidate,
    runnable: true,
    reason: "voice-runtime-ready",
  };
}
