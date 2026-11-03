import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";

import { getConsoleApiAuthState, getConsoleAuthState } from "@/lib/auth/session";
import {
  getArtifact,
  getCurrentOrganization,
  getMailOverview,
  getProject,
  getRuntimeRunDetail,
  getSettingsData,
  listArtifactVersions,
  listArtifacts,
  listAuditEvents,
  listRuntimeRuns,
  getPageSiteDetail,
  listOrganizations,
  listPageSites,
  listPublishedPages,
  listProjects,
  organizationMembershipToOrg,
} from "@/server/console/read-model";
import { ConsoleApiError } from "@/server/console/api-error";
import {
  checkConsoleDomainBinding,
  createConsoleDomainBinding,
  createConsoleDomainClaim,
  listConsoleDomainClaims,
  verifyConsoleDomainClaim,
} from "@/server/console/domains";
import { createConsoleMailDomain, createConsoleMailbox } from "@/server/console/mail/console-management";
import {
  removeConsoleOrganizationMember,
  upsertConsoleOrganizationMember,
} from "@/server/console/members";
import { accessActorFromWorkspace } from "@/server/console/access/common";
import { decideAccessRequest, listSiteAccessRequests } from "@/server/console/access/requests";
import { listPagesSiteAccess, sharePagesAccess, unsharePagesAccess } from "@/server/console/access/grants";
import {
  createOrganizationInvite,
  listOrganizationInvites,
  revokeOrganizationInvite,
} from "@/server/console/access/invites";
import { raviLinkConsoleOrigin } from "@/server/console/ravi-link-requests";
import { isTrustedConsolePost } from "@/server/console/ravi-link-web";
import { createProject } from "@/server/console/projects";
import { createPageSite } from "@/server/console/pages";
import {
  createViewerAssertionAudience,
  deleteViewerAssertionAudience,
  listViewerAssertionAudiences,
} from "@/server/console/pages/viewer-assertions/registry";
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  getKnowledgeSource,
  listKnowledgeSources,
} from "@/server/console/knowledge";
import { ingestKnowledgeSource } from "@/server/console/knowledge/ingestion";
import { retrieveKnowledge } from "@/server/console/knowledge/retrieval";
import {
  assertConsoleFeatureAccess,
  assertConsoleFeatureAvailable,
  getConsoleFeatureAccess,
} from "@/server/console/feature-access";
import { listConsoleFeedback, submitConsoleFeedback } from "@/server/console/feedback";
import {
  applyBugReportTriage,
  deleteBugReport,
  getAdminBugReport,
  getBugReportForReporter,
  listAdminBugReports,
  listBugReportsForReporter,
  storeBugReportTriage,
  updateBugReportStatus,
} from "@/server/console/bug-reports";
import { consoleFeatureForSegments } from "@/server/console/console-api-features";
import { requirePlatformOperatorApi } from "@/server/console/manage-page";
import { isConsoleManageBugsPath } from "@/server/console/platform-operator";
import {
  GITHUB_USER_SESSION_COOKIE,
  getOrganizationGithubConfig,
  getProjectGithubAppConfig,
  linkGithubInstallation,
  startGithubAppInstall,
  startGithubUserAuthorization,
  unlinkGithubInstallation,
} from "@/server/console/github-app";
import { updateSettings } from "@/server/console/settings";
import {
  createManagedInstance,
  enqueueManagedInstanceOperation,
  getManagedInstance,
  listManagedInstances,
} from "@/server/console/managed-instances";
import {
  enqueueManagedRaviCommand,
  getManagedRaviSession,
  listManagedRaviSessionEvents,
} from "@/server/console/managed-runtime-commands";
import {
  getRaviControlChat,
  interruptRaviControlTurn,
  sendRaviControlMessage,
  syncRaviControlChat,
} from "@/server/console/ravi-control-chat";
import { listRaviControlInstallations } from "@/server/console/ravi-control-workspace";
import {
  activatePageSiteRelease,
  consolePublishContextFromWorkspace,
  createPageSiteRelease,
  createPageUploadSession,
  finalizePageUploadSession,
  getPagePublish,
} from "@/server/console/pages/publish";
import {
  ConsoleWorkspaceSelectionRequiredError,
  getConsoleWorkspace,
} from "@/server/console/workspace";
import { requestOrganizationRef } from "@/server/console/request-workspace";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  const { segments = [] } = await context.params;
  const [resource, id, child, fourth] = segments;

  try {
    const auth = await getConsoleAuthState();
    if (isConsoleManageBugsPath(segments)) {
      await requirePlatformOperatorApi(auth);
      const payload = await routeManageBugsGet(request, segments);
      if (payload === null) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json(serializePagePayload(payload));
    }

    const workspace = await getConsoleWorkspace(auth, {
      organizationRef: requestOrganizationRef(request),
    });
    if (resource === "github" && (id === "connect" || id === "install") && !child) {
      await assertConsoleFeatureAccess(workspace, "console.github");
      return NextResponse.redirect(id === "connect" ? startGithubUserAuthorization(workspace) : startGithubAppInstall(workspace));
    }

    const payload = await routeRequest(request, segments, workspace);
    if (payload === null) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(serializePagePayload(payload));
  } catch (error) {
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      if (segments[0] === "organizations") {
        return NextResponse.json(error.organizations.map(organizationMembershipToOrg));
      }
      return NextResponse.json({ error: error.code }, { status: 409 });
    }
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    const eventId = await captureConsoleApiException(error, {
      tags: {
        feature: "console-api",
        operation: "read",
        surface: "console",
      },
      contexts: {
        consoleApi: {
          method: request.method,
          path: request.nextUrl.pathname,
          query: request.nextUrl.search,
          segments,
        },
      },
    });
    console.error("Console read failed", { error, segments });
    return NextResponse.json({ error: "internal_error", eventId }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { segments = [] } = await context.params;
  const [resource, id, child, fourth, fifth, sixth, seventh, eighth] = segments;

  const auth = await getConsoleApiAuthState();
  if (!auth) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  let body: unknown;

  try {
    const rawBody = await request.text();
    body = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    if (isConsoleManageBugsPath(segments)) {
      await requirePlatformOperatorApi(auth);
      const payload = await routeManageBugsPost(segments, body, requestId);
      if (payload === null) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json(serializePagePayload(payload), { status: 200 });
    }

    const workspace = await getConsoleWorkspace(auth, {
      organizationRef: requestOrganizationRef(request),
    });
    const requiredFeature = consoleFeatureForSegments(segments);
    const organizationSettings = resource === "settings" && !id && body !== null && typeof body === "object"
      && !Array.isArray(body) && (body as Record<string, unknown>).scope === "org";
    const projectCreation = resource === "projects" && !id;
    if (resource === "settings" && (id === "members" || id === "invites"))
      throw new ConsoleApiError(403, { error: "legacy_membership_unsupported" });
    if (requiredFeature && !organizationSettings) {
      if (projectCreation) await assertConsoleFeatureAvailable(workspace, requiredFeature);
      else await assertConsoleFeatureAccess(workspace, requiredFeature);
    }
    if (resource === "projects" && !id && shouldCreateDefaultPageSite(body)) {
      await assertConsoleFeatureAvailable(workspace, "console.pages");
    }

    if (resource === "projects" && !id) {
      const payload = await createProject({ body, requestId, workspace });
      return NextResponse.json(payload, { status: 201 });
    }

    if (resource === "settings" && !id) {
      const payload = await updateSettings({ body, requestId, workspace });
      return NextResponse.json(serializePagePayload(payload), { status: 200 });
    }

    if (resource === "feedback" && !id) {
      const payload = await submitConsoleFeedback({
        body,
        defaultSource: "console",
        requestId,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "settings" && id === "members" && child === "upsert" && !fourth) {
      const payload = await upsertConsoleOrganizationMember({ body, requestId, workspace });
      return NextResponse.json(serializePagePayload(payload), { status: 200 });
    }

    if (resource === "settings" && id === "members" && child === "remove" && !fourth) {
      const payload = await removeConsoleOrganizationMember({ body, requestId, workspace });
      return NextResponse.json(serializePagePayload(payload), { status: 200 });
    }

    if (resource === "settings" && id === "invites" && child === "create" && !fourth) {
      const payload = await createOrganizationInvite({
        actor: accessActorFromWorkspace(workspace),
        body,
        origin: raviLinkConsoleOrigin(request.url),
        requestId,
      });
      return NextResponse.json(payload, { status: 201 });
    }

    if (resource === "settings" && id === "invites" && child === "revoke" && !fourth) {
      const payload = await revokeOrganizationInvite({ actor: accessActorFromWorkspace(workspace), body, requestId });
      return NextResponse.json(payload, { status: 200 });
    }

    if (resource === "pages" && id === "access" && child === "share" && !fourth) {
      const payload = await sharePagesAccess({ actor: accessActorFromWorkspace(workspace), body, requestId });
      return NextResponse.json(payload, { status: payload.created ? 201 : 200 });
    }

    if (resource === "pages" && id === "access" && child === "requests" && fourth === "decide" && !segments[4]) {
      // Same guards as the forwardable link's form: a decision creates a grant.
      if (!isTrustedConsolePost(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
      if (auth.initialAuth?.impersonator) return NextResponse.json({ error: "impersonated" }, { status: 403 });
      const decision = decideBody(body);
      const payload = await decideAccessRequest({
        ...decision,
        origin: raviLinkConsoleOrigin(request.url),
        requestId,
        viewerUserId: workspace.user.id,
      });
      return NextResponse.json(payload, { status: 200 });
    }

    if (resource === "pages" && id === "access" && child === "unshare" && !fourth) {
      const payload = await unsharePagesAccess({ actor: accessActorFromWorkspace(workspace), body, requestId });
      return NextResponse.json(payload, { status: 200 });
    }

    if (resource === "projects" && id && child === "pages" && fourth && segments[4] === "viewer-assertion-audiences" && !segments[5]) {
      const payload = await createViewerAssertionAudience({
        body,
        projectRef: id,
        requestId,
        siteRef: fourth,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "projects" && id && child === "pages" && !fourth) {
      const payload = await createPageSite({
        input: body as Parameters<typeof createPageSite>[0]["input"],
        projectRef: id,
        requestId,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "projects" && id && child === "knowledge" && fourth === "sources" && !fifth) {
      const payload = await createKnowledgeSource({
        body,
        projectRef: id,
        requestId,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "projects" && id && child === "knowledge" && fourth === "sources" && fifth && sixth === "ingestions") {
      const payload = await ingestKnowledgeSource({
        body,
        projectRef: id,
        requestId,
        sourceId: fifth,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "projects" && id && child === "knowledge" && fourth === "retrieval-runs" && !fifth) {
      const payload = await retrieveKnowledge({
        body,
        projectRef: id,
        requestId,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "projects" && id && child === "managed-runtime" && fourth === "instances" && !fifth) {
      const payload = await createManagedInstance({
        body: withIdempotencyHeader(body, request),
        projectRef: id,
        requestId,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 202 });
    }

    if (
      resource === "projects"
      && id
      && child === "managed-runtime"
      && fourth === "instances"
      && fifth
      && sixth === "operations"
    ) {
      const payload = await enqueueManagedInstanceOperation({
        body: withIdempotencyHeader(body, request),
        instanceId: fifth,
        projectRef: id,
        requestId,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 202 });
    }

    if (
      resource === "projects"
      && id
      && child === "ravi-control"
      && fourth === "instances"
      && fifth
      && sixth === "chat"
      && seventh === "messages"
      && !eighth
    ) {
      const payload = await sendRaviControlMessage({
        body: withIdempotencyHeader(body, request),
        instanceId: fifth,
        projectRef: id,
        requestId,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 202 });
    }

    if (
      resource === "projects"
      && id
      && child === "ravi-control"
      && fourth === "instances"
      && fifth
      && sixth === "chat"
      && seventh === "sync"
      && !eighth
    ) {
      const payload = await syncRaviControlChat({
        body: withIdempotencyHeader(body, request),
        instanceId: fifth,
        projectRef: id,
        requestId,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 202 });
    }

    if (
      resource === "projects"
      && id
      && child === "ravi-control"
      && fourth === "instances"
      && fifth
      && sixth === "chat"
      && seventh === "interrupt"
      && !eighth
    ) {
      const payload = await interruptRaviControlTurn({
        body: withIdempotencyHeader(body, request),
        instanceId: fifth,
        projectRef: id,
        requestId,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 202 });
    }

    if (
      resource === "projects"
      && id
      && child === "managed-runtime"
      && fourth === "instances"
      && fifth
      && sixth === "sessions"
      && seventh
      && eighth === "commands"
    ) {
      const payload = await enqueueManagedRaviCommand({
        body: withIdempotencyHeader(body, request),
        instanceId: fifth,
        projectRef: id,
        requestId,
        sessionId: seventh === "current" ? undefined : seventh,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 202 });
    }

    if (resource === "projects" && id && child === "mail" && fourth === "mailboxes" && !fifth) {
      const payload = await createConsoleMailbox({
        body,
        projectRef: id,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "github" && id === "installations" && !child) {
      const payload = await linkGithubInstallation({
        body,
        requestId,
        userSession: request.cookies.get(GITHUB_USER_SESSION_COOKIE)?.value,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 200 });
    }

    if (resource === "mail" && id === "domains" && !child) {
      const payload = await createConsoleMailDomain({ body, workspace });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "mail" && id === "mailboxes" && !child) {
      const payload = await createConsoleMailbox({ body, workspace });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "domains" && id === "claims" && !child) {
      const payload = await createConsoleDomainClaim({ body, requestId, workspace });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "domains" && id === "claims" && child && fourth === "verify" && !fifth) {
      const payload = await verifyConsoleDomainClaim({
        claimId: child,
        requestId,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 200 });
    }

    if (resource === "domains" && id === "claims" && child && fourth === "bindings" && !fifth) {
      const payload = await createConsoleDomainBinding({
        body,
        claimId: child,
        requestId,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "domains" && id === "bindings" && child && fourth === "check" && !fifth) {
      const payload = await checkConsoleDomainBinding({
        bindingId: child,
        requestId,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 200 });
    }

    if (resource === "pages" && id === "upload-sessions" && !child) {
      const payload = await createPageUploadSession({
        context: consolePublishContextFromWorkspace(workspace),
        input: body as Parameters<typeof createPageUploadSession>[0]["input"],
        requestId,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "pages" && id === "upload-sessions" && child && fourth === "finalize") {
      const payload = await finalizePageUploadSession({
        context: consolePublishContextFromWorkspace(workspace),
        input: {
          ...(body as Record<string, unknown>),
          uploadSessionId: child,
        } as Parameters<typeof finalizePageUploadSession>[0]["input"],
        requestId,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 200 });
    }

    if (resource === "pages" && id === "publishes" && !child) {
      const payload = await createPageSiteRelease({
        context: consolePublishContextFromWorkspace(workspace),
        input: body as Parameters<typeof createPageSiteRelease>[0]["input"],
        requestId,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "pages" && id === "sites" && child && fourth === "releases" && !fifth) {
      const payload = await createPageSiteRelease({
        context: consolePublishContextFromWorkspace(workspace),
        input: {
          ...(body as Record<string, unknown>),
          siteRef: child,
        } as Parameters<typeof createPageSiteRelease>[0]["input"],
        requestId,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 201 });
    }

    if (resource === "pages" && id === "sites" && child && fourth === "releases" && fifth) {
      const action = segments[5];
      if (action === "activate") {
        const payload = await activatePageSiteRelease({
          context: consolePublishContextFromWorkspace(workspace),
          input: {
            siteRef: child,
            releaseId: fifth,
          },
          requestId,
        });
        return NextResponse.json(serializePagePayload(payload), { status: 200 });
      }
    }

    return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return NextResponse.json({ error: error.code }, { status: 409 });
    }

    const eventId = await captureConsoleApiException(error, {
      tags: {
        feature: "console-api",
        operation: "mutation",
        surface: "console",
      },
      contexts: {
        consoleApi: {
          method: request.method,
          path: request.nextUrl.pathname,
          requestId,
          segments,
        },
      },
    });
    console.error("Console mutation failed", { error, requestId, segments });
    return NextResponse.json({ error: "internal_error", eventId }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { segments = [] } = await context.params;
  const [resource, id, child, fourth, fifth] = segments;

  const auth = await getConsoleApiAuthState();
  if (!auth) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  try {
    if (isConsoleManageBugsPath(segments)) {
      const operator = await requirePlatformOperatorApi(auth);
      const payload = await routeManageBugsDelete(segments, requestId, operator.id);
      if (payload === null) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json(serializePagePayload(payload), { status: 200 });
    }

    const workspace = await getConsoleWorkspace(auth, {
      organizationRef: requestOrganizationRef(request),
    });
    const requiredFeature = consoleFeatureForSegments(segments);
    if (requiredFeature) await assertConsoleFeatureAccess(workspace, requiredFeature);

    if (
      resource === "projects" &&
      id &&
      child === "pages" &&
      fourth &&
      segments[4] === "viewer-assertion-audiences" &&
      segments[5]
    ) {
      const payload = await deleteViewerAssertionAudience({
        audienceId: segments[5],
        projectRef: id,
        requestId,
        siteRef: fourth,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 200 });
    }

    if (resource === "github" && id === "installations" && child && !fourth) {
      const payload = await unlinkGithubInstallation({
        connectionId: child,
        requestId,
        userSession: request.cookies.get(GITHUB_USER_SESSION_COOKIE)?.value,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 200 });
    }

    if (resource === "projects" && id && child === "knowledge" && fourth === "sources" && fifth) {
      const payload = await deleteKnowledgeSource({
        projectRef: id,
        requestId,
        sourceId: fifth,
        workspace,
      });
      return NextResponse.json(serializePagePayload(payload), { status: 200 });
    }

    return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return NextResponse.json({ error: error.code }, { status: 409 });
    }

    const eventId = await captureConsoleApiException(error, {
      tags: {
        feature: "console-api",
        operation: "delete",
        surface: "console",
      },
      contexts: {
        consoleApi: {
          method: request.method,
          path: request.nextUrl.pathname,
          requestId,
          segments,
        },
      },
    });
    console.error("Console delete failed", { error, requestId, segments });
    return NextResponse.json({ error: "internal_error", eventId }, { status: 500 });
  }
}

async function routeRequest(
  request: NextRequest,
  segments: string[],
  workspace: Awaited<ReturnType<typeof getConsoleWorkspace>>,
) {
  const [resource, id, child, fourth] = segments;

  if (!resource || resource === "organization") {
    return getCurrentOrganization(workspace);
  }

  if (
    resource === "organizations" &&
    id &&
    child === "control" &&
    segments[3] === "installations"
  ) {
    await assertConsoleFeatureAccess(workspace, "console.managed_runtime");
    return listRaviControlInstallations({
      organizationRef: id,
      workspace,
    });
  }

  if (resource === "organizations") {
    return listOrganizations(workspace);
  }

  if (resource === "features") {
    return getConsoleFeatureAccess(workspace);
  }

  if (resource === "github" && !id) {
    await assertConsoleFeatureAccess(workspace, "console.github");
    return getOrganizationGithubConfig({
      userSession: request.cookies.get(GITHUB_USER_SESSION_COOKIE)?.value,
      workspace,
    });
  }

  const requiredFeature = consoleFeatureForSegments(segments);
  const organizationSettings = resource === "settings" && !id && request.nextUrl.searchParams.get("scope") !== "project";
  if (requiredFeature && !organizationSettings) await assertConsoleFeatureAccess(workspace, requiredFeature);

  if (resource === "projects") {
    if (!id) return listProjects(workspace);
    if (child === "published-pages") return listPublishedPages(workspace, id);
    if (child === "pages") {
      if (!segments[3]) return listPageSites(workspace, id);
      if (segments[4] === "viewer-assertion-audiences" && !segments[5]) {
        return listViewerAssertionAudiences({
          projectRef: id,
          siteRef: segments[3],
          workspace,
        });
      }
      return getPageSiteDetail(workspace, id, segments[3]);
    }
    if (child === "knowledge") {
      if (segments[3] === "sources" && !segments[4]) return listKnowledgeSources({ projectRef: id, workspace });
      if (segments[3] === "sources" && segments[4]) {
        return getKnowledgeSource({ projectRef: id, sourceId: segments[4], workspace });
      }
    }
    if (child === "managed-runtime" && segments[3] === "instances") {
      if (segments[4]) {
        if (segments[5] === "sessions") {
          const sessionRef = segments[6];
          if (segments[7] === "events" && sessionRef) {
            return listManagedRaviSessionEvents({
              afterSequence: queryInteger(request, "after", 0),
              instanceId: segments[4],
              limit: queryInteger(request, "limit", 100),
              projectRef: id,
              sessionId: sessionRef,
              workspace,
            });
          }
          if (!segments[7]) {
            return getManagedRaviSession({
              instanceId: segments[4],
              projectRef: id,
              sessionId:
                !sessionRef || sessionRef === "current"
                  ? undefined
                  : sessionRef,
              workspace,
            });
          }
        }
        return getManagedInstance({
          instanceId: segments[4],
          projectRef: id,
          workspace,
        });
      }
      return listManagedInstances({ projectRef: id, workspace });
    }
    if (
      child === "ravi-control"
      && segments[3] === "instances"
      && segments[4]
      && segments[5] === "chat"
      && !segments[6]
    ) {
      return getRaviControlChat({
        instanceId: segments[4],
        projectRef: id,
        targetAgentId: request.nextUrl.searchParams.get("agent") ?? undefined,
        workspace,
      });
    }
    if (child === "runs") return listRuntimeRuns(workspace, id);
    if (child === "mail") return getMailOverview(workspace, id);
    if (child === "github-app") return getProjectGithubAppConfig({ projectRef: id, workspace });
    if (child === "artifacts") return listArtifacts(workspace, id);
    return getProject(workspace, id);
  }

  if (resource === "artifacts" && id) {
    if (child === "versions") return listArtifactVersions(workspace, id);
    return getArtifact(workspace, id);
  }

  if (resource === "events") {
    const projectId = request.nextUrl.searchParams.get("projectId") ?? undefined;
    return listAuditEvents(workspace, projectId);
  }

  if (resource === "feedback") {
    const projectId = request.nextUrl.searchParams.get("projectId") ?? undefined;
    return listConsoleFeedback(workspace, { projectRef: projectId });
  }

  if (resource === "bugs") {
    if (id) return getBugReportForReporter({ id, reporterUserId: workspace.user.id });
    return listBugReportsForReporter(workspace.user.id);
  }

  if (resource === "runs") {
    if (id) return getRuntimeRunDetail(workspace, id);
    return listRuntimeRuns(workspace);
  }

  if (resource === "pages" && id === "publishes" && child) {
    return getPagePublish({
      context: consolePublishContextFromWorkspace(workspace),
      publishId: child,
    });
  }

  if (resource === "mail") {
    const projectId = request.nextUrl.searchParams.get("projectId") ?? undefined;
    return getMailOverview(workspace, projectId);
  }

  if (resource === "domains") {
    return listConsoleDomainClaims({ workspace });
  }

  if (resource === "settings" && id === "invites" && !child) {
    throw new ConsoleApiError(403, { error: "legacy_membership_unsupported" });
  }

  if (resource === "pages" && id === "access" && child === "requests" && !segments[3]) {
    const siteId = request.nextUrl.searchParams.get("siteId") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw new ConsoleApiError(400, { error: "validation_failed" });
    return listSiteAccessRequests({
      actor: accessActorFromWorkspace(workspace),
      origin: raviLinkConsoleOrigin(request.url),
      siteId,
    });
  }

  if (resource === "pages" && id === "access" && !child) {
    const siteId = request.nextUrl.searchParams.get("siteId") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw new ConsoleApiError(400, { error: "validation_failed" });
    return listPagesSiteAccess({ actor: accessActorFromWorkspace(workspace), siteId });
  }

  if (resource === "settings") {
    const scope = request.nextUrl.searchParams.get("scope") === "project" ? "project" : "org";
    const projectId = request.nextUrl.searchParams.get("projectId") ?? undefined;
    return getSettingsData(workspace, scope, projectId);
  }

  return null;
}

function shouldCreateDefaultPageSite(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return true;
  return (body as Record<string, unknown>).createDefaultPageSite !== false;
}

function decideBody(body: unknown) {
  const value = (body ?? {}) as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : "";
  const decision: "approve" | "deny" | null =
    value.decision === "approve" ? "approve" : value.decision === "deny" ? "deny" : null;
  const scope = value.scope === "site" ? ("site" as const) : ("route" as const);
  if (!decision || !/^[0-9a-f-]{36}$/i.test(id)) throw new ConsoleApiError(400, { error: "validation_failed" });
  return { decision, id, scope };
}

function withIdempotencyHeader(body: unknown, request: NextRequest) {
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || !body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (record.idempotencyKey !== undefined) return body;
  return { ...record, idempotencyKey };
}

function queryInteger(request: NextRequest, name: string, fallback: number) {
  const raw = request.nextUrl.searchParams.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function serializePagePayload(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializePagePayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializePagePayload(item)]),
    );
  }
  return value;
}

async function routeManageBugsGet(request: NextRequest, segments: string[]) {
  const [, , child, fourth] = segments;
  if (!child) return listAdminBugReports(request.nextUrl.searchParams);
  if (!fourth) return getAdminBugReport(child);
  return null;
}

async function routeManageBugsPost(segments: string[], body: unknown, requestId: string) {
  const [, , child, fourth] = segments;
  if (!child || !fourth) return null;
  if (fourth === "status") return updateBugReportStatus({ id: child, body, requestId });
  if (fourth === "apply-triage") return applyBugReportTriage({ id: child, body, requestId });
  if (fourth === "triage") return storeBugReportTriage({ id: child, body, requestId });
  return null;
}

async function routeManageBugsDelete(segments: string[], requestId: string, actorId: string) {
  const [, , child, fourth] = segments;
  if (!child || fourth) return null;
  return deleteBugReport({
    id: child,
    requestId,
    actorType: "user",
    actorId,
  });
}

async function captureConsoleApiException(
  error: unknown,
  context: Parameters<typeof Sentry.captureException>[1],
) {
  ensureSentryServerClient();
  const eventId = Sentry.captureException(error, context);
  await Sentry.flush(2000);
  return eventId;
}

function ensureSentryServerClient() {
  if (Sentry.getClient()) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate: Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    enableLogs: true,
  });
}
