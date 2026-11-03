import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";

import { authenticateCliRequest, type CliAuthContext } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { parseMailAddressSummary } from "@/server/console/mail/address-summary";
import { createCloudflareMailWorkerAdapterFromEnv } from "@/server/console/mail/cloudflare-worker-adapter";
import { applyOrgSlugSuffix, validateMailboxAddress, validateMailboxLocalPart } from "@/server/console/mail/addressing";
import { getManagedMailDomains, MANAGED_MAIL_PROVIDER_ADAPTER, resolveManagedMailDomain } from "@/server/console/mail/managed-domains";
import { composeOutboundMail, MailComposeError } from "@/server/console/mail/outbound-compose";
import { createMailPayloadDecrypterFromEnv, createMailPayloadEncryptorFromEnv } from "@/server/console/mail/object-storage";
import { buildMailInboundRoutingProvider } from "@/server/console/mail/inbound-routing";
import {
  createMailConsoleMailService,
  mailServiceRepositoryForDb,
  type MailAccessController,
  type MailMessageMetadata,
  type MailServiceActor,
  type MailServiceRepository,
} from "@/server/console/mail/service";
import type { MailProviderAdapter } from "@/server/console/mail/provider-adapters";
import { mailDomainAllowsMailboxCreation, type MailDomain, type MailMessage, type Mailbox } from "@/server/console/mail/storage";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";

const mailboxCreateSchema = z.object({
  addressOrLocalPart: z.string().min(1),
  domainRef: z.string().min(1),
});

const domainCreateSchema = z.object({
  domain: z.string().min(1),
});

const messageReadSchema = z.object({
  payloadKind: z.enum(["subject", "raw_mime", "parsed_body", "headers", "address_summary"]).optional(),
});

