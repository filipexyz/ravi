import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";

import { ConsoleApiError, type ConsoleApiErrorPayload } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import { decideMailAccess } from "./policy";
import {
  sendOutboundMailWithAdapter,
  type MailCipherRef as ProviderMailCipherRef,
  type MailProviderAdapter,
  type MailUsageMetricKey,
} from "./provider-adapters";
import {
  createMailDomain,
  createMailbox,
  createMailRoute,
  mailStorageRepositoryForDb,
  mailDomainUsesPerMailboxInboundRule,
  recordEncryptedMailMessage,
  recordMailDeliveryEvent,
  type CreateMailDomainInput,
  type CreateMailboxInput,
  type CreateMailRouteInput,
  type InsertMailMessageInput,
  type MailAttachment,
  type MailCipherRef,
  type MailDomain,
  type MailMessage,
  type MailRoute,
  type MailStorageRepository,
  type Mailbox,
} from "./storage";

export type MailServiceActor = {
  actorId: string;
  organizationId: string;
};

export type CreateMailDomainRequest = Omit<CreateMailDomainInput, "organizationId">;
export type CreateMailboxRequest = Omit<CreateMailboxInput, "organizationId">;
export type CreateMailRouteRequest = Omit<CreateMailRouteInput, "organizationId">;

export type MailMessagePayloadKind = "subject" | "raw_mime" | "parsed_body" | "headers" | "address_summary";
export type MailAttachmentPayloadKind = "attachment_filename" | "attachment_object";
export type MailDecryptPayloadKind = MailMessagePayloadKind | MailAttachmentPayloadKind;

export type ListMailMessageMetadataInput = {
  limit?: number;
  mailboxId: string;
};

export type MailMessageMetadata = {
  addressSummary?: unknown;
  createdAt: Date;
  direction: MailMessage["direction"];
  fromHash: string | null;
  hasAddressSummary: boolean;
  hasHeaders: boolean;
  hasParsedBody: boolean;
  hasSubject: boolean;
  id: string;
  mailboxId: string;
  organizationId: string;
  projectId: string | null;
  receivedAt: Date | null;
  sentAt: Date | null;
  sizeBytes: number | null;
  status: MailMessage["status"];
  threadId: string | null;
  toHashesJson: string[];
  updatedAt: Date;
};

export type MailAttachmentMetadata = {
  contentType: string | null;
  createdAt: Date;
  filename: string | null;
  hasEncryptedObject: boolean;
  hasFilename: boolean;
  id: string;
  messageId: string;
  organizationId: string;
  projectId: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  status: MailAttachment["status"];
};

export type DecryptMailMessagePayloadInput = {
  messageId: string;
  payloadKind: MailMessagePayloadKind;
};

export type DecryptMailMessagePayloadResult = {
  messageId: string;
  payloadKind: MailMessagePayloadKind;
  plaintext: string;
};

export type SendOutboundMailInput = {
  addressSummaryCipherRef?: MailCipherRef | null;
  bcc?: string[];
  cc?: string[];
  fromAddress?: string;
  fromMailboxId?: string;
  headersCipherRef: MailCipherRef;
  idempotencyKey: string;
  internetMessageIdHash?: string | null;
  messageId?: string;
  providerPayload?: {
    subject: string;
    text: string;
  };
  projectId?: string | null;
  rawMimeCipherRef: MailCipherRef;
  sizeBytes: number;
  subjectCipherRef?: MailCipherRef | null;
  to: string[];
};

export type SendOutboundMailResult = {
  acceptedAt: string;
  deliveryEventRefHash: string | null;
  message: MailMessageMetadata;
};

export type MailAuditOperation =
  | "mail.domain.create"
  | "mail.mailbox.create"
  | "mail.mailbox.disable"
  | "mail.attachment.list"
  | "mail.route.create"
  | "mail.message.read"
  | "mail.message.decrypt"
  | "mail.message.send";

