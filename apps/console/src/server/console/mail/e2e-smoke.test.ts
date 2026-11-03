import { describe, expect, mock, test } from "bun:test";

import { createMailSmokeHarness, type MailSmokeAuditEvent, type MailSmokePolicyInput } from "./test-harness";

describe("Ravi Mail local smoke harness", () => {
  test("runs the intended inbound read and outbound send flow with local fakes", async () => {
    const policyCalls: MailSmokePolicyInput[] = [];
    const auditEvents: MailSmokeAuditEvent[] = [];
    const policy = mock((input: MailSmokePolicyInput) => {
      policyCalls.push(input);
      if (input.actorOrganizationId !== input.mailbox.organizationId) {
        return {
          ok: false,
          publicError: "mail_operation_denied",
          reason: "cross_organization",
        } as const;
      }

      return input.canRead
        ? ({ ok: true } as const)
        : ({
            ok: false,
            publicError: "mail_operation_denied",
            reason: "missing_read_permission",
          } as const);
    });
    const audit = {
      record: mock((event: MailSmokeAuditEvent) => {
        auditEvents.push(event);
      }),
    };
    const harness = createMailSmokeHarness({
      audit,
      now: new Date("2026-05-11T12:00:00.000Z"),
      policy,
    });
    const rawMime = [
      "From: customer@example.com",
      "To: Agent+lead-42@MAIL.RAVI.BOT",
      "Subject: Contract terms",
      "",
      "Plaintext proposal: price is 42.",
    ].join("\r\n");

    const { domain, mailbox, route } = await harness.createDomainMailboxAndRoute({
      domain: "MAIL.RAVI.BOT",
      localPart: "Agent",
      organizationId: "org_1",
      projectId: "proj_1",
    });

    expect(domain).toMatchObject({
      domain: "mail.ravi.bot",
      providerAdapter: "cloudflare_email",
      status: "verified",
    });
    expect(mailbox).toMatchObject({
      address: "agent@mail.ravi.bot",
      organizationId: "org_1",
      projectId: "proj_1",
      status: "active",
    });
    expect(route).toMatchObject({
      action: "deliver",
      mailboxId: mailbox.id,
      matchType: "exact",
      pattern: "agent@mail.ravi.bot",
      status: "active",
    });

    const inbound = await harness.receiveInboundRawMime({
      organizationId: "org_1",
      projectId: "proj_1",
      providerMessageRefHash: "hash_provider_inbound_1",
      rawMime,
      recipient: "Agent+lead-42@MAIL.RAVI.BOT",
      recipientHashes: ["hash_recipient_agent"],
      senderHash: "hash_sender_customer",
    });

    expect(inbound.ok).toBe(true);
    if (!inbound.ok) throw new Error("Inbound smoke setup failed.");

    expect(inbound.resolution).toMatchObject({
      route: {
        id: route.id,
      },
      subaddressTag: "lead-42",
    });
    expect(inbound.encryptedRawMime.ciphertext).not.toContain("Contract terms");
    expect(inbound.encryptedRawMime.ciphertext).not.toContain("price is 42");
    expect(inbound.message.rawMimeCipherRef).toMatchObject({
      algorithm: "AES-256-GCM",
      ciphertextRef: `object://mail/org_1/${mailbox.id}/${inbound.message.id}/raw_mime`,
      keyScope: {
        mailboxId: mailbox.id,
        organizationId: "org_1",
        payloadKind: "raw_mime",
        projectId: "proj_1",
        resourceId: inbound.message.id,
        resourceType: "message",
      },
    });

    const metadata = harness.listMessageMetadata({
      mailboxId: mailbox.id,
      organizationId: "org_1",
    });

    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({
      direction: "inbound",
      fromHash: "hash_sender_customer",
      id: inbound.message.id,
      providerMessageRefHash: "hash_provider_inbound_1",
      rawMimeCipherRef: {
        ciphertextRef: `object://mail/org_1/${mailbox.id}/${inbound.message.id}/raw_mime`,
      },
      status: "received",
      toHashesJson: ["hash_recipient_agent"],
    });
    expect(JSON.stringify(metadata)).not.toContain("Contract terms");
    expect(JSON.stringify(metadata)).not.toContain("Plaintext proposal");
    expect(JSON.stringify(metadata)).not.toContain("customer@example.com");

    const deniedRead = await harness.decryptRawMime({
      actorOrganizationId: "org_2",
      canRead: true,
      messageId: inbound.message.id,
      organizationId: "org_1",
    });

    expect(deniedRead).toEqual({
      ok: false,
      publicError: "mail_operation_denied",
      reason: "cross_organization",
    });

    const allowedRead = await harness.decryptRawMime({
      actorOrganizationId: "org_1",
      canRead: true,
      messageId: inbound.message.id,
      organizationId: "org_1",
    });

    expect(allowedRead).toEqual({
      ok: true,
      plaintext: rawMime,
    });
    expect(policy).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "mail.decrypt",
        actorOrganizationId: "org_2",
        allowed: false,
        messageId: inbound.message.id,
        organizationId: "org_1",
        reason: "cross_organization",
      }),
      expect.objectContaining({
        action: "mail.decrypt",
        actorOrganizationId: "org_1",
        allowed: true,
        messageId: inbound.message.id,
        organizationId: "org_1",
      }),
    ]);

    const outboundRawMime = [
      "From: agent@mail.ravi.bot",
      "To: lead@example.com",
      "Subject: Follow up",
      "",
      "Confidential outbound body.",
    ].join("\r\n");
    const outbound = await harness.sendOutboundRawMime({
      authorization: {
        actorId: "user_1",
        fromAddress: "agent@mail.ravi.bot",
        grantedAt: "2026-05-11T12:00:00.000Z",
        mailboxId: mailbox.id,
        ok: true,
        organizationId: "org_1",
      },
      fromAddress: "agent@mail.ravi.bot",
      idempotencyKey: "mail-smoke-outbound-1",
      mailbox,
      messageId: "outbound_message_1",
      rawMime: outboundRawMime,
      to: ["lead@example.com"],
      verifiedSender: {
        domain: "mail.ravi.bot",
        scope: "domain",
        verified: true,
        verifiedAt: "2026-05-11T12:00:00.000Z",
      },
    });

    expect(outbound).toEqual({
      ok: true,
      result: {
        acceptedAt: "2026-05-11T12:00:00.000Z",
        deliveryEventRefHash: "delivery_1",
        providerAdapter: "cloudflare_email",
        providerMessageRefHash: "provider_outbound_1",
      },
    });
    expect(harness.providerAdapter.sent).toHaveLength(1);
    expect(harness.providerAdapter.sent[0]).toMatchObject({
      from: {
        address: "agent@mail.ravi.bot",
        mailboxId: mailbox.id,
      },
      idempotencyKey: "mail-smoke-outbound-1",
      rawMimeCipherRef: {
        payloadKind: "raw_mime",
        ref: `object://mail/org_1/${mailbox.id}/outbound_message_1/raw_mime`,
        scheme: "ravi-mail-cipher-ref",
      },
      to: ["lead@example.com"],
    });
    expect(JSON.stringify(harness.providerAdapter.sent[0])).not.toContain("Confidential outbound body");
    expect(JSON.stringify(harness.providerAdapter.sent[0])).not.toContain("Follow up");
  });
});
