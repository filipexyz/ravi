import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  createMailAccount,
  createMailMailbox,
  enqueueMailReply,
  enqueueMailSend,
  getMailThread,
  importMailMessage,
  listMailAccounts,
  listMailMailboxes,
  listMailMessages,
  listMailOutbox,
  readMailMessage,
} from "./index.js";

let stateDir: string | null = null;

describe("local mailbox db", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-mailbox-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("initializes local mail schema without cloud auth", () => {
    const account = createMailAccount({ provider: "ravi-mail", displayName: "Ravi Mail" });
    const mailbox = createMailMailbox({
      accountId: account.id,
      address: "Luis@Ravi.Bot",
      isDefault: true,
    });

    expect(listMailAccounts()).toHaveLength(1);
    expect(listMailMailboxes()).toHaveLength(1);
    expect(mailbox.normalizedAddress).toBe("luis@ravi.bot");
  });

  it("dedupes provider messages and keeps local body readable", () => {
    const account = createMailAccount({ provider: "ravi-mail" });
    const mailbox = createMailMailbox({ accountId: account.id, address: "luis@ravi.bot", isDefault: true });

    const first = importMailMessage({
      mailbox: mailbox.address,
      provider: "ravi-mail",
      providerMessageId: "remote_msg_1",
      providerThreadId: "remote_thr_1",
      rfcMessageId: "<msg-1@ravi.bot>",
      subject: "Hello",
      bodyText: "Local body",
      addresses: [
        { kind: "from", address: "alice@example.com" },
        { kind: "to", address: mailbox.address },
      ],
    });
    const second = importMailMessage({
      mailbox: mailbox.address,
      provider: "ravi-mail",
      providerMessageId: "remote_msg_1",
      providerThreadId: "remote_thr_1",
      rfcMessageId: "<msg-1@ravi.bot>",
      subject: "Hello updated",
      bodyText: "Updated local body",
      addresses: [{ kind: "from", address: "alice@example.com" }],
    });

    expect(second.id).toBe(first.id);
    expect(listMailMessages({ includeAddresses: true })).toHaveLength(1);
    expect(readMailMessage(first.id).bodyText).toBe("Updated local body");
  });

  it("queues outbound mail locally before provider delivery", () => {
    const account = createMailAccount({ provider: "ravi-mail" });
    const mailbox = createMailMailbox({ accountId: account.id, address: "luis@ravi.bot", isDefault: true });

    const first = enqueueMailSend({
      from: mailbox.address,
      to: ["bob@example.com"],
      subject: "Queued",
      body: "Body",
      idempotencyKey: "send-1",
    });
    const second = enqueueMailSend({
      from: mailbox.address,
      to: ["bob@example.com"],
      subject: "Queued",
      body: "Body",
      idempotencyKey: "send-1",
    });

    expect(first.outbox.id).toBe(second.outbox.id);
    expect(first.message.status).toBe("queued");
    expect(listMailOutbox()).toHaveLength(1);
  });

  it("threads replies through message-id references", () => {
    const account = createMailAccount({ provider: "ravi-mail" });
    const mailbox = createMailMailbox({ accountId: account.id, address: "luis@ravi.bot", isDefault: true });
    const original = importMailMessage({
      mailbox: mailbox.address,
      provider: "ravi-mail",
      providerMessageId: "remote_msg_1",
      rfcMessageId: "<msg-1@example.com>",
      subject: "Question",
      bodyText: "Can you help?",
      addresses: [
        { kind: "from", address: "alice@example.com" },
        { kind: "to", address: mailbox.address },
      ],
    });

    const reply = enqueueMailReply({
      messageId: original.id,
      body: "Yes.",
      idempotencyKey: "reply-1",
    });

    expect(reply.message.threadId).toBe(original.threadId);
    expect(reply.message.safePayload.replyToMessageId).toBe(original.id);
    expect(reply.outbox.operation).toBe("reply");
    expect(getMailThread(original.threadId)?.lastLocalMessageId).toBe(reply.message.id);
    expect(listMailMessages({ threadId: original.threadId })).toHaveLength(2);
  });
});
