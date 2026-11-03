import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { buildMailMessageReceivedInboxItem } from "@/server/console/agent-inbox";
import {
  authorizeMailInternalRequest,
  ingestEncryptedInboundMail,
  resolveMailInternalRoute,
  type MailInternalAuditEvent,
  type MailInternalDomain,
  type MailInternalInsertInboundMessage,
  type MailInternalAttachmentInput,
  type MailInternalMailbox,
  type MailInternalMessage,
  type MailInternalRepository,
  type MailInternalRoute,
  type MailInternalUsageEvent,
} from "./internal-api";

describe("Ravi Mail internal Worker boundary", () => {
  test("requires a bearer control token", () => {
    const url = "https://console.ravi.bot/api/internal/mail/routes/resolve";
    const valid = new Request(url, { headers: { authorization: "Bearer mail-control-token" } });
    const missing = new Request(url);
    const invalid = new Request(url, { headers: { authorization: "Bearer different-token" } });

    expect(authorizeMailInternalRequest(valid, "mail-control-token")).toBe(true);
    expect(authorizeMailInternalRequest(missing, "mail-control-token")).toBe(false);
    expect(authorizeMailInternalRequest(invalid, "mail-control-token")).toBe(false);
    expect(authorizeMailInternalRequest(valid, null)).toBe(false);
  });

  test("returns a coarse drop when no route is found", async () => {
    const repository = createInMemoryMailInternalRepository();

    const response = await resolveMailInternalRoute({
      input: {
        sender: "customer@example.com",
        recipient: "missing@mail.ravi.bot",
        rawSize: 512,
        requestId: "req_route_missing",
      },
      repository,
    });

    expect(response).toEqual({
      status: "drop",
      action: "drop",
      code: "route_not_found",
      requestId: "req_route_missing",
    });
  });

  test("accepts a matched deliver route with organization, mailbox, project, route, and message ids", async () => {
    const repository = createInMemoryMailInternalRepository();
    repository.domains.push(domain({ id: "domain_1", organizationId: "org_1" }));
    repository.mailboxes.push(mailbox({ id: "mailbox_1", organizationId: "org_1", projectId: "project_1" }));
    repository.routes.push(
      route({
        id: "route_1",
        organizationId: "org_1",
        domainId: "domain_1",
        mailboxId: "mailbox_1",
        matchType: "exact",
        pattern: "agent@mail.ravi.bot",
      }),
    );

    const response = await resolveMailInternalRoute({
      input: {
        sender: "customer@example.com",
        recipient: "agent@mail.ravi.bot",
        rawSize: 2048,
        requestId: "req_route_accept",
      },
      repository,
    });

    expect(response).toMatchObject({
      status: "accept",
      action: "deliver",
      requestId: "req_route_accept",
      organizationId: "org_1",
      projectId: "project_1",
      mailboxId: "mailbox_1",
      routeId: "route_1",
    });
    expect(response.status === "accept" ? response.messageId : null).toBeString();
  });

  test("rejects plaintext fields on encrypted inbound ingest", async () => {
    const repository = createInMemoryMailInternalRepository();
    repository.mailboxes.push(mailbox({ id: "mailbox_1", organizationId: "org_1" }));

    await expect(
      ingestEncryptedInboundMail({
        input: {
          ...encryptedIngestInput(),
          subject: "plaintext subject",
        } as Parameters<typeof ingestEncryptedInboundMail>[0]["input"],
        repository,
      }),
    ).rejects.toBeInstanceOf(ConsoleApiError);

    await expect(
      ingestEncryptedInboundMail({
        input: {
          ...encryptedIngestInput({ providerMessageRefHash: "provider_hash_2" }),
          metadataJson: { sender: "customer@example.com" },
        },
        repository,
      }),
    ).rejects.toBeInstanceOf(ConsoleApiError);

    expect(repository.messages).toHaveLength(0);
  });

  test("rejects attachment metadata that tries to smuggle plaintext content", async () => {
    const repository = createInMemoryMailInternalRepository();
    repository.mailboxes.push(mailbox({ id: "mailbox_1", organizationId: "org_1" }));

    await expect(
      ingestEncryptedInboundMail({
        input: encryptedIngestInput({
          attachments: [
            {
              ...attachmentInput("attachment_1"),
              metadataJson: { content: "raw attachment body" },
            },
          ],
        }),
        repository,
      }),
    ).rejects.toBeInstanceOf(ConsoleApiError);

    expect(repository.messages).toHaveLength(0);
  });

  test("persists encrypted inbound metadata inside the organization scope", async () => {
    const repository = createInMemoryMailInternalRepository();
    const auditEvents: MailInternalAuditEvent[] = [];
    const inboxEvents: unknown[] = [];
    const usageEvents: MailInternalUsageEvent[] = [];
    repository.mailboxes.push(mailbox({ id: "mailbox_1", organizationId: "org_1", projectId: "project_1" }));
    repository.mailboxes.push(mailbox({ id: "mailbox_2", organizationId: "org_2", projectId: "project_2" }));
    repository.routes.push(
      route({
        id: "route_1",
        organizationId: "org_1",
        domainId: "domain_1",
        mailboxId: "mailbox_1",
        pattern: "agent@mail.ravi.bot",
      }),
    );

    const response = await ingestEncryptedInboundMail({
      input: encryptedIngestInput({
        messageId: "message_1",
        routeId: "route_1",
        sizeBytes: 4096,
      }),
      hooks: {
        audit: (event) => {
          auditEvents.push(event);
        },
        usage: (event) => {
          usageEvents.push(event);
        },
        inbox: (event) => {
          inboxEvents.push(event);
        },
      },
      repository,
    });

    expect(response).toEqual({
      status: "ok",
      created: true,
      requestId: "req_ingest",
      organizationId: "org_1",
      projectId: "project_1",
      mailboxId: "mailbox_1",
      routeId: "route_1",
      messageId: "message_1",
    });
    expect(repository.messages).toHaveLength(1);
    expect(repository.messages[0]).toMatchObject({
      id: "message_1",
      organizationId: "org_1",
      projectId: "project_1",
      mailboxId: "mailbox_1",
      providerAdapter: "cloudflare_email",
      providerMessageRefHash: "provider_hash_1",
      internetMessageIdHash: "internet_hash_1",
      fromHash: "from_hash_1",
      toHashesJson: ["to_hash_1"],
      rawMimeCipherRef: cipherRef("raw"),
      headersCipherRef: cipherRef("headers"),
    });
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "mail.message.ingest",
        organizationId: "org_1",
        mailboxId: "mailbox_1",
        messageId: "message_1",
        status: "created",
      }),
    ]);
    expect(usageEvents.map((event) => event.metric).sort()).toEqual(["mail.bytes.inbound", "mail.messages.inbound"]);
    expect(inboxEvents).toEqual([]);

    await expect(
      ingestEncryptedInboundMail({
        input: encryptedIngestInput({
          organizationId: "org_1",
          mailboxId: "mailbox_2",
          messageId: "message_cross_org",
          providerMessageRefHash: "provider_hash_cross_org",
        }),
        repository,
      }),
    ).rejects.toBeInstanceOf(ConsoleApiError);
    expect(repository.messages).toHaveLength(1);
  });

  test("resolves a concurrent provider-ref insert conflict to the canonical message", async () => {
    const repository = createInMemoryMailInternalRepository();
    const auditEvents: MailInternalAuditEvent[] = [];
    const usageEvents: MailInternalUsageEvent[] = [];
    repository.mailboxes.push(mailbox({ id: "mailbox_1", organizationId: "org_1", projectId: "project_1" }));
    repository.routes.push(
      route({
        id: "route_1",
        organizationId: "org_1",
        domainId: "domain_1",
        mailboxId: "mailbox_1",
      }),
    );

    const canonical: MailInternalMessage = {
      id: "message_canonical",
      organizationId: "org_1",
      projectId: "project_1",
      mailboxId: "mailbox_1",
      providerAdapter: "cloudflare_email",
      providerMessageRefHash: "provider_hash_1",
    };
    let providerLookupCount = 0;
    repository.findMessageByProviderRef = async () => {
      providerLookupCount += 1;
      return providerLookupCount === 1 ? null : canonical;
    };
    repository.insertInboundMessage = async () => null;

    const response = await ingestEncryptedInboundMail({
      input: encryptedIngestInput({
        messageId: "message_temporary",
        projectId: "project_1",
        routeId: "route_1",
      }),
      hooks: {
        audit: (event) => {
          auditEvents.push(event);
        },
        usage: (event) => {
          usageEvents.push(event);
        },
      },
      repository,
    });

    expect(response).toMatchObject({
      created: false,
      messageId: "message_canonical",
      status: "ok",
    });
    expect(providerLookupCount).toBe(2);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        messageId: "message_canonical",
        status: "duplicate",
      }),
    ]);
    expect(usageEvents).toEqual([]);
  });

  test("updates parsed cipher refs idempotently when parse jobs replay", async () => {
    const repository = createInMemoryMailInternalRepository();
    const inboxEvents: unknown[] = [];
    repository.mailboxes.push(mailbox({ id: "mailbox_1", organizationId: "org_1", projectId: "project_1" }));
    repository.routes.push(
      route({
        id: "route_1",
        organizationId: "org_1",
        domainId: "domain_1",
        mailboxId: "mailbox_1",
        pattern: "agent@mail.ravi.bot",
      }),
    );

    await ingestEncryptedInboundMail({
      input: encryptedIngestInput({
        messageId: "message_1",
        routeId: "route_1",
        subjectCipherRef: null,
        parsedBodyCipherRef: null,
      }),
      repository,
    });

    const parsed = await ingestEncryptedInboundMail({
      input: encryptedIngestInput({
        messageId: "message_1",
        routeId: "route_1",
        providerMessageRefHash: "provider_hash_1",
        subjectCipherRef: cipherRef("subject_parsed"),
        headersCipherRef: cipherRef("headers_parsed"),
        parsedBodyCipherRef: cipherRef("body_parsed"),
        attachments: [attachmentInput("attachment_1")],
        metadataJson: {
          parse: { status: "ok" },
          guardrail: {
            provider: "model_armor",
            delivery: "deliver",
            content: { status: "disabled" },
          },
        },
      }),
      hooks: {
        inbox: (event) => {
          inboxEvents.push(event);
        },
      },
      repository,
    });

    expect(parsed).toMatchObject({
      status: "ok",
      created: false,
      messageId: "message_1",
    });
    expect(repository.messages).toHaveLength(1);
    expect(repository.messages[0]).toMatchObject({
      subjectCipherRef: cipherRef("subject_parsed"),
      headersCipherRef: cipherRef("headers_parsed"),
      parsedBodyCipherRef: cipherRef("body_parsed"),
      metadataJson: {
        parse: { status: "ok" },
        guardrail: {
          provider: "model_armor",
          delivery: "deliver",
          content: { status: "disabled" },
        },
      },
    });
    expect(inboxEvents).toHaveLength(1);
    expect(repository.attachments).toEqual([
      expect.objectContaining({
        attachmentId: "attachment_1",
        messageId: "message_1",
        filenameCipherRef: cipherRef("attachment_1_filename"),
        objectCipherRef: cipherRef("attachment_1_object"),
        contentType: "application/pdf",
        sizeBytes: 1234,
        sha256: "sha256:attachment_1",
      }),
    ]);

    await ingestEncryptedInboundMail({
      input: encryptedIngestInput({
        messageId: "message_1",
        routeId: "route_1",
        providerMessageRefHash: "provider_hash_1",
        subjectCipherRef: cipherRef("subject_parsed_2"),
        headersCipherRef: cipherRef("headers_parsed_2"),
        parsedBodyCipherRef: cipherRef("body_parsed_2"),
        attachments: [attachmentInput("attachment_2")],
      }),
      repository,
    });
    expect(repository.attachments).toEqual([
      expect.objectContaining({
        attachmentId: "attachment_2",
        messageId: "message_1",
      }),
    ]);
    expect(buildMailMessageReceivedInboxItem(inboxEvents[0] as Parameters<typeof buildMailMessageReceivedInboxItem>[0]))
      .toMatchObject({
        dedupeKey: "mail:message:org_1:message_1:received",
        eventType: "mail.message.received",
        organizationId: "org_1",
        payloadJson: expect.objectContaining({
          direction: "inbound",
          mailboxAddress: "agent@mail.ravi.bot",
          mailboxId: "mailbox_1",
          messageId: "message_1",
          receivedAt: "2026-05-11T12:00:00.000Z",
          status: "received",
        }),
        sensitivity: "restricted",
        sourceId: "message_1",
        sourceType: "mail_message",
        targetId: "mailbox_1",
        targetType: "mailbox",
      });
  });

  test("suppresses inbox delivery when parsed ingest is quarantined by guardrail", async () => {
    const repository = createInMemoryMailInternalRepository();
    const inboxEvents: unknown[] = [];
    repository.mailboxes.push(mailbox({ id: "mailbox_1", organizationId: "org_1", projectId: "project_1" }));
    repository.routes.push(
      route({
        id: "route_1",
        organizationId: "org_1",
        domainId: "domain_1",
        mailboxId: "mailbox_1",
        pattern: "agent@mail.ravi.bot",
      }),
    );

    await ingestEncryptedInboundMail({
      input: encryptedIngestInput({
        messageId: "message_1",
        routeId: "route_1",
        subjectCipherRef: null,
        parsedBodyCipherRef: null,
      }),
      repository,
    });

    await ingestEncryptedInboundMail({
      input: encryptedIngestInput({
        messageId: "message_1",
        routeId: "route_1",
        providerMessageRefHash: "provider_hash_1",
        subjectCipherRef: cipherRef("subject_parsed"),
        headersCipherRef: cipherRef("headers_parsed"),
        parsedBodyCipherRef: cipherRef("body_parsed"),
        metadataJson: {
          parse: { status: "ok" },
          guardrail: { provider: "model_armor", delivery: "quarantine" },
        },
      }),
      hooks: {
        inbox: (event) => {
          inboxEvents.push(event);
        },
      },
      repository,
    });

    expect(inboxEvents).toEqual([]);
  });

  test("emits inbox metadata on duplicate ingest replay after a previous hook failure", async () => {
    const repository = createInMemoryMailInternalRepository();
    const inboxEvents: unknown[] = [];
    repository.mailboxes.push(mailbox({ id: "mailbox_1", organizationId: "org_1", projectId: "project_1" }));
    repository.routes.push(
      route({
        id: "route_1",
        organizationId: "org_1",
        domainId: "domain_1",
        mailboxId: "mailbox_1",
        pattern: "agent@mail.ravi.bot",
      }),
    );

    await expect(
      ingestEncryptedInboundMail({
        input: encryptedIngestInput({
          messageId: "message_1",
          routeId: "route_1",
          parsedBodyCipherRef: cipherRef("body_parsed"),
        }),
        hooks: {
          inbox: () => {
            throw new Error("inbox unavailable");
          },
        },
        repository,
      }),
    ).rejects.toThrow("inbox unavailable");
    expect(repository.messages).toHaveLength(1);

    const replay = await ingestEncryptedInboundMail({
      input: encryptedIngestInput({
        messageId: "message_1",
        routeId: "route_1",
        parsedBodyCipherRef: cipherRef("body_parsed"),
      }),
      hooks: {
        inbox: (event) => {
          inboxEvents.push(event);
        },
      },
      repository,
    });

    expect(replay).toMatchObject({ created: false, messageId: "message_1" });
    expect(inboxEvents).toEqual([
      expect.objectContaining({
        mailboxAddress: "agent@mail.ravi.bot",
        messageId: "message_1",
        organizationId: "org_1",
        providerAdapter: "cloudflare_email",
      }),
    ]);
  });
});