export type MailAuditEvent = {
  actorId: string;
  metadata?: JsonRecord;
  operation: MailAuditOperation;
  organizationId: string;
  resourceId: string;
  resourceType: "mail_domain" | "mailbox" | "mail_route" | "mail_message";
};

export type MailUsageEvent = {
  idempotencyKey?: string;
  metric: MailUsageMetricKey;
  organizationId: string;
  projectId?: string | null;
  quantity: number;
  resourceId?: string;
};

export type MailAuditSink = {
  record(event: MailAuditEvent): Promise<void>;
};

export type MailUsageSink = {
  emit(event: MailUsageEvent): Promise<void>;
};

export type MailAccessController = {
  canManageMailbox(input: { actor: MailServiceActor; mailbox: Mailbox }): Promise<boolean>;
  canReadMailbox(input: { actor: MailServiceActor; mailbox: Mailbox }): Promise<boolean>;
  canSendFromMailbox(input: { actor: MailServiceActor; fromAddress: string; mailbox: Mailbox }): Promise<boolean>;
  resolveDefaultSendMailbox(input: { actor: MailServiceActor; projectId?: string | null }): Promise<string | null>;
};

export type MailPayloadDecrypter = {
  decryptMessagePayload(input: {
    cipherRef: MailCipherRef;
    attachmentId?: string | null;
    message: MailMessage;
    payloadKind: MailDecryptPayloadKind;
  }): Promise<string>;
};

export type MailProviderAdapterRegistry = {
  get(name: string): MailProviderAdapter | undefined;
};

export type MailServiceRepository = MailStorageRepository & {
  findMessageById(input: { messageId: string; organizationId: string }): Promise<MailMessage | null>;
  listAttachmentsForMessage(input: { messageId: string; organizationId: string }): Promise<MailAttachment[]>;
  listDomains(input: { organizationId: string }): Promise<MailDomain[]>;
  listMessages(input: { limit?: number; mailboxId?: string; organizationId: string }): Promise<MailMessage[]>;
};

export type MailConsoleMailServiceDependencies = {
  access?: MailAccessController;
  adapters?: MailProviderAdapterRegistry;
  audit?: MailAuditSink;
  decrypter?: MailPayloadDecrypter;
  inboundProvider?: MailInboundRoutingProvider;
  messageIdFactory?: () => string;
  now?: () => Date;
  repository?: MailServiceRepository;
  usage?: MailUsageSink;
};

/**
 * Hook for the inbound MX provider (e.g. Cloudflare Email Routing). When set,
 * the service syncs per-mailbox provider rules for Ravi-managed shared domains.
 * Custom routed domains are handled at the domain binding layer, so mailbox
 * creation only records local routes.
 */
export type MailInboundRoutingProvider = {
  deleteMailboxRule?(input: {
    address: string;
    domain: string;
    mailboxId: string;
  }): Promise<void>;
  ensureMailboxRule(input: {
    address: string;
    domain: string;
    mailboxId: string;
  }): Promise<void>;
};

type DbExecutor = Pick<typeof db, "insert" | "select" | "update">;

const MAIL_RESOURCE_UNAVAILABLE = {
  error: "mail_resource_unavailable",
} satisfies ConsoleApiErrorPayload;

const MAIL_OPERATION_DENIED = {
  error: "mail_operation_denied",
} satisfies ConsoleApiErrorPayload;

const MAIL_SEND_DENIED = {
  error: "mail_send_denied",
} satisfies ConsoleApiErrorPayload;

