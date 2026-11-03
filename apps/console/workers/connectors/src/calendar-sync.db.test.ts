import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import postgres from "postgres";

import type { ConnectorAdapter } from "./adapters/adapter";
import { createGoogleAdapter } from "./adapters/google";
import { runCalendarSync } from "./calendar-sync";
import { importRootWrapKey } from "./crypto";
import { openConnectorsDb, type ConnectorsDb } from "./db";
import type { HyperdriveBinding } from "./env";
import { storeConnectionTokens } from "./vault";

// Calendar sync against a migrated Console database with a fake Google.
// Runs only with CONNECTORS_TEST_DATABASE_URL; creates and deletes its own
// fixtures.
const url = process.env.CONNECTORS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const ROOT_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const owner = { id: randomUUID(), email: `cal-${suffix}-owner@acme.test` };
const colleague = { id: randomUUID(), email: `cal-${suffix}-colleague@acme.test` };

let sql: postgres.Sql;
let db: ConnectorsDb;
let rootWrapKey: CryptoKey;
let connectionId: string;
let settingsId: string;

const google = {
  items: [] as unknown[],
  pages: 1,
  status: 200,
  tokens: [] as string[],
  queries: [] as URLSearchParams[],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  if (`${target.origin}${target.pathname}` !== EVENTS_URL) return json({ error: "unexpected" }, 500);
  google.tokens.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
  google.queries.push(target.searchParams);
  if (google.status !== 200) return json({ error: { code: google.status } }, google.status);
  const page = Number(target.searchParams.get("pageToken") ?? "0");
  const next = page + 1 < google.pages ? String(page + 1) : undefined;
  return json({ items: page === 0 ? google.items : [], ...(next ? { nextPageToken: next } : {}) });
}) as typeof fetch;

function meeting(id: string, startOffsetMinutes: number, attendees: { email: string; self?: boolean }[]) {
  const start = new Date(Date.now() + startOffsetMinutes * 60_000);
  return {
    id,
    status: "confirmed",
    summary: `Call ${id}`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: new Date(start.getTime() + 30 * 60_000).toISOString() },
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    attendees: attendees.map((attendee) => ({ ...attendee, responseStatus: "accepted" })),
    updated: "2026-10-18T10:00:00.000Z",
  };
}

async function run() {
  await sql`update calendar_settings set last_synced_at = null where id = ${settingsId}`;
  const adapters = new Map<string, ConnectorAdapter>([
    ["google", createGoogleAdapter({ config: { clientId: "c", clientSecret: "s", fetchImpl: fakeFetch }, capabilities: new Map() })],
  ]);
  return runCalendarSync({ db, rootWrapKey, dekKeyVersion: 1, adapters, fetchImpl: fakeFetch, scope: { organizationId: orgId } });
}

async function events() {
  return sql<{ providerEventId: string; deletedAt: Date | null; externalAttendees: boolean; meetingCode: string | null; selfResponse: string | null }[]>`
    select provider_event_id as "providerEventId", deleted_at as "deletedAt",
           external_attendees as "externalAttendees", meeting_code as "meetingCode",
           self_response as "selfResponse"
    from calendar_events where provider_connection_id = ${connectionId}
    order by provider_event_id
  `;
}

