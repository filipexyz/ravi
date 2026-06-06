import { isExplicitConnect, publish } from "../nats.js";
import { logger } from "../utils/logger.js";
import type { MailMessageWithAddresses } from "../mailbox/types.js";
import type { LocalInboxItem } from "./local-db.js";

const log = logger.child("inbox:events");

export const LOCAL_INBOX_MAIL_RECEIVED_SUBJECT = "ravi.inbox.mail.received" as const;

export interface LocalInboxMailReceivedPayload {
  version: 1;
  eventType: "inbox.mail.received";
  inboxItemId: string;
  sourceDomain: "mail";
  sourceType: "mail_message";
  sourceId: string;
  mail: {
    messageId: string;
    threadId: string;
    mailboxId: string;
    accountId: string;
    providerMessageId: string | null;
    providerThreadId: string | null;
    rfcMessageId: string | null;
    subject: string | null;
    snippet: string | null;
    bodyRedactionStatus: string;
    receivedAt: number | null;
    from: Array<{ address: string; name: string | null }>;
    fromText: string;
    to: Array<{ address: string; name: string | null }>;
    toText: string;
    attachments: Array<{
      id: string;
      providerAttachmentId: string | null;
      filename: string | null;
      contentType: string | null;
      sizeBytes: number | null;
      sha256: string | null;
      redactionStatus: string | null;
      hasLocalBlob: boolean;
    }>;
  };
  inbox: {
    title: string | null;
    summary: string | null;
    status: string;
    priority: string;
    occurredAt: number | null;
    createdAt: number;
  };
  occurredAt: string | null;
  createdAt: string;
}

type InboxEventPublisher = (subject: string, payload: Record<string, unknown>) => Promise<void> | void;

let publisherForTests: InboxEventPublisher | null = null;

export function setLocalInboxEventPublisherForTests(publisher?: InboxEventPublisher): void {
  publisherForTests = publisher ?? null;
}

export function emitLocalInboxMailReceived(input: { item: LocalInboxItem; message: MailMessageWithAddresses }): void {
  const payload = buildLocalInboxMailReceivedPayload(input);
  const publisher = publisherForTests ?? (isExplicitConnect() ? publish : null);
  if (!publisher) return;
  Promise.resolve(publisher(LOCAL_INBOX_MAIL_RECEIVED_SUBJECT, payload as unknown as Record<string, unknown>)).catch(
    (error) => {
      log.warn("Failed to publish local inbox mail received event", {
        inboxItemId: input.item.id,
        mailMessageId: input.message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

function buildLocalInboxMailReceivedPayload(input: {
  item: LocalInboxItem;
  message: MailMessageWithAddresses;
}): LocalInboxMailReceivedPayload {
  const { item, message } = input;
  const from = formatAddressList(message, "from");
  const to = formatAddressList(message, "to");
  return {
    version: 1,
    eventType: "inbox.mail.received",
    inboxItemId: item.id,
    sourceDomain: "mail",
    sourceType: "mail_message",
    sourceId: message.id,
    mail: {
      messageId: message.id,
      threadId: message.threadId,
      mailboxId: message.mailboxId,
      accountId: message.accountId,
      providerMessageId: message.providerMessageId,
      providerThreadId: message.providerThreadId,
      rfcMessageId: message.rfcMessageId,
      subject: message.subject,
      snippet: message.snippet,
      bodyRedactionStatus: message.bodyRedactionStatus,
      receivedAt: message.receivedAt,
      from: from.addresses,
      fromText: from.text,
      to: to.addresses,
      toText: to.text,
      attachments: message.attachments.map((attachment) => ({
        id: attachment.id,
        providerAttachmentId: attachment.providerAttachmentId,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
        redactionStatus: attachment.redactionStatus,
        hasLocalBlob: Boolean(attachment.localBlobRef),
      })),
    },
    inbox: {
      title: item.title,
      summary: item.summary,
      status: item.status,
      priority: item.priority,
      occurredAt: item.occurredAt,
      createdAt: item.createdAt,
    },
    occurredAt: item.occurredAt ? new Date(item.occurredAt).toISOString() : null,
    createdAt: new Date(item.createdAt).toISOString(),
  };
}

function formatAddressList(
  message: MailMessageWithAddresses,
  kind: "from" | "to",
): { addresses: Array<{ address: string; name: string | null }>; text: string } {
  const addresses = message.addresses
    .filter((address) => address.kind === kind)
    .map((address) => ({ address: address.address, name: address.displayName }));
  return {
    addresses,
    text: addresses.map(formatAddress).join(", "),
  };
}

function formatAddress(address: { address: string; name: string | null }): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}
