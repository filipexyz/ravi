/**
 * Voice door types. Spec: `voice` (.ravi/specs/voice/SPEC.md).
 *
 * A call binds one existing session to one speaker. The session thinks the
 * work and is the only actor; engines are only ears and mouth.
 */

export const VOICE_MODES = ["push", "live", "handsfree", "mock"] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

export const VOICE_CALL_STATES = ["starting", "active", "ending", "ended"] as const;
export type VoiceCallState = (typeof VOICE_CALL_STATES)[number];

export const VOICE_AGENT_STATES = ["listening", "thinking", "speaking", "idle"] as const;
export type VoiceAgentState = (typeof VOICE_AGENT_STATES)[number];

export const VOICE_DELIVERY_CLASSES = ["speak", "when_idle", "silent"] as const;
export type VoiceDeliveryClass = (typeof VOICE_DELIVERY_CLASSES)[number];

export type VoiceConnectionKind = "none" | "webrtc" | "room";

export type VoiceSpeakerKind = "operator" | "device" | "guest";

export interface VoiceSpeaker {
  kind: VoiceSpeakerKind;
  /** Device id for `device`, `operator` for the local operator, a free label for `guest`. */
  id: string;
  contactId?: string;
  label?: string;
}

export const VOICE_EVENT_TYPES = [
  "call.snapshot",
  "call.state",
  "call.ended",
  "agent.state",
  "work.state",
  "work.tool",
  "user.transcript",
  "agent.transcript",
  "turn.accepted",
  "turn.completed",
  "turn.approval_requested",
  "turn.approval_resolved",
  "usage",
  "error",
] as const;
export type VoiceEventType = (typeof VOICE_EVENT_TYPES)[number];

export interface VoiceEvent {
  callId: string;
  seq: number;
  type: VoiceEventType;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface VoiceUsage {
  audioInSeconds: number;
  audioOutSeconds: number;
  charactersSpoken: number;
  engineSeconds: number;
  estimatedCostUsd: number;
}

export interface VoiceCall {
  id: string;
  sessionKey: string;
  sessionName: string;
  agentId?: string;
  mode: VoiceMode;
  engine: VoiceMode;
  profileId: string;
  state: VoiceCallState;
  agentState: VoiceAgentState;
  speaker: VoiceSpeaker;
  /** Context that started the call; the session turn runs with its authority. */
  callerContextId?: string;
  /** Session-relay turn origin built from the caller's context at start. */
  turnOrigin?: Record<string, unknown>;
  connectionKind: VoiceConnectionKind;
  /** Provider-side handle (GPT-Live session id, LiveKit room). Never a secret. */
  providerRef?: string;
  usage: VoiceUsage;
  endedReason?: string;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
}

export const VOICE_STT_PROVIDERS = ["groq", "openai"] as const;
export type VoiceSttProvider = (typeof VOICE_STT_PROVIDERS)[number];

export interface VoiceProfile {
  id: string;
  label: string;
  mode: VoiceMode;
  language: string;
  /** ElevenLabs voice name or id for push / handsfree speech. */
  voice?: string;
  ttsModel?: string;
  /** GPT-Live voice (fixed at session start). */
  liveVoice?: string;
  liveModel?: string;
  /** Push transcription provider; unset picks Groq when its key is set, else OpenAI. */
  sttProvider?: VoiceSttProvider;
  /** Transcription model (push: the provider's Whisper model; hands-free: the worker's STT model). */
  sttModel?: string;
  /** Transcription language when it differs from `language`. */
  sttLanguage?: string;
  delivery: VoiceDeliveryClass;
  allowGuests: boolean;
  maxCallMinutes: number;
  maxCallCostUsd: number;
  maxDailyCostUsd: number;
  createdAt: number;
  updatedAt: number;
}

export interface VoiceDevice {
  id: string;
  label: string;
  contactId: string;
  /** Sessions this device may call; `*` means every session the contact may reach. */
  sessions: string[];
  /** Voice profiles this device may start calls with; `*` (the default) means any. */
  profiles?: string[];
  contextId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  lastSeenAt?: number;
}

export interface VoiceTurn {
  id: string;
  callId: string;
  text: string;
  speaker: VoiceSpeaker;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
}

export const DEFAULT_VOICE_PROFILE_ID = "default";

export const DEFAULT_VOICE_LIMITS = {
  maxCallMinutes: 30,
  maxCallCostUsd: 2,
  maxDailyCostUsd: 10,
} as const;

export function emptyVoiceUsage(): VoiceUsage {
  return { audioInSeconds: 0, audioOutSeconds: 0, charactersSpoken: 0, engineSeconds: 0, estimatedCostUsd: 0 };
}

export function isVoiceMode(value: unknown): value is VoiceMode {
  return typeof value === "string" && (VOICE_MODES as readonly string[]).includes(value);
}

/** NATS subjects. Only text and control cross NATS; audio never does. */
export const voiceSubjects = {
  control: (callId: string) => `ravi.voice.${callId}.ctl`,
  event: (callId: string) => `ravi.voice.${callId}.event`,
  allControl: "ravi.voice.*.ctl",
} as const;
