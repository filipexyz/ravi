import { resolveCredentialSecret } from "../../credentials/broker.js";

export interface GmailAccessCredential {
  accessToken: string;
}

export interface GmailMessageRef {
  id?: string;
  threadId?: string;
}

export interface GmailMessage extends GmailMessageRef {
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
  raw?: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessageListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailListMessagesOptions {
  q?: string;
  labelIds?: string[];
  maxResults?: number;
  pageToken?: string;
  includeSpamTrash?: boolean;
}

export interface GmailSendMessageInput {
  raw: string;
  threadId?: string;
}

type CredentialResolver = (connection: string, action: string) => Promise<GmailAccessCredential>;

export interface GmailClientOptions {
  connection?: string;
  fetch?: typeof globalThis.fetch;
  /** In-process credential injection for tests and isolated migration validation. */
  credential?: GmailAccessCredential;
  /** Test seam that proves missing credentials fail before any network request. */
  credentialResolver?: CredentialResolver;
}

export interface GmailMimeMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html?: boolean;
  inReplyTo?: string;
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

export class GmailClient {
  readonly #connection: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #credential?: GmailAccessCredential;
  readonly #credentialResolver: CredentialResolver;

  constructor(options: GmailClientOptions = {}) {
    this.#connection = options.connection ?? "default";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#credential = options.credential;
    this.#credentialResolver =
      options.credentialResolver ??
      (async (connection, action) =>
        parseGmailCredential(
          (
            await resolveCredentialSecret({
              provider: "gmail",
              connection,
              action,
            })
          ).secret,
        ));
  }

  async listMessages(options: GmailListMessagesOptions = {}): Promise<GmailMessageListResponse> {
    const query = new URLSearchParams();
    if (options.q) query.set("q", options.q);
    for (const labelId of options.labelIds ?? []) query.append("labelIds", labelId);
    if (options.maxResults !== undefined) query.set("maxResults", String(options.maxResults));
    if (options.pageToken) query.set("pageToken", options.pageToken);
    if (options.includeSpamTrash !== undefined) query.set("includeSpamTrash", String(options.includeSpamTrash));
    return this.#request<GmailMessageListResponse>("/users/me/messages", "messages.list", { query });
  }

  async getMessage(id: string, format: "minimal" | "full" | "raw" | "metadata" = "full"): Promise<GmailMessage> {
    const query = new URLSearchParams({ format });
    return this.#request<GmailMessage>(`/users/me/messages/${encodeURIComponent(id)}`, "messages.get", { query });
  }

  async sendMessage(input: GmailSendMessageInput): Promise<GmailMessage> {
    return this.#request<GmailMessage>("/users/me/messages/send", "messages.send", {
      method: "POST",
      body: { raw: input.raw, ...(input.threadId ? { threadId: input.threadId } : {}) },
    });
  }

  async #credentialFor(action: string): Promise<GmailAccessCredential> {
    return this.#credential ?? this.#credentialResolver(this.#connection, action);
  }

  async #request<T>(
    path: string,
    action: string,
    options: { method?: "GET" | "POST"; query?: URLSearchParams; body?: unknown } = {},
  ): Promise<T> {
    const credential = await this.#credentialFor(action);
    const suffix = options.query && options.query.size > 0 ? `?${options.query.toString()}` : "";
    const response = await this.#fetch(`${GMAIL_API}${path}${suffix}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential.accessToken}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    if (!response.ok) {
      const detail = redactProviderError(await response.text());
      throw new Error(`Gmail API ${response.status}: ${detail || response.statusText}`);
    }
    if (response.status === 204) return {} as T;
    return (await response.json()) as T;
  }
}

export function parseGmailCredential(value: string): GmailAccessCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Gmail credential must be a JSON object with accessToken");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gmail credential must be a JSON object with accessToken");
  }
  const source = parsed as Record<string, unknown>;
  const accessToken = stringValue(source.accessToken) ?? stringValue(source.access_token);
  if (!accessToken) throw new Error("Gmail credential is missing accessToken");
  return { accessToken };
}

export function encodeGmailMimeMessage(input: GmailMimeMessageInput): string {
  const headers = [
    ["To", input.to.join(", ")],
    ...(input.cc?.length ? [["Cc", input.cc.join(", ")]] : []),
    ...(input.bcc?.length ? [["Bcc", input.bcc.join(", ")]] : []),
    ["Subject", input.subject],
    ...(input.inReplyTo
      ? [
          ["In-Reply-To", input.inReplyTo],
          ["References", input.inReplyTo],
        ]
      : []),
    ["MIME-Version", "1.0"],
    ["Content-Type", `${input.html ? "text/html" : "text/plain"}; charset=UTF-8`],
    ["Content-Transfer-Encoding", "8bit"],
  ];
  for (const [name, value] of headers) assertSafeHeader(name, value);
  const message = `${headers.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n${input.body}`;
  return Buffer.from(message, "utf8").toString("base64url");
}

function assertSafeHeader(name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain line breaks`);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function redactProviderError(value: string): string {
  return value
    .slice(0, 2_000)
    .replace(/("?(?:access_token|refresh_token|client_secret)"?\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}
