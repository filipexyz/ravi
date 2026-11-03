import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import type { RecordMailMessageReceivedInboxItemInput } from "@/server/console/agent-inbox";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import { parseInboundMailAddress, parseSubaddress } from "./addressing";
import { assertNoPlaintextMailPayloadFields, type MailCipherRef } from "./storage";

export type MailInternalRouteAction = "deliver" | "reject" | "drop" | "forward";
export type MailInternalRouteMatchType = "exact" | "local_part" | "catch_all" | "pattern";

export type MailInternalDomain = {
  id: string;
  organizationId: string;
  domain: string;
  status: "pending" | "verified" | "disabled" | "deleted";
};

export type MailInternalMailbox = {
  id: string;
  organizationId: string;
  projectId: string | null;
  address: string;
  status: "active" | "disabled" | "deleted";
};

export type MailInternalRoute = {
  id: string;
  organizationId: string;
  domainId: string;
  mailboxId: string | null;
  matchType: MailInternalRouteMatchType;
  pattern: string;
  action: MailInternalRouteAction;
  priority: number;
  status: "active" | "disabled" | "deleted";
  policyJson: JsonRecord;
};

export type MailInternalMessage = {
  id: string;
  organizationId: string;
  projectId: string | null;
  mailboxId: string;
  providerAdapter: string;
  providerMessageRefHash: string | null;
};

export type MailInternalAttachmentInput = {
  attachmentId: string;
  filenameCipherRef?: MailCipherRef | null;
  objectCipherRef: MailCipherRef;
  contentType?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
  status?: "unscanned" | "available" | "quarantined" | "deleted";
  metadataJson?: JsonRecord;
};

export type MailInternalRepository = {
  findActiveDomainsByName(domain: string): Promise<MailInternalDomain[]>;
  findMailboxById(input: { mailboxId: string; organizationId: string }): Promise<MailInternalMailbox | null>;
  findMessageById(input: { messageId: string; organizationId: string }): Promise<MailInternalMessage | null>;
  findMessageByProviderRef(input: {
    organizationId: string;
    providerAdapter: string;
    providerMessageRefHash: string;
  }): Promise<MailInternalMessage | null>;
  findRouteById(input: { organizationId: string; routeId: string }): Promise<MailInternalRoute | null>;
  insertInboundMessage(input: MailInternalInsertInboundMessage): Promise<MailInternalMessage | null>;
  listActiveRoutesForDomain(input: { domainId: string; organizationId: string }): Promise<MailInternalRoute[]>;
  replaceMessageAttachments(input: {
    attachments: MailInternalAttachmentInput[];
    mailboxId: string;
    messageId: string;
    organizationId: string;
    projectId: string | null;
  }): Promise<void>;
  updateInboundMessageParsedPayloads(input: MailInternalUpdateParsedMessage): Promise<MailInternalMessage | null>;
};

export type MailInternalHooks = {
  audit?: (event: MailInternalAuditEvent) => Promise<void> | void;
  inbox?: (event: RecordMailMessageReceivedInboxItemInput) => Promise<void> | void;
  usage?: (event: MailInternalUsageEvent) => Promise<void> | void;
};

export type MailInternalRouteResolveRequest = {
  sender: string;
  recipient: string;
  rawSize: number;
  requestId?: string | null;
};

export type MailInternalRouteResolveResponse =
  | {
      status: "accept";
      action: "deliver";
      requestId: string;
      organizationId: string;
      projectId: string | null;
      mailboxId: string;
      routeId: string;
      messageId: string;
    }
  | {
      status: "drop" | "reject";
      action: "drop" | "reject";
      requestId: string;
      code: "invalid_request" | "route_not_found" | "route_drop" | "route_reject" | "route_unavailable";
    };

export type MailInternalEncryptedInboundIngestRequest = {
  addressSummaryCipherRef?: MailCipherRef | null;
  attachments?: MailInternalAttachmentInput[];
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  routeId?: string | null;
  messageId?: string | null;
  providerAdapter: string;
  providerMessageRefHash?: string | null;
  internetMessageIdHash?: string | null;
  fromHash?: string | null;
  toHashesJson?: string[];
  subjectCipherRef?: MailCipherRef | null;
  rawMimeCipherRef: MailCipherRef;
  headersCipherRef: MailCipherRef;
  parsedBodyCipherRef?: MailCipherRef | null;
  sizeBytes?: number | null;
  receivedAt?: string | null;
  requestId?: string | null;
  metadataJson?: JsonRecord;
};

