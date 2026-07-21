import type { MessageTarget } from "../../runtime/message-types.js";

export interface NativeTextDeliveryRequest {
  readonly sessionName: string;
  readonly emitId?: string;
  readonly idempotencyKey: string;
  readonly target: MessageTarget;
  readonly text: string;
}

export interface NativeTextDeliveryResult {
  readonly provider: string;
  readonly messageId?: string;
  readonly platformMessageId?: string;
  readonly providerTimestamp?: number;
  readonly raw?: Record<string, unknown>;
}

export interface NativeTextDelivery {
  readonly channelId: string;
  supports(target: MessageTarget): boolean;
  deliverText(request: NativeTextDeliveryRequest): Promise<NativeTextDeliveryResult>;
}

export interface NativePresenceDeliveryRequest {
  readonly sessionName: string;
  readonly target: MessageTarget;
  readonly active: boolean;
  readonly reason?: string;
}

export interface NativePresenceDeliveryResult {
  readonly provider: string;
  readonly status: "active" | "inactive" | "skipped";
  readonly reason?: string;
  readonly raw?: Record<string, unknown>;
}

export interface NativePresenceDelivery {
  readonly channelId: string;
  supports(target: MessageTarget): boolean;
  sendPresence(request: NativePresenceDeliveryRequest): Promise<NativePresenceDeliveryResult>;
}

export interface NativeSpeechDeliveryRequest {
  readonly sessionName: string;
  readonly emitId?: string;
  readonly target: MessageTarget;
  readonly text: string;
  readonly voice?: string;
  readonly interrupt?: boolean;
  readonly rawProvenance?: unknown;
}

export interface NativeSpeechDeliveryResult {
  readonly provider: string;
  readonly speechId?: string;
  readonly platformMessageId?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly raw?: Record<string, unknown>;
}

export interface NativeMeetingDelivery extends NativeTextDelivery {
  readonly channelId: "meet";
  deliverSpeech(request: NativeSpeechDeliveryRequest): Promise<NativeSpeechDeliveryResult>;
  leave?(request: {
    readonly sessionName: string;
    readonly target: MessageTarget;
    readonly reason?: string;
    readonly rawProvenance?: unknown;
  }): Promise<{ readonly provider: string; readonly raw?: Record<string, unknown> }>;
}