describeDb("calendar sync", () => {
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, prepare: false });
    db = openConnectorsDb({ connectionString: url! } as HyperdriveBinding);
    rootWrapKey = await importRootWrapKey(ROOT_KEY);
    await sql`insert into organizations (id, name, slug) values (${orgId}, 'Acme', ${`cal-${suffix}`})`;
    for (const user of [owner, colleague]) {
      await sql`insert into users (id, primary_email) values (${user.id}, ${user.email})`;
      await sql`insert into organization_memberships (organization_id, user_id, role) values (${orgId}, ${user.id}, 'developer')`;
    }
    const [row] = await sql<{ id: string }[]>`
      insert into provider_connections (
        organization_id, user_id, provider, scope_kind, external_account_id, external_account_login,
        display_name, status, scopes_json
      ) values (
        ${orgId}, ${owner.id}, 'google', 'user', ${`sub-${suffix}`}, ${owner.email},
        'google', 'active', ${sql.json(["openid", "https://www.googleapis.com/auth/calendar.readonly"])}
      )
      returning id
    `;
    connectionId = row!.id;
    await storeConnectionTokens(db, {
      rootWrapKey,
      dekKeyVersion: 1,
      connection: { id: connectionId, organizationId: orgId, userId: owner.id },
      tokens: { accessToken: "at-calendar", refreshToken: "rt-calendar", expiresInSeconds: 3600, scopes: [] },
      existing: [],
    });
    const [settings] = await sql<{ id: string }[]>`
      insert into calendar_settings (organization_id, user_id, provider_connection_id, sync_enabled)
      values (${orgId}, ${owner.id}, ${connectionId}, true)
      returning id
    `;
    settingsId = settings!.id;
  });

  afterAll(async () => {
    await sql`delete from organizations where id = ${orgId}`;
    await sql`delete from users where id in ${sql([owner.id, colleague.id])}`;
    await sql.end({ timeout: 5 });
    await db.close();
  });

  test("stores the window with the stored token, and tells colleagues from outsiders", async () => {
    google.items = [
      meeting("a-internal", 30, [{ email: owner.email, self: true }, { email: colleague.email.toUpperCase() }]),
      meeting("b-external", 60, [{ email: owner.email, self: true }, { email: "client@other.test" }]),
    ];
    const report = await run();
    expect(report).toMatchObject({ connections: 1, synced: 1, failed: 0, written: 2, removed: 0 });
    expect(google.tokens.at(-1)).toBe("Bearer at-calendar");
    const query = google.queries.at(-1)!;
    expect(query.get("singleEvents")).toBe("true");
    expect(query.get("fields")).not.toContain("description");
    expect([...(await events())]).toEqual([
      { providerEventId: "a-internal", deletedAt: null, externalAttendees: false, meetingCode: "abc-defg-hij", selfResponse: "accepted" },
      { providerEventId: "b-external", deletedAt: null, externalAttendees: true, meetingCode: "abc-defg-hij", selfResponse: "accepted" },
    ]);
    const [settings] = await sql`select last_sync_error, last_synced_at from calendar_settings where id = ${settingsId}`;
    expect(settings!.last_sync_error).toBeNull();
    expect(settings!.last_synced_at).toBeTruthy();
  });

  test("an unchanged event is not rewritten; one the provider dropped is marked removed", async () => {
    const [before] = await sql`select updated_at from calendar_events where provider_event_id = 'a-internal' and provider_connection_id = ${connectionId}`;
    google.items = google.items.slice(0, 1);
    const report = await run();
    expect(report).toMatchObject({ written: 0, removed: 1 });
    const [after] = await sql`select updated_at from calendar_events where provider_event_id = 'a-internal' and provider_connection_id = ${connectionId}`;
    expect(after!.updated_at.getTime()).toBe(before!.updated_at.getTime());
    const rows = await events();
    expect(rows.find((row) => row.providerEventId === "b-external")?.deletedAt).toBeTruthy();
  });

  test("a listing cut by the page cap removes nothing", async () => {
    google.items = [];
    google.pages = 10;
    const report = await run();
    expect(report).toMatchObject({ synced: 1, removed: 0 });
    expect((await events()).find((row) => row.providerEventId === "a-internal")?.deletedAt).toBeNull();
    google.pages = 1;
  });

  test("an auth failure keeps the events and records auth_required", async () => {
    google.status = 401;
    const report = await run();
    expect(report).toMatchObject({ failed: 1 });
    const [settings] = await sql`select last_sync_error from calendar_settings where id = ${settingsId}`;
    expect(settings!.last_sync_error).toBe("auth_required");
    expect((await events()).find((row) => row.providerEventId === "a-internal")?.deletedAt).toBeNull();
    google.status = 200;
  });

  test("a connection synced moments ago is not taken again", async () => {
    await run();
    const again = await runCalendarSync({
      db,
      rootWrapKey,
      dekKeyVersion: 1,
      adapters: new Map(),
      fetchImpl: fakeFetch,
      scope: { organizationId: orgId },
    });
    expect(again.connections).toBe(0);
  });
});