export type MailInternalEncryptedInboundIngestResponse = {
  status: "ok";
  created: boolean;
  requestId: string;
  organizationId: string;
  projectId: string | null;
  mailboxId: string;
  routeId: string | null;
  messageId: string;
};

export type MailInternalInsertInboundMessage = {
  addressSummaryCipherRef: MailCipherRef | null;
  id: string;
  organizationId: string;
  projectId: string | null;
  mailboxId: string;
  direction: "inbound";
  providerAdapter: string;
  providerMessageRefHash: string | null;
  internetMessageIdHash: string | null;
  fromHash: string | null;
  toHashesJson: string[];
  subjectCipherRef: MailCipherRef | null;
  rawMimeCipherRef: MailCipherRef;
  headersCipherRef: MailCipherRef;
  parsedBodyCipherRef: MailCipherRef | null;
  status: "received";
  sizeBytes: number | null;
  receivedAt: Date | null;
  metadataJson: JsonRecord;
};

export type MailInternalUpdateParsedMessage = {
  addressSummaryCipherRef?: MailCipherRef | null;
  attachments?: MailInternalAttachmentInput[];
  organizationId: string;
  messageId: string;
  subjectCipherRef?: MailCipherRef | null;
  headersCipherRef?: MailCipherRef;
  parsedBodyCipherRef?: MailCipherRef | null;
  metadataJson?: JsonRecord;
};

export type MailInternalAuditEvent = {
  action: "mail.route.resolve" | "mail.message.ingest";
  organizationId?: string | null;
  projectId?: string | null;
  mailboxId?: string | null;
  routeId?: string | null;
  messageId?: string | null;
  requestId: string;
  status: string;
};

export type MailInternalUsageEvent = {
  metric: "mail.messages.inbound" | "mail.bytes.inbound";
  organizationId: string;
  projectId: string | null;
  mailboxId: string;
  messageId: string;
  requestId: string;
  value: number;
};

type DbExecutor = Pick<typeof db, "delete" | "insert" | "select" | "update">;

const FORBIDDEN_INGEST_PLAINTEXT_FIELDS = new Set([
  "body",
  "bytes",
  "cc",
  "bcc",
  "content",
  "from",
  "headers",
  "html",
  "filename",
  "object",
  "payload",
  "plaintext",
  "raw",
  "rawmime",
  "recipient",
  "recipients",
  "sender",
  "subject",
  "text",
  "to",
]);

