/**
 * Who is calling, and what they may do. Spec `voice`, section Authority.
 *
 * - Agent turns never start, connect, approve or deny calls.
 * - The local operator may call any session it can access.
 * - A paired device (context kind `voice-device`) may call only the sessions
 *   listed at pairing and only control its own calls.
 * - The speaker never adds authority: the session turn runs with the caller's.
 */
import { getContext, type ToolContext } from "../cli/context.js";
import { canAccessSession, getScopeContext } from "../permissions/scope.js";
import { isRuntimeContextLive } from "../runtime/context-liveness.js";
import { getVoiceDeviceByContextId } from "./store.js";
import type { VoiceCall, VoiceDevice, VoiceSpeaker } from "./types.js";

export const VOICE_DEVICE_CONTEXT_KIND = "voice-device";
export const VOICE_WORKER_CONTEXT_KIND = "voice-worker";
export const VOICE_DEVICE_CAPABILITIES = [
  { permission: "read", objectType: "voice", objectId: "*" },
  { permission: "mutate", objectType: "voice", objectId: "*" },
  { permission: "access", objectType: "voice-call", objectId: "*" },
] as const;

export class VoiceAuthorityError extends Error {
  constructor(
    readonly code:
      | "VOICE_AGENT_TURN_REFUSED"
      | "VOICE_SESSION_FORBIDDEN"
      | "VOICE_CALL_FORBIDDEN"
      | "VOICE_DEVICE_REVOKED"
      | "VOICE_GUEST_FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "VoiceAuthorityError";
  }
}

export type VoiceCallerKind = "operator" | "device" | "worker" | "context";

export interface VoiceCaller {
  kind: VoiceCallerKind;
  speaker: VoiceSpeaker;
  contextId?: string;
  device?: VoiceDevice;
}

function isAgentTurnContext(ctx: ToolContext | undefined): boolean {
  if (!ctx) return false;
  const kind = ctx.context?.kind;
  if (kind === VOICE_DEVICE_CONTEXT_KIND || kind === VOICE_WORKER_CONTEXT_KIND) return false;
  if (ctx.contextOrigin === "default-credential") return false;
  // A runtime turn (or anything derived from one) carries the session it runs in.
  return Boolean(ctx.sessionKey || ctx.sessionName || ctx.context?.sessionKey);
}

/** Resolve the caller of a voice command. Throws for agent turns and dead device keys. */
export function resolveVoiceCaller(op: string): VoiceCaller {
  const ctx = getContext();
  if (isAgentTurnContext(ctx)) {
    throw new VoiceAuthorityError(
      "VOICE_AGENT_TURN_REFUSED",
      `${op} cannot run from an agent turn. Calls are started and approved by a person (CLI or a paired device).`,
    );
  }
  const record = ctx?.context;
  if (record?.kind === VOICE_DEVICE_CONTEXT_KIND || record?.kind === VOICE_WORKER_CONTEXT_KIND) {
    const device = getVoiceDeviceByContextId(record.contextId);
    if (!device || device.revokedAt || !isRuntimeContextLive(record)) {
      throw new VoiceAuthorityError("VOICE_DEVICE_REVOKED", "This voice device key is revoked or expired. Pair again.");
    }
    const worker = record.kind === VOICE_WORKER_CONTEXT_KIND;
    return {
      kind: worker ? "worker" : "device",
      speaker: { kind: "device", id: device.id, contactId: device.contactId, label: device.label },
      contextId: record.contextId,
      device,
    };
  }
  if (record) {
    // An operator-issued CLI context (`ravi context issue`) without a session.
    return {
      kind: "context",
      speaker: { kind: "operator", id: `context:${record.contextId}` },
      contextId: record.contextId,
    };
  }
  return { kind: "operator", speaker: { kind: "operator", id: "operator" } };
}

/** The caller needs the same reach as `sessions send` on the target session. */
export function assertCallerMayCallSession(caller: VoiceCaller, session: { name?: string; sessionKey: string }): void {
  const name = session.name ?? session.sessionKey;
  if (caller.kind === "device") {
    const allowed = caller.device?.sessions ?? [];
    if (allowed.includes("*") || allowed.includes(session.sessionKey)) return;
    throw new VoiceAuthorityError("VOICE_SESSION_FORBIDDEN", `This device was not paired for session ${name}.`);
  }
  if (caller.kind === "worker") {
    throw new VoiceAuthorityError("VOICE_SESSION_FORBIDDEN", "The voice worker joins calls; it cannot start them.");
  }
  if (!canAccessSession(getScopeContext(), name)) {
    throw new VoiceAuthorityError("VOICE_SESSION_FORBIDDEN", `No access to session ${name}.`);
  }
}

/**
 * Control of an existing call. The operator controls every call; a device only
 * its own; the worker may speak into and read hands-free calls of the device it
 * serves, but never approve, deny, cancel or end.
 */
export function assertCallerControlsCall(
  caller: VoiceCaller,
  call: VoiceCall,
  action: "read" | "speak" | "control" | "approve",
): void {
  if (caller.kind === "operator" || caller.kind === "context") {
    // A context reaches only the calls it opened; an operator call has no
    // callerContextId and stays the operator's.
    if (caller.kind === "context" && call.callerContextId !== caller.contextId) {
      throw new VoiceAuthorityError("VOICE_CALL_FORBIDDEN", "This call belongs to another caller.");
    }
    return;
  }
  if (caller.kind === "worker") {
    if (call.mode !== "handsfree") {
      throw new VoiceAuthorityError("VOICE_CALL_FORBIDDEN", "The voice worker only serves hands-free calls.");
    }
    if (action === "control" || action === "approve") {
      throw new VoiceAuthorityError("VOICE_CALL_FORBIDDEN", "The voice worker cannot approve, deny, cancel or end.");
    }
    return;
  }
  if (call.speaker.kind !== "device" || call.speaker.id !== caller.device?.id) {
    throw new VoiceAuthorityError("VOICE_CALL_FORBIDDEN", "This call belongs to another device.");
  }
}

/** Guests (third-party speakers) talk only when the profile opts in, and never control. */
export function assertGuestMaySpeak(allowGuests: boolean): void {
  if (!allowGuests) {
    throw new VoiceAuthorityError("VOICE_GUEST_FORBIDDEN", "This call's profile does not accept guest speakers.");
  }
}