export function createMailConsoleMailService(dependencies: MailConsoleMailServiceDependencies = {}) {
  const repository = dependencies.repository ?? mailServiceRepositoryForDb();
  const access = dependencies.access ?? denyAllMailAccess();
  const audit = dependencies.audit ?? noopAuditSink();
  const usage = dependencies.usage ?? noopUsageSink();
  const decrypter = dependencies.decrypter ?? unavailableDecrypter();
  const adapters = dependencies.adapters ?? new Map<string, MailProviderAdapter>();
  const now = dependencies.now ?? (() => new Date());
  const messageIdFactory = dependencies.messageIdFactory ?? randomUUID;

  return {
    async createDomain(actor: MailServiceActor, input: CreateMailDomainRequest): Promise<MailDomain> {
      const domain = await createMailDomain({
        input: {
          ...input,
          organizationId: actor.organizationId,
        },
        repository,
      });

      await audit.record({
        actorId: actor.actorId,
        operation: "mail.domain.create",
        organizationId: actor.organizationId,
        resourceId: domain.id,
        resourceType: "mail_domain",
      });

      return domain;
    },

    async createMailbox(actor: MailServiceActor, input: CreateMailboxRequest): Promise<Mailbox> {
      const mailbox = await createMailbox({
        input: {
          ...input,
          organizationId: actor.organizationId,
        },
        repository,
      });

      if (dependencies.inboundProvider) {
        const domain = await repository.findDomainById({
          domainId: mailbox.domainId,
          organizationId: actor.organizationId,
        });
        if (domain && mailDomainUsesPerMailboxInboundRule(domain)) {
          try {
            await dependencies.inboundProvider.ensureMailboxRule({
              address: mailbox.address,
              domain: domain.domain,
              mailboxId: mailbox.id,
            });
          } catch (error) {
            Sentry.captureException(error, {
              tags: { component: "mail.inbound_provider" },
              extra: { mailboxId: mailbox.id, address: mailbox.address },
            });
            throw new ConsoleApiError(502, {
              error: "mail_inbound_provider_failed",
            });
          }
        }
      }

      await audit.record({
        actorId: actor.actorId,
        operation: "mail.mailbox.create",
        organizationId: actor.organizationId,
        resourceId: mailbox.id,
        resourceType: "mailbox",
      });

      return mailbox;
    },

    async createRoute(actor: MailServiceActor, input: CreateMailRouteRequest): Promise<MailRoute> {
      const route = await createMailRoute({
        input: {
          ...input,
          organizationId: actor.organizationId,
        },
        repository,
      });

      await audit.record({
        actorId: actor.actorId,
        operation: "mail.route.create",
        organizationId: actor.organizationId,
        resourceId: route.id,
        resourceType: "mail_route",
      });

      return route;
    },

    async disableMailbox(actor: MailServiceActor, input: { mailboxId: string }): Promise<{
      disabledRoutes: MailRoute[];
      mailbox: Mailbox;
      providerSynced: boolean;
    }> {
      const mailbox = await requireMailbox(repository, actor.organizationId, input.mailboxId);
      await requireMailboxManageAccess({ access, actor, mailbox });

      const disabledRoutes = await repository.disableRoutesForMailbox({
        organizationId: actor.organizationId,
        mailboxId: mailbox.id,
      });
      const updatedMailbox =
        mailbox.status === "deleted"
          ? mailbox
          : mailbox.status === "disabled"
            ? mailbox
            : await repository.updateMailboxStatus({
                organizationId: actor.organizationId,
                mailboxId: mailbox.id,
                status: "disabled",
              });
      if (!updatedMailbox) throw mailServiceError(404, MAIL_RESOURCE_UNAVAILABLE);

      let providerSynced = false;
      if (dependencies.inboundProvider?.deleteMailboxRule) {
        const domain = await requireDomain(repository, actor.organizationId, mailbox.domainId);
        if (mailDomainUsesPerMailboxInboundRule(domain)) {
          try {
            await dependencies.inboundProvider.deleteMailboxRule({
              address: mailbox.address,
              domain: domain.domain,
              mailboxId: mailbox.id,
            });
            providerSynced = true;
          } catch (error) {
            Sentry.captureException(error, {
              tags: { component: "mail.inbound_provider" },
              extra: { mailboxId: mailbox.id, address: mailbox.address },
            });
            throw new ConsoleApiError(502, {
              error: "mail_inbound_provider_failed",
            });
          }
        }
      }

      await audit.record({
        actorId: actor.actorId,
        metadata: {
          disabledRouteCount: disabledRoutes.length,
          providerSynced,
        },
        operation: "mail.mailbox.disable",
        organizationId: actor.organizationId,
        resourceId: mailbox.id,
        resourceType: "mailbox",
      });

      return {
        disabledRoutes,
        mailbox: updatedMailbox,
        providerSynced,
      };
    },

    async listDomains(actor: MailServiceActor): Promise<MailDomain[]> {
      return repository.listDomains({ organizationId: actor.organizationId });
    },

    async listMailboxes(actor: MailServiceActor, input: { projectId?: string | null } = {}): Promise<Mailbox[]> {
      return repository.listMailboxes({
        organizationId: actor.organizationId,
        projectId: input.projectId,
      });
    },

    async listMessageMetadata(
      actor: MailServiceActor,
      input: ListMailMessageMetadataInput,
    ): Promise<MailMessageMetadata[]> {
      const mailbox = await requireMailbox(repository, actor.organizationId, input.mailboxId);
      await requireMailboxReadAccess({ access, actor, mailbox, operation: "read" });

      const messages = await repository.listMessages({
        organizationId: actor.organizationId,
        mailboxId: mailbox.id,
        limit: input.limit,
      });

      await audit.record({
        actorId: actor.actorId,
        metadata: {
          count: messages.length,
        },
        operation: "mail.message.read",
        organizationId: actor.organizationId,
        resourceId: mailbox.id,
        resourceType: "mailbox",
      });

      return messages.map(toMessageMetadata);
    },

    async listMessageAttachments(actor: MailServiceActor, input: { messageId: string }): Promise<MailAttachmentMetadata[]> {
      const message = await requireMessage(repository, actor.organizationId, input.messageId);
      const mailbox = await requireMailbox(repository, actor.organizationId, message.mailboxId);
      await requireMailboxReadAccess({ access, actor, mailbox, operation: "read" });

      const attachments = await repository.listAttachmentsForMessage({
        organizationId: actor.organizationId,
        messageId: message.id,
      });
      const encryptedFilenameCount = attachments.filter((attachment) => Boolean(attachment.filenameCipherRef)).length;

      await audit.record({
        actorId: actor.actorId,
        metadata: {
          count: attachments.length,
        },
        operation: "mail.attachment.list",
        organizationId: actor.organizationId,
        resourceId: message.id,
        resourceType: "mail_message",
      });

      if (encryptedFilenameCount > 0) {
        await audit.record({
          actorId: actor.actorId,
          metadata: {
            attachmentCount: encryptedFilenameCount,
            payloadKind: "attachment_filename",
          },
          operation: "mail.message.decrypt",
          organizationId: actor.organizationId,
          resourceId: message.id,
          resourceType: "mail_message",
        });
      }

      return Promise.all(attachments.map((attachment) => toAttachmentMetadata({ attachment, decrypter, message })));
    },

    async decryptMessagePayload(
      actor: MailServiceActor,
      input: DecryptMailMessagePayloadInput,
    ): Promise<DecryptMailMessagePayloadResult> {
      const message = await requireMessage(repository, actor.organizationId, input.messageId);
      const mailbox = await requireMailbox(repository, actor.organizationId, message.mailboxId);
      await requireMailboxReadAccess({ access, actor, mailbox, operation: "decrypt" });

      const cipherRef = selectMessageCipherRef(message, input.payloadKind);
      if (!cipherRef) throw mailServiceError(404, MAIL_RESOURCE_UNAVAILABLE);

      await audit.record({
        actorId: actor.actorId,
        metadata: {
          payloadKind: input.payloadKind,
        },
        operation: "mail.message.decrypt",
        organizationId: actor.organizationId,
        resourceId: message.id,
        resourceType: "mail_message",
      });

      return {
        messageId: message.id,
        payloadKind: input.payloadKind,
        plaintext: await decrypter.decryptMessagePayload({
          cipherRef,
          message,
          payloadKind: input.payloadKind,
        }),
      };
    },

    async sendOutbound(actor: MailServiceActor, input: SendOutboundMailInput): Promise<SendOutboundMailResult> {
      const mailboxId =
        input.fromMailboxId ??
        (await access.resolveDefaultSendMailbox({
          actor,
          projectId: input.projectId ?? null,
        }));
      if (!mailboxId) throw mailServiceError(403, MAIL_OPERATION_DENIED);

      const mailbox = await requireMailbox(repository, actor.organizationId, mailboxId);
      const domain = await requireDomain(repository, actor.organizationId, mailbox.domainId);
      const fromAddress = normalizeMailAddress(input.fromAddress ?? mailbox.address);
      if (fromAddress !== normalizeMailAddress(mailbox.address)) {
        throw mailServiceError(403, MAIL_SEND_DENIED);
      }

      const canSend = await access.canSendFromMailbox({
        actor,
        fromAddress,
        mailbox,
      });
      const decision = decideMailAccess("send", {
        actorOrganizationId: actor.organizationId,
        mailboxOrganizationId: mailbox.organizationId,
        mailboxStatus: mailbox.status,
        canSend,
      });
      if (!decision.ok) throw mailServiceError(403, { error: decision.publicError });

      const adapter = adapters.get(domain.providerAdapter);
      if (!adapter) {
        throw mailServiceError(503, {
          error: "mail_resource_unavailable",
          fieldErrors: {
            reason: "provider_adapter_unavailable",
          },
        });
      }

      const draftMessageId = input.messageId ?? messageIdFactory();
      const draft = {
        organizationId: actor.organizationId,
        projectId: mailbox.projectId,
        mailboxId: mailbox.id,
        messageId: draftMessageId,
        from: {
          address: fromAddress,
          mailboxId: mailbox.id,
          domainId: domain.id,
        },
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        rawMimeCipherRef: toProviderCipherRef(input.rawMimeCipherRef, "raw_mime", input.sizeBytes),
        subjectCipherRef: input.subjectCipherRef
          ? toProviderCipherRef(input.subjectCipherRef, "subject", input.sizeBytes)
          : null,
        headersCipherRef: toProviderCipherRef(input.headersCipherRef, "headers", input.sizeBytes),
        sizeBytes: input.sizeBytes,
        idempotencyKey: input.idempotencyKey,
      };

      const sendResult = await sendOutboundMailWithAdapter({
        adapter,
        authorization: {
          ok: true,
          actorId: actor.actorId,
          organizationId: actor.organizationId,
          mailboxId: mailbox.id,
          fromAddress,
          grantedAt: now().toISOString(),
        },
        draft,
        context: input.providerPayload
          ? {
              transientMessage: input.providerPayload,
            }
          : undefined,
        verifiedSender:
          domain.status === "verified"
            ? {
                verified: true,
                scope: "domain",
                domain: domain.domain,
                verifiedAt: domain.updatedAt.toISOString(),
              }
            : {
                verified: false,
                reason: "domain_unverified",
              },
      });
      if (!sendResult.ok || !("result" in sendResult)) {
        throw mailServiceError(403, MAIL_SEND_DENIED);
      }

      const message = await recordSentMessage({
        actor,
        domain,
        fromAddress,
        input,
        mailbox,
        messageId: draftMessageId,
        providerMessageRefHash: sendResult.result.providerMessageRefHash,
        repository,
        sentAt: new Date(sendResult.result.acceptedAt),
      });

      await recordMailDeliveryEvent({
        input: {
          eventType: "accepted",
          mailboxId: mailbox.id,
          messageId: message.id,
          metadataJson: {},
          occurredAt: new Date(sendResult.result.acceptedAt),
          organizationId: actor.organizationId,
          providerAdapter: domain.providerAdapter,
          providerEventRefHash: sendResult.result.deliveryEventRefHash ?? null,
          status: "recorded",
        },
        repository,
      });

      await audit.record({
        actorId: actor.actorId,
        metadata: {
          recipientCount: input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0),
          sizeBytes: input.sizeBytes,
        },
        operation: "mail.message.send",
        organizationId: actor.organizationId,
        resourceId: message.id,
        resourceType: "mail_message",
      });

      await usage.emit({
        idempotencyKey: `${input.idempotencyKey}:messages`,
        metric: "mail.messages.outbound",
        organizationId: actor.organizationId,
        projectId: mailbox.projectId,
        quantity: 1,
        resourceId: message.id,
      });
      await usage.emit({
        idempotencyKey: `${input.idempotencyKey}:recipients`,
        metric: "mail.recipients.outbound",
        organizationId: actor.organizationId,
        projectId: mailbox.projectId,
        quantity: input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0),
        resourceId: message.id,
      });
      await usage.emit({
        idempotencyKey: `${input.idempotencyKey}:bytes`,
        metric: "mail.bytes.outbound",
        organizationId: actor.organizationId,
        projectId: mailbox.projectId,
        quantity: input.sizeBytes,
        resourceId: message.id,
      });

      return {
        acceptedAt: sendResult.result.acceptedAt,
        deliveryEventRefHash: sendResult.result.deliveryEventRefHash ?? null,
        message: toMessageMetadata(message),
      };
    },
  };
}

