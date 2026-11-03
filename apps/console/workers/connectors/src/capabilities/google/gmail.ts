/**
 * Gmail capability handlers.
 *
 * Each handler talks to Gmail's REST API using a Ravi-managed access
 * token (passed in, never persisted). Output is the raw provider
 * payload; the registry's Zod output schema strips unknown fields
 * before the response reaches the caller.
 */

import type { GoogleCapabilityHandler } from "../../adapters/google";
import { AdapterProviderError } from "../../adapters/adapter";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

export function buildGmailHandlers(fetchImpl: typeof fetch = fetch): Map<string, GoogleCapabilityHandler> {
  return new Map<string, GoogleCapabilityHandler>([
    ["gmail.message.send", gmailMessageSend(fetchImpl)],
    ["gmail.message.list", gmailMessageList(fetchImpl)],
    ["gmail.message.read", gmailMessageRead(fetchImpl)],
  ]);
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessageFull {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
}

function gmailMessageRead(fetchImpl: typeof fetch): GoogleCapabilityHandler {
  return {
    async execute(input) {
      const params = input.parameters as { id: string; format?: "full" | "metadata" | "raw" };
      const url = new URL(`${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(params.id)}`);
      url.searchParams.set("format", params.format ?? "full");
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${input.accessToken}` },
        signal: input.abortSignal,
      });
      const message = (await readJsonOrThrow(response)) as GmailMessageFull | null;
      if (!message) return { id: params.id, threadId: "", headers: {}, body: {} };
      const headers = headerMap(message.payload?.headers);
      const body = extractBody(message.payload);
      return {
        id: message.id ?? params.id,
        threadId: message.threadId ?? "",
        labelIds: message.labelIds,
        snippet: message.snippet,
        internalDate: message.internalDate,
        sizeEstimate: message.sizeEstimate,
        headers: {
          from: headers.get("from"),
          to: headers.get("to"),
          cc: headers.get("cc"),
          bcc: headers.get("bcc"),
          subject: headers.get("subject"),
          date: headers.get("date"),
          replyTo: headers.get("reply-to"),
          messageId: headers.get("message-id"),
        },
        body,
      };
    },
  };
}

function headerMap(headers: GmailHeader[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of headers ?? []) {
    map.set(header.name.toLowerCase(), header.value);
  }
  return map;
}

function extractBody(part: GmailPart | undefined): { text?: string; html?: string } {
  if (!part) return {};
  const out: { text?: string; html?: string } = {};
  visit(part);
  return out;

  function visit(node: GmailPart) {
    const mime = node.mimeType ?? "";
    if (mime.startsWith("text/") && node.body?.data) {
      const decoded = decodeBase64Url(node.body.data);
      if (mime === "text/plain" && !out.text) out.text = decoded;
      if (mime === "text/html" && !out.html) out.html = decoded;
    }
    for (const child of node.parts ?? []) visit(child);
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

function gmailMessageSend(fetchImpl: typeof fetch): GoogleCapabilityHandler {
  return {
    async execute(input) {
      const params = input.parameters as {
        to: string[];
        cc?: string[];
        bcc?: string[];
        subject: string;
        body: string;
        bodyHtml?: string;
        inReplyTo?: string;
        references?: string[];
        threadId?: string;
      };
      const mime = buildMimeMessage(params);
      const encoded = base64UrlEncode(new TextEncoder().encode(mime));
      const response = await fetchImpl(`${GMAIL_API_BASE}/users/me/messages/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        signal: input.abortSignal,
        body: JSON.stringify({
          raw: encoded,
          threadId: params.threadId,
        }),
      });
      const result = (await readJsonOrThrow(response)) as
        | { id?: string; threadId?: string; labelIds?: string[] }
        | null;
      return {
        messageId: result?.id,
        threadId: result?.threadId,
        labelIds: result?.labelIds,
      };
    },
  };
}

function gmailMessageList(fetchImpl: typeof fetch): GoogleCapabilityHandler {
  return {
    async execute(input) {
      const params = input.parameters as {
        q?: string;
        labelIds?: string[];
        pageToken?: string;
        maxResults?: number;
      };
      const url = new URL(`${GMAIL_API_BASE}/users/me/messages`);
      if (params.q) url.searchParams.set("q", params.q);
      if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);
      if (params.maxResults) url.searchParams.set("maxResults", String(params.maxResults));
      for (const labelId of params.labelIds ?? []) url.searchParams.append("labelIds", labelId);
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${input.accessToken}` },
        signal: input.abortSignal,
      });
      return readJsonOrThrow(response);
    },
  };
}

export function buildMimeMessage(input: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string[];
}): string {
  const headers: string[] = [
    `To: ${headerValue(input.to.join(", "))}`,
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (input.cc && input.cc.length > 0) headers.push(`Cc: ${headerValue(input.cc.join(", "))}`);
  if (input.bcc && input.bcc.length > 0) headers.push(`Bcc: ${headerValue(input.bcc.join(", "))}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${headerValue(input.inReplyTo)}`);
  if (input.references && input.references.length > 0) {
    headers.push(`References: ${headerValue(input.references.join(" "))}`);
  }
  if (input.bodyHtml) {
    const boundary = `ravi_${cryptoRandomHex(8)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const text = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      quotedPrintable(input.body),
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      quotedPrintable(input.bodyHtml),
      `--${boundary}--`,
      "",
    ];
    return [...headers, "", ...text].join("\r\n");
  }
  headers.push("Content-Type: text/plain; charset=utf-8");
  headers.push("Content-Transfer-Encoding: quoted-printable");
  return [...headers, "", quotedPrintable(input.body)].join("\r\n");
}

async function readJsonOrThrow(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    let providerCode: string | null = null;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
      providerCode = parsed?.error?.status ?? null;
    } catch {
      /* not JSON */
    }
    throw new AdapterProviderError(response.status, providerCode, "Gmail API request failed");
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdapterProviderError(502, "invalid_response", "Gmail returned non-JSON body");
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A header value on one line. The input schema already refuses line breaks;
 * this is the second line of defense, since a CR or LF here would start a
 * header (or the body) of its own.
 */
function headerValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ");
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]+$/.test(value)) return value;
  return `=?utf-8?B?${btoa(unescape(encodeURIComponent(value)))}?=`;
}

function quotedPrintable(input: string): string {
  // Minimal QP encoder for ASCII + UTF-8 text. Gmail accepts this for
  // standard message bodies without attachments.
  const bytes = new TextEncoder().encode(input);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    if (b === 0x09 || b === 0x20 || (b >= 0x21 && b <= 0x7e && b !== 0x3d)) {
      out += String.fromCharCode(b);
    } else if (b === 0x0a) {
      out += "\r\n";
    } else {
      out += `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function cryptoRandomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}
