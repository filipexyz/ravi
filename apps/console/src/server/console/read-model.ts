import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";

import {
  colorFor,
  markFor,
  type Artifact,
  type ArtifactVersion,
  type Event,
  type MailDomainSummary,
  type MailMessageSummary,
  type MailOverviewData,
  type MailboxSummary,
  type Member,
  type Org,
  type PageReleaseRoute,
  type PageCustomDomainSummary,
  type PublishedPageSummary,
  type PageSiteDetail,
  type PageSiteRelease,
  type PageSiteSummary,
  type Project,
  type RuntimeRunBlobRef,
  type RuntimeRunDetail,
  type RuntimeRunEvent,
  type RuntimeRunsData,
  type RuntimeRunSummary,
  type RuntimeRunToolCall,
  type RuntimeRunTurn,
  type SettingsData,
  type Visibility,
} from "@/features/console/types";
import { db, schema } from "@/server/db";
import {
  formatMailAddress,
  mailAddressSummaryFromHeaders,
  parseMailAddressSummary,
  type MailAddressHeader,
} from "@/server/console/mail/address-summary";
import { pageCustomDomainSummary } from "@/server/console/domains";
import { getManagedMailDomains } from "@/server/console/mail/managed-domains";
import { createMailPayloadDecrypterFromEnv } from "@/server/console/mail/object-storage";
import type {
  MailMessagePayloadKind,
  MailPayloadDecrypter,
} from "@/server/console/mail/service";
import type {
  MailCipherRef,
  MailMessage,
} from "@/server/console/mail/storage";
import { listLatestPageThumbnails, type PageThumbnailSummary } from "./pages/captures";
import { listActorUsers, releaseAuthor } from "./pages/operator";
import { listPageThumbnailAttempts } from "./pages/thumbnails";
import { effectiveVisibility as effectivePageVisibility } from "./pages/resolve";
import { isUuidRef } from "./ref";
import {
  canAccessProject,
  findAccessibleProjectRecord,
  listAccessibleProjectRecords,
  type ProjectAccessWorkspace,
} from "./project-access";
import {
  emptyPageRouteCommentSummary,
  listPageRouteCommentSummaries,
  routeCommentKey,
} from "./pages/comments";
import type { ConsoleOrganizationMembership, ConsoleWorkspace } from "./workspace";
import { authorizationStore } from "./authorization/store";
import { organizationSettingsActor, organizationSettingsPayload } from "./organization-settings";

type JsonRecord = Record<string, unknown>;

export async function listOrganizations(workspace: ConsoleWorkspace): Promise<Org[]> {
  const rows = await db
    .select({
      organization: schema.organizations,
      membership: schema.organizationMemberships,
      billing: schema.billingAccounts,
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.organizations, eq(schema.organizationMemberships.organizationId, schema.organizations.id))
    .leftJoin(schema.billingAccounts, eq(schema.billingAccounts.organizationId, schema.organizations.id))
    .where(
      and(
        eq(schema.organizationMemberships.userId, workspace.user.id),
        eq(schema.organizationMemberships.status, "active"),
        eq(schema.organizations.status, "active"),
      ),
    )
    .orderBy(schema.organizations.name);

  return rows.map(organizationMembershipToOrg);
}

export function organizationMembershipToOrg({ organization, membership, billing }: ConsoleOrganizationMembership): Org {
  return organizationToOrg(organization, membership.role, billing?.planKey ?? "free");
}

export async function getCurrentOrganization(workspace: ConsoleWorkspace): Promise<Org> {
  const [billing] = await db
    .select()
    .from(schema.billingAccounts)
    .where(eq(schema.billingAccounts.organizationId, workspace.organization.id))
    .limit(1);

  return organizationToOrg(workspace.organization, workspace.membership.role, billing?.planKey ?? "free");
}

export async function listProjects(workspace: ProjectAccessWorkspace): Promise<Project[]> {
  return hydrateProjects(await listAccessibleProjectRecords(workspace));
}

export async function getProject(workspace: ProjectAccessWorkspace, projectRef: string): Promise<Project | null> {
  const projects = await listProjects(workspace);
  return projects.find((project) => project.id === projectRef || project.slug === projectRef) ?? null;
}

export async function listArtifacts(workspace: ConsoleWorkspace, projectRef: string): Promise<Artifact[]> {
  const project = await projectRecord(workspace, projectRef);
  if (!project) return [];

  const rows = await db
    .select()
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.projectId, project.id),
        sql`COALESCE(${schema.artifacts.metadataJson}->>'kind', '') <> 'pages.capture'`,
      ),
    )
    .orderBy(desc(schema.artifacts.updatedAt));

  return hydrateArtifacts(rows);
}

export async function listPageSites(workspace: ConsoleWorkspace, projectRef: string): Promise<PageSiteSummary[]> {
  const project = await projectRecord(workspace, projectRef);
  if (!project) return [];

  const sites = await db
    .select()
    .from(schema.pageSites)
    .where(and(eq(schema.pageSites.organizationId, workspace.organization.id), eq(schema.pageSites.projectId, project.id)))
    .orderBy(desc(schema.pageSites.isDefault), desc(schema.pageSites.updatedAt));

  return hydratePageSiteSummaries(sites);
}

