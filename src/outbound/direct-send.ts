/**
 * Direct Send - Send messages directly to contacts via WhatsApp
 *
 * Allows agents to proactively send messages to phone numbers
 * without going through the bot pipeline.
 */

import { notif } from "../notif.js";
import { isOptedOut, recordOutbound, getContact } from "../contacts.js";
import { logger } from "../utils/logger.js";

const log = logger.child("outbound:direct-send");

export interface DirectSendInput {
  to: string;
  text: string;
  channel?: "whatsapp";
  accountId?: string;
  sessionKey?: string;
  typingDelayMs?: number;
}

export interface DirectSendResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

/**
 * Send a message directly to a contact.
 *
 * The actual sending is done by emitting a notif event that the
 * WhatsApp plugin picks up. This decouples direct-send from
 * the WhatsApp module internals.
 */
export async function directSend(input: DirectSendInput): Promise<DirectSendResult> {
  const { to, text, accountId = "default" } = input;

  // Check opt-out
  if (isOptedOut(to)) {
    log.info("Skipping direct send - contact opted out", { to });
    return { success: false, error: "Contact has opted out" };
  }

  // Detect channel - for now only WhatsApp
  const channel = input.channel ?? "whatsapp";

  if (channel !== "whatsapp") {
    return { success: false, error: `Unsupported channel: ${channel}` };
  }

  try {
    // Emit to the outbound send topic
    // The gateway subscribes to this and routes to the correct plugin
    await notif.emit("ravi.outbound.send", {
      channel,
      accountId,
      to,
      text,
      sessionKey: input.sessionKey,
      typingDelayMs: input.typingDelayMs,
    });

    // Record outbound activity
    const contact = getContact(to);
    if (contact) {
      recordOutbound(to);
    }

    log.info("Direct send emitted", { to, channel, accountId });
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("Direct send failed", { to, error });
    return { success: false, error };
  }
}
