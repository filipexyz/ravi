import type { JsonRecord } from "@/server/db/schema";
import {
  decryptMailPayloadToString,
  encryptMailPayload,
  generateMailContentEncryptionKeyBytes,
  type EncryptedMailPayload,
  type MailCipherRef as EncryptionMailCipherRef,
  type MailCipherScopeInput,
  type MailPayloadKind,
} from "./encryption";
import { decideMailAccess, type MailPolicyDecision } from "./policy";
import {
  sendOutboundMailWithAdapter,
  type MailOutboundAuthorization,
  type MailOutboundDraft,
  type MailProviderAdapter,
  type MailProviderCapabilities,
  type MailVerifiedSender,
} from "./provider-adapters";
import {
  createMailDomain,
  createMailbox,
  createMailRoute,
  recordEncryptedMailMessage,
  resolveInboundMailbox,
  type InsertMailMessageInput,
  type InsertMailThreadInput,
  type MailAttachment,
  type MailCipherRef as StoredMailCipherRef,
  type MailDeliveryEvent,
  type MailDomain,
  type MailKeyRef,
  type MailMessage,
  type MailRoute,
  type MailStorageRepository,
  type MailThread,
  type Mailbox,
} from "./storage";

export type MailSmokeMessageMetadata = Pick<
  MailMessage,
  | "id"
  | "organizationId"
  | "projectId"
  | "mailboxId"
  | "direction"
  | "providerAdapter"
  | "providerMessageRefHash"
  | "fromHash"
  | "toHashesJson"
  | "subjectCipherRef"
  | "rawMimeCipherRef"
  | "headersCipherRef"
  | "status"
  | "sizeBytes"
  | "receivedAt"
  | "sentAt"
  | "metadataJson"
>;

export type MailSmokeAuditEvent = {
  action: "mail.decrypt";
  actorOrganizationId: string;
  allowed: boolean;
  messageId: string;
  organizationId: string;
  reason?: string;
};

export type MailSmokePolicyInput = {
  actorOrganizationId: string;
  canRead: boolean;
  message: MailMessage;
  mailbox: Mailbox;
};

export type MailSmokeHarnessOptions = {
  audit?: {
    record(event: MailSmokeAuditEvent): Promise<void> | void;
  };
  now?: Date;
  policy?: (input: MailSmokePolicyInput) => MailPolicyDecision;
  projects?: { id: string; organizationId: string }[];
};

export type InMemoryMailStorageRepository = MailStorageRepository & {
  attachments: MailAttachment[];
  deliveryEvents: MailDeliveryEvent[];
  domains: MailDomain[];
  keyRefs: MailKeyRef[];
  mailboxes: Mailbox[];
  messages: MailMessage[];
  nextMessageId(): string;
  routes: MailRoute[];
  threads: MailThread[];
};