export function mailServiceRepositoryForDb(database: DbExecutor = db): MailServiceRepository {
  const storage = mailStorageRepositoryForDb(database);

  return {
    ...storage,

    async findMessageById(input) {
      const [message] = await database
        .select()
        .from(schema.mailMessages)
        .where(
          and(
            eq(schema.mailMessages.organizationId, input.organizationId),
            eq(schema.mailMessages.id, input.messageId),
          ),
        )
        .limit(1);

      return message ?? null;
    },

    async listAttachmentsForMessage(input) {
      return database
        .select()
        .from(schema.mailAttachments)
        .where(
          and(
            eq(schema.mailAttachments.organizationId, input.organizationId),
            eq(schema.mailAttachments.messageId, input.messageId),
          ),
        )
        .orderBy(schema.mailAttachments.createdAt, schema.mailAttachments.id);
    },

    async listDomains(input) {
      return database
        .select()
        .from(schema.mailDomains)
        .where(eq(schema.mailDomains.organizationId, input.organizationId))
        .orderBy(desc(schema.mailDomains.updatedAt));
    },

    async listMessages(input) {
      const predicates = [eq(schema.mailMessages.organizationId, input.organizationId)];
      if (input.mailboxId) {
        predicates.push(eq(schema.mailMessages.mailboxId, input.mailboxId));
      }

      return database
        .select()
        .from(schema.mailMessages)
        .where(and(...predicates))
        .orderBy(desc(schema.mailMessages.receivedAt), desc(schema.mailMessages.sentAt), desc(schema.mailMessages.createdAt))
        .limit(clampMessageListLimit(input.limit));
    },
  };
}

