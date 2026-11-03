import { describe, expect, mock, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  createMailConsoleMailService,
  type MailAuditEvent,
  type MailServiceRepository,
  type MailUsageEvent,
} from "./service";
import type { MailProviderAdapter, MailProviderCapabilities } from "./provider-adapters";
import type {
  InsertMailDeliveryEventInput,
  InsertMailMessageInput,
  InsertMailThreadInput,
  MailAttachment,
  MailDeliveryEvent,
  MailDomain,
  MailKeyRef,
  MailMessage,
  MailRoute,
  MailThread,
  Mailbox,
} from "./storage";

describe("Ravi Mail console service contracts", () => {
  test("keeps domain, mailbox, and route operations scoped to the actor organization", async () => {
    const repository = createInMemoryMailServiceRepository();
    const service = createService({ repository });

    await service.createDomain(actor("org_1"), {
      domain: "Mail.Ravi.Bot",
      providerAdapter: "cloudflare_email",
      status: "verified",
    });
    await service.createDomain(actor("org_2"), {
      domain: "mail.ravi.bot",
      providerAdapter: "cloudflare_email",
      status: "verified",
    });

    const org1Domains = await service.listDomains(actor("org_1"));
    expect(org1Domains).toHaveLength(1);
    expect(org1Domains[0]?.organizationId).toBe("org_1");

    const org2Domain = repository.domains.find((domain) => domain.organizationId === "org_2");
    await expect(
      service.createMailbox(actor("org_1"), {
        domainId: org2Domain?.id ?? "missing",
        localPart: "agent",
      }),
    ).rejects.toMatchObject({
      status: 409,
      payload: {
        error: "mail_address_unavailable",
      },
    });

    await expect(
      service.createRoute(actor("org_1"), {
        action: "deliver",
        domainId: org2Domain?.id ?? "missing",
        matchType: "local_part",
        pattern: "agent",
      }),
    ).rejects.toMatchObject({
      status: 404,
      payload: {
        error: "mail_resource_unavailable",
      },
    });
  });

  test("lists message metadata without touching the decrypt boundary or returning cipher payloads", async () => {
    const repository = createInMemoryMailServiceRepository();
    const decryptMessagePayload = mock(async () => "plaintext");
    const service = createService({
      repository,
      decrypter: { decryptMessagePayload },
      access: allowReadSendAccess(),
    });
    const mailbox = await seedMailbox(repository, "org_1", "agent");
    await repository.insertMessage(
      messageInput({
        mailboxId: mailbox.id,
        organizationId: "org_1",
        providerMessageRefHash: "provider_hash_1",
      }),
    );

    const messages = await service.listMessageMetadata(actor("org_1"), { mailboxId: mailbox.id });

    expect(decryptMessagePayload).not.toHaveBeenCalled();
    expect(messages).toEqual([
      expect.objectContaining({
        id: "message_1",
        mailboxId: mailbox.id,
        hasSubject: true,
        hasParsedBody: false,
      }),
    ]);
    expect(JSON.stringify(messages)).not.toContain("ciphertextRef");
    expect(JSON.stringify(messages)).not.toContain("rawMimeCipherRef");
    expect(JSON.stringify(messages)).not.toContain("subjectCipherRef");
  });

  test("decrypts one payload only through the explicit audited operation boundary", async () => {
    const repository = createInMemoryMailServiceRepository();
    const auditEvents: MailAuditEvent[] = [];
    const decryptMessagePayload = mock(async () => "Decrypted subject");
    const service = createService({
      repository,
      audit: {
        async record(event) {
          auditEvents.push(event);
        },
      },
      decrypter: { decryptMessagePayload },
      access: allowReadSendAccess(),
    });
    const mailbox = await seedMailbox(repository, "org_1", "agent");
    const message = await repository.insertMessage(
      messageInput({
        mailboxId: mailbox.id,
        organizationId: "org_1",
        providerMessageRefHash: "provider_hash_1",
      }),
    );

    const decrypted = await service.decryptMessagePayload(actor("org_1"), {
      messageId: message.id,
      payloadKind: "subject",
    });

    expect(decrypted).toEqual({
      messageId: message.id,
      payloadKind: "subject",
      plaintext: "Decrypted subject",
    });
    expect(decryptMessagePayload).toHaveBeenCalledTimes(1);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        operation: "mail.message.decrypt",
        organizationId: "org_1",
        actorId: "actor_1",
        resourceId: message.id,
      }),
    ]);

    const deniedDecrypter = mock(async () => "should not happen");
    const deniedService = createService({
      repository,
      decrypter: { decryptMessagePayload: deniedDecrypter },
      access: {
        ...allowReadSendAccess(),
        async canReadMailbox() {
          return false;
        },
      },
    });

    await expect(
      deniedService.decryptMessagePayload(actor("org_1"), {
        messageId: message.id,
        payloadKind: "subject",
      }),
    ).rejects.toMatchObject({
      status: 403,
      payload: {
        error: "mail_operation_denied",
      },
    });
    expect(deniedDecrypter).not.toHaveBeenCalled();
  });

  test("lists attachment metadata through read access and audits filename decrypt", async () => {
    const repository = createInMemoryMailServiceRepository();
    const auditEvents: MailAuditEvent[] = [];
    const decryptMessagePayload = mock(async () => "contrato.pdf");
    const service = createService({
      repository,
      audit: {
        async record(event) {
          auditEvents.push(event);
        },
      },
      decrypter: { decryptMessagePayload },
      access: allowReadSendAccess(),
    });
    const mailbox = await seedMailbox(repository, "org_1", "agent");
    const message = await repository.insertMessage(
      messageInput({
        mailboxId: mailbox.id,
        organizationId: "org_1",
        providerMessageRefHash: "provider_hash_1",
      }),
    );
    await repository.insertAttachment({
      organizationId: "org_1",
      projectId: null,
      mailboxId: mailbox.id,
      messageId: message.id,
      filenameCipherRef: cipherRef("attachment_filename"),
      objectCipherRef: cipherRef("attachment_object"),
      contentType: "application/pdf",
      sizeBytes: 1234,
      sha256: "sha256:attachment",
      status: "unscanned",
      metadataJson: {
        parserAttachmentId: `${message.id}:attachment:1`,
      },
    });

    const attachments = await service.listMessageAttachments(actor("org_1"), { messageId: message.id });

    expect(attachments).toEqual([
      expect.objectContaining({
        filename: "contrato.pdf",
        hasEncryptedObject: true,
        id: "attachment_1",
        messageId: message.id,
      }),
    ]);
    expect(JSON.stringify(attachments)).not.toContain("objectCipherRef");
    expect(JSON.stringify(attachments)).not.toContain("filenameCipherRef");
    expect(decryptMessagePayload).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: `${message.id}:attachment:1`,
        payloadKind: "attachment_filename",
      }),
    );
    expect(auditEvents.map((event) => event.operation)).toEqual([
      "mail.attachment.list",
      "mail.message.decrypt",
    ]);
    expect(auditEvents[1]).toMatchObject({
      metadata: {
        attachmentCount: 1,
        payloadKind: "attachment_filename",
      },
      resourceId: message.id,
      resourceType: "mail_message",
    });
  });

  test("disables a mailbox, its active routes, and the provider rule idempotently", async () => {
    const repository = createInMemoryMailServiceRepository();
    const auditEvents: MailAuditEvent[] = [];
    const ensureMailboxRule = mock(async () => {});
    const deleteMailboxRule = mock(async () => {});
    const service = createService({
      repository,
      audit: {
        async record(event) {
          auditEvents.push(event);
        },
      },
      inboundProvider: {
        ensureMailboxRule,
        deleteMailboxRule,
      },
    });
    const domain = await service.createDomain(actor("org_1"), {
      domain: "mail.ravi.bot",
      providerAdapter: "cloudflare_email",
      status: "verified",
    });
    const mailbox = await service.createMailbox(actor("org_1"), {
      domainId: domain.id,
      localPart: "teste",
    });
    expect(ensureMailboxRule).toHaveBeenCalledWith({
      address: mailbox.address,
      domain: domain.domain,
      mailboxId: mailbox.id,
    });
    const route = await service.createRoute(actor("org_1"), {
      action: "deliver",
      domainId: domain.id,
      mailboxId: mailbox.id,
      matchType: "local_part",
      pattern: mailbox.localPart,
      priority: 100,
    });

    const result = await service.disableMailbox(actor("org_1"), { mailboxId: mailbox.id });

    expect(result.mailbox.status).toBe("disabled");
    expect(result.disabledRoutes).toEqual([expect.objectContaining({ id: route.id, status: "disabled" })]);
    expect(result.providerSynced).toBe(true);
    expect(deleteMailboxRule).toHaveBeenCalledWith({
      address: mailbox.address,
      domain: domain.domain,
      mailboxId: mailbox.id,
    });
    expect(repository.mailboxes).toHaveLength(1);
    expect(repository.messages).toHaveLength(0);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        operation: "mail.mailbox.disable",
        resourceId: mailbox.id,
        metadata: {
          disabledRouteCount: 1,
          providerSynced: true,
        },
      }),
    );

    const repeated = await service.disableMailbox(actor("org_1"), { mailboxId: mailbox.id });

    expect(repeated.mailbox.status).toBe("disabled");
    expect(repeated.disabledRoutes).toEqual([]);
    expect(deleteMailboxRule).toHaveBeenCalledTimes(2);
  });

  test("keeps customer-managed mail domain routing at the domain binding layer", async () => {
    const repository = createInMemoryMailServiceRepository();
    const ensureMailboxRule = mock(async () => {});
    const deleteMailboxRule = mock(async () => {});
    const service = createService({
      repository,
      inboundProvider: {
        ensureMailboxRule,
        deleteMailboxRule,
      },
    });
    const domain = await service.createDomain(actor("org_1"), {
      domain: "customer.example",
      providerAdapter: "cloudflare_email",
      status: "pending",
      authStatusJson: {
        mode: "customer_managed",
        ownershipStatus: "verified",
      },
      metadataJson: {
        managed: false,
        ownershipMode: "customer_managed",
        providerMode: "ravi_managed_delegated_cloudflare",
      },
    });

    const mailbox = await service.createMailbox(actor("org_1"), {
      domainId: domain.id,
      localPart: "support",
    });
    const result = await service.disableMailbox(actor("org_1"), { mailboxId: mailbox.id });

    expect(mailbox.address).toBe("support@customer.example");
    expect(ensureMailboxRule).not.toHaveBeenCalled();
    expect(deleteMailboxRule).not.toHaveBeenCalled();
    expect(result.providerSynced).toBe(false);
  });

  test("denies mailbox disable without mailbox manage access", async () => {
    const repository = createInMemoryMailServiceRepository();
    const service = createService({ repository });
    const domain = await service.createDomain(actor("org_1"), {
      domain: "mail.ravi.bot",
      providerAdapter: "cloudflare_email",
      status: "verified",
    });
    const mailbox = await service.createMailbox(actor("org_1"), {
      domainId: domain.id,
      localPart: "teste",
    });
    const deniedService = createService({
      repository,
      access: {
        ...allowReadSendAccess(),
        async canManageMailbox() {
          return false;
        },
      },
    });

    await expect(deniedService.disableMailbox(actor("org_1"), { mailboxId: mailbox.id })).rejects.toMatchObject({
      status: 403,
      payload: {
        error: "mail_operation_denied",
      },
    });
  });

  test("sends from the default mailbox or an explicit mailbox through provider contracts", async () => {
    const repository = createInMemoryMailServiceRepository();
    const auditEvents: MailAuditEvent[] = [];
    const usageEvents: MailUsageEvent[] = [];
    const sentRequests: unknown[] = [];
    const adapter = fakeAdapter({
      async sendOutbound(request) {
        sentRequests.push(request);
        return {
          providerAdapter: "cloudflare_email",
          providerMessageRefHash: `provider_hash_${sentRequests.length}`,
          acceptedAt: "2026-05-11T03:00:00.000Z",
        };
      },
    });
    const service = createService({
      repository,
      adapters: new Map([[adapter.name, adapter]]),
      audit: {
        async record(event) {
          auditEvents.push(event);
        },
      },
      usage: {
        async emit(event) {
          usageEvents.push(event);
        },
      },
      access: {
        ...allowReadSendAccess(),
        async resolveDefaultSendMailbox() {
          return "mailbox_1";
        },
      },
      now: () => new Date("2026-05-11T03:00:00.000Z"),
      messageIdFactory: () => `draft_${sentRequests.length + 1}`,
    });

    const domain = await service.createDomain(actor("org_1"), {
      domain: "mail.ravi.bot",
      providerAdapter: "cloudflare_email",
      status: "verified",
    });
    const defaultMailbox = await service.createMailbox(actor("org_1"), {
      domainId: domain.id,
      localPart: "agent",
    });
    const explicitMailbox = await service.createMailbox(actor("org_1"), {
      domainId: domain.id,
      localPart: "finance",
    });

    const defaultSend = await service.sendOutbound(actor("org_1"), outboundInput());
    const explicitSend = await service.sendOutbound(
      actor("org_1"),
      outboundInput({
        fromMailboxId: explicitMailbox.id,
        idempotencyKey: "idem_explicit",
        to: ["finance@example.com"],
      }),
    );

    expect(defaultSend.message).toMatchObject({
      direction: "outbound",
      mailboxId: defaultMailbox.id,
      status: "sent",
    });
    expect(explicitSend.message).toMatchObject({
      direction: "outbound",
      mailboxId: explicitMailbox.id,
      status: "sent",
    });
    expect(sentRequests).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ address: "agent@mail.ravi.bot" }),
        to: ["lead@example.com"],
      }),
      expect.objectContaining({
        from: expect.objectContaining({ address: "finance@mail.ravi.bot" }),
        to: ["finance@example.com"],
      }),
    ]);
    expect(repository.messages).toHaveLength(2);
    expect(repository.deliveryEvents).toHaveLength(2);
    expect(auditEvents.map((event) => event.operation)).toEqual(["mail.domain.create", "mail.mailbox.create", "mail.mailbox.create", "mail.message.send", "mail.message.send"]);
    expect(usageEvents).toEqual([
      expect.objectContaining({ metric: "mail.messages.outbound", quantity: 1 }),
      expect.objectContaining({ metric: "mail.recipients.outbound", quantity: 1 }),
      expect.objectContaining({ metric: "mail.bytes.outbound", quantity: 4096 }),
      expect.objectContaining({ metric: "mail.messages.outbound", quantity: 1 }),
      expect.objectContaining({ metric: "mail.recipients.outbound", quantity: 1 }),
      expect.objectContaining({ metric: "mail.bytes.outbound", quantity: 4096 }),
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain("lead@example.com");
  });
});

