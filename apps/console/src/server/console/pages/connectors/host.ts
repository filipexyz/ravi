import { and, eq } from "drizzle-orm";
import { ZodError } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import type { BasesCaller } from "@/server/console/bases/context";
import {
  archiveRowThroughViewForCaller,
  basesCallerForPagesViewer,
  chartDataForCaller,
  createRowThroughViewForCaller,
  describeViewForCaller,
  getRowThroughViewForCaller,
  queryViewForCaller,
  updateRowThroughViewForCaller,
  viewVersionForCaller,
} from "@/server/console/bases";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { listPageSitesForProject, type PageSite, type PageVisibility } from "@/server/console/pages";
import type { ConsoleWorkspace } from "@/server/console/workspace";
import {
  findPagesSessionByToken,
  pagesPrivateAuthRepositoryForDb,
  pagesSessionActorKind,
  resolvePagesGuestViewer,
  verifyPagesSessionForSite,
  type PagesPrivateAuthRepository,
  type PagesSessionRecord,
} from "@/server/console/pages/auth";
import { parsePageChatSiteSettings } from "@/server/console/pages/chat/site-settings";
import {
  BASES_CHARTS_DATA_ACTION_ID,
  BASES_VIEWS_DESCRIBE_ACTION_ID,
  BASES_VIEWS_QUERY_ACTION_ID,
  BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID,
  BASES_VIEWS_ROWS_CREATE_ACTION_ID,
  BASES_VIEWS_ROWS_GET_ACTION_ID,
  BASES_VIEWS_ROWS_UPDATE_ACTION_ID,
  BASES_VIEWS_VERSION_ACTION_ID,
  curatedPlatformUsesSnapshot,
  getPagesConnectorCatalogEntry,
  IDENTITY_ASSERTION_ACTION_ID,
  isActionAllowlisted,
  KNOWLEDGE_SEARCH_ACTION_ID,
  isBasesConnectorAction,
  listPagesConnectorCatalogEntries,
  PAGES_CONNECTOR_CATALOG_SCHEMA_VERSION,
  PAGES_PUBLISHED_LIST_ACTION_ID,
  PAGES_SITES_LIST_ACTION_ID,
  PAGES_THEME_GET_ACTION_ID,
  PROJECTS_LIST_ACTION_ID,
  projectBasesErrorDetails,
  projectCatalogOutput,
  publicCatalogEntry,
  snapshotRevisionForAction,
  validateCatalogInput,
  withAlwaysAllowlistedUses,
  type PagesConnectorCatalogEntry,
  type PagesConnectorCatalogProjection,
  type PagesConnectorClass,
  type BasesConnectorErrorDetails,
  type BasesViewsQueryInput,
  type BasesViewsRowsArchiveInput,
  type BasesViewsRowsCreateInput,
  type BasesViewsRowsGetInput,
  type BasesViewsRowsUpdateInput,
  type PagesConnectorUsesSnapshot,
  type PagesThemeGetOutput,
} from "@/server/console/pages/connectors/catalog";
import {
  searchMarkedPagesForViewer,
  type PageChatViewer,
} from "@/server/console/pages/connectors/knowledge-search";
import { originMatchesRequestHost } from "@/server/console/pages/viewer-assertions/audience";
import { mintHumanViewerAssertion } from "@/server/console/pages/viewer-assertions/mint";
import { findActiveViewerAssertionAudience } from "@/server/console/pages/viewer-assertions/registry";
import { findAccessibleProjectRecord, type ProjectAccessWorkspace, type ProjectAuthorizationCheck } from "@/server/console/project-access";
import { listProjects, listPublishedPages } from "@/server/console/read-model";
import { pagesThemeForProject } from "@/server/console/widgets/live-theme";
import { db, schema } from "@/server/db";
import { isRateLimited } from "@/server/security/rate-limit";
import { connectorUsesForOrigin, isolatedPagesOriginsRequired } from "./origin-policy";
import { delegatePageOperation, shouldDelegatePageOperation } from "@/server/console/executor/delegation";

export type PagesConnectorSite = {
  id: string;
  organizationId: string;
  projectId: string;
  defaultHostname: string;
  defaultVisibility: PageVisibility;
  status: "active" | "disabled" | "deleted";
  activeReleaseId: string | null;
};

export type PagesConnectorCatalogQuery = {
  ids?: string | null;
  q?: string | null;
  auth?: string | null;
  class?: string | null;
  executable?: string | null;
};

export type PagesConnectorCatalogResult = {
  schemaVersion: number;
  siteId: string;
  projectId: string;
  releaseId: string | null;
  actions: PagesConnectorCatalogProjection[];
};

export type PagesConnectorExecResult = {
  ok: true;
  id: string;
  revision: number;
  output: unknown;
};

/** Exec error body: `{ error }`; `ravi.bases.*` errors may add `fieldErrors` or `current`. */
export type PagesConnectorExecErrorBody = { error: string } & BasesConnectorErrorDetails;

/** A `ravi.bases.*` service error with the details a generated UI may receive. */
export class PagesConnectorBasesExecError extends ConsoleApiError {
  constructor(
    status: number,
    error: string,
    public readonly details: BasesConnectorErrorDetails,
  ) {
    super(status, { error });
  }
}

/** The JSON body the exec route returns for a connector error. */
export function pagesConnectorExecErrorBody(error: ConsoleApiError): PagesConnectorExecErrorBody {
  return error instanceof PagesConnectorBasesExecError
    ? { error: error.payload.error, ...error.details }
    : { error: error.payload.error };
}

