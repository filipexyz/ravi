import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";

import type { AccessActor } from "./common";
import {
  canUserViewPagesRoute,
  listPagesSharedWithUser,
  listPagesSiteAccess,
  sharePagesAccess,
  unsharePagesAccess,
} from "./grants";
import {
  acceptOrganizationInvite,
  createOrganizationInvite,
  getOrganizationInviteView,
  listOrganizationInvites,
  revokeOrganizationInvite,
} from "./invites";

// Runs only with ACCESS_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database; creates and deletes its own fixtures.
const url = process.env.ACCESS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const otherOrgId = randomUUID();
const projectId = randomUUID();
const siteId = randomUUID();
const deckRouteId = randomUUID();
const planRouteId = randomUUID();
const owner = randomUUID();
const admin = randomUUID();
const developer = randomUUID();
const viewer = randomUUID();
const outsider = randomUUID();
const ORIGIN = "https://console.ravi.bot";

const email = (name: string) => `${name}-${suffix}@example.test`;
const actor = (userId: string, role: string): AccessActor => ({ actorType: "user", organizationId: orgId, role, userId });
const browser = (userId: string, address: string, emailVerified = true) => ({
  actorType: "user" as const,
  email: address,
  emailVerified,
  impersonated: false,
  userId,
});

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof ConsoleApiError) return error.payload.error;
    throw error;
  }
}

function tokenFrom(inviteUrl: string) {
  return inviteUrl.split("/invite/")[1] ?? "";
}

