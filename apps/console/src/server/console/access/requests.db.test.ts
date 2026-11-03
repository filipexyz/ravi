import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import type { CliAuthContext } from "@/server/cli/auth";
import { CliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";

import { handleAccessCliRequest } from "./cli";
import { canUserViewPagesRoute } from "./grants";
import { createAccessRequest, decideAccessRequest, getAccessRequestView, listSiteAccessRequests } from "./requests";
import type { PageTarget } from "./targets";

// Runs only with ACCESS_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database; creates and deletes its own fixtures.
const url = process.env.ACCESS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const otherOrgId = randomUUID();
const projectId = randomUUID();
const siteId = randomUUID();
const routeId = randomUUID();
const admin = randomUUID();
const developer = randomUUID();
const viewer = randomUUID();
const outsider = randomUUID();
const installation = randomUUID();
const otherInstallation = randomUUID();
const ORIGIN = "https://console.ravi.bot";
const HOST = `req-${suffix}.ravi.page`;

const email = (name: string) => `${name}-${suffix}@example.test`;

function target(): PageTarget {
  return {
    host: HOST,
    path: "/deck",
    route: {
      artifactId: "art",
      artifactVersionId: "ver",
      assetBase: "/",
      entrypoint: "index.html",
      id: "binding",
      matchType: "exact",
      path: "/deck",
      priority: 0,
      routeId,
      visibility: "private",
    },
    site: {
      activeReleaseId: null,
      defaultHostname: HOST,
      defaultVisibility: "private",
      id: siteId,
      organizationId: orgId,
      projectId,
      status: "active",
    },
    visibility: "private",
  };
}

function cliAuth(input: { installationId: string; organizationId: string; role: string; userId: string }) {
  return {
    localInstallation: { id: input.installationId },
    membership: { role: input.role, status: "active" },
    organization: { id: input.organizationId },
    scopes: ["console.projects.read", "artifacts.publish"],
    user: { id: input.userId },
  } as unknown as CliAuthContext;
}

async function cliError(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof CliApiError) return error.code;
    throw error;
  }
}

