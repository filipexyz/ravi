import {
  processEncryptedRawMimeParseJob,
  type MailParserDependencies,
  type MailParseJobInput,
  type MailParseResult,
} from "@/server/console/mail/parser";

export type MailParseQueueMessage = MailParseJobInput & {
  source: "mail_worker";
  enqueuedAt: string;
  routeId: string;
};

export type MailParseQueueResult =
  | MailParseResult
  | {
      ok: false;
      reason: "unsafe_queue_payload";
    };

const UNSAFE_QUEUE_FIELD_NAMES = new Set([
  "attachment",
  "attachmentcontent",
  "attachmentfilename",
  "bcc",
  "body",
  "cc",
  "content",
  "filename",
  "from",
  "headers",
  "html",
  "rawmime",
  "recipient",
  "recipients",
  "sender",
  "subject",
  "text",
  "to",
]);

export async function processMailParseQueueMessage(
  message: unknown,
  dependencies: MailParserDependencies,
): Promise<MailParseQueueResult> {
  try {
    assertSafeMailParseQueueMessage(message);
  } catch {
    return {
      ok: false,
      reason: "unsafe_queue_payload",
    };
  }

  return processEncryptedRawMimeParseJob({
    job: message,
    ...dependencies,
  });
}

export function assertSafeMailParseQueueMessage(message: unknown): asserts message is MailParseQueueMessage {
  if (!isPlainObject(message)) throw new Error("unsafe_queue_payload");
  const payload = message as Partial<MailParseQueueMessage>;
  if (payload.schemaVersion !== 1 || payload.source !== "mail_worker" || payload.direction !== "inbound") {
    throw new Error("unsafe_queue_payload");
  }

  for (const field of ["requestId", "enqueuedAt", "organizationId", "mailboxId", "routeId", "messageId", "providerAdapter"]) {
    if (typeof payload[field as keyof MailParseQueueMessage] !== "string") throw new Error("unsafe_queue_payload");
  }

  if (payload.projectId !== undefined && payload.projectId !== null && typeof payload.projectId !== "string") {
    throw new Error("unsafe_queue_payload");
  }

  if (!isPlainObject(payload.encryptedRawMime)) throw new Error("unsafe_queue_payload");
  if (
    typeof payload.encryptedRawMime.objectRef !== "string" ||
    typeof payload.encryptedRawMime.keyVersion !== "string" ||
    typeof payload.encryptedRawMime.sha256 !== "string" ||
    typeof payload.encryptedRawMime.sizeBytes !== "number" ||
    payload.encryptedRawMime.sizeBytes < 0
  ) {
    throw new Error("unsafe_queue_payload");
  }

  assertNoUnsafeQueueFields(payload);
}

function assertNoUnsafeQueueFields(value: unknown, path: string[] = []): void {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoUnsafeQueueFields(value[index], [...path, String(index)]);
    }
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    if (UNSAFE_QUEUE_FIELD_NAMES.has(normalized)) {
      throw new Error(`unsafe_queue_payload:${[...path, key].join(".")}`);
    }
    assertNoUnsafeQueueFields(nested, [...path, key]);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
