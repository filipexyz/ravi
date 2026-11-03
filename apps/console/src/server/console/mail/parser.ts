import {
  mailAddressSummaryFromHeaders,
  serializeMailAddressSummary,
} from "./address-summary";

export type MailParseJobInput = {
  schemaVersion: 1;
  requestId: string;
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  messageId: string;
  providerAdapter: string;
  direction: "inbound";
  encryptedRawMime: MailEncryptedRawMimeRef;
  envelope?: {
    senderHash?: string;
    recipientHash?: string;
    rawSizeBytes?: number;
  };
};

export type MailEncryptedRawMimeRef = {
  cipherRef: unknown;
  objectRef: string;
  keyVersion: string;
  sha256: string;
  sizeBytes: number;
};

export type MailParserCipherRef = Record<string, unknown> & {
  schemaVersion: number;
  ciphertextRef: string;
  algorithm: string;
  wrappedKeyRef: string;
  aadHash: string;
  keyVersion: number;
  createdAt: string;
};

export type MailParsedPayloadKind =
  | "subject"
  | "headers"
  | "parsed_body"
  | "address_summary"
  | "attachment_filename"
  | "attachment_object";

export type MailDecryptRawMimeInput = {
  requestId: string;
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  messageId: string;
  encryptedRawMime: MailEncryptedRawMimeRef;
};

export type MailEncryptParsedPayloadInput = {
  requestId: string;
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  messageId: string;
  payloadKind: MailParsedPayloadKind;
  plaintext: string | Uint8Array;
  attachmentId?: string;
  contentType?: string | null;
};

export type MailEncryptedParsedPayload = {
  cipherRef: MailParserCipherRef;
  objectRef?: string;
  sha256?: string;
  sizeBytes?: number;
};

export type MailParseClassification = {
  schemaVersion: 1;
  category: "unknown";
  hasAttachments: boolean;
  attachmentCount: number;
};

export type MailParsedGuardrailAttachmentInput = {
  attachmentId: string;
  filename: string | null;
  contentType: string | null;
  content: Uint8Array;
  sha256: string;
  sizeBytes: number;
};

export type MailParsedGuardrailInput = {
  schemaVersion: 1;
  requestId: string;
  organizationId: string;
  projectId: string | null;
  mailboxId: string;
  messageId: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  attachments: MailParsedGuardrailAttachmentInput[];
  classification: MailParseClassification;
};

export type MailParsedGuardrailResult = {
  metadataJson?: Record<string, unknown>;
};

export type MailPersistParsedMessageInput = {
  requestId: string;
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  messageId: string;
  attachments: MailPersistParsedAttachmentInput[];
  subjectCipherRef: MailParserCipherRef;
  headersCipherRef: MailParserCipherRef;
  parsedBodyCipherRef: MailParserCipherRef;
  addressSummaryCipherRef: MailParserCipherRef;
  classification: MailParseClassification;
  metadataJson?: Record<string, unknown>;
  parsedAt: string;
};

export type MailPersistParsedAttachmentInput = {
  requestId: string;
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  messageId: string;
  attachmentId: string;
  filenameCipherRef?: MailParserCipherRef | null;
  objectCipherRef: MailParserCipherRef;
  contentType?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
  status: "unscanned";
  metadataJson?: Record<string, unknown>;
};

export type MailRecordParseFailureInput = {
  requestId: string;
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  messageId: string;
  reason: MailParseFailureReason;
};

export type MailParseFailureReason = "decrypt_failed" | "malformed_mime" | "persist_failed";

export type MailParseResult =
  | {
      ok: true;
      attachmentCount: number;
      classification: MailParseClassification;
    }
  | {
      ok: false;
      reason: MailParseFailureReason;
    };

export type MailParserDependencies = {
  decryptRawMime(input: MailDecryptRawMimeInput): Promise<string | ArrayBuffer | ArrayBufferView>;
  encryptParsedPayload(input: MailEncryptParsedPayloadInput): Promise<MailEncryptedParsedPayload>;
  guardParsedMime?(input: MailParsedGuardrailInput): Promise<MailParsedGuardrailResult>;
  persistParsedMessage(input: MailPersistParsedMessageInput): Promise<void>;
  persistParsedAttachment(input: MailPersistParsedAttachmentInput): Promise<void>;
  recordParseFailure?(input: MailRecordParseFailureInput): Promise<void>;
  now?: () => Date;
};