async function recordSentMessage({
  actor,
  domain,
  fromAddress,
  input,
  mailbox,
  messageId,
  providerMessageRefHash,
  repository,
  sentAt,
}: {
  actor: MailServiceActor;
  domain: MailDomain;
  fromAddress: string;
  input: SendOutboundMailInput;
  mailbox: Mailbox;
  messageId: string;
  providerMessageRefHash: string;
  repository: MailServiceRepository;
  sentAt: Date;
}): Promise<MailMessage> {
  const result = await recordEncryptedMailMessage({
    input: {
      id: messageId,
      addressSummaryCipherRef: input.addressSummaryCipherRef ?? null,
      direction: "outbound",
      fromHash: await hashMailAddress(fromAddress),
      headersCipherRef: input.headersCipherRef,
      internetMessageIdHash: input.internetMessageIdHash ?? null,
      mailboxId: mailbox.id,
      organizationId: actor.organizationId,
      projectId: mailbox.projectId,
      providerAdapter: domain.providerAdapter,
      providerMessageRefHash,
      rawMimeCipherRef: input.rawMimeCipherRef,
      sentAt,
      sizeBytes: input.sizeBytes,
      status: "sent",
      subjectCipherRef: input.subjectCipherRef ?? null,
      toHashesJson: await Promise.all(input.to.map(hashMailAddress)),
    } satisfies InsertMailMessageInput,
    repository,
  });

  return result.message;
}

