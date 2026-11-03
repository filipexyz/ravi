import { and, desc, eq, isNull } from "drizzle-orm";

import { ConsoleApiError, type ConsoleApiErrorPayload } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import {
  parseInboundMailAddress,
  parseSubaddress,
  publicMailAddressError,
  validateMailboxAddress,
  validateMailboxLocalPart,
} from "./addressing";

export type MailDomain = typeof schema.mailDomains.$inferSelect;
export type Mailbox = typeof schema.mailboxes.$inferSelect;
export type MailRoute = typeof schema.mailRoutes.$inferSelect;
export type MailThread = typeof schema.mailThreads.$inferSelect;
export type MailMessage = typeof schema.mailMessages.$inferSelect;
export type MailAttachment = typeof schema.mailAttachments.$inferSelect;
export type MailDeliveryEvent = typeof schema.mailDeliveryEvents.$inferSelect;
export type MailKeyRef = typeof schema.mailKeyRefs.$inferSelect;

export type MailStoragePublicErrorCode =
  | "mail_address_unavailable"
  | "mail_resource_unavailable"
  | "mail_payload_not_encrypted";

export type MailLookupResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      publicError: MailStoragePublicErrorCode;
    };

export type MailCipherRef = JsonRecord & {
  schemaVersion: number;
  ciphertextRef: string;
  algorithm: string;
  wrappedKeyRef: string;
  aadHash: string;
  keyVersion: number;
  createdAt: string;
};

export type CreateMailDomainInput = {
  authStatusJson?: JsonRecord;
  dnsStatusJson?: JsonRecord;
  domainClaimId?: string | null;
  domain: string;
  metadataJson?: JsonRecord;
  organizationId: string;
  providerAdapter: string;
  status?: "pending" | "verified" | "disabled" | "deleted";
};

export type CreateMailboxInput = {
  agentId?: string | null;
  createdByUserId?: string | null;
  defaultVisibility?: "public" | "private" | "protected_link";
  domainId: string;
  keyScope?: "organization" | "project" | "mailbox" | "agent";
  localPart: string;
  metadataJson?: JsonRecord;
  organizationId: string;
  projectId?: string | null;
};

export type CreateMailRouteInput = {
  action: "deliver" | "reject" | "drop" | "forward";
  domainId: string;
  mailboxId?: string | null;
  matchType: "exact" | "local_part" | "catch_all" | "pattern";
  organizationId: string;
  pattern: string;
  policyJson?: JsonRecord;
  priority?: number;
  status?: "active" | "disabled" | "deleted";
};

export type InsertMailThreadInput = {
  contactId?: string | null;
  lastMessageAt?: Date | null;
  mailboxId: string;
  normalizedSubjectHash?: string | null;
  organizationId: string;
  projectId?: string | null;
  status?: "active" | "archived" | "deleted";
  subjectCipherRef?: MailCipherRef | null;
};

export type InsertMailMessageInput = {
  addressSummaryCipherRef?: MailCipherRef | null;
  direction: "inbound" | "outbound";
  fromHash?: string | null;
  headersCipherRef: MailCipherRef;
  id?: string;
  internetMessageIdHash?: string | null;
  mailboxId: string;
  metadataJson?: JsonRecord;
  organizationId: string;
  parsedBodyCipherRef?: MailCipherRef | null;
  projectId?: string | null;
  providerAdapter: string;
  providerMessageRefHash?: string | null;
  rawMimeCipherRef: MailCipherRef;
  receivedAt?: Date | null;
  sentAt?: Date | null;
  sizeBytes?: number | null;
  status?: "received" | "queued" | "sent" | "delivered" | "failed" | "rejected" | "deleted";
  subjectCipherRef?: MailCipherRef | null;
  threadId?: string | null;
  toHashesJson?: string[];
};

