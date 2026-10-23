import { dbGetChat, dbGetSessionDefaultChatId } from "../router/router-db.js";
import { getSessionByName } from "../router/sessions.js";
import { buildChannelTextOutboundJob, publishChannelOutboundJob } from "../channels/outbound-stream.js";
import type { MessageTarget } from "../runtime/message-types.js";
import type { SignalRecord } from "./types.js";

export function resolveSessionOutputTarget(sessionName: string): MessageTarget | null {
  const session = getSessionByName(sessionName);
  if (!session) return null;
  const chatId = dbGetSessionDefaultChatId(session.sessionKey);
  if (!chatId) return null;
  const chat = dbGetChat(chatId);
  if (!chat) return null;
  const channel = chat.channel || session.channel;
  const accountId = session.accountId;
  if (!channel || !accountId) return null;
  return {
    channel,
    accountId,
    ...(chat.instanceId ? { instanceId: chat.instanceId } : {}),
    chatId: chat.platformChatId,
    ...(session.lastThreadId ? { threadId: session.lastThreadId } : {}),
  };
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
  const target = resolveSessionOutputTarget(sessionName);
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