export async function listPublishedPages(
  workspace: ProjectAccessWorkspace,
  projectRef: string,
): Promise<PublishedPageSummary[]> {
  const project = await projectRecord(workspace, projectRef);
  if (!project) return [];

  const sites = await db
    .select()
    .from(schema.pageSites)
    .where(and(eq(schema.pageSites.organizationId, workspace.organization.id), eq(schema.pageSites.projectId, project.id)))
    .orderBy(desc(schema.pageSites.isDefault), desc(schema.pageSites.updatedAt));

  const siteSummaries = await hydratePageSiteSummaries(sites);
  if (siteSummaries.length === 0) return [];

  const activeReleaseIds = siteSummaries.flatMap((site) => site.activeReleaseId ? [site.activeReleaseId] : []);
  const activeReleases = activeReleaseIds.length
    ? await db
        .select()
        .from(schema.pageSiteReleases)
        .where(inArray(schema.pageSiteReleases.id, activeReleaseIds))
    : [];
  const releaseById = new Map(activeReleases.map((release) => [release.id, release]));
  const servedRoutes = siteSummaries.flatMap((site) =>
    site.activeRoutes.map((route) => ({ routeId: route.routeId, artifactVersionId: route.artifactVersionId })),
  );
  // Independent reads of what the active routes serve; the screen polls this while previews are being made.
  const [customDomainsBySite, routeCommentSummaries, routeThumbnails, thumbnailAttempts, publishedByVersion] = await Promise.all([
    listPageCustomDomains(
      workspace.organization.id,
      siteSummaries.map((site) => site.id),
    ),
    listPageRouteCommentSummaries({
      routes: siteSummaries.flatMap((site) =>
        site.activeRoutes.map((route) => ({
          siteId: site.id,
          path: route.path,
          routeId: route.routeId,
        })),
      ),
      userId: workspace.user.id,
    }),
    listLatestPageThumbnails({ projectId: project.id, routes: servedRoutes }),
    listPageThumbnailAttempts({ projectId: project.id, routes: servedRoutes }),
    listPageContentPublishers(servedRoutes.map((route) => route.artifactVersionId)),
  ]);

  return siteSummaries
    .flatMap((site) => {
      if (!site.activeReleaseId) return [];
      const release = releaseById.get(site.activeReleaseId);
      if (!release) return [];

      const customDomains = customDomainsBySite.get(site.id) ?? [];
      return site.activeRoutes.map((route) => {
        const urls = [
          pageUrlForHost(site.defaultHostname, route.path),
          ...customDomains
            .filter((domain) => domain.status === "ready")
            .map((domain) => pageUrlForHost(domain.hostname, route.path)),
        ];
        const status = pageStatusText(site, route);

        return {
          id: route.id,
          routeId: route.routeId,
          projectId: site.projectId,
          siteId: site.id,
          siteSlug: site.slug,
          defaultHostname: site.defaultHostname,
          path: route.path,
          matchType: route.matchType,
          priority: route.priority,
          title: pageTitle(route, site),
          description: pageDescription(route, site),
          urls,
          customDomains,
          artifactId: route.artifactId,
          artifactName: route.artifactName,
          artifactDescription: route.artifactDescription,
          artifactVersionId: route.artifactVersionId,
          artifactVersion: route.artifactVersion,
          entrypoint: route.entrypoint,
          assetBase: route.assetBase,
          visibility: route.visibility,
          effectiveVisibility: route.effectiveVisibility,
          releaseId: release.id,
          releaseNumber: release.releaseNumber,
          releaseStatus: release.status,
          siteStatus: site.status,
          status,
          thumbnail: publishedPageThumbnail(
            routeThumbnails.get(route.routeId),
            thumbnailAttempts.get(route.routeId) ?? null,
            project.id,
          ),
          comments: routeCommentSummaries.get(routeCommentKey(site.id, route.path)) ?? emptyPageRouteCommentSummary(),
          published: publishedByVersion.get(route.artifactVersionId) ?? { at: dateMs(site.updatedAt), by: { name: null, via: "system" } },
          updatedAt: dateMs(site.updatedAt),
        };
      });
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || right.priority - left.priority || left.path.localeCompare(right.path));
}

/**
 * When each page's current content was published and by whom: the artifact
 * version a route serves. A host's own update time moves on any release, so it
 * can't tell pages apart.
 */
async function listPageContentPublishers(artifactVersionIds: string[]): Promise<Map<string, PublishedPageSummary["published"]>> {
  const ids = [...new Set(artifactVersionIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: schema.artifactVersions.id,
      createdAt: schema.artifactVersions.createdAt,
      actorType: schema.artifactVersions.createdByActorType,
      actorId: schema.artifactVersions.createdByActorId,
    })
    .from(schema.artifactVersions)
    .where(inArray(schema.artifactVersions.id, ids));
  const users = await listActorUsers(rows.map((row) => row.actorId));
  return new Map(
    rows.map((row) => {
      const user = row.actorId ? users.get(row.actorId.toLowerCase()) : undefined;
      return [row.id, { at: dateMs(row.createdAt), by: releaseAuthor(row.actorType, user?.displayName, user?.email) }];
    }),
  );
}

function publishedPageThumbnail(
  thumbnail: PageThumbnailSummary | undefined,
  attempt: PublishedPageSummary["thumbnail"]["attempt"],
  projectRef: string,
): PublishedPageSummary["thumbnail"] {
  if (!thumbnail) {
    return {
      state: "missing",
      attempt,
      captureId: null,
      sourceArtifactVersionId: null,
      capturedAt: null,
      url: null,
      width: null,
      height: null,
      mimeType: null,
      sizeBytes: null,
    };
  }
  return {
    state: thumbnail.state,
    attempt: thumbnail.state === "current" ? null : attempt,
    captureId: thumbnail.captureId,
    sourceArtifactVersionId: thumbnail.sourceArtifactVersionId,
    capturedAt: thumbnail.capturedAt,
    url: `/api/console/projects/${encodeURIComponent(projectRef)}/pages/captures/${thumbnail.captureId}/images/${thumbnail.image.sequence}`,
    width: thumbnail.image.width,
    height: thumbnail.image.height,
    mimeType: thumbnail.image.mimeType,
    sizeBytes: thumbnail.image.sizeBytes,
  };
}

export async function getPageSiteDetail(
  workspace: ConsoleWorkspace,
  projectRef: string,
  siteRef: string,
): Promise<PageSiteDetail | null> {
  const project = await projectRecord(workspace, projectRef);
  if (!project) return null;

  const [site] = await db
    .select()
    .from(schema.pageSites)
    .where(
      and(
        eq(schema.pageSites.organizationId, workspace.organization.id),
        eq(schema.pageSites.projectId, project.id),
        isUuidRef(siteRef)
          ? or(eq(schema.pageSites.id, siteRef), eq(schema.pageSites.slug, siteRef))
          : eq(schema.pageSites.slug, siteRef),
      ),
    )
    .limit(1);

  if (!site) return null;

  const [summary] = await hydratePageSiteSummaries([site]);
  if (!summary) return null;

  const releases = await db
    .select()
    .from(schema.pageSiteReleases)
    .where(eq(schema.pageSiteReleases.siteId, site.id))
    .orderBy(desc(schema.pageSiteReleases.releaseNumber));

  const releaseSummaries = await hydratePageSiteReleases(releases);
  const activeRelease = site.activeReleaseId
    ? releaseSummaries.find((release) => release.id === site.activeReleaseId) ?? null
    : null;
  const activeRoutes = site.activeReleaseId
    ? withEffectiveVisibility(await listPageReleaseRoutes(site.activeReleaseId), site.defaultVisibility)
    : [];

  return {
    ...summary,
    activeRelease,
    activeRoutes,
    releases: releaseSummaries,
  };
}

export async function getArtifact(workspace: ProjectAccessWorkspace, artifactId: string): Promise<Artifact | null> {
  const [row] = await db
    .select({
      artifact: schema.artifacts,
      project: schema.projects,
    })
    .from(schema.artifacts)
    .innerJoin(schema.projects, eq(schema.artifacts.projectId, schema.projects.id))
    .where(and(eq(schema.artifacts.id, artifactId), eq(schema.projects.organizationId, workspace.organization.id)))
    .limit(1);

  if (!row) return null;
  if (!(await canAccessProject(workspace, row.project.id, "read"))) return null;
  return (await hydrateArtifacts([row.artifact]))[0] ?? null;
}

export async function listArtifactVersions(
  workspace: ProjectAccessWorkspace,
  artifactId: string,
): Promise<ArtifactVersion[]> {
  const artifact = await artifactRecord(workspace, artifactId);
  if (!artifact) return [];

  const versions = await db
    .select()
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, artifact.id))
    .orderBy(desc(schema.artifactVersions.versionNumber));

  if (versions.length === 0) return [];

  return versions.map((version) => ({
    id: version.id,
    artifactId: version.artifactId,
    ver: `v${version.versionNumber}`,
    sha: version.sha256?.slice(0, 12) ?? "-",
    author: actorLabel(version.createdByActorType, version.createdByActorId),
    authorMark: markFor(version.createdByActorId ?? version.createdByActorType),
    color: colorFor(version.createdByActorId ?? version.createdByActorType),
    msg: textFromJson(version.metadataJson, "message") ?? version.status,
    at: dateMs(version.createdAt),
    on: [],
    status: versionStatus(version.status),
  }));
}

export async function listAuditEvents(workspace: ConsoleWorkspace, projectRef?: string): Promise<Event[]> {
  const project = projectRef ? await projectRecord(workspace, projectRef) : null;
  if (projectRef && !project) return [];

  let where = project
    ? and(eq(schema.auditEvents.organizationId, workspace.organization.id), eq(schema.auditEvents.projectId, project.id))
    : eq(schema.auditEvents.organizationId, workspace.organization.id);
  if (!project) {
    const projects = await listAccessibleProjectRecords(workspace);
    if (projects.length === 0) return [];
    where = and(
      eq(schema.auditEvents.organizationId, workspace.organization.id),
      inArray(schema.auditEvents.projectId, projects.map((item) => item.id)),
    );
  }

  const rows = await db.select().from(schema.auditEvents).where(where).orderBy(desc(schema.auditEvents.createdAt)).limit(200);
  const projects = await listProjectRecords(workspace.organization.id);
  const projectById = new Map(projects.map((item) => [item.id, item]));

  return rows.map((event) => {
    const eventProject = event.projectId ? projectById.get(event.projectId) : null;
    const metadata = record(event.metadataJson);
    return {
      id: event.id,
      t: dateMs(event.createdAt),
      type: event.action,
      project: eventProject?.slug ?? null,
      target: event.targetId ?? event.targetType,
      actor: actorLabel(event.actorType, event.actorId),
      actorMark: markFor(event.actorId ?? event.actorType),
      color: colorFor(event.actorId ?? event.actorType),
      note: typeof metadata.note === "string" ? metadata.note : undefined,
    };
  });
}

