import { describe, expect, mock, test } from "bun:test";

import {
  prepareOutboundMailSend,
  providerSupportsCapability,
  sendOutboundMailWithAdapter,
  type MailCipherRef,
  type MailProviderAdapter,
  type MailProviderCapabilities,
} from "./provider-adapters";

describe("Ravi Mail provider adapter contracts", () => {
  test("declares provider capabilities without leaking provider-specific scheduling decisions", () => {
    const adapter = fakeAdapter();

    expect(providerSupportsCapability(adapter, "inbound")).toBe(true);
    expect(providerSupportsCapability(adapter, "outbound")).toBe(true);
    expect(providerSupportsCapability({ capabilities: { ...adapter.capabilities, outbound: false } }, "outbound")).toBe(
      false,
    );
  });

  test("requires verified sender and explicit from authorization before outbound adapter send", async () => {
    const sentRequests: unknown[] = [];
    const sendOutbound = mock(async (request: unknown) => {
      sentRequests.push(request);
      return {
      providerAdapter: "cloudflare_email" as const,
      providerMessageRefHash: "hash_provider_message_1",
      acceptedAt: "2026-05-11T03:00:00.000Z",
      };
    });
    const adapter = fakeAdapter({ sendOutbound });
    const draft = outboundDraft();

    expect(
      await sendOutboundMailWithAdapter({
        adapter,
        draft,
        authorization: { ok: false, reason: "missing_send_permission" },
        verifiedSender: {
          verified: true,
          scope: "domain",
          domain: "mail.ravi.bot",
          verifiedAt: "2026-05-11T03:00:00.000Z",
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: "from_not_authorized",
      publicError: "mail_send_denied",
    });

    expect(
      await sendOutboundMailWithAdapter({
        adapter,
        draft,
        authorization: {
          ok: true,
          actorId: "user_1",
          organizationId: "org_1",
          mailboxId: "mailbox_1",
          fromAddress: "agent@mail.ravi.bot",
          grantedAt: "2026-05-11T03:00:00.000Z",
        },
        verifiedSender: { verified: false, reason: "domain_unverified" },
      }),
    ).toMatchObject({
      ok: false,
      reason: "sender_not_verified",
      publicError: "mail_send_denied",
    });

    expect(sendOutbound).not.toHaveBeenCalled();

    const accepted = await sendOutboundMailWithAdapter({
      adapter,
      draft,
      authorization: {
        ok: true,
        actorId: "user_1",
        organizationId: "org_1",
        mailboxId: "mailbox_1",
        fromAddress: " Agent@MAIL.RAVI.BOT ",
        grantedAt: "2026-05-11T03:00:00.000Z",
      },
      verifiedSender: {
        verified: true,
        scope: "domain",
        domain: "mail.ravi.bot",
        verifiedAt: "2026-05-11T03:00:00.000Z",
      },
    });

    expect(accepted).toMatchObject({
      ok: true,
      result: {
        providerAdapter: "cloudflare_email",
        providerMessageRefHash: "hash_provider_message_1",
      },
    });
    expect(sendOutbound).toHaveBeenCalledTimes(1);
    expect(sentRequests[0]).toMatchObject({
      organizationId: "org_1",
      mailboxId: "mailbox_1",
      rawMimeCipherRef: cipherRef("raw_mime"),
      subjectCipherRef: cipherRef("subject"),
    });
    expect(JSON.stringify(sentRequests[0])).not.toContain("Plain subject");
  });

  test("rejects verified sender scope mismatches before touching the provider", () => {
    const adapter = fakeAdapter();

    expect(
      prepareOutboundMailSend({
        adapter,
        draft: outboundDraft({ from: { address: "agent@other.example", mailboxId: "mailbox_1" } }),
        authorization: {
          ok: true,
          actorId: "user_1",
          organizationId: "org_1",
          mailboxId: "mailbox_1",
          fromAddress: "agent@other.example",
          grantedAt: "2026-05-11T03:00:00.000Z",
        },
        verifiedSender: {
          verified: true,
          scope: "domain",
          domain: "mail.ravi.bot",
          verifiedAt: "2026-05-11T03:00:00.000Z",
        },
      }),
    ).toEqual({
      ok: false,
      reason: "sender_scope_mismatch",
      publicError: "mail_send_denied",
    });
  });
});

function fakeAdapter(overrides: Partial<MailProviderAdapter> = {}): MailProviderAdapter {
  return {
    name: "cloudflare_email",
    capabilities: capabilities(),
    async sendOutbound() {
      return {
        providerAdapter: "cloudflare_email",
        providerMessageRefHash: "hash_provider_message_1",
        acceptedAt: "2026-05-11T03:00:00.000Z",
      };
    },
    ...overrides,
  };
}

function capabilities(): MailProviderCapabilities {
  return {
    inbound: true,
    outbound: true,
    attachments: true,
    maxMessageBytes: 10 * 1024 * 1024,
    maxRecipientsPerMessage: 50,
    customDomains: true,
    catchAll: true,
    subaddressing: true,
    suppressionEvents: true,
    deliveryEvents: true,
    rateLimitModel: "domain",
    costDimensions: [
      "mail.messages.inbound",
      "mail.messages.outbound",
      "mail.recipients.outbound",
      "mail.bytes.inbound",
      "mail.bytes.outbound",
      "mail.attachments.bytes_stored",
      "mail.parser.jobs",
      "mail.delivery.events",
      "mail.suppression.events",
    ],
    supportStatus: "beta",
  };
}

function outboundDraft(overrides: Partial<ReturnType<typeof outboundDraftShape>> = {}) {
  return {
    ...outboundDraftShape(),
    ...overrides,
  };
}

function outboundDraftShape() {
  return {
    organizationId: "org_1",
    projectId: "proj_1",
    mailboxId: "mailbox_1",
    messageId: "message_1",
    from: {
      address: "agent@mail.ravi.bot",
      mailboxId: "mailbox_1",
    },
    to: ["lead@example.com"],
    rawMimeCipherRef: cipherRef("raw_mime"),
    subjectCipherRef: cipherRef("subject"),
    headersCipherRef: cipherRef("headers"),
    sizeBytes: 4096,
    idempotencyKey: "idem_1",
  };
}

function cipherRef(payloadKind: MailCipherRef["payloadKind"]): MailCipherRef {
  return {
    scheme: "ravi-mail-cipher-ref",
    ref: `cipher_${payloadKind}_1`,
    payloadKind,
    keyVersion: "key_v1",
    sizeBytes: 128,
    sha256: `hash_${payloadKind}`,
  };
}