const sendSchema = z.object({
  body: z.string(),
  from: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  subject: z.string().min(1),
  to: z.array(z.string().min(1)).min(1).max(50),
});

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const runtime = mailCliRuntime(auth);
    const searchParams = new URL(request.url).searchParams;

    if (matches(segments, "domains")) {
      return cliSuccess({
        domains: serializeMailPayload(await runtime.service.listDomains(runtime.actor)),
      });
    }

    if (matches(segments, "mailboxes")) {
      const domainRef = searchParams.get("domain");
      const mailboxes = await runtime.service.listMailboxes(runtime.actor);
      const filtered = domainRef
        ? mailboxes.filter((mailbox) => mailbox.domainId === domainRef || mailbox.address.endsWith(`@${domainRef.toLowerCase()}`))
        : mailboxes;
      return cliSuccess({
        mailboxes: serializeMailPayload(filtered.slice(0, parseLimit(searchParams))),
      });
    }

    if (matches(segments, "mailboxes", ":mailbox")) {
      const mailbox = await resolveMailbox(runtime.repository, auth.organization.id, requiredSegment(segments, 1));
      await runtime.access.canReadMailbox({ actor: runtime.actor, mailbox }).then((allowed) => {
        if (!allowed) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
      });
      return cliSuccess({ mailbox: serializeMailPayload(mailbox) });
    }

    if (matches(segments, "messages")) {
      const mailboxRef = searchParams.get("mailbox");
      if (!mailboxRef) throw cliApiError(400, "PAYLOAD_INVALID", "Missing mailbox query parameter.");
      const mailbox = await resolveMailbox(runtime.repository, auth.organization.id, mailboxRef);
      const messages = await runtime.service.listMessageMetadata(runtime.actor, {
        mailboxId: mailbox.id,
        limit: parseLimit(searchParams),
      });
      return cliSuccess({
        messages: serializeMailPayload(await maybeAttachAddressSummaries(runtime, messages, searchParams)),
      });
    }

    if (matches(segments, "messages", ":message")) {
      const message = await resolveMessage(runtime.repository, auth.organization.id, requiredSegment(segments, 1));
      const mailbox = await resolveMailbox(runtime.repository, auth.organization.id, message.mailboxId);
      await runtime.access.canReadMailbox({ actor: runtime.actor, mailbox }).then((allowed) => {
        if (!allowed) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
      });
      return cliSuccess({
        message: serializeMailPayload(
          await maybeAttachAddressSummary(runtime, mailMessageMetadata(message), searchParams),
        ),
      });
    }

    if (matches(segments, "messages", ":message", "attachments")) {
      const attachments = await runtime.service.listMessageAttachments(runtime.actor, {
        messageId: requiredSegment(segments, 1),
      });
      return cliSuccess({
        attachments: serializeMailPayload(attachments),
      });
    }

    throw cliApiError(404, "PAYLOAD_INVALID", "Unknown mail CLI route.");
  } catch (error) {
    return cliFailure(mailCliError(error), requestId);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const runtime = mailCliRuntime(auth);

    if (matches(segments, "domains")) {
      assertMailWriteRole(auth);
      const body = domainCreateSchema.parse(await readJsonBody(request, requestId));
      const managedDomain = resolveManagedMailDomain(body.domain);
      const existing = await runtime.repository.findDomainByName({
        organizationId: auth.organization.id,
        domain: managedDomain,
      });
      const domain =
        existing ??
        (await runtime.service.createDomain(runtime.actor, {
          domain: managedDomain,
          providerAdapter: MANAGED_MAIL_PROVIDER_ADAPTER,
          status: "verified",
          authStatusJson: { mode: "ravi_managed" },
          dnsStatusJson: { mode: "ravi_managed" },
          metadataJson: { managed: true },
        }));

      return cliSuccess({ domain: serializeMailPayload(domain) }, { status: existing ? 200 : 201 });
    }

    if (matches(segments, "mailboxes")) {
      assertMailWriteRole(auth);
      const body = mailboxCreateSchema.parse(await readJsonBody(request, requestId));
      const domain = await resolveDomain(runtime.repository, auth.organization.id, body.domainRef);
      const baseLocalPart = localPartFromInput(body.addressOrLocalPart, domain);
      const localPart = mailDomainUsesManagedLocalPartSuffix(domain)
        ? applyOrgSlugSuffix(baseLocalPart, auth.organization.slug)
        : baseLocalPart;
      const validated = validateMailboxLocalPart(localPart);
      if (!validated.ok) throw cliApiError(400, "PAYLOAD_INVALID", "Mailbox address is unavailable.");
      const mailbox = await runtime.service.createMailbox(runtime.actor, {
        domainId: domain.id,
        localPart,
        createdByUserId: auth.user.id,
        defaultVisibility: "private",
        keyScope: "mailbox",
      });
      const route = await runtime.service.createRoute(runtime.actor, {
        action: "deliver",
        domainId: domain.id,
        mailboxId: mailbox.id,
        matchType: "local_part",
        pattern: mailbox.localPart,
        priority: 100,
      });

      return cliSuccess({ mailbox: serializeMailPayload(mailbox), route: serializeMailPayload(route) }, { status: 201 });
    }

    if (matches(segments, "mailboxes", ":mailbox", "disable")) {
      assertMailWriteRole(auth);
      const mailbox = await resolveMailbox(runtime.repository, auth.organization.id, requiredSegment(segments, 1));
      const result = await runtime.service.disableMailbox(runtime.actor, {
        mailboxId: mailbox.id,
      });
      return cliSuccess({
        disabledRoutes: result.disabledRoutes.map((route) => ({
          action: route.action,
          id: route.id,
          matchType: route.matchType,
          pattern: route.pattern,
          status: route.status,
        })),
        mailbox: serializeMailPayload(result.mailbox),
        providerSynced: result.providerSynced,
      });
    }

    if (matches(segments, "messages", ":message", "read")) {
      const body = messageReadSchema.parse(await readJsonBody(request, requestId));
      const result = await runtime.service.decryptMessagePayload(runtime.actor, {
        messageId: requiredSegment(segments, 1),
        payloadKind: body.payloadKind ?? "parsed_body",
      });
      return cliSuccess(result);
    }

    if (matches(segments, "send")) {
      assertMailWriteRole(auth);
      const encryptor = createMailPayloadEncryptorFromEnv();
      if (!encryptor) {
        throw cliApiError(503, "SERVER_UNAVAILABLE", "Ravi Mail encryption storage is not configured.");
      }

      const body = sendSchema.parse(await readJsonBody(request, requestId));
      const fromMailbox = await resolveOutboundMailbox({
        actor: runtime.actor,
        bodyFrom: body.from,
        repository: runtime.repository,
        organizationId: auth.organization.id,
        access: runtime.access,
      });
      const messageId = randomUUID();
      const composed = composeOutboundMail({
        bodyText: body.body,
        from: fromMailbox.address,
        messageId,
        subject: body.subject,
        to: body.to,
      });
      const [rawMime, headers, addressSummary, subject] = await Promise.all([
        encryptor.encryptMessagePayload({
          direction: "outbound",
          organizationId: auth.organization.id,
          projectId: fromMailbox.projectId,
          mailboxId: fromMailbox.id,
          messageId,
          payloadKind: "raw_mime",
          plaintext: composed.rawMime,
        }),
        encryptor.encryptMessagePayload({
          direction: "outbound",
          organizationId: auth.organization.id,
          projectId: fromMailbox.projectId,
          mailboxId: fromMailbox.id,
          messageId,
          payloadKind: "headers",
          plaintext: composed.headersJson,
        }),
        encryptor.encryptMessagePayload({
          direction: "outbound",
          organizationId: auth.organization.id,
          projectId: fromMailbox.projectId,
          mailboxId: fromMailbox.id,
          messageId,
          payloadKind: "address_summary",
          plaintext: composed.addressSummaryJson,
        }),
        encryptor.encryptMessagePayload({
          direction: "outbound",
          organizationId: auth.organization.id,
          projectId: fromMailbox.projectId,
          mailboxId: fromMailbox.id,
          messageId,
          payloadKind: "subject",
          plaintext: composed.subject,
        }),
      ]);
      const result = await runtime.service.sendOutbound(runtime.actor, {
        fromMailboxId: fromMailbox.id,
        fromAddress: fromMailbox.address,
        addressSummaryCipherRef: addressSummary.cipherRef,
        headersCipherRef: headers.cipherRef,
        idempotencyKey: body.idempotencyKey ?? `cli:${messageId}`,
        messageId,
        providerPayload: {
          subject: composed.subject,
          text: composed.text,
        },
        rawMimeCipherRef: rawMime.cipherRef,
        sizeBytes: rawMime.plaintextSizeBytes,
        subjectCipherRef: subject.cipherRef,
        to: composed.recipients,
      });

      return cliSuccess({ sent: serializeMailPayload(result) }, { status: 201 });
    }

    throw cliApiError(404, "PAYLOAD_INVALID", "Unknown mail CLI route.");
  } catch (error) {
    return cliFailure(mailCliError(error), requestId);
  }
}