export async function listRuntimeRuns(
  workspace: ConsoleWorkspace,
  projectRef?: string,
): Promise<RuntimeRunsData | null> {
  const project = projectRef ? await projectRecord(workspace, projectRef) : null;
  if (projectRef && !project) return null;

  const predicates = [eq(schema.runtimeTraceSessions.organizationId, workspace.organization.id)];
  if (project) {
    predicates.push(eq(schema.runtimeTraceSessions.projectId, project.id));
  } else {
    const projects = await listAccessibleProjectRecords(workspace);
    if (projects.length === 0) {
      return { scope: "organization", projectId: null, runs: [] };
    }
    predicates.push(inArray(schema.runtimeTraceSessions.projectId, projects.map((item) => item.id)));
  }

  const rows = await db
    .select({
      session: schema.runtimeTraceSessions,
      projectName: schema.projects.name,
      projectSlug: schema.projects.slug,
    })
    .from(schema.runtimeTraceSessions)
    .leftJoin(schema.projects, eq(schema.runtimeTraceSessions.projectId, schema.projects.id))
    .where(and(...predicates))
    .orderBy(desc(schema.runtimeTraceSessions.updatedAt), desc(schema.runtimeTraceSessions.startedAt))
    .limit(100);

  const summaries = dedupeRuntimeRunsBySession(
    (await hydrateRuntimeRunSummaries(rows)).filter(runtimeRunHasActivity),
  );
  return {
    scope: project ? "project" : "organization",
    projectId: project?.id ?? null,
    runs: summaries,
  };
}

export async function getRuntimeRunDetail(
  workspace: ConsoleWorkspace,
  traceSessionRef: string,
): Promise<RuntimeRunDetail | null> {
  const refPredicate = isUuidRef(traceSessionRef)
    ? or(
        eq(schema.runtimeTraceSessions.id, traceSessionRef),
        eq(schema.runtimeTraceSessions.externalTraceId, traceSessionRef),
      )
    : eq(schema.runtimeTraceSessions.externalTraceId, traceSessionRef);

  const [row] = await db
    .select({
      session: schema.runtimeTraceSessions,
      projectName: schema.projects.name,
      projectSlug: schema.projects.slug,
    })
    .from(schema.runtimeTraceSessions)
    .leftJoin(schema.projects, eq(schema.runtimeTraceSessions.projectId, schema.projects.id))
    .where(and(eq(schema.runtimeTraceSessions.organizationId, workspace.organization.id), refPredicate))
    .limit(1);

  if (!row) return null;
  if (!(await canAccessRuntimeTraceSession(workspace, row.session.projectId))) return null;

  const [summary] = await hydrateRuntimeRunSummaries([row]);
  if (!summary) return null;

  const [turns, events, toolCalls, blobs] = await Promise.all([
    db
      .select()
      .from(schema.runtimeTraceTurns)
      .where(eq(schema.runtimeTraceTurns.traceSessionId, row.session.id))
      .orderBy(asc(schema.runtimeTraceTurns.sequence)),
    db
      .select()
      .from(schema.runtimeTraceEvents)
      .where(eq(schema.runtimeTraceEvents.traceSessionId, row.session.id))
      .orderBy(
        asc(schema.runtimeTraceEvents.occurredAt),
        asc(schema.runtimeTraceEvents.sequence),
        asc(schema.runtimeTraceEvents.sourceEventId),
      ),
    db
      .select()
      .from(schema.runtimeTraceToolCalls)
      .where(eq(schema.runtimeTraceToolCalls.traceSessionId, row.session.id))
      .orderBy(asc(schema.runtimeTraceToolCalls.startedAt)),
    db
      .select()
      .from(schema.runtimeTraceBlobs)
      .where(eq(schema.runtimeTraceBlobs.traceSessionId, row.session.id))
      .orderBy(asc(schema.runtimeTraceBlobs.createdAt)),
  ]);

  return {
    summary,
    turns: turns.map(runtimeTurnToView),
    events: events.map(runtimeEventToView),
    toolCalls: toolCalls.map(runtimeToolCallToView),
    blobs: blobs.map(runtimeBlobToView),
  };
}

export async function getMailOverview(
  workspace: ConsoleWorkspace,
  projectRef?: string,
): Promise<MailOverviewData | null> {
  const project = projectRef ? await projectRecord(workspace, projectRef) : null;
  if (projectRef && !project) return null;

  const domains = await db
    .select()
    .from(schema.mailDomains)
    .where(eq(schema.mailDomains.organizationId, workspace.organization.id))
    .orderBy(desc(schema.mailDomains.updatedAt));

  const mailboxPredicates = [eq(schema.mailboxes.organizationId, workspace.organization.id)];
  if (project) {
    mailboxPredicates.push(eq(schema.mailboxes.projectId, project.id));
  } else {
    const projects = await listAccessibleProjectRecords(workspace);
    if (projects.length === 0) {
      return emptyMailOverview(workspace, domains, "organization", null);
    }
    mailboxPredicates.push(inArray(schema.mailboxes.projectId, projects.map((item) => item.id)));
  }

  const mailboxRows = await db
    .select({
      mailbox: schema.mailboxes,
      projectName: schema.projects.name,
    })
    .from(schema.mailboxes)
    .leftJoin(schema.projects, eq(schema.mailboxes.projectId, schema.projects.id))
    .where(and(...mailboxPredicates))
    .orderBy(desc(schema.mailboxes.updatedAt));

  const mailboxes = mailboxRows.map(({ mailbox }) => mailbox);
  const mailboxIds = mailboxes.map((mailbox) => mailbox.id);
  const routes = mailboxIds.length
    ? await db
        .select()
        .from(schema.mailRoutes)
        .where(and(eq(schema.mailRoutes.organizationId, workspace.organization.id), inArray(schema.mailRoutes.mailboxId, mailboxIds)))
    : [];
  const messageStats = mailboxIds.length
    ? await db
        .select({
          mailboxId: schema.mailMessages.mailboxId,
          messageCount: sql<string>`COUNT(*)`,
          lastMessageAt: sql<Date | null>`MAX(COALESCE(${schema.mailMessages.receivedAt}, ${schema.mailMessages.sentAt}, ${schema.mailMessages.updatedAt}))`,
        })
        .from(schema.mailMessages)
        .where(and(eq(schema.mailMessages.organizationId, workspace.organization.id), inArray(schema.mailMessages.mailboxId, mailboxIds)))
        .groupBy(schema.mailMessages.mailboxId)
    : [];
  const messages = mailboxIds.length
    ? await db
        .select()
        .from(schema.mailMessages)
        .where(and(eq(schema.mailMessages.organizationId, workspace.organization.id), inArray(schema.mailMessages.mailboxId, mailboxIds)))
        .orderBy(desc(schema.mailMessages.updatedAt))
        .limit(50)
    : [];

  const routeCountByMailbox = countBy(routes, (route) => route.mailboxId ?? "");
  const routeCountByDomain = countBy(routes, (route) => route.domainId);
  const messageCountByMailbox = new Map(messageStats.map((item) => [item.mailboxId, Number(item.messageCount)]));
  const lastMessageAtByMailbox = new Map(messageStats.map((item) => [item.mailboxId, dateMs(item.lastMessageAt)]));
  const domainById = new Map(domains.map((domain) => [domain.id, domain]));
  const mailboxCountByDomain = countBy(mailboxes, (mailbox) => mailbox.domainId);
  const managedDomains = Array.from(getManagedMailDomains());
  const decrypter = createMailPayloadDecrypterFromEnv();
  const messageSummaries = await Promise.all(
    messages.map((message) => mailMessageSummary(message, decrypter)),
  );

  return {
    scope: project ? "project" : "organization",
    projectId: project?.id ?? null,
    domains: domains.map((domain): MailDomainSummary => ({
      id: domain.id,
      domain: domain.domain,
      status: domain.status,
      providerAdapter: domain.providerAdapter,
      managed: managedDomains.includes(domain.domain),
      mailboxCount: mailboxCountByDomain.get(domain.id) ?? 0,
      routeCount: routeCountByDomain.get(domain.id) ?? 0,
      updatedAt: dateMs(domain.updatedAt),
    })),
    mailboxes: mailboxRows.map(({ mailbox, projectName }): MailboxSummary => ({
      id: mailbox.id,
      address: mailbox.address,
      localPart: mailbox.localPart,
      domainId: mailbox.domainId,
      domain: domainById.get(mailbox.domainId)?.domain ?? mailbox.address.split("@")[1] ?? "",
      projectId: mailbox.projectId,
      projectName: projectName ?? null,
      agentId: mailbox.agentId,
      status: mailbox.status,
      defaultVisibility: mailbox.defaultVisibility,
      keyScope: mailbox.keyScope,
      routeCount: routeCountByMailbox.get(mailbox.id) ?? 0,
      messageCount: messageCountByMailbox.get(mailbox.id) ?? 0,
      lastMessageAt: lastMessageAtByMailbox.get(mailbox.id) ?? null,
      updatedAt: dateMs(mailbox.updatedAt),
    })),
    messages: messageSummaries,
    managedDomains,
    agentAddressPattern: agentAddressPattern(workspace, managedDomains[0] ?? "ravi.bot"),
  };
}