type ParsedMime = {
  headers: ParsedHeader[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  attachments: ParsedAttachment[];
};

type ParsedHeader = {
  name: string;
  value: string;
};

type ParsedMimePart = {
  headers: ParsedHeader[];
  body: string;
};

type ParsedAttachment = {
  filename: string | null;
  contentType: string | null;
  content: Uint8Array;
  sha256: string;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export async function processEncryptedRawMimeParseJob({
  decryptRawMime,
  encryptParsedPayload,
  guardParsedMime,
  job,
  now = () => new Date(),
  persistParsedAttachment,
  persistParsedMessage,
  recordParseFailure,
}: MailParserDependencies & { job: MailParseJobInput }): Promise<MailParseResult> {
  let rawMime: string | ArrayBuffer | ArrayBufferView;
  try {
    rawMime = await decryptRawMime({
      requestId: job.requestId,
      organizationId: job.organizationId,
      projectId: job.projectId ?? null,
      mailboxId: job.mailboxId,
      messageId: job.messageId,
      encryptedRawMime: job.encryptedRawMime,
    });
  } catch {
    await recordFailure(job, "decrypt_failed", recordParseFailure);
    return { ok: false, reason: "decrypt_failed" };
  }

  let parsed: ParsedMime;
  try {
    parsed = await parseRawMime(rawMime);
  } catch {
    await recordFailure(job, "malformed_mime", recordParseFailure);
    return { ok: false, reason: "malformed_mime" };
  }

  try {
    const classification = classifyParsedMime(parsed);
    const guardrail = await guardParsedMime?.(buildGuardrailInput(job, parsed, classification));
    const subject = await encryptParsedPayload(parsedPayload(job, "subject", parsed.subject));
    const headers = await encryptParsedPayload(
      parsedPayload(
        job,
        "headers",
        JSON.stringify({
          schemaVersion: 1,
          headers: parsed.headers,
        }),
      ),
    );
    const parsedBody = await encryptParsedPayload(
      parsedPayload(
        job,
        "parsed_body",
        JSON.stringify({
          schemaVersion: 1,
          text: parsed.bodyText,
          html: parsed.bodyHtml,
        }),
      ),
    );
    const addressSummary = await encryptParsedPayload(
      parsedPayload(job, "address_summary", serializeMailAddressSummary(mailAddressSummaryFromHeaders(parsed.headers))),
    );

    const guardrailAttachments = guardrailAttachmentMetadataById(guardrail?.metadataJson);
    const persistedAttachments: MailPersistParsedAttachmentInput[] = [];

    for (let index = 0; index < parsed.attachments.length; index += 1) {
      const attachment = parsed.attachments[index];
      if (!attachment) continue;

      const attachmentId = `${job.messageId}:attachment:${index + 1}`;
      const filename = attachment.filename
        ? await encryptParsedPayload(
            parsedPayload(job, "attachment_filename", attachment.filename, {
              attachmentId,
              contentType: attachment.contentType,
            }),
          )
        : null;
      const object = await encryptParsedPayload(
        parsedPayload(job, "attachment_object", attachment.content, {
          attachmentId,
          contentType: attachment.contentType,
        }),
      );

      persistedAttachments.push({
        requestId: job.requestId,
        organizationId: job.organizationId,
        projectId: job.projectId ?? null,
        mailboxId: job.mailboxId,
        messageId: job.messageId,
        attachmentId,
        filenameCipherRef: filename?.cipherRef ?? null,
        objectCipherRef: object.cipherRef,
        contentType: attachment.contentType,
        sizeBytes: attachment.content.byteLength,
        sha256: attachment.sha256,
        status: "unscanned",
        metadataJson: {
          parserAttachmentId: attachmentId,
          ...(guardrailAttachments.get(attachmentId)
            ? { guardrail: guardrailAttachments.get(attachmentId) }
            : {}),
        },
      });
    }

    await persistParsedMessage({
      requestId: job.requestId,
      organizationId: job.organizationId,
      projectId: job.projectId ?? null,
      mailboxId: job.mailboxId,
      messageId: job.messageId,
      attachments: persistedAttachments,
      subjectCipherRef: subject.cipherRef,
      headersCipherRef: headers.cipherRef,
      parsedBodyCipherRef: parsedBody.cipherRef,
      addressSummaryCipherRef: addressSummary.cipherRef,
      classification,
      ...(guardrail?.metadataJson ? { metadataJson: guardrail.metadataJson } : {}),
      parsedAt: now().toISOString(),
    });

    for (const attachment of persistedAttachments) {
      await persistParsedAttachment(attachment);
    }

    return {
      ok: true,
      attachmentCount: parsed.attachments.length,
      classification,
    };
  } catch {
    await recordFailure(job, "persist_failed", recordParseFailure);
    return { ok: false, reason: "persist_failed" };
  }
}

export async function parseRawMime(rawMime: string | ArrayBuffer | ArrayBufferView): Promise<ParsedMime> {
  const root = parseMimePart(toText(rawMime));
  if (root.headers.length === 0) throw new MailMimeParseError();

  const contentType = headerValue(root.headers, "content-type");
  const boundary = contentType ? parseHeaderParameter(contentType, "boundary") : null;
  const parts = boundary ? splitMultipartBody(root.body, boundary).map(parseMimePart) : [root];
  if (boundary && parts.length === 0) throw new MailMimeParseError();

  let bodyText = "";
  let bodyHtml: string | null = null;
  const attachments: ParsedAttachment[] = [];

  for (const part of parts) {
    const partContentType = headerValue(part.headers, "content-type") ?? "text/plain";
    const disposition = headerValue(part.headers, "content-disposition");
    const filename =
      parseHeaderParameter(disposition, "filename") ?? parseHeaderParameter(partContentType, "name");
    const isAttachment = Boolean(filename) || dispositionType(disposition) === "attachment";

    if (isAttachment) {
      const content = decodePartBody(part.body, headerValue(part.headers, "content-transfer-encoding"));
      attachments.push({
        filename: filename ? decodeMimeWords(filename) : null,
        contentType: mediaType(partContentType),
        content,
        sha256: await sha256Hex(content),
      });
      continue;
    }

    if (mediaType(partContentType) === "text/plain" && !bodyText) {
      bodyText = decodePartText(part);
    } else if (mediaType(partContentType) === "text/html" && bodyHtml === null) {
      bodyHtml = decodePartText(part);
    }
  }

  return {
    headers: root.headers,
    subject: decodeMimeWords(headerValue(root.headers, "subject") ?? ""),
    bodyText,
    bodyHtml,
    attachments,
  };
}

function parsedPayload(
  job: MailParseJobInput,
  payloadKind: MailParsedPayloadKind,
  plaintext: string | Uint8Array,
  options: { attachmentId?: string; contentType?: string | null } = {},
): MailEncryptParsedPayloadInput {
  return {
    requestId: job.requestId,
    organizationId: job.organizationId,
    projectId: job.projectId ?? null,
    mailboxId: job.mailboxId,
    messageId: job.messageId,
    payloadKind,
    plaintext,
    ...(options.attachmentId ? { attachmentId: options.attachmentId } : {}),
    ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
  };
}

function classifyParsedMime(parsed: ParsedMime): MailParseClassification {
  return {
    schemaVersion: 1,
    category: "unknown",
    hasAttachments: parsed.attachments.length > 0,
    attachmentCount: parsed.attachments.length,
  };
}

function buildGuardrailInput(
  job: MailParseJobInput,
  parsed: ParsedMime,
  classification: MailParseClassification,
): MailParsedGuardrailInput {
  return {
    schemaVersion: 1,
    requestId: job.requestId,
    organizationId: job.organizationId,
    projectId: job.projectId ?? null,
    mailboxId: job.mailboxId,
    messageId: job.messageId,
    subject: parsed.subject,
    bodyText: parsed.bodyText,
    bodyHtml: parsed.bodyHtml,
    attachments: parsed.attachments.map((attachment, index) => ({
      attachmentId: `${job.messageId}:attachment:${index + 1}`,
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: attachment.content,
      sha256: attachment.sha256,
      sizeBytes: attachment.content.byteLength,
    })),
    classification,
  };
}

function guardrailAttachmentMetadataById(metadataJson: unknown): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!metadataJson || typeof metadataJson !== "object" || Array.isArray(metadataJson)) return result;
  const guardrail = (metadataJson as { guardrail?: unknown }).guardrail;
  if (!guardrail || typeof guardrail !== "object" || Array.isArray(guardrail)) return result;
  const attachments = (guardrail as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return result;
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) continue;
    const attachmentId = (attachment as { attachmentId?: unknown }).attachmentId;
    if (typeof attachmentId !== "string" || !attachmentId) continue;
    result.set(attachmentId, attachment as Record<string, unknown>);
  }
  return result;
}

