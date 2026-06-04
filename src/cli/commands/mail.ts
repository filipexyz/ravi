import "reflect-metadata";
import { CliOnly, Arg, Command, Group, Option } from "../decorators.js";
import { CloudAuthError, cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../../cloud-auth/storage.js";
import {
  createMailDomain as createRemoteMailDomain,
  createMailbox as createRemoteMailbox,
  disableMailbox as disableRemoteMailbox,
  listMailDomains as listRemoteMailDomains,
  listMailboxes as listRemoteMailboxes,
  listMessages as listRemoteMessages,
  readMessage as readRemoteMessage,
  sendMail as sendRemoteMail,
  showMailbox as showRemoteMailbox,
  showMessage as showRemoteMessage,
  type MailClientDeps,
} from "../../mail/client.js";
import {
  createMailAccount,
  createMailMailbox,
  enqueueMailReply,
  enqueueMailSend,
  canUseAnyMailbox,
  canUseMailMailbox,
  canUseMailProvider,
  getMailScopeContext,
  getMailAccount,
  getMailMailbox,
  getMailOutbox,
  getMailThread,
  importMailMessage,
  listMailAccounts,
  listMailMailboxes,
  listMailMessages,
  listMailOutbox,
  readMailMessage,
  retryMailOutbox,
  setMailMailboxStatus,
  type MailAccount,
  type MailAddressInput,
  type MailMailbox,
  type MailMessage,
  type MailMessageWithAddresses,
  type MailOutboxRow,
  type MailThread,
  type MailAccountStatus,
  type MailMailboxStatus,
  type MailMessageStatus,
  type MailOutboxStatus,
} from "../../mailbox/index.js";
import { projectMailMessageToInbox } from "../../inbox/index.js";

export interface MailCommandDeps extends MailClientDeps {
  client?: ConsoleApiClient;
}

@Group({
  name: "mail.accounts",
  description: "Manage local-first mail provider accounts",
  scope: "open",
})
export class MailAccountsCommands {
  constructor(private readonly deps: MailCommandDeps = defaultMailDeps()) {}

  @Command({ name: "list", description: "List local mail accounts" })
  @CliOnly()
  async list(
    @Option({ flags: "--provider <provider>", description: "Filter by provider" }) provider?: string,
    @Option({ flags: "--status <status>", description: "Filter by account status" }) status?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const accounts = listMailAccounts({
        provider,
        status: parseAccountStatus(status),
        limit: parseOptionalInteger(limit, "--limit"),
        offset: parseOptionalInteger(offset, "--offset"),
      });
      const payload = { accounts };
      printPayload(payload, asJson, () => printItems("Accounts", payload, ["id", "provider", "status", "displayName"]));
      return payload;
    });
  }

  @Command({ name: "create", description: "Create or update a local mail provider account" })
  @CliOnly()
  async create(
    @Option({ flags: "--provider <provider>", description: "Provider id, e.g. ravi-mail or gmail" }) provider?: string,
    @Option({ flags: "--id <id>", description: "Stable local account id" }) id?: string,
    @Option({ flags: "--name <name>", description: "Display name" }) displayName?: string,
    @Option({ flags: "--credentials-ref <ref>", description: "Reference to existing credential store entry" })
    credentialsRef?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      requireOption(provider, "--provider");
      const account = createMailAccount({
        id,
        provider: provider as string,
        displayName,
        credentialsRef,
      });
      const payload = { account };
      printPayload(payload, asJson, () => printRecord("Account", payload));
      return payload;
    });
  }

  @Command({ name: "sync", description: "Run one local provider sync tick for an account" })
  @CliOnly()
  async sync(
    @Arg("account", { description: "Local mail account id" }) accountId: string,
    @Option({ flags: "--once", description: "Run one foreground tick" }) _once?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const account = getMailAccount(accountId);
      if (!account) throw new CloudAuthError("PAYLOAD_INVALID", `Mail account not found: ${accountId}`);
      requireProviderPermission("sync", account.provider);
      const payload =
        account.provider === "ravi-mail"
          ? await syncRaviMailAccount(account, this.deps)
          : {
              ok: false,
              account,
              status: "adapter_not_started",
              message: `Provider sync adapter is not implemented yet: ${account.provider}`,
            };
      printPayload(payload, asJson, () => printRecord("Sync", payload));
      return payload;
    });
  }
}