export function createMailSmokeHarness(options: MailSmokeHarnessOptions = {}) {
  const repository = createInMemoryMailStorageRepository({
    now: options.now,
    projects: options.projects,
  });
  const encryptedObjects = new Map<string, EncryptedMailPayload>();
  const contentKey = generateMailContentEncryptionKeyBytes();
  const providerAdapter = createFakeMailProviderAdapter(options.now);
  const auditEvents: MailSmokeAuditEvent[] = [];
  const audit = options.audit ?? {
    record(event: MailSmokeAuditEvent) {
      auditEvents.push(event);
    },
  };
  const policy =
    options.policy ??
    ((input: MailSmokePolicyInput) =>
      decideMailAccess("decrypt", {
        actorOrganizationId: input.actorOrganizationId,
        mailboxOrganizationId: input.mailbox.organizationId,
        mailboxStatus: input.mailbox.status,
        canRead: input.canRead,
      }));

  return {
    auditEvents,
    encryptedObjects,
    providerAdapter,
    repository,

    async createDomainMailboxAndRoute(input: {
      domain: string;
      localPart: string;
      organizationId: string;
      projectId?: string | null;
    }) {
      const domain = await createMailDomain({
        input: {
          domain: input.domain,
          organizationId: input.organizationId,
          providerAdapter: providerAdapter.name,
          status: "verified",
        },
        repository,
      });
      const mailbox = await createMailbox({
        input: {
          domainId: domain.id,
          localPart: input.localPart,
          organizationId: input.organizationId,
          projectId: input.projectId,
        },
        repository,
      });
      const route = await createMailRoute({
        input: {
          action: "deliver",
          domainId: domain.id,
          mailboxId: mailbox.id,
          matchType: "exact",
          organizationId: input.organizationId,
          pattern: mailbox.address,
          priority: 10,
          status: "active",
        },
        repository,
      });

      return { domain, mailbox, route };
    },

    async receiveInboundRawMime(input: {
      organizationId: string;
      projectId?: string | null;
      recipient: string;
      rawMime: string;
      providerMessageRefHash: string;
      senderHash: string;
      recipientHashes: string[];
      receivedAt?: Date;
    }) {
      const resolved = await resolveInboundRecipient({
        address: input.recipient,
        organizationId: input.organizationId,
        repository,
      });
      if (!resolved.ok) return resolved;

      const messageId = repository.nextMessageId();
      const rawMime = await encryptAndStore({
        encryptedObjects,
        key: contentKey,
        mailboxId: resolved.value.mailbox.id,
        organizationId: input.organizationId,
        payloadKind: "raw_mime",
        plaintext: input.rawMime,
        projectId: input.projectId ?? resolved.value.mailbox.projectId,
        resourceId: messageId,
      });
      const headers = await encryptAndStore({
        encryptedObjects,
        key: contentKey,
        mailboxId: resolved.value.mailbox.id,
        organizationId: input.organizationId,
        payloadKind: "headers",
        plaintext: "encrypted headers placeholder",
        projectId: input.projectId ?? resolved.value.mailbox.projectId,
        resourceId: messageId,
      });

      const recorded = await recordEncryptedMailMessage({
        input: {
          direction: "inbound",
          fromHash: input.senderHash,
          headersCipherRef: headers.cipherRef,
          mailboxId: resolved.value.mailbox.id,
          metadataJson: {
            routeId: resolved.value.route.id,
            subaddressTag: resolved.value.subaddressTag,
          },
          organizationId: input.organizationId,
          projectId: input.projectId ?? resolved.value.mailbox.projectId,
          providerAdapter: providerAdapter.name,
          providerMessageRefHash: input.providerMessageRefHash,
          rawMimeCipherRef: rawMime.cipherRef,
          receivedAt: input.receivedAt ?? options.now ?? new Date(),
          sizeBytes: new TextEncoder().encode(input.rawMime).byteLength,
          status: "received",
          toHashesJson: input.recipientHashes,
        },
        repository,
      });

      return {
        ok: true as const,
        encryptedRawMime: rawMime.payload,
        message: recorded.message,
        resolution: resolved.value,
      };
    },

    listMessageMetadata(input: { organizationId: string; mailboxId?: string }) {
      return repository.messages
        .filter((message) => {
          if (message.organizationId !== input.organizationId) return false;
          if (input.mailboxId && message.mailboxId !== input.mailboxId) return false;
          return true;
        })
        .map(toMessageMetadata);
    },

    async decryptRawMime(input: {
      actorOrganizationId: string;
      canRead: boolean;
      messageId: string;
      organizationId: string;
    }) {
      const message = repository.messages.find(
        (candidate) => candidate.organizationId === input.organizationId && candidate.id === input.messageId,
      );
      if (!message) throw new Error("mail_message_not_found");

      const mailbox = await repository.findMailboxById({
        mailboxId: message.mailboxId,
        organizationId: message.organizationId,
      });
      if (!mailbox) throw new Error("mail_mailbox_not_found");

      const decision = policy({
        actorOrganizationId: input.actorOrganizationId,
        canRead: input.canRead,
        mailbox,
        message,
      });

      await audit.record({
        action: "mail.decrypt",
        actorOrganizationId: input.actorOrganizationId,
        allowed: decision.ok,
        messageId: message.id,
        organizationId: message.organizationId,
        ...(!decision.ok ? { reason: decision.reason } : {}),
      });

      if (!decision.ok) {
        return {
          ok: false as const,
          publicError: decision.publicError,
          reason: decision.reason,
        };
      }

      const cipherRef = message.rawMimeCipherRef as StoredMailCipherRef;
      const encryptedPayload = encryptedObjects.get(cipherRef.ciphertextRef);
      if (!encryptedPayload) throw new Error("mail_encrypted_payload_not_found");

      return {
        ok: true as const,
        plaintext: await decryptMailPayloadToString({
          key: contentKey,
          payload: encryptedPayload,
          scope: cipherScopeFromStoredRef(cipherRef),
        }),
      };
    },

    async sendOutboundRawMime(input: {
      authorization: MailOutboundAuthorization;
      fromAddress: string;
      idempotencyKey: string;
      mailbox: Mailbox;
      messageId: string;
      rawMime: string;
      sizeBytes?: number;
      to: string[];
      verifiedSender: MailVerifiedSender;
    }) {
      const encrypted = await encryptAndStore({
        encryptedObjects,
        key: contentKey,
        mailboxId: input.mailbox.id,
        organizationId: input.mailbox.organizationId,
        payloadKind: "raw_mime",
        plaintext: input.rawMime,
        projectId: input.mailbox.projectId,
        resourceId: input.messageId,
      });
      const draft: MailOutboundDraft = {
        from: {
          address: input.fromAddress,
          mailboxId: input.mailbox.id,
        },
        idempotencyKey: input.idempotencyKey,
        mailboxId: input.mailbox.id,
        messageId: input.messageId,
        organizationId: input.mailbox.organizationId,
        projectId: input.mailbox.projectId,
        rawMimeCipherRef: toProviderCipherRef(encrypted.cipherRef, input.sizeBytes ?? input.rawMime.length),
        sizeBytes: input.sizeBytes ?? new TextEncoder().encode(input.rawMime).byteLength,
        to: input.to,
      };

      return sendOutboundMailWithAdapter({
        adapter: providerAdapter,
        authorization: input.authorization,
        draft,
        verifiedSender: input.verifiedSender,
      });
    },
  };
}

