/**
 * WhatsApp DM Commands - Send messages and read receipts
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { nats } from "../../nats.js";
import { getContact, getContactIdentities, normalizePhone, formatPhone } from "../../contacts.js";
import { phoneToJid, jidToSessionId } from "../../channels/whatsapp/normalize.js";
import { getRecentHistory } from "../../db.js";

/**
 * Resolve the best WhatsApp JID for a contact reference.
 * Prefers LID (direct chat) over phone number.
 */
function resolveWhatsAppJid(contactRef: string): { jid: string; displayName: string } {
  const contact = getContact(contactRef);

  if (contact) {
    const identities = getContactIdentities(contact.id);
    // Prefer LID for DMs (direct WhatsApp internal ID)
    const lid = identities.find(i => i.platform === "whatsapp_lid");
    if (lid) {
      const jid = phoneToJid(`lid:${lid.value.replace(/^lid:/, "")}`);
      if (jid) return { jid, displayName: contact.name ?? formatPhone(contact.phone) };
    }
    // Fallback to phone
    const phone = identities.find(i => i.platform === "phone");
    if (phone) {
      const jid = phoneToJid(phone.value);
      if (jid) return { jid, displayName: contact.name ?? formatPhone(phone.value) };
    }
    // Last resort: contact.phone field
    if (contact.phone) {
      const jid = phoneToJid(contact.phone);
      if (jid) return { jid, displayName: contact.name ?? formatPhone(contact.phone) };
    }
  }

  // No contact found — try raw input
  const normalized = normalizePhone(contactRef);
  const jid = phoneToJid(normalized);
  if (!jid) throw new Error(`Cannot resolve to WhatsApp JID: ${contactRef}`);
  return { jid, displayName: formatPhone(normalized) };
}

@Group({
  name: "whatsapp.dm",
  description: "WhatsApp direct messages",
  scope: "open",
})
export class WhatsAppDmCommands {
  @Command({ name: "send", description: "Send a direct message to a contact" })
  async send(
    @Arg("contact", { description: "Contact ID, phone, or LID" }) contactRef: string,
    @Arg("message", { description: "Message text" }) message: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const { jid, displayName } = resolveWhatsAppJid(contactRef);

    // Strip common bash escape artifacts (e.g. Claude writes "oi\!" instead of "oi!")
    const cleanMessage = message.replace(/\\([!#$&*?])/g, "$1");

    await nats.emit("ravi.outbound.deliver", {
      channel: "whatsapp",
      accountId: account ?? "default",
      to: jid,
      text: cleanMessage,
    });

    console.log(`✓ Message sent to ${displayName} (${jid})`);
  }

  @Command({ name: "read", description: "Read recent messages from a DM chat" })
  async read(
    @Arg("contact", { description: "Contact ID, phone, or LID" }) contactRef: string,
    @Option({ flags: "--last <n>", description: "Number of messages to read (default: 10)" }) last?: string,
    @Option({ flags: "--no-ack", description: "Don't send read receipt" }) noAck?: boolean,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const { jid, displayName } = resolveWhatsAppJid(contactRef);
    const sessionId = jidToSessionId(jid);
    const limit = last ? parseInt(last, 10) : 10;

    const messages = getRecentHistory(sessionId, limit);

    if (messages.length === 0) {
      console.log(`No messages found for ${displayName}`);
      return;
    }

    console.log(`\n💬 ${displayName} (last ${messages.length})\n`);
    for (const msg of messages) {
      const time = msg.created_at.replace("T", " ").slice(0, 16);
      const role = msg.role === "user" ? "👤" : "🤖";
      console.log(`${role} [${time}] ${msg.content}`);
    }

    // Send ack for the last user message by default
    if (!noAck) {
      // Find last inbound message ID from content (mid tag)
      const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
      if (lastUserMsg) {
        const midMatch = lastUserMsg.content.match(/\[mid:([^\]]+)\]/);
        if (midMatch) {
          await nats.emit("ravi.outbound.receipt", {
            channel: "whatsapp",
            accountId: account ?? "default",
            chatId: jid,
            senderId: jid,
            messageIds: [midMatch[1]],
          });
          console.log(`\n✓ Read receipt sent (${midMatch[1]})`);
        }
      }
    }
  }

  @Command({ name: "ack", description: "Send read receipt (blue ticks) for a specific message" })
  async ack(
    @Arg("contact", { description: "Contact ID, phone, or LID" }) contactRef: string,
    @Arg("messageId", { description: "Message ID to mark as read" }) messageId: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string
  ) {
    const { jid, displayName } = resolveWhatsAppJid(contactRef);

    await nats.emit("ravi.outbound.receipt", {
      channel: "whatsapp",
      accountId: account ?? "default",
      chatId: jid,
      senderId: jid,
      messageIds: [messageId],
    });

    console.log(`✓ Read receipt sent for ${messageId} in ${displayName}`);
  }
}
