import { createHash } from "node:crypto";
import { and, desc, eq, inArray, ne } from "drizzle-orm";

import { cliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import {
  getProviderDefinition,
  getProviderEventDefinition,
  getProviderEventTypes,
  normalizeProviderEventTypes,
  providerConnectorEventType,
  providerHasImplementedWatchEvents,
  watchEventSubject,
  type ProviderDefinition,
} from "@/shared/integrations/provider-registry";

import { upsertGlobalInboxSubscription } from "./agent-inbox";
import { listOrganizationGithubConnections } from "./github-app";
import {
  findAccessibleProjectRecord,
  listAccessibleProjectRecords,
} from "./project-access";

export type ConsoleWatchWorkspace = {
  authorization?: import("./authorization/identity").AuthorizationActor["delegation"];
  user: { id: string };
  organization: { id: string; name: string; slug: string };
  membership: { role: string };
  localInstallation: {
    id: string;
    name: string;
    capabilitiesJson: string[];
  };
};

export type WatchPlacement = "auto" | "console" | "local";

export type CreateConsoleWatchInput = {
  clientRequestId?: string | null;
  delivery?: JsonRecord | null;
  description?: string | null;
  eventTypes: string[];
  filters?: JsonRecord | null;
  name?: string | null;
  owner?: string | null;
  placement?: WatchPlacement | null;
  projectId?: string | null;
  projectRef?: string | null;
  provider: string;
  providerConnectionId?: string | null;
  providerInstallationId?: string | null;
  providerResource?: {
    fullName?: string | null;
    owner?: string | null;
    ref?: string | null;
    repo?: string | null;
    resourceRef?: string | null;
  } | null;
  providerResourceId?: string | null;
  repo?: string | null;
  resourceRef?: string | null;
};

export type UpdateConsoleWatchInput = {
  delivery?: JsonRecord | null;
  description?: string | null;
  eventTypes?: string[] | null;
  filters?: JsonRecord | null;
  name?: string | null;
};

const GITHUB_PROVIDER = getProviderDefinition("github")!;

export const SUPPORTED_GITHUB_WATCH_EVENTS = getProviderEventTypes(
  GITHUB_PROVIDER,
  { implementedOnly: true },
);

type ProviderConnectionRecord = typeof schema.providerConnections.$inferSelect;

type WatchProviderResource = {
  providerResourceId: string;
  providerResourceJson: JsonRecord;
  resourceRef: string;
};

type WatchProviderAdapter = {
  listConnections(input: {
    workspace: ConsoleWatchWorkspace;
  }): Promise<ProviderConnectionRecord[]>;
  resolveConnection(input: {
    providerConnectionId?: string | null;
    providerInstallationId?: string | null;
    resourceRef?: string | null;
    workspace: ConsoleWatchWorkspace;
  }): Promise<ProviderConnectionRecord>;
  resolveProviderInstallationId(input: {
    body: CreateConsoleWatchInput;
    connection: ProviderConnectionRecord;
  }): string | null;
  resolveResource(input: {
    body: CreateConsoleWatchInput;
    connection: ProviderConnectionRecord;
  }): WatchProviderResource;
};

const watchProviderAdapters: Record<string, WatchProviderAdapter> = {
  github: {
    listConnections: listGithubProviderConnections,
    resolveConnection: resolveGithubProviderConnection,
    resolveProviderInstallationId({ body, connection }) {
      return body.providerInstallationId ?? githubInstallationId(connection);
    },
    resolveResource({ body, connection }) {
      return resolveGithubWatchResource(connection, body);
    },
  },
};

export async function listWatchCapabilities(input: {
  eventTypes?: string[];
  projectRef?: string | null;
  provider?: string | null;
  workspace: ConsoleWatchWorkspace;
}) {
  const { adapter, providerDefinition } = requireWatchProviderAdapter(input.provider ?? "github");
  const provider = providerDefinition.id;

  const requestedEventTypes = input.eventTypes?.length
    ? normalizeProviderEventTypes(providerDefinition, input.eventTypes)
    : getProviderEventTypes(providerDefinition, { implementedOnly: true });
  const supported = new Set<string>(getProviderEventTypes(providerDefinition, { implementedOnly: true }));
  const unsupportedEventTypes = requestedEventTypes.filter((eventType) => !supported.has(eventType));
  const supportedRequestedEventTypes = requestedEventTypes.filter((eventType) => supported.has(eventType));
  const project = input.projectRef
    ? await requireProject(input.workspace, input.projectRef, "read")
    : null;
  const connections = await adapter.listConnections({ workspace: input.workspace });
  const hasConnection = connections.length > 0;
  const hasInboxScope = input.workspace.localInstallation.capabilitiesJson.includes("console.inbox.subscribe");
  const missing = [
    ...(hasConnection ? [] : ["INSTALLATION_MISSING"]),
    ...(hasInboxScope ? [] : ["INBOX_SUBSCRIPTION_MISSING"]),
  ];
  const events = supportedRequestedEventTypes.map((eventType) => {
    const definition = getProviderEventDefinition(providerDefinition, eventType);
    if (!definition) throw cliApiError(422, "WATCH_UNSUPPORTED_EVENT", `Unsupported watch event: ${eventType}`);
    return {
      eventType,
      placements: ["console"],
      recommendedPlacement: "console",
      missing,
      category: definition.category,
      deliveryModes: [...definition.deliveryModes],
      fidelity: definition.fidelity,
      requiredCapabilities: [...definition.requiredCapabilities],
      requiredProviderPermissions: [...definition.requiredProviderPermissions],
      resourceTypes: [...definition.resourceTypes],
      webhookOnly: definition.deliveryModes.length === 1 && definition.deliveryModes[0] === "webhook",
    };
  });
  const eventTypes = Object.fromEntries(
    events.flatMap(({ eventType, ...event }) => [
      [eventType, event],
      [providerConnectorEventType(providerDefinition, eventType), event],
    ]),
  );

  return {
    version: 1,
    provider,
    available: hasConnection && hasInboxScope && unsupportedEventTypes.length === 0,
    recommendedPlacement: hasConnection && hasInboxScope ? "console" : null,
    placements: ["console"],
    supportedEventTypes: getProviderEventTypes(providerDefinition, { implementedOnly: true }),
    unsupportedEventTypes,
    inboxAvailable: hasInboxScope,
    installNeeded: !hasConnection,
    missing,
    missingCapabilities: hasInboxScope ? [] : ["console.inbox.subscribe"],
    missingPermissions: [],
    events,
    eventTypes,
  };
}

export async function listGithubInstallations(input: {
  projectRef?: string | null;
  workspace: ConsoleWatchWorkspace;
}) {
  // Installations are the organization's; a project still has to be one this person can open.
  if (input.projectRef) await requireProject(input.workspace, input.projectRef, "read");
  const connections = await listGithubProviderConnections({ workspace: input.workspace });

  return {
    version: 1,
    provider: "github",
    installations: connections.map((connection) => githubInstallationResponse(connection)),
    missing: connections.length === 0 ? ["INSTALLATION_MISSING"] : [],
  };
}

export async function listGithubInstallationRepos(input: {
  installationId: string;
  projectRef?: string | null;
  workspace: ConsoleWatchWorkspace;
}) {
  // Installations are the organization's; a project still has to be one this person can open.
  if (input.projectRef) await requireProject(input.workspace, input.projectRef, "read");
  const connections = await listGithubProviderConnections({ workspace: input.workspace });
  const connection = connections.find((candidate) => githubInstallationId(candidate) === input.installationId);
  if (!connection) {
    throw cliApiError(409, "INSTALLATION_MISSING");
  }

  return {
    version: 1,
    provider: "github",
    installationId: input.installationId,
    repos: githubSelectedRepositories(connection),
    missing: githubSelectedRepositories(connection).length === 0 ? ["REPO_NOT_SELECTED"] : [],
  };
}

export async function createConsoleWatch(input: {
  body: CreateConsoleWatchInput;
  requestId: string;
  workspace: ConsoleWatchWorkspace;
}) {
  const provider = normalizeProvider(input.body.provider);
  const { adapter, providerDefinition } = requireWatchProviderAdapter(provider);

  const effectivePlacement = effectiveConsolePlacement(input.body.placement ?? "auto");
  const eventTypes = normalizeProviderWatchEventTypes(providerDefinition, input.body.eventTypes);
  const projectRef = input.body.projectRef ?? input.body.projectId ?? null;
  const project = projectRef
    ? await requireProject(input.workspace, projectRef, "write")
    : null;

  const connection = await adapter.resolveConnection({
    providerConnectionId: input.body.providerConnectionId ?? null,
    providerInstallationId: input.body.providerInstallationId ?? null,
    resourceRef: normalizeResourceRef({
      owner: input.body.owner ?? null,
      providerResource: input.body.providerResource ?? null,
      repo: input.body.repo ?? null,
      resourceRef: input.body.resourceRef ?? null,
    }) ?? input.body.providerResourceId ?? null,
    workspace: input.workspace,
  });
  // GitHub installations belong to the organization: without --project the
  // watch is the organization's, which needs an organization write role.
  const effectiveProject = project
    ?? (connection.projectId ? await requireProject(input.workspace, connection.projectId, "write") : null);
  requireOrganizationWatchWrite(input.workspace, effectiveProject?.id ?? null);
  const providerInstallationId = adapter.resolveProviderInstallationId({
    body: input.body,
    connection,
  });
  if (!providerInstallationId) throw cliApiError(409, "INSTALLATION_MISSING");

  const delivery = await resolveWatchDelivery({
    delivery: input.body.delivery ?? null,
    workspace: input.workspace,
  });
  const filters = input.body.filters ?? {};
  const providerResource = adapter.resolveResource({
    body: input.body,
    connection,
  });
  const watchKey = buildConsoleWatchKey({
    delivery,
    eventTypes,
    filters,
    placement: effectivePlacement,
    projectId: effectiveProject?.id ?? null,
    provider,
    providerConnectionId: connection.id,
    providerInstallationId,
    providerResourceId: providerResource.providerResourceId,
    resourceRef: providerResource.resourceRef,
  });
  const now = new Date();

  const [created] = await db
    .insert(schema.consoleWatches)
    .values({
      organizationId: input.workspace.organization.id,
      projectId: effectiveProject?.id ?? null,
      createdByUserId: input.workspace.user.id,
      localInstallationId: input.workspace.localInstallation.id,
      provider,
      placement: effectivePlacement,
      providerConnectionId: connection.id,
      providerInstallationId,
      providerResourceId: providerResource.providerResourceId,
      resourceRef: providerResource.resourceRef,
      watchKey,
      name: cleanText(input.body.name, 160),
      description: cleanText(input.body.description, 500),
      eventTypesJson: eventTypes,
      filtersJson: filters,
      deliveryJson: delivery,
      status: "active",
      metadataJson: {
        clientRequestId: cleanText(input.body.clientRequestId, 160),
        providerResource: providerResource.providerResourceJson,
        source: "cli-watch",
      },
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    await auditWatchEvent({
      action: "watch.created",
      requestId: input.requestId,
      watch: created,
      workspace: input.workspace,
    });
    return { created: true, watch: watchResponse(created), statusUrl: `/api/cli/watches/${created.id}/status` };
  }

  const existing = await findWatchByKey(input.workspace, watchKey);
  if (!existing) throw cliApiError(409, "WATCH_ALREADY_EXISTS");
  const [reactivated] = await db
    .update(schema.consoleWatches)
    .set({
      status: "active",
      localInstallationId: input.workspace.localInstallation.id,
      disabledAt: null,
      deletedAt: null,
      updatedAt: now,
    })
    .where(eq(schema.consoleWatches.id, existing.id))
    .returning();
  const watch = reactivated ?? existing;

  await auditWatchEvent({
    action: "watch.create_idempotent",
    requestId: input.requestId,
    watch,
    workspace: input.workspace,
  });
  return { created: false, watch: watchResponse(watch), statusUrl: `/api/cli/watches/${watch.id}/status` };
}

export async function listConsoleWatches(input: {
  projectRef?: string | null;
  provider?: string | null;
  status?: string | null;
  workspace: ConsoleWatchWorkspace;
}) {
  const predicates = [
    eq(schema.consoleWatches.organizationId, input.workspace.organization.id),
    eq(schema.consoleWatches.localInstallationId, input.workspace.localInstallation.id),
    ne(schema.consoleWatches.status, "deleted"),
  ];

  if (input.provider) predicates.push(eq(schema.consoleWatches.provider, normalizeProvider(input.provider)));
  if (input.status) predicates.push(eq(schema.consoleWatches.status, normalizeWatchStatus(input.status)));

  if (input.projectRef) {
    const project = await requireProject(input.workspace, input.projectRef, "read");
    predicates.push(eq(schema.consoleWatches.projectId, project.id));
  } else {
    const projects = await listAccessibleProjectRecords(input.workspace);
    if (projects.length === 0) {
      return { version: 1, watches: [] };
    }
    predicates.push(inArray(schema.consoleWatches.projectId, projects.map((project) => project.id)));
  }

  const watches = await db
    .select()
    .from(schema.consoleWatches)
    .where(and(...predicates))
    .orderBy(desc(schema.consoleWatches.updatedAt));

  return { version: 1, watches: watches.map(watchResponse) };
}

export async function getConsoleWatch(input: {
  watchId: string;
  workspace: ConsoleWatchWorkspace;
}) {
  const watch = await requireWatch(input.workspace, input.watchId, "read");
  return { version: 1, watch: watchResponse(watch) };
}

export async function getConsoleWatchStatus(input: {
  watchId: string;
  workspace: ConsoleWatchWorkspace;
}) {
  const watch = await requireWatch(input.workspace, input.watchId, "read");
  return {
    version: 1,
    watchId: watch.id,
    status: watch.status,
    provider: watch.provider,
    placement: watch.placement,
    webhookHealth: "not_configured",
    lastEventAt: watch.lastEventAt?.toISOString() ?? null,
    lastDeliveryAt: watch.lastDeliveryAt?.toISOString() ?? null,
    lastErrorCode: watch.lastErrorCode,
    missing: watch.status === "degraded" ? [watch.lastErrorCode ?? "WEBHOOK_UNHEALTHY"] : [],
  };
}

export async function updateConsoleWatch(input: {
  body: UpdateConsoleWatchInput;
  requestId: string;
  watchId: string;
  workspace: ConsoleWatchWorkspace;
}) {
  const watch = await requireWatch(input.workspace, input.watchId, "write");
  const eventTypes = input.body.eventTypes
    ? normalizeProviderWatchEventTypes(requireWatchProviderAdapter(watch.provider).providerDefinition, input.body.eventTypes)
    : watch.eventTypesJson;
  const filters = input.body.filters ?? watch.filtersJson;
  const delivery = input.body.delivery
    ? await resolveWatchDelivery({ delivery: input.body.delivery, workspace: input.workspace })
    : watch.deliveryJson;
  const watchKey = buildConsoleWatchKey({
    delivery,
    eventTypes,
    filters,
    placement: watch.placement,
    projectId: watch.projectId,
    provider: watch.provider,
    providerConnectionId: watch.providerConnectionId,
    providerInstallationId: watch.providerInstallationId,
    providerResourceId: watch.providerResourceId,
    resourceRef: watch.resourceRef,
  });

  const [updated] = await db
    .update(schema.consoleWatches)
    .set({
      name: input.body.name === undefined ? watch.name : cleanText(input.body.name, 160),
      description: input.body.description === undefined ? watch.description : cleanText(input.body.description, 500),
      eventTypesJson: eventTypes,
      filtersJson: filters,
      deliveryJson: delivery,
      watchKey,
      updatedAt: new Date(),
    })
    .where(eq(schema.consoleWatches.id, watch.id))
    .returning();
  if (!updated) throw cliApiError(404, "PROVIDER_RESOURCE_UNAVAILABLE");

  await auditWatchEvent({
    action: "watch.updated",
    requestId: input.requestId,
    watch: updated,
    workspace: input.workspace,
  });
  return { version: 1, watch: watchResponse(updated) };
}

export async function setConsoleWatchEnabled(input: {
  enabled: boolean;
  requestId: string;
  watchId: string;
  workspace: ConsoleWatchWorkspace;
}) {
  const watch = await requireWatch(input.workspace, input.watchId, "write");
  const now = new Date();
  const [updated] = await db
    .update(schema.consoleWatches)
    .set({
      status: input.enabled ? "active" : "disabled",
      disabledAt: input.enabled ? null : now,
      updatedAt: now,
    })
    .where(eq(schema.consoleWatches.id, watch.id))
    .returning();
  if (!updated) throw cliApiError(404, "PROVIDER_RESOURCE_UNAVAILABLE");
  await auditWatchEvent({
    action: input.enabled ? "watch.enabled" : "watch.disabled",
    requestId: input.requestId,
    watch: updated,
    workspace: input.workspace,
  });
  return { version: 1, watch: watchResponse(updated) };
}

export async function deleteConsoleWatch(input: {
  requestId: string;
  watchId: string;
  workspace: ConsoleWatchWorkspace;
}) {
  const watch = await requireWatch(input.workspace, input.watchId, "write");
  const now = new Date();
  const [updated] = await db
    .update(schema.consoleWatches)
    .set({
      status: "deleted",
      deletedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.consoleWatches.id, watch.id))
    .returning();
  if (updated) {
    await auditWatchEvent({
      action: "watch.deleted",
      requestId: input.requestId,
      watch: updated,
      workspace: input.workspace,
    });
  }
  return { ok: true };
}

export function normalizeGithubEventTypes(eventTypes: string[]) {
  return normalizeProviderWatchEventTypes(GITHUB_PROVIDER, eventTypes);
}

function normalizeProviderWatchEventTypes(provider: ProviderDefinition, eventTypes: string[]) {
  const normalized = normalizeProviderEventTypes(provider, eventTypes);
  if (normalized.length === 0) {
    throw cliApiError(400, "PAYLOAD_INVALID", "At least one watch event type is required.");
  }

  const supported = new Set<string>(getProviderEventTypes(provider, { implementedOnly: true }));
  const unsupported = normalized.filter((eventType) => !supported.has(eventType));
  if (unsupported.length > 0) {
    throw cliApiError(422, "WATCH_UNSUPPORTED_EVENT", `Unsupported watch event: ${unsupported[0]}`);
  }

  return normalized;
}

function requireWatchProviderAdapter(provider: string) {
  const providerDefinition = getProviderDefinition(provider);
  if (!providerDefinition || !providerHasImplementedWatchEvents(providerDefinition)) {
    throw cliApiError(404, "WATCH_CAPABILITY_UNAVAILABLE", "Provider watches are not available for this provider.");
  }
  const adapter = watchProviderAdapters[providerDefinition.id];
  if (!adapter) {
    throw cliApiError(404, "WATCH_CAPABILITY_UNAVAILABLE", "Provider watches are not available for this provider.");
  }
  return { adapter, providerDefinition };
}

export function buildConsoleWatchKey(input: {
  delivery: JsonRecord;
  eventTypes: string[];
  filters: JsonRecord;
  placement: string;
  projectId: string | null;
  provider: string;
  providerConnectionId: string | null;
  providerInstallationId: string | null;
  providerResourceId: string | null;
  resourceRef: string;
}) {
  const canonical = stableJson({
    delivery: input.delivery,
    eventTypes: [...input.eventTypes].sort(),
    filters: input.filters,
    placement: input.placement,
    projectId: input.projectId,
    provider: normalizeProvider(input.provider),
    providerConnectionId: input.providerConnectionId,
    providerInstallationId: input.providerInstallationId,
    providerResourceId: input.providerResourceId,
    resourceRef: input.resourceRef.toLowerCase(),
  });
  return `watch:${normalizeProvider(input.provider)}:${createHash("sha256").update(canonical).digest("hex").slice(0, 40)}`;
}

async function resolveGithubProviderConnection(input: {
  providerConnectionId?: string | null;
  providerInstallationId?: string | null;
  resourceRef?: string | null;
  workspace: ConsoleWatchWorkspace;
}) {
  const connections = (await listGithubProviderConnections({ workspace: input.workspace }))
    .filter((connection) => !input.providerConnectionId || connection.id === input.providerConnectionId);
  const resource = input.resourceRef?.toLowerCase() ?? null;
  const matched = input.providerInstallationId
    ? connections.find((connection) => githubInstallationId(connection) === input.providerInstallationId)
    // Several linked accounts: the one that can see the repository.
    : (resource
        ? connections.find((connection) => githubSelectedRepositories(connection).some((repository) =>
            repository.fullName?.toLowerCase() === resource || repository.id?.toLowerCase() === resource))
        : undefined) ?? connections[0];

  if (!matched) throw cliApiError(409, "INSTALLATION_MISSING");
  return matched;
}

/** The organization's linked GitHub installations, which every project of it uses. */
async function listGithubProviderConnections(input: { workspace: ConsoleWatchWorkspace }) {
  return (await listOrganizationGithubConnections(input.workspace.organization.id))
    .filter((connection) => connection.status === "active");
}

async function resolveWatchDelivery(input: {
  delivery: JsonRecord | null;
  workspace: ConsoleWatchWorkspace;
}) {
  const delivery = input.delivery ?? {};
  const subscriptionId = typeof delivery.subscriptionId === "string" ? delivery.subscriptionId : null;
  const predicates = [
    eq(schema.agentInboxSubscriptions.organizationId, input.workspace.organization.id),
    eq(schema.agentInboxSubscriptions.localInstallationId, input.workspace.localInstallation.id),
    eq(schema.agentInboxSubscriptions.status, "active"),
  ];
  if (subscriptionId) {
    predicates.push(eq(schema.agentInboxSubscriptions.id, subscriptionId));
  } else {
    predicates.push(eq(schema.agentInboxSubscriptions.name, "global"));
  }
  const [subscription] = await db
    .select()
    .from(schema.agentInboxSubscriptions)
    .where(and(...predicates))
    .limit(1);

  if (!subscription) {
    if (subscriptionId) {
      throw cliApiError(409, "INBOX_SUBSCRIPTION_MISSING");
    }

    const upserted = await upsertGlobalInboxSubscription({
      workspace: input.workspace,
    });
    return {
      ...delivery,
      type: "inbox",
      subscriptionId: upserted.subscription.id,
      localInstallationId: input.workspace.localInstallation.id,
    };
  }

  return {
    ...delivery,
    type: "inbox",
    subscriptionId: subscription.id,
    localInstallationId: input.workspace.localInstallation.id,
  };
}

async function requireProject(
  workspace: ConsoleWatchWorkspace,
  projectRef: string,
  action: "read" | "write" | "admin",
) {
  const project = await findAccessibleProjectRecord(workspace, projectRef, action);
  if (!project) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  return project;
}

function requireOrganizationWatchWrite(workspace: ConsoleWatchWorkspace, projectId: string | null) {
  if (projectId) return;
  if (["owner", "admin", "developer"].includes(workspace.membership.role)) return;
  throw cliApiError(403, "PROJECT_ACCESS_DENIED");
}

async function requireWatch(
  workspace: ConsoleWatchWorkspace,
  watchId: string,
  action: "read" | "write",
) {
  const [watch] = await db
    .select()
    .from(schema.consoleWatches)
    .where(
      and(
        eq(schema.consoleWatches.organizationId, workspace.organization.id),
        eq(schema.consoleWatches.localInstallationId, workspace.localInstallation.id),
        eq(schema.consoleWatches.id, watchId),
        ne(schema.consoleWatches.status, "deleted"),
      ),
    )
    .limit(1);
  if (!watch) throw cliApiError(404, "PROVIDER_RESOURCE_UNAVAILABLE");
  if (watch.projectId) {
    const project = await findAccessibleProjectRecord(workspace, watch.projectId, action);
    if (!project) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  } else if (action === "write") {
    requireOrganizationWatchWrite(workspace, null);
  }
  return watch;
}

async function findWatchByKey(workspace: ConsoleWatchWorkspace, watchKey: string) {
  const [watch] = await db
    .select()
    .from(schema.consoleWatches)
    .where(and(eq(schema.consoleWatches.organizationId, workspace.organization.id), eq(schema.consoleWatches.watchKey, watchKey)))
    .limit(1);
  return watch ?? null;
}

function watchResponse(watch: typeof schema.consoleWatches.$inferSelect) {
  return {
    id: watch.id,
    provider: watch.provider,
    placement: watch.placement,
    status: watch.status,
    organizationId: watch.organizationId,
    projectId: watch.projectId,
    localInstallationId: watch.localInstallationId,
    providerConnectionId: watch.providerConnectionId,
    providerInstallationId: watch.providerInstallationId,
    providerResourceId: watch.providerResourceId,
    providerResourceRef: watch.resourceRef,
    resourceRef: watch.resourceRef,
    eventTypes: watch.eventTypesJson,
    effectiveEventTypes: watch.eventTypesJson,
    eventSubjects: watch.eventTypesJson.map(watchEventSubject),
    filters: watch.filtersJson,
    delivery: watch.deliveryJson,
    name: watch.name,
    description: watch.description,
    missingRequirements: [],
    statusUrl: `/api/cli/watches/${watch.id}/status`,
    lastEventAt: watch.lastEventAt?.toISOString() ?? null,
    lastDeliveryAt: watch.lastDeliveryAt?.toISOString() ?? null,
    lastErrorCode: watch.lastErrorCode,
    createdAt: watch.createdAt.toISOString(),
    updatedAt: watch.updatedAt.toISOString(),
  };
}

function githubInstallationResponse(connection: typeof schema.providerConnections.$inferSelect) {
  return {
    id: githubInstallationId(connection),
    providerConnectionId: connection.id,
    accountId: connection.externalAccountId,
    accountLogin: connection.externalAccountLogin,
    displayName: connection.displayName,
    status: connection.status,
    projectId: connection.projectId,
    capabilities: connection.capabilitiesJson,
    repositories: githubSelectedRepositories(connection),
  };
}

function githubInstallationId(connection: typeof schema.providerConnections.$inferSelect) {
  const metadata = connection.metadataJson;
  const value = metadata.installationId ?? metadata.providerInstallationId;
  return typeof value === "string" && value ? value : connection.externalAccountId;
}

function githubSelectedRepositories(connection: typeof schema.providerConnections.$inferSelect) {
  const metadata = connection.metadataJson;
  const raw = metadata.selectedRepositories ?? metadata.repositories ?? [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      id: normalizedProviderId(item.id) ?? normalizedProviderId(item.nodeId),
      name: typeof item.name === "string" ? item.name : null,
      fullName: typeof item.fullName === "string" ? item.fullName : typeof item.full_name === "string" ? item.full_name : null,
      visibility: typeof item.visibility === "string" ? item.visibility : null,
      selected: item.selected !== false,
    }));
}

