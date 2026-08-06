import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { listMailMailboxes, listMailMessages, listMailOutbox } from "../../mailbox/index.js";
import { ContractError } from "../agent-contract.js";
import {
  MailAccountsCommands,
  MailCommands,
  MailMailboxesCommands,
  MailMessagesCommands,
  MailOutboxCommands,
  MailRaviMailCommands,
  MailRaviMailMailboxesCommands,
  MailThreadsCommands,
} from "./mail.js";

// The gmail contract tests must prove the write brake fires BEFORE any
// connector call, so the connectors module is mocked with recording spies and
// GmailCommands is imported after the mock is installed.
const actualConnectorsModule = await import("../../link/connectors.js");
const gmailConnectorCalls: Array<Record<string, unknown>> = [];
const gmailConnectorLookups: Array<Record<string, unknown> | undefined> = [];
mock.module("../../link/connectors.js", () => ({
  ...actualConnectorsModule,
  execCapability: async (input: Record<string, unknown>) => {
    gmailConnectorCalls.push(input);
    return {
      result: { messageId: "gm_out_1", threadId: "gm_thr_1" },
      capability: String(input.capability),
      refreshed: false,
    };
  },
  listConnectors: async (input?: Record<string, unknown>) => {
    gmailConnectorLookups.push(input);
    return [{ id: "conn_google_1", provider: "google", status: "active", requiresReauth: false }];
  },
}));
const { GmailCommands } = await import("./gmail.js");

afterAll(() => mock.restore());

let stateDir: string | null = null;
let previousAgentId: string | undefined;
let previousSessionKey: string | undefined;
let previousSessionName: string | undefined;

setDefaultTimeout(20_000);