async function recordFailure(
  job: MailParseJobInput,
  reason: MailParseFailureReason,
  recordParseFailure?: (input: MailRecordParseFailureInput) => Promise<void>,
): Promise<void> {
  await recordParseFailure?.({
    requestId: job.requestId,
    organizationId: job.organizationId,
    projectId: job.projectId ?? null,
    mailboxId: job.mailboxId,
    messageId: job.messageId,
    reason,
  });
}

function parseMimePart(input: string): ParsedMimePart {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const separatorIndex = normalized.indexOf("\n\n");
  if (separatorIndex < 0) throw new MailMimeParseError();

  return {
    headers: parseHeaders(normalized.slice(0, separatorIndex)),
    body: normalized.slice(separatorIndex + 2),
  };
}

function parseHeaders(headerText: string): ParsedHeader[] {
  const lines = headerText.split("\n");
  const unfolded: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line)) {
      if (unfolded.length === 0) throw new MailMimeParseError();
      unfolded[unfolded.length - 1] = `${unfolded[unfolded.length - 1]} ${line.trim()}`;
      continue;
    }
    unfolded.push(line);
  }

  const headers = unfolded.map((line) => {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new MailMimeParseError();
    const name = line.slice(0, separator).trim();
    if (!HEADER_NAME_PATTERN.test(name)) throw new MailMimeParseError();
    return {
      name,
      value: line.slice(separator + 1).trim(),
    };
  });

  if (headers.length === 0) throw new MailMimeParseError();
  return headers;
}