function createService(overrides: Partial<Parameters<typeof createMailConsoleMailService>[0]> = {}) {
  const repository = overrides.repository ?? createInMemoryMailServiceRepository();
  const adapter = fakeAdapter();

  return createMailConsoleMailService({
    repository,
    access: allowReadSendAccess(),
    decrypter: {
      async decryptMessagePayload() {
        return "plaintext";
      },
    },
    adapters: new Map([[adapter.name, adapter]]),
    audit: {
      async record() {},
    },
    usage: {
      async emit() {},
    },
    now: () => new Date("2026-05-11T03:00:00.000Z"),
    messageIdFactory: () => "draft_message_1",
    ...overrides,
  });
}

function allowReadSendAccess() {
  return {
    async canManageMailbox() {
      return true;
    },
    async canReadMailbox() {
      return true;
    },
    async canSendFromMailbox() {
      return true;
    },
    async resolveDefaultSendMailbox() {
      return null;
    },
  };
}

function actor(organizationId: string) {
  return {
    actorId: "actor_1",
    organizationId,
  };
}

function createInMemoryMailServiceRepository(): MailServiceRepository & {
  attachments: MailAttachment[];
  deliveryEvents: MailDeliveryEvent[];
  domains: MailDomain[];
  mailboxes: Mailbox[];
  messages: MailMessage[];
} {
  const projects = [{ id: "proj_1", organizationId: "org_1" }];
  const domains: MailDomain[] = [];
  const mailboxes: Mailbox[] = [];
  const routes: MailRoute[] = [];
  const threads: MailThread[] = [];
  const messages: MailMessage[] = [];
  const attachments: MailAttachment[] = [];
  const deliveryEvents: MailDeliveryEvent[] = [];
  const keyRefs: MailKeyRef[] = [];

  return {
    deliveryEvents,
    domains,
    attachments,
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
          route.updatedAt = new Date("2026-05-11T03:00:00.000Z");
          disabledRoutes.push(route);
        }
      }
      return disabledRoutes;
    },

    async findDomainById(input) {
      return domains.find((domain) => domain.organizationId === input.organizationId && domain.id === input.domainId) ?? null;
    },

    async findDomainByName(input) {
      return domains.find((domain) => domain.organizationId === input.organizationId && domain.domain === input.domain) ?? null;
    },

    async findMailboxByAddress(input) {
      return mailboxes.find((mailbox) => mailbox.organizationId === input.organizationId && mailbox.address === input.address) ?? null;
    },

    async findMailboxById(input) {
      return mailboxes.find((mailbox) => mailbox.organizationId === input.organizationId && mailbox.id === input.mailboxId) ?? null;
    },

    async findMessageById(input) {
      return messages.find((message) => message.organizationId === input.organizationId && message.id === input.messageId) ?? null;
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
      return projects.find((project) => project.organizationId === input.organizationId && project.id === input.projectId) ?? null;
    },

    async findThreadById(input) {
      return threads.find((thread) => thread.organizationId === input.organizationId && thread.id === input.threadId) ?? null;
    },

    async listAttachmentsForMessage(input) {
      return attachments.filter(
        (attachment) =>
          attachment.organizationId === input.organizationId && attachment.messageId === input.messageId,
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
        createdAt: new Date("2026-05-11T03:00:00.000Z"),
      } satisfies MailAttachment;
      attachments.push(attachment);
      return attachment;
    },

    async insertDeliveryEvent(input: InsertMailDeliveryEventInput) {
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
        createdAt: new Date("2026-05-11T03:00:00.000Z"),
      } satisfies MailDeliveryEvent;
      deliveryEvents.push(event);
      return event;
    },

    async insertDomain(input) {
      const now = new Date("2026-05-11T03:00:00.000Z");
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
      const now = new Date("2026-05-11T03:00:00.000Z");
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
      const now = new Date("2026-05-11T03:00:00.000Z");
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
      const now = new Date("2026-05-11T03:00:00.000Z");
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
      const now = new Date("2026-05-11T03:00:00.000Z");
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
      const now = new Date("2026-05-11T03:00:00.000Z");
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

    async listDomains(input) {
      return domains.filter((domain) => domain.organizationId === input.organizationId);
    },

    async listMailboxes(input) {
      return mailboxes.filter((mailbox) => {
        if (mailbox.organizationId !== input.organizationId) return false;
        if (input.projectId !== undefined) return mailbox.projectId === input.projectId;
        return true;
      });
    },

    async listMessages(input) {
      return messages
        .filter((message) => {
          if (message.organizationId !== input.organizationId) return false;
          if (input.mailboxId && message.mailboxId !== input.mailboxId) return false;
          return true;
        })
        .slice(0, input.limit ?? 50);
    },

    async updateMailboxStatus(input) {
      const mailbox = mailboxes.find(
        (candidate) => candidate.organizationId === input.organizationId && candidate.id === input.mailboxId,
      );
      if (!mailbox) return null;
      mailbox.status = input.status;
      mailbox.updatedAt = new Date("2026-05-11T03:00:00.000Z");
      return mailbox;
    },
  };
}

