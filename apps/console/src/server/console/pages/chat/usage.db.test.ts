import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { updatePageChatSettingsFromCli, type PageChatCliWorkspace } from "./cli";

import {
  countOpenPageChatSessions,
  recordPageChatClose,
  recordPageChatSessionStarted,
  summarizeOpenPageChatSessions,
} from "./usage";

// Page Chat's start marker, open-session count and close report against a
// real Console database. Runs only with BASES_TEST_DATABASE_URL (and
// DATABASE_URL) pointing at it; creates and deletes its own fixtures.
const url = process.env.BASES_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectId = randomUUID();
const siteId = randomUUID();
const viewerUserId = randomUUID();
const now = new Date("2026-10-10T15:00:00.000Z");

function start(chatSessionId: string, startedAt: Date) {
  return recordPageChatSessionStarted({
    organizationId: orgId,
    projectId,
    siteId,
    releaseId: null,
    routeId: null,
    chatSessionId,
    viewerUserId,
    requestId: `req_${chatSessionId}`,
    startedAt,
    sessionMaxSeconds: 600,
  });
}

describeDb("Page Chat usage (database)", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values({ id: orgId, slug: `page-chat-${suffix}`, name: "Page Chat test" });
    await db.insert(schema.projects).values({ id: projectId, organizationId: orgId, slug: `pc-${suffix}`, name: "Page Chat" });
    await db.insert(schema.pageSites).values({
      id: siteId,
      organizationId: orgId,
      projectId,
      slug: `pc-${suffix}`,
      defaultHostname: `pc-${suffix}.ravi.page.test`,
    });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
  });

  test("counts started, unclosed and recent conversations; a close report frees the slot once", async () => {
    const open = randomUUID();
    const closed = randomUUID();
    const stale = randomUUID();
    await start(open, new Date(now.getTime() - 60_000));
    await start(open, new Date(now.getTime() - 60_000));
    await start(closed, new Date(now.getTime() - 120_000));
    await start(stale, new Date(now.getTime() - 3_600_000));

    const count = () => countOpenPageChatSessions({ organizationId: orgId, sessionMaxSeconds: 600, now });
    expect(await count()).toBe(2);
    expect(await summarizeOpenPageChatSessions({ organizationId: orgId, viewerUserId, sessionMaxSeconds: 600, now })).toEqual({
      count: 2,
      orgReservedSeconds: 1200,
      viewerReservedSeconds: 1200,
    });
    expect(
      (await summarizeOpenPageChatSessions({ organizationId: orgId, viewerUserId: randomUUID(), sessionMaxSeconds: 600, now }))
        .viewerReservedSeconds,
    ).toBe(0);

    const report = {
      chatSessionId: closed,
      endReason: "viewer_closed" as const,
      voiceSeconds: 42,
      usageComplete: true,
      model: "background-model",
      inputTokens: 1000,
      outputTokens: 200,
      toolCalls: { page_read: 2 },
    };
    expect(await recordPageChatClose({ report, requestId: "req_close" })).toBe(true);
    expect(await recordPageChatClose({ report, requestId: "req_close_retry" })).toBe(true);
    expect(await count()).toBe(1);

    const rows = await db
      .select({ metricKey: schema.usageEvents.metricKey, quantity: schema.usageEvents.quantity })
      .from(schema.usageEvents)
      .where(
        and(
          eq(schema.usageEvents.organizationId, orgId),
          sql`${schema.usageEvents.dimensionsJson}->>'chatSessionId' = ${closed}`,
          eq(schema.usageEvents.eventType, "pages.chat.session_closed"),
        ),
      );
    expect(rows.map((row) => [row.metricKey, Number(row.quantity)]).sort()).toEqual(
      [
        ["pages.chat.model_input_tokens", 1000],
        ["pages.chat.model_output_tokens", 200],
        ["pages.chat.sessions", 1],
        ["pages.chat.tool_calls", 2],
        ["pages.chat.voice_seconds", 42],
      ].sort(),
    );

    expect(
      await recordPageChatClose({ report: { ...report, chatSessionId: randomUUID() }, requestId: "req_unknown" }),
    ).toBe(false);
  });

  test("saves settings under a row lock, keeps other metadata keys and audits the change", async () => {
    await db.update(schema.pageSites).set({ metadataJson: { theme: "dark" } }).where(eq(schema.pageSites.id, siteId));
    const site = { id: siteId, organizationId: orgId, projectId } as never;
    const workspace = { user: { id: viewerUserId }, organization: { id: orgId }, membership: { role: "owner" } } as unknown as PageChatCliWorkspace;
    const result = await updatePageChatSettingsFromCli(
      { body: { voice: "tempo" }, projectRef: "p", requestId: "req_settings", siteRef: "s", workspace },
      { resolveSite: async () => site, featureEnabled: async () => true },
    );
    expect(result.settings.voice).toBe("tempo");

    const [row] = await db
      .select({ metadataJson: schema.pageSites.metadataJson })
      .from(schema.pageSites)
      .where(eq(schema.pageSites.id, siteId));
    expect(row?.metadataJson).toMatchObject({ theme: "dark", pageChat: { voice: "tempo", enabled: true } });

    const audits = await db
      .select({ action: schema.auditEvents.action, beforeJson: schema.auditEvents.beforeJson })
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.targetId, siteId), eq(schema.auditEvents.action, "pages.chat.settings.updated")));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.beforeJson).toMatchObject({ pageChat: { voice: "bossa" } });
  });
});
