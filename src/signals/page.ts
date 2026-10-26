import { getSessionByName } from "../router/sessions.js";
import { buildChannelTextOutboundJob, publishChannelOutboundJob } from "../channels/outbound-stream.js";
import type { MessageTarget } from "../runtime/message-types.js";
import { resolveSessionOutputTarget } from "../runtime/session-output-target.js";
import type { SignalRecord } from "./types.js";

/**
 * Where a page goes: the session's attached output, resolved like a
 * source-less turn (channel and thread split, the attached chat's account).
 */
export function resolveSignalPageTarget(sessionName: string): MessageTarget | null {
  const session = getSessionByName(sessionName);
  if (!session) return null;
  return resolveSessionOutputTarget({ sessionKey: session.sessionKey, fallback: undefined }).target;
}

export function buildSignalPageText(signal: SignalRecord, now = Date.now()): string {
  const observed = new Date(signal.lastSeenAt || now).toISOString().slice(11, 16);
  const detail = signal.detail ? ` — ${signal.detail}` : "";
  return `⚠ ${signal.title}${detail} (observed ${observed}Z). Ack: ravi signals ack ${signal.id}`;
}

export async function sendSignalPage(
  signal: SignalRecord,
  sessionName: string,
  bucket: string,
): Promise<"sent" | "skipped_no_binding" | "failed"> {
  const target = resolveSignalPageTarget(sessionName);
  if (!target) return "skipped_no_binding";
  try {
    const idempotencyKey = `signal-page:${signal.id}:${bucket}`;
    const job = buildChannelTextOutboundJob({
      requestId: idempotencyKey,
      sessionName,
      emitId: idempotencyKey,
      idempotencyKey,
      target,
      text: buildSignalPageText(signal),
    });
    await publishChannelOutboundJob(job);
    return "sent";
  } catch {
    return "failed";
  }
}