function mailCliRuntime(auth: CliAuthContext) {
  assertMailReadRole(auth);
  const repository = mailServiceRepositoryForDb();
  const actor = {
    actorId: auth.user.id,
    organizationId: auth.organization.id,
  } satisfies MailServiceActor;
  const access = cliMailAccessController(auth, repository);

  return {
    actor,
    access,
    repository,
    service: createMailConsoleMailService({
      access,
      adapters: createMailAdapterRegistry(),
      decrypter: createMailPayloadDecrypterFromEnv() ?? undefined,
      inboundProvider: buildMailInboundRoutingProvider(),
      repository,
    }),
  };
}

function createMailAdapterRegistry(): Map<string, MailProviderAdapter> {
  const adapter = createCloudflareMailWorkerAdapterFromEnv();
  return adapter ? new Map([[adapter.name, adapter]]) : new Map();
}

function cliMailAccessController(auth: CliAuthContext, repository: MailServiceRepository): MailAccessController {
  const role = parseConsoleRole(auth.membership.role);
  const canRead = role === "owner" || role === "admin" || role === "developer" || role === "viewer";
  const canWrite = role === "owner" || role === "admin" || role === "developer";

  return {
    async canManageMailbox({ actor, mailbox }) {
      return canWrite && actor.organizationId === mailbox.organizationId;
    },
    async canReadMailbox({ actor, mailbox }) {
      return canRead && actor.organizationId === mailbox.organizationId;
    },
    async canSendFromMailbox({ actor, mailbox }) {
      return canWrite && actor.organizationId === mailbox.organizationId;
    },
    async resolveDefaultSendMailbox({ actor, projectId }) {
      if (!canWrite) return null;
      const mailboxes = await repository.listMailboxes({
        organizationId: actor.organizationId,
        projectId: projectId === undefined ? undefined : projectId,
      });
      return mailboxes.find((mailbox) => mailbox.status === "active")?.id ?? null;
    },
  };
}