export function getSettingsData(workspace: ConsoleWorkspace, scope: "org", projectRef?: string): Promise<import("@/features/console/types").OrganizationSettingsData | null>;
export function getSettingsData(workspace: ConsoleWorkspace, scope: "project", projectRef?: string): Promise<SettingsData | null>;
export function getSettingsData(workspace: ConsoleWorkspace, scope: "org" | "project", projectRef?: string): Promise<import("@/features/console/types").OrganizationSettingsData | SettingsData | null>;
export async function getSettingsData(
  workspace: ConsoleWorkspace,
  scope: "org" | "project",
  projectRef?: string,
): Promise<import("@/features/console/types").OrganizationSettingsData | SettingsData | null> {
  if (scope === "org") {
    return authorizationStore.withAuthorizedOrganization(organizationSettingsActor(workspace),
      "organization.settings.read", async tx => {
        const [organization] = await tx.select().from(schema.organizations)
          .where(eq(schema.organizations.id, workspace.organization.id)).limit(1);
        return organization ? organizationSettingsPayload(organization) : null;
      });
  }

  const members = await listMembers(workspace);
  const canManageMembers = false;

  if (!projectRef) return null;
  const project = await projectRecord(workspace, projectRef);
  if (!project) return null;

  return {
    canManageMembers,
    currentRole: workspace.membership.role,
    currentUserId: workspace.user.id,
    id: project.id,
    name: project.name,
    slug: project.slug,
    visibility: project.defaultVisibility,
    members,
  };
}

async function hydrateProjects(projects: Array<typeof schema.projects.$inferSelect>): Promise<Project[]> {
  if (projects.length === 0) return [];
  const projectIds = projects.map((project) => project.id);
  const artifactRows = await db.select().from(schema.artifacts).where(inArray(schema.artifacts.projectId, projectIds));
  const memberships = await db
    .select()
    .from(schema.projectMemberships)
    .where(inArray(schema.projectMemberships.projectId, projectIds));
  const artifactsByProject = groupBy(artifactRows, (artifact) => artifact.projectId);
  const membersByProject = groupBy(memberships, (membership) => membership.projectId);

  return projects.map((project) => {
    const latestActivity = Math.max(
      dateMs(project.updatedAt),
      ...(artifactsByProject.get(project.id) ?? []).map((artifact) => dateMs(artifact.updatedAt)),
    );
    return {
      id: project.id,
      orgId: project.organizationId,
      slug: project.slug,
      name: project.name,
      description: project.description ?? "",
      artifactCount: artifactsByProject.get(project.id)?.length ?? 0,
      members: membersByProject.get(project.id)?.length ?? 0,
      lastActive: latestActivity,
    };
  });
}

async function hydrateArtifacts(artifacts: Array<typeof schema.artifacts.$inferSelect>): Promise<Artifact[]> {
  if (artifacts.length === 0) return [];
  const artifactIds = artifacts.map((artifact) => artifact.id);
  const versions = await db
    .select()
    .from(schema.artifactVersions)
    .where(inArray(schema.artifactVersions.artifactId, artifactIds));

  const versionsByArtifact = groupBy(versions, (version) => version.artifactId);

  return artifacts.map((artifact) => {
    const latestVersion = latestBy(versionsByArtifact.get(artifact.id) ?? [], (version) => version.versionNumber);
    return {
      id: artifact.id,
      projectId: artifact.projectId,
      name: artifact.name,
      description: artifact.description ?? "",
      visibility: artifact.visibility,
      versions: versionsByArtifact.get(artifact.id)?.length ?? 0,
      latestVersion: latestVersion ? `v${latestVersion.versionNumber}` : "-",
      last: dateMs(artifact.updatedAt),
    };
  });
}

async function hydratePageSiteSummaries(sites: Array<typeof schema.pageSites.$inferSelect>): Promise<PageSiteSummary[]> {
  if (sites.length === 0) return [];
  const siteIds = sites.map((site) => site.id);
  const activeReleaseIds = sites.flatMap((site) => site.activeReleaseId ? [site.activeReleaseId] : []);
  const releases = await db
    .select()
    .from(schema.pageSiteReleases)
    .where(inArray(schema.pageSiteReleases.siteId, siteIds));
  const routes = await db
    .select()
    .from(schema.pageRoutes)
    .where(inArray(schema.pageRoutes.siteId, siteIds));
  const activeReleaseRoutes = await listPageReleaseRoutesForReleaseIds(activeReleaseIds);
  const releasesBySite = groupBy(releases, (release) => release.siteId);
  const routesBySite = groupBy(routes, (route) => route.siteId);
  const activeRoutesByRelease = groupBy(activeReleaseRoutes, (route) => route.releaseId);

  return sites.map((site) => ({
    id: site.id,
    projectId: site.projectId,
    slug: site.slug,
    defaultHostname: site.defaultHostname,
    defaultVisibility: site.defaultVisibility,
    isDefault: site.isDefault,
    status: site.status,
    activeReleaseId: site.activeReleaseId,
    activeRoutes: site.activeReleaseId
      ? withEffectiveVisibility(
          (activeRoutesByRelease.get(site.activeReleaseId) ?? []).map(({ releaseId: _releaseId, ...route }) => route),
          site.defaultVisibility,
        )
      : [],
    releaseCount: releasesBySite.get(site.id)?.length ?? 0,
    routeCount: routesBySite.get(site.id)?.length ?? 0,
    updatedAt: dateMs(site.updatedAt),
  }));
}

async function hydratePageSiteReleases(
  releases: Array<typeof schema.pageSiteReleases.$inferSelect>,
): Promise<PageSiteRelease[]> {
  if (releases.length === 0) return [];
  const releaseIds = releases.map((release) => release.id);
  const routes = await db
    .select()
    .from(schema.pageReleaseRoutes)
    .where(inArray(schema.pageReleaseRoutes.releaseId, releaseIds));
  const routesByRelease = groupBy(routes, (route) => route.releaseId);

  return releases.map((release) => ({
    id: release.id,
    siteId: release.siteId,
    releaseNumber: release.releaseNumber,
    previousReleaseId: release.previousReleaseId,
    status: release.status,
    reason: release.reason,
    manifestHash: release.manifestHash,
    routeCount: routesByRelease.get(release.id)?.length ?? 0,
    activatedAt: dateMsOrNull(release.activatedAt),
    createdAt: dateMs(release.createdAt),
  }));
}

