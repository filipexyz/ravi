/** Store-then-publish for call events, and the control channel to the door. */
import { nats } from "../nats.js";
import { logger } from "../utils/logger.js";
import { appendVoiceEvent } from "./store.js";
import { type VoiceEvent, type VoiceEventType, voiceSubjects } from "./types.js";

const log = logger.child("voice:events");

export interface VoiceEventSink {
  emit(topic: string, data: Record<string, unknown>): Promise<void>;
}

const defaultSink: VoiceEventSink = { emit: (topic, data) => nats.emit(topic, data) };

/** Every event is stored first (the stream resumes from the store), then published. */
export async function emitVoiceEvent(
  callId: string,
  type: VoiceEventType,
  data: Record<string, unknown>,
  sink: VoiceEventSink = defaultSink,
): Promise<VoiceEvent> {
  const event = appendVoiceEvent(callId, type, data);
  await sink.emit(voiceSubjects.event(callId), event as unknown as Record<string, unknown>).catch((error) => {
    log.warn("Failed to publish voice event", { callId, type, error });
  });
  return event;
}

export type VoiceControlMessage =
  | {
      op: "utterance";
      callId: string;
      turnId: string;
      text: string;
      speaker: Record<string, unknown>;
      audioInSeconds?: number;
      sttCostUsd?: number;
    }
  | { op: "cancel-turn"; callId: string; turnId: string; actor: string }
  | { op: "silence"; callId: string }
  | { op: "end"; callId: string; reason: string }
  | { op: "live-attach"; callId: string; providerSessionId: string }
  | { op: "approval-resolved"; callId: string; approvalId: string; decision: "approved" | "rejected" };

export async function sendVoiceControl(
  message: VoiceControlMessage,
  sink: VoiceEventSink = defaultSink,
): Promise<void> {
  await sink.emit(voiceSubjects.control(message.callId), message as unknown as Record<string, unknown>);
}