async function resolveInboundRecipient({
  address,
  organizationId,
  repository,
}: {
  address: string;
  organizationId: string;
  repository: InMemoryMailStorageRepository;
}) {
  const mailboxResult = await resolveInboundMailbox({
    address,
    organizationId,
    repository,
  });
  if (!mailboxResult.ok) return mailboxResult;

  const exactAddress = mailboxResult.value.mailbox.address;
  const route =
    repository.routes.find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.status === "active" &&
        candidate.action === "deliver" &&
        candidate.mailboxId === mailboxResult.value.mailbox.id &&
        candidate.matchType === "exact" &&
        candidate.pattern === exactAddress,
    ) ?? null;

  if (!route) {
    return {
      ok: false as const,
      publicError: "mail_address_unavailable" as const,
    };
  }

  return {
    ok: true as const,
    value: {
      mailbox: mailboxResult.value.mailbox,
      route,
      subaddressTag: mailboxResult.value.subaddressTag,
    },
  };
}

function createInMemoryMailStorageRepository({
  now = new Date("2026-05-11T00:00:00.000Z"),
  projects = [{ id: "proj_1", organizationId: "org_1" }],
}: {
  now?: Date;
  projects?: { id: string; organizationId: string }[];
} = {}): InMemoryMailStorageRepository {
  const domains: MailDomain[] = [];
  const mailboxes: Mailbox[] = [];
  const routes: MailRoute[] = [];
  const threads: MailThread[] = [];
  const messages: MailMessage[] = [];
  const attachments: MailAttachment[] = [];
  const deliveryEvents: MailDeliveryEvent[] = [];
  const keyRefs: MailKeyRef[] = [];

  return {
    attachments,
    deliveryEvents,
    domains,
    keyRefs,
    mailboxes,
    messages,
    routes,
    threads,

    nextMessageId() {
      return `message_${messages.length + 1}`;
    },

    async disableRoutesForMailbox(input) {
      const disabledRoutes: MailRoute[] = [];
      for (const route of routes) {
        if (
          route.organizationId === input.organizationId &&
          route.mailboxId === input.mailboxId &&
          route.status === "active"
        ) {
          route.status = "disabled";
          route.updatedAt = now;
          disabledRoutes.push(route);
        }
      }
      return disabledRoutes;
    },

    async findDomainById(input) {
      return (
        domains.find((domain) => domain.organizationId === input.organizationId && domain.id === input.domainId) ?? null
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
        mailboxes.find(
          (mailbox) => mailbox.organizationId === input.organizationId && mailbox.address === input.address,
        ) ?? null
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
        contentType: input.contentType ?? null,
        createdAt: now,
        filenameCipherRef: input.filenameCipherRef ?? null,
        id: `attachment_${attachments.length + 1}`,
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        metadataJson: input.metadataJson ?? {},
        objectCipherRef: input.objectCipherRef,
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        sha256: input.sha256 ?? null,
        sizeBytes: input.sizeBytes ?? null,
        status: input.status ?? "unscanned",
      } satisfies MailAttachment;
      attachments.push(attachment);
      return attachment;
    },

    async insertDeliveryEvent(input) {
      const event = {
        createdAt: now,
        eventType: input.eventType,
        id: `delivery_${deliveryEvents.length + 1}`,
        mailboxId: input.mailboxId,
        messageId: input.messageId ?? null,
        metadataJson: input.metadataJson ?? {},
        occurredAt: input.occurredAt,
        organizationId: input.organizationId,
        providerAdapter: input.providerAdapter,
        providerEventRefHash: input.providerEventRefHash ?? null,
        status: input.status ?? "recorded",
      } satisfies MailDeliveryEvent;
      deliveryEvents.push(event);
      return event;
    },

    async insertDomain(input) {
      const domain = {
        authStatusJson: input.authStatusJson,
        createdAt: now,
        dnsStatusJson: input.dnsStatusJson,
        domainClaimId: input.domainClaimId,
        domain: input.domain,
        id: `domain_${domains.length + 1}`,
        metadataJson: input.metadataJson,
        organizationId: input.organizationId,
        providerAdapter: input.providerAdapter,
        status: input.status,
        updatedAt: now,
      } satisfies MailDomain;
      domains.push(domain);
      return domain;
    },

    async insertKeyRef(input) {
      const keyRef = {
        aadHash: input.aadHash ?? null,
        algorithm: input.algorithm,
        createdAt: now,
        id: `key_ref_${keyRefs.length + 1}`,
        keyScope: input.keyScope,
        keyVersion: input.keyVersion ?? 1,
        mailboxId: input.mailboxId ?? null,
        metadataJson: input.metadataJson ?? {},
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        resourceId: input.resourceId ?? null,
        resourceType: input.resourceType,
        status: input.status ?? "active",
        updatedAt: now,
        wrappedKeyRef: input.wrappedKeyRef,
      } satisfies MailKeyRef;
      keyRefs.push(keyRef);
      return keyRef;
    },

    async insertMailbox(input) {
      const mailbox = {
        address: input.address,
        agentId: input.agentId,
        createdAt: now,
        createdByUserId: input.createdByUserId,
        defaultVisibility: input.defaultVisibility,
        domainId: input.domainId,
        id: `mailbox_${mailboxes.length + 1}`,
        keyScope: input.keyScope,
        localPart: input.localPart,
        metadataJson: input.metadataJson,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "active",
        updatedAt: now,
      } satisfies Mailbox;
      mailboxes.push(mailbox);
      return mailbox;
    },

    async insertMessage(input: InsertMailMessageInput) {
      const message = {
        createdAt: now,
        direction: input.direction,
        fromHash: input.fromHash ?? null,
        headersCipherRef: input.headersCipherRef,
        id: input.id ?? `message_${messages.length + 1}`,
        internetMessageIdHash: input.internetMessageIdHash ?? null,
        mailboxId: input.mailboxId,
        metadataJson: input.metadataJson ?? {},
        organizationId: input.organizationId,
        parsedBodyCipherRef: input.parsedBodyCipherRef ?? null,
        addressSummaryCipherRef: input.addressSummaryCipherRef ?? null,
        projectId: input.projectId ?? null,
        providerAdapter: input.providerAdapter,
        providerMessageRefHash: input.providerMessageRefHash ?? null,
        rawMimeCipherRef: input.rawMimeCipherRef,
        receivedAt: input.receivedAt ?? null,
        sentAt: input.sentAt ?? null,
        sizeBytes: input.sizeBytes ?? null,
        status: input.status ?? (input.direction === "inbound" ? "received" : "queued"),
        subjectCipherRef: input.subjectCipherRef ?? null,
        threadId: input.threadId ?? null,
        toHashesJson: input.toHashesJson ?? [],
        updatedAt: now,
      } satisfies MailMessage;
      messages.push(message);
      return message;
    },

    async insertRoute(input) {
      const route = {
        action: input.action,
        createdAt: now,
        domainId: input.domainId,
        id: `route_${routes.length + 1}`,
        mailboxId: input.mailboxId,
        matchType: input.matchType,
        organizationId: input.organizationId,
        pattern: input.pattern,
        policyJson: input.policyJson,
        priority: input.priority,
        status: input.status,
        updatedAt: now,
      } satisfies MailRoute;
      routes.push(route);
      return route;
    },

    async insertThread(input: InsertMailThreadInput) {
      const thread = {
        contactId: input.contactId ?? null,
        createdAt: now,
        id: `thread_${threads.length + 1}`,
        lastMessageAt: input.lastMessageAt ?? null,
        mailboxId: input.mailboxId,
        normalizedSubjectHash: input.normalizedSubjectHash ?? null,
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        status: input.status ?? "active",
        subjectCipherRef: input.subjectCipherRef ?? null,
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
      mailbox.updatedAt = now;
      return mailbox;
    },
  };
}

async function encryptAndStore(input: {
  encryptedObjects: Map<string, EncryptedMailPayload>;
  key: Uint8Array;
  mailboxId: string;
  organizationId: string;
  payloadKind: MailPayloadKind;
  plaintext: string;
  projectId?: string | null;
  resourceId: string;
}) {
  const ciphertextRef = [
    "object://mail",
    input.organizationId,
    input.mailboxId,
    input.resourceId,
    input.payloadKind,
  ].join("/");
  const scope = {
    mailboxId: input.mailboxId,
    organizationId: input.organizationId,
    payloadKind: input.payloadKind,
    projectId: input.projectId ?? null,
    resourceId: input.resourceId,
    resourceType: "message",
  } satisfies MailCipherScopeInput;
  const payload = await encryptMailPayload({
    ciphertextRef,
    key: input.key,
    keyVersion: 1,
    plaintext: input.plaintext,
    scope,
    wrappedKeyRef: `mail_key_wraps/${input.organizationId}/${input.mailboxId}/v1`,
  });

  input.encryptedObjects.set(ciphertextRef, payload);
  return {
    cipherRef: toStoredCipherRef(payload.cipherRef),
    payload,
  };
}

function toStoredCipherRef(cipherRef: EncryptionMailCipherRef): StoredMailCipherRef {
  return {
    aadHash: cipherRef.aadHash,
    algorithm: cipherRef.algorithm,
    ciphertextRef: cipherRef.ciphertextRef ?? "",
    createdAt: cipherRef.createdAt,
    keyScope: cipherRef.keyScope,
    keyVersion: cipherRef.keyVersion,
    nonce: cipherRef.nonce,
    schemaVersion: cipherRef.schemaVersion,
    tag: cipherRef.tag,
    wrappedKeyRef: cipherRef.wrappedKeyRef,
  };
}

function cipherScopeFromStoredRef(cipherRef: StoredMailCipherRef): MailCipherScopeInput {
  const keyScope = cipherRef.keyScope;
  if (!isMailCipherScopeInput(keyScope)) throw new Error("mail_cipher_scope_missing");
  return keyScope;
}

function isMailCipherScopeInput(value: unknown): value is MailCipherScopeInput {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.organizationId === "string" &&
    (typeof record.projectId === "string" || record.projectId === null || record.projectId === undefined) &&
    typeof record.mailboxId === "string" &&
    record.resourceType === "message" &&
    typeof record.resourceId === "string" &&
    typeof record.payloadKind === "string"
  );
}

