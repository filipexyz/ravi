import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { CliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";

import { routeCalendarRequest } from "./routes";
import { calendarAutoRecordAllowed } from "./service";
import { processCalendarMeeting, runCalendarTick, type CreateCalendarBot } from "./tick";

// Runs only with ACCESS_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database; creates and deletes its own fixtures.
const url = process.env.ACCESS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectId = randomUUID();
const admin = randomUUID();
const developer = randomUUID();
const viewer = randomUUID();
const adminConnection = randomUUID();
const developerConnection = randomUUID();
const viewerConnection = randomUUID();
const noScopeConnection = randomUUID();
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const email = (name: string) => `${name}-${suffix}@example.test`;
const workspace = (userId: string, role: string) => ({
  user: { id: userId },
  organization: { id: orgId },
  membership: { role },
});

function call(userId: string, role: string, method: string, segments: string[], body: unknown = {}, search = "") {
  return routeCalendarRequest({
    workspace: workspace(userId, role),
    envelope: "console",
    requestId: `req-${randomUUID().slice(0, 6)}`,
    method,
    segments,
    body,
    searchParams: new URLSearchParams(search),
  }).then((result) => result.payload as Record<string, any>);
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof CliApiError) return error.code;
    throw error;
  }
}

/** Stands in for the vendor: inserts the bot row the real service would. */
const sentBots: Array<{ userId: string; projectId: string; joinAt: Date | null; clientRef: string }> = [];
const fakeCreateBot: CreateCalendarBot = async (input) => {
  sentBots.push({ userId: input.workspace.user.id, projectId: input.projectId, joinAt: input.joinAt, clientRef: input.clientRef });
  const [bot] = await db
    .insert(schema.meetingBots)
    .values({
      organizationId: input.workspace.organization.id,
      projectId: input.projectId,
      requestedByUserId: input.workspace.user.id,
      platform: "google_meet",
      meetingUrl: input.meetingUrl,
      meetingCode: input.meetingUrl.split("/").pop() ?? null,
      botName: "Ravi",
      title: input.title,
      language: "pt",
      clientRef: input.clientRef,
      status: "requested",
      joinAt: input.joinAt,
      maxRecordingSeconds: 3600,
    })
    .returning({ id: schema.meetingBots.id });
  return { meetingId: bot!.id };
};

async function insertEvent(input: {
  connectionId: string;
  userId: string;
  code: string;
  startAt: Date;
  providerEventId?: string;
  externalAttendees?: boolean;
}) {
  const [row] = await db
    .insert(schema.calendarEvents)
    .values({
      organizationId: orgId,
      userId: input.userId,
      providerConnectionId: input.connectionId,
      providerEventId: input.providerEventId ?? randomUUID(),
      title: "Weekly",
      startAt: input.startAt,
      endAt: new Date(input.startAt.getTime() + 30 * 60_000),
      meetingUrl: `https://meet.google.com/${input.code}`,
      meetingCode: input.code,
      externalAttendees: input.externalAttendees ?? false,
    })
    .returning();
  return row!;
}