type RuntimeRunSummaryRow = {
  session: typeof schema.runtimeTraceSessions.$inferSelect;
  projectName: string | null;
  projectSlug: string | null;
};

async function hydrateRuntimeRunSummaries(rows: RuntimeRunSummaryRow[]): Promise<RuntimeRunSummary[]> {
  if (rows.length === 0) return [];
  const sessionIds = rows.map((row) => row.session.id);

  const [turnStats, eventStats, toolStats, recentEvents] = await Promise.all([
    db
      .select({
        traceSessionId: schema.runtimeTraceTurns.traceSessionId,
        turnCount: sql<string>`COUNT(*)`,
        inputTokens: sql<string>`COALESCE(SUM(${schema.runtimeTraceTurns.inputTokens}), 0)`,
        outputTokens: sql<string>`COALESCE(SUM(${schema.runtimeTraceTurns.outputTokens}), 0)`,
      })
      .from(schema.runtimeTraceTurns)
      .where(inArray(schema.runtimeTraceTurns.traceSessionId, sessionIds))
      .groupBy(schema.runtimeTraceTurns.traceSessionId),
    db
      .select({
        traceSessionId: schema.runtimeTraceEvents.traceSessionId,
        eventCount: sql<string>`COUNT(*)`,
        warningCount: sql<string>`COALESCE(SUM(CASE WHEN ${schema.runtimeTraceEvents.severity} IN ('warn', 'warning') THEN 1 ELSE 0 END), 0)`,
        errorCount: sql<string>`COALESCE(SUM(CASE WHEN ${schema.runtimeTraceEvents.severity} = 'error' THEN 1 ELSE 0 END), 0)`,
      })
      .from(schema.runtimeTraceEvents)
      .where(inArray(schema.runtimeTraceEvents.traceSessionId, sessionIds))
      .groupBy(schema.runtimeTraceEvents.traceSessionId),
    db
      .select({
        traceSessionId: schema.runtimeTraceToolCalls.traceSessionId,
        toolCallCount: sql<string>`COUNT(*)`,
      })
      .from(schema.runtimeTraceToolCalls)
      .where(inArray(schema.runtimeTraceToolCalls.traceSessionId, sessionIds))
      .groupBy(schema.runtimeTraceToolCalls.traceSessionId),
    db
      .select({
        traceSessionId: schema.runtimeTraceEvents.traceSessionId,
        severity: schema.runtimeTraceEvents.severity,
        safePreview: schema.runtimeTraceEvents.safePreview,
        occurredAt: schema.runtimeTraceEvents.occurredAt,
        sequence: schema.runtimeTraceEvents.sequence,
      })
      .from(schema.runtimeTraceEvents)
      .where(inArray(schema.runtimeTraceEvents.traceSessionId, sessionIds))
      .orderBy(
        desc(schema.runtimeTraceEvents.occurredAt),
        desc(schema.runtimeTraceEvents.sequence),
        desc(schema.runtimeTraceEvents.sourceEventId),
      )
      .limit(1000),
  ]);

  const turnStatsBySession = new Map(turnStats.map((item) => [item.traceSessionId, item]));
  const eventStatsBySession = new Map(eventStats.map((item) => [item.traceSessionId, item]));
  const toolStatsBySession = new Map(toolStats.map((item) => [item.traceSessionId, item]));
  const previewsBySession = new Map<string, { error: string | null; last: string | null }>();
  for (const event of recentEvents) {
    if (!event.safePreview) continue;
    const current = previewsBySession.get(event.traceSessionId) ?? { error: null, last: null };
    current.last ??= event.safePreview;
    if (event.severity === "error") current.error ??= event.safePreview;
    previewsBySession.set(event.traceSessionId, current);
  }

  return rows.map(({ projectName, projectSlug, session }) => {
    const turn = turnStatsBySession.get(session.id);
    const event = eventStatsBySession.get(session.id);
    const tool = toolStatsBySession.get(session.id);
    const previews = previewsBySession.get(session.id);
    const source = runtimeTraceSourceFromSession(session);

    return {
      id: session.id,
      externalTraceId: session.externalTraceId,
      projectId: session.projectId,
      projectName,
      projectSlug,
      localInstallationId: session.localInstallationId,
      managedRuntimeInstanceId: session.managedRuntimeInstanceId,
      managedRuntimeSessionId: session.managedRuntimeSessionId,
      sessionKey: session.sessionKey,
      sessionName: session.sessionName,
      runId: session.runId,
      agentRef: session.agentRef,
      placement: session.placement,
      runtimeProvider: session.runtimeProvider,
      runtimeModel: session.runtimeModel,
      sourceAccountId: source.accountId,
      sourceChannel: source.channel,
      sourceChatId: source.chatId,
      sourceThreadId: source.threadId,
      canonicalChatId: source.canonicalChatId,
      status: session.status,
      startedAt: dateMs(session.startedAt),
      endedAt: dateMsOrNull(session.endedAt),
      updatedAt: dateMs(session.updatedAt),
      turnCount: Number(turn?.turnCount ?? 0),
      eventCount: Number(event?.eventCount ?? 0),
      toolCallCount: Number(tool?.toolCallCount ?? 0),
      warningCount: Number(event?.warningCount ?? 0),
      errorCount: Number(event?.errorCount ?? 0),
      inputTokens: Number(turn?.inputTokens ?? 0),
      outputTokens: Number(turn?.outputTokens ?? 0),
      lastSafePreview: previews?.last ?? null,
      lastErrorPreview: previews?.error ?? null,
    };
  });
}

function dedupeRuntimeRunsBySession(runs: RuntimeRunSummary[]): RuntimeRunSummary[] {
  const seen = new Set<string>();
  const output: RuntimeRunSummary[] = [];
  for (const run of runs) {
    const key = runtimeRunIdentityKey(run);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(run);
  }
  return output;
}

function runtimeRunIdentityKey(run: RuntimeRunSummary): string {
  const parsed = parseRuntimeSessionKey(run.sessionKey);
  const channel = normalizeRuntimeSourceChannel(run.sourceChannel ?? parsed.channel);
  const account = run.sourceAccountId ?? parsed.accountId ?? "*";
  const chat = normalizeRuntimeSourceChatId(run.sourceChatId ?? parsed.chatId);
  const identity = chat ?? run.canonicalChatId ?? run.sessionKey;
  return [
    run.projectId ?? "*",
    run.localInstallationId ?? "*",
    channel ?? "runtime",
    account,
    identity,
  ].join(":");
}

function runtimeTraceSourceFromSession(session: typeof schema.runtimeTraceSessions.$inferSelect) {
  const legacy = runtimeTraceSourceFromMetadata(session.safeMetadataJson);
  const parsed = parseRuntimeSessionKey(session.sessionKey);
  return {
    accountId: textOrNull(session.sourceAccountId) ?? legacy.accountId ?? parsed.accountId,
    canonicalChatId: textOrNull(session.canonicalChatId) ?? legacy.canonicalChatId,
    channel: textOrNull(session.sourceChannel) ?? legacy.channel ?? parsed.channel,
    chatId: textOrNull(session.sourceChatId) ?? legacy.chatId ?? parsed.chatId,
    threadId: textOrNull(session.sourceThreadId) ?? legacy.threadId,
  };
}

function runtimeTraceSourceFromMetadata(metadata: JsonRecord | null | undefined) {
  const source = metadata?.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {
      accountId: null,
      canonicalChatId: null,
      channel: null,
      chatId: null,
      threadId: null,
    };
  }
  const record = source as JsonRecord;
  return {
    accountId: textOrNull(record.accountId),
    canonicalChatId: textOrNull(record.canonicalChatId),
    channel: textOrNull(record.channel),
    chatId: textOrNull(record.chatId),
    threadId: textOrNull(record.threadId),
  };
}