function splitMultipartBody(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const parts: string[] = [];
  const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let collecting = false;
  let current: string[] = [];

  for (const line of lines) {
    if (line === marker || line === `${marker}--`) {
      if (collecting && current.length > 0) parts.push(current.join("\n"));
      if (line === `${marker}--`) return parts;
      collecting = true;
      current = [];
      continue;
    }

    if (collecting) current.push(line);
  }

  return parts;
}

function headerValue(headers: ParsedHeader[], name: string): string | null {
  const normalized = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === normalized)?.value ?? null;
}

function mediaType(contentType: string | null): string | null {
  return contentType?.split(";")[0]?.trim().toLowerCase() || null;
}

function dispositionType(disposition: string | null): string | null {
  return disposition?.split(";")[0]?.trim().toLowerCase() || null;
}

function parseHeaderParameter(header: string | null | undefined, parameterName: string): string | null {
  if (!header) return null;
  const parameters = header.split(";").slice(1);
  const target = parameterName.toLowerCase();

  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (separator < 0) continue;
    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (name !== target) continue;
    return stripQuotes(parameter.slice(separator + 1).trim());
  }

  return null;
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

function decodePartText(part: ParsedMimePart): string {
  const contentType = headerValue(part.headers, "content-type");
  const charset = parseHeaderParameter(contentType, "charset");
  return decodeTextBytes(
    decodePartBody(part.body, headerValue(part.headers, "content-transfer-encoding")),
    charset,
  );
}

function decodePartBody(body: string, encoding: string | null): Uint8Array {
  const normalizedEncoding = encoding?.trim().toLowerCase();
  if (normalizedEncoding === "base64") {
    return base64ToBytes(body.replace(/\s/g, ""));
  }
  if (normalizedEncoding === "quoted-printable") {
    return decodeQuotedPrintableBytes(body);
  }
  return textEncoder.encode(trimTrailingMimeLineBreak(body));
}

function trimTrailingMimeLineBreak(value: string): string {
  return value.replace(/\n$/, "");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeQuotedPrintableBytes(value: string): Uint8Array {
  const normalized = trimTrailingMimeLineBreak(value).replace(/=\r?\n/g, "");
  const bytes: number[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "=") {
      const hex = normalized.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }

    if (!char) continue;
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0xff) {
      bytes.push(codePoint);
      continue;
    }

    bytes.push(...textEncoder.encode(char));
  }

  return new Uint8Array(bytes);
}

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g, (_match, charset: string, encoding: string, text: string) => {
    const bytes =
      encoding.toUpperCase() === "B"
        ? base64ToBytes(text)
        : decodeQuotedPrintableBytes(text.replace(/_/g, " "));
    return decodeTextBytes(bytes, charset);
  });
}

function decodeTextBytes(bytes: Uint8Array, charset: string | null | undefined): string {
  const normalizedCharset = charset?.trim() || "utf-8";
  try {
    return new TextDecoder(normalizedCharset).decode(bytes);
  } catch {
    return textDecoder.decode(bytes);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toText(rawMime: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof rawMime === "string") return rawMime;
  if (rawMime instanceof ArrayBuffer) return textDecoder.decode(rawMime);
  return textDecoder.decode(new Uint8Array(rawMime.buffer, rawMime.byteOffset, rawMime.byteLength));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

class MailMimeParseError extends Error {
  constructor() {
    super("Malformed MIME message.");
    this.name = "MailMimeParseError";
  }
}