export function mailInternalRepositoryForDb(database: DbExecutor = db): MailInternalRepository {
  return {
    async findActiveDomainsByName(domain) {
      return database
        .select({
          id: schema.mailDomains.id,
          organizationId: schema.mailDomains.organizationId,
          domain: schema.mailDomains.domain,
          status: schema.mailDomains.status,
        })
        .from(schema.mailDomains)
        .where(and(eq(schema.mailDomains.domain, domain), eq(schema.mailDomains.status, "verified")));
    },

    async findMailboxById(input) {
      const [mailbox] = await database
        .select({
          id: schema.mailboxes.id,
          organizationId: schema.mailboxes.organizationId,
          projectId: schema.mailboxes.projectId,
          address: schema.mailboxes.address,
          status: schema.mailboxes.status,
        })
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
        .select({
          id: schema.mailMessages.id,
          organizationId: schema.mailMessages.organizationId,
          projectId: schema.mailMessages.projectId,
          mailboxId: schema.mailMessages.mailboxId,
          providerAdapter: schema.mailMessages.providerAdapter,
          providerMessageRefHash: schema.mailMessages.providerMessageRefHash,
        })
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

    async findMessageById(input) {
      const [message] = await database
        .select({
          id: schema.mailMessages.id,
          organizationId: schema.mailMessages.organizationId,
          projectId: schema.mailMessages.projectId,
          mailboxId: schema.mailMessages.mailboxId,
          providerAdapter: schema.mailMessages.providerAdapter,
          providerMessageRefHash: schema.mailMessages.providerMessageRefHash,
        })
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

    async findRouteById(input) {
      const [route] = await database
        .select()
        .from(schema.mailRoutes)
        .where(and(eq(schema.mailRoutes.organizationId, input.organizationId), eq(schema.mailRoutes.id, input.routeId)))
        .limit(1);

      return route ?? null;
    },

    async insertInboundMessage(input) {
      const [message] = await database
        .insert(schema.mailMessages)
        .values(input)
        .onConflictDoNothing()
        .returning({
          id: schema.mailMessages.id,
          organizationId: schema.mailMessages.organizationId,
          projectId: schema.mailMessages.projectId,
          mailboxId: schema.mailMessages.mailboxId,
          providerAdapter: schema.mailMessages.providerAdapter,
          providerMessageRefHash: schema.mailMessages.providerMessageRefHash,
        });

      return message ?? null;
    },

    async replaceMessageAttachments(input) {
      await database
        .delete(schema.mailAttachments)
        .where(
          and(
            eq(schema.mailAttachments.organizationId, input.organizationId),
            eq(schema.mailAttachments.messageId, input.messageId),
          ),
        );

      if (input.attachments.length === 0) return;

      await database.insert(schema.mailAttachments).values(
        input.attachments.map((attachment) => ({
          organizationId: input.organizationId,
          projectId: input.projectId,
          mailboxId: input.mailboxId,
          messageId: input.messageId,
          filenameCipherRef: attachment.filenameCipherRef ?? null,
          contentType: normalizeOptionalText(attachment.contentType),
          sizeBytes: normalizeOptionalSize(attachment.sizeBytes),
          sha256: normalizeOptionalText(attachment.sha256),
          objectCipherRef: attachment.objectCipherRef,
          status: attachment.status ?? "unscanned",
          metadataJson: {
            ...(attachment.metadataJson ?? {}),
            parserAttachmentId: attachment.attachmentId,
          },
        })),
      );
    },

    async updateInboundMessageParsedPayloads(input) {
      const [message] = await database
        .update(schema.mailMessages)
        .set({
          ...(input.subjectCipherRef !== undefined ? { subjectCipherRef: input.subjectCipherRef } : {}),
          ...(input.headersCipherRef !== undefined ? { headersCipherRef: input.headersCipherRef } : {}),
          ...(input.parsedBodyCipherRef !== undefined ? { parsedBodyCipherRef: input.parsedBodyCipherRef } : {}),
          ...(input.addressSummaryCipherRef !== undefined
            ? { addressSummaryCipherRef: input.addressSummaryCipherRef }
            : {}),
          ...(input.metadataJson !== undefined ? { metadataJson: input.metadataJson } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.mailMessages.organizationId, input.organizationId),
            eq(schema.mailMessages.id, input.messageId),
          ),
        )
        .returning({
          id: schema.mailMessages.id,
          organizationId: schema.mailMessages.organizationId,
          projectId: schema.mailMessages.projectId,
          mailboxId: schema.mailMessages.mailboxId,
          providerAdapter: schema.mailMessages.providerAdapter,
          providerMessageRefHash: schema.mailMessages.providerMessageRefHash,
        });

      return message ?? null;
    },

    async listActiveRoutesForDomain(input) {
      return database
        .select()
        .from(schema.mailRoutes)
        .where(
          and(
            eq(schema.mailRoutes.organizationId, input.organizationId),
            eq(schema.mailRoutes.domainId, input.domainId),
            eq(schema.mailRoutes.status, "active"),
          ),
        )
        .orderBy(desc(schema.mailRoutes.priority));
    },
  };
}

export function getMailInternalControlToken() {
  return process.env.RAVI_MAIL_CONTROL_TOKEN?.trim() || null;
}

export function authorizeMailInternalRequest(request: Request, expectedToken = getMailInternalControlToken()) {
  const token = expectedToken?.trim();
  if (!token) return false;

  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const bearerToken = match?.[1]?.trim();
  if (!bearerToken) return false;

  return bearerToken.length === token.length && timingSafeStringEqual(bearerToken, token);
}

export async function resolveMailInternalRoute({
  input,
  hooks,
  repository = mailInternalRepositoryForDb(),
}: {
  input: MailInternalRouteResolveRequest;
  hooks?: MailInternalHooks;
  repository?: MailInternalRepository;
}): Promise<MailInternalRouteResolveResponse> {
  const requestId = input.requestId || randomUUID();
  if (!isNonEmptyString(input.sender) || !isValidRawSize(input.rawSize)) {
    return routeState("reject", "invalid_request", requestId);
  }

  const recipient = parseInboundMailAddress(input.recipient);
  if (!recipient.ok) return routeState("reject", "invalid_request", requestId);

  const domains = await repository.findActiveDomainsByName(recipient.domain);
  const matchedRoutes = await resolveMatchingRoutes({
    domains,
    recipientLocalPart: recipient.localPart,
    recipientAddress: recipient.address,
    repository,
  });

  const matched = matchedRoutes[0] ?? null;
  if (!matched) {
    await emitMailInternalAuditHook(hooks, {
      action: "mail.route.resolve",
      requestId,
      status: "drop:route_not_found",
    });
    return routeState("drop", "route_not_found", requestId);
  }
  if (hasAmbiguousTopRoute(matchedRoutes)) {
    await emitMailInternalAuditHook(hooks, {
      action: "mail.route.resolve",
      requestId,
      status: "reject:ambiguous_route",
    });
    return routeState("reject", "route_unavailable", requestId);
  }

  const { route } = matched;
  if (route.action === "drop") return routeState("drop", "route_drop", requestId);
  if (route.action === "reject") return routeState("reject", "route_reject", requestId);
  if (route.action !== "deliver" || !route.mailboxId) return routeState("reject", "route_unavailable", requestId);

  const mailbox = await repository.findMailboxById({
    organizationId: route.organizationId,
    mailboxId: route.mailboxId,
  });
  if (!mailbox || mailbox.status !== "active") return routeState("reject", "route_unavailable", requestId);

  const messageId = randomUUID();
  await emitMailInternalAuditHook(hooks, {
    action: "mail.route.resolve",
    organizationId: route.organizationId,
    projectId: mailbox.projectId,
    mailboxId: mailbox.id,
    routeId: route.id,
    messageId,
    requestId,
    status: "accept",
  });

  return {
    status: "accept",
    action: "deliver",
    requestId,
    organizationId: route.organizationId,
    projectId: mailbox.projectId,
    mailboxId: mailbox.id,
    routeId: route.id,
    messageId,
  };
}

export async function ingestEncryptedInboundMail({
  input,
  hooks,
  repository = mailInternalRepositoryForDb(),
}: {
  input: MailInternalEncryptedInboundIngestRequest;
  hooks?: MailInternalHooks;
  repository?: MailInternalRepository;
}): Promise<MailInternalEncryptedInboundIngestResponse> {
  const requestId = input.requestId || randomUUID();
  assertNoInboundIngestPlaintextFields(input);
  assertCipherRef(input.rawMimeCipherRef, "rawMimeCipherRef");
  assertCipherRef(input.headersCipherRef, "headersCipherRef");
  if (input.subjectCipherRef) assertCipherRef(input.subjectCipherRef, "subjectCipherRef");
  if (input.parsedBodyCipherRef) assertCipherRef(input.parsedBodyCipherRef, "parsedBodyCipherRef");
  if (input.addressSummaryCipherRef) assertCipherRef(input.addressSummaryCipherRef, "addressSummaryCipherRef");
  const attachments = normalizeAttachments(input.attachments);

  const providerAdapter = normalizeProviderAdapter(input.providerAdapter);
  const mailbox = await repository.findMailboxById({
    organizationId: input.organizationId,
    mailboxId: input.mailboxId,
  });
  if (!mailbox || mailbox.status !== "active") throw mailInternalError(404, "mail_route_unavailable");

  const projectId = input.projectId === undefined ? mailbox.projectId : input.projectId;
  if (projectId !== mailbox.projectId) throw mailInternalError(404, "mail_route_unavailable");

  const routeId: string | null = input.routeId ?? null;
  if (routeId) {
    const route = await repository.findRouteById({
      organizationId: input.organizationId,
      routeId,
    });
    if (!route || route.action !== "deliver" || route.mailboxId !== mailbox.id) {
      throw mailInternalError(404, "mail_route_unavailable");
    }
  }

  const providerMessageRefHash = normalizeOptionalHash(input.providerMessageRefHash);
  const sizeBytes = normalizeOptionalSize(input.sizeBytes);
  const receivedAt = parseOptionalDate(input.receivedAt);
  const existingById = input.messageId
    ? await repository.findMessageById({
        organizationId: input.organizationId,
        messageId: input.messageId,
      })
    : null;
  if (existingById) {
    const updated = await updateExistingInboundMessage({
      hooks,
      input,
      mailbox,
      message: existingById,
      providerAdapter,
      receivedAt,
      repository,
      requestId,
      routeId,
      sizeBytes,
    });
    return {
      status: "ok",
      created: false,
      requestId,
      organizationId: updated.organizationId,
      projectId: updated.projectId,
      mailboxId: updated.mailboxId,
      routeId,
      messageId: updated.id,
    };
  }

  if (providerMessageRefHash) {
    const existing = await repository.findMessageByProviderRef({
      organizationId: input.organizationId,
      providerAdapter,
      providerMessageRefHash,
    });
    if (existing) {
      const updated = await updateExistingInboundMessage({
        hooks,
        input,
        mailbox,
        message: existing,
        providerAdapter,
        receivedAt,
        repository,
        requestId,
        routeId,
        sizeBytes,
      });
      return {
        status: "ok",
        created: false,
        requestId,
        organizationId: updated.organizationId,
        projectId: updated.projectId,
        mailboxId: updated.mailboxId,
        routeId,
        messageId: updated.id,
      };
    }
  }

  const messageId = input.messageId || randomUUID();
  const messageInput: MailInternalInsertInboundMessage = {
    id: messageId,
    organizationId: input.organizationId,
    projectId,
    mailboxId: mailbox.id,
    direction: "inbound",
    providerAdapter,
    providerMessageRefHash,
    internetMessageIdHash: normalizeOptionalHash(input.internetMessageIdHash),
    fromHash: normalizeOptionalHash(input.fromHash),
    toHashesJson: normalizeHashList(input.toHashesJson),
    subjectCipherRef: input.subjectCipherRef ?? null,
    rawMimeCipherRef: input.rawMimeCipherRef,
    headersCipherRef: input.headersCipherRef,
    parsedBodyCipherRef: input.parsedBodyCipherRef ?? null,
    addressSummaryCipherRef: input.addressSummaryCipherRef ?? null,
    status: "received",
    sizeBytes,
    receivedAt,
    metadataJson: input.metadataJson ?? {},
  };
  const insertedMessage = await repository.insertInboundMessage(messageInput);
  if (!insertedMessage) {
    const existing = providerMessageRefHash
      ? await repository.findMessageByProviderRef({
          organizationId: input.organizationId,
          providerAdapter,
          providerMessageRefHash,
        })
      : await repository.findMessageById({
          organizationId: input.organizationId,
          messageId,
        });
    if (!existing) throw new Error("Failed to resolve concurrent encrypted inbound mail ingest.");

    const updated = await updateExistingInboundMessage({
      hooks,
      input,
      mailbox,
      message: existing,
      providerAdapter,
      receivedAt,
      repository,
      requestId,
      routeId,
      sizeBytes,
    });
    return {
      status: "ok",
      created: false,
      requestId,
      organizationId: updated.organizationId,
      projectId: updated.projectId,
      mailboxId: updated.mailboxId,
      routeId,
      messageId: updated.id,
    };
  }
  const message = insertedMessage;
  if (input.attachments !== undefined) {
    await repository.replaceMessageAttachments({
      attachments,
      organizationId: message.organizationId,
      projectId: message.projectId,
      mailboxId: message.mailboxId,
      messageId: message.id,
    });
  }

  await emitMailIngestHooks(hooks, {
    attachmentCount: attachments.length,
    created: true,
    emitInbox: shouldEmitMailInboxItem(input),
    messageId: message.id,
    organizationId: message.organizationId,
    projectId: message.projectId,
    hasEncryptedBody: Boolean(input.parsedBodyCipherRef),
    hasEncryptedSubject: Boolean(input.subjectCipherRef),
    mailboxAddress: mailbox.address,
    mailboxId: message.mailboxId,
    providerAdapter,
    receivedAt,
    routeId,
    requestId,
    sizeBytes,
  });

  return {
    status: "ok",
    created: true,
    requestId,
    organizationId: message.organizationId,
    projectId: message.projectId,
    mailboxId: message.mailboxId,
    routeId,
    messageId: message.id,
  };
}

async function updateExistingInboundMessage({
  hooks,
  input,
  mailbox,
  message,
  providerAdapter,
  receivedAt,
  repository,
  requestId,
  routeId,
  sizeBytes,
}: {
  hooks?: MailInternalHooks;
  input: MailInternalEncryptedInboundIngestRequest;
  mailbox: MailInternalMailbox;
  message: MailInternalMessage;
  providerAdapter: string;
  receivedAt: Date | null;
  repository: MailInternalRepository;
  requestId: string;
  routeId: string | null;
  sizeBytes: number | null;
}) {
  if (
    input.organizationId !== message.organizationId ||
    input.mailboxId !== message.mailboxId ||
    (input.projectId !== undefined && input.projectId !== message.projectId)
  ) {
    throw mailInternalError(404, "mail_route_unavailable");
  }

  let updated = message;
  if (input.subjectCipherRef || input.parsedBodyCipherRef || input.addressSummaryCipherRef) {
    updated =
      (await repository.updateInboundMessageParsedPayloads({
        organizationId: message.organizationId,
        messageId: message.id,
        ...(input.subjectCipherRef !== undefined ? { subjectCipherRef: input.subjectCipherRef } : {}),
        ...(input.headersCipherRef ? { headersCipherRef: input.headersCipherRef } : {}),
        ...(input.parsedBodyCipherRef !== undefined ? { parsedBodyCipherRef: input.parsedBodyCipherRef } : {}),
        ...(input.addressSummaryCipherRef !== undefined
          ? { addressSummaryCipherRef: input.addressSummaryCipherRef }
          : {}),
        metadataJson: input.metadataJson ?? {},
      })) ?? message;
  }
  const attachments = normalizeAttachments(input.attachments);
  if (input.attachments !== undefined) {
    await repository.replaceMessageAttachments({
      attachments,
      organizationId: updated.organizationId,
      projectId: updated.projectId,
      mailboxId: updated.mailboxId,
      messageId: updated.id,
    });
  }

  await emitMailIngestHooks(hooks, {
    attachmentCount: attachments.length,
    created: false,
    emitInbox: shouldEmitMailInboxItem(input),
    messageId: updated.id,
    organizationId: updated.organizationId,
    projectId: updated.projectId,
    hasEncryptedBody: Boolean(input.parsedBodyCipherRef),
    hasEncryptedSubject: Boolean(input.subjectCipherRef),
    mailboxAddress: mailbox.address,
    mailboxId: updated.mailboxId,
    providerAdapter,
    receivedAt,
    routeId,
    requestId,
    sizeBytes,
  });

  return updated;
}

async function resolveMatchingRoutes({
  domains,
  recipientAddress,
  recipientLocalPart,
  repository,
}: {
  domains: MailInternalDomain[];
  recipientAddress: string;
  recipientLocalPart: string;
  repository: MailInternalRepository;
}) {
  const subaddress = parseSubaddress(recipientLocalPart);
  const candidates: Array<{ route: MailInternalRoute; rank: number }> = [];

  for (const domain of domains) {
    const routes = await repository.listActiveRoutesForDomain({
      domainId: domain.id,
      organizationId: domain.organizationId,
    });
    for (const route of routes) {
      const rank = routeMatchRank(route, {
        baseLocalPart: subaddress.baseLocalPart,
        recipientAddress,
        recipientLocalPart,
      });
      if (rank !== null) candidates.push({ route, rank });
    }
  }

  return candidates.sort((left, right) => right.rank - left.rank || right.route.priority - left.route.priority);
}

function hasAmbiguousTopRoute(routes: Array<{ route: MailInternalRoute; rank: number }>) {
  const first = routes[0];
  const second = routes[1];
  return Boolean(first && second && first.rank === second.rank && first.route.priority === second.route.priority);
}

function routeMatchRank(
  route: MailInternalRoute,
  input: {
    baseLocalPart: string;
    recipientAddress: string;
    recipientLocalPart: string;
  },
) {
  const pattern = route.pattern.trim().toLowerCase();
  if (route.matchType === "exact") return pattern === input.recipientAddress ? 400 : null;
  if (route.matchType === "local_part") {
    return pattern === input.recipientLocalPart || pattern === input.baseLocalPart ? 300 : null;
  }
  if (route.matchType === "pattern") {
    return wildcardMatches(pattern, input.recipientAddress) || wildcardMatches(pattern, input.recipientLocalPart)
      ? 200
      : null;
  }
  return 100;
}

function wildcardMatches(pattern: string, value: string) {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function routeState(
  status: "drop" | "reject",
  code: Extract<MailInternalRouteResolveResponse, { status: "drop" | "reject" }>["code"],
  requestId: string,
): MailInternalRouteResolveResponse {
  return {
    status,
    action: status,
    requestId,
    code,
  };
}

async function emitMailIngestHooks(
  hooks: MailInternalHooks | undefined,
  input: {
    attachmentCount?: number;
    created: boolean;
    hasEncryptedBody?: boolean;
    hasEncryptedSubject?: boolean;
    emitInbox?: boolean;
    mailboxAddress?: string;
    organizationId: string;
    projectId: string | null;
    mailboxId: string;
    routeId: string | null;
    messageId: string;
    providerAdapter?: string;
    receivedAt?: Date | null;
    requestId: string;
    sizeBytes: number | null;
  },
) {
  await emitMailInternalAuditHook(hooks, {
    action: "mail.message.ingest",
    organizationId: input.organizationId,
    projectId: input.projectId,
    mailboxId: input.mailboxId,
    routeId: input.routeId,
    messageId: input.messageId,
    requestId: input.requestId,
    status: input.created ? "created" : "duplicate",
  });

  if (input.emitInbox !== false && input.mailboxAddress && input.providerAdapter) {
    await hooks?.inbox?.({
      hasEncryptedBody: Boolean(input.hasEncryptedBody),
      hasEncryptedSubject: Boolean(input.hasEncryptedSubject),
      attachmentCount: input.attachmentCount ?? 0,
      mailboxAddress: input.mailboxAddress,
      mailboxId: input.mailboxId,
      messageId: input.messageId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      providerAdapter: input.providerAdapter,
      receivedAt: input.receivedAt ?? null,
      requestId: input.requestId,
      routeId: input.routeId,
      sizeBytes: input.sizeBytes,
    });
  }

  if (!input.created) return;

  await emitMailInternalUsageHook(hooks, {
    metric: "mail.messages.inbound",
    organizationId: input.organizationId,
    projectId: input.projectId,
    mailboxId: input.mailboxId,
    messageId: input.messageId,
    requestId: input.requestId,
    value: 1,
  });

  if (input.sizeBytes !== null) {
    await emitMailInternalUsageHook(hooks, {
      metric: "mail.bytes.inbound",
      organizationId: input.organizationId,
      projectId: input.projectId,
      mailboxId: input.mailboxId,
      messageId: input.messageId,
      requestId: input.requestId,
      value: input.sizeBytes,
    });
  }
}

function shouldEmitMailInboxItem(input: MailInternalEncryptedInboundIngestRequest): boolean {
  if (!input.parsedBodyCipherRef) return false;
  return guardrailDelivery(input.metadataJson) !== "quarantine";
}

function guardrailDelivery(metadataJson: unknown): string | null {
  if (!metadataJson || typeof metadataJson !== "object" || Array.isArray(metadataJson)) return null;
  const guardrail = (metadataJson as { guardrail?: unknown }).guardrail;
  if (!guardrail || typeof guardrail !== "object" || Array.isArray(guardrail)) return null;
  const delivery = (guardrail as { delivery?: unknown }).delivery;
  return typeof delivery === "string" ? delivery : null;
}

async function emitMailInternalAuditHook(hooks: MailInternalHooks | undefined, event: MailInternalAuditEvent) {
  await hooks?.audit?.(event);
}

async function emitMailInternalUsageHook(hooks: MailInternalHooks | undefined, event: MailInternalUsageEvent) {
  await hooks?.usage?.(event);
}

function assertNoInboundIngestPlaintextFields(input: MailInternalEncryptedInboundIngestRequest) {
  assertNoPlaintextMailPayloadFields(input);
  const path = findForbiddenPlaintextFieldPath(input);
  if (path) throw mailInternalError(400, "mail_payload_not_encrypted");
}

function findForbiddenPlaintextFieldPath(value: unknown, path: string[] = []): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = findForbiddenPlaintextFieldPath(value[index], [...path, String(index)]);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
    const currentPath = [...path, key];
    if (
      FORBIDDEN_INGEST_PLAINTEXT_FIELDS.has(normalizedKey) &&
      !isAllowedSafeMetadataPlaintextField(currentPath, normalizedKey)
    ) {
      return currentPath.join(".");
    }

    const nested = findForbiddenPlaintextFieldPath(nestedValue, currentPath);
    if (nested) return nested;
  }

  return null;
}

function isAllowedSafeMetadataPlaintextField(path: string[], normalizedKey: string): boolean {
  if (normalizedKey !== "content") return false;
  const normalizedPath = path.map((part) => part.replace(/[_-]/g, "").toLowerCase());
  return (
    normalizedPath.length === 3 &&
    normalizedPath[0] === "metadatajson" &&
    normalizedPath[1] === "guardrail" &&
    normalizedPath[2] === "content"
  );
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
    throw mailInternalError(400, "mail_payload_not_encrypted", {
      [label]: "Encrypted mail payloads must be stored as cipher references.",
    });
  }
}