@Group({
  name: "mail.mailboxes",
  description: "Manage local mailboxes",
  scope: "open",
})
export class MailMailboxesCommands {
  @Command({ name: "list", description: "List local mailboxes" })
  @CliOnly()
  async list(
    @Option({ flags: "--account <account>", description: "Local account id" }) accountId?: string,
    @Option({ flags: "--status <status>", description: "Filter by mailbox status" }) status?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const mailboxes = listMailMailboxes({
        accountId,
        status: parseMailboxStatus(status),
        limit: parseOptionalInteger(limit, "--limit"),
        offset: parseOptionalInteger(offset, "--offset"),
      }).filter((mailbox) => canUseMailMailbox(getMailScopeContext(), "read", mailbox));
      const payload = { mailboxes };
      printPayload(payload, asJson, () => printItems("Mailboxes", payload, ["address", "id", "status", "isDefault"]));
      return payload;
    });
  }

  @Command({ name: "create", description: "Create or update a local mailbox projection" })
  @CliOnly()
  async create(
    @Arg("address", { description: "Mailbox email address" }) address: string,
    @Option({ flags: "--account <account>", description: "Local account id" }) accountId?: string,
    @Option({ flags: "--name <name>", description: "Mailbox display name" }) displayName?: string,
    @Option({ flags: "--role <role>", description: "primary, alias, shared, system, or unknown" }) role?: string,
    @Option({ flags: "--provider-mailbox-id <id>", description: "Provider mailbox id as provenance" })
    providerMailboxId?: string,
    @Option({ flags: "--default", description: "Mark as default mailbox for the account" }) isDefault?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      requireOption(accountId, "--account");
      requireMailboxRefPermission("manage", address);
      const mailbox = createMailMailbox({
        accountId: accountId as string,
        address,
        displayName,
        role: parseMailboxRole(role),
        providerMailboxId,
        isDefault,
      });
      const payload = { mailbox };
      printPayload(payload, asJson, () => printRecord("Mailbox", payload));
      return payload;
    });
  }

  @Command({ name: "show", description: "Show a local mailbox" })
  @CliOnly()
  async show(
    @Arg("mailbox", { description: "Local mailbox id or address" }) mailboxRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const mailbox = getMailMailbox(mailboxRef);
      if (!mailbox) throw new CloudAuthError("PAYLOAD_INVALID", `Mail mailbox not found: ${mailboxRef}`);
      requireMailboxPermission("read", mailbox);
      const payload = { mailbox };
      printPayload(payload, asJson, () => printRecord("Mailbox", payload));
      return payload;
    });
  }

  @Command({ name: "disable", description: "Disable a local mailbox projection" })
  @CliOnly()
  async disable(
    @Arg("mailbox", { description: "Local mailbox id or address" }) mailboxRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const existing = getMailMailbox(mailboxRef);
      if (!existing) throw new CloudAuthError("PAYLOAD_INVALID", `Mail mailbox not found: ${mailboxRef}`);
      requireMailboxPermission("manage", existing);
      const mailbox = setMailMailboxStatus(mailboxRef, "disabled");
      const payload = { mailbox };
      printPayload(payload, asJson, () => printRecord("Mailbox", payload));
      return payload;
    });
  }
}

@Group({
  name: "mail.messages",
  description: "Read and import local mailbox messages",
  scope: "open",
})
export class MailMessagesCommands {
  @Command({ name: "list", description: "List local mail messages" })
  @CliOnly()
  async list(
    @Option({ flags: "--mailbox <mailbox>", description: "Local mailbox id or address" }) mailbox?: string,
    @Option({ flags: "--query <query>", description: "Search subject/snippet/body" }) query?: string,
    @Option({ flags: "--status <status>", description: "Filter by local message status" }) status?: string,
    @Option({ flags: "--addresses", description: "Include local address rows" }) includeAddresses?: boolean,
    @Option({ flags: "--limit <n>", description: "Maximum records" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      if (mailbox) {
        const mailboxRecord = getMailMailbox(mailbox);
        if (!mailboxRecord) throw new CloudAuthError("PAYLOAD_INVALID", `Mail mailbox not found: ${mailbox}`);
        requireMailboxPermission("search", mailboxRecord);
      } else if (getMailScopeContext().agentId && !canUseAnyMailbox(getMailScopeContext(), "search")) {
        requireAnyMailboxPermission("search");
      }
      const messages = listMailMessages({
        mailbox,
        query,
        status: parseMessageStatus(status),
        includeAddresses,
        limit: parseOptionalInteger(limit, "--limit"),
        offset: parseOptionalInteger(offset, "--offset"),
      }).filter((message) => canUseRowMailbox("search", message.mailboxId));
      const payload = { messages: safeMailMessages(messages) };
      printPayload(payload, asJson, () => printItems("Messages", payload, ["id", "subject", "status", "receivedAt"]));
      return payload;
    });
  }

  @Command({ name: "search", description: "Search local mail messages" })
  @CliOnly()
  async search(
    @Arg("query", { description: "Search query" }) query: string,
    @Option({ flags: "--mailbox <mailbox>", description: "Local mailbox id or address" }) mailbox?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return this.list(mailbox, query, undefined, undefined, limit, undefined, asJson);
  }

