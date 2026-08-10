/**
 * WhatsApp DM Commands - Send messages and read receipts
 */

import "reflect-metadata";
import { Group, Command, CommandAccess, Arg, Option } from "../decorators.js";
import { contractDryRun, contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { hashForAudit } from "../provenance.js";
import { commandEnvelopeReturnSchema, declareCommandReturns } from "./operational-return-schemas.js";
import { nats } from "../../nats.js";
import { getContact, getContactIdentities, normalizePhone, formatPhone, searchContacts } from "../../contacts.js";
import { getFirstAccountName } from "../../router/router-db.js";
import { phoneToJid, jidToSessionId } from "../../utils/phone.js";
import { getRecentHistory } from "../../db.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function pseudonymousTargetRef(value: string): string {
  return `sha256:${hashForAudit(value)}`;
}

/**
 * CONTACT_NOT_FOUND envelope (Manual v2): the target could not be resolved to
 * a WhatsApp JID. Suggestions come from the LOCAL contacts DB
 * (`searchContacts`) — a cheap local source, no live bridge call involved.
 */
function failDmContactNotFound(op: string, contactRef: string, asJson?: boolean): never {
  const digits = contactRef.replace(/\D/g, "");
  const candidates = [
    ...searchContacts(contactRef),
    ...(digits.length >= 4 ? searchContacts(digits.slice(-4)) : []),
  ].flatMap((contact) => [contact.name ?? "", contact.phone ?? ""]);
  contractFail(op, "CONTACT_NOT_FOUND", `Cannot resolve to WhatsApp JID: ${contactRef}`, {
    asJson,
    details: {
      suggestedAction: "Check the contact id/phone (list with: ravi contacts list --json)",
      suggestions: suggestSimilar(contactRef, candidates),
    },
  });
}

/**
 * Resolve the best WhatsApp JID for a contact reference.
 * Prefers WhatsApp platform identities over phone number.
 * Fails with the CONTACT_NOT_FOUND envelope when nothing resolves.
 */