export type InsertMailAttachmentInput = {
  contentType?: string | null;
  filenameCipherRef?: MailCipherRef | null;
  mailboxId: string;
  messageId: string;
  metadataJson?: JsonRecord;
  objectCipherRef: MailCipherRef;
  organizationId: string;
  projectId?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  status?: "unscanned" | "available" | "quarantined" | "deleted";
};

export type InsertMailDeliveryEventInput = {
  eventType: string;
  mailboxId: string;
  messageId?: string | null;
  metadataJson?: JsonRecord;
  occurredAt: Date;
  organizationId: string;
  providerAdapter: string;
  providerEventRefHash?: string | null;
  status?: "recorded" | "ignored" | "failed";
};

export type InsertMailKeyRefInput = {
  aadHash?: string | null;
  algorithm: string;
  keyScope: "organization" | "project" | "mailbox" | "agent";
  keyVersion?: number;
  mailboxId?: string | null;
  metadataJson?: JsonRecord;
  organizationId: string;
  projectId?: string | null;
  resourceId?: string | null;
  resourceType: string;
  status?: "active" | "rotated" | "revoked";
  wrappedKeyRef: string;
};

export type MailStorageRepository = {
  disableRoutesForMailbox(input: { mailboxId: string; organizationId: string }): Promise<MailRoute[]>;
  findDomainById(input: { domainId: string; organizationId: string }): Promise<MailDomain | null>;
  findDomainByName(input: { domain: string; organizationId: string }): Promise<MailDomain | null>;
  findMailboxByAddress(input: { address: string; organizationId: string }): Promise<Mailbox | null>;
  findMailboxById(input: { mailboxId: string; organizationId: string }): Promise<Mailbox | null>;
  findMessageByProviderRef(input: {
    organizationId: string;
    providerAdapter: string;
    providerMessageRefHash: string;
  }): Promise<MailMessage | null>;
  findProjectById(input: { organizationId: string; projectId: string }): Promise<{ id: string; organizationId: string } | null>;
  findThreadById(input: { organizationId: string; threadId: string }): Promise<MailThread | null>;
  insertAttachment(input: InsertMailAttachmentInput): Promise<MailAttachment>;
  insertDeliveryEvent(input: InsertMailDeliveryEventInput): Promise<MailDeliveryEvent>;
  insertDomain(input: Required<Pick<CreateMailDomainInput, "domain" | "organizationId" | "providerAdapter">> & {
    authStatusJson: JsonRecord;
    dnsStatusJson: JsonRecord;
    domainClaimId: string | null;
    metadataJson: JsonRecord;
    status: "pending" | "verified" | "disabled" | "deleted";
  }): Promise<MailDomain>;
  insertKeyRef(input: InsertMailKeyRefInput): Promise<MailKeyRef>;
  insertMailbox(input: Required<Pick<CreateMailboxInput, "domainId" | "localPart" | "organizationId">> & {
    address: string;
    agentId: string | null;
    createdByUserId: string | null;
    defaultVisibility: "public" | "private" | "protected_link";
    keyScope: "organization" | "project" | "mailbox" | "agent";
    metadataJson: JsonRecord;
    projectId: string | null;
  }): Promise<Mailbox>;
  insertMessage(input: InsertMailMessageInput): Promise<MailMessage>;
  insertRoute(input: Required<Pick<CreateMailRouteInput, "action" | "domainId" | "matchType" | "organizationId" | "pattern">> & {
    mailboxId: string | null;
    policyJson: JsonRecord;
    priority: number;
    status: "active" | "disabled" | "deleted";
  }): Promise<MailRoute>;
  insertThread(input: InsertMailThreadInput): Promise<MailThread>;
  listMailboxes(input: { organizationId: string; projectId?: string | null }): Promise<Mailbox[]>;
  updateMailboxStatus(input: {
    mailboxId: string;
    organizationId: string;
    status: "active" | "disabled" | "deleted";
  }): Promise<Mailbox | null>;
};

type DbExecutor = Pick<typeof db, "insert" | "select" | "update">;