describe("mail CLI commands", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-mail-cli-test-");
    previousAgentId = process.env.RAVI_AGENT_ID;
    previousSessionKey = process.env.RAVI_SESSION_KEY;
    previousSessionName = process.env.RAVI_SESSION_NAME;
    delete process.env.RAVI_AGENT_ID;
    delete process.env.RAVI_SESSION_KEY;
    delete process.env.RAVI_SESSION_NAME;
  });

  afterEach(async () => {
    restoreEnv("RAVI_AGENT_ID", previousAgentId);
    restoreEnv("RAVI_SESSION_KEY", previousSessionKey);
    restoreEnv("RAVI_SESSION_NAME", previousSessionName);
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("creates local accounts and mailboxes with JSON output", async () => {
    const accounts = new MailAccountsCommands();
    const mailboxes = new MailMailboxesCommands();

    const { output: accountOutput } = await captureConsole(() =>
      accounts.create("ravi-mail", "acct_1", "Ravi Mail", "cloud-auth:ravi-mail", true),
    );
    const accountPayload = JSON.parse(accountOutput);

    const { output: mailboxOutput } = await captureConsole(() =>
      mailboxes.create("Luis@Ravi.Bot", "acct_1", "Luis", "primary", "remote_box_1", true, true),
    );
    const mailboxPayload = JSON.parse(mailboxOutput);

    expect(accountPayload.account.provider).toBe("ravi-mail");
    expect(mailboxPayload.mailbox.normalizedAddress).toBe("luis@ravi.bot");
    expect(mailboxPayload.mailbox.isDefault).toBe(true);
  });

  it("imports local messages and projects them into the real inbox", async () => {
    const accounts = new MailAccountsCommands();
    const mailboxes = new MailMailboxesCommands();
    const messages = new MailMessagesCommands();

    await captureConsole(() => accounts.create("ravi-mail", "acct_1", undefined, undefined, true));
    await captureConsole(() =>
      mailboxes.create("luis@ravi.bot", "acct_1", undefined, undefined, undefined, true, true),
    );

    const { output } = await captureConsole(() =>
      messages.importMessage(
        "luis@ravi.bot",
        "alice@example.com",
        "luis@ravi.bot",
        "Hello",
        "Local body",
        "ravi-mail",
        "remote_msg_1",
        "remote_thr_1",
        "<msg-1@ravi.bot>",
        true,
      ),
    );
    const payload = JSON.parse(output);

    expect(payload.message.subject).toBe("Hello");
    expect(payload.message.bodyText).toBeUndefined();
    expect(payload.inboxItem.sourceDomain).toBe("mail");
    expect(payload.inboxCreated).toBe(true);

    const { output: listOutput } = await captureConsole(() =>
      messages.list("luis@ravi.bot", undefined, undefined, true, undefined, undefined, true),
    );
    const listPayload = JSON.parse(listOutput);
    expect(listPayload.messages).toHaveLength(1);
    expect(listPayload.messages[0].bodyText).toBeUndefined();
    expect(listPayload.messages[0].bodyHtml).toBeUndefined();
    expect(listPayload.messages[0].rawHeaders).toBeUndefined();
  });

  it("queues mail locally instead of sending directly to provider", async () => {
    const accounts = new MailAccountsCommands();
    const mailboxes = new MailMailboxesCommands();
    const mail = new MailCommands();
    const outbox = new MailOutboxCommands();

    await captureConsole(() => accounts.create("ravi-mail", "acct_1", undefined, undefined, true));
    await captureConsole(() =>
      mailboxes.create("luis@ravi.bot", "acct_1", undefined, undefined, undefined, true, true),
    );

    const { output } = await captureConsole(() =>
      mail.send("bob@example.com", "Subject", "Body", "luis@ravi.bot", "idem-1", true, true),
    );
    const payload = JSON.parse(output);
    const { output: statusOutput } = await captureConsole(() => outbox.status(true));
    const statusPayload = JSON.parse(statusOutput);
    const { output: outboxOutput } = await captureConsole(() =>
      outbox.list(undefined, "luis@ravi.bot", undefined, true),
    );
    const outboxPayload = JSON.parse(outboxOutput);

    expect(payload.queued).toBe(true);
    expect(payload.message.bodyText).toBeUndefined();
    expect(payload.outbox.status).toBe("pending");
    expect(payload.outbox.payload.body).toBe("[redacted]");
    expect(statusPayload.counts.pending).toBe(1);
    expect(outboxPayload.outbox[0].payload.body).toBe("[redacted]");
    expect(JSON.stringify(outboxPayload)).not.toContain('"Body"');
  });

  it("queues replies and reads a safe local thread timeline", async () => {
    const accounts = new MailAccountsCommands();
    const mailboxes = new MailMailboxesCommands();
    const messages = new MailMessagesCommands();
    const mail = new MailCommands();
    const threads = new MailThreadsCommands();

    await captureConsole(() => accounts.create("ravi-mail", "acct_1", undefined, undefined, true));
    await captureConsole(() =>
      mailboxes.create("luis@ravi.bot", "acct_1", undefined, undefined, undefined, true, true),
    );
    const { output: importOutput } = await captureConsole(() =>
      messages.importMessage(
        "luis@ravi.bot",
        "alice@example.com",
        "luis@ravi.bot",
        "Question",
        "Can you help?",
        "ravi-mail",
        "remote_msg_1",
        undefined,
        "<msg-1@example.com>",
        true,
      ),
    );
    const imported = JSON.parse(importOutput);

    const { output: replyOutput } = await captureConsole(() =>
      mail.reply(
        imported.message.id,
        "Yes.",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "reply-1",
        true,
        true,
      ),
    );
    const reply = JSON.parse(replyOutput);
    const { output: threadOutput } = await captureConsole(() => threads.read(imported.message.threadId, true, true));
    const thread = JSON.parse(threadOutput);

    expect(reply.outbox.operation).toBe("reply");
    expect(reply.outbox.payload.body).toBe("[redacted]");
    expect(reply.message.threadId).toBe(imported.message.threadId);
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages.every((message: Record<string, unknown>) => message.bodyText === undefined)).toBe(true);
    expect(thread.messages.every((message: Record<string, unknown>) => message.bodyHtml === undefined)).toBe(true);
    expect(thread.messages.every((message: Record<string, unknown>) => message.rawHeaders === undefined)).toBe(true);
  });

  it("syncs Ravi Mail provider metadata into the local mailbox", async () => {
    const calls: string[] = [];
    const client = makeClient(async (_method, path) => {
      calls.push(path);
      if (path.startsWith("/api/cli/mail/mailboxes")) {
        return {
          mailboxes: [{ id: "remote_box_1", address: "luis@ravi.bot", isDefault: true, status: "active" }],
        };
      }
      if (path.startsWith("/api/cli/mail/messages")) {
        return {
          messages: [
            {
              id: "remote_msg_1",
              threadId: "remote_thr_1",
              subject: "Hello",
              snippet: "Preview only",
              receivedAt: "2026-06-04T10:00:00.000Z",
              addressSummary: {
                from: [{ address: "alice@example.com" }],
                to: [{ address: "luis@ravi.bot" }],
              },
            },
          ],
        };
      }
      return {};
    });
    const accounts = new MailAccountsCommands({ client, readCredentials: makeReadCredentials() });

    await captureConsole(() => accounts.create("ravi-mail", "acct_1", undefined, undefined, true));
    const { output } = await captureConsole(() => accounts.sync("acct_1", true, true));
    const payload = JSON.parse(output);
    const mailboxes = listMailMailboxes();
    const messages = listMailMessages();

    expect(payload.status).toBe("synced");
    expect(payload.mailboxesImported).toBe(1);
    expect(payload.messagesImported).toBe(1);
    expect(mailboxes[0].providerMailboxId).toBe("remote_box_1");
    expect(messages[0].bodyText).toBeNull();
    expect(messages[0].bodyRedactionStatus).toBe("preview_only");
    expect(calls).toEqual([
      "/api/cli/mail/mailboxes",
      "/api/cli/mail/messages?limit=50&mailbox=remote_box_1&addresses=1",
    ]);
  });

  it("keeps Ravi Mail provider operations explicit under mail providers ravi-mail", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return {
        mailbox: { address: "agent@ravi.bot", status: "disabled" },
        disabledRoutes: 2,
        providerSynced: true,
      };
    });
    const command = new MailRaviMailMailboxesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.disable("agent@ravi.bot", undefined, true));
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      { method: "POST", path: "/api/cli/mail/mailboxes/agent%40ravi.bot/disable", body: undefined },
    ]);
    expect(payload.mailbox.status).toBe("disabled");
    expect(payload.disabledRoutes).toBe(2);
    expect(payload.providerSynced).toBe(true);
  });

  it("can still send directly through Ravi Mail provider when explicitly requested", async () => {
    const bodies: unknown[] = [];
    const client = makeClient(async (_method, _path, body) => {
      bodies.push(body);
      return { sent: { id: "out_1", status: "queued" } };
    });
    const command = new MailRaviMailCommands({ client, readCredentials: makeReadCredentials() });

    await captureConsole(() =>
      command.send("bob@example.com", "Subject", "Body", "agent@example.com", undefined, undefined, true, true),
    );

    expect(bodies).toEqual([{ from: "agent@example.com", to: ["bob@example.com"], subject: "Subject", body: "Body" }]);
  });
});