type ConnectorAuditInput = {
  action: string;
  actorId: string | null;
  actorType: "anonymous" | "user" | "system";
  metadataJson: Record<string, unknown>;
  organizationId?: string | null;
  projectId?: string | null;
  requestId?: string | null;
  targetId?: string | null;
  targetType: string;
};

export type PagesConnectorBasesServices = {
  describeView: typeof describeViewForCaller;
  queryView: typeof queryViewForCaller;
  viewVersion: typeof viewVersionForCaller;
  createRow: typeof createRowThroughViewForCaller;
  updateRow: typeof updateRowThroughViewForCaller;
  getRow: typeof getRowThroughViewForCaller;
  archiveRow: typeof archiveRowThroughViewForCaller;
  chartData: typeof chartDataForCaller;
};

export type PagesConnectorHostDeps = {
  /** Internal callback marker; never copied from an HTTP request body. */
  executorCallback?: boolean;
  delegateOperation?: typeof delegatePageOperation;
  shouldDelegateOperation?: typeof shouldDelegatePageOperation;
  authRepository?: PagesPrivateAuthRepository;
  findSiteByHost?: (host: string) => Promise<PagesConnectorSite | null>;
  loadUsesSnapshot?: (input: {
    releaseId: string | null;
    siteId: string;
  }) => Promise<PagesConnectorUsesSnapshot | null>;
  findAccessibleProjectRecord?: typeof findAccessibleProjectRecord;
  /** Current-policy read check of the Pages viewer session; defaults to canAccessProject. */
  canReadProject?: ProjectAuthorizationCheck;
  listPageSitesForProject?: typeof listPageSitesForProject;
  listProjects?: typeof listProjects;
  listPublishedPages?: typeof listPublishedPages;
  findViewerAssertionAudience?: typeof findActiveViewerAssertionAudience;
  insertAudit?: (input: ConnectorAuditInput) => Promise<void>;
  bases?: Partial<PagesConnectorBasesServices>;
  basesFeatureEnabled?: (input: { organizationId: string; role: string }) => Promise<boolean>;
  findUserEmail?: (userId: string) => Promise<string | null>;
  isRateLimited?: typeof isRateLimited;
  /** `ravi.pages.theme.get`: the effective theme of the site's project. */
  resolvePagesTheme?: (input: { organizationId: string; projectId: string }) => Promise<PagesThemeGetOutput>;
  /** `ravi.knowledge.search`: whether Page Chat is on for the site (`console.pages.chat` plus the site setting). */
  pageChatEnabled?: (site: PagesConnectorSite) => Promise<boolean>;
  resolveGuestViewer?: typeof resolvePagesGuestViewer;
  searchMarkedPages?: typeof searchMarkedPagesForViewer;
};

/**
 * Exec ceilings per window for one viewer on one site, one site, and one
 * organization (`connector_rate_limited`). Checked in that order, so calls a
 * viewer's own ceiling refuses do not count against the site or organization.
 */
export const PAGES_CONNECTOR_EXEC_LIMITS = {
  viewer: 120,
  site: 600,
  organization: 1200,
  windowMs: 60_000,
} as const;

/** `ravi.knowledge.search` calls per minute for one viewer on one site. */
export const PAGES_KNOWLEDGE_SEARCH_LIMIT = { perViewer: 30, windowMs: 60_000 } as const;

const DEFAULT_BASES_SERVICES: PagesConnectorBasesServices = {
  describeView: describeViewForCaller,
  queryView: queryViewForCaller,
  viewVersion: viewVersionForCaller,
  createRow: createRowThroughViewForCaller,
  updateRow: updateRowThroughViewForCaller,
  getRow: getRowThroughViewForCaller,
  archiveRow: archiveRowThroughViewForCaller,
  chartData: chartDataForCaller,
};

const PAGE_VISIBILITIES = new Set(["public", "private", "protected_link", "password"]);

export async function getPagesConnectorCatalog(
  input: {
    host: string;
    pagesSession?: string | null;
    query?: PagesConnectorCatalogQuery;
    requestId: string;
  },
  deps: PagesConnectorHostDeps = {},
): Promise<PagesConnectorCatalogResult> {
  const site = await resolveConnectorSite(input.host, deps);
  const workspace = await resolveViewerWorkspace({
    host: input.host,
    pagesSession: input.pagesSession,
    requestId: input.requestId,
    site,
    deps,
  });
  const snapshot = await resolveUsesSnapshot(site, deps);
  const missingSession = !workspace;
  const requestedIds = parseCsv(input.query?.ids);
  const query = (input.query?.q ?? "").trim().toLowerCase();
  const authFilter = input.query?.auth === "platform" || input.query?.auth === "oauth" ? input.query.auth : null;
  const classFilter = isConnectorClass(input.query?.class) ? input.query.class : null;
  const executableOnly = input.query?.executable === "true";

  const allowlistedIds = new Set(snapshot.uses.map((item) => item.id));
  const basesSession =
    workspace && input.pagesSession && [...allowlistedIds].some(isBasesConnectorAction)
      ? await findHumanViewerSession({ deps, pagesSession: input.pagesSession, site, workspace })
      : null;
  const actions = listPagesConnectorCatalogEntries()
    .filter((entry) => allowlistedIds.has(entry.id))
    .filter((entry) => requestedIds.length === 0 || requestedIds.includes(entry.id))
    .filter((entry) => !authFilter || entry.auth === authFilter)
    .filter((entry) => !classFilter || entry.class === classFilter)
    .filter((entry) => !query || matchesQuery(entry, query))
    .map((entry) =>
      projectCatalogAction(entry, {
        allowlisted: true,
        humanViewer: Boolean(basesSession),
        missingSession,
        workspace,
      }),
    )
    .filter((entry) => !executableOnly || entry.executable);

  return {
    schemaVersion: PAGES_CONNECTOR_CATALOG_SCHEMA_VERSION,
    siteId: site.id,
    projectId: site.projectId,
    releaseId: site.activeReleaseId,
    actions,
  };
}

