import type { MailMessagePayloadKind } from "../mail/client.js";
import type { InboxNatsPayload } from "./types.js";

type JsonRecord = Record<string, unknown>;

export type MailPayloadReader = (
  messageId: string,
  payloadKind: Extract<MailMessagePayloadKind, "subject" | "address_summary" | "parsed_body">,
) => Promise<JsonRecord>;

export interface MailPayloadEnrichmentOptions {
  now?: () => string;
}

export async function enrichMailMessageReceivedPayload(
  natsPayload: InboxNatsPayload,
  readPayload: MailPayloadReader,
  options: MailPayloadEnrichmentOptions = {},
): Promise<InboxNatsPayload> {
  if (natsPayload.eventType !== "mail.message.received") return natsPayload;

  const messageId = extractMailMessageId(natsPayload);
  if (!messageId) return withMailEnrichmentStatus(natsPayload, "skipped", "missing_message_id", options);

  const subject = readPlaintext(await readPayload(messageId, "subject"));
  const addressSummary = parseJsonRecord(readPlaintext(await readPayload(messageId, "address_summary")));
  const parsedBody = parseJsonRecord(readPlaintext(await readPayload(messageId, "parsed_body")));
  const bodyText = readString(parsedBody?.text);
  const bodyHtml = readString(parsedBody?.html);

  const payload = asRecord(natsPayload.payload) ?? {};
  const existingMail = asRecord(payload.mail) ?? {};
  const mail = {
    ...existingMail,
    messageId,
    mailboxId: firstString(existingMail.mailboxId, payload.mailboxId),
    mailboxAddress: firstString(existingMail.mailboxAddress, payload.mailboxAddress),
    receivedAt: firstString(existingMail.receivedAt, payload.receivedAt),
    direction: firstString(existingMail.direction, payload.direction),
    status: firstString(existingMail.status, payload.status),
    threadId: firstString(existingMail.threadId, payload.threadId),
    subject,
    addressSummary,
    from: addressSummary?.from ?? existingMail.from ?? null,
    to: addressSummary?.to ?? existingMail.to ?? null,
    cc: addressSummary?.cc ?? existingMail.cc ?? null,
    bcc: addressSummary?.bcc ?? existingMail.bcc ?? null,
    replyTo: addressSummary?.replyTo ?? existingMail.replyTo ?? null,
    internetMessageId: addressSummary?.internetMessageId ?? existingMail.internetMessageId ?? null,
    content: {
      schemaVersion: parsedBody?.schemaVersion ?? null,
      text: bodyText,
      html: bodyHtml,
      parsedBody,
    },
    bodyText,
    bodyHtml,
    enrichment: {
      status: "enriched",
      source: "console_mail_read",
      enrichedAt: (options.now ?? currentIso)(),
      payloadKinds: ["subject", "address_summary", "parsed_body"],
    },
  };

  return {
    ...natsPayload,
    payload: {
      ...payload,
      mail,
      mailContent: mail.content,
    },
  };
}

export function extractMailMessageId(natsPayload: InboxNatsPayload): string | null {
  const payload = asRecord(natsPayload.payload);
  const mail = asRecord(payload?.mail);
  const links = asRecord(natsPayload.links);
  const source = asRecord(natsPayload.source);

  return firstString(
    payload?.messageId,
    mail?.messageId,
    links?.messageId,
    source?.type === "mail_message" ? source.id : null,
    extractMessageIdFromLinks(natsPayload.links),
  );
}

export function withMailEnrichmentFailure(
  natsPayload: InboxNatsPayload,
  reason: string,
  options: MailPayloadEnrichmentOptions = {},
): InboxNatsPayload {
  return withMailEnrichmentStatus(natsPayload, "failed", reason, options);
}

function withMailEnrichmentStatus(
  natsPayload: InboxNatsPayload,
  status: "skipped" | "failed",
  reason: string,
  options: MailPayloadEnrichmentOptions,
): InboxNatsPayload {
  if (natsPayload.eventType !== "mail.message.received") return natsPayload;
  const payload = asRecord(natsPayload.payload) ?? {};
  const existingMail = asRecord(payload.mail) ?? {};
  const messageId = extractMailMessageId(natsPayload);
  const mail = {
    ...existingMail,
    ...(messageId ? { messageId } : {}),
    mailboxId: firstString(existingMail.mailboxId, payload.mailboxId),
    mailboxAddress: firstString(existingMail.mailboxAddress, payload.mailboxAddress),
    enrichment: {
      status,
      reason,
      attemptedAt: (options.now ?? currentIso)(),
    },
  };
  return {
    ...natsPayload,
    payload: {
      ...payload,
      mail,
    },
  };
}

function extractMessageIdFromLinks(linksValue: unknown): string | null {
  const links = asRecord(linksValue);
  if (links) {
    const consoleLink = asRecord(links.console);
    return firstString(
      links.messageId,
      extractMessageIdFromUrl(readString(consoleLink?.message)),
      extractMessageIdFromUrl(readString(links.messageUrl)),
    );
  }

  if (!Array.isArray(linksValue)) return null;
  for (const link of linksValue) {
    const linkRecord = asRecord(link);
    const candidate = firstString(
      linkRecord?.messageId,
      extractMessageIdFromUrl(readString(linkRecord?.url)),
      extractMessageIdFromUrl(readString(linkRecord?.href)),
    );
    if (candidate) return candidate;
  }
  return null;
}

function extractMessageIdFromUrl(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/\/mail\/messages\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function readPlaintext(response: JsonRecord): string | null {
  return readString(response.plaintext);
}

function parseJsonRecord(value: string | null): JsonRecord | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const stringValue = readString(value);
    if (stringValue) return stringValue;
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function currentIso(): string {
  return new Date().toISOString();
}
