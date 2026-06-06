import { projectMailMessageToInbox, type LocalInboxItem } from "../inbox/local-db.js";
import { extractMailMessageId } from "../inbox/mail-enrichment.js";
import type { InboxNatsPayload } from "../inbox/types.js";
import { createMailAccount, createMailMailbox, getMailMailbox, importMailMessage, listMailAccounts } from "./db.js";
import type {
  MailAccount,
  MailAddressInput,
  MailDirection,
  MailMailbox,
  MailMessageStatus,
  MailMessageWithAddresses,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

const RAVI_MAIL_ACCOUNT_ID = "mail_acct_ravi_mail";
const RAVI_MAIL_PROVIDER = "ravi-mail";

export type ConsoleMailIngestStatus = "ingested" | "skipped";

export interface ConsoleMailIngestResult {
  status: ConsoleMailIngestStatus;
  reason?: string;
  message?: MailMessageWithAddresses;
  inboxItem?: LocalInboxItem | null;
  inboxCreated?: boolean;
}

export function ingestConsoleMailReceivedEvent(natsPayload: InboxNatsPayload): ConsoleMailIngestResult {
  if (natsPayload.eventType !== "mail.message.received") {
    return { status: "skipped", reason: "unsupported_event_type" };
  }

  const messageId = extractMailMessageId(natsPayload);
  if (!messageId) return { status: "skipped", reason: "missing_message_id" };

  const payload = asRecord(natsPayload.payload) ?? {};
  const mail = asRecord(payload.mail) ?? {};
  const mailboxAddress = firstString(
    mail.mailboxAddress,
    payload.mailboxAddress,
    asRecord(natsPayload.target)?.address,
    asRecord(natsPayload.target)?.email,
    looksLikeEmail(natsPayload.target.id) ? natsPayload.target.id : null,
  );
  if (!mailboxAddress) return { status: "skipped", reason: "missing_mailbox_address" };

  const mailboxId = firstString(mail.mailboxId, payload.mailboxId, natsPayload.target.id);
  const account = ensureRaviMailAccount();
  const mailbox = ensureRaviMailMailbox({ account, address: mailboxAddress, providerMailboxId: mailboxId });
  const bodyText = firstString(mail.bodyText, asRecord(mail.content)?.text, asRecord(payload.mailContent)?.text);
  const bodyHtml = firstString(mail.bodyHtml, asRecord(mail.content)?.html, asRecord(payload.mailContent)?.html);
  const addressSummary = asRecord(mail.addressSummary);
  const subject = firstString(mail.subject, payload.subject, natsPayload.title);
  const receivedAt = parseTimestamp(
    firstString(mail.receivedAt, payload.receivedAt, natsPayload.occurredAt, natsPayload.createdAt),
  );
  const message = importMailMessage({
    accountId: mailbox.accountId,
    mailboxId: mailbox.id,
    provider: RAVI_MAIL_PROVIDER,
    providerMessageId: messageId,
    providerThreadId: firstString(mail.threadId, payload.threadId),
    rfcMessageId: firstString(mail.internetMessageId, addressSummary?.internetMessageId, payload.internetMessageId),
    direction: readDirection(mail.direction),
    status: readStatus(mail.status),
    subject,
    snippet: firstString(payload.snippet, natsPayload.summary, bodyText),
    bodyText,
    bodyHtml,
    bodyRedactionStatus: bodyText || bodyHtml ? "full_local" : "preview_only",
    receivedAt,
    addresses: buildAddresses(mail, addressSummary, mailbox.address),
    attachments: buildAttachments(mail),
    safePayload: {
      source: "console_inbox",
      consoleInboxItemId: natsPayload.eventId,
      consoleSequence: natsPayload.sequence,
      consoleDedupeKey: natsPayload.dedupeKey,
      enrichment: asRecord(mail.enrichment) ?? null,
    },
    providerProvenance: {
      provider: RAVI_MAIL_PROVIDER,
      providerMessageId: messageId,
      providerMailboxId: mailboxId,
      consoleInboxItemId: natsPayload.eventId,
      consoleSequence: natsPayload.sequence,
    },
  });

  const projected = projectMailMessageToInbox(message);
  return {
    status: "ingested",
    message,
    inboxItem: projected?.item ?? null,
    inboxCreated: projected?.created ?? false,
  };
}

export function annotateConsoleMailPayloadWithLocalIngest(
  natsPayload: InboxNatsPayload,
  result: ConsoleMailIngestResult,
): InboxNatsPayload {
  if (natsPayload.eventType !== "mail.message.received") return natsPayload;
  const payload = asRecord(natsPayload.payload) ?? {};
  const mail = asRecord(payload.mail) ?? {};
  const localIngest =
    result.status === "ingested"
      ? {
          status: "ingested",
          messageId: result.message?.id ?? null,
          threadId: result.message?.threadId ?? null,
          mailboxId: result.message?.mailboxId ?? null,
          inboxItemId: result.inboxItem?.id ?? null,
          inboxCreated: result.inboxCreated ?? false,
        }
      : {
          status: "skipped",
          reason: result.reason ?? "unknown",
        };
  return {
    ...natsPayload,
    payload: {
      ...payload,
      mail: {
        ...mail,
        localIngest,
      },
    },
  };
}

function ensureRaviMailAccount(): MailAccount {
  const existing = listMailAccounts({ provider: RAVI_MAIL_PROVIDER, status: "active", limit: 50 })[0];
  if (existing) return existing;
  return createMailAccount({
    id: RAVI_MAIL_ACCOUNT_ID,
    provider: RAVI_MAIL_PROVIDER,
    displayName: "Ravi Mail",
    credentialsRef: "cloud-auth:ravi-mail",
    capabilities: {
      consoleEvents: true,
      localMailboxSourceOfTruth: true,
    },
  });
}

function ensureRaviMailMailbox(input: {
  account: MailAccount;
  address: string;
  providerMailboxId: string | null;
}): MailMailbox {
  const existing = getMailMailbox(input.address, input.account.id);
  if (existing) return existing;
  return createMailMailbox({
    accountId: input.account.id,
    address: input.address,
    providerMailboxId: input.providerMailboxId,
    role: "primary",
    metadata: {
      source: "console_inbox",
    },
  });
}

function buildAddresses(
  mail: JsonRecord,
  addressSummary: JsonRecord | null,
  mailboxAddress: string,
): MailAddressInput[] {
  const addresses: MailAddressInput[] = [];
  appendAddressList(addresses, "from", mail.from ?? addressSummary?.from);
  appendAddressList(addresses, "sender", mail.sender ?? addressSummary?.sender);
  appendAddressList(addresses, "to", mail.to ?? addressSummary?.to);
  appendAddressList(addresses, "cc", mail.cc ?? addressSummary?.cc);
  appendAddressList(addresses, "bcc", mail.bcc ?? addressSummary?.bcc);
  appendAddressList(addresses, "reply_to", mail.replyTo ?? addressSummary?.replyTo);
  if (!addresses.some((address) => address.kind === "to" && sameEmail(address.address, mailboxAddress))) {
    addresses.push({ kind: "to", address: mailboxAddress });
  }
  return dedupeAddresses(addresses);
}

function buildAttachments(mail: JsonRecord): NonNullable<Parameters<typeof importMailMessage>[0]["attachments"]> {
  const rawAttachments = mail.attachments;
  if (!Array.isArray(rawAttachments)) return [];
  return rawAttachments.flatMap((entry) => {
    const attachment = asRecord(entry);
    if (!attachment) return [];
    const providerAttachmentId = firstString(attachment.providerAttachmentId, attachment.id);
    return [
      {
        filename: firstString(attachment.filename),
        contentType: firstString(attachment.contentType),
        sizeBytes: readNumber(attachment.sizeBytes),
        sha256: firstString(attachment.sha256),
        providerAttachmentId,
        redactionStatus: firstString(attachment.status, attachment.redactionStatus),
        metadata: {
          source: "console_inbox",
          consoleAttachmentId: firstString(attachment.id),
          hasEncryptedObject: readBoolean(attachment.hasEncryptedObject),
        },
      },
    ];
  });
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function appendAddressList(addresses: MailAddressInput[], kind: MailAddressInput["kind"], value: unknown): void {
  if (!value) return;
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    if (typeof entry === "string") {
      if (looksLikeEmail(entry)) addresses.push({ kind, address: entry });
      continue;
    }
    const record = asRecord(entry);
    if (!record) continue;
    const address = firstString(record.address, record.email);
    if (!address) continue;
    addresses.push({
      kind,
      address,
      displayName: firstString(record.name, record.displayName),
      raw: record,
    });
  }
}

function dedupeAddresses(addresses: MailAddressInput[]): MailAddressInput[] {
  const seen = new Set<string>();
  const unique: MailAddressInput[] = [];
  for (const address of addresses) {
    const key = `${address.kind}:${address.address.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(address);
  }
  return unique;
}

function readDirection(value: unknown): MailDirection {
  return value === "outbound" || value === "draft" || value === "system" ? value : "inbound";
}

function readStatus(value: unknown): MailMessageStatus {
  if (
    value === "queued" ||
    value === "sending" ||
    value === "sent" ||
    value === "delivered" ||
    value === "failed" ||
    value === "archived" ||
    value === "trashed" ||
    value === "spam"
  ) {
    return value;
  }
  return "received";
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function looksLikeEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function sameEmail(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