const MAIL_RESOURCE_UNAVAILABLE = {
  error: "mail_resource_unavailable",
} satisfies ConsoleApiErrorPayload;

const MAIL_PAYLOAD_NOT_ENCRYPTED = {
  error: "mail_payload_not_encrypted",
} satisfies ConsoleApiErrorPayload;

const PLAINTEXT_FIELD_NAMES = new Set([
  "attachmentfilename",
  "bcc",
  "body",
  "cc",
  "filename",
  "from",
  "headers",
  "html",
  "htmlbody",
  "payload",
  "rawmime",
  "recipient",
  "recipients",
  "subject",
  "text",
  "textbody",
  "to",
]);

export function mailStorageRepositoryForDb(database: DbExecutor = db): MailStorageRepository {
  return {
    async disableRoutesForMailbox(input) {
      return database
        .update(schema.mailRoutes)
        .set({
          status: "disabled",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.mailRoutes.organizationId, input.organizationId),
            eq(schema.mailRoutes.mailboxId, input.mailboxId),
            eq(schema.mailRoutes.status, "active"),
          ),
        )
        .returning();
    },

    async findDomainById(input) {
      const [domain] = await database
        .select()
        .from(schema.mailDomains)
        .where(
          and(
            eq(schema.mailDomains.organizationId, input.organizationId),
            eq(schema.mailDomains.id, input.domainId),
          ),
        )
        .limit(1);

      return domain ?? null;
    },

    async findDomainByName(input) {
      const [domain] = await database
        .select()
        .from(schema.mailDomains)
        .where(
          and(
            eq(schema.mailDomains.organizationId, input.organizationId),
            eq(schema.mailDomains.domain, input.domain),
          ),
        )
        .limit(1);

      return domain ?? null;
    },

    async findMailboxByAddress(input) {
      const [mailbox] = await database
        .select()
        .from(schema.mailboxes)
        .where(
          and(
            eq(schema.mailboxes.organizationId, input.organizationId),
            eq(schema.mailboxes.address, input.address),
          ),
        )
        .limit(1);

      return mailbox ?? null;
    },

    async findMailboxById(input) {
      const [mailbox] = await database
        .select()
        .from(schema.mailboxes)
        .where(
          and(
            eq(schema.mailboxes.organizationId, input.organizationId),
            eq(schema.mailboxes.id, input.mailboxId),
          ),
        )
        .limit(1);

      return mailbox ?? null;
    },

    async findMessageByProviderRef(input) {
      const [message] = await database
        .select()
        .from(schema.mailMessages)
        .where(
          and(
            eq(schema.mailMessages.organizationId, input.organizationId),
            eq(schema.mailMessages.providerAdapter, input.providerAdapter),
            eq(schema.mailMessages.providerMessageRefHash, input.providerMessageRefHash),
          ),
        )
        .limit(1);

      return message ?? null;
    },

    async findProjectById(input) {
      const [project] = await database
        .select({
          id: schema.projects.id,
          organizationId: schema.projects.organizationId,
        })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.organizationId, input.organizationId),
            eq(schema.projects.id, input.projectId),
          ),
        )
        .limit(1);

      return project ?? null;
    },

    async findThreadById(input) {
      const [thread] = await database
        .select()
        .from(schema.mailThreads)
        .where(
          and(
            eq(schema.mailThreads.organizationId, input.organizationId),
            eq(schema.mailThreads.id, input.threadId),
          ),
        )
        .limit(1);

      return thread ?? null;
    },

    async insertAttachment(input) {
      const [attachment] = await database
        .insert(schema.mailAttachments)
        .values({
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
        })
        .returning();

      if (!attachment) throw new Error("Failed to record mail attachment.");
      return attachment;
    },

    async insertDeliveryEvent(input) {
      const [event] = await database
        .insert(schema.mailDeliveryEvents)
        .values({
          organizationId: input.organizationId,
          mailboxId: input.mailboxId,
          messageId: input.messageId ?? null,
          eventType: input.eventType,
          providerAdapter: input.providerAdapter,
          providerEventRefHash: input.providerEventRefHash ?? null,
          status: input.status ?? "recorded",
          occurredAt: input.occurredAt,
          metadataJson: input.metadataJson ?? {},
        })
        .returning();

      if (!event) throw new Error("Failed to record mail delivery event.");
      return event;
    },

    async insertDomain(input) {
      const [domain] = await database.insert(schema.mailDomains).values(input).returning();
      if (!domain) throw new Error("Failed to create mail domain.");
      return domain;
    },

    async insertKeyRef(input) {
      const [keyRef] = await database
        .insert(schema.mailKeyRefs)
        .values({
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
        })
        .returning();

      if (!keyRef) throw new Error("Failed to create mail key ref.");
      return keyRef;
    },

    async insertMailbox(input) {
      const [mailbox] = await database.insert(schema.mailboxes).values(input).returning();
      if (!mailbox) throw new Error("Failed to create mailbox.");
      return mailbox;
    },

    async insertMessage(input) {
      const [message] = await database
        .insert(schema.mailMessages)
        .values({
          ...(input.id ? { id: input.id } : {}),
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
          status: input.status ?? (input.direction === "inbound" ? "received" : "queued"),
          sizeBytes: input.sizeBytes ?? null,
          receivedAt: input.receivedAt ?? null,
          sentAt: input.sentAt ?? null,
          metadataJson: input.metadataJson ?? {},
        })
        .returning();

      if (!message) throw new Error("Failed to record mail message.");
      return message;
    },

    async insertRoute(input) {
      const [route] = await database.insert(schema.mailRoutes).values(input).returning();
      if (!route) throw new Error("Failed to create mail route.");
      return route;
    },

    async insertThread(input) {
      const [thread] = await database
        .insert(schema.mailThreads)
        .values({
          organizationId: input.organizationId,
          projectId: input.projectId ?? null,
          mailboxId: input.mailboxId,
          contactId: input.contactId ?? null,
          subjectCipherRef: input.subjectCipherRef ?? null,
          normalizedSubjectHash: input.normalizedSubjectHash ?? null,
          status: input.status ?? "active",
          lastMessageAt: input.lastMessageAt ?? null,
        })
        .returning();

      if (!thread) throw new Error("Failed to create mail thread.");
      return thread;
    },

    async listMailboxes(input) {
      const predicates = [eq(schema.mailboxes.organizationId, input.organizationId)];
      if (input.projectId !== undefined) {
        predicates.push(
          input.projectId === null
            ? isNull(schema.mailboxes.projectId)
            : eq(schema.mailboxes.projectId, input.projectId),
        );
      }

      return database
        .select()
        .from(schema.mailboxes)
        .where(and(...predicates))
        .orderBy(desc(schema.mailboxes.updatedAt));
    },

    async updateMailboxStatus(input) {
      const [mailbox] = await database
        .update(schema.mailboxes)
        .set({
          status: input.status,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.mailboxes.organizationId, input.organizationId),
            eq(schema.mailboxes.id, input.mailboxId),
          ),
        )
        .returning();

      return mailbox ?? null;
    },
  };
}