async function requireMailbox(repository: MailServiceRepository, organizationId: string, mailboxId: string): Promise<Mailbox> {
  const mailbox = await repository.findMailboxById({
    mailboxId,
    organizationId,
  });
  if (!mailbox) throw mailServiceError(404, MAIL_RESOURCE_UNAVAILABLE);
  return mailbox;
}

async function requireDomain(repository: MailServiceRepository, organizationId: string, domainId: string): Promise<MailDomain> {
  const domain = await repository.findDomainById({
    domainId,
    organizationId,
  });
  if (!domain) throw mailServiceError(404, MAIL_RESOURCE_UNAVAILABLE);
  return domain;
}

async function requireMessage(repository: MailServiceRepository, organizationId: string, messageId: string): Promise<MailMessage> {
  const message = await repository.findMessageById({
    messageId,
    organizationId,
  });
  if (!message) throw mailServiceError(404, MAIL_RESOURCE_UNAVAILABLE);
  return message;
}

async function requireMailboxReadAccess({
  access,
  actor,
  mailbox,
  operation,
}: {
  access: MailAccessController;
  actor: MailServiceActor;
  mailbox: Mailbox;
  operation: "read" | "decrypt";
}) {
  const canRead = await access.canReadMailbox({ actor, mailbox });
  const decision = decideMailAccess(operation, {
    actorOrganizationId: actor.organizationId,
    mailboxOrganizationId: mailbox.organizationId,
    mailboxStatus: mailbox.status,
    canRead,
  });
  if (!decision.ok) {
    const diagnostics = {
      operation,
      reason: decision.reason,
      actorOrganizationId: actor.organizationId,
      mailboxOrganizationId: mailbox.organizationId,
      mailboxId: mailbox.id,
      mailboxStatus: mailbox.status,
      canRead,
    };
    console.error("Ravi Mail read access denied", diagnostics);
    Sentry.captureMessage("Ravi Mail read access denied", {
      level: "warning",
      tags: {
        feature: "ravi-mail",
        operation,
        reason: decision.reason,
        mailboxStatus: mailbox.status,
        canRead: String(canRead),
      },
      contexts: {
        mail: diagnostics,
      },
    });
    throw mailServiceError(403, { error: decision.publicError, fieldErrors: { reason: decision.reason } });
  }
}