function parseRuntimeSessionKey(sessionKey: string) {
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent" || parts.length < 6) {
    return { accountId: null, channel: null, chatId: null };
  }
  const chatKind = textOrNull(parts[4]);
  const rawChatId = textOrNull(parts.slice(5).join(":"));
  return {
    accountId: textOrNull(parts[3]),
    channel: textOrNull(parts[2]),
    chatId: normalizeStructuredSessionChatId(chatKind, rawChatId),
  };
}

function normalizeRuntimeSourceChannel(channel: string | null | undefined): string | null {
  const value = textOrNull(channel);
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower.includes("whatsapp")) return "whatsapp";
  if (lower.includes("telegram")) return "telegram";
  if (lower.includes("discord")) return "discord";
  if (lower.includes("slack")) return "slack";
  if (lower.includes("codex")) return "codex";
  if (lower.includes("claude")) return "claude";
  return lower;
}

function normalizeRuntimeSourceChatId(chatId: string | null | undefined): string | null {
  const value = textOrNull(chatId);
  if (!value) return null;
  if (value.endsWith("@g.us")) return `group:${value.slice(0, -5)}`;
  if (value.endsWith("@s.whatsapp.net")) return `chat:${value.slice(0, -15)}`;
  return value;
}

function normalizeStructuredSessionChatId(chatKind: string | null, chatId: string | null): string | null {
  if (!chatId) return null;
  if (chatId.includes("@") || !chatKind) return chatId;
  if (chatKind === "group") return `${chatId}@g.us`;
  return chatId;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

async function canAccessRuntimeTraceSession(workspace: ConsoleWorkspace, projectId: string | null) {
  if (!projectId) return false;
  return canAccessProject(workspace, projectId, "read");
}

function runtimeTurnToView(turn: typeof schema.runtimeTraceTurns.$inferSelect): RuntimeRunTurn {
  return {
    id: turn.id,
    sourceTurnId: turn.sourceTurnId,
    runtimeLeaseId: turn.runtimeLeaseId,
    sandboxId: turn.sandboxId,
    sequence: turn.sequence,
    status: turn.status,
    promptSha256: turn.promptSha256,
    userPromptSha256: turn.userPromptSha256,
    systemPromptSha256: turn.systemPromptSha256,
    requestBlobSha256: turn.requestBlobSha256,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheReadTokens: turn.cacheReadTokens,
    cacheCreationTokens: turn.cacheCreationTokens,
    costUsd: turn.costUsd,
    startedAt: dateMs(turn.startedAt),
    completedAt: dateMsOrNull(turn.completedAt),
  };
}

function runtimeEventToView(event: typeof schema.runtimeTraceEvents.$inferSelect): RuntimeRunEvent {
  return {
    id: event.id,
    turnId: event.turnId,
    sourceEventId: event.sourceEventId,
    runtimeLeaseId: event.runtimeLeaseId,
    sandboxId: event.sandboxId,
    sequence: event.sequence,
    eventType: event.eventType,
    eventGroup: event.eventGroup,
    severity: event.severity,
    status: event.status,
    safePreview: event.safePreview,
    safePayload: record(event.safePayloadJson),
    blobRef: event.blobRef,
    occurredAt: dateMs(event.occurredAt),
  };
}

function runtimeToolCallToView(toolCall: typeof schema.runtimeTraceToolCalls.$inferSelect): RuntimeRunToolCall {
  return {
    id: toolCall.id,
    turnId: toolCall.turnId,
    runtimeLeaseId: toolCall.runtimeLeaseId,
    sandboxId: toolCall.sandboxId,
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    status: toolCall.status,
    inputPreview: toolCall.inputPreview,
    outputPreview: toolCall.outputPreview,
    inputBlobRef: toolCall.inputBlobRef,
    outputBlobRef: toolCall.outputBlobRef,
    approval: record(toolCall.approvalJson),
    durationMs: toolCall.durationMs,
    startedAt: dateMs(toolCall.startedAt),
    completedAt: dateMsOrNull(toolCall.completedAt),
  };
}

function runtimeRunHasActivity(run: RuntimeRunSummary): boolean {
  return run.turnCount > 0 || run.eventCount > 0 || run.toolCallCount > 0;
}

function runtimeBlobToView(blob: typeof schema.runtimeTraceBlobs.$inferSelect): RuntimeRunBlobRef {
  return {
    id: blob.id,
    turnId: blob.turnId,
    runtimeLeaseId: blob.runtimeLeaseId,
    sandboxId: blob.sandboxId,
    kind: blob.kind,
    sha256: blob.sha256,
    sizeBytes: blob.sizeBytes,
    sensitivity: blob.sensitivity,
    retentionClass: blob.retentionClass,
    createdAt: dateMs(blob.createdAt),
  };
}

type StoredPageReleaseRoute = Omit<PageReleaseRoute, "effectiveVisibility">;
type PageReleaseRouteWithRelease = StoredPageReleaseRoute & { releaseId: string };

function withEffectiveVisibility(
  routes: StoredPageReleaseRoute[],
  siteVisibility: PageReleaseRoute["visibility"],
): PageReleaseRoute[] {
  return routes.map((route) => ({ ...route, effectiveVisibility: effectivePageVisibility(siteVisibility, route.visibility) }));
}

async function listPageReleaseRoutes(releaseId: string): Promise<StoredPageReleaseRoute[]> {
  const routes = await listPageReleaseRoutesForReleaseIds([releaseId]);
  return routes.map(({ releaseId: _releaseId, ...route }) => route);
}

async function listPageReleaseRoutesForReleaseIds(releaseIds: string[]): Promise<PageReleaseRouteWithRelease[]> {
  if (releaseIds.length === 0) return [];
  const rows = await db
    .select({
      releaseRoute: schema.pageReleaseRoutes,
      artifact: schema.artifacts,
      artifactVersion: schema.artifactVersions,
    })
    .from(schema.pageReleaseRoutes)
    .innerJoin(schema.artifacts, eq(schema.pageReleaseRoutes.artifactId, schema.artifacts.id))
    .innerJoin(schema.artifactVersions, eq(schema.pageReleaseRoutes.artifactVersionId, schema.artifactVersions.id))
    .where(inArray(schema.pageReleaseRoutes.releaseId, releaseIds))
    .orderBy(desc(schema.pageReleaseRoutes.priority), schema.pageReleaseRoutes.path);

  return rows.map(({ artifact, artifactVersion, releaseRoute }) => ({
    id: releaseRoute.id,
    releaseId: releaseRoute.releaseId,
    routeId: releaseRoute.routeId,
    path: releaseRoute.path,
    matchType: releaseRoute.matchType,
    priority: releaseRoute.priority,
    artifactId: artifact.id,
    artifactName: artifact.name,
    artifactDescription: artifact.description ?? "",
    artifactVersionId: artifactVersion.id,
    artifactVersion: `v${artifactVersion.versionNumber}`,
    entrypoint: releaseRoute.entrypoint,
    assetBase: releaseRoute.assetBase,
    visibility: releaseRoute.visibility,
  }));
}

/** Adds each host's custom domains, pending ones included, to a host list (the CLI's `ravi pages list`). */
export async function withPageCustomDomains<T extends { id: string }>(
  organizationId: string,
  sites: T[],
): Promise<Array<T & { customDomains: PageCustomDomainSummary[] }>> {
  const domainsBySite = await listPageCustomDomains(
    organizationId,
    sites.map((site) => site.id),
  );
  return sites.map((site) => ({ ...site, customDomains: domainsBySite.get(site.id) ?? [] }));
}

async function listPageCustomDomains(
  organizationId: string,
  siteIds: string[],
): Promise<Map<string, PageCustomDomainSummary[]>> {
  if (siteIds.length === 0) return new Map();
  const rows = await db
    .select({
      siteId: schema.pageDomainBindings.pageSiteId,
      hostname: schema.pageDomainBindings.hostname,
      bindingStatus: schema.domainBindings.status,
      readinessJson: schema.domainBindings.readinessJson,
    })
    .from(schema.pageDomainBindings)
    .innerJoin(schema.domainBindings, eq(schema.pageDomainBindings.domainBindingId, schema.domainBindings.id))
    .where(
      and(
        eq(schema.domainBindings.organizationId, organizationId),
        eq(schema.domainBindings.product, "pages"),
        inArray(schema.pageDomainBindings.pageSiteId, siteIds),
        ne(schema.domainBindings.status, "deleted"),
      ),
    )
    .orderBy(schema.pageDomainBindings.hostname);

  const domainsBySite = new Map<string, PageCustomDomainSummary[]>();
  for (const row of rows) {
    const domains = domainsBySite.get(row.siteId) ?? [];
    domains.push(pageCustomDomainSummary(row.hostname, row.bindingStatus, row.readinessJson));
    domainsBySite.set(row.siteId, domains);
  }
  return domainsBySite;
}

function pageUrlForHost(hostname: string, path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `https://${hostname}${normalizedPath === "/" ? "/" : normalizedPath}`;
}

function pageTitle(route: PageReleaseRoute, site: PageSiteSummary) {
  if (route.artifactName.trim()) return route.artifactName;
  if (route.path === "/") return `${site.slug} home`;
  return route.path
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? site.slug;
}

function pageDescription(route: PageReleaseRoute, site: PageSiteSummary) {
  if (route.artifactDescription.trim()) return route.artifactDescription;
  if (route.path === "/") return `Home page published on ${site.defaultHostname}.`;
  return `Published page on ${site.defaultHostname}.`;
}

function pageStatusText(site: PageSiteSummary, route: PageReleaseRoute) {
  const state = site.status === "active" && site.activeReleaseId ? "live" : site.status;
  return `${state} · ${route.artifactVersion} · ${route.visibility}`;
}

async function listMembers(workspace: ConsoleWorkspace): Promise<Member[]> {
  const rows = await db
    .select({
      membership: schema.organizationMemberships,
      user: schema.users,
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.organizationMemberships.userId, schema.users.id))
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, workspace.organization.id),
        ne(schema.organizationMemberships.status, "removed"),
      ),
    )
    .orderBy(schema.users.displayName);

  return rows.map(({ membership, user }) => ({
    id: user.id,
    membershipId: membership.id,
    name: user.displayName ?? user.primaryEmail,
    email: user.primaryEmail,
    role: membership.role,
    status: membership.status,
    mark: markFor(user.displayName ?? user.primaryEmail),
    color: colorFor(user.id),
    joined: dateMs(membership.createdAt),
  }));
}