  @Command({ name: "read", description: "Read a local mail message" })
  @CliOnly()
  async read(
    @Arg("message", { description: "Local message id" }) messageId: string,
    @Option({ flags: "--addresses", description: "Include local address rows" }) includeAddresses?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const message = readMailMessage(messageId, { includeAddresses });
      const mailbox = getMailMailbox(message.mailboxId);
      if (!mailbox) throw new CloudAuthError("PAYLOAD_INVALID", `Mail mailbox not found: ${message.mailboxId}`);
      requireMailboxPermission("read", mailbox);
      const payload = { message };
      printPayload(payload, asJson, () => printReadMessage(payload));
      return payload;
    });
  }

  @Command({ name: "import", description: "Import one normalized provider message into the local mailbox" })
  @CliOnly()
  async importMessage(
    @Option({ flags: "--mailbox <mailbox>", description: "Local mailbox id or address" }) mailbox?: string,
    @Option({ flags: "--from <email>", description: "Sender email" }) from?: string,
    @Option({ flags: "--to <email>", description: "Recipient email or comma-separated recipients" }) to?: string,
    @Option({ flags: "--subject <subject>", description: "Message subject" }) subject?: string,
    @Option({ flags: "--body <text>", description: "Plaintext body" }) body?: string,
    @Option({ flags: "--provider <provider>", description: "Provider id as provenance" }) provider?: string,
    @Option({ flags: "--provider-message-id <id>", description: "Provider message id" }) providerMessageId?: string,
    @Option({ flags: "--provider-thread-id <id>", description: "Provider thread id" }) providerThreadId?: string,
    @Option({ flags: "--rfc-message-id <id>", description: "RFC Message-ID" }) rfcMessageId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      requireOption(mailbox, "--mailbox");
      requireOption(from, "--from");
      const mailboxRecord = getMailMailbox(mailbox as string);
      if (!mailboxRecord) throw new CloudAuthError("PAYLOAD_INVALID", `Mail mailbox not found: ${mailbox}`);
      requireMailboxPermission("manage", mailboxRecord);
      const recipients = parseRecipients(to ?? mailboxRecord.address);
      const message = importMailMessage({
        mailbox: mailbox as string,
        provider: provider as string | undefined,
        providerMessageId,
        providerThreadId,
        rfcMessageId,
        subject,
        bodyText: body,
        snippet: body,
        addresses: [
          { kind: "from", address: from as string },
          ...recipients.map((address) => ({ kind: "to" as const, address })),
        ],
      });
      const inbox = projectMailMessageToInbox(message);
      const payload = {
        message: safeMailMessage(message),
        inboxItem: inbox?.item ?? null,
        inboxCreated: inbox?.created ?? false,
      };
      printPayload(payload, asJson, () => printRecord("Message", payload));
      return payload;
    });
  }
}

@Group({
  name: "mail.outbox",
  description: "Inspect and retry the local mail outbox",
  scope: "open",
})
export class MailOutboxCommands {
  @Command({ name: "status", description: "Show local mail outbox status" })
  @CliOnly()
  async status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    return runMailCommand(asJson, async () => {
      const rows = listMailOutbox({ limit: 500 }).filter((row) => canUseRowMailbox("send", row.mailboxId));
      const counts = rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {});
      const payload = { counts, total: rows.length };
      printPayload(payload, asJson, () => printRecord("Outbox", payload));
      return payload;
    });
  }

  @Command({ name: "list", description: "List local outbox rows" })
  @CliOnly()
  async list(
    @Option({ flags: "--status <status>", description: "Filter by outbox status" }) status?: string,
    @Option({ flags: "--mailbox <mailbox>", description: "Local mailbox id or address" }) mailbox?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      if (mailbox) {
        const mailboxRecord = getMailMailbox(mailbox);
        if (!mailboxRecord) throw new CloudAuthError("PAYLOAD_INVALID", `Mail mailbox not found: ${mailbox}`);
        requireMailboxPermission("send", mailboxRecord);
      } else if (getMailScopeContext().agentId && !canUseAnyMailbox(getMailScopeContext(), "send")) {
        requireAnyMailboxPermission("send");
      }
      const outbox = listMailOutbox({
        status: parseOutboxStatus(status),
        mailbox,
        limit: parseOptionalInteger(limit, "--limit"),
      }).filter((row) => canUseRowMailbox("send", row.mailboxId));
      const payload = { outbox: safeOutboxRows(outbox) };
      printPayload(payload, asJson, () => printItems("Outbox", payload, ["id", "status", "operation", "messageId"]));
      return payload;
    });
  }

  @Command({ name: "inspect", description: "Inspect a local outbox row" })
  @CliOnly()
  async inspect(
    @Arg("outbox", { description: "Local outbox id" }) outboxId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const outbox = getMailOutbox(outboxId);
      if (!outbox) throw new CloudAuthError("PAYLOAD_INVALID", `Mail outbox row not found: ${outboxId}`);
      const mailbox = getMailMailbox(outbox.mailboxId);
      if (!mailbox) throw new CloudAuthError("PAYLOAD_INVALID", `Mail mailbox not found: ${outbox.mailboxId}`);
      requireMailboxPermission("send", mailbox);
      const payload = { outbox: redactOutboxPayload(outbox) };
      printPayload(payload, asJson, () => printRecord("Outbox", payload));
      return payload;
    });
  }

  @Command({ name: "retry", description: "Move a failed/dead local outbox row back to pending" })
  @CliOnly()
  async retry(
    @Arg("outbox", { description: "Local outbox id" }) outboxId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const existing = getMailOutbox(outboxId);
      if (!existing) throw new CloudAuthError("PAYLOAD_INVALID", `Mail outbox row not found: ${outboxId}`);
      const mailbox = getMailMailbox(existing.mailboxId);
      if (!mailbox) throw new CloudAuthError("PAYLOAD_INVALID", `Mail mailbox not found: ${existing.mailboxId}`);
      requireMailboxPermission("send", mailbox);
      const outbox = retryMailOutbox(outboxId);
      const payload = { outbox: redactOutboxPayload(outbox) };
      printPayload(payload, asJson, () => printRecord("Outbox", payload));
      return payload;
    });
  }
}