function requireGithubRepositorySelected(
  connection: typeof schema.providerConnections.$inferSelect,
  input: { providerResourceId: string; resourceRef: string },
) {
  const repositories = githubSelectedRepositories(connection);
  if (repositories.length === 0) {
    throw cliApiError(409, "REPO_NOT_SELECTED");
  }

  const providerResourceId = input.providerResourceId.toLowerCase();
  const resourceRef = input.resourceRef.toLowerCase();
  const selected = repositories.find((repository) => {
    if (repository.selected === false) return false;
    return (
      repository.id?.toLowerCase() === providerResourceId ||
      repository.fullName?.toLowerCase() === resourceRef ||
      repository.fullName?.toLowerCase() === providerResourceId
    );
  });
  if (!selected) throw cliApiError(409, "REPO_NOT_SELECTED");
  return selected;
}

function resolveGithubWatchResource(
  connection: typeof schema.providerConnections.$inferSelect,
  body: CreateConsoleWatchInput,
): WatchProviderResource {
  const resourceRef = resolveGithubResourceRef(connection, {
    owner: body.owner ?? null,
    providerResource: body.providerResource ?? null,
    providerResourceId: body.providerResourceId ?? null,
    repo: body.repo ?? null,
    resourceRef: body.resourceRef ?? null,
  });
  if (!resourceRef) throw cliApiError(409, "REPO_NOT_SELECTED");

  const selectedRepository = requireGithubRepositorySelected(connection, {
    providerResourceId: body.providerResourceId ?? resourceRef,
    resourceRef,
  });
  return {
    providerResourceId: body.providerResourceId ?? selectedRepository.id ?? resourceRef,
    providerResourceJson: selectedRepository,
    resourceRef,
  };
}