async function requireMailboxManageAccess({
  access,
  actor,
  mailbox,
}: {
  access: MailAccessController;
  actor: MailServiceActor;
  mailbox: Mailbox;
}) {
  const canManage = await access.canManageMailbox({ actor, mailbox });
  if (!canManage || actor.organizationId !== mailbox.organizationId) {
    throw mailServiceError(403, MAIL_OPERATION_DENIED);
  }
}

function selectMessageCipherRef(message: MailMessage, payloadKind: MailMessagePayloadKind): MailCipherRef | null {
  if (payloadKind === "subject") return (message.subjectCipherRef as MailCipherRef | null) ?? null;
  if (payloadKind === "raw_mime") return message.rawMimeCipherRef as MailCipherRef;
  if (payloadKind === "parsed_body") return (message.parsedBodyCipherRef as MailCipherRef | null) ?? null;
  if (payloadKind === "address_summary") return (message.addressSummaryCipherRef as MailCipherRef | null) ?? null;
  return message.headersCipherRef as MailCipherRef;
}

function toMessageMetadata(message: MailMessage): MailMessageMetadata {
  return {
    addressSummary: undefined,
    createdAt: message.createdAt,
    direction: message.direction,
    fromHash: message.fromHash,
    hasAddressSummary: Boolean(message.addressSummaryCipherRef),
    hasHeaders: Boolean(message.headersCipherRef),
    hasParsedBody: Boolean(message.parsedBodyCipherRef),
    hasSubject: Boolean(message.subjectCipherRef),
    id: message.id,
    mailboxId: message.mailboxId,
    organizationId: message.organizationId,
    projectId: message.projectId,
    receivedAt: message.receivedAt,
    sentAt: message.sentAt,
    sizeBytes: message.sizeBytes,
    status: message.status,
    threadId: message.threadId,
    toHashesJson: message.toHashesJson,
    updatedAt: message.updatedAt,
  };
}