async function resolveDomain(
  repository: MailServiceRepository,
  organizationId: string,
  domainRef: string,
): Promise<MailDomain> {
  const normalized = domainRef.trim().toLowerCase();
  const domain =
    (isUuid(normalized) ? await repository.findDomainById({ organizationId, domainId: normalized }) : null) ??
    (await repository.findDomainByName({ organizationId, domain: normalized }));
  if (!domain || !mailDomainAllowsMailboxCreation(domain)) {
    throw cliApiError(400, "PAYLOAD_INVALID", "Mail domain is unavailable.");
  }
  return domain;
}

async function resolveMailbox(
  repository: MailServiceRepository,
  organizationId: string,
  mailboxRef: string,
): Promise<Mailbox> {
  const normalized = mailboxRef.trim().toLowerCase();
  const mailbox = normalized.includes("@")
    ? await repository.findMailboxByAddress({ organizationId, address: normalized })
    : isUuid(normalized)
      ? await repository.findMailboxById({ organizationId, mailboxId: normalized })
      : null;
  if (!mailbox) throw cliApiError(400, "PAYLOAD_INVALID", "Mailbox is unavailable.");
  return mailbox;
}

async function resolveMessage(
  repository: MailServiceRepository,
  organizationId: string,
  messageId: string,
): Promise<MailMessage> {
  if (!isUuid(messageId)) throw cliApiError(400, "PAYLOAD_INVALID", "Message is unavailable.");
  const message = await repository.findMessageById({ organizationId, messageId });
  if (!message) throw cliApiError(400, "PAYLOAD_INVALID", "Message is unavailable.");
  return message;
}

