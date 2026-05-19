import { ConsoleApiClient, getMeWithAutoRefresh, normalizeConsoleUrl } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";

export interface MailClientOptions {
  console?: string;
}

export interface MailClientDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

export interface MailListOptions extends MailClientOptions {
  limit?: number;
  offset?: number;
}

export interface MailboxListOptions extends MailListOptions {
  domain?: string;
}

export interface MailboxCreateOptions extends MailClientOptions {
  addressOrLocalPart: string;
  domain: string;
}

export interface MailDomainCreateOptions extends MailClientOptions {
  domain: string;
}

export interface MessageListOptions extends MailListOptions {
  includeAddresses?: boolean;
  mailbox: string;
}

export type MailMessagePayloadKind = "subject" | "raw_mime" | "parsed_body" | "headers" | "address_summary";

export interface MessageShowOptions extends MailClientOptions {
  includeAddresses?: boolean;
}

export interface MessageReadOptions extends MailClientOptions {
  payloadKind?: MailMessagePayloadKind;
}

export interface MailSendOptions extends MailClientOptions {
  from?: string;
  to: string[];
  subject: string;
  body: string;
  idempotencyKey?: string;
}

export interface AuthenticatedMailContext {
  consoleUrl: string;
  accessToken: string;
  client: ConsoleApiClient;
}

export class RaviMailClient {
  constructor(private readonly client: ConsoleApiClient) {}

  async listDomains(accessToken: string, options: MailListOptions = {}): Promise<Record<string, unknown>> {
    return sanitizeMetadataResponse(
      await this.request<Record<string, unknown>>(
        "GET",
        withQuery("/api/cli/mail/domains", paginationQuery(options)),
        undefined,
        accessToken,
      ),
    );
  }

  async createDomain(accessToken: string, options: MailDomainCreateOptions): Promise<Record<string, unknown>> {
    return sanitizeMetadataResponse(
      await this.request<Record<string, unknown>>(
        "POST",
        "/api/cli/mail/domains",
        {
          domain: options.domain,
        },
        accessToken,
      ),
    );
  }

  async listMailboxes(accessToken: string, options: MailboxListOptions = {}): Promise<Record<string, unknown>> {
    return sanitizeMetadataResponse(
      await this.request<Record<string, unknown>>(
        "GET",
        withQuery("/api/cli/mail/mailboxes", { ...paginationQuery(options), domain: options.domain }),
        undefined,
        accessToken,
      ),
    );
  }

  async createMailbox(accessToken: string, options: MailboxCreateOptions): Promise<Record<string, unknown>> {
    return sanitizeMetadataResponse(
      await this.request<Record<string, unknown>>(
        "POST",
        "/api/cli/mail/mailboxes",
        {
          addressOrLocalPart: options.addressOrLocalPart,
          domainRef: options.domain,
        },
        accessToken,
      ),
    );
  }

  async showMailbox(accessToken: string, mailbox: string): Promise<Record<string, unknown>> {
    return sanitizeMetadataResponse(
      await this.request<Record<string, unknown>>(
        "GET",
        `/api/cli/mail/mailboxes/${encodeURIComponent(mailbox)}`,
        undefined,
        accessToken,
      ),
    );
  }

  async listMessages(accessToken: string, options: MessageListOptions): Promise<Record<string, unknown>> {
    return sanitizeMetadataResponse(
      await this.request<Record<string, unknown>>(
        "GET",
        withQuery("/api/cli/mail/messages", {
          ...paginationQuery(options),
          mailbox: options.mailbox,
          addresses: options.includeAddresses ? "1" : undefined,
        }),
        undefined,
        accessToken,
      ),
    );
  }

  async showMessage(
    accessToken: string,
    message: string,
    options: MessageShowOptions = {},
  ): Promise<Record<string, unknown>> {
    return sanitizeMetadataResponse(
      await this.request<Record<string, unknown>>(
        "GET",
        withQuery(`/api/cli/mail/messages/${encodeURIComponent(message)}`, {
          addresses: options.includeAddresses ? "1" : undefined,
        }),
        undefined,
        accessToken,
      ),
    );
  }

  async readMessage(
    accessToken: string,
    message: string,
    options: MessageReadOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "POST",
      `/api/cli/mail/messages/${encodeURIComponent(message)}/read`,
      {
        ...(options.payloadKind ? { payloadKind: options.payloadKind } : {}),
      },
      accessToken,
    );
  }

  async send(accessToken: string, options: MailSendOptions): Promise<Record<string, unknown>> {
    return sanitizeMetadataResponse(
      await this.request<Record<string, unknown>>(
        "POST",
        "/api/cli/mail/send",
        {
          ...(options.from ? { from: options.from } : {}),
          to: options.to,
          subject: options.subject,
          body: options.body,
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        },
        accessToken,
      ),
    );
  }

  private async request<T>(method: string, path: string, body: unknown, accessToken: string): Promise<T> {
    try {
      return await this.client.requestJson<T>(method, path, body, accessToken);
    } catch (error) {
      throw normalizeMailError(error);
    }
  }
}