function normalizedProviderId(value: unknown) {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function effectiveConsolePlacement(placement: WatchPlacement) {
  if (placement === "local") {
    throw cliApiError(422, "WATCH_CAPABILITY_UNAVAILABLE", "Local watches are managed by the local Ravi runtime.");
  }
  return "console" as const;
}

function normalizeProvider(provider: string) {
  return provider.trim().toLowerCase();
}

function normalizeWatchStatus(status: string) {
  if (["active", "disabled", "degraded"].includes(status)) return status as "active" | "disabled" | "degraded";
  throw cliApiError(400, "PAYLOAD_INVALID", "Invalid watch status.");
}

function normalizeResourceRef(input: {
  owner: string | null;
  providerResource?: {
    fullName?: string | null;
    owner?: string | null;
    ref?: string | null;
    repo?: string | null;
    resourceRef?: string | null;
  } | null;
  repo: string | null;
  resourceRef: string | null;
}) {
  const explicit = (
    input.resourceRef ??
    input.providerResource?.resourceRef ??
    input.providerResource?.ref ??
    input.providerResource?.fullName
  )?.trim();
  if (explicit) return explicit.toLowerCase();
  if (input.providerResource?.owner?.trim() && input.providerResource?.repo?.trim()) {
    return `${input.providerResource.owner.trim()}/${input.providerResource.repo.trim()}`.toLowerCase();
  }
  if (input.owner?.trim() && input.repo?.trim()) {
    return `${input.owner.trim()}/${input.repo.trim()}`.toLowerCase();
  }
  return null;
}

function resolveGithubResourceRef(
  connection: typeof schema.providerConnections.$inferSelect,
  input: {
    owner: string | null;
    providerResource?: {
      fullName?: string | null;
      owner?: string | null;
      ref?: string | null;
      repo?: string | null;
      resourceRef?: string | null;
    } | null;
    providerResourceId: string | null;
    repo: string | null;
    resourceRef: string | null;
  },
) {
  const explicit = normalizeResourceRef(input);
  if (explicit) return explicit;

  const providerResourceId = input.providerResourceId?.toLowerCase();
  if (!providerResourceId) return null;
  const repository = githubSelectedRepositories(connection).find((candidate) => {
    if (candidate.selected === false) return false;
    return (
      candidate.id?.toLowerCase() === providerResourceId ||
      candidate.fullName?.toLowerCase() === providerResourceId
    );
  });
  return repository?.fullName?.toLowerCase() ?? null;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function cleanText(value: string | null | undefined, maxLength: number) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

async function auditWatchEvent(input: {
  action: string;
  requestId: string;
  watch: typeof schema.consoleWatches.$inferSelect;
  workspace: ConsoleWatchWorkspace;
}) {
  await db.insert(schema.auditEvents).values({
    organizationId: input.workspace.organization.id,
    projectId: input.watch.projectId,
    actorType: "cli",
    actorId: input.workspace.user.id,
    targetType: "console_watch",
    targetId: input.watch.id,
    action: input.action,
    requestId: input.requestId,
    metadataJson: {
      eventTypes: input.watch.eventTypesJson,
      localInstallationId: input.workspace.localInstallation.id,
      placement: input.watch.placement,
      provider: input.watch.provider,
      providerConnectionId: input.watch.providerConnectionId,
      providerInstallationId: input.watch.providerInstallationId,
      providerResourceId: input.watch.providerResourceId,
      resourceRef: input.watch.resourceRef,
    },
  });
}