export async function execPagesConnector(
  input: {
    host: string;
    id: unknown;
    input?: unknown;
    origin?: string | null;
    pagesSession?: string | null;
    requestId: string;
  },
  deps: PagesConnectorHostDeps = {},
): Promise<PagesConnectorExecResult> {
  const actionId = typeof input.id === "string" ? input.id.trim() : "";
  if (!actionId) {
    throw new ConsoleApiError(400, { error: "payload_invalid" });
  }

  const site = await resolveConnectorSite(input.host, deps);
  if (!input.pagesSession) {
    await auditConnector(deps, {
      action: "pages.connector.exec.denied",
      actorId: null,
      host: input.host,
      outcome: "connector_session_required",
      requestId: input.requestId,
      site,
      actionId,
    });
    throw new ConsoleApiError(401, { error: "connector_session_required" });
  }

  // Even built-ins fail closed for a legacy incompatible single-origin release.
  let snapshot = isolatedPagesOriginsRequired() ? await resolveUsesSnapshot(site, deps) : undefined;

  // Site built-in: placed before the member-only checks below, which answer
  // every guest 401. It skips the `uses` allowlist: it returns only this
  // site's routes marked for page viewers that the viewer can already open.
  if (actionId === KNOWLEDGE_SEARCH_ACTION_ID) {
    return execKnowledgeSearch({
      actionId,
      deps,
      host: input.host,
      input: input.input,
      pagesSession: input.pagesSession,
      requestId: input.requestId,
      site,
    });
  }

  const workspace = await resolveViewerWorkspace({
    host: input.host,
    pagesSession: input.pagesSession,
    requestId: input.requestId,
    site,
    deps,
  });
  if (!workspace) {
    await auditConnector(deps, {
      action: "pages.connector.exec.denied",
      actorId: null,
      host: input.host,
      outcome: "connector_unauthorized",
      requestId: input.requestId,
      site,
      actionId,
    });
    throw new ConsoleApiError(401, { error: "connector_unauthorized" });
  }

  if (execRateLimited(site, workspace, deps)) {
    throw new ConsoleApiError(429, { error: "connector_rate_limited" });
  }

  snapshot ??= await resolveUsesSnapshot(site, deps);
  const entry = getPagesConnectorCatalogEntry(actionId);
  const snapshotRevision = snapshotRevisionForAction(snapshot, actionId);

  if (!entry || entry.status !== "implemented") {
    await denyExec(deps, {
      actionId,
      host: input.host,
      outcome: "connector_capability_unsupported",
      requestId: input.requestId,
      site,
      workspace,
    });
    throw new ConsoleApiError(400, { error: "connector_capability_unsupported" });
  }

  if (!isActionAllowlisted(snapshot, actionId) || snapshotRevision == null) {
    await denyExec(deps, {
      actionId,
      host: input.host,
      outcome: "connector_not_allowlisted",
      requestId: input.requestId,
      site,
      workspace,
    });
    throw new ConsoleApiError(403, { error: "connector_not_allowlisted" });
  }

  if (entry.revision !== snapshotRevision) {
    await denyExec(deps, {
      actionId,
      host: input.host,
      outcome: "connector_capability_unsupported",
      requestId: input.requestId,
      site,
      workspace,
    });
    throw new ConsoleApiError(400, { error: "connector_capability_unsupported" });
  }

  if (!canExecEntry(entry, workspace)) {
    await denyExec(deps, {
      actionId,
      host: input.host,
      outcome: "connector_permission_required",
      requestId: input.requestId,
      site,
      workspace,
    });
    throw new ConsoleApiError(403, { error: "connector_permission_required" });
  }

  let basesSession: PagesSessionRecord | null = null;
  if (isBasesConnectorAction(entry.id)) {
    const admission = await admitBasesConnectorExec({
      deps,
      entry,
      host: input.host,
      origin: input.origin,
      pagesSession: input.pagesSession,
      site,
      workspace,
    });
    if (!admission.ok) {
      await denyExec(deps, {
        actionId,
        host: input.host,
        outcome: admission.error,
        requestId: input.requestId,
        site,
        workspace,
      });
      throw new ConsoleApiError(admission.status, { error: admission.error });
    }
    basesSession = admission.session;
  }

  let parsedInput: unknown;
  try {
    parsedInput = validateCatalogInput(entry, input.input ?? {});
  } catch (error) {
    await denyExec(deps, {
      actionId,
      host: input.host,
      outcome: "payload_invalid",
      requestId: input.requestId,
      site,
      workspace,
    });
    if (error instanceof ZodError || error instanceof ConsoleApiError) {
      throw new ConsoleApiError(400, { error: "payload_invalid" });
    }
    throw error;
  }

  try {
    const wantsDelegation = !deps.executorCallback && (deps.shouldDelegateOperation ?? shouldDelegatePageOperation)(entry.id);
    // Capture/system sessions keep their narrow existing read path; they never
    // acquire the human-viewer Executor delegation protocol.
    const humanSession = wantsDelegation
      ? basesSession ?? await findHumanViewerSession({ deps, pagesSession: input.pagesSession, site, workspace })
      : null;
    const dispatched = humanSession
      ? await (deps.delegateOperation ?? delegatePageOperation)({
          host: input.host, id: entry.id, input: parsedInput, origin: input.origin ?? null,
          pagesSession: input.pagesSession, requestId: input.requestId,
          actorId: workspace.user.id, organizationId: site.organizationId,
          siteId: site.id, projectId: site.projectId, releaseId: site.activeReleaseId,
        })
      : basesSession
      ? await dispatchBasesAction({
          deps,
          entry,
          input: parsedInput,
          requestId: input.requestId,
          session: basesSession,
          site,
          workspace,
        })
      : await dispatchPlatformAction({
          deps,
          entry,
          host: input.host,
          input: parsedInput,
          origin: input.origin,
          pagesSession: input.pagesSession,
          site,
          workspace,
        });
    const output = projectCatalogOutput(entry, dispatched.output);
    await auditConnector(deps, {
      action: "pages.connector.exec.allowed",
      actionId,
      actorId: workspace.user.id,
      auditMetadata: dispatched.auditMetadata,
      host: input.host,
      outcome: "ok",
      releaseId: site.activeReleaseId,
      requestId: input.requestId,
      revision: entry.revision,
      site,
    });
    return {
      ok: true,
      id: entry.id,
      revision: entry.revision,
      output,
    };
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      await denyExec(deps, {
        actionId,
        host: input.host,
        outcome: error.payload.error,
        requestId: input.requestId,
        site,
        workspace,
      });
      throw basesSession ? basesExecError(error) : error;
    }
    await denyExec(deps, {
      actionId,
      host: input.host,
      outcome: "connector_unavailable",
      requestId: input.requestId,
      site,
      workspace,
    });
    throw new ConsoleApiError(503, { error: "connector_unavailable" });
  }
}