export async function createMailDomain({
  input,
  repository = mailStorageRepositoryForDb(),
}: {
  input: CreateMailDomainInput;
  repository?: MailStorageRepository;
}): Promise<MailDomain> {
  const domain = normalizeMailDomain(input.domain);
  const existing = await repository.findDomainByName({
    domain,
    organizationId: input.organizationId,
  });
  if (existing) return existing;

  return repository.insertDomain({
    organizationId: input.organizationId,
    domainClaimId: input.domainClaimId ?? null,
    domain,
    status: input.status ?? "pending",
    providerAdapter: normalizeProviderAdapter(input.providerAdapter),
    dnsStatusJson: input.dnsStatusJson ?? {},
    authStatusJson: input.authStatusJson ?? {},
    metadataJson: input.metadataJson ?? {},
  });
}

export async function createMailbox({
  input,
  repository = mailStorageRepositoryForDb(),
}: {
  input: CreateMailboxInput;
  repository?: MailStorageRepository;
}): Promise<Mailbox> {
  const localPart = validateMailboxLocalPart(input.localPart);
  if (!localPart.ok) throw mailStorageError(409, publicMailAddressError());

  const domain = await repository.findDomainById({
    organizationId: input.organizationId,
    domainId: input.domainId,
  });
  if (!domain || !mailDomainAllowsMailboxCreation(domain)) throw mailStorageError(409, publicMailAddressError());

  if (input.projectId) {
    const project = await repository.findProjectById({
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (!project) throw mailStorageError(404, MAIL_RESOURCE_UNAVAILABLE);
  }

  const address = `${localPart.localPart}@${domain.domain}`;
  const addressValidation = validateMailboxAddress(address);
  if (!addressValidation.ok) throw mailStorageError(409, publicMailAddressError());

  const existing = await repository.findMailboxByAddress({
    organizationId: input.organizationId,
    address: addressValidation.address,
  });
  if (existing) throw mailStorageError(409, publicMailAddressError());

  return repository.insertMailbox({
    organizationId: input.organizationId,
    projectId: input.projectId ?? null,
    agentId: input.agentId ?? null,
    localPart: localPart.localPart,
    domainId: domain.id,
    address: addressValidation.address,
    defaultVisibility: input.defaultVisibility ?? "private",
    keyScope: input.keyScope ?? "mailbox",
    createdByUserId: input.createdByUserId ?? null,
    metadataJson: input.metadataJson ?? {},
  });
}

export async function createMailRoute({
  input,
  repository = mailStorageRepositoryForDb(),
}: {
  input: CreateMailRouteInput;
  repository?: MailStorageRepository;
}): Promise<MailRoute> {
  const domain = await repository.findDomainById({
    organizationId: input.organizationId,
    domainId: input.domainId,
  });
  if (!domain) throw mailStorageError(404, MAIL_RESOURCE_UNAVAILABLE);

  if (input.mailboxId) {
    const mailbox = await repository.findMailboxById({
      organizationId: input.organizationId,
      mailboxId: input.mailboxId,
    });
    if (!mailbox) throw mailStorageError(404, MAIL_RESOURCE_UNAVAILABLE);
  }

  return repository.insertRoute({
    organizationId: input.organizationId,
    domainId: input.domainId,
    mailboxId: input.mailboxId ?? null,
    matchType: input.matchType,
    pattern: input.pattern.trim().toLowerCase(),
    action: input.action,
    priority: input.priority ?? 0,
    status: input.status ?? "active",
    policyJson: input.policyJson ?? {},
  });
}

export async function lookupMailboxByAddress({
  address,
  organizationId,
  repository = mailStorageRepositoryForDb(),
}: {
  address: string;
  organizationId: string;
  repository?: MailStorageRepository;
}): Promise<MailLookupResult<Mailbox>> {
  const parsed = validateMailboxAddress(address);
  if (!parsed.ok) return unavailableAddress();

  const mailbox = await repository.findMailboxByAddress({
    organizationId,
    address: parsed.address,
  });

  if (!mailbox || mailbox.status !== "active") return unavailableAddress();
  return { ok: true, value: mailbox };
}

export async function resolveInboundMailbox({
  address,
  organizationId,
  repository = mailStorageRepositoryForDb(),
}: {
  address: string;
  organizationId: string;
  repository?: MailStorageRepository;
}): Promise<MailLookupResult<{ mailbox: Mailbox; subaddressTag: string | null }>> {
  const parsed = parseInboundMailAddress(address);
  if (!parsed.ok) return unavailableAddress();

  const subaddress = parseSubaddress(parsed.localPart);
  const mailboxAddress = `${subaddress.baseLocalPart}@${parsed.domain}`;
  const mailbox = await repository.findMailboxByAddress({
    organizationId,
    address: mailboxAddress,
  });

  if (!mailbox || mailbox.status !== "active") return unavailableAddress();
  return {
    ok: true,
    value: {
      mailbox,
      subaddressTag: subaddress.hasTag ? subaddress.tag : null,
    },
  };
}

export async function recordEncryptedMailMessage({
  input,
  repository = mailStorageRepositoryForDb(),
}: {
  input: InsertMailMessageInput;
  repository?: MailStorageRepository;
}): Promise<{ created: boolean; message: MailMessage }> {
  assertNoPlaintextMailPayloadFields(input);
  assertCipherRef(input.rawMimeCipherRef, "rawMimeCipherRef");
  assertCipherRef(input.headersCipherRef, "headersCipherRef");
  if (input.subjectCipherRef) assertCipherRef(input.subjectCipherRef, "subjectCipherRef");
  if (input.parsedBodyCipherRef) assertCipherRef(input.parsedBodyCipherRef, "parsedBodyCipherRef");
  if (input.addressSummaryCipherRef) assertCipherRef(input.addressSummaryCipherRef, "addressSummaryCipherRef");

  const mailbox = await repository.findMailboxById({
    organizationId: input.organizationId,
    mailboxId: input.mailboxId,
  });
  if (!mailbox || mailbox.status !== "active") throw mailStorageError(404, MAIL_RESOURCE_UNAVAILABLE);

  const projectId = input.projectId ?? mailbox.projectId;
  if (projectId) {
    const project = await repository.findProjectById({
      organizationId: input.organizationId,
      projectId,
    });
    if (!project) throw mailStorageError(404, MAIL_RESOURCE_UNAVAILABLE);
  }

  if (input.threadId) {
    const thread = await repository.findThreadById({
      organizationId: input.organizationId,
      threadId: input.threadId,
    });
    if (!thread || thread.mailboxId !== mailbox.id) throw mailStorageError(404, MAIL_RESOURCE_UNAVAILABLE);
  }

  const providerMessageRefHash = input.providerMessageRefHash ?? null;
  if (providerMessageRefHash) {
    const existing = await repository.findMessageByProviderRef({
      organizationId: input.organizationId,
      providerAdapter: normalizeProviderAdapter(input.providerAdapter),
      providerMessageRefHash,
    });
    if (existing) return { created: false, message: existing };
  }

  const message = await repository.insertMessage({
    ...input,
    projectId,
    providerAdapter: normalizeProviderAdapter(input.providerAdapter),
    providerMessageRefHash,
  });
  return { created: true, message };
}

export async function recordEncryptedMailAttachment({
  input,
  repository = mailStorageRepositoryForDb(),
}: {
  input: InsertMailAttachmentInput;
  repository?: MailStorageRepository;
}): Promise<MailAttachment> {
  assertNoPlaintextMailPayloadFields(input);
  assertCipherRef(input.objectCipherRef, "objectCipherRef");
  if (input.filenameCipherRef) assertCipherRef(input.filenameCipherRef, "filenameCipherRef");

  const mailbox = await repository.findMailboxById({
    organizationId: input.organizationId,
    mailboxId: input.mailboxId,
  });
  if (!mailbox) throw mailStorageError(404, MAIL_RESOURCE_UNAVAILABLE);

  return repository.insertAttachment({
    ...input,
    projectId: input.projectId ?? mailbox.projectId,
  });
}

export async function recordMailDeliveryEvent({
  input,
  repository = mailStorageRepositoryForDb(),
}: {
  input: InsertMailDeliveryEventInput;
  repository?: MailStorageRepository;
}): Promise<MailDeliveryEvent> {
  assertNoPlaintextMailPayloadFields(input);

  const mailbox = await repository.findMailboxById({
    organizationId: input.organizationId,
    mailboxId: input.mailboxId,
  });
  if (!mailbox) throw mailStorageError(404, MAIL_RESOURCE_UNAVAILABLE);

  return repository.insertDeliveryEvent({
    ...input,
    providerAdapter: normalizeProviderAdapter(input.providerAdapter),
  });
}

export async function createMailKeyRef({
  input,
  repository = mailStorageRepositoryForDb(),
}: {
  input: InsertMailKeyRefInput;
  repository?: MailStorageRepository;
}): Promise<MailKeyRef> {
  if (input.projectId) {
    const project = await repository.findProjectById({
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (!project) throw mailStorageError(404, MAIL_RESOURCE_UNAVAILABLE);
  }

  if (input.mailboxId) {
    const mailbox = await repository.findMailboxById({
      organizationId: input.organizationId,
      mailboxId: input.mailboxId,
    });
    if (!mailbox) throw mailStorageError(404, MAIL_RESOURCE_UNAVAILABLE);
  }

  return repository.insertKeyRef(input);
}

export function mailDomainAllowsMailboxCreation(domain: MailDomain): boolean {
  if (domain.status === "verified") return true;
  if (domain.status !== "pending") return false;

  const authStatus = asJsonRecord(domain.authStatusJson);
  const metadata = asJsonRecord(domain.metadataJson);
  const customerManaged =
    authStatus.mode === "customer_managed" ||
    metadata.managed === false ||
    metadata.ownershipMode === "customer_managed";

  return customerManaged && authStatus.ownershipStatus === "verified";
}

export function mailDomainUsesPerMailboxInboundRule(domain: MailDomain): boolean {
  const authStatus = asJsonRecord(domain.authStatusJson);
  const metadata = asJsonRecord(domain.metadataJson);
  const customerManaged =
    authStatus.mode === "customer_managed" ||
    metadata.managed === false ||
    metadata.ownershipMode === "customer_managed";

  return domain.status === "verified" && !customerManaged;
}

export function assertNoPlaintextMailPayloadFields(value: unknown): void {
  const path = findPlaintextFieldPath(value);
  if (path) throw mailStorageError(400, MAIL_PAYLOAD_NOT_ENCRYPTED);
}

function normalizeMailDomain(value: string): string {
  const validation = validateMailboxAddress(`mailbox@${value}`);
  if (!validation.ok) throw mailStorageError(409, publicMailAddressError());
  return validation.domain;
}

function normalizeProviderAdapter(value: string): string {
  return value.trim().toLowerCase();
}

function asJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function unavailableAddress<T>(): MailLookupResult<T> {
  return {
    ok: false,
    publicError: "mail_address_unavailable",
  };
}

function mailStorageError(status: number, payload: ConsoleApiErrorPayload): ConsoleApiError {
  return new ConsoleApiError(status, payload);
}

function assertCipherRef(value: MailCipherRef, label: string): void {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.schemaVersion !== "number" ||
    typeof value.ciphertextRef !== "string" ||
    typeof value.algorithm !== "string" ||
    typeof value.wrappedKeyRef !== "string" ||
    typeof value.aadHash !== "string" ||
    typeof value.keyVersion !== "number" ||
    typeof value.createdAt !== "string"
  ) {
    throw mailStorageError(400, {
      error: "mail_payload_not_encrypted",
      fieldErrors: {
        [label]: "Encrypted mail payloads must be stored as cipher references.",
      },
    });
  }
}

function findPlaintextFieldPath(value: unknown, path: string[] = []): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = findPlaintextFieldPath(value[index], [...path, String(index)]);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (PLAINTEXT_FIELD_NAMES.has(key.replace(/[_-]/g, "").toLowerCase())) {
      return [...path, key].join(".");
    }

    const nested = findPlaintextFieldPath(nestedValue, [...path, key]);
    if (nested) return nested;
  }

  return null;
}