async function listProjectRecords(organizationId: string) {
  return db.select().from(schema.projects).where(eq(schema.projects.organizationId, organizationId));
}

async function projectRecord(workspace: ProjectAccessWorkspace, projectRef: string) {
  return findAccessibleProjectRecord(workspace, projectRef);
}

async function artifactRecord(workspace: ProjectAccessWorkspace, artifactId: string) {
  const [row] = await db
    .select({
      artifact: schema.artifacts,
      project: schema.projects,
    })
    .from(schema.artifacts)
    .innerJoin(schema.projects, eq(schema.artifacts.projectId, schema.projects.id))
    .where(and(eq(schema.artifacts.id, artifactId), eq(schema.projects.organizationId, workspace.organization.id)))
    .limit(1);
  if (!row) return null;
  if (!(await canAccessProject(workspace, row.project.id, "read"))) return null;
  return row.artifact;
}

function organizationToOrg(
  organization: typeof schema.organizations.$inferSelect,
  role: string,
  plan: string,
): Org {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    plan,
    role,
    mark: markFor(organization.name),
    color: colorFor(organization.id),
  };
}

function latestBy<T>(items: T[], score: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>((latest, item) => {
    if (!latest) return item;
    return score(item) > score(latest) ? item : latest;
  }, undefined);
}

function emptyMailOverview(
  workspace: ConsoleWorkspace,
  domains: Array<typeof schema.mailDomains.$inferSelect>,
  scope: "organization" | "project",
  projectId: string | null,
): MailOverviewData {
  const managedDomains = Array.from(getManagedMailDomains());
  return {
    scope,
    projectId,
    domains: domains.map((domain) => ({
      id: domain.id,
      domain: domain.domain,
      status: domain.status,
      providerAdapter: domain.providerAdapter,
      managed: managedDomains.includes(domain.domain),
      mailboxCount: 0,
      routeCount: 0,
      updatedAt: dateMs(domain.updatedAt),
    })),
    mailboxes: [],
    messages: [],
    managedDomains,
    agentAddressPattern: agentAddressPattern(workspace, managedDomains[0] ?? "ravi.bot"),
  };
}

async function mailMessageSummary(
  message: MailMessage,
  decrypter: MailPayloadDecrypter | null,
): Promise<MailMessageSummary> {
  const [subjectResult, bodyResult, addressResult, headersResult] = await Promise.all([
    decryptMailMessagePayload(decrypter, message, "subject"),
    decryptMailMessagePayload(decrypter, message, "parsed_body"),
    decryptMailMessagePayload(decrypter, message, "address_summary"),
    decryptMailMessagePayload(decrypter, message, "headers"),
  ]);
  const headerPayload = parseMailHeaderPayload(headersResult.plaintext);
  const body = parseMailBodyPayload(bodyResult.plaintext);
  let bodyText = body.text ?? body.htmlText;
  let addressSummary = addressResult.plaintext ? parseMailAddressSummary(addressResult.plaintext) : null;
  if (!addressSummary && headerPayload.headers.length > 0) {
    addressSummary = mailAddressSummaryFromHeaders(headerPayload.headers);
  }
  let subject = cleanText(subjectResult.plaintext) ?? headerValue(headerPayload.headers, "subject");

  if ((!addressSummary || !subject || !bodyText) && decrypter) {
    const rawResult = await decryptMailMessagePayload(decrypter, message, "raw_mime");
    const rawPayload = parseRawMimePayload(rawResult.plaintext);
    if (!addressSummary && rawPayload.headers.length > 0) {
      addressSummary = mailAddressSummaryFromHeaders(rawPayload.headers);
    }
    subject ??= headerValue(rawPayload.headers, "subject");
    bodyText ??= rawPayload.body;
  }

  const decryptError = [
    subjectResult.error,
    bodyResult.error,
    addressResult.error,
    headersResult.error,
  ].find(Boolean) ?? null;

  return {
    bodyHtml: body.html,
    bodyPreview: previewText(bodyText),
    bodyText,
    cc: addressSummary?.cc.map(formatMailAddress) ?? [],
    decrypted: Boolean(subjectResult.plaintext || bodyResult.plaintext || addressResult.plaintext),
    decryptError,
    direction: message.direction,
    from: addressSummary?.from.map(formatMailAddress) ?? [],
    fromHash: message.fromHash,
    hasAddressSummary: Boolean(message.addressSummaryCipherRef),
    hasParsedBody: Boolean(message.parsedBodyCipherRef),
    hasSubject: Boolean(message.subjectCipherRef),
    id: message.id,
    internetMessageId: addressSummary?.internetMessageId ?? null,
    mailboxId: message.mailboxId,
    receivedAt: dateMsOrNull(message.receivedAt),
    sentAt: dateMsOrNull(message.sentAt),
    sizeBytes: message.sizeBytes,
    status: message.status,
    subject,
    to: addressSummary?.to.map(formatMailAddress) ?? [],
    updatedAt: dateMs(message.updatedAt),
  };
}

async function decryptMailMessagePayload(
  decrypter: MailPayloadDecrypter | null,
  message: MailMessage,
  payloadKind: MailMessagePayloadKind,
): Promise<{ plaintext: string | null; error: string | null }> {
  const cipherRef = messageCipherRef(message, payloadKind);
  if (!cipherRef) return { plaintext: null, error: null };
  if (!decrypter) return { plaintext: null, error: "decrypt_unavailable" };

  try {
    return {
      plaintext: await decrypter.decryptMessagePayload({
        cipherRef,
        message,
        payloadKind,
      }),
      error: null,
    };
  } catch (error) {
    console.warn("Ravi Mail console payload decrypt failed", {
      errorName: error instanceof Error ? error.name : typeof error,
      messageId: message.id,
      payloadKind,
    });
    return { plaintext: null, error: "decrypt_failed" };
  }
}