async function resolveOutboundMailbox({
  access,
  actor,
  bodyFrom,
  organizationId,
  repository,
}: {
  access: MailAccessController;
  actor: MailServiceActor;
  bodyFrom?: string;
  organizationId: string;
  repository: MailServiceRepository;
}): Promise<Mailbox> {
  if (bodyFrom) return resolveMailbox(repository, organizationId, bodyFrom);

  const mailboxId = await access.resolveDefaultSendMailbox({ actor });
  if (!mailboxId) {
    throw cliApiError(400, "PAYLOAD_INVALID", "No default mailbox is available. Pass --from.");
  }
  return resolveMailbox(repository, organizationId, mailboxId);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function localPartFromInput(addressOrLocalPart: string, domain: MailDomain) {
  const value = addressOrLocalPart.trim().toLowerCase();
  if (!value.includes("@")) return value;

  const parsed = validateMailboxAddress(value);
  if (!parsed.ok || parsed.domain !== domain.domain) {
    throw cliApiError(400, "PAYLOAD_INVALID", "Mailbox address is unavailable.");
  }
  return parsed.localPart;
}

function mailDomainUsesManagedLocalPartSuffix(domain: MailDomain) {
  const metadata = record(domain.metadataJson);
  const authStatus = record(domain.authStatusJson);
  if (
    metadata.managed === false ||
    metadata.ownershipMode === "customer_managed" ||
    authStatus.mode === "customer_managed"
  ) {
    return false;
  }
  if (metadata.managed === true || authStatus.mode === "ravi_managed") return true;
  return getManagedMailDomains().has(domain.domain);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseLimit(searchParams: URLSearchParams) {
  const raw = searchParams.get("limit");
  if (!raw) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) throw cliApiError(400, "PAYLOAD_INVALID", "Invalid limit.");
  return Math.min(limit, 100);
}

async function maybeAttachAddressSummaries(
  runtime: ReturnType<typeof mailCliRuntime>,
  messages: MailMessageMetadata[],
  searchParams: URLSearchParams,
): Promise<MailMessageMetadata[]> {
  if (!includeAddressSummaries(searchParams)) return messages;
  return Promise.all(messages.map((message) => maybeAttachAddressSummary(runtime, message, searchParams)));
}

async function maybeAttachAddressSummary(
  runtime: ReturnType<typeof mailCliRuntime>,
  message: MailMessageMetadata,
  searchParams: URLSearchParams,
): Promise<MailMessageMetadata> {
  if (!includeAddressSummaries(searchParams) || !message.hasAddressSummary) return message;
  const payload = await runtime.service.decryptMessagePayload(runtime.actor, {
    messageId: message.id,
    payloadKind: "address_summary",
  });
  return {
    ...message,
    addressSummary: parseMailAddressSummary(payload.plaintext),
  };
}

function includeAddressSummaries(searchParams: URLSearchParams): boolean {
  const value = searchParams.get("addresses");
  return value === "1" || value === "true" || value === "yes";
}

function matches(segments: string[], ...pattern: string[]) {
  if (segments.length !== pattern.length) return false;
  return pattern.every((part, index) => part.startsWith(":") || segments[index] === part);
}

function requiredSegment(segments: string[], index: number) {
  const segment = segments[index];
  if (!segment) throw cliApiError(400, "PAYLOAD_INVALID", "Missing mail route segment.");
  return segment;
}

function assertMailReadRole(auth: CliAuthContext) {
  const role = parseConsoleRole(auth.membership.role);
  if (role !== "owner" && role !== "admin" && role !== "developer" && role !== "viewer") {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
}

function assertMailWriteRole(auth: CliAuthContext) {
  const role = parseConsoleRole(auth.membership.role);
  if (role !== "owner" && role !== "admin" && role !== "developer") {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
}

function mailCliError(error: unknown) {
  if (error instanceof MailComposeError) return cliApiError(400, "PAYLOAD_INVALID", "Invalid outbound mail payload.");
  if (error instanceof z.ZodError) return cliApiError(400, "PAYLOAD_INVALID");
  if (error instanceof ConsoleApiError) {
    const reason = fieldErrorReason(error.payload.fieldErrors);
    console.error("Ravi Mail CLI operation failed", {
      status: error.status,
      error: error.payload.error,
      fieldErrors: error.payload.fieldErrors,
    });
    Sentry.captureMessage("Ravi Mail CLI operation failed", {
      level: error.status >= 500 ? "error" : "warning",
      tags: {
        feature: "ravi-mail",
        surface: "cli",
        status: String(error.status),
        error: error.payload.error,
        reason: reason ?? "unknown",
      },
      contexts: {
        cli: {
          status: error.status,
          error: error.payload.error,
          reason: reason ?? null,
        },
      },
    });
    if (error.status === 400 || error.status === 404 || error.status === 409) {
      return cliApiError(400, "PAYLOAD_INVALID", "Mail resource is unavailable.");
    }
    if (error.status === 403) return cliApiError(403, "PROJECT_ACCESS_DENIED");
    return cliApiError(503, "SERVER_UNAVAILABLE");
  }
  return error;
}

function fieldErrorReason(fieldErrors: unknown): string | undefined {
  if (!fieldErrors || typeof fieldErrors !== "object") return undefined;
  const reason = (fieldErrors as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

function mailMessageMetadata(message: MailMessage): MailMessageMetadata {
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

function serializeMailPayload(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeMailPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeMailPayload(item)]));
  }
  return value;
}
