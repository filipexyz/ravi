import "reflect-metadata";
import { CliOnly, Arg, Command, Group, Option } from "../decorators.js";
import { CloudAuthError, cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../../cloud-auth/storage.js";
import {
  createMailDomain,
  createMailbox,
  disableMailbox,
  listMailDomains,
  listMailboxes,
  listMessages,
  readMessage,
  sendMail,
  showMailbox,
  showMessage,
  type MailClientDeps,
} from "../../mail/client.js";

export interface MailCommandDeps extends MailClientDeps {
  client?: ConsoleApiClient;
}

@Group({
  name: "mail.domains",
  description: "Inspect Ravi Mail domains through Console",
  scope: "open",
})
export class MailDomainsCommands {
  constructor(private readonly deps: MailCommandDeps = defaultMailDeps()) {}

  @Command({ name: "list", description: "List configured Ravi Mail domains" })
  @CliOnly()
  async list(
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records to request" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset to request" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const result = await listMailDomains(
        {
          console: consoleUrl,
          limit: parseOptionalInteger(limit, "--limit"),
          offset: parseOptionalInteger(offset, "--offset"),
        },
        this.deps,
      );
      printPayload(result, asJson, () => printItems("Domains", result, ["domain", "name", "status"]));
      return result;
    });
  }

  @Command({ name: "create", description: "Register a managed Ravi Mail domain in Console" })
  @CliOnly()
  async create(
    @Arg("domain", { description: "Managed domain to register, such as ravi.bot" }) domain: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const result = await createMailDomain(
        {
          domain,
          console: consoleUrl,
        },
        this.deps,
      );
      printPayload(result, asJson, () => printRecord("Domain", result));
      return result;
    });
  }
}

@Group({
  name: "mail.mailboxes",
  description: "Manage Ravi Mail mailboxes through Console",
  scope: "open",
})
export class MailMailboxesCommands {
  constructor(private readonly deps: MailCommandDeps = defaultMailDeps()) {}

  @Command({ name: "list", description: "List accessible Ravi Mail mailboxes" })
  @CliOnly()
  async list(
    @Option({ flags: "--domain <domain>", description: "Filter by domain id, slug, or name" }) domain?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records to request" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset to request" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const result = await listMailboxes(
        {
          domain,
          console: consoleUrl,
          limit: parseOptionalInteger(limit, "--limit"),
          offset: parseOptionalInteger(offset, "--offset"),
        },
        this.deps,
      );
      printPayload(result, asJson, () => printItems("Mailboxes", result, ["address", "id", "status", "isDefault"]));
      return result;
    });
  }

  @Command({ name: "create", description: "Create a Ravi Mail mailbox through Console" })
  @CliOnly()
  async create(
    @Arg("address-or-local-part", { description: "Full address or local part" }) addressOrLocalPart: string,
    @Option({ flags: "--domain <domain>", description: "Domain id, slug, or name" }) domain?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      requireOption(domain, "--domain");
      const result = await createMailbox(
        {
          addressOrLocalPart,
          domain: domain as string,
          console: consoleUrl,
        },
        this.deps,
      );
      printPayload(result, asJson, () => printRecord("Mailbox", result));
      return result;
    });
  }

  @Command({ name: "show", description: "Show Ravi Mail mailbox metadata" })
  @CliOnly()
  async show(
    @Arg("mailbox", { description: "Mailbox id or address" }) mailbox: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const result = await showMailbox(mailbox, { console: consoleUrl }, this.deps);
      printPayload(result, asJson, () => printRecord("Mailbox", result));
      return result;
    });
  }

  @Command({ name: "disable", description: "Disable a managed Ravi Mail mailbox and its active routes" })
  @CliOnly()
  async disable(
    @Arg("mailbox", { description: "Mailbox id or address" }) mailbox: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const result = await disableMailbox(
        {
          mailbox,
          console: consoleUrl,
        },
        this.deps,
      );
      printPayload(result, asJson, () => printMailboxDisable(result));
      return result;
    });
  }
}

@Group({
  name: "mail.messages",
  description: "Inspect Ravi Mail messages through Console",
  scope: "open",
})
export class MailMessagesCommands {
  constructor(private readonly deps: MailCommandDeps = defaultMailDeps()) {}

