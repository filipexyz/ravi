/**
 * Who is calling, and what they may do. Spec `voice`, section Authority.
 *
 * - Agent turns never start, connect, approve or deny calls, nor does any key
 *   bound to an agent identity (a turn, or a context an agent issued).
 * - The operator is the local default credential (`ravi daemon init-admin-key`)
 *   or that same admin-bootstrap key presented through the gateway, and may
 *   call any session it can access.
 * - A paired device (context kind `voice-device`) may call only the sessions
 *   listed at pairing and only control its own calls.
 * - The speaker never adds authority: the session turn runs with the caller's.
 * - Voice profiles (voices, models, limits) are managed by the operator, or by a key the operator
 *   issued with `mutate:voice:profiles`. Device and worker keys only read them, even though they
 *   carry `mutate voice *` for their own calls.
 */
import { getContext, type ToolContext } from "../cli/context.js";
import { canAccessSession, getScopeContext } from "../permissions/scope.js";
import { isRuntimeContextLive } from "../runtime/context-liveness.js";
import { ADMIN_BOOTSTRAP_AGENT_ID, ADMIN_BOOTSTRAP_KIND, revokeRuntimeContext } from "../runtime/context-registry.js";
import { dbGetContext } from "../router/router-db.js";
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
  /** For `context` callers: the capabilities the operator issued to that key. */
  capabilities?: ReadonlyArray<{ permission: string; objectType: string; objectId: string }>;
}

/** The capability an operator issues for managing voice profiles through the gateway or SDK. */
export const VOICE_PROFILES_MANAGE_CAPABILITY = {
  permission: "mutate",
  objectType: "voice",
  objectId: "profiles",
} as const;

/** May this caller create, change, bind or delete voice profiles? Never a device or worker key. */
export function callerMayManageVoiceProfiles(caller: VoiceCaller): boolean {
  if (caller.kind === "operator") return true;
  if (caller.kind !== "context") return false;
  return (caller.capabilities ?? []).some(
    (capability) =>
      (capability.permission === "admin" && capability.objectType === "system" && capability.objectId === "*") ||
      (capability.permission === VOICE_PROFILES_MANAGE_CAPABILITY.permission &&
        capability.objectType === VOICE_PROFILES_MANAGE_CAPABILITY.objectType &&
        capability.objectId === VOICE_PROFILES_MANAGE_CAPABILITY.objectId),
  );
}

/** The operator's own key: the local default credential, or the admin-bootstrap key it is. */
function isOperatorContext(ctx: ToolContext | undefined): boolean {
  if (!ctx?.context) return false;
  if (ctx.contextOrigin === "default-credential") return true;
  return ctx.context.kind === ADMIN_BOOTSTRAP_KIND && !ctx.context.sessionKey;
}

function isAgentTurnContext(ctx: ToolContext | undefined): boolean {
  if (!ctx) return false;
  const kind = ctx.context?.kind;
  if (kind === VOICE_DEVICE_CONTEXT_KIND || kind === VOICE_WORKER_CONTEXT_KIND) return false;
  if (isOperatorContext(ctx)) return false;
  // A runtime turn (or anything derived from one) carries the session it runs in.
  if (ctx.sessionKey || ctx.sessionName || ctx.context?.sessionKey) return true;
  // A key bound to an agent identity is that agent's work even without a session
  // (`ravi context issue --as-agent`). Keys the operator issues carry the
  // bootstrap identity, and device keys carry none.
  const agentId = ctx.context?.agentId ?? ctx.agentId;
  return Boolean(agentId && agentId !== ADMIN_BOOTSTRAP_AGENT_ID);
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
  if (isOperatorContext(ctx)) return { kind: "operator", speaker: { kind: "operator", id: "operator" } };
  if (record) {
    // An operator-issued CLI context (`ravi context issue`) without a session.
    return {
      kind: "context",
      speaker: { kind: "operator", id: `context:${record.contextId}` },
      contextId: record.contextId,
      capabilities: record.capabilities ?? [],
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

/** Revoke a voice device's runtime context unless it already is. Idempotent. */
export function revokeVoiceDeviceContext(contextId: string): boolean {
  const record = dbGetContext(contextId);
  if (!record || record.revokedAt) return false;
  revokeRuntimeContext(contextId, { reason: "voice_device_revoked" });
  return true;
}
