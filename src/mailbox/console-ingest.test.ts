import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { listLocalInboxItems } from "../inbox/local-db.js";
import type { InboxNatsPayload } from "../inbox/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  ingestConsoleMailReceivedEvent,
  listMailAccounts,
  listMailMailboxes,
  listMailMessages,
  readMailMessage,
} from "./index.js";

let stateDir: string | null = null;

describe("console mail event ingest", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-console-mail-ingest-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("persists enriched Console mail events into the local mailbox before inbox projection", () => {
    const result = ingestConsoleMailReceivedEvent(
      makePayload({
        payload: {
          messageId: "remote_msg_1",
          mailboxId: "remote_box_1",
          mailboxAddress: "Nx-Luis@Ravi.Bot",
          mail: {
            messageId: "remote_msg_1",
            mailboxId: "remote_box_1",
            mailboxAddress: "Nx-Luis@Ravi.Bot",
            receivedAt: "2026-06-04T14:00:00.000Z",
            threadId: "remote_thread_1",
            subject: "Entrada nova",
            addressSummary: {
              from: [{ address: "sender@example.com", name: "Sender" }],
              to: [{ address: "nx-luis@ravi.bot" }],
              internetMessageId: "<remote-msg-1@example.com>",
            },
            bodyText: "conteudo completo",
            bodyHtml: "<p>conteudo completo</p>",
            attachments: [
              {
                id: "remote_att_1",
                filename: "contrato.pdf",
                contentType: "application/pdf",
                sizeBytes: 12345,
                sha256: "sha256:abc",
                status: "unscanned",
                hasEncryptedObject: true,
              },
            ],
            enrichment: { status: "enriched" },
          },
        },
      }),
    );

    expect(result.status).toBe("ingested");
    expect(listMailAccounts()).toHaveLength(1);
    const [mailbox] = listMailMailboxes();
    expect(mailbox?.normalizedAddress).toBe("nx-luis@ravi.bot");

    const messages = listMailMessages({ includeAddresses: true });
    expect(messages).toHaveLength(1);
    const message = readMailMessage(messages[0]!.id, { includeAddresses: true });
    expect(message).toMatchObject({
      providerMessageId: "remote_msg_1",
      providerThreadId: "remote_thread_1",
      rfcMessageId: "<remote-msg-1@example.com>",
      subject: "Entrada nova",
      bodyText: "conteudo completo",
      bodyRedactionStatus: "full_local",
    });
    expect(message.attachments).toEqual([
      expect.objectContaining({
        filename: "contrato.pdf",
        contentType: "application/pdf",
        sizeBytes: 12345,
        sha256: "sha256:abc",
        providerAttachmentId: "remote_att_1",
        redactionStatus: "unscanned",
      }),
    ]);
    expect(message.addresses.map((address) => `${address.kind}:${address.address}`)).toContain(
      "from:sender@example.com",
    );
    expect(JSON.stringify(message.safePayload)).not.toContain("conteudo completo");
    expect(listLocalInboxItems({ sourceDomain: "mail" })).toHaveLength(1);
  });

  it("dedupes duplicate Console deliveries by provider message id", () => {
    const payload = makePayload({
      eventId: "console_item_1",
      sequence: 10,
      payload: {
        messageId: "remote_msg_duplicate",
        mailboxAddress: "nx-luis@ravi.bot",
        mail: {
          messageId: "remote_msg_duplicate",
          mailboxAddress: "nx-luis@ravi.bot",
          subject: "Primeira versao",
          bodyText: "body 1",
          attachments: [{ id: "remote_att_1", filename: "one.pdf" }],
        },
      },
    });

    const first = ingestConsoleMailReceivedEvent(payload);
    const second = ingestConsoleMailReceivedEvent({
      ...payload,
      eventId: "console_item_2",
      sequence: 11,
      payload: {
        messageId: "remote_msg_duplicate",
        mailboxAddress: "nx-luis@ravi.bot",
        mail: {
          messageId: "remote_msg_duplicate",
          mailboxAddress: "nx-luis@ravi.bot",
          subject: "Segunda versao",
          bodyText: "body 2",
          attachments: [{ id: "remote_att_2", filename: "two.pdf" }],
        },
      },
    });

    expect(first.status).toBe("ingested");
    expect(second.status).toBe("ingested");
    expect(first.message?.id).toBe(second.message?.id);
    expect(listMailMessages()).toHaveLength(1);
    const message = readMailMessage(first.message!.id);
    expect(message.bodyText).toBe("body 2");
    expect(message.attachments).toEqual([
      expect.objectContaining({
        filename: "two.pdf",
        providerAttachmentId: "remote_att_2",
      }),
    ]);
    expect(listLocalInboxItems({ sourceDomain: "mail" })).toHaveLength(1);
  });

  it("stores metadata-only Console mail events as preview-only local messages", () => {
    const result = ingestConsoleMailReceivedEvent(
      makePayload({
        payload: {
          messageId: "remote_msg_preview",
          mailboxAddress: "nx-luis@ravi.bot",
          mail: {
            messageId: "remote_msg_preview",
            mailboxAddress: "nx-luis@ravi.bot",
            subject: "Sem corpo local",
            enrichment: { status: "failed", reason: "mail_read_failed" },
          },
        },
        summary: "Resumo seguro",
      }),
    );

    expect(result.status).toBe("ingested");
    const [message] = listMailMessages();
    expect(message).toMatchObject({
      providerMessageId: "remote_msg_preview",
      subject: "Sem corpo local",
      snippet: "Resumo seguro",
      bodyText: null,
      bodyHtml: null,
      bodyRedactionStatus: "preview_only",
    });
  });
});

function makePayload(overrides: Partial<InboxNatsPayload> = {}): InboxNatsPayload {
  return {
    version: 1,
    eventId: "console_item_1",
    sequence: 1,
    dedupeKey: "mail:remote_msg_1",
    eventType: "mail.message.received",
    category: "mail",
    severity: "info",
    sensitivity: "restricted",
    title: "Email received",
    summary: "New email",
    organization: { id: "org_1" },
    project: null,
    source: { type: "mail_message", id: "remote_msg_1" },
    actor: { type: null, id: null },
    target: { type: "mailbox", id: "remote_box_1" },
    payload: {
      messageId: "remote_msg_1",
      mailboxAddress: "nx-luis@ravi.bot",
    },
    links: null,
    delivery: {
      subscriptionId: "sub_1",
      installationId: "ins_1",
      pollId: "poll_1",
      leaseId: "lease_1",
      localDeliveredAt: "2026-06-04T14:00:00.000Z",
    },
    occurredAt: "2026-06-04T14:00:00.000Z",
    createdAt: "2026-06-04T14:00:00.000Z",
    ...overrides,
  };
}