function toProviderCipherRef(cipherRef: StoredMailCipherRef, sizeBytes: number): MailOutboundDraft["rawMimeCipherRef"] {
  return {
    keyVersion: `v${cipherRef.keyVersion}`,
    payloadKind: "raw_mime",
    ref: cipherRef.ciphertextRef,
    scheme: "ravi-mail-cipher-ref",
    sha256: cipherRef.aadHash,
    sizeBytes,
  };
}

function toMessageMetadata(message: MailMessage): MailSmokeMessageMetadata {
  return {
    direction: message.direction,
    fromHash: message.fromHash,
    headersCipherRef: message.headersCipherRef,
    id: message.id,
    mailboxId: message.mailboxId,
    metadataJson: scrubMetadata(message.metadataJson),
    organizationId: message.organizationId,
    projectId: message.projectId,
    providerAdapter: message.providerAdapter,
    providerMessageRefHash: message.providerMessageRefHash,
    rawMimeCipherRef: message.rawMimeCipherRef,
    receivedAt: message.receivedAt,
    sentAt: message.sentAt,
    sizeBytes: message.sizeBytes,
    status: message.status,
    subjectCipherRef: message.subjectCipherRef,
    toHashesJson: message.toHashesJson,
  };
}

function scrubMetadata(metadata: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(metadata)) as JsonRecord;
}

function createFakeMailProviderAdapter(now = new Date("2026-05-11T00:00:00.000Z")) {
  const sent: MailOutboundDraft[] = [];
  const adapter: MailProviderAdapter & { sent: MailOutboundDraft[] } = {
    capabilities: mailProviderCapabilities(),
    name: "cloudflare_email",
    sent,
    async sendOutbound(request) {
      sent.push(request);
      return {
        acceptedAt: now.toISOString(),
        deliveryEventRefHash: `delivery_${sent.length}`,
        providerAdapter: "cloudflare_email",
        providerMessageRefHash: `provider_outbound_${sent.length}`,
      };
    },
  };

  return adapter;
}

function mailProviderCapabilities(): MailProviderCapabilities {
  return {
    attachments: true,
    catchAll: true,
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
    customDomains: true,
    deliveryEvents: true,
    inbound: true,
    maxMessageBytes: 10 * 1024 * 1024,
    maxRecipientsPerMessage: 50,
    outbound: true,
    rateLimitModel: "domain",
    subaddressing: true,
    suppressionEvents: true,
    supportStatus: "beta",
  };
}
