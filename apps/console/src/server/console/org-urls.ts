import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { getConsoleApiAuthState, type ConsoleAuthState } from "@/lib/auth/session";
import { consoleBrowserOrigin, consoleRedirectUrl } from "@/lib/auth/console-origin";
import { orgPath, orgSegment, parseOrgPath } from "@/lib/console-paths";
import { db, schema } from "@/server/db";
import { isUuidRef } from "@/server/console/ref";
import {
  CONSOLE_ORGANIZATION_COOKIE,
  ConsoleWorkspaceSelectionRequiredError,
  getConsoleWorkspace,
  listSelectableConsoleOrganizationMemberships,
} from "@/server/console/workspace";

/**
 * Console URLs before the organization moved into them (`/projects`,
 * `/org/<section>`, `/p/<project>/...`) still answer: they redirect to the URL
 * of the organization they belong to. A project link goes to the organization
 * that owns the project when the reader is a member of it. Anything else stays
 * in the organization of the Console page the link was followed from, then
 * goes to the one this browser used last, or to the picker.
 */
export async function redirectLegacyConsolePath(request: NextRequest, deps: {
  getAuthState?: typeof getConsoleApiAuthState;
  resolveTarget?: typeof legacyConsoleRedirectTarget;
} = {}) {
  const appPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const auth = await (deps.getAuthState ?? getConsoleApiAuthState)();
  if (!auth) {
    return NextResponse.redirect(consoleRedirectUrl(`/login?${new URLSearchParams({ returnTo: appPath })}`, request.url));
  }

  const cookieRef = request.cookies.get(CONSOLE_ORGANIZATION_COOKIE)?.value ?? null;
  const target = await (deps.resolveTarget ?? legacyConsoleRedirectTarget)(auth, appPath, {
    cookieRef,
    refererRef: refererOrganization(request),
  });
  return NextResponse.redirect(consoleRedirectUrl(target, request.url));
}

export async function legacyConsoleRedirectTarget(
  auth: ConsoleAuthState,
  appPath: string,
  refs: { cookieRef: string | null; refererRef?: string | null },
) {
  const { cookieRef, refererRef = null } = refs;
  const projectRef = legacyProjectRef(appPath);
  if (projectRef) {
    const owner = await findProjectOrganization(auth, projectRef, refererRef ?? cookieRef);
    if (owner) return orgPath(orgSegment(owner), appPath);
  }

  if (refererRef) {
    try {
      const workspace = await getConsoleWorkspace(auth, { organizationRef: refererRef });
      return orgPath(orgSegment(workspace.organization), appPath);
    } catch (error) {
      if (!(error instanceof ConsoleWorkspaceSelectionRequiredError)) throw error;
    }
  }

  try {
    const workspace = await getConsoleWorkspace(auth, { organizationRef: cookieRef });
    return orgPath(orgSegment(workspace.organization), appPath);
  } catch (error) {
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return `/org?${new URLSearchParams({ returnTo: appPath })}`;
    }
    throw error;
  }
}

/**
 * Where to send someone who chose an organization, given where they were
 * going: an organization page of another organization, or an old path, opens
 * in the chosen organization.
 */
export function returnToForOrganization(organization: { id: string; slug: string }, returnTo: string | null) {
  const segment = orgSegment(organization);
  if (!returnTo) return orgPath(segment, "/projects");
  const parsed = parseOrgPath(returnTo);
  return orgPath(segment, parsed.path);
}

/** The organization of the Console page a link was followed from, if it was one. */
function refererOrganization(request: NextRequest) {
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    const url = new URL(referer);
    if (url.origin !== consoleBrowserOrigin(request.url)) return null;
    return parseOrgPath(url.pathname).org;
  } catch {
    return null;
  }
}

function legacyProjectRef(appPath: string) {
  const [first, second] = appPath.split(/[?#]/)[0]!.split("/").filter(Boolean);
  return first === "p" && second ? safeDecode(second) : null;
}

async function findProjectOrganization(auth: ConsoleAuthState, projectRef: string, preferredRef: string | null) {
  const memberships = await listSelectableConsoleOrganizationMemberships(auth);
  if (!memberships.length) return null;
  const organizationIds = memberships.map((row) => row.organization.id);
  const rows = await db
    .select({ organizationId: schema.projects.organizationId })
    .from(schema.projects)
    .where(
      and(
        inArray(schema.projects.organizationId, organizationIds),
        isUuidRef(projectRef)
          ? or(eq(schema.projects.id, projectRef), eq(schema.projects.slug, projectRef))
          : eq(schema.projects.slug, projectRef),
      ),
    );
  const owners = memberships.filter((row) => rows.some((project) => project.organizationId === row.organization.id));
  if (owners.length === 1) return owners[0]!.organization;
  // A slug several of the reader's organizations use: the one they came from, or used last, wins.
  const remembered = owners.find(
    (row) => row.organization.id === preferredRef || row.organization.slug === preferredRef,
  );
  return remembered?.organization ?? null;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The organization that used to have this slug, among the reader's own, so a
 * link from before a rename keeps opening it. Renames are recorded as
 * `organization.updated` audit events with the old slug.
 */
export async function findRenamedOrganization(
  memberships: { organization: { id: string; slug: string } }[],
  previousSlug: string,
) {
  if (!memberships.length) return null;
  const organizationIds = memberships.map((row) => row.organization.id);
  const [renamed] = await db
    .select({ organizationId: schema.auditEvents.organizationId })
    .from(schema.auditEvents)
    .where(
      and(
        eq(schema.auditEvents.action, "organization.updated"),
        inArray(schema.auditEvents.organizationId, organizationIds),
        sql`${schema.auditEvents.beforeJson}->>'slug' = ${previousSlug}`,
      ),
    )
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(1);
  const organization = memberships.find((row) => row.organization.id === renamed?.organizationId)?.organization;
  // The slug may have been taken by another of the reader's organizations since.
  if (!organization || memberships.some((row) => row.organization.slug === previousSlug)) return null;
  return organization;
}