  @Command({ name: "list", description: "List message metadata without decrypting bodies" })
  @CliOnly()
  async list(
    @Option({ flags: "--mailbox <mailbox>", description: "Mailbox id or address" }) mailbox?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records to request" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset to request" }) offset?: string,
    @Option({ flags: "--addresses", description: "Decrypt and print address summary metadata" })
    includeAddresses?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      requireOption(mailbox, "--mailbox");
      const result = await listMessages(
        {
          mailbox: mailbox as string,
          console: consoleUrl,
          limit: parseOptionalInteger(limit, "--limit"),
          offset: parseOptionalInteger(offset, "--offset"),
          includeAddresses,
        },
        this.deps,
      );
      printPayload(result, asJson, () =>
        printItems("Messages", result, ["id", "from", "to", "fromHash", "subject", "receivedAt", "sentAt"]),
      );
      return result;
    });
  }

  @Command({ name: "show", description: "Show message metadata without decrypting body" })
  @CliOnly()
  async show(
    @Arg("message", { description: "Message id" }) message: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--addresses", description: "Decrypt and print address summary metadata" })
    includeAddresses?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const result = await showMessage(message, { console: consoleUrl, includeAddresses }, this.deps);
      printPayload(result, asJson, () => printRecord("Message", result));
      return result;
    });
  }

  @Command({ name: "read", description: "Read one authorized message body through Console decrypt" })
  @CliOnly()
  async read(
    @Arg("message", { description: "Message id" }) message: string,
    @Option({
      flags: "--payload <kind>",
      description: "Payload to read: parsed_body, raw_mime, subject, headers, or address_summary",
    })
    payloadKind?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result, including explicit read payload" })
    asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const result = await readMessage(
        message,
        {
          console: consoleUrl,
          payloadKind: parsePayloadKind(payloadKind),
        },
        this.deps,
      );
      printPayload(result, asJson, () => printReadMessage(result));
      return result;
    });
  }
}

@Group({
  name: "mail",
  description: "Use Ravi Mail through Console",
  scope: "open",
})
export class MailCommands {
  constructor(private readonly deps: MailCommandDeps = defaultMailDeps()) {}

  @Command({ name: "send", description: "Send mail from the default or explicit Ravi Mail mailbox" })
  @CliOnly()
  async send(
    @Option({ flags: "--to <email>", description: "Recipient email or comma-separated recipients" }) to?: string,
    @Option({ flags: "--subject <subject>", description: "Message subject" }) subject?: string,
    @Option({ flags: "--body <text>", description: "Message body" }) body?: string,
    @Option({ flags: "--from <mailbox>", description: "Explicit sender mailbox id or address" }) from?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Idempotency key for Console retries" })
    idempotencyKey?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      requireOption(to, "--to");
      requireOption(subject, "--subject");
      requireOption(body, "--body");
      const result = await sendMail(
        {
          from,
          to: parseRecipients(to as string),
          subject: subject as string,
          body: body as string,
          idempotencyKey,
          console: consoleUrl,
        },
        this.deps,
      );
      printPayload(result, asJson, () => printRecord("Sent", result));
      return result;
    });
  }
}

function defaultMailDeps(): MailCommandDeps {
  return {
    readCredentials: readCloudCredentials,
    writeCredentials: writeCloudCredentials,
    deleteCredentials: deleteCloudCredentials,
  };
}

async function runMailCommand<T>(asJson: boolean | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const cloudError = cloudAuthErrorFromUnknown(error);
    if (asJson) {
      printJson(formatCloudAuthError(cloudError));
    } else {
      console.error(`${cloudError.code}: ${cloudError.message}`);
      if (cloudError.code === "AUTH_REQUIRED" || cloudError.code === "AUTH_EXPIRED") {
        console.error("Next: run `ravi login`.");
      }
    }
    process.exit(cloudError.exitCode);
  }
}

