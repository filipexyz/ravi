import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";

import {
  canUserViewMeeting,
  getMeetingsSharingSettings,
  listMeetingAccess,
  listMeetingsSharedWithUser,
  meetingsExternalAgentsAllowed,
  readSharedMeeting,
  resolveMeetingForUser,
  shareMeeting,
  unshareMeeting,
  updateMeetingsSharingSettings,
} from "./sharing";

// Runs only with ACCESS_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database; creates and deletes its own fixtures.
const url = process.env.ACCESS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const otherOrgId = randomUUID();
const projectId = randomUUID();
const meetingId = randomUUID();
const admin = randomUUID();
const developer = randomUUID();
const viewer = randomUUID();
const outsider = randomUUID();

const email = (name: string) => `${name}-${suffix}@example.test`;
const workspace = (userId: string, role: string) => ({
  user: { id: userId },
  organization: { id: orgId },
  membership: { role },
});

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof ConsoleApiError) return error.payload.error;
    if (error instanceof CliApiError) return error.code;
    throw error;
  }
}

describeDb("meetings shared across organizations", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values([
      { id: orgId, name: "Rabbit", slug: `rabbit-${suffix}` },
      { id: otherOrgId, name: "Luis", slug: `luis-${suffix}` },
    ]);
    await db.insert(schema.projects).values({ id: projectId, name: "Calls", organizationId: orgId, slug: `calls-${suffix}` });
    await db.insert(schema.users).values([
      { id: admin, primaryEmail: email("admin") },
      { id: developer, primaryEmail: email("developer") },
      { id: viewer, primaryEmail: email("viewer") },
      { id: outsider, primaryEmail: email("outsider") },
    ]);
    await db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, role: "admin", userId: admin },
      { organizationId: orgId, role: "developer", userId: developer },
      { organizationId: orgId, role: "viewer", userId: viewer },
      { organizationId: otherOrgId, role: "owner", userId: outsider },
    ]);
    // Meetings need the entitlement; organizations created after it shipped start without it.
    await db.insert(schema.entitlements).values({ organizationId: orgId, key: "console.meetings", valueJson: {} });
    await db.insert(schema.meetingBots).values({
      id: meetingId,
      organizationId: orgId,
      projectId,
      requestedByUserId: developer,
      platform: "google_meet",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      meetingCode: "abc-defg-hij",
      botName: "Ravi",
      title: "Weekly",
      language: "pt",
      status: "recording",
      maxRecordingSeconds: 3600,
    });
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, [orgId, otherOrgId]));
    await db
      .delete(schema.users)
      .where(inArray(schema.users.primaryEmail, [email("admin"), email("developer"), email("viewer"), email("outsider"), email("guest"), email("twin")]));
  });

  test("the policy is off until an owner or admin turns it on, and every change is audited", async () => {
    expect(await meetingsExternalAgentsAllowed(orgId)).toBe(false);
    expect((await getMeetingsSharingSettings(workspace(developer, "developer"))).canEdit).toBe(false);
    expect(
      await errorCode(updateMeetingsSharingSettings({ body: { externalAgents: true }, requestId: "r", workspace: workspace(developer, "developer") })),
    ).toBe("forbidden");
    expect(await errorCode(updateMeetingsSharingSettings({ body: { externalAgents: "yes" }, requestId: "r", workspace: workspace(admin, "admin") }))).toBe(
      "validation_failed",
    );

    // Turning off what was never on writes nothing.
    await updateMeetingsSharingSettings({ body: { externalAgents: false }, requestId: "r0", workspace: workspace(admin, "admin") });
    const on = await updateMeetingsSharingSettings({ body: { externalAgents: true }, requestId: "r1", workspace: workspace(admin, "admin") });
    expect(on.externalAgents).toBe(true);
    expect(await meetingsExternalAgentsAllowed(orgId)).toBe(true);
    expect(await meetingsExternalAgentsAllowed(otherOrgId)).toBe(false);
    // Setting it to what it already is changes nothing and writes no audit.
    await updateMeetingsSharingSettings({ body: { externalAgents: true }, requestId: "r2", workspace: workspace(admin, "admin") });
    await updateMeetingsSharingSettings({ body: { externalAgents: false }, requestId: "r3", workspace: workspace(admin, "admin") });
    expect(await meetingsExternalAgentsAllowed(orgId)).toBe(false);

    const audits = await db
      .select({ requestId: schema.auditEvents.requestId })
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.organizationId, orgId), eq(schema.auditEvents.action, "organization_policy.updated")));
    expect(audits.map((audit) => audit.requestId).sort()).toEqual(["r1", "r3"]);
  });

  test("only people who can write to the project share, and sharing again updates the grant", async () => {
    const input = { meetingId, projectRef: projectId, requestId: "s" };
    expect(await errorCode(shareMeeting({ ...input, body: { email: email("guest") }, workspace: workspace(viewer, "viewer") }))).toBe(
      "PROJECT_ACCESS_DENIED",
    );
    expect(await errorCode(shareMeeting({ ...input, body: { email: "nope" }, workspace: workspace(developer, "developer") }))).toBe(
      "validation_failed",
    );

    const first = await shareMeeting({ ...input, body: { email: email("Guest").toUpperCase() }, workspace: workspace(developer, "developer") });
    expect(first.created).toBe(true);
    expect(first.userCreated).toBe(true);
    expect(first.grant.email).toBe(email("guest"));
    expect(first.grant.path).toBe(`/shared/meetings/${meetingId}`);

    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const second = await shareMeeting({ ...input, body: { email: email("guest"), expiresAt }, workspace: workspace(developer, "developer") });
    expect(second.created).toBe(false);
    expect(second.grant.id).toBe(first.grant.id);
    expect(second.grant.expiresAt).toBe(expiresAt);

    // Two shares at once with the same person end with one grant, and neither fails.
    const [a, b] = await Promise.all([
      shareMeeting({ ...input, body: { email: email("twin") }, workspace: workspace(developer, "developer") }),
      shareMeeting({ ...input, body: { email: email("twin") }, workspace: workspace(developer, "developer") }),
    ]);
    expect(a.grant.id).toBe(b.grant.id);
    await unshareMeeting({ body: { grantId: a.grant.id }, meetingId, projectRef: projectId, requestId: "t", workspace: workspace(developer, "developer") });

    const { grants } = await listMeetingAccess({ meetingId, projectRef: projectId, workspace: workspace(developer, "developer") });
    expect(grants.map((grant) => grant.email)).toEqual([email("guest")]);
  });

  test("a guest sees only the meeting they were given, and it shows under Shared with you", async () => {
    const [guest] = await db.select().from(schema.users).where(eq(schema.users.primaryEmail, email("guest")));
    if (!guest) throw new Error("guest missing");
    expect(await canUserViewMeeting({ meetingBotId: meetingId, userId: guest.id })).toBe(true);
    expect((await resolveMeetingForUser({ meetingId, userId: guest.id })).access).toBe("guest");
    expect((await resolveMeetingForUser({ meetingId, userId: developer })).access).toBe("member");
    // A viewer of the organization has no meetings feature and no grant.
    expect(await errorCode(resolveMeetingForUser({ meetingId, userId: viewer }))).toBe("NOT_FOUND");
    expect(await errorCode(resolveMeetingForUser({ meetingId, userId: outsider }))).toBe("NOT_FOUND");

    const shared = await listMeetingsSharedWithUser({ userId: guest.id });
    expect(shared.map((item) => [item.meetingId, item.organizationName, item.title])).toEqual([[meetingId, "Rabbit", "Weekly"]]);

    // Before the call is over the page shows the meeting without a recording, and the guest view is audited.
    const view = await readSharedMeeting({ meetingId, requestId: "g1", userId: guest.id });
    expect(view.access).toBe("guest");
    expect(view.recording).toBeNull();
    // A guest gets the recording, never the call link or the client reference.
    expect(view.meeting.meetingUrl).toBe("");
    expect(view.meeting.clientRef).toBeNull();
    expect((await readSharedMeeting({ meetingId, requestId: "m1", userId: developer })).meeting.meetingUrl).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    // The page refreshing while the call is processing writes one audit row, not one per refresh.
    await readSharedMeeting({ meetingId, requestId: "g2", userId: guest.id });
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.organizationId, orgId), eq(schema.auditEvents.action, "meetings.read.guest")));
    expect(audits.map((audit) => [audit.actorId, audit.requestId])).toEqual([[guest.id, "g1"]]);
  });

  test("removing access takes the meeting away, and expired grants never count", async () => {
    const [guest] = await db.select().from(schema.users).where(eq(schema.users.primaryEmail, email("guest")));
    if (!guest) throw new Error("guest missing");
    const { grants } = await listMeetingAccess({ meetingId, projectRef: projectId, workspace: workspace(developer, "developer") });
    const grantId = grants[0]?.id ?? "";

    expect(
      await errorCode(unshareMeeting({ body: { grantId }, meetingId, projectRef: projectId, requestId: "u", workspace: workspace(viewer, "viewer") })),
    ).toBe("PROJECT_ACCESS_DENIED");
    expect(
      (await unshareMeeting({ body: { grantId }, meetingId, projectRef: projectId, requestId: "u", workspace: workspace(developer, "developer") }))
        .revoked,
    ).toBe(true);
    expect(
      (await unshareMeeting({ body: { grantId }, meetingId, projectRef: projectId, requestId: "u", workspace: workspace(developer, "developer") }))
        .revoked,
    ).toBe(false);
    expect(await canUserViewMeeting({ meetingBotId: meetingId, userId: guest.id })).toBe(false);
    expect(await listMeetingsSharedWithUser({ userId: guest.id })).toEqual([]);

    await shareMeeting({
      body: { email: email("guest"), expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      meetingId,
      projectRef: projectId,
      requestId: "s2",
      workspace: workspace(developer, "developer"),
    });
    expect(await canUserViewMeeting({ meetingBotId: meetingId, userId: guest.id, now: new Date(Date.now() + 2 * 86_400_000) })).toBe(false);
  });

  test("a meeting grant needs its meeting, and a Pages grant its site", async () => {
    const insert = (values: Partial<typeof schema.accessGrants.$inferInsert>) =>
      db.insert(schema.accessGrants).values({
        organizationId: orgId,
        projectId,
        objectId: meetingId,
        objectType: "meeting",
        subjectId: outsider,
        ...values,
      });
    await expect(insert({ meetingBotId: null }).then(() => "ok")).rejects.toThrow();
    await expect(insert({ objectType: "page_site", meetingBotId: meetingId }).then(() => "ok")).rejects.toThrow();
  });
});