describeDb("calendar settings, events and the recording decision", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values({ id: orgId, name: "Agenda", slug: `agenda-${suffix}` });
    await db.insert(schema.projects).values({ id: projectId, name: "Calls", organizationId: orgId, slug: `calls-${suffix}` });
    await db.insert(schema.users).values([
      { id: admin, primaryEmail: email("admin") },
      { id: developer, primaryEmail: email("developer") },
      { id: viewer, primaryEmail: email("viewer") },
    ]);
    await db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, role: "admin", userId: admin },
      { organizationId: orgId, role: "developer", userId: developer },
      { organizationId: orgId, role: "viewer", userId: viewer },
    ]);
    await db.insert(schema.entitlements).values({ organizationId: orgId, key: "console.meetings", valueJson: {} });
    const connection = (id: string, userId: string, scopes: string[], account: string) => ({
      id,
      organizationId: orgId,
      userId,
      provider: "google",
      scopeKind: "user" as const,
      externalAccountId: `${account}-${suffix}`,
      externalAccountLogin: email(account),
      displayName: account,
      scopesJson: scopes,
    });
    await db.insert(schema.providerConnections).values([
      connection(adminConnection, admin, [CALENDAR_SCOPE], "admin"),
      connection(developerConnection, developer, [CALENDAR_SCOPE], "developer"),
      connection(viewerConnection, viewer, [CALENDAR_SCOPE], "viewer"),
      connection(noScopeConnection, developer, ["openid"], "developer-mail"),
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await db.delete(schema.users).where(inArray(schema.users.id, [admin, developer, viewer]));
  });

  test("each person sees only their own Google connections, with the writable projects", async () => {
    const overview = await call(developer, "developer", "GET", []);
    expect(overview.connections.map((entry: { connectionId: string }) => entry.connectionId).sort()).toEqual(
      [developerConnection, noScopeConnection].sort(),
    );
    expect(overview.connections.find((entry: { connectionId: string }) => entry.connectionId === noScopeConnection).hasCalendarScope).toBe(false);
    expect(overview.policy).toEqual({ autoRecordAllowed: false, canManage: false });
    expect(overview.projects.map((project: { id: string }) => project.id)).toEqual([projectId]);
    expect((await call(viewer, "viewer", "GET", [])).projects).toEqual([]);
  });

  test("settings: calendar scope, project, policy, and an audit of the changed fields only", async () => {
    expect(await errorCode(call(developer, "developer", "POST", ["settings"], { connectionId: noScopeConnection, syncEnabled: true }))).toBe(
      "CALENDAR_SCOPE_MISSING",
    );
    expect(await errorCode(call(developer, "developer", "POST", ["settings"], { connectionId: adminConnection, syncEnabled: true }))).toBe(
      "NOT_FOUND",
    );
    expect(await errorCode(call(developer, "developer", "POST", ["settings"], { connectionId: developerConnection, recordMode: "ask" }))).toBe(
      "PAYLOAD_INVALID",
    );
    expect(
      await errorCode(call(developer, "developer", "POST", ["settings"], { connectionId: developerConnection, recordMode: "auto", projectId })),
    ).toBe("POLICY_DISABLED");
    expect(await errorCode(call(viewer, "viewer", "POST", ["settings"], { connectionId: viewerConnection, recordMode: "ask", projectId }))).toBe(
      "PROJECT_ACCESS_DENIED",
    );

    const saved = await call(developer, "developer", "POST", ["settings"], {
      connectionId: developerConnection,
      syncEnabled: true,
      recordMode: "ask",
      projectId,
      briefingMinutes: 45,
    });
    expect(saved.connection.settings).toMatchObject({ syncEnabled: true, recordMode: "ask", projectId, briefingMinutes: 45, briefingEnabled: null });

    // Only owners and admins turn the policy on; then `auto` is accepted.
    expect(await errorCode(call(developer, "developer", "POST", ["policy"], { autoRecordAllowed: true }))).toBe("ORG_ACCESS_DENIED");
    expect((await call(admin, "admin", "POST", ["policy"], { autoRecordAllowed: true })).autoRecordAllowed).toBe(true);
    const auto = await call(developer, "developer", "POST", ["settings"], { connectionId: developerConnection, recordMode: "auto" });
    expect(auto.connection.settings).toMatchObject({ recordMode: "auto", effectiveRecordMode: "auto" });
    // With the policy off again a stored `auto` acts as `ask`.
    await call(admin, "admin", "POST", ["policy"], { autoRecordAllowed: false });
    expect(await calendarAutoRecordAllowed(orgId)).toBe(false);
    const overview = await call(developer, "developer", "GET", []);
    expect(overview.connections.find((entry: { connectionId: string }) => entry.connectionId === developerConnection).settings).toMatchObject({
      recordMode: "auto",
      effectiveRecordMode: "ask",
    });

    const audits = await db
      .select({ afterJson: schema.auditEvents.afterJson })
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.organizationId, orgId), eq(schema.auditEvents.action, "calendar.settings.updated")))
      .orderBy(schema.auditEvents.createdAt);
    expect(audits.map((audit) => audit.afterJson)).toEqual([
      { syncEnabled: true, recordMode: "ask", projectId, briefingMinutes: 45 },
      { recordMode: "auto" },
    ]);
    // The policy endpoint is the Console's only.
    await expect(
      routeCalendarRequest({
        workspace: workspace(admin, "admin"),
        envelope: "cli",
        requestId: "r",
        method: "GET",
        segments: ["policy"],
        body: {},
        searchParams: new URLSearchParams(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("events: own rows only, decisions before the start, briefing for the owner", async () => {
    const start = new Date(Date.now() + 3 * 3600_000);
    const own = await insertEvent({ connectionId: developerConnection, userId: developer, code: "own-aaaa-bbb", startAt: start });
    const other = await insertEvent({ connectionId: adminConnection, userId: admin, code: "own-aaaa-bbb", startAt: start });

    const listed = await call(developer, "developer", "GET", ["events"]);
    expect(listed.events.map((event: { id: string }) => event.id)).toContain(own.id);
    expect(listed.events.map((event: { id: string }) => event.id)).not.toContain(other.id);
    expect(await errorCode(call(developer, "developer", "GET", ["events", other.id]))).toBe("NOT_FOUND");
    expect(await errorCode(call(developer, "developer", "GET", ["events"], {}, "from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z"))).toBe(
      "PAYLOAD_INVALID",
    );

    const decided = await call(developer, "developer", "POST", ["events", own.id, "decision"], { decision: "record" });
    expect(decided.event).toMatchObject({ recordDecision: "record", recordDecisionProjectId: projectId, briefing: null });
    const cleared = await call(developer, "developer", "POST", ["events", own.id, "decision"], { decision: null });
    expect(cleared.event.recordDecision).toBeNull();

    const briefed = await call(developer, "developer", "POST", ["events", own.id, "briefing"], { markdown: "# Pauta\n- preço" });
    expect(briefed.event).toMatchObject({ hasBriefing: true, briefing: "# Pauta\n- preço" });
    expect(await errorCode(call(developer, "developer", "POST", ["events", own.id, "briefing"], { markdown: "x".repeat(20_001) }))).toBe(
      "PAYLOAD_INVALID",
    );
    expect((await call(developer, "developer", "POST", ["events", own.id, "briefing"], { markdown: "" })).event.hasBriefing).toBe(false);

    // A removed event comes back with updatedSince, so the local mirror drops it.
    const since = new Date(Date.now() - 1000).toISOString();
    await db.update(schema.calendarEvents).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.calendarEvents.id, own.id));
    expect((await call(developer, "developer", "GET", ["events"])).events.map((event: { id: string }) => event.id)).not.toContain(own.id);
    const changed = await call(developer, "developer", "GET", ["events"], {}, `updatedSince=${encodeURIComponent(since)}`);
    expect(changed.events.find((event: { id: string }) => event.id === own.id)?.deletedAt).toBeTruthy();

    const started = await insertEvent({ connectionId: developerConnection, userId: developer, code: "old-aaaa-bbb", startAt: new Date(Date.now() - 60_000) });
    expect(await errorCode(call(developer, "developer", "POST", ["events", started.id, "decision"], { decision: "skip" }))).toBe("CONFLICT");
  });

  test("three members with the same meeting: one bot, every row linked, a viewer grant for who cannot read the project", async () => {
    const start = new Date(Date.now() + 10 * 60_000);
    const code = `abc-${suffix.slice(0, 4)}-xyz`;
    const rows = [
      await insertEvent({ connectionId: developerConnection, userId: developer, code, startAt: start }),
      await insertEvent({ connectionId: adminConnection, userId: admin, code, startAt: start }),
      await insertEvent({ connectionId: viewerConnection, userId: viewer, code, startAt: start }),
    ];
    // The admin never records this calendar; the developer asks for this meeting explicitly.
    await db
      .insert(schema.calendarSettings)
      .values({ organizationId: orgId, userId: admin, providerConnectionId: adminConnection, recordMode: "off" })
      .onConflictDoUpdate({ target: schema.calendarSettings.providerConnectionId, set: { recordMode: "off" } });

    const input = { organizationId: orgId, meetingCode: code, startAt: start, requestId: "tick-1", now: new Date() };
    expect(await processCalendarMeeting(input, { createBot: fakeCreateBot })).toMatchObject({ outcome: "none", reason: "off" });

    await db
      .update(schema.calendarEvents)
      .set({ recordDecision: "record", recordDecisionProjectId: projectId, recordDecidedAt: new Date() })
      .where(eq(schema.calendarEvents.id, rows[0]!.id));
    const before = sentBots.length;
    const result = await runCalendarTick({ requestId: "tick-2", budgetMs: 60_000 }, { createBot: fakeCreateBot });
    expect(result.recorded).toBe(1);
    expect(sentBots.length).toBe(before + 1);
    expect(sentBots.at(-1)).toMatchObject({ userId: developer, projectId, clientRef: `calendar:${rows[0]!.id}` });
    expect(sentBots.at(-1)!.joinAt!.getTime()).toBe(start.getTime() - 60_000);

    const linked = await db
      .select({ id: schema.calendarEvents.id, meetingBotId: schema.calendarEvents.meetingBotId })
      .from(schema.calendarEvents)
      .where(inArray(schema.calendarEvents.id, rows.map((row) => row.id)));
    const botIds = new Set(linked.map((row) => row.meetingBotId));
    expect(botIds.size).toBe(1);
    const [botId] = [...botIds];
    expect(botId).toBeTruthy();

    const grants = await db
      .select({ subjectId: schema.accessGrants.subjectId, reason: schema.accessGrants.reason })
      .from(schema.accessGrants)
      .where(and(eq(schema.accessGrants.meetingBotId, botId!), eq(schema.accessGrants.objectType, "meeting")));
    expect(grants).toEqual([{ subjectId: viewer, reason: "calendar attendee" }]);

    // The next tick sends nothing new: every row already has the bot.
    const again = await runCalendarTick({ requestId: "tick-3", budgetMs: 60_000 }, { createBot: fakeCreateBot });
    expect(again.recorded).toBe(0);
    expect(sentBots.length).toBe(before + 1);

    // Someone who syncs the same meeting later is linked to the same bot.
    const late = await insertEvent({ connectionId: noScopeConnection, userId: developer, code, startAt: start });
    expect(await processCalendarMeeting({ ...input, requestId: "tick-4" }, { createBot: fakeCreateBot })).toMatchObject({
      outcome: "link",
      meetingId: botId,
    });
    const [lateRow] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, late.id));
    expect(lateRow!.meetingBotId).toBe(botId!);
  });

  test("auto records only meetings without external attendees, as the calendar's owner", async () => {
    await call(admin, "admin", "POST", ["policy"], { autoRecordAllowed: true });
    await call(developer, "developer", "POST", ["settings"], { connectionId: developerConnection, recordMode: "auto", projectId });
    const start = new Date(Date.now() + 15 * 60_000);
    await insertEvent({ connectionId: developerConnection, userId: developer, code: `ext-${suffix.slice(0, 4)}-aaa`, startAt: start, externalAttendees: true });
    await insertEvent({ connectionId: developerConnection, userId: developer, code: `int-${suffix.slice(0, 4)}-aaa`, startAt: start });

    const external = await processCalendarMeeting(
      { organizationId: orgId, meetingCode: `ext-${suffix.slice(0, 4)}-aaa`, startAt: start, requestId: "t", now: new Date() },
      { createBot: fakeCreateBot },
    );
    expect(external).toMatchObject({ outcome: "none", reason: "external_attendees" });
    const internal = await processCalendarMeeting(
      { organizationId: orgId, meetingCode: `int-${suffix.slice(0, 4)}-aaa`, startAt: start, requestId: "t", now: new Date() },
      { createBot: fakeCreateBot },
    );
    expect(internal).toMatchObject({ outcome: "record", reason: "auto" });
  });

  test("a failed send is kept on the row and retried on the next tick", async () => {
    const start = new Date(Date.now() + 12 * 60_000);
    const code = `err-${suffix.slice(0, 4)}-aaa`;
    const row = await insertEvent({ connectionId: developerConnection, userId: developer, code, startAt: start });
    await db.update(schema.calendarEvents).set({ recordDecision: "record", recordDecidedAt: new Date() }).where(eq(schema.calendarEvents.id, row.id));
    const failing: CreateCalendarBot = async () => {
      throw new CliApiError(429, "RATE_LIMITED", "Monthly meeting budget reached.");
    };
    const input = { organizationId: orgId, meetingCode: code, startAt: start, requestId: "t", now: new Date() };
    expect(await processCalendarMeeting(input, { createBot: failing })).toMatchObject({ outcome: "error" });
    const [failed] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, row.id));
    expect(failed!.recordError).toBe("RATE_LIMITED: Monthly meeting budget reached.");
    expect(await processCalendarMeeting(input, { createBot: fakeCreateBot })).toMatchObject({ outcome: "record" });
    const [fixed] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, row.id));
    expect(fixed!.recordError).toBeNull();
    expect(fixed!.meetingBotId).toBeTruthy();
  });
});