@Group({
  name: "mail.providers",
  description: "Inspect mail provider adapters",
  scope: "open",
})
export class MailProvidersCommands {
  @Command({ name: "list", description: "List known mail providers and local account counts" })
  @CliOnly()
  async list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    return runMailCommand(asJson, async () => {
      const accounts = listMailAccounts({ limit: 500 });
      const providers = ["ravi-mail", "gmail", "imap-smtp"].map((provider) => ({
        provider,
        accounts: accounts.filter((account) => account.provider === provider).length,
        default: provider === "ravi-mail",
        localFirst: true,
      }));
      const payload = { providers };
      printPayload(payload, asJson, () => printItems("Providers", payload, ["provider", "accounts", "default"]));
      return payload;
    });
  }
}

@Group({
  name: "mail",
  description: "Use local-first Ravi mail",
  scope: "open",
})
export class MailCommands {
  @Command({ name: "send", description: "Queue mail in the local outbox" })
  @CliOnly()
  async send(
    @Option({ flags: "--to <email>", description: "Recipient email or comma-separated recipients" }) to?: string,
    @Option({ flags: "--subject <subject>", description: "Message subject" }) subject?: string,
    @Option({ flags: "--body <text>", description: "Message body" }) body?: string,
    @Option({ flags: "--from <mailbox>", description: "Local sender mailbox id or address" }) from?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Local outbox idempotency key" })
    idempotencyKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      requireOption(to, "--to");
      requireOption(subject, "--subject");
      requireOption(body, "--body");
      const mailbox = resolveLocalSendMailbox(from);
      requireMailboxPermission("send", mailbox);
      const result = enqueueMailSend({
        from: mailbox.id,
        to: parseRecipients(to as string),
        subject: subject as string,
        body: body as string,
        idempotencyKey,
      });
      const payload = {
        queued: true,
        message: safeMailMessage(result.message),
        outbox: redactOutboxPayload(result.outbox),
      };
      printPayload(payload, asJson, () => printRecord("Queued", payload));
      return payload;
    });
  }

  @Command({ name: "reply", description: "Queue a local reply in the outbox" })
  @CliOnly()
  async reply(
    @Arg("message", { description: "Local message id to reply to" }) messageId: string,
    @Option({ flags: "--body <text>", description: "Reply body" }) body?: string,
    @Option({ flags: "--from <mailbox>", description: "Local sender mailbox id or address" }) from?: string,
    @Option({ flags: "--to <email>", description: "Override recipient or comma-separated recipients" }) to?: string,
    @Option({ flags: "--cc <email>", description: "CC recipient or comma-separated recipients" }) cc?: string,
    @Option({ flags: "--bcc <email>", description: "BCC recipient or comma-separated recipients" }) bcc?: string,
    @Option({ flags: "--subject <subject>", description: "Override reply subject" }) subject?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Local outbox idempotency key" })
    idempotencyKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      requireOption(body, "--body");
      const original = readMailMessage(messageId, { includeAddresses: true });
      const originalMailbox = getMailMailbox(original.mailboxId);
      if (!originalMailbox)
        throw new CloudAuthError("PAYLOAD_INVALID", `Mail mailbox not found: ${original.mailboxId}`);
      requireMailboxPermission("read", originalMailbox);
      const sendMailbox = resolveLocalSendMailbox(from ?? original.mailboxId);
      requireMailboxPermission("send", sendMailbox);
      const result = enqueueMailReply({
        messageId,
        from: sendMailbox.id,
        to: to ? parseRecipients(to) : undefined,
        cc: parseOptionalRecipients(cc),
        bcc: parseOptionalRecipients(bcc),
        subject,
        body: body as string,
        idempotencyKey,
      });
      const payload = {
        queued: true,
        message: safeMailMessage(result.message),
        outbox: redactOutboxPayload(result.outbox),
      };
      printPayload(payload, asJson, () => printRecord("Queued", payload));
      return payload;
    });
  }
}

