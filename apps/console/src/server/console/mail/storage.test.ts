import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { schema } from "@/server/db";
import {
  assertNoPlaintextMailPayloadFields,
  createMailDomain,
  createMailbox,
  lookupMailboxByAddress,
  recordEncryptedMailMessage,
  resolveInboundMailbox,
  type InsertMailMessageInput,
  type InsertMailThreadInput,
  type MailAttachment,
  type MailDeliveryEvent,
  type MailDomain,
  type MailKeyRef,
  type MailMessage,
  type MailRoute,
  type MailStorageRepository,
  type MailThread,
  type Mailbox,
} from "./storage";

describe("Ravi Mail storage foundation", () => {
  test("keeps domain and mailbox operations scoped to one organization", async () => {
    const repository = createInMemoryMailStorageRepository();

    await createMailDomain({
      input: {
        domain: "mail.ravi.bot",
        organizationId: "org_1",
        providerAdapter: "generic",
        status: "verified",
      },
      repository,
    });
    await createMailDomain({
      input: {
        domain: "mail.ravi.bot",
        organizationId: "org_2",
        providerAdapter: "generic",
        status: "verified",
      },
      repository,
    });

    expect(repository.domains.map((domain) => domain.organizationId).sort()).toEqual(["org_1", "org_2"]);

    const org1Domain = await repository.findDomainByName({
      organizationId: "org_1",
      domain: "mail.ravi.bot",
    });
    const org2Domain = await repository.findDomainByName({
      organizationId: "org_2",
      domain: "mail.ravi.bot",
    });

    expect(org1Domain?.id).not.toBe(org2Domain?.id);

    await createMailbox({
      input: {
        domainId: org1Domain?.id ?? "missing",
        localPart: "agent-one",
        organizationId: "org_1",
        projectId: "proj_1",
      },
      repository,
    });

    await expect(
      createMailbox({
        input: {
          domainId: org1Domain?.id ?? "missing",
          localPart: "agent-two",
          organizationId: "org_2",
        },
        repository,
      }),
    ).rejects.toBeInstanceOf(ConsoleApiError);
  });

  test("looks up mailboxes by address without cross-tenant leakage", async () => {
    const repository = createInMemoryMailStorageRepository();
    const domain = await createMailDomain({
      input: {
        domain: "mail.ravi.bot",
        organizationId: "org_2",
        providerAdapter: "generic",
        status: "verified",
      },
      repository,
    });
    await createMailbox({
      input: {
        domainId: domain.id,
        localPart: "support",
        organizationId: "org_2",
      },
      repository,
    });

    await expect(
      lookupMailboxByAddress({
        address: "support@mail.ravi.bot",
        organizationId: "org_1",
        repository,
      }),
    ).resolves.toEqual({
      ok: false,
      publicError: "mail_address_unavailable",
    });

    await expect(
      lookupMailboxByAddress({
        address: "missing@mail.ravi.bot",
        organizationId: "org_1",
        repository,
      }),
    ).resolves.toEqual({
      ok: false,
      publicError: "mail_address_unavailable",
    });

    const ownLookup = await lookupMailboxByAddress({
      address: "support@mail.ravi.bot",
      organizationId: "org_2",
      repository,
    });
    expect(ownLookup.ok).toBe(true);

    const inboundLookup = await resolveInboundMailbox({
      address: "support+case-42@mail.ravi.bot",
      organizationId: "org_2",
      repository,
    });
    expect(inboundLookup).toMatchObject({
      ok: true,
      value: {
        subaddressTag: "case-42",
      },
    });
  });

  test("allows mailbox creation on owned customer-managed domains before routing is ready", async () => {
    const repository = createInMemoryMailStorageRepository();
    const domain = await createMailDomain({
      input: {
        domain: "customer.example",
        organizationId: "org_1",
        providerAdapter: "cloudflare_email",
        status: "pending",
        authStatusJson: {
          mode: "customer_managed",
          ownershipStatus: "verified",
        },
        metadataJson: {
          managed: false,
          ownershipMode: "customer_managed",
        },
      },
      repository,
    });

    const mailbox = await createMailbox({
      input: {
        domainId: domain.id,
        localPart: "support",
        organizationId: "org_1",
      },
      repository,
    });

    expect(mailbox.address).toBe("support@customer.example");
  });

  test("records provider message refs idempotently inside the organization boundary", async () => {
    const repository = createInMemoryMailStorageRepository();
    const mailbox1 = await seedMailbox(repository, "org_1", "agent");
    const mailbox2 = await seedMailbox(repository, "org_2", "other-agent");
    const firstInput = messageInput({
      mailboxId: mailbox1.id,
      organizationId: "org_1",
      providerMessageRefHash: "provider_hash_1",
    });

    const first = await recordEncryptedMailMessage({ input: firstInput, repository });
    const duplicate = await recordEncryptedMailMessage({ input: firstInput, repository });
    const otherOrg = await recordEncryptedMailMessage({
      input: messageInput({
        mailboxId: mailbox2.id,
        organizationId: "org_2",
        providerMessageRefHash: "provider_hash_1",
      }),
      repository,
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.message.id).toBe(first.message.id);
    expect(otherOrg.created).toBe(true);
    expect(repository.messages).toHaveLength(2);
  });

  test("does not expose plaintext payload columns or accept plaintext message inputs", async () => {
    expect(mailColumnKeys(schema.mailMessages)).not.toContain("subject");
    expect(mailColumnKeys(schema.mailMessages)).not.toContain("body");
    expect(mailColumnKeys(schema.mailMessages)).not.toContain("rawMime");
    expect(mailColumnKeys(schema.mailMessages)).not.toContain("headers");
    expect(mailColumnKeys(schema.mailAttachments)).not.toContain("filename");
    expect(mailColumnKeys(schema.mailAttachments)).not.toContain("object");

    expect(() => assertNoPlaintextMailPayloadFields({ subject: "hello" })).toThrow(ConsoleApiError);
    expect(() => assertNoPlaintextMailPayloadFields({ metadataJson: { headers: { from: "a@b.test" } } })).toThrow(
      ConsoleApiError,
    );

    const repository = createInMemoryMailStorageRepository();
    const mailbox = await seedMailbox(repository, "org_1", "secure");
    await expect(
      recordEncryptedMailMessage({
        input: {
          ...messageInput({
            mailboxId: mailbox.id,
            organizationId: "org_1",
            providerMessageRefHash: "provider_hash_plaintext",
          }),
          subject: "plaintext subject",
        } as InsertMailMessageInput,
        repository,
      }),
    ).rejects.toBeInstanceOf(ConsoleApiError);
  });
});

function createInMemoryMailStorageRepository(): MailStorageRepository & {
  domains: MailDomain[];
  mailboxes: Mailbox[];
  messages: MailMessage[];
} {
  const projects = [
    { id: "proj_1", organizationId: "org_1" },
    { id: "proj_2", organizationId: "org_2" },
  ];
  const domains: MailDomain[] = [];
  const mailboxes: Mailbox[] = [];
  const routes: MailRoute[] = [];
  const threads: MailThread[] = [];
  const messages: MailMessage[] = [];
  const attachments: MailAttachment[] = [];
  const deliveryEvents: MailDeliveryEvent[] = [];
  const keyRefs: MailKeyRef[] = [];

  return {
    domains,
    mailboxes,
    messages,

    async disableRoutesForMailbox(input) {
      const disabledRoutes: MailRoute[] = [];
      for (const route of routes) {
        if (
          route.organizationId === input.organizationId &&
          route.mailboxId === input.mailboxId &&
          route.status === "active"
        ) {
          route.status = "disabled";
          route.updatedAt = new Date();
          disabledRoutes.push(route);
        }
      }
      return disabledRoutes;
    },

    async findDomainById(input) {
      return (
        domains.find((domain) => domain.organizationId === input.organizationId && domain.id === input.domainId) ??
        null
      );
    },

    async findDomainByName(input) {
      return (
        domains.find((domain) => domain.organizationId === input.organizationId && domain.domain === input.domain) ??
        null
      );
    },

    async findMailboxByAddress(input) {
      return (
        mailboxes.find((mailbox) => mailbox.organizationId === input.organizationId && mailbox.address === input.address) ??
        null
      );
    },

    async findMailboxById(input) {
      return (
        mailboxes.find((mailbox) => mailbox.organizationId === input.organizationId && mailbox.id === input.mailboxId) ??
        null
      );
    },

    async findMessageByProviderRef(input) {
      return (
        messages.find(
          (message) =>
            message.organizationId === input.organizationId &&
            message.providerAdapter === input.providerAdapter &&
            message.providerMessageRefHash === input.providerMessageRefHash,
        ) ?? null
      );
    },

    async findProjectById(input) {
      return (
        projects.find((project) => project.organizationId === input.organizationId && project.id === input.projectId) ??
        null
      );
    },

    async findThreadById(input) {
      return (
        threads.find((thread) => thread.organizationId === input.organizationId && thread.id === input.threadId) ?? null
      );
    },

    async insertAttachment(input) {
      const attachment = {
        id: `attachment_${attachments.length + 1}`,
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        filenameCipherRef: input.filenameCipherRef ?? null,
        contentType: input.contentType ?? null,
        sizeBytes: input.sizeBytes ?? null,
        sha256: input.sha256 ?? null,
        objectCipherRef: input.objectCipherRef,
        status: input.status ?? "unscanned",
        metadataJson: input.metadataJson ?? {},
        createdAt: new Date(),
      } satisfies MailAttachment;
      attachments.push(attachment);
      return attachment;
    },

    async insertDeliveryEvent(input) {
      const event = {
        id: `delivery_${deliveryEvents.length + 1}`,
        organizationId: input.organizationId,
        mailboxId: input.mailboxId,
        messageId: input.messageId ?? null,
        eventType: input.eventType,
        providerAdapter: input.providerAdapter,
        providerEventRefHash: input.providerEventRefHash ?? null,
        status: input.status ?? "recorded",
        occurredAt: input.occurredAt,
        metadataJson: input.metadataJson ?? {},
        createdAt: new Date(),
      } satisfies MailDeliveryEvent;
      deliveryEvents.push(event);
      return event;
    },

    async insertDomain(input) {
      const now = new Date();
      const domain = {
        id: `domain_${domains.length + 1}`,
        organizationId: input.organizationId,
        domainClaimId: input.domainClaimId,
        domain: input.domain,
        status: input.status,
        providerAdapter: input.providerAdapter,
        dnsStatusJson: input.dnsStatusJson,
        authStatusJson: input.authStatusJson,
        metadataJson: input.metadataJson,
        createdAt: now,
        updatedAt: now,
      } satisfies MailDomain;
      domains.push(domain);
      return domain;
    },

    async insertKeyRef(input) {
      const now = new Date();
      const keyRef = {
        id: `key_ref_${keyRefs.length + 1}`,
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        mailboxId: input.mailboxId ?? null,
        keyScope: input.keyScope,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        keyVersion: input.keyVersion ?? 1,
        algorithm: input.algorithm,
        wrappedKeyRef: input.wrappedKeyRef,
        aadHash: input.aadHash ?? null,
        status: input.status ?? "active",
        metadataJson: input.metadataJson ?? {},
        createdAt: now,
        updatedAt: now,
      } satisfies MailKeyRef;
      keyRefs.push(keyRef);
      return keyRef;
    },

    async insertMailbox(input) {
      const now = new Date();
      const mailbox = {
        id: `mailbox_${mailboxes.length + 1}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        agentId: input.agentId,
        localPart: input.localPart,
        domainId: input.domainId,
        address: input.address,
        status: "active",
        defaultVisibility: input.defaultVisibility,
        keyScope: input.keyScope,
        createdByUserId: input.createdByUserId,
        metadataJson: input.metadataJson,
        createdAt: now,
        updatedAt: now,
      } satisfies Mailbox;
      mailboxes.push(mailbox);
      return mailbox;
    },

    async insertMessage(input) {
      const now = new Date();
      const message = {
        id: input.id ?? `message_${messages.length + 1}`,
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        mailboxId: input.mailboxId,
        threadId: input.threadId ?? null,
        direction: input.direction,
        providerAdapter: input.providerAdapter,
        providerMessageRefHash: input.providerMessageRefHash ?? null,
        internetMessageIdHash: input.internetMessageIdHash ?? null,
        fromHash: input.fromHash ?? null,
        toHashesJson: input.toHashesJson ?? [],
        subjectCipherRef: input.subjectCipherRef ?? null,
        rawMimeCipherRef: input.rawMimeCipherRef,
        parsedBodyCipherRef: input.parsedBodyCipherRef ?? null,
        addressSummaryCipherRef: input.addressSummaryCipherRef ?? null,
        headersCipherRef: input.headersCipherRef,
        status: input.status ?? "received",
        sizeBytes: input.sizeBytes ?? null,
        receivedAt: input.receivedAt ?? null,
        sentAt: input.sentAt ?? null,
        metadataJson: input.metadataJson ?? {},
        createdAt: now,
        updatedAt: now,
      } satisfies MailMessage;
      messages.push(message);
      return message;
    },

    async insertRoute(input) {
      const now = new Date();
      const route = {
        id: `route_${routes.length + 1}`,
        organizationId: input.organizationId,
        domainId: input.domainId,
        mailboxId: input.mailboxId,
        matchType: input.matchType,
        pattern: input.pattern,
        action: input.action,
        priority: input.priority,
        status: input.status,
        policyJson: input.policyJson,
        createdAt: now,
        updatedAt: now,
      } satisfies MailRoute;
      routes.push(route);
      return route;
    },

    async insertThread(input: InsertMailThreadInput) {
      const now = new Date();
      const thread = {
        id: `thread_${threads.length + 1}`,
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        mailboxId: input.mailboxId,
        contactId: input.contactId ?? null,
        subjectCipherRef: input.subjectCipherRef ?? null,
        normalizedSubjectHash: input.normalizedSubjectHash ?? null,
        status: input.status ?? "active",
        lastMessageAt: input.lastMessageAt ?? null,
        createdAt: now,
        updatedAt: now,
      } satisfies MailThread;
      threads.push(thread);
      return thread;
    },

    async listMailboxes(input) {
      return mailboxes.filter((mailbox) => {
        if (mailbox.organizationId !== input.organizationId) return false;
        if (input.projectId !== undefined) return mailbox.projectId === input.projectId;
        return true;
      });
    },

    async updateMailboxStatus(input) {
      const mailbox = mailboxes.find(
        (candidate) => candidate.organizationId === input.organizationId && candidate.id === input.mailboxId,
      );
      if (!mailbox) return null;
      mailbox.status = input.status;
      mailbox.updatedAt = new Date();
      return mailbox;
    },
  };
}

async function seedMailbox(repository: MailStorageRepository, organizationId: string, localPart: string) {
  const domain = await createMailDomain({
    input: {
      domain: "mail.ravi.bot",
      organizationId,
      providerAdapter: "Generic",
      status: "verified",
    },
    repository,
  });

  return createMailbox({
    input: {
      domainId: domain.id,
      localPart,
      organizationId,
    },
    repository,
  });
}

function messageInput(input: {
  mailboxId: string;
  organizationId: string;
  providerMessageRefHash: string;
}): InsertMailMessageInput {
  return {
    direction: "inbound",
    headersCipherRef: cipherRef("headers"),
    mailboxId: input.mailboxId,
    organizationId: input.organizationId,
    providerAdapter: "generic",
    providerMessageRefHash: input.providerMessageRefHash,
    rawMimeCipherRef: cipherRef("raw"),
    subjectCipherRef: cipherRef("subject"),
    toHashesJson: ["hash_to"],
  };
}

function cipherRef(kind: string) {
  return {
    schemaVersion: 1,
    ciphertextRef: `object://mail/${kind}`,
    algorithm: "AES-256-GCM",
    wrappedKeyRef: `mail_key_wraps/${kind}`,
    aadHash: `aad_${kind}`,
    keyVersion: 1,
    createdAt: "2026-05-11T00:00:00.000Z",
  };
}

function mailColumnKeys(table: object) {
  return Object.keys(table).filter((key) => !key.startsWith("_"));
}