async function execKnowledgeSearch(input: {
  actionId: string;
  deps: PagesConnectorHostDeps;
  host: string;
  input: unknown;
  pagesSession: string;
  requestId: string;
  site: PagesConnectorSite;
}): Promise<PagesConnectorExecResult> {
  const { actionId, deps, host, requestId, site } = input;
  const entry = getPagesConnectorCatalogEntry(KNOWLEDGE_SEARCH_ACTION_ID);
  if (!entry) throw new ConsoleApiError(400, { error: "connector_capability_unsupported" });

  const viewer = await resolvePageChatViewer({ deps, host, pagesSession: input.pagesSession, requestId, site });
  if (!viewer) {
    await auditConnector(deps, {
      action: "pages.connector.exec.denied",
      actorId: null,
      host,
      outcome: "connector_unauthorized",
      requestId,
      site,
      actionId,
    });
    throw new ConsoleApiError(401, { error: "connector_unauthorized" });
  }
  const deny = async (outcome: string) =>
    auditConnector(deps, { action: "pages.connector.exec.denied", actionId, actorId: viewer.userId, host, outcome, requestId, site });

  let chatEnabled = false;
  try {
    chatEnabled = await (deps.pageChatEnabled ?? pageChatEnabledForSite)(site);
  } catch {
    chatEnabled = false;
  }
  if (!chatEnabled) {
    await deny("page_chat_disabled_for_site");
    throw new ConsoleApiError(403, { error: "page_chat_disabled_for_site" });
  }

  const limited = deps.isRateLimited ?? isRateLimited;
  if (
    limited({
      key: `pages-knowledge:${site.id}:${viewer.userId}`,
      limit: PAGES_KNOWLEDGE_SEARCH_LIMIT.perViewer,
      windowMs: PAGES_KNOWLEDGE_SEARCH_LIMIT.windowMs,
    })
  ) {
    throw new ConsoleApiError(429, { error: "connector_rate_limited" });
  }

  let parsed: { query: string; limit: number };
  try {
    parsed = validateCatalogInput(entry, input.input ?? {}) as { query: string; limit: number };
  } catch (error) {
    await deny("payload_invalid");
    if (error instanceof ZodError || error instanceof ConsoleApiError) {
      throw new ConsoleApiError(400, { error: "payload_invalid" });
    }
    throw error;
  }

  try {
    const result = await (deps.searchMarkedPages ?? searchMarkedPagesForViewer)({
      site,
      viewer,
      query: parsed.query,
      limit: parsed.limit,
      requestId,
    });
    const output = projectCatalogOutput(entry, result);
    await auditConnector(deps, {
      action: "pages.connector.exec.allowed",
      actionId,
      actorId: viewer.userId,
      auditMetadata: { audience: viewer.kind === "guest" ? "guest" : "member" },
      host,
      outcome: "ok",
      releaseId: site.activeReleaseId,
      requestId,
      revision: entry.revision,
      site,
    });
    return { ok: true, id: entry.id, revision: entry.revision, output };
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      await deny(error.payload.error);
      throw error;
    }
    await deny("connector_unavailable");
    throw new ConsoleApiError(503, { error: "connector_unavailable" });
  }
}

/**
 * The Page Chat viewer behind a Pages session: the member workspace when the
 * member check passes, else a guest (a `human_viewer` session of this site;
 * route grants are checked per route by the caller). Null when neither.
 */
