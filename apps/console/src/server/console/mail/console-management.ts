import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  getManagedMailDomains,
  MANAGED_MAIL_PROVIDER_ADAPTER,
  resolveManagedMailDomain,
} from "@/server/console/mail/managed-domains";
import {
  mailDomainAllowsMailboxCreation,
  type MailDomain,
} from "@/server/console/mail/storage";
import {
  createMailConsoleMailService,
  mailServiceRepositoryForDb,
  type MailAccessController,
  type MailServiceActor,
  type MailServiceRepository,
} from "@/server/console/mail/service";
import { applyOrgSlugSuffix, validateMailboxAddress, validateMailboxLocalPart } from "@/server/console/mail/addressing";
import { buildMailInboundRoutingProvider } from "@/server/console/mail/inbound-routing";
import { assertProjectAccess, findAccessibleProjectRecord } from "@/server/console/project-access";
import { parseConsoleRole, type ConsoleWorkspace } from "@/server/console/workspace";

const createDomainSchema = z.object({
  domain: z.string().min(1),
});

const createMailboxSchema = z.object({
  agentId: z.string().trim().min(1).max(160).optional(),
  domainRef: z.string().min(1),
  localPart: z.string().min(1),
  projectRef: z.string().min(1).optional(),
});

export async function createConsoleMailDomain({
  body,
  workspace,
}: {
  body: unknown;
  workspace: ConsoleWorkspace;
}) {
  assertMailManageRole(workspace);
  const input = createDomainSchema.parse(body);
  const repository = mailServiceRepositoryForDb();
  const runtime = consoleMailRuntime(workspace, repository);
  const domainName = resolveManagedMailDomain(input.domain);
  const existing = await repository.findDomainByName({
    domain: domainName,
    organizationId: workspace.organization.id,
  });
  if (existing) return { domain: existing };

  const domain = await runtime.service.createDomain(runtime.actor, {
    domain: domainName,
    providerAdapter: MANAGED_MAIL_PROVIDER_ADAPTER,
    status: "verified",
    authStatusJson: { mode: "ravi_managed" },
    dnsStatusJson: { mode: "ravi_managed" },
    metadataJson: { managed: true },
  });

  return { domain };
}

export async function createConsoleMailbox({
  body,
  projectRef,
  workspace,
}: {
  body: unknown;
  projectRef?: string;
  workspace: ConsoleWorkspace;
}) {
  assertMailManageRole(workspace);
  const input = createMailboxSchema.parse(body);
  const repository = mailServiceRepositoryForDb();
  const runtime = consoleMailRuntime(workspace, repository);
  const domain = await resolveDomain(repository, workspace.organization.id, input.domainRef);
  const targetProjectRef = projectRef ?? input.projectRef;
  const project = targetProjectRef
    ? await findAccessibleProjectRecord(workspace, targetProjectRef, "write")
    : null;
  if (targetProjectRef && !project) throw new ConsoleApiError(404, { error: "mail_resource_unavailable" });
  if (project) await assertProjectAccess(workspace, project.id, "write");

  const baseLocalPart = localPartFromInput(input.localPart, domain.domain);
  const localPart = mailDomainUsesManagedLocalPartSuffix(domain)
    ? applyOrgSlugSuffix(baseLocalPart, workspace.organization.slug)
    : baseLocalPart;
  const validated = validateMailboxLocalPart(localPart);
  if (!validated.ok) {
    throw new ConsoleApiError(409, {
      error: "mail_address_unavailable",
      fieldErrors: { localPart: "This email address is unavailable." },
    });
  }
  const mailbox = await runtime.service.createMailbox(runtime.actor, {
    agentId: input.agentId?.trim() || null,
    createdByUserId: workspace.user.id,
    defaultVisibility: "private",
    domainId: domain.id,
    keyScope: input.agentId ? "agent" : "mailbox",
    localPart,
    metadataJson: input.agentId ? { agentId: input.agentId.trim(), createdFrom: "console" } : { createdFrom: "console" },
    projectId: project?.id ?? null,
  });
  const route = await runtime.service.createRoute(runtime.actor, {
    action: "deliver",
    domainId: domain.id,
    mailboxId: mailbox.id,
    matchType: "local_part",
    pattern: mailbox.localPart,
    priority: 100,
  });

  return { mailbox, route };
}

function consoleMailRuntime(workspace: ConsoleWorkspace, repository: MailServiceRepository) {
  const actor = {
    actorId: workspace.user.id,
    organizationId: workspace.organization.id,
  } satisfies MailServiceActor;
  const access = consoleMailAccessController(workspace);

  return {
    actor,
    service: createMailConsoleMailService({
      access,
      repository,
      inboundProvider: buildMailInboundRoutingProvider(),
    }),
  };
}

function consoleMailAccessController(workspace: ConsoleWorkspace): MailAccessController {
  const role = parseConsoleRole(workspace.membership.role);
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
      const mailboxes = await mailServiceRepositoryForDb().listMailboxes({
        organizationId: actor.organizationId,
        projectId: projectId === undefined ? undefined : projectId,
      });
      return mailboxes.find((mailbox) => mailbox.status === "active")?.id ?? null;
    },
  };
}

function resolveDomain(repository: MailServiceRepository, organizationId: string, domainRef: string) {
  const normalized = domainRef.trim().toLowerCase();
  return Promise.resolve()
    .then(async () => {
      const domain =
        (isUuid(normalized) ? await repository.findDomainById({ organizationId, domainId: normalized }) : null) ??
        (await repository.findDomainByName({ organizationId, domain: normalized }));
      if (!domain || !mailDomainAllowsMailboxCreation(domain)) {
        throw new ConsoleApiError(400, { error: "mail_resource_unavailable" });
      }
      return domain;
    });
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

function localPartFromInput(value: string, domain: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized.includes("@")) return normalized;

  const parsed = validateMailboxAddress(normalized);
  if (!parsed.ok || parsed.domain !== domain) {
    throw new ConsoleApiError(409, {
      error: "mail_address_unavailable",
      fieldErrors: { localPart: "This email address is unavailable." },
    });
  }
  return parsed.localPart;
}

function assertMailManageRole(workspace: ConsoleWorkspace) {
  const role = parseConsoleRole(workspace.membership.role);
  if (role !== "owner" && role !== "admin" && role !== "developer") {
    throw new ConsoleApiError(403, { error: "forbidden" });
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