function messageCipherRef(message: MailMessage, payloadKind: MailMessagePayloadKind): MailCipherRef | null {
  if (payloadKind === "subject") return (message.subjectCipherRef as MailCipherRef | null) ?? null;
  if (payloadKind === "parsed_body") return (message.parsedBodyCipherRef as MailCipherRef | null) ?? null;
  if (payloadKind === "address_summary") return (message.addressSummaryCipherRef as MailCipherRef | null) ?? null;
  if (payloadKind === "headers") return message.headersCipherRef as MailCipherRef;
  return message.rawMimeCipherRef as MailCipherRef;
}

function parseMailBodyPayload(value: string | null) {
  if (!value) {
    return { html: null as string | null, htmlText: null as string | null, text: null as string | null };
  }

  try {
    const parsed = JSON.parse(value) as { html?: unknown; schemaVersion?: unknown; text?: unknown };
    const text = typeof parsed.text === "string" ? cleanText(parsed.text) : null;
    const html = typeof parsed.html === "string" ? parsed.html : null;
    return {
      html,
      htmlText: text ? null : htmlToText(html),
      text,
    };
  } catch {
    return {
      html: null,
      htmlText: null,
      text: cleanText(value),
    };
  }
}

function parseMailHeaderPayload(value: string | null): { headers: MailAddressHeader[] } {
  if (!value) return { headers: [] };

  try {
    const parsed = JSON.parse(value) as { headers?: unknown; schemaVersion?: unknown };
    const headers = normalizeMailHeaders(parsed.headers);
    if (headers.length > 0) return { headers };
  } catch {
    // Fall through to raw MIME/header parsing.
  }

  return { headers: parseRawHeaders(value) };
}

function parseRawMimePayload(value: string | null): { body: string | null; headers: MailAddressHeader[] } {
  if (!value) return { body: null, headers: [] };
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parsed = splitMimePart(normalized);
  if (!parsed) return { body: cleanText(normalized), headers: parseRawHeaders(normalized) };
  const contentType = headerValue(parsed.headers, "content-type") ?? "";
  const boundary = mimeHeaderParam(contentType, "boundary");
  if (boundary) {
    const multipart = parseMultipartBody(parsed.body, boundary);
    return {
      body: multipart ?? decodeMimeBody(parsed.body, parsed.headers),
      headers: parsed.headers,
    };
  }
  return {
    body: decodeMimeBody(parsed.body, parsed.headers),
    headers: parsed.headers,
  };
}

function parseMultipartBody(body: string, boundary: string): string | null {
  const marker = `--${boundary}`;
  const parts = body
    .split(marker)
    .map((part) => part.replace(/^\n/, "").replace(/\n$/, ""))
    .filter((part) => part.trim() && part.trim() !== "--" && !part.trim().startsWith("--"));

  const parsedParts = parts.flatMap((part) => {
    const parsed = splitMimePart(part);
    if (!parsed) return [];
    const contentType = headerValue(parsed.headers, "content-type") ?? "text/plain";
    const nestedBoundary = mimeHeaderParam(contentType, "boundary");
    if (nestedBoundary) {
      const nested = parseMultipartBody(parsed.body, nestedBoundary);
      return nested ? [{ contentType: "text/plain", text: nested }] : [];
    }
    return [{ contentType, text: decodeMimeBody(parsed.body, parsed.headers) }];
  });

  const plain = parsedParts.find((part) => mediaType(part.contentType) === "text/plain" && part.text);
  if (plain?.text) return plain.text;
  const html = parsedParts.find((part) => mediaType(part.contentType) === "text/html" && part.text);
  return html?.text ?? null;
}

function splitMimePart(value: string): { body: string; headers: MailAddressHeader[] } | null {
  const separatorIndex = value.indexOf("\n\n");
  if (separatorIndex < 0) return null;
  return {
    body: value.slice(separatorIndex + 2),
    headers: parseRawHeaders(value.slice(0, separatorIndex)),
  };
}

function parseRawHeaders(value: string): MailAddressHeader[] {
  const headers: MailAddressHeader[] = [];
  let current: MailAddressHeader | null = null;

  for (const line of value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (!line.trim()) break;
    if (/^[ \t]/.test(line) && current) {
      current.value = `${current.value} ${line.trim()}`;
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;
    current = {
      name: line.slice(0, separatorIndex).trim(),
      value: line.slice(separatorIndex + 1).trim(),
    };
    headers.push(current);
  }

  return headers;
}

function normalizeMailHeaders(value: unknown): MailAddressHeader[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Partial<MailAddressHeader>;
    if (typeof record.name !== "string" || typeof record.value !== "string") return [];
    return [{ name: record.name, value: record.value }];
  });
}

function headerValue(headers: MailAddressHeader[], name: string) {
  return cleanText(headers.find((header) => header.name.toLowerCase() === name)?.value ?? null);
}

function mediaType(value: string) {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

function mimeHeaderParam(value: string, name: string) {
  const pattern = new RegExp(`${name}=("[^"]+"|[^;]+)`, "i");
  const match = value.match(pattern);
  return match?.[1]?.trim().replace(/^"|"$/g, "") || null;
}

function decodeMimeBody(value: string, headers: MailAddressHeader[]) {
  const encoding = headerValue(headers, "content-transfer-encoding")?.toLowerCase();
  const contentType = headerValue(headers, "content-type") ?? "";
  const decoded =
    encoding === "quoted-printable"
      ? decodeQuotedPrintable(value)
      : encoding === "base64"
        ? decodeBase64Body(value)
        : value;
  return mediaType(contentType) === "text/html" ? htmlToText(decoded) : cleanText(decoded);
}

function decodeQuotedPrintable(value: string) {
  const normalized = value.replace(/=\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    const hex = normalized.slice(index + 1, index + 3);
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    bytes.push(char.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeBase64Body(value: string) {
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(value.replace(/\s+/g, "")), (char) => char.charCodeAt(0)),
    );
  } catch {
    return value;
  }
}

function htmlToText(value: string | null) {
  if (!value) return null;
  return cleanText(
    value
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

function cleanText(value: string | null) {
  const cleaned = value?.replace(/\u0000/g, "").trim();
  return cleaned || null;
}

function previewText(value: string | null) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function agentAddressPattern(workspace: ConsoleWorkspace, domain: string) {
  const org = slugPart(workspace.organization.slug || workspace.organization.name || "org");
  return {
    canonicalExample: `agent-${org}@${domain}`,
    aliasCandidate: `agent+${org}@${domain}`,
    plusAddressingReserved: true,
  };
}

function slugPart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 32) || "org";
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) {
    const key = keyFor(item);
    if (!key) continue;
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function groupBy<T, K>(items: T[], getKey: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const current = result.get(key) ?? [];
    current.push(item);
    result.set(key, current);
  }
  return result;
}

function versionStatus(status: string): ArtifactVersion["status"] {
  if (status === "ready" || status === "created") return status;
  if (status === "building") return "building";
  if (status === "failed") return "failed";
  if (status === "archived") return "archived";
  return "created";
}

function actorLabel(actorType: string, actorId: string | null) {
  if (actorType === "system") return "system";
  if (actorType === "anonymous") return "anonymous";
  return actorId ?? actorType;
}

type DateValue = Date | string | number | null | undefined;

function dateMs(value: DateValue) {
  return coerceDateMs(value) ?? 0;
}

function dateMsOrNull(value: DateValue) {
  return coerceDateMs(value);
}

function coerceDateMs(value: DateValue) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function textFromJson(value: unknown, key: string) {
  const data = record(value);
  const item = data[key];
  return typeof item === "string" && item.trim() ? item : null;
}