function resolveWhatsAppJid(op: string, contactRef: string, asJson?: boolean): { jid: string; displayName: string } {
  const contact = getContact(contactRef);

  if (contact) {
    const identities = getContactIdentities(contact.id);
    const whatsapp = identities.find((i) => i.platform === "whatsapp");
    if (whatsapp) {
      const jid = phoneToJid(whatsapp.value);
      if (jid) return { jid, displayName: contact.name ?? formatPhone(contact.phone) };
    }
    const phone = identities.find((i) => i.platform === "phone");
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
  if (!jid) failDmContactNotFound(op, contactRef, asJson);
  return { jid, displayName: formatPhone(normalized) };
}

@Group({
  name: "whatsapp.dm",
  description: "WhatsApp direct messages",
  scope: "open",
})
export class WhatsAppDmCommands {
  @Command({ name: "send", description: "Send a direct message to a contact" })
  @CommandAccess({
    kind: "mutate",
    resource: "whatsapp.dm",
    action: "send",
    risk: "high",
    requiresConfirmation: true,
    redactions: ["contact", "message"],
  })
  async send(
    @Arg("contact", { description: "Contact ID, phone, or WhatsApp identity" }) contactRef: string,
    @Arg("message", { description: "Message text" }) message: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually send the message; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const { jid, displayName } = resolveWhatsAppJid("whatsapp dm send", contactRef, asJson);
    const accountId = account ?? getFirstAccountName() ?? "";

    // Strip common bash escape artifacts (e.g. Claude writes "oi\!" instead of "oi!")
    const cleanMessage = message.replace(/\\([!#$&*?])/g, "$1");

    if (execute !== true) {
      // Write brake (Manual v2 7.8): a DM reaches a real person and cannot be
      // reliably unsent, so dry-run by default and exit 3 before any NATS/queue
      // call.
      contractDryRun(
        "whatsapp dm send",
        {
          channel: "whatsapp",
          accountId,
          targetType: "contact",
          targetRef: pseudonymousTargetRef(jid),
          effect: "send-message",
          messageChars: cleanMessage.length,
        },
        { asJson },
      );
    }

    await nats.emit("ravi.outbound.deliver", {
      channel: "whatsapp",
      accountId,
      to: jid,
      text: cleanMessage,
    });

    const payload = {
      status: "sent" as const,
      channel: "whatsapp" as const,
      accountId,
      target: contactRef,
      to: jid,
      displayName,
      text: cleanMessage,
      changedCount: 1,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Message sent to ${displayName} (${jid})`);
    }
    return payload;
  }

  @Command({ name: "read", description: "Read recent messages from a DM chat" })
  @CommandAccess({
    kind: "read",
    resource: "whatsapp.dm",
    action: "read",
    risk: "low",
    redactions: ["contact"],
  })
  async read(
    @Arg("contact", { description: "Contact ID, phone, or WhatsApp identity" }) contactRef: string,
    @Option({ flags: "--last <n>", description: "Number of messages to read (default: 10)" }) last?: string,
    @Option({
      flags: "--account <id>",
      description: "WhatsApp account ID (accepted for compatibility; local history is account-independent)",
    })
    account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each message" })
    fields?: string,
    @Option({
      flags: "--no-ack",
      description: "Deprecated compatibility no-op; dm read never sends a receipt",
    })
    noAck?: boolean,
  ) {
    const { jid, displayName } = resolveWhatsAppJid("whatsapp dm read", contactRef, asJson);
    const sessionId = jidToSessionId(jid);
    const limit = last ? parseInt(last, 10) : 10;
    // Kept for CLI compatibility; local history is not account-scoped.
    void account;
    // Kept for legacy scripts; reads are now always local and receipt-free.
    void noAck;

    const messages = getRecentHistory(sessionId, limit);

    if (messages.length === 0) {
      const emptyPayload = {
        contact: contactRef,
        displayName,
        jid,
        sessionId,
        limit,
        total: 0,
        messages: [],
      };
      if (asJson) {
        printJson(emptyPayload);
      } else {
        console.log(`No messages found for ${displayName}`);
      }
      return emptyPayload;
    }

    if (!asJson) {
      console.log(`\n💬 ${displayName} (last ${messages.length})\n`);
      for (const msg of messages) {
        const time = msg.created_at.replace("T", " ").slice(0, 16);
        const role = msg.role === "user" ? "👤" : "🤖";
        console.log(`${role} [${time}] ${msg.content}`);
      }
    }

    const payload = {
      contact: contactRef,
      displayName,
      jid,
      sessionId,
      limit,
      total: messages.length,
      // Compact mode (Manual v2 7.9): narrows the message objects only.
      messages: pickFields(messages, fields),
    };

    if (asJson) {
      printJson(payload);
    }
    return payload;
  }

  @Command({ name: "ack", description: "Send read receipt (blue ticks) for a specific message" })
  @CommandAccess({
    kind: "mutate",
    resource: "whatsapp.dm",
    action: "ack",
    risk: "high",
    requiresConfirmation: true,
    redactions: ["contact", "messageId"],
  })
  async ack(
    @Arg("contact", { description: "Contact ID, phone, or WhatsApp identity" }) contactRef: string,
    @Arg("messageId", { description: "Message ID to mark as read" }) messageId: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually send the read receipt; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const { jid, displayName } = resolveWhatsAppJid("whatsapp dm ack", contactRef, asJson);
    const accountId = account ?? getFirstAccountName() ?? "";

    if (execute !== true) {
      contractDryRun(
        "whatsapp dm ack",
        {
          channel: "whatsapp",
          accountId,
          targetType: "contact",
          targetRef: pseudonymousTargetRef(jid),
          effect: "send-read-receipt",
          receiptCount: 1,
        },
        { asJson },
      );
    }

    await nats.emit("ravi.outbound.receipt", {
      channel: "whatsapp",
      accountId,
      chatId: jid,
      senderId: jid,
      messageIds: [messageId],
    });

    const payload = {
      status: "acknowledged" as const,
      channel: "whatsapp" as const,
      accountId,
      target: contactRef,
      jid,
      displayName,
      messageIds: [messageId],
      changedCount: 1,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Read receipt sent for ${messageId} in ${displayName}`);
    }
    return payload;
  }
}

declareCommandReturns(WhatsAppDmCommands, {
  ack: commandEnvelopeReturnSchema,
  read: commandEnvelopeReturnSchema,
  send: commandEnvelopeReturnSchema,
});