async function resolvePageChatViewer(input: {
  deps: PagesConnectorHostDeps;
  host: string;
  pagesSession: string;
  requestId: string;
  site: PagesConnectorSite;
}): Promise<PageChatViewer | null> {
  const workspace = await resolveViewerWorkspace(input);
  if (workspace) return { kind: "member", userId: workspace.user.id, workspace };
  const guest = await (input.deps.resolveGuestViewer ?? resolvePagesGuestViewer)({
    host: input.host,
    repository: input.deps.authRepository ?? pagesPrivateAuthRepositoryForDb(),
    requestId: input.requestId,
    sessionToken: input.pagesSession,
    site: input.site,
  });
  return guest ? { kind: "guest", userId: guest.userId } : null;
}

async function pageChatEnabledForSite(site: PagesConnectorSite): Promise<boolean> {
  const [access, [row]] = await Promise.all([
    getConsoleFeatureAccessForOrganizationRole({ organizationId: site.organizationId, role: "owner" }),
    db
      .select({ metadataJson: schema.pageSites.metadataJson })
      .from(schema.pageSites)
      .where(eq(schema.pageSites.id, site.id))
      .limit(1),
  ]);
  return Boolean(access.byKey["console.pages.chat"]?.available) && parsePageChatSiteSettings(row?.metadataJson).enabled;
}

async function dispatchPlatformAction(input: {
  deps: PagesConnectorHostDeps;
  entry: PagesConnectorCatalogEntry;
  host: string;
  input: unknown;
  origin?: string | null;
  pagesSession: string;
  site: PagesConnectorSite;
  workspace: ProjectAccessWorkspace;
}): Promise<{ auditMetadata?: Record<string, unknown>; output: unknown }> {
  if (input.entry.auth !== "platform") {
    throw new ConsoleApiError(400, { error: "connector_capability_unsupported" });
  }

  if (input.entry.id === IDENTITY_ASSERTION_ACTION_ID) {
    const repository = input.deps.authRepository ?? pagesPrivateAuthRepositoryForDb();
    const session = await findPagesSessionByToken({
      repository,
      sessionToken: input.pagesSession,
    });
    if (!session || session.userId !== input.workspace.user.id) {
      throw new ConsoleApiError(403, { error: "viewer_assertion_actor_forbidden" });
    }
    const findAudience = input.deps.findViewerAssertionAudience ?? findActiveViewerAssertionAudience;
    const minted = await mintHumanViewerAssertion({
      audience: (input.input as { aud: string }).aud,
      findAudience: async (audience) => findAudience({ audience, siteId: input.site.id }),
      origin: input.origin ?? null,
      requestHost: input.host,
      session,
      site: {
        id: input.site.id,
        organizationId: input.site.organizationId,
        projectId: input.site.projectId,
      },
    });
    return minted;
  }

  if (input.entry.id === PAGES_THEME_GET_ACTION_ID) {
    // The session already proved project read for this site; the theme is the site project's, never another's.
    const resolveTheme = input.deps.resolvePagesTheme ?? pagesThemeForProject;
    return { output: await resolveTheme({ organizationId: input.site.organizationId, projectId: input.site.projectId }) };
  }

  const viewerWorkspace = {
    mode: "workos" as const,
    user: input.workspace.user,
    organization: input.workspace.organization,
    membership: {
      role: input.workspace.membership.role as ConsoleWorkspace["membership"]["role"],
    },
  };
  const parsed = input.input as { limit: number; projectRef?: string };

  if (input.entry.id === PROJECTS_LIST_ACTION_ID) {
    const listViewerProjects = input.deps.listProjects ?? listProjects;
    const projects = await listViewerProjects(input.workspace);
    return {
      output: {
        items: projects.slice(0, parsed.limit).map(projectProjectSummary),
      },
    };
  }

  const projectRef = await resolveViewerProjectRef({
    deps: input.deps,
    projectRef: parsed.projectRef,
    site: input.site,
    workspace: input.workspace,
  });

  if (input.entry.id === PAGES_SITES_LIST_ACTION_ID) {
    const listSites = input.deps.listPageSitesForProject ?? listPageSitesForProject;
    const sites = await listSites({
      projectRef,
      workspace: viewerWorkspace,
    });
    return {
      output: {
        items: sites
          .filter((site) => site.status !== "deleted")
          .slice(0, parsed.limit)
          .map(projectPageSite),
      },
    };
  }

  if (input.entry.id === PAGES_PUBLISHED_LIST_ACTION_ID) {
    const listPublished = input.deps.listPublishedPages ?? listPublishedPages;
    const pages = await listPublished(input.workspace, projectRef);
    return {
      output: {
        items: pages.slice(0, parsed.limit).map((page) => ({
          id: page.id,
          path: page.path,
          title: page.title,
          urls: page.urls,
          visibility: page.visibility,
          siteSlug: page.siteSlug,
          defaultHostname: page.defaultHostname,
          updatedAt: page.updatedAt,
        })),
      },
    };
  }

  throw new ConsoleApiError(400, { error: "connector_capability_unsupported" });
}

/**
 * `ravi.bases.*` admission beyond the common exec checks: a `human_viewer`
 * claim-code session for this site, the `console.bases` feature, and for
 * writes an exact Origin match. View grants are decided by the Bases service.
 */