@Group({
  name: "mail.threads",
  description: "Read local mail threads",
  scope: "open",
})
export class MailThreadsCommands {
  @Command({ name: "read", description: "Read a local mail thread and its safe message timeline" })
  @CliOnly()
  async read(
    @Arg("thread", { description: "Local thread id" }) threadId: string,
    @Option({ flags: "--addresses", description: "Include local address rows" }) includeAddresses?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const thread = getMailThread(threadId);
      if (!thread) throw new CloudAuthError("PAYLOAD_INVALID", `Mail thread not found: ${threadId}`);
      const messages = listMailMessages({
        threadId,
        includeAddresses,
        limit: 500,
      }).filter((message) => canUseRowMailbox("read", message.mailboxId));
      if (!messages.length && getMailScopeContext().agentId) {
        throw new CloudAuthError(
          "ORG_ACCESS_DENIED",
          `Permission denied: agent:${getMailScopeContext().agentId} requires read on a mailbox in thread:${threadId}`,
        );
      }
      const payload = { thread: safeMailThread(thread), messages: safeMailMessages(messages) };
      printPayload(payload, asJson, () => {
        printRecord("Thread", payload);
        printItems("Messages", payload, ["id", "subject", "status", "receivedAt", "sentAt"]);
      });
      return payload;
    });
  }
}

@Group({
  name: "mail.domains",
  description: "Compatibility alias for Ravi Mail provider domains through Console",
  scope: "open",
})
export class MailDomainsCommands {
  constructor(private readonly deps: MailCommandDeps = defaultMailDeps()) {}

  @Command({ name: "list", description: "List managed Ravi Mail domains through Console" })
  @CliOnly()
  async list(
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records to request" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset to request" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const result = await listRemoteMailDomains(
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
      const result = await createRemoteMailDomain({ domain, console: consoleUrl }, this.deps);
      printPayload(result, asJson, () => printRecord("Domain", result));
      return result;
    });
  }
}

@Group({
  name: "mail.providers.ravi-mail.mailboxes",
  description: "Manage Ravi Mail provider mailboxes through Console",
  scope: "open",
})
export class MailRaviMailMailboxesCommands {
  constructor(private readonly deps: MailCommandDeps = defaultMailDeps()) {}

  @Command({ name: "list", description: "List Ravi Mail provider mailboxes through Console" })
  @CliOnly()
  async list(
    @Option({ flags: "--domain <domain>", description: "Filter by domain id, slug, or name" }) domain?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records to request" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset to request" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const result = await listRemoteMailboxes(
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

  @Command({ name: "create", description: "Create a Ravi Mail provider mailbox through Console" })
  @CliOnly()
  async create(
    @Arg("address-or-local-part", { description: "Full address or local part" }) addressOrLocalPart: string,
    @Option({ flags: "--domain <domain>", description: "Domain id, slug, or name" }) domain?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      requireOption(domain, "--domain");
      const result = await createRemoteMailbox(
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

  @Command({ name: "show", description: "Show Ravi Mail provider mailbox metadata" })
  @CliOnly()
  async show(
    @Arg("mailbox", { description: "Provider mailbox id or address" }) mailbox: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const result = await showRemoteMailbox(mailbox, { console: consoleUrl }, this.deps);
      printPayload(result, asJson, () => printRecord("Mailbox", result));
      return result;
    });
  }

  @Command({ name: "disable", description: "Disable a managed Ravi Mail provider mailbox and active routes" })
  @CliOnly()
  async disable(
    @Arg("mailbox", { description: "Provider mailbox id or address" }) mailbox: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const result = await disableRemoteMailbox({ mailbox, console: consoleUrl }, this.deps);
      printPayload(result, asJson, () => printMailboxDisable(result));
      return result;
    });
  }
}