describeDb("organization invites and per-person Pages access", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values([
      { id: orgId, name: "Access test", slug: `access-${suffix}` },
      { id: otherOrgId, name: "Other org", slug: `access-other-${suffix}` },
    ]);
    await db.insert(schema.projects).values({ id: projectId, name: "P", organizationId: orgId, slug: `p-${suffix}` });
    await db.insert(schema.users).values([
      { id: owner, primaryEmail: email("owner") },
      { id: admin, primaryEmail: email("admin") },
      { id: developer, primaryEmail: email("developer") },
      { id: viewer, primaryEmail: email("viewer") },
      { id: outsider, primaryEmail: email("outsider") },
    ]);
    await db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, role: "owner", userId: owner },
      { organizationId: orgId, role: "admin", userId: admin },
      { organizationId: orgId, role: "developer", userId: developer },
      { organizationId: orgId, role: "viewer", userId: viewer },
      { organizationId: otherOrgId, role: "owner", userId: outsider },
    ]);
    await db.insert(schema.pageSites).values({
      defaultHostname: `access-${suffix}.ravi.page`,
      defaultVisibility: "private",
      id: siteId,
      organizationId: orgId,
      projectId,
      slug: `access-${suffix}`,
    });
    await db.insert(schema.pageRoutes).values([
      { id: deckRouteId, matchType: "exact", organizationId: orgId, path: "/deck", projectId, siteId },
      { id: planRouteId, matchType: "exact", organizationId: orgId, path: "/plan", projectId, siteId },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, [orgId, otherOrgId]));
    await db
      .delete(schema.users)
      .where(inArray(schema.users.primaryEmail, [
        email("owner"),
        email("admin"),
        email("developer"),
        email("viewer"),
        email("outsider"),
        email("newcomer"),
        email("guest"),
      ]));
  });

  test("only owners and admins invite, and only owners invite owners", async () => {
    expect(await errorCode(createOrganizationInvite({ actor: actor(developer, "developer"), body: { email: email("x") }, origin: ORIGIN, requestId: "r" }))).toBe("forbidden");
    expect(await errorCode(createOrganizationInvite({ actor: actor(admin, "admin"), body: { email: email("x"), role: "owner" }, origin: ORIGIN, requestId: "r" }))).toBe("owner_required");
    expect(await errorCode(createOrganizationInvite({ actor: actor(admin, "admin"), body: { email: email("viewer") }, origin: ORIGIN, requestId: "r" }))).toBe("already_member");
  });

  test("an invite joins the invited email once, and a new link replaces the old one", async () => {
    const first = await createOrganizationInvite({
      actor: actor(admin, "admin"),
      body: { email: email("Newcomer").toUpperCase(), role: "developer" },
      origin: ORIGIN,
      requestId: "r1",
    });
    expect(first.url.startsWith(`${ORIGIN}/invite/rvinv_`)).toBe(true);
    expect(first.invite.email).toBe(email("newcomer"));

    const second = await createOrganizationInvite({
      actor: actor(admin, "admin"),
      body: { email: email("newcomer"), role: "viewer" },
      origin: ORIGIN,
      requestId: "r2",
    });
    const pending = await listOrganizationInvites({ actor: actor(admin, "admin") });
    expect(pending.filter((invite) => invite.email === email("newcomer")).map((invite) => invite.role)).toEqual(["viewer"]);
    expect((await getOrganizationInviteView({ token: tokenFrom(first.url), viewer: browser(outsider, email("newcomer")) })).state).toBe("revoked");

    // The newcomer signs up: a fresh user with that email.
    const [newcomer] = await db.insert(schema.users).values({ primaryEmail: email("newcomer") }).returning();
    const token = tokenFrom(second.url);

    expect((await getOrganizationInviteView({ token, viewer: browser(newcomer!.id, email("newcomer"), false) })).state).toBe("email_unverified");
    expect((await getOrganizationInviteView({ token, viewer: browser(outsider, email("outsider")) })).state).toBe("email_mismatch");
    expect(await errorCode(acceptOrganizationInvite({ requestId: "r", token, viewer: browser(outsider, email("outsider")) }))).toBe("INVITE_EMAIL_MISMATCH");

    const view = await getOrganizationInviteView({ token, viewer: browser(newcomer!.id, email("newcomer")) });
    expect(view).toMatchObject({ organizationName: "Access test", role: "viewer", state: "pending" });

    const accepted = await acceptOrganizationInvite({ requestId: "r3", token, viewer: browser(newcomer!.id, email("newcomer")) });
    expect(accepted.organizationId).toBe(orgId);
    const [membership] = await db
      .select()
      .from(schema.organizationMemberships)
      .where(and(eq(schema.organizationMemberships.organizationId, orgId), eq(schema.organizationMemberships.userId, newcomer!.id)));
    expect(membership).toMatchObject({ role: "viewer", status: "active" });

    // Opening it again is harmless; someone else can't reuse it.
    expect(await acceptOrganizationInvite({ requestId: "r4", token, viewer: browser(newcomer!.id, email("newcomer")) })).toEqual({ organizationId: orgId });
    expect(await errorCode(acceptOrganizationInvite({ requestId: "r5", token, viewer: browser(outsider, email("newcomer")) }))).toBe("INVITE_USED");
  });

  test("expired and revoked invites can't be accepted", async () => {
    const created = await createOrganizationInvite({
      actor: actor(owner, "owner"),
      body: { email: email("late") },
      now: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      origin: ORIGIN,
      requestId: "r",
    });
    const token = tokenFrom(created.url);
    expect((await getOrganizationInviteView({ token, viewer: browser(outsider, email("late")) })).state).toBe("expired");
    expect(await errorCode(acceptOrganizationInvite({ requestId: "r", token, viewer: browser(outsider, email("late")) }))).toBe("INVITE_EXPIRED");
    // The first try stored the status; a retry still reads as expired, not used.
    expect(await errorCode(acceptOrganizationInvite({ requestId: "r", token, viewer: browser(outsider, email("late")) }))).toBe("INVITE_EXPIRED");

    const ownerInvite = await createOrganizationInvite({ actor: actor(owner, "owner"), body: { email: email("boss"), role: "owner" }, origin: ORIGIN, requestId: "r" });
    // An admin session can't revoke an owner invite, even when the acting person is an owner.
    expect(
      await errorCode(
        revokeOrganizationInvite({ actor: actor(owner, "owner"), alsoAuthorize: [actor(admin, "admin")], body: { inviteId: ownerInvite.invite.id }, requestId: "r" }),
      ),
    ).toBe("owner_required");

    const another = await createOrganizationInvite({ actor: actor(owner, "owner"), body: { email: email("gone") }, origin: ORIGIN, requestId: "r" });
    expect(await revokeOrganizationInvite({ actor: actor(admin, "admin"), body: { inviteId: another.invite.id }, requestId: "r" })).toEqual({ revoked: true });
    expect(await errorCode(acceptOrganizationInvite({ requestId: "r", token: tokenFrom(another.url), viewer: browser(outsider, email("gone")) }))).toBe("INVITE_REVOKED");
  });

  test("people who publish share one page with one person, who sees only that page", async () => {
    expect(await errorCode(sharePagesAccess({ actor: actor(viewer, "viewer"), body: { email: email("guest"), siteId }, requestId: "r" }))).toBe("forbidden");
    expect(await errorCode(sharePagesAccess({ actor: { ...actor(outsider, "owner"), organizationId: otherOrgId }, body: { email: email("guest"), siteId }, requestId: "r" }))).toBe("site_not_found");

    const shared = await sharePagesAccess({
      actor: actor(developer, "developer"),
      body: { email: email("guest"), path: "/deck/", siteId },
      requestId: "r",
    });
    expect(shared).toMatchObject({ created: true, grant: { routeId: deckRouteId, scope: "route", url: `https://access-${suffix}.ravi.page/deck` }, userCreated: true });
    const guestId = shared.grant.userId;

    expect(await canUserViewPagesRoute({ routeId: deckRouteId, siteId, userId: guestId })).toBe(true);
    expect(await canUserViewPagesRoute({ routeId: planRouteId, siteId, userId: guestId })).toBe(false);
    expect(await canUserViewPagesRoute({ routeId: deckRouteId, siteId, userId: outsider })).toBe(false);

    // Sharing again updates the same grant.
    const again = await sharePagesAccess({ actor: actor(developer, "developer"), body: { email: email("guest"), routeId: deckRouteId, siteId }, requestId: "r" });
    expect(again).toMatchObject({ created: false, grant: { id: shared.grant.id } });

    const access = await listPagesSiteAccess({ actor: actor(admin, "admin"), siteId });
    expect(access.grants.map((grant) => grant.email)).toEqual([email("guest")]);

    const mine = await listPagesSharedWithUser({ userId: guestId });
    expect(mine).toMatchObject([{ organizationName: "Access test", path: "/deck", scope: "route" }]);

    expect(await unsharePagesAccess({ actor: actor(developer, "developer"), body: { grantId: shared.grant.id }, requestId: "r" })).toEqual({ revoked: true });
    expect(await canUserViewPagesRoute({ routeId: deckRouteId, siteId, userId: guestId })).toBe(false);
    expect(await listPagesSharedWithUser({ userId: guestId })).toEqual([]);
  });

  test("a whole-site grant covers every page, until it expires", async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const shared = await sharePagesAccess({
      actor: actor(owner, "owner"),
      body: { email: email("outsider"), expiresAt: soon, siteId },
      requestId: "r",
    });
    expect(shared.grant.scope).toBe("site");
    expect(await canUserViewPagesRoute({ routeId: planRouteId, siteId, userId: outsider })).toBe(true);
    expect(
      await canUserViewPagesRoute({ now: new Date(Date.now() + 120_000), routeId: planRouteId, siteId, userId: outsider }),
    ).toBe(false);

    expect(await errorCode(sharePagesAccess({ actor: actor(owner, "owner"), body: { email: email("outsider"), expiresAt: new Date(Date.now() - 1000).toISOString(), siteId }, requestId: "r" }))).toBe("validation_failed");
  });
});