async function admitBasesConnectorExec(input: {
  deps: PagesConnectorHostDeps;
  entry: PagesConnectorCatalogEntry;
  host: string;
  origin?: string | null;
  pagesSession: string;
  site: PagesConnectorSite;
  workspace: ProjectAccessWorkspace;
}): Promise<{ ok: true; session: PagesSessionRecord } | { ok: false; status: number; error: string }> {
  const session = await findHumanViewerSession(input);
  if (!session) {
    return { ok: false, status: 403, error: "connector_permission_required" };
  }
  if (input.entry.class !== "read") {
    const origin = input.origin?.trim() ?? "";
    if (!origin || !originMatchesRequestHost(origin, input.host)) {
      return { ok: false, status: 401, error: "connector_unauthorized" };
    }
  }
  const featureEnabled = await (input.deps.basesFeatureEnabled ?? basesFeatureEnabledFor)({
    organizationId: input.site.organizationId,
    role: input.workspace.membership.role,
  });
  if (!featureEnabled) {
    return { ok: false, status: 403, error: "connector_permission_required" };
  }
  return { ok: true, session };
}

async function findHumanViewerSession(input: {
  deps: PagesConnectorHostDeps;
  pagesSession: string;
  site: PagesConnectorSite;
  workspace: ProjectAccessWorkspace;
}): Promise<PagesSessionRecord | null> {
  const repository = input.deps.authRepository ?? pagesPrivateAuthRepositoryForDb();
  const session = await findPagesSessionByToken({ repository, sessionToken: input.pagesSession });
  if (
    !session ||
    session.userId !== input.workspace.user.id ||
    session.organizationId !== input.site.organizationId ||
    session.siteId !== input.site.id ||
    pagesSessionActorKind(session) !== "human_viewer"
  ) {
    return null;
  }
  return session;
}

async function dispatchBasesAction(input: {
  deps: PagesConnectorHostDeps;
  entry: PagesConnectorCatalogEntry;
  input: unknown;
  requestId: string;
  session: PagesSessionRecord;
  site: PagesConnectorSite;
  workspace: ProjectAccessWorkspace;
}): Promise<{ auditMetadata?: Record<string, unknown>; output: unknown }> {
  const email = await (input.deps.findUserEmail ?? findUserPrimaryEmail)(input.workspace.user.id);
  const caller = basesCallerForPagesViewer({
    organizationId: input.site.organizationId,
    userId: input.workspace.user.id,
    email,
    pagesSessionId: input.session.id,
    siteId: input.site.id,
    orgRole: input.workspace.membership.role,
    requestId: input.requestId,
  });
  return dispatchBasesConnectorAction({
    caller,
    entry: input.entry,
    input: input.input,
    projectId: input.site.projectId,
    services: input.deps.bases,
  });
}

/**
 * Runs one validated `ravi.bases.*` catalog action as `caller` in `projectId`.
 * Shared by Pages exec and the operation registry (Page chat agent, Console MCP).
 */
export async function dispatchBasesConnectorAction(input: {
  caller: BasesCaller;
  entry: PagesConnectorCatalogEntry;
  input: unknown;
  projectId: string;
  services?: Partial<PagesConnectorBasesServices>;
}): Promise<{ auditMetadata?: Record<string, unknown>; output: unknown }> {
  const services = { ...DEFAULT_BASES_SERVICES, ...input.services };
  const { caller, projectId } = input;

  switch (input.entry.id) {
    case BASES_VIEWS_DESCRIBE_ACTION_ID: {
      const parsed = input.input as { viewId: string };
      return { output: await services.describeView(caller, { projectId, viewId: parsed.viewId }) };
    }
    case BASES_VIEWS_QUERY_ACTION_ID: {
      const parsed = input.input as BasesViewsQueryInput;
      return {
        output: await services.queryView(caller, {
          projectId,
          viewId: parsed.viewId,
          ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
          ...(parsed.sort !== undefined ? { sort: parsed.sort } : {}),
          ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
          ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
          ...(parsed.search !== undefined ? { search: parsed.search } : {}),
        }),
      };
    }
    case BASES_VIEWS_VERSION_ACTION_ID: {
      const parsed = input.input as { viewId: string };
      return { output: await services.viewVersion(caller, { projectId, viewId: parsed.viewId }) };
    }
    case BASES_VIEWS_ROWS_GET_ACTION_ID: {
      const parsed = input.input as BasesViewsRowsGetInput;
      const result = await services.getRow(caller, { projectId, viewId: parsed.viewId, rowId: parsed.rowId });
      return { output: { ...result.row, users: result.users } };
    }
    case BASES_VIEWS_ROWS_CREATE_ACTION_ID: {
      const parsed = input.input as BasesViewsRowsCreateInput;
      const result = await services.createRow(caller, {
        projectId,
        viewId: parsed.viewId,
        values: parsed.values,
        ...(parsed.body !== undefined ? { body: parsed.body } : {}),
        idempotencyKey: parsed.idempotencyKey,
      });
      return { output: { rowId: result.row.rowId, version: result.row.version } };
    }
    case BASES_VIEWS_ROWS_UPDATE_ACTION_ID: {
      const parsed = input.input as BasesViewsRowsUpdateInput;
      const result = await services.updateRow(caller, {
        projectId,
        viewId: parsed.viewId,
        rowId: parsed.rowId,
        values: parsed.values,
        ...(parsed.body !== undefined ? { body: parsed.body } : {}),
        expectedVersion: parsed.expectedVersion,
        idempotencyKey: parsed.idempotencyKey,
      });
      return { output: result.row };
    }
    case BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID: {
      const parsed = input.input as BasesViewsRowsArchiveInput;
      const result = await services.archiveRow(caller, {
        projectId,
        viewId: parsed.viewId,
        rowId: parsed.rowId,
        expectedVersion: parsed.expectedVersion,
      });
      return { output: { rowId: result.row.rowId, version: result.row.version } };
    }
    case BASES_CHARTS_DATA_ACTION_ID: {
      const parsed = input.input as { chartId: string };
      const data = await services.chartData(caller, { projectId, chartId: parsed.chartId });
      return {
        output: {
          chart: data.chart,
          groups: data.data,
          fields: data.fields,
          suppressedGroups: data.suppressedGroups,
          users: data.users,
        },
      };
    }
    default:
      throw new ConsoleApiError(400, { error: "connector_capability_unsupported" });
  }
}