function createInMemoryMailInternalRepository(): MailInternalRepository & {
  domains: MailInternalDomain[];
  mailboxes: MailInternalMailbox[];
  messages: Array<MailInternalMessage & MailInternalInsertInboundMessage>;
  attachments: Array<MailInternalAttachmentInput & { mailboxId: string; messageId: string; organizationId: string; projectId: string | null }>;
  routes: MailInternalRoute[];
} {
  const domains: MailInternalDomain[] = [];
  const mailboxes: MailInternalMailbox[] = [];
  const messages: Array<MailInternalMessage & MailInternalInsertInboundMessage> = [];
  const attachments: Array<MailInternalAttachmentInput & { mailboxId: string; messageId: string; organizationId: string; projectId: string | null }> = [];
  const routes: MailInternalRoute[] = [];

  return {
    domains,
    mailboxes,
    messages,
    attachments,
    routes,

    async findActiveDomainsByName(inputDomain) {
      return domains.filter((candidate) => candidate.domain === inputDomain && candidate.status === "verified");
    },

    async findMailboxById(input) {
      return (
        mailboxes.find(
          (candidate) => candidate.organizationId === input.organizationId && candidate.id === input.mailboxId,
        ) ?? null
      );
    },

    async findMessageByProviderRef(input) {
      return (
        messages.find(
          (candidate) =>
            candidate.organizationId === input.organizationId &&
            candidate.providerAdapter === input.providerAdapter &&
            candidate.providerMessageRefHash === input.providerMessageRefHash,
        ) ?? null
      );
    },

    async findMessageById(input) {
      return (
        messages.find(
          (candidate) => candidate.organizationId === input.organizationId && candidate.id === input.messageId,
        ) ?? null
      );
    },

    async findRouteById(input) {
      return (
        routes.find((candidate) => candidate.organizationId === input.organizationId && candidate.id === input.routeId) ??
        null
      );
    },

    async insertInboundMessage(input) {
      messages.push(input);
      return input;
    },

    async replaceMessageAttachments(input) {
      for (let index = attachments.length - 1; index >= 0; index -= 1) {
        const attachment = attachments[index];
        if (attachment?.organizationId === input.organizationId && attachment.messageId === input.messageId) {
          attachments.splice(index, 1);
        }
      }
      attachments.push(
        ...input.attachments.map((attachment) => ({
          ...attachment,
          mailboxId: input.mailboxId,
          messageId: input.messageId,
          organizationId: input.organizationId,
          projectId: input.projectId,
        })),
      );
    },

    async updateInboundMessageParsedPayloads(input) {
      const message = messages.find(
        (candidate) => candidate.organizationId === input.organizationId && candidate.id === input.messageId,
      );
      if (!message) return null;
      if (input.subjectCipherRef !== undefined) message.subjectCipherRef = input.subjectCipherRef;
      if (input.headersCipherRef !== undefined) message.headersCipherRef = input.headersCipherRef;
      if (input.parsedBodyCipherRef !== undefined) message.parsedBodyCipherRef = input.parsedBodyCipherRef;
      if (input.metadataJson !== undefined) message.metadataJson = input.metadataJson;
      return message;
    },

    async listActiveRoutesForDomain(input) {
      return routes
        .filter(
          (candidate) =>
            candidate.organizationId === input.organizationId &&
            candidate.domainId === input.domainId &&
            candidate.status === "active",
        )
        .sort((left, right) => right.priority - left.priority);
    },
  };
}