async function seedMailbox(repository: MailServiceRepository, organizationId: string, localPart: string) {
  const service = createService({ repository });
  const domain = await service.createDomain(actor(organizationId), {
    domain: "mail.ravi.bot",
    providerAdapter: "cloudflare_email",
    status: "verified",
  });

  return service.createMailbox(actor(organizationId), {
    domainId: domain.id,
    localPart,
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
    providerAdapter: "cloudflare_email",
    providerMessageRefHash: input.providerMessageRefHash,
    rawMimeCipherRef: cipherRef("raw_mime"),
    subjectCipherRef: cipherRef("subject"),
    toHashesJson: ["hash_to"],
  };
}

function outboundInput(overrides: Partial<Parameters<ReturnType<typeof createMailConsoleMailService>["sendOutbound"]>[1]> = {}) {
  return {
    to: ["lead@example.com"],
    rawMimeCipherRef: cipherRef("raw_mime"),
    headersCipherRef: cipherRef("headers"),
    subjectCipherRef: cipherRef("subject"),
    sizeBytes: 4096,
    idempotencyKey: "idem_default",
    ...overrides,
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

function fakeAdapter(overrides: Partial<MailProviderAdapter> = {}): MailProviderAdapter {
  return {
    name: "cloudflare_email",
    capabilities: capabilities(),
    async sendOutbound() {
      return {
        providerAdapter: "cloudflare_email",
        providerMessageRefHash: "provider_hash_1",
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