function normalizeProviderAdapter(value: string): string {
  if (!isNonEmptyString(value)) throw mailInternalError(400, "invalid_mail_ingest");
  return value.trim().toLowerCase();
}

function normalizeOptionalHash(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!isNonEmptyString(value)) throw mailInternalError(400, "invalid_mail_ingest");
  return value.trim();
}

function normalizeHashList(value: string[] | undefined): string[] {
  if (!value) return [];
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    throw mailInternalError(400, "invalid_mail_ingest");
  }
  return value.map((item) => item.trim());
}

function normalizeOptionalSize(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!isValidRawSize(value)) throw mailInternalError(400, "invalid_mail_ingest");
  return value;
}

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw mailInternalError(400, "invalid_mail_ingest");
  return date;
}

function normalizeAttachments(value: MailInternalAttachmentInput[] | undefined): MailInternalAttachmentInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw mailInternalError(400, "invalid_mail_ingest");
  return value.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      throw mailInternalError(400, "invalid_mail_ingest");
    }
    if (!isNonEmptyString(attachment.attachmentId)) {
      throw mailInternalError(400, "invalid_mail_ingest", {
        [`attachments.${index}.attachmentId`]: "Attachment id is required.",
      });
    }
    assertCipherRef(attachment.objectCipherRef, `attachments.${index}.objectCipherRef`);
    if (attachment.filenameCipherRef) {
      assertCipherRef(attachment.filenameCipherRef, `attachments.${index}.filenameCipherRef`);
    }
    return {
      attachmentId: attachment.attachmentId.trim(),
      filenameCipherRef: attachment.filenameCipherRef ?? null,
      objectCipherRef: attachment.objectCipherRef,
      contentType: normalizeOptionalText(attachment.contentType),
      sizeBytes: normalizeOptionalSize(attachment.sizeBytes),
      sha256: normalizeOptionalText(attachment.sha256),
      status: normalizeAttachmentStatus(attachment.status),
      metadataJson: attachment.metadataJson ?? {},
    };
  });
}

function normalizeAttachmentStatus(
  value: MailInternalAttachmentInput["status"] | undefined,
): NonNullable<MailInternalAttachmentInput["status"]> {
  if (value === undefined) return "unscanned";
  if (value === "unscanned" || value === "available" || value === "quarantined" || value === "deleted") {
    return value;
  }
  throw mailInternalError(400, "invalid_mail_ingest");
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!isNonEmptyString(value)) return null;
  return value.trim();
}

function isValidRawSize(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function mailInternalError(status: number, error: string, fieldErrors?: Record<string, string>) {
  return new ConsoleApiError(status, {
    error,
    ...(fieldErrors ? { fieldErrors } : {}),
  });
}

function timingSafeStringEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