function domain(input: Partial<MailInternalDomain> = {}): MailInternalDomain {
  return {
    id: input.id ?? "domain_1",
    organizationId: input.organizationId ?? "org_1",
    domain: input.domain ?? "mail.ravi.bot",
    status: input.status ?? "verified",
  };
}

function mailbox(input: Partial<MailInternalMailbox> = {}): MailInternalMailbox {
  return {
    id: input.id ?? "mailbox_1",
    organizationId: input.organizationId ?? "org_1",
    projectId: input.projectId ?? null,
    address: input.address ?? "agent@mail.ravi.bot",
    status: input.status ?? "active",
  };
}

function route(input: Partial<MailInternalRoute> = {}): MailInternalRoute {
  return {
    id: input.id ?? "route_1",
    organizationId: input.organizationId ?? "org_1",
    domainId: input.domainId ?? "domain_1",
    mailboxId: input.mailboxId ?? "mailbox_1",
    matchType: input.matchType ?? "exact",
    pattern: input.pattern ?? "agent@mail.ravi.bot",
    action: input.action ?? "deliver",
    priority: input.priority ?? 0,
    status: input.status ?? "active",
    policyJson: input.policyJson ?? {},
  };
}

function encryptedIngestInput(
  input: Partial<Parameters<typeof ingestEncryptedInboundMail>[0]["input"]> = {},
): Parameters<typeof ingestEncryptedInboundMail>[0]["input"] {
  return {
    organizationId: input.organizationId ?? "org_1",
    projectId: input.projectId ?? undefined,
    mailboxId: input.mailboxId ?? "mailbox_1",
    routeId: input.routeId ?? null,
    messageId: input.messageId ?? "message_1",
    providerAdapter: input.providerAdapter ?? "Cloudflare_Email",
    providerMessageRefHash: input.providerMessageRefHash ?? "provider_hash_1",
    internetMessageIdHash: input.internetMessageIdHash ?? "internet_hash_1",
    fromHash: input.fromHash ?? "from_hash_1",
    toHashesJson: input.toHashesJson ?? ["to_hash_1"],
    subjectCipherRef: "subjectCipherRef" in input ? input.subjectCipherRef : cipherRef("subject"),
    rawMimeCipherRef: input.rawMimeCipherRef ?? cipherRef("raw"),
    headersCipherRef: input.headersCipherRef ?? cipherRef("headers"),
    parsedBodyCipherRef: "parsedBodyCipherRef" in input ? input.parsedBodyCipherRef : undefined,
    attachments: input.attachments,
    sizeBytes: input.sizeBytes ?? 1024,
    receivedAt: input.receivedAt ?? "2026-05-11T12:00:00.000Z",
    requestId: input.requestId ?? "req_ingest",
    metadataJson: input.metadataJson ?? { provider: { messageRefHash: "provider_hash_1" } },
  };
}

function attachmentInput(id: string): MailInternalAttachmentInput {
  return {
    attachmentId: id,
    filenameCipherRef: cipherRef(`${id}_filename`),
    objectCipherRef: cipherRef(`${id}_object`),
    contentType: "application/pdf",
    sizeBytes: 1234,
    sha256: `sha256:${id}`,
    status: "unscanned",
    metadataJson: { guardrail: { status: "disabled" } },
  };
}

function cipherRef(kind: string) {
  return {
    schemaVersion: 1,
    ciphertextRef: `r2://mail/${kind}`,
    algorithm: "AES-256-GCM",
    wrappedKeyRef: `mail_key_wraps/${kind}`,
    aadHash: `sha256:${kind}`,
    keyVersion: 1,
    createdAt: "2026-05-11T00:00:00.000Z",
  };
}