async function toAttachmentMetadata({
  attachment,
  decrypter,
  message,
}: {
  attachment: MailAttachment;
  decrypter: MailPayloadDecrypter;
  message: MailMessage;
}): Promise<MailAttachmentMetadata> {
  let filename: string | null = null;
  const filenameCipherRef = attachment.filenameCipherRef as MailCipherRef | null;
  if (filenameCipherRef) {
    try {
      filename = await decrypter.decryptMessagePayload({
        attachmentId: parserAttachmentId(attachment),
        cipherRef: filenameCipherRef,
        message,
        payloadKind: "attachment_filename",
      });
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          feature: "ravi-mail",
          operation: "attachment_filename_decrypt",
        },
        extra: {
          attachmentId: attachment.id,
          messageId: message.id,
        },
      });
    }
  }

  return {
    contentType: attachment.contentType,
    createdAt: attachment.createdAt,
    filename,
    hasEncryptedObject: Boolean(attachment.objectCipherRef),
    hasFilename: Boolean(attachment.filenameCipherRef),
    id: attachment.id,
    messageId: attachment.messageId,
    organizationId: attachment.organizationId,
    projectId: attachment.projectId,
    sha256: attachment.sha256,
    sizeBytes: attachment.sizeBytes,
    status: attachment.status,
  };
}

function parserAttachmentId(attachment: MailAttachment): string | null {
  const metadata = attachment.metadataJson;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as { parserAttachmentId?: unknown }).parserAttachmentId;
  return typeof value === "string" && value ? value : null;
}

function toProviderCipherRef(
  cipherRef: MailCipherRef,
  payloadKind: ProviderMailCipherRef["payloadKind"],
  sizeBytes: number,
): ProviderMailCipherRef {
  return {
    scheme: "ravi-mail-cipher-ref",
    ref: cipherRef.ciphertextRef,
    payloadKind,
    keyVersion: String(cipherRef.keyVersion),
    sizeBytes,
  };
}

function normalizeMailAddress(address: string): string {
  return address.trim().toLowerCase();
}

async function hashMailAddress(address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeMailAddress(address)));
  return `sha256:${encodeBase64Url(new Uint8Array(digest))}`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function clampMessageListLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || typeof limit !== "number") return 50;
  return Math.min(Math.max(limit, 1), 100);
}

function mailServiceError(status: number, payload: ConsoleApiErrorPayload): ConsoleApiError {
  return new ConsoleApiError(status, payload);
}

function denyAllMailAccess(): MailAccessController {
  return {
    async canManageMailbox() {
      return false;
    },
    async canReadMailbox() {
      return false;
    },
    async canSendFromMailbox() {
      return false;
    },
    async resolveDefaultSendMailbox() {
      return null;
    },
  };
}

function noopAuditSink(): MailAuditSink {
  return {
    async record() {},
  };
}

function noopUsageSink(): MailUsageSink {
  return {
    async emit() {},
  };
}

function unavailableDecrypter(): MailPayloadDecrypter {
  return {
    async decryptMessagePayload() {
      console.error("Ravi Mail payload decrypter unavailable");
      Sentry.captureMessage("Ravi Mail payload decrypter unavailable", {
        level: "error",
        tags: {
          feature: "ravi-mail",
          operation: "decrypt",
          reason: "decrypter_unavailable",
        },
      });
      throw mailServiceError(403, MAIL_OPERATION_DENIED);
    },
  };
}