@Group({
  name: "mail.providers.ravi-mail.messages",
  description: "Inspect Ravi Mail provider messages through Console",
  scope: "open",
})
export class MailRaviMailMessagesCommands {
  constructor(private readonly deps: MailCommandDeps = defaultMailDeps()) {}

  @Command({ name: "list", description: "List Ravi Mail provider message metadata" })
  @CliOnly()
  async list(
    @Option({ flags: "--mailbox <mailbox>", description: "Provider mailbox id or address" }) mailbox?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records to request" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset to request" }) offset?: string,
    @Option({ flags: "--addresses", description: "Decrypt and print address summary metadata" })
    includeAddresses?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      requireOption(mailbox, "--mailbox");
      const result = await listRemoteMessages(
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

  @Command({ name: "show", description: "Show Ravi Mail provider message metadata" })
  @CliOnly()
  async show(
    @Arg("message", { description: "Provider message id" }) message: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--addresses", description: "Decrypt and print address summary metadata" })
    includeAddresses?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      const result = await showRemoteMessage(message, { console: consoleUrl, includeAddresses }, this.deps);
      printPayload(result, asJson, () => printRecord("Message", result));
      return result;
    });
  }

  @Command({ name: "read", description: "Read one authorized Ravi Mail provider message body through Console" })
  @CliOnly()
  async read(
    @Arg("message", { description: "Provider message id" }) message: string,
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
      const result = await readRemoteMessage(
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
  name: "mail.providers.ravi-mail",
  description: "Use Ravi Mail provider directly through Console",
  scope: "open",
})
export class MailRaviMailCommands {
  constructor(private readonly deps: MailCommandDeps = defaultMailDeps()) {}