describeDb("access requests and the access CLI", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values([
      { id: orgId, name: "Requests test", slug: `req-${suffix}` },
      { id: otherOrgId, name: "Other", slug: `req-other-${suffix}` },
    ]);
    await db.insert(schema.projects).values({ id: projectId, name: "P", organizationId: orgId, slug: `p-${suffix}` });
    await db.insert(schema.users).values([
      { id: admin, primaryEmail: email("admin") },
      { id: developer, primaryEmail: email("developer") },
      { id: viewer, primaryEmail: email("viewer") },
      { id: outsider, displayName: "Pedro", primaryEmail: email("outsider") },
    ]);
    await db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, role: "admin", userId: admin },
      { organizationId: orgId, role: "developer", userId: developer },
      { organizationId: orgId, role: "viewer", userId: viewer },
      { organizationId: otherOrgId, role: "owner", userId: outsider },
    ]);
    await db.insert(schema.localInstallations).values([
      { id: installation, name: "Luis Mac", organizationId: orgId, userId: developer },
      { id: otherInstallation, name: "Pedro Mac", organizationId: otherOrgId, userId: outsider },
    ]);
    await db.insert(schema.raviActorBindings).values([
      { consoleUserId: viewer, contactId: "contact_viewer", installationId: installation, linkedBy: viewer, organizationId: orgId },
      { consoleUserId: admin, contactId: "contact_admin", installationId: installation, linkedBy: admin, organizationId: orgId },
    ]);
    await db.insert(schema.pageSites).values({
      defaultHostname: HOST,
      defaultVisibility: "private",
      id: siteId,
      organizationId: orgId,
      projectId,
      slug: `req-${suffix}`,
    });
    await db.insert(schema.pageRoutes).values({ id: routeId, matchType: "exact", organizationId: orgId, path: "/deck", projectId, siteId });
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, [orgId, otherOrgId]));
    await db
      .delete(schema.users)
      .where(inArray(schema.users.primaryEmail, [email("admin"), email("developer"), email("viewer"), email("outsider"), email("guest")]));
  });

  test("someone outside asks, the page's managers see it, and approving opens only that page", async () => {
    // A member who reads the project needs no request.
    expect(await createAccessRequest({ caller: { userId: developer }, origin: ORIGIN, requestId: "r", target: target() })).toEqual({
      status: "already_allowed",
      url: `https://${HOST}/deck`,
    });

    const first = await createAccessRequest({
      caller: { userId: outsider },
      message: "Reviewing the deck",
      origin: ORIGIN,
      requestId: "r1",
      target: target(),
    });
    if (first.status !== "requested") throw new Error("expected a request");
    expect(first.created).toBe(true);
    expect(first.request.url).toBe(`${ORIGIN}/access/requests/${first.request.id}`);

    const again = await createAccessRequest({ caller: { userId: outsider }, origin: ORIGIN, requestId: "r2", target: target() });
    expect(again).toMatchObject({ created: false, request: { id: first.request.id } });

    const [inbox] = await db
      .select()
      .from(schema.agentInboxItems)
      .where(and(eq(schema.agentInboxItems.organizationId, orgId), eq(schema.agentInboxItems.eventType, "pages.access.requested")));
    expect(inbox).toMatchObject({ category: "pages", severity: "action_required", sourceId: first.request.id });

    // The link is forwardable: only the requester and the page's managers see what it is.
    const id = first.request.id;
    expect(await getAccessRequestView({ id, origin: ORIGIN, viewerUserId: viewer })).toEqual({ state: "not_allowed" });
    expect(await getAccessRequestView({ id, origin: ORIGIN, viewerUserId: outsider })).toMatchObject({ state: "requester" });
    expect(await getAccessRequestView({ id, origin: ORIGIN, viewerUserId: developer })).toMatchObject({
      detail: { message: "Reviewing the deck", requester: { email: email("outsider") }, routeMatched: true },
      state: "approver",
    });

    const listed = await listSiteAccessRequests({
      actor: { actorType: "user", organizationId: orgId, role: "developer", userId: developer },
      origin: ORIGIN,
      siteId,
    });
    expect(listed.requests.map((request) => request.id)).toEqual([id]);

    await expect(decideAccessRequest({ decision: "approve", id, origin: ORIGIN, requestId: "r", viewerUserId: viewer })).rejects.toMatchObject({
      payload: { error: "forbidden" },
    });
    const approved = await decideAccessRequest({ decision: "approve", id, origin: ORIGIN, requestId: "r", viewerUserId: developer });
    expect(approved.request.status).toBe("approved");
    const [stored] = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.id, id));
    expect(stored?.grantId).toBeTruthy();
    expect(await canUserViewPagesRoute({ routeId, siteId, userId: outsider })).toBe(true);
    await expect(decideAccessRequest({ decision: "deny", id, origin: ORIGIN, requestId: "r", viewerUserId: admin })).rejects.toMatchObject({
      payload: { error: "request_decided" },
    });

    // Now they see it, so asking again is not needed.
    expect(await createAccessRequest({ caller: { userId: outsider }, origin: ORIGIN, requestId: "r", target: target() })).toMatchObject({
      status: "already_allowed",
    });
  });

  test("an agent's approved request tells the installation that asked", async () => {
    const asked = await createAccessRequest({
      caller: {
        cli: { agentId: "main", agentName: "main", installationId: otherInstallation, organizationId: otherOrgId },
        userId: outsider,
      },
      // The longest message allowed still fits the grant's reason once approved.
      message: "x".repeat(500),
      origin: ORIGIN,
      requestId: "r",
      target: { ...target(), path: "/", route: null },
    });
    if (asked.status !== "requested") throw new Error("expected a request");

    const status = await handleAccessCliRequest({
      auth: cliAuth({ installationId: otherInstallation, organizationId: otherOrgId, role: "owner", userId: outsider }),
      body: {},
      method: "GET",
      origin: ORIGIN,
      requestId: "r",
      segments: ["requests", asked.request.id],
    });
    expect(status.payload).toMatchObject({ request: { id: asked.request.id, status: "pending" } });
    expect(
      await cliError(
        handleAccessCliRequest({
          auth: cliAuth({ installationId: installation, organizationId: orgId, role: "developer", userId: developer }),
          body: {},
          method: "GET",
          origin: ORIGIN,
          requestId: "r",
          segments: ["requests", asked.request.id],
        }),
      ),
    ).toBe("NOT_FOUND");

    // No page matched, so approving gives the whole site.
    await decideAccessRequest({ decision: "approve", id: asked.request.id, origin: ORIGIN, requestId: "r", viewerUserId: admin });
    const [notice] = await db
      .select()
      .from(schema.agentInboxItems)
      .where(and(eq(schema.agentInboxItems.organizationId, otherOrgId), eq(schema.agentInboxItems.eventType, "pages.access.approved")));
    expect(notice).toMatchObject({ targetId: otherInstallation, targetType: "local_installation" });
  });

  test("the CLI acts for the linked chat author, and never beyond the session user", async () => {
    const developerSession = cliAuth({ installationId: installation, organizationId: orgId, role: "developer", userId: developer });

    const shared = await handleAccessCliRequest({
      auth: developerSession,
      body: { email: email("guest"), site: true, url: `https://${HOST}/` },
      method: "POST",
      origin: ORIGIN,
      requestId: "r",
      segments: ["pages", "share"],
    });
    expect(shared).toMatchObject({ payload: { created: true, grant: { scope: "site" } }, status: 201 });

    // An unlinked author can't act; a linked viewer lacks the role.
    expect(
      await cliError(
        handleAccessCliRequest({
          auth: developerSession,
          body: { actor: { contactId: "contact_unknown" }, email: email("guest"), site: true, url: `https://${HOST}/` },
          method: "POST",
          origin: ORIGIN,
          requestId: "r",
          segments: ["pages", "share"],
        }),
      ),
    ).toBe("ACTOR_NOT_LINKED");
    expect(
      await cliError(
        handleAccessCliRequest({
          auth: developerSession,
          body: { actor: { contactId: "contact_viewer" }, email: email("guest"), site: true, url: `https://${HOST}/` },
          method: "POST",
          origin: ORIGIN,
          requestId: "r",
          segments: ["pages", "share"],
        }),
      ),
    ).toBe("PROJECT_ACCESS_DENIED");

    // A linked admin asking through a developer's daemon still can't invite: the session user can't.
    expect(
      await cliError(
        handleAccessCliRequest({
          auth: developerSession,
          body: { actor: { contactId: "contact_admin" }, email: email("newcomer") },
          method: "POST",
          origin: ORIGIN,
          requestId: "r",
          segments: ["invites", "create"],
        }),
      ),
    ).toBe("PROJECT_ACCESS_DENIED");

    const access = await handleAccessCliRequest({
      auth: developerSession,
      body: { url: `https://${HOST}/` },
      method: "POST",
      origin: ORIGIN,
      requestId: "r",
      segments: ["pages", "access"],
    });
    expect((access.payload as { grants: { email: string }[] }).grants.map((grant) => grant.email)).toContain(email("guest"));

    expect(
      await cliError(
        handleAccessCliRequest({
          auth: developerSession,
          body: { email: email("guest"), url: `https://${HOST}/missing` },
          method: "POST",
          origin: ORIGIN,
          requestId: "r",
          segments: ["pages", "share"],
        }),
      ),
    ).toBe("NOT_FOUND");

    const removed = await handleAccessCliRequest({
      auth: developerSession,
      body: { email: email("guest"), site: true, url: `https://${HOST}/` },
      method: "POST",
      origin: ORIGIN,
      requestId: "r",
      segments: ["pages", "unshare"],
    });
    expect(removed.payload).toEqual({ revoked: true });

    // Another organization's session can't manage this site.
    expect(
      await cliError(
        handleAccessCliRequest({
          auth: cliAuth({ installationId: otherInstallation, organizationId: otherOrgId, role: "owner", userId: outsider }),
          body: { url: `https://${HOST}/` },
          method: "POST",
          origin: ORIGIN,
          requestId: "r",
          segments: ["pages", "access"],
        }),
      ),
    ).toBe("ORG_ACCESS_DENIED");
  });
});