function printPayload(payload: unknown, asJson: boolean | undefined, printHuman: () => void): void {
  if (asJson) {
    printJson(payload);
    return;
  }
  printHuman();
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printItems(title: string, payload: Record<string, unknown>, preferredFields: string[]): void {
  const items = extractItems(payload);
  if (!items.length) {
    console.log(`No ${title.toLowerCase()} found.`);
    return;
  }
  console.log(`${title}: ${items.length}`);
  for (const item of items) {
    console.log(`- ${formatSummary(item, preferredFields)}`);
  }
  printNext(payload);
}

function printRecord(title: string, payload: Record<string, unknown>): void {
  const record = extractRecord(payload);
  console.log(`${title}: ${formatSummary(record, ["address", "id", "status", "subject"])}`);
}

function printMailboxDisable(payload: Record<string, unknown>): void {
  const record = extractRecord(payload);
  console.log(`Mailbox: ${formatSummary(record, ["address", "id", "status"])}`);
  const disabledRoutes = payload.disabledRoutes;
  if (typeof disabledRoutes === "number") {
    console.log(`Disabled routes: ${disabledRoutes}`);
  } else if (Array.isArray(disabledRoutes)) {
    console.log(`Disabled routes: ${disabledRoutes.length}`);
  }
  const providerSynced = payload.providerSynced;
  if (typeof providerSynced === "boolean") console.log(`Provider synced: ${providerSynced ? "yes" : "no"}`);
}

function printReadMessage(payload: Record<string, unknown>): void {
  const record = extractRecord(payload);
  const subject = stringValue(record.subject) ?? stringValue(payload.subject);
  const from = stringValue(record.from) ?? stringValue(payload.from);
  if (from) console.log(`From: ${from}`);
  if (subject) console.log(`Subject: ${subject}`);
  if (from || subject) console.log("");
  console.log(extractReadableBody(payload) ?? "");
}

function extractItems(payload: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ["items", "domains", "mailboxes", "messages"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function extractRecord(payload: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["domain", "mailbox", "message", "send", "sent", "result"]) {
    const value = payload[key];
    if (isRecord(value)) return value;
  }
  return payload;
}

function printNext(payload: Record<string, unknown>): void {
  const pagination = isRecord(payload.pagination) ? payload.pagination : null;
  const nextCommand = stringValue(pagination?.nextCommand);
  if (nextCommand) {
    console.log("");
    console.log("Next page:");
    console.log(`  ${nextCommand}`);
  }
}

function formatSummary(record: Record<string, unknown>, preferredFields: string[]): string {
  const parts: string[] = [];
  for (const field of preferredFields) {
    const value = record[field] ?? addressSummaryValue(record, field);
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${field}=${formatValue(value)}`);
  }
  if (parts.length) return parts.join(" ");

  const fallback = Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, 4)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  return fallback.join(" ") || JSON.stringify(record);
}

function extractReadableBody(payload: Record<string, unknown>): string | null {
  const record = extractRecord(payload);
  for (const source of [record, payload]) {
    for (const key of ["body", "text", "plainText", "plaintext", "content"]) {
      const value = stringValue(source[key]);
      if (value) return value;
    }
  }
  return null;
}

function addressSummaryValue(record: Record<string, unknown>, field: string): string | null {
  if (field !== "from" && field !== "to" && field !== "cc" && field !== "bcc" && field !== "replyTo") return null;
  const addressSummary = isRecord(record.addressSummary) ? record.addressSummary : null;
  const entries = Array.isArray(addressSummary?.[field]) ? addressSummary[field].filter(isRecord) : [];
  if (!entries.length) return null;
  return entries.map(formatAddressEntry).join(",");
}

function formatAddressEntry(entry: Record<string, unknown>): string {
  const address = stringValue(entry.address);
  const name = stringValue(entry.name);
  if (!address) return JSON.stringify(entry);
  return name ? `${name} <${address}>` : address;
}

function parseRecipients(value: string): string[] {
  const recipients = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!recipients.length) {
    throw new CloudAuthError("PAYLOAD_INVALID", "--to must include at least one recipient.");
  }
  return recipients;
}

function parsePayloadKind(
  value: string | undefined,
): "subject" | "raw_mime" | "parsed_body" | "headers" | "address_summary" | undefined {
  if (!value?.trim()) return undefined;
  if (
    value === "subject" ||
    value === "raw_mime" ||
    value === "parsed_body" ||
    value === "headers" ||
    value === "address_summary"
  ) {
    return value;
  }
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --payload value.");
}

function requireOption(value: string | undefined, label: string): void {
  if (!value?.trim()) {
    throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
  }
}

function parseOptionalInteger(value: string | undefined, label: string): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CloudAuthError("PAYLOAD_INVALID", `${label} must be a non-negative integer.`);
  }
  return parsed;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