describe("mail agent-first contract", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-mail-contract-test-");
    previousAgentId = process.env.RAVI_AGENT_ID;
    previousSessionKey = process.env.RAVI_SESSION_KEY;
    previousSessionName = process.env.RAVI_SESSION_NAME;
    delete process.env.RAVI_AGENT_ID;
    delete process.env.RAVI_SESSION_NAME;
    // hasContext() must be true so the contract helpers throw ContractError
    // instead of process.exit. RAVI_SESSION_KEY alone keeps agentId undefined,
    // which leaves the local-operator permission path open like the legacy
    // tests above.
    process.env.RAVI_SESSION_KEY = "agent:test:mail-contract";
    gmailConnectorCalls.length = 0;
    gmailConnectorLookups.length = 0;
  });

  afterEach(async () => {
    restoreEnv("RAVI_AGENT_ID", previousAgentId);
    restoreEnv("RAVI_SESSION_KEY", previousSessionKey);
    restoreEnv("RAVI_SESSION_NAME", previousSessionName);
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  async function setupLocalMailbox(): Promise<void> {
    const accounts = new MailAccountsCommands();
    const mailboxes = new MailMailboxesCommands();
    await captureConsole(() => accounts.create("ravi-mail", "acct_main", undefined, undefined, true));
    await captureConsole(() =>
      mailboxes.create("luis@ravi.bot", "acct_main", undefined, undefined, undefined, true, true),
    );
  }

  async function expectContractError(run: () => unknown | Promise<unknown>): Promise<ContractError> {
    let thrown: unknown;
    try {
      await captureConsole(run);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    return thrown as ContractError;
  }

  it("blocks mail send without --execute (dry-run, exit 3, nothing queued)", async () => {
    await setupLocalMailbox();
    const mail = new MailCommands();

    const contractError = await expectContractError(() =>
      mail.send("bob@example.com", "Subject", "Body text", "luis@ravi.bot", "idem-1", true),
    );

    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("mail send");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    const plan = envelope.error.plan as Record<string, unknown>;
    expect(plan.from).toBe("luis@ravi.bot");
    expect(plan.to).toEqual(["bob@example.com"]);
    expect(plan.subject).toBe("Subject");
    expect(plan.bodyPreview).toBe("Body text");
    expect(listMailMessages()).toHaveLength(0);
    expect(listMailOutbox({ limit: 10 })).toHaveLength(0);
  });

  it("blocks mail reply without --execute (dry-run, exit 3, nothing queued)", async () => {
    await setupLocalMailbox();
    const messages = new MailMessagesCommands();
    const mail = new MailCommands();
    const { output: importOutput } = await captureConsole(() =>
      messages.importMessage(
        "luis@ravi.bot",
        "alice@example.com",
        "luis@ravi.bot",
        "Question",
        "Can you help?",
        "ravi-mail",
        "remote_msg_1",
        undefined,
        "<msg-1@example.com>",
        true,
      ),
    );
    const imported = JSON.parse(importOutput);

    const contractError = await expectContractError(() =>
      mail.reply(imported.message.id, "Yes.", undefined, undefined, undefined, undefined, undefined, "reply-1", true),
    );

    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("mail reply");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    const plan = envelope.error.plan as Record<string, unknown>;
    expect(plan.messageId).toBe(imported.message.id);
    expect(plan.to).toBe("(original sender)");
    expect(listMailOutbox({ limit: 10 })).toHaveLength(0);
    expect(listMailMessages()).toHaveLength(1);
  });

  it("blocks mail providers ravi-mail send without --execute (no provider call)", async () => {
    const bodies: unknown[] = [];
    const client = makeClient(async (_method, _path, body) => {
      bodies.push(body);
      return { sent: { id: "out_1", status: "queued" } };
    });
    const command = new MailRaviMailCommands({ client, readCredentials: makeReadCredentials() });

    const contractError = await expectContractError(() =>
      command.send("bob@example.com", "Subject", "Body", "agent@example.com", undefined, undefined, true),
    );

    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("mail providers ravi-mail send");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(bodies).toHaveLength(0);
  });

  it("blocks gmail send without --execute (dry-run before any connector call)", async () => {
    const gmail = new GmailCommands();

    const contractError = await expectContractError(() =>
      gmail.send(
        "bob@example.com",
        undefined,
        undefined,
        "Oi",
        "Corpo do email",
        undefined,
        undefined,
        undefined,
        true,
      ),
    );

    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("gmail send");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    const plan = envelope.error.plan as Record<string, unknown>;
    expect(plan.to).toEqual(["bob@example.com"]);
    expect(plan.subject).toBe("Oi");
    expect(plan.bodyPreview).toBe("Corpo do email");
    expect(gmailConnectorCalls).toHaveLength(0);
    expect(gmailConnectorLookups).toHaveLength(0);
  });

  it("sends gmail with --execute calling the connector capability spy", async () => {
    const gmail = new GmailCommands();

    const { output } = await captureConsole(() =>
      gmail.send(
        "bob@example.com",
        undefined,
        undefined,
        "Oi",
        "Corpo do email",
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
    );

    expect(gmailConnectorCalls).toHaveLength(1);
    expect(gmailConnectorCalls[0]).toMatchObject({
      connectorId: "conn_google_1",
      capability: "gmail.message.send",
    });
    const payload = JSON.parse(output);
    expect(payload.result.messageId).toBe("gm_out_1");
  });

  it("emits MAILBOX_NOT_FOUND envelope with suggestions on mail mailboxes show --json (exit 1)", async () => {
    await setupLocalMailbox();
    const mailboxes = new MailMailboxesCommands();

    const contractError = await expectContractError(() => mailboxes.show("luiz@ravi.bot", true));

    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("mail mailboxes show");
    expect(envelope.error.code).toBe("MAILBOX_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("luis@ravi.bot");
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
  });

  it("emits ACCOUNT_NOT_FOUND envelope with suggestions on mail accounts sync --json (exit 1)", async () => {
    const accounts = new MailAccountsCommands();
    await captureConsole(() => accounts.create("ravi-mail", "acct_main", undefined, undefined, true));

    const contractError = await expectContractError(() => accounts.sync("acct_mian", true, true));

    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("mail accounts sync");
    expect(envelope.error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("acct_main");
  });

  it("emits MESSAGE_NOT_FOUND envelope without suggestions on mail messages read --json (exit 1)", async () => {
    const messages = new MailMessagesCommands();

    const contractError = await expectContractError(() => messages.read("msg-nope", undefined, true));

    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("mail messages read");
    expect(envelope.error.code).toBe("MESSAGE_NOT_FOUND");
    expect(envelope.error.suggestions).toBeUndefined();
    expect(envelope.error.suggestedAction).toContain("ravi mail messages list");
  });

  it("emits OUTBOX_NOT_FOUND envelope on mail outbox inspect --json (exit 1)", async () => {
    const outbox = new MailOutboxCommands();

    const contractError = await expectContractError(() => outbox.inspect("out-nope", true));

    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("mail outbox inspect");
    expect(envelope.error.code).toBe("OUTBOX_NOT_FOUND");
    expect(envelope.error.suggestedAction).toContain("ravi mail outbox list");
  });

  it("emits THREAD_NOT_FOUND envelope on mail threads read --json (exit 1)", async () => {
    const threads = new MailThreadsCommands();

    const contractError = await expectContractError(() => threads.read("thr-nope", undefined, true));

    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("mail threads read");
    expect(envelope.error.code).toBe("THREAD_NOT_FOUND");
  });

  it("supports --fields compact mode on mail accounts and messages listings", async () => {
    await setupLocalMailbox();
    const accountsCmd = new MailAccountsCommands();
    const messagesCmd = new MailMessagesCommands();
    await captureConsole(() =>
      messagesCmd.importMessage(
        "luis@ravi.bot",
        "alice@example.com",
        "luis@ravi.bot",
        "Hello",
        "Local body",
        "ravi-mail",
        "remote_msg_1",
        undefined,
        "<msg-1@ravi.bot>",
        true,
      ),
    );

    const { output: accountsOutput } = await captureConsole(() =>
      accountsCmd.list(undefined, undefined, undefined, undefined, true, "id,provider"),
    );
    const accountsPayload = JSON.parse(accountsOutput);
    expect(accountsPayload.accounts).toHaveLength(1);
    expect(Object.keys(accountsPayload.accounts[0]).sort()).toEqual(["id", "provider"]);

    const { output: messagesOutput } = await captureConsole(() =>
      messagesCmd.list("luis@ravi.bot", undefined, undefined, undefined, undefined, undefined, true, "id,subject"),
    );
    const messagesPayload = JSON.parse(messagesOutput);
    expect(messagesPayload.messages).toHaveLength(1);
    expect(Object.keys(messagesPayload.messages[0]).sort()).toEqual(["id", "subject"]);
  });
});

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

function makeClient(
  handler: (method: string, path: string, body: unknown, accessToken: string) => Promise<unknown>,
): ConsoleApiClient {
  return {
    me: mock(async () => ({
      user: { email: "alice@example.com" },
      organization: { id: "org_1" },
    })),
    requestJson: mock(async (method: string, path: string, body: unknown, accessToken: string) =>
      handler(method, path, body, accessToken),
    ),
  } as unknown as ConsoleApiClient;
}

function makeReadCredentials() {
  return () => makeCredentials();
}

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["mail"],
    user: { email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
