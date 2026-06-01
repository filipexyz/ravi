import { describe, expect, it } from "bun:test";
import {
  enrichMailMessageReceivedPayload,
  extractMailMessageId,
  withMailEnrichmentFailure,
} from "./mail-enrichment.js";
import type { InboxNatsPayload } from "./types.js";

describe("mail inbox payload enrichment", () => {
  it("reads explicit mail payloads and embeds full content in the local NATS JSON", async () => {
    const calls: Array<{ messageId: string; payloadKind: string }> = [];
    const result = await enrichMailMessageReceivedPayload(
      makePayload({
        payload: {
          messageId: "msg_1",
          mailboxId: "box_1",
          mailboxAddress: "nx-luis@ravi.bot",
          receivedAt: "2026-06-01T11:56:27.165Z",
        },
      }),
      async (messageId, payloadKind) => {
        calls.push({ messageId, payloadKind });
        if (payloadKind === "subject") {
          return { plaintext: "Re: foi" };
        }
        if (payloadKind === "address_summary") {
          return {
            plaintext: JSON.stringify({
              schemaVersion: 1,
              from: [{ address: "sender@example.com", name: "Sender" }],
              to: [{ address: "nx-luis@ravi.bot", name: null }],
              cc: [],
              bcc: [],
              replyTo: [],
              internetMessageId: "<mail@example.com>",
            }),
          };
        }
        return {
          plaintext: JSON.stringify({
            schemaVersion: 1,
            text: "boaaaa\n\n> foi",
            html: "<p>boaaaa</p><blockquote>foi</blockquote>",
          }),
        };
      },
      { now: () => "2026-06-01T12:00:00.000Z" },
    );

    expect(calls).toEqual([
      { messageId: "msg_1", payloadKind: "subject" },
      { messageId: "msg_1", payloadKind: "address_summary" },
      { messageId: "msg_1", payloadKind: "parsed_body" },
    ]);
    const mail = record(result.payload?.mail);
    expect(mail).toMatchObject({
      messageId: "msg_1",
      mailboxId: "box_1",
      mailboxAddress: "nx-luis@ravi.bot",
      subject: "Re: foi",
      bodyText: "boaaaa\n\n> foi",
      bodyHtml: "<p>boaaaa</p><blockquote>foi</blockquote>",
      enrichment: {
        status: "enriched",
        source: "console_mail_read",
        enrichedAt: "2026-06-01T12:00:00.000Z",
      },
    });
    expect(result.payload?.mailContent).toEqual(mail.content);
    expect(JSON.stringify(result.payload)).toContain("boaaaa\\n\\n> foi");
  });

  it("extracts the message id from legacy nested mail payloads and links", () => {
    expect(
      extractMailMessageId(
        makePayload({
          payload: { mail: { messageId: "msg_nested" } },
        }),
      ),
    ).toBe("msg_nested");

    expect(
      extractMailMessageId(
        makePayload({
          payload: {},
          links: { console: { message: "https://console.ravi.bot/mail/messages/msg_from_link" } } as unknown as
            | InboxNatsPayload["links"]
            | undefined,
          source: { type: "console", id: null },
        }),
      ),
    ).toBe("msg_from_link");
  });

  it("records a sanitized enrichment failure without adding message plaintext", () => {
    const result = withMailEnrichmentFailure(
      makePayload({
        payload: {
          messageId: "msg_1",
          mailboxAddress: "nx-luis@ravi.bot",
        },
      }),
      "mail_read_failed",
      { now: () => "2026-06-01T12:00:00.000Z" },
    );

    expect(result.payload?.mail).toEqual({
      messageId: "msg_1",
      mailboxId: null,
      mailboxAddress: "nx-luis@ravi.bot",
      enrichment: {
        status: "failed",
        reason: "mail_read_failed",
        attemptedAt: "2026-06-01T12:00:00.000Z",
      },
    });
    expect(JSON.stringify(result)).not.toContain("plaintext");
  });
});

function makePayload(overrides: Partial<InboxNatsPayload> = {}): InboxNatsPayload {
  return {
    version: 1,
    eventId: "item_1",
    sequence: 1,
    dedupeKey: "mail:msg_1",
    eventType: "mail.message.received",
    category: "mail",
    severity: "info",
    sensitivity: "restricted",
    title: "Email received",
    summary: "New email",
    organization: { id: "org_1" },
    project: null,
    source: { type: "mail_message", id: "msg_1" },
    actor: { type: null, id: null },
    target: { type: "mailbox", id: "box_1" },
    payload: {
      messageId: "msg_1",
    },
    links: null,
    delivery: {
      subscriptionId: "sub_1",
      installationId: "ins_1",
      pollId: "poll_1",
      leaseId: "lease_1",
      localDeliveredAt: "2026-06-01T12:00:00.000Z",
    },
    occurredAt: "2026-06-01T11:59:00.000Z",
    createdAt: "2026-06-01T11:59:00.000Z",
    ...overrides,
  };
}

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}