export async function createAuthenticatedMailContext(
  options: MailClientOptions = {},
  deps: MailClientDeps = {},
): Promise<AuthenticatedMailContext> {
  const credentials = requireStoredCredentials((deps.readCredentials ?? readCloudCredentials)(), options.console);
  const client = deps.client ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl });
  const auth = await getMeWithAutoRefresh({
    client,
    credentials,
    write: deps.writeCredentials ?? writeCloudCredentials,
    delete: deps.deleteCredentials ?? deleteCloudCredentials,
  });
  return {
    consoleUrl: auth.credentials.consoleUrl,
    accessToken: auth.credentials.accessToken,
    client,
  };
}

export async function listMailDomains(
  options: MailListOptions = {},
  deps: MailClientDeps = {},
): Promise<Record<string, unknown>> {
  const auth = await createAuthenticatedMailContext(options, deps);
  return new RaviMailClient(auth.client).listDomains(auth.accessToken, options);
}

export async function createMailDomain(
  options: MailDomainCreateOptions,
  deps: MailClientDeps = {},
): Promise<Record<string, unknown>> {
  const auth = await createAuthenticatedMailContext(options, deps);
  return new RaviMailClient(auth.client).createDomain(auth.accessToken, options);
}

export async function listMailboxes(
  options: MailboxListOptions = {},
  deps: MailClientDeps = {},
): Promise<Record<string, unknown>> {
  const auth = await createAuthenticatedMailContext(options, deps);
  return new RaviMailClient(auth.client).listMailboxes(auth.accessToken, options);
}

export async function createMailbox(
  options: MailboxCreateOptions,
  deps: MailClientDeps = {},
): Promise<Record<string, unknown>> {
  const auth = await createAuthenticatedMailContext(options, deps);
  return new RaviMailClient(auth.client).createMailbox(auth.accessToken, options);
}

export async function showMailbox(
  mailbox: string,
  options: MailClientOptions = {},
  deps: MailClientDeps = {},
): Promise<Record<string, unknown>> {
  const auth = await createAuthenticatedMailContext(options, deps);
  return new RaviMailClient(auth.client).showMailbox(auth.accessToken, mailbox);
}

export async function listMessages(
  options: MessageListOptions,
  deps: MailClientDeps = {},
): Promise<Record<string, unknown>> {
  const auth = await createAuthenticatedMailContext(options, deps);
  return new RaviMailClient(auth.client).listMessages(auth.accessToken, options);
}

export async function showMessage(
  message: string,
  options: MessageShowOptions = {},
  deps: MailClientDeps = {},
): Promise<Record<string, unknown>> {
  const auth = await createAuthenticatedMailContext(options, deps);
  return new RaviMailClient(auth.client).showMessage(auth.accessToken, message, options);
}

export async function readMessage(
  message: string,
  options: MessageReadOptions = {},
  deps: MailClientDeps = {},
): Promise<Record<string, unknown>> {
  const auth = await createAuthenticatedMailContext(options, deps);
  return new RaviMailClient(auth.client).readMessage(auth.accessToken, message, options);
}

export async function sendMail(options: MailSendOptions, deps: MailClientDeps = {}): Promise<Record<string, unknown>> {
  const auth = await createAuthenticatedMailContext(options, deps);
  return new RaviMailClient(auth.client).send(auth.accessToken, options);
}

export function sanitizeMetadataResponse<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => sanitizeMetadataResponse(item)) as T;
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (METADATA_BODY_KEYS.has(key)) continue;
    result[key] = sanitizeMetadataResponse(child);
  }
  return result as T;
}

function requireStoredCredentials(credentials: CloudCredentials | null, consoleUrl?: string): CloudCredentials {
  if (!credentials) {
    throw new CloudAuthError("AUTH_REQUIRED", "No Ravi Cloud CLI credentials found. Run `ravi login`.");
  }
  if (consoleUrl && normalizeConsoleUrl(consoleUrl) !== credentials.consoleUrl) {
    throw new CloudAuthError(
      "AUTH_REQUIRED",
      `No Ravi Cloud CLI credentials found for ${normalizeConsoleUrl(consoleUrl)}.`,
    );
  }
  return credentials;
}

function normalizeMailError(error: unknown): CloudAuthError {
  if (!(error instanceof CloudAuthError)) {
    return new CloudAuthError("SERVER_UNAVAILABLE", error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
  if (error.status === 403 || error.status === 404) {
    return new CloudAuthError(error.code, "Mail resource is not available to this Ravi Cloud identity.", {
      status: error.status,
      cause: error,
    });
  }
  return error;
}

function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

function paginationQuery(options: MailListOptions): Record<string, number | undefined> {
  return {
    limit: options.limit,
    offset: options.offset,
  };
}

const METADATA_BODY_KEYS = new Set([
  "body",
  "text",
  "html",
  "content",
  "plaintext",
  "plainText",
  "raw",
  "rawMime",
  "mime",
  "decrypted",
  "decryptedBody",
  "decryptedHtml",
  "decryptedText",
]);
