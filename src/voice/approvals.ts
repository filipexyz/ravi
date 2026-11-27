/**
 * Tap-only approvals in a call.
 *
 * A voice turn carries `_approvalSource: { channel: "voice", chatId: <call> }`.
 * The approval service then asks the gateway to deliver the request on channel
 * `voice`; the gateway hands it here, and the call shows it as
 * `turn.approval_requested`. `calls approve` answers with an inbound reaction
 * that the approval service checks against the grantor gate, using the voice
 * grantor resolver below (device → paired contact, operator → the owner).
 */
import { createHash } from "node:crypto";
import { registerGrantorIdentityResolver } from "../approval/grantor.js";
import { getApprovalRequest, listOpenApprovalRequestsForChannelChat } from "../approval/store.js";
import { findContactsByTag } from "../contacts.js";
import { OWNER_CONTACT_TAG } from "../knowledge/owner.js";
import { emitVoiceEvent, type VoiceEventSink } from "./events.js";
import { getVoiceCall, getVoiceDevice, listVoiceEvents } from "./store.js";

export const VOICE_CHANNEL = "voice";
export const VOICE_ACCOUNT_ID = "voice";
export const VOICE_OPERATOR_SENDER = "operator";
export const VOICE_APPROVE_EMOJI = "👍";
export const VOICE_REJECT_EMOJI = "👎";
const APPROVAL_TEXT_LIMIT = 2000;

export function voiceApprovalMessageId(callId: string, approvalId: string): string {
  return `voice:${callId}:${approvalId}`;
}

/** The call and request a voice approval message id names, or null for any other id. */
export function parseVoiceApprovalMessageId(messageId: string): { callId: string; approvalId: string } | null {
  const match = /^voice:([^:]+):(.+)$/.exec(messageId);
  return match ? { callId: match[1] as string, approvalId: match[2] as string } : null;
}

export function voiceApprovalDigest(approvalId: string, text: string): string {
  return createHash("sha256").update(`${approvalId}\n${text}`).digest("hex").slice(0, 16);
}

export interface VoiceDirectSendInput {
  channel: string;
  accountId?: string;
  to: string;
  text?: string;
  /** The approval request this text belongs to, set by the approval service. */
  approvalRequestId?: string;
}

export type VoiceDirectSendResult = { success: true; messageId: string } | { success: false; error: string };

/**
 * Gateway branch for `ravi.outbound.deliver` on channel `voice`. Only an open
 * approval request the approval service itself created for this call is shown;
 * anything else sent to the voice channel is refused (agents cannot paint
 * approvals into a call).
 */
export async function deliverVoiceApprovalRequest(
  input: VoiceDirectSendInput,
  now = Date.now(),
): Promise<VoiceDirectSendResult> {
  const callId = input.to;
  const call = getVoiceCall(callId);
  if (!call || call.state === "ended") return { success: false, error: "VOICE_CALL_NOT_ACTIVE" };
  // The text must belong to the request it names: an open, not yet shown
  // request of this call. Without that id nothing is shown.
  const requestId = input.approvalRequestId?.trim();
  if (!requestId) return { success: false, error: "VOICE_NOT_AN_APPROVAL" };
  const request = listOpenApprovalRequestsForChannelChat(VOICE_CHANNEL, callId, now).find(
    (candidate) => candidate.id === requestId && !candidate.messageId,
  );
  if (!request) return { success: false, error: "VOICE_NOT_AN_APPROVAL" };
  const text = (input.text ?? "").slice(0, APPROVAL_TEXT_LIMIT);
  const approvalId = request.id;
  await emitVoiceEvent(callId, "turn.approval_requested", {
    approvalId,
    version: 1,
    digest: voiceApprovalDigest(approvalId, text),
    text,
    type: request.type,
    expiresAt: request.expiresAt,
  });
  return { success: true, messageId: voiceApprovalMessageId(callId, approvalId) };
}

export interface OpenVoiceApproval {
  approvalId: string;
  version: number;
  digest: string;
  text: string;
}

/** Approvals shown in the call and not yet resolved, newest first. */
export function listOpenVoiceApprovals(callId: string): OpenVoiceApproval[] {
  const events = listVoiceEvents(callId, { limit: 5000 });
  const resolved = new Set(
    events.filter((event) => event.type === "turn.approval_resolved").map((event) => String(event.data.approvalId)),
  );
  return events
    .filter((event) => event.type === "turn.approval_requested" && !resolved.has(String(event.data.approvalId)))
    .map((event) => ({
      approvalId: String(event.data.approvalId),
      version: Number(event.data.version ?? 1),
      digest: String(event.data.digest ?? ""),
      text: String(event.data.text ?? ""),
    }))
    .reverse();
}

/** The voice channel's grantor identity: a device's paired contact, or the owner for the local operator. */
export function resolveVoiceGrantorIdentity(input: {
  senderId: string;
}): { ownerType: "contact"; ownerId: string } | null {
  if (input.senderId === VOICE_OPERATOR_SENDER) {
    const owners = [...new Set(findContactsByTag(OWNER_CONTACT_TAG).map((contact) => contact.id))];
    return owners.length === 1 ? { ownerType: "contact", ownerId: owners[0] as string } : null;
  }
  const device = getVoiceDevice(input.senderId);
  if (!device || device.revokedAt || device.expiresAt <= Date.now()) return null;
  return { ownerType: "contact", ownerId: device.contactId };
}

let registered = false;
export function registerVoiceGrantorResolver(): void {
  if (registered) return;
  registered = true;
  registerGrantorIdentityResolver(VOICE_CHANNEL, resolveVoiceGrantorIdentity);
}

export type VoiceApprovalOutcome = "approved" | "rejected" | "expired";

/**
 * Show in the call what the approval store committed for a request the call
 * still shows as open: `turn.approval_resolved` with the decision, or
 * `expired` when the request timed out or was withdrawn. The store is the only
 * source; nothing happens while the request is pending. The open check and the
 * append run in the same tick, so one process publishes an outcome once.
 */
export async function publishVoiceApprovalOutcome(
  callId: string,
  approvalId: string,
  options: { by?: string; sink?: VoiceEventSink } = {},
): Promise<VoiceApprovalOutcome | null> {
  const record = getApprovalRequest(approvalId);
  if (!record || record.status === "pending") return null;
  const decision: VoiceApprovalOutcome = record.status === "decided" && record.decision ? record.decision : "expired";
  const call = getVoiceCall(callId);
  if (!call || call.state === "ending" || call.state === "ended") return null;
  if (!listOpenVoiceApprovals(callId).some((open) => open.approvalId === approvalId)) return null;
  const by = options.by ?? record.decidedBy ?? undefined;
  await emitVoiceEvent(callId, "turn.approval_resolved", { approvalId, decision, ...(by ? { by } : {}) }, options.sink);
  return decision;
}