  @Command({ name: "send", description: "Send mail directly through Console Ravi Mail" })
  @CliOnly()
  async send(
    @Option({ flags: "--to <email>", description: "Recipient email or comma-separated recipients" }) to?: string,
    @Option({ flags: "--subject <subject>", description: "Message subject" }) subject?: string,
    @Option({ flags: "--body <text>", description: "Message body" }) body?: string,
    @Option({ flags: "--from <mailbox>", description: "Explicit provider sender mailbox id or address" }) from?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Idempotency key for Console retries" })
    idempotencyKey?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMailCommand(asJson, async () => {
      requireOption(to, "--to");
      requireOption(subject, "--subject");
      requireOption(body, "--body");
      const result = await sendRemoteMail(
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
    const cloudError =
      error instanceof CloudAuthError
        ? error
        : new CloudAuthError("PAYLOAD_INVALID", error instanceof Error ? error.message : String(error), {
            cause: error,
          });
    const formatted = cloudAuthErrorFromUnknown(cloudError);
    if (asJson) {
      printJson(formatCloudAuthError(formatted));
    } else {
      console.error(`${formatted.code}: ${formatted.message}`);
      if (formatted.code === "AUTH_REQUIRED" || formatted.code === "AUTH_EXPIRED") {
        console.error("Next: run `ravi login`.");
      }
    }
    process.exit(formatted.exitCode);
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
  console.log(`${title}: ${formatSummary(record, ["address", "id", "status", "subject", "provider", "total"])}`);
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
  const from = stringValue(record.from) ?? stringValue(payload.from) ?? localAddressSummary(record, "from");
  if (from) console.log(`From: ${from}`);
  if (subject) console.log(`Subject: ${subject}`);
  if (from || subject) console.log("");
  console.log(extractReadableBody(payload) ?? "");
}

function extractItems(payload: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ["items", "accounts", "domains", "mailboxes", "messages", "outbox", "providers"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function extractRecord(payload: Record<string, unknown>): Record<string, unknown> {
  for (const key of [
    "account",
    "domain",
    "mailbox",
    "message",
    "thread",
    "outbox",
    "send",
    "sent",
    "queued",
    "result",
  ]) {
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
    for (const key of ["body", "bodyText", "text", "plainText", "plaintext", "content"]) {
      const value = stringValue(source[key]);
      if (value) return value;
    }
  }
  return null;
}

function localAddressSummary(record: Record<string, unknown>, field: string): string | null {
  const addresses = Array.isArray(record.addresses) ? record.addresses.filter(isRecord) : [];
  const entries = addresses.filter((entry) => entry.kind === field);
  if (!entries.length) return null;
  return entries.map(formatAddressEntry).join(",");
}

function addressSummaryValue(record: Record<string, unknown>, field: string): string | null {
  if (field !== "from" && field !== "to" && field !== "cc" && field !== "bcc" && field !== "replyTo") return null;
  const local = localAddressSummary(record, field);
  if (local) return local;
  const addressSummary = isRecord(record.addressSummary) ? record.addressSummary : null;
  const entries = Array.isArray(addressSummary?.[field]) ? addressSummary[field].filter(isRecord) : [];
  if (!entries.length) return null;
  return entries.map(formatAddressEntry).join(",");
}

function formatAddressEntry(entry: Record<string, unknown>): string {
  const address = stringValue(entry.address);
  const name = stringValue(entry.name) ?? stringValue(entry.displayName);
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

function parseOptionalRecipients(value: string | undefined): string[] | undefined {
  return value?.trim() ? parseRecipients(value) : undefined;
}

function extractNamedItems(payload: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function remoteMessageAddresses(record: Record<string, unknown>): MailAddressInput[] {
  const addresses: MailAddressInput[] = [];
  const summary = isRecord(record.addressSummary) ? record.addressSummary : null;
  for (const kind of ["from", "to", "cc", "bcc", "reply_to"] as const) {
    const field = kind === "reply_to" ? "replyTo" : kind;
    const entries = Array.isArray(summary?.[field]) ? summary[field].filter(isRecord) : [];
    for (const entry of entries) {
      const address = stringValue(entry.address);
      if (address) {
        addresses.push({ kind, address, displayName: stringValue(entry.name) ?? stringValue(entry.displayName) });
      }
    }
  }
  addAddressString(addresses, "from", record.from);
  addAddressString(addresses, "to", record.to);
  return addresses;
}

function addAddressString(addresses: MailAddressInput[], kind: MailAddressInput["kind"], value: unknown): void {
  if (typeof value !== "string") return;
  for (const address of parseLooseAddressList(value)) {
    if (!addresses.some((entry) => entry.kind === kind && entry.address === address)) {
      addresses.push({ kind, address });
    }
  }
}

function parseLooseAddressList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function timestampValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function parseAccountStatus(value: string | undefined): MailAccountStatus | undefined {
  if (!value?.trim()) return undefined;
  if (value === "active" || value === "paused" || value === "auth_required" || value === "disabled") return value;
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --status value.");
}

function parseMailboxStatus(value: string | undefined): MailMailboxStatus | undefined {
  if (!value?.trim()) return undefined;
  if (value === "active" || value === "paused" || value === "disabled") return value;
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --status value.");
}

function parseMessageStatus(value: string | undefined): MailMessageStatus | undefined {
  if (!value?.trim()) return undefined;
  if (
    value === "received" ||
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
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --status value.");
}

function parseOutboxStatus(value: string | undefined): MailOutboxStatus | undefined {
  if (!value?.trim()) return undefined;
  if (
    value === "pending" ||
    value === "leased" ||
    value === "sending" ||
    value === "sent" ||
    value === "acked" ||
    value === "failed" ||
    value === "dead"
  ) {
    return value;
  }
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --status value.");
}

function parseMailboxRole(value: string | undefined): "primary" | "alias" | "shared" | "system" | "unknown" {
  if (!value?.trim()) return "primary";
  if (value === "primary" || value === "alias" || value === "shared" || value === "system" || value === "unknown") {
    return value;
  }
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --role value.");
}

async function syncRaviMailAccount(account: MailAccount, deps: MailCommandDeps): Promise<Record<string, unknown>> {
  const remoteMailboxes = await listRemoteMailboxes({}, deps);
  const mailboxRecords = extractNamedItems(remoteMailboxes, ["mailboxes", "items"]);
  let mailboxesImported = 0;
  let messagesImported = 0;
  let inboxCreated = 0;

  for (const record of mailboxRecords) {
    const address = stringValue(record.address) ?? stringValue(record.email);
    if (!address) continue;
    const mailbox = createMailMailbox({
      accountId: account.id,
      address,
      displayName: stringValue(record.displayName) ?? stringValue(record.name),
      providerMailboxId: stringValue(record.id),
      isDefault: Boolean(record.isDefault) || Boolean(record.default),
      status: stringValue(record.status) === "disabled" ? "disabled" : "active",
      metadata: {
        provider: "ravi-mail",
        providerStatus: stringValue(record.status) ?? null,
      },
    });
    mailboxesImported += 1;

    const remoteMessages = await listRemoteMessages(
      {
        mailbox: mailbox.providerMailboxId ?? mailbox.address,
        limit: 50,
        includeAddresses: true,
      },
      deps,
    );
    for (const messageRecord of extractNamedItems(remoteMessages, ["messages", "items"])) {
      const providerMessageId = stringValue(messageRecord.id) ?? stringValue(messageRecord.messageId);
      if (!providerMessageId) continue;
      const message = importMailMessage({
        mailbox: mailbox.id,
        provider: "ravi-mail",
        providerMessageId,
        providerThreadId: stringValue(messageRecord.threadId),
        rfcMessageId: stringValue(messageRecord.rfcMessageId),
        subject: stringValue(messageRecord.subject),
        snippet: stringValue(messageRecord.snippet) ?? stringValue(messageRecord.preview),
        bodyRedactionStatus: "preview_only",
        receivedAt: timestampValue(messageRecord.receivedAt) ?? timestampValue(messageRecord.createdAt),
        sentAt: timestampValue(messageRecord.sentAt),
        addresses: remoteMessageAddresses(messageRecord),
        safePayload: {
          syncedFromProvider: "ravi-mail",
        },
        providerProvenance: {
          providerMailboxId: mailbox.providerMailboxId,
        },
      });
      messagesImported += 1;
      const inbox = projectMailMessageToInbox(message);
      if (inbox?.created) inboxCreated += 1;
    }
  }

  return {
    ok: true,
    account,
    status: "synced",
    provider: "ravi-mail",
    mailboxesImported,
    messagesImported,
    inboxCreated,
  };
}

function requireMailboxPermission(permission: "read" | "search" | "send" | "manage", mailbox: MailMailbox): void {
  const ctx = getMailScopeContext();
  if (canUseMailMailbox(ctx, permission, mailbox)) return;
  throw new CloudAuthError(
    "ORG_ACCESS_DENIED",
    `Permission denied: agent:${ctx.agentId} requires ${permission} on mailbox:${mailbox.normalizedAddress}`,
  );
}

function requireProviderPermission(permission: "sync" | "manage", provider: string): void {
  const ctx = getMailScopeContext();
  if (canUseMailProvider(ctx, permission, provider)) return;
  throw new CloudAuthError(
    "ORG_ACCESS_DENIED",
    `Permission denied: agent:${ctx.agentId} requires ${permission} on mail-provider:${provider}`,
  );
}

function requireAnyMailboxPermission(permission: "read" | "search" | "send" | "manage"): void {
  const ctx = getMailScopeContext();
  if (canUseAnyMailbox(ctx, permission)) return;
  throw new CloudAuthError(
    "ORG_ACCESS_DENIED",
    `Permission denied: agent:${ctx.agentId} requires ${permission} on mailbox:*`,
  );
}

function requireMailboxRefPermission(permission: "read" | "search" | "send" | "manage", ref: string): void {
  const mailbox = getMailMailbox(ref);
  if (mailbox) {
    requireMailboxPermission(permission, mailbox);
    return;
  }
  const pseudoMailbox: MailMailbox = {
    id: ref,
    accountId: "",
    address: ref,
    normalizedAddress: ref.trim().toLowerCase().normalize("NFKC"),
    displayName: null,
    role: "unknown",
    status: "active",
    providerMailboxId: null,
    isDefault: false,
    lastSyncedAt: null,
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
  };
  requireMailboxPermission(permission, pseudoMailbox);
}

function canUseRowMailbox(permission: "read" | "search" | "send" | "manage", mailboxId: string): boolean {
  const mailbox = getMailMailbox(mailboxId);
  return Boolean(mailbox && canUseMailMailbox(getMailScopeContext(), permission, mailbox));
}

function resolveLocalSendMailbox(ref: string | undefined): MailMailbox {
  if (ref?.trim()) {
    const mailbox = getMailMailbox(ref);
    if (!mailbox) throw new CloudAuthError("PAYLOAD_INVALID", `Mail mailbox not found: ${ref}`);
    return mailbox;
  }
  const mailboxes = listMailMailboxes({ status: "active", limit: 500 });
  const mailbox = mailboxes.find((item) => item.isDefault) ?? mailboxes[0];
  if (!mailbox) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "No active local mailbox. Create one with `ravi mail mailboxes create`.",
    );
  }
  return mailbox;
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

function redactOutboxPayload<T extends { payload?: Record<string, unknown> }>(outbox: T): T {
  if (!outbox.payload) return outbox;
  return {
    ...outbox,
    payload: {
      ...outbox.payload,
      ...(typeof outbox.payload.body === "string" ? { body: "[redacted]" } : {}),
    },
  };
}

function safeMailMessage<T extends MailMessage | MailMessageWithAddresses>(
  message: T,
): Omit<T, "bodyText" | "bodyHtml" | "rawHeaders"> {
  const { bodyText: _bodyText, bodyHtml: _bodyHtml, rawHeaders: _rawHeaders, ...safe } = message;
  return safe;
}

function safeMailMessages<T extends MailMessage | MailMessageWithAddresses>(
  messages: T[],
): Array<Omit<T, "bodyText" | "bodyHtml" | "rawHeaders">> {
  return messages.map((message) => safeMailMessage(message));
}

function safeOutboxRows(rows: MailOutboxRow[]): MailOutboxRow[] {
  return rows.map((row) => redactOutboxPayload(row));
}

function safeMailThread(thread: MailThread): MailThread {
  return thread;
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
