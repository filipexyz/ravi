import {
  mailAddressSummaryForOutbound,
  serializeMailAddressSummary,
} from "./address-summary";

export type ComposeOutboundMailInput = {
  bodyText: string;
  bcc?: string[];
  cc?: string[];
  from: string;
  messageId: string;
  subject: string;
  to: string[];
};

export type ComposeOutboundMailResult = {
  addressSummaryJson: string;
  headersJson: string;
  rawMime: string;
  recipients: string[];
  subject: string;
  text: string;
};

const EMAIL_ADDRESS_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const MAX_SUBJECT_BYTES = 998;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const textEncoder = new TextEncoder();

export function composeOutboundMail(input: ComposeOutboundMailInput): ComposeOutboundMailResult {
  const from = normalizeExternalEmailAddress(input.from);
  const recipients = input.to.map(normalizeExternalEmailAddress);
  if (!recipients.length) throw new MailComposeError("mail_recipient_missing");

  const subject = normalizeHeaderValue(input.subject, "subject");
  if (textEncoder.encode(subject).byteLength > MAX_SUBJECT_BYTES) {
    throw new MailComposeError("mail_subject_too_large");
  }

  const text = input.bodyText;
  if (textEncoder.encode(text).byteLength > MAX_BODY_BYTES) {
    throw new MailComposeError("mail_body_too_large");
  }

  const headers = [
    { name: "From", value: from },
    { name: "To", value: recipients.join(", ") },
    { name: "Subject", value: subject },
    { name: "Date", value: new Date().toUTCString() },
    { name: "Message-ID", value: `<${input.messageId}@ravi.mail>` },
    { name: "MIME-Version", value: "1.0" },
    { name: "Content-Type", value: "text/plain; charset=UTF-8" },
    { name: "Content-Transfer-Encoding", value: "8bit" },
  ];

  const rawMime = `${headers.map((header) => `${header.name}: ${header.value}`).join("\r\n")}\r\n\r\n${normalizeBody(
    text,
  )}`;

  return {
    headersJson: JSON.stringify({
      schemaVersion: 1,
      headers,
    }),
    addressSummaryJson: serializeMailAddressSummary(
      mailAddressSummaryForOutbound({
        from,
        to: recipients,
        cc: input.cc,
        bcc: input.bcc,
        internetMessageId: `<${input.messageId}@ravi.mail>`,
      }),
    ),
    rawMime,
    recipients,
    subject,
    text,
  };
}

export function normalizeExternalEmailAddress(value: string): string {
  const address = normalizeHeaderValue(value, "email").toLowerCase();
  if (!EMAIL_ADDRESS_PATTERN.test(address)) {
    throw new MailComposeError("mail_address_invalid");
  }
  return address;
}

export class MailComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailComposeError";
  }
}

function normalizeHeaderValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new MailComposeError(`mail_${label}_missing`);
  if (/[\r\n]/.test(normalized)) throw new MailComposeError(`mail_${label}_invalid`);
  return normalized;
}

function normalizeBody(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}