function basesExecError(error: ConsoleApiError): ConsoleApiError {
  const details = projectBasesErrorDetails(error.payload as { error: string; fieldErrors?: unknown; current?: unknown });
  return Object.keys(details).length ? new PagesConnectorBasesExecError(error.status, error.payload.error, details) : error;
}

async function basesFeatureEnabledFor(input: { organizationId: string; role: string }) {
  const access = await getConsoleFeatureAccessForOrganizationRole(input);
  const feature = access.byKey["console.bases"];
  return Boolean(feature?.available && feature.authorized);
}

async function findUserPrimaryEmail(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ primaryEmail: schema.users.primaryEmail })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row?.primaryEmail ?? null;
}

async function resolveViewerProjectRef(input: {
  deps: PagesConnectorHostDeps;
  projectRef?: string;
  site: PagesConnectorSite;
  workspace: ProjectAccessWorkspace;
}) {
  const requested = input.projectRef?.trim();
  if (!requested) return input.site.projectId;

  const findProject = input.deps.findAccessibleProjectRecord ?? findAccessibleProjectRecord;
  const project = await findProject(input.workspace, requested, "read");
  if (!project) {
    throw new ConsoleApiError(403, { error: "connector_permission_required" });
  }
  return project.id;
}

export function projectProjectSummary(project: {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}) {
  const description = project.description?.trim();
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    ...(description ? { description } : {}),
  };
}

export function projectPageSite(site: PageSite) {
  return {
    id: site.id,
    slug: site.slug,
    defaultHostname: site.defaultHostname,
    defaultVisibility: PAGE_VISIBILITIES.has(site.defaultVisibility)
      ? site.defaultVisibility
      : "private",
    isDefault: site.isDefault,
    status: site.status === "disabled" ? "disabled" : "active",
    activeReleaseId: site.activeReleaseId,
    updatedAt: site.updatedAt instanceof Date ? site.updatedAt.getTime() : Number(site.updatedAt),
  };
}

function projectCatalogAction(
  entry: PagesConnectorCatalogEntry,
  input: {
    allowlisted: boolean;
    humanViewer: boolean;
    missingSession: boolean;
    workspace: ProjectAccessWorkspace | null;
  },
): PagesConnectorCatalogProjection {
  const executable =
    Boolean(input.workspace) &&
    input.allowlisted &&
    entry.status === "implemented" &&
    canExecEntry(entry, input.workspace) &&
    (!isBasesConnectorAction(entry.id) || input.humanViewer);
  return {
    ...publicCatalogEntry(entry),
    allowlisted: input.allowlisted,
    executable,
    missingSession: input.missingSession,
  };
}

function canExecEntry(entry: PagesConnectorCatalogEntry, workspace: ProjectAccessWorkspace | null) {
  if (!workspace) return false;
  // Bases writes need only project read here; the view's access decides who may write.
  if (entry.requiredRoles.length === 0) return entry.class === "read" || isBasesConnectorAction(entry.id);
  return entry.requiredRoles.includes(workspace.membership.role);
}

async function resolveConnectorSite(host: string, deps: PagesConnectorHostDeps): Promise<PagesConnectorSite> {
  const findSite = deps.findSiteByHost ?? findConnectorSiteByHost;
  const site = await findSite(host);
  if (!site || site.status !== "active") {
    throw new ConsoleApiError(404, { error: "connector_unavailable" });
  }
  return site;
}

async function resolveViewerWorkspace(input: {
  deps: PagesConnectorHostDeps;
  host: string;
  pagesSession?: string | null;
  requestId: string;
  site: PagesConnectorSite;
}): Promise<ProjectAccessWorkspace | null> {
  if (!input.pagesSession) return null;
  const authRepository = input.deps.authRepository ?? pagesPrivateAuthRepositoryForDb();
  return verifyPagesSessionForSite({
    host: input.host,
    repository: authRepository,
    requestId: input.requestId,
    sessionToken: input.pagesSession,
    site: input.site,
    ...(input.deps.canReadProject ? { canReadProject: input.deps.canReadProject } : {}),
  });
}

function execRateLimited(site: PagesConnectorSite, workspace: ProjectAccessWorkspace, deps: PagesConnectorHostDeps) {
  const limited = deps.isRateLimited ?? isRateLimited;
  const { windowMs } = PAGES_CONNECTOR_EXEC_LIMITS;
  return (
    limited({
      key: `pages-connectors-exec:viewer:${site.id}:${workspace.user.id}`,
      limit: PAGES_CONNECTOR_EXEC_LIMITS.viewer,
      windowMs,
    }) ||
    limited({ key: `pages-connectors-exec:site:${site.id}`, limit: PAGES_CONNECTOR_EXEC_LIMITS.site, windowMs }) ||
    limited({
      key: `pages-connectors-exec:org:${site.organizationId}`,
      limit: PAGES_CONNECTOR_EXEC_LIMITS.organization,
      windowMs,
    })
  );
}

async function resolveUsesSnapshot(
  site: PagesConnectorSite,
  deps: PagesConnectorHostDeps,
): Promise<PagesConnectorUsesSnapshot> {
  const load = deps.loadUsesSnapshot ?? loadUsesSnapshotFromDb;
  const stored = await load({ releaseId: site.activeReleaseId, siteId: site.id });
  return withAlwaysAllowlistedUses(stored ?? curatedPlatformUsesSnapshot());
}

async function findConnectorSiteByHost(host: string): Promise<PagesConnectorSite | null> {
  const authSite = await pagesPrivateAuthRepositoryForDb().findSiteByHost(host);
  if (!authSite) return null;
  const [row] = await db
    .select({
      activeReleaseId: schema.pageSites.activeReleaseId,
    })
    .from(schema.pageSites)
    .where(eq(schema.pageSites.id, authSite.id))
    .limit(1);

  return {
    id: authSite.id,
    organizationId: authSite.organizationId,
    projectId: authSite.projectId,
    defaultHostname: authSite.defaultHostname,
    defaultVisibility: authSite.defaultVisibility,
    status: authSite.status,
    activeReleaseId: row?.activeReleaseId ?? null,
  };
}

/**
 * The host allowlist is the union of the `uses` of every route in the site's
 * active release. Each route's `uses` is the snapshot stored on the artifact
 * version it serves, which the ship that created that version wrote (from
 * `packageManifest.uses` or `publish.uses`). So publishing or re-shipping
 * route B never drops what route A still needs, and a route only stops
 * contributing when a release no longer serves its version. `null` (curated
 * fallback) when no active route has a snapshot in hosted mode. The
 * single-installation path rejects incompatible routes instead of unioning.
 */
export async function loadUsesSnapshotFromDb(input: {
  releaseId: string | null;
  siteId: string;
}): Promise<PagesConnectorUsesSnapshot | null> {
  if (!input.releaseId) {
    if (isolatedPagesOriginsRequired()) throw new ConsoleApiError(403, { error: "connector_not_allowlisted" });
    return null;
  }
  const versions = await db
    .select({ metadataJson: schema.artifactVersions.metadataJson })
    .from(schema.pageReleaseRoutes)
    .leftJoin(schema.artifactVersions, eq(schema.artifactVersions.id, schema.pageReleaseRoutes.artifactVersionId))
    .where(
      and(
        eq(schema.pageReleaseRoutes.siteId, input.siteId),
        eq(schema.pageReleaseRoutes.releaseId, input.releaseId),
      ),
    );
  return connectorUsesForOrigin(versions.map((version) => version.metadataJson));
}

async function denyExec(
  deps: PagesConnectorHostDeps,
  input: {
    actionId: string;
    host: string;
    outcome: string;
    requestId: string;
    site: PagesConnectorSite;
    workspace: ProjectAccessWorkspace | null;
  },
) {
  await auditConnector(deps, {
    action: "pages.connector.exec.denied",
    actionId: input.actionId,
    actorId: input.workspace?.user.id ?? null,
    host: input.host,
    outcome: input.outcome,
    requestId: input.requestId,
    site: input.site,
  });
}

async function auditConnector(
  deps: PagesConnectorHostDeps,
  input: {
    action: string;
    actionId?: string;
    actorId: string | null;
    host: string;
    outcome: string;
    auditMetadata?: Record<string, unknown>;
    releaseId?: string | null;
    requestId: string;
    revision?: number;
    site: PagesConnectorSite;
  },
) {
  const insertAudit =
    deps.insertAudit ??
    (deps.authRepository ?? pagesPrivateAuthRepositoryForDb()).insertAudit.bind(
      deps.authRepository ?? pagesPrivateAuthRepositoryForDb(),
    );

  await insertAudit({
    action: input.action,
    actorId: input.actorId,
    actorType: input.actorId ? "user" : "system",
    metadataJson: {
      host: input.host,
      outcome: input.outcome,
      actionId: input.actionId ?? null,
      revision: input.revision ?? null,
      releaseId: input.releaseId ?? input.site.activeReleaseId,
      requestId: input.requestId,
      ...safeAuditMetadata(input.auditMetadata),
    },
    organizationId: input.site.organizationId,
    projectId: input.site.projectId,
    requestId: input.requestId,
    targetId: input.site.id,
    targetType: "page_site",
  });
}

function safeAuditMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) return {};
  const allowed = ["actor", "audience", "expiresAt", "jti", "kid"] as const;
  const next: Record<string, string | number> = {};
  for (const key of allowed) {
    const value = metadata[key];
    if (typeof value === "string" || typeof value === "number") next[key] = value;
  }
  // Fixed server-side attribution only; never persist arbitrary bridge payloads.
  if (metadata.via === "executor" && metadata.delegation === "site-scoped") {
    next.via = "executor";
    next.delegation = "site-scoped";
  }
  return next;
}

function matchesQuery(entry: PagesConnectorCatalogEntry, query: string) {
  return (
    entry.id.toLowerCase().includes(query) ||
    entry.title.toLowerCase().includes(query) ||
    entry.description.toLowerCase().includes(query)
  );
}

function parseCsv(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isConnectorClass(value: string | null | undefined): value is PagesConnectorClass {
  return value === "read" || value === "write" || value === "destructive";
}
