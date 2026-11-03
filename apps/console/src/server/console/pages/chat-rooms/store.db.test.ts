import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { projectChatRoomIntoBase } from "./projection";
import { chatRoomStoreForDb } from "./store";

// The Postgres chat store and the Base projection against a migrated Console
// database. Runs only with BASES_TEST_DATABASE_URL (and DATABASE_URL) set;
// creates and deletes its own fixtures.
const url = process.env.BASES_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectId = randomUUID();
const siteId = randomUUID();
const routeId = randomUUID();
const ana = randomUUID();
const bruno = randomUUID();

describeDb("Page chat store (Postgres)", () => {
  const store = chatRoomStoreForDb();

  beforeAll(async () => {
    await db.insert(schema.users).values([
      { id: ana, primaryEmail: `chat-${suffix}-ana@example.test`, displayName: "Ana" },
      { id: bruno, primaryEmail: `chat-${suffix}-bruno@example.test`, displayName: "Bruno" },
    ]);
    await db.insert(schema.organizations).values({ id: orgId, slug: `chat-${suffix}`, name: "Chat test" });
    await db.insert(schema.billingAccounts).values({ organizationId: orgId, provider: "manual", planKey: "free" });
    await db.insert(schema.projects).values({ id: projectId, organizationId: orgId, slug: `chat-${suffix}`, name: "Chat" });
    await db.insert(schema.pageSites).values({ id: siteId, organizationId: orgId, projectId, slug: `chat-${suffix}`, defaultHostname: `chat-${suffix}.ravi.page.test` });
    await db.insert(schema.pageRoutes).values({ id: routeId, organizationId: orgId, projectId, siteId, path: "/", matchType: "exact" });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${ana}::uuid, ${bruno}::uuid)`);
  });

  const roomInput = (kind: "shared" | "private", ownerUserId: string | null) => ({ organizationId: orgId, projectId, siteId, routeId, kind, ownerUserId, path: "/" });
  const message = (room: Awaited<ReturnType<typeof store.getOrCreateRoom>>, authorUserId: string, body: string, clientMessageId: string | null = null) => ({
    room,
    authorType: "user" as const,
    authorUserId,
    authorName: authorUserId === ana ? "Ana" : "Bruno",
    authorRole: "member" as const,
    body,
    parts: [],
    status: "complete" as const,
    source: "text" as const,
    clientMessageId,
    anchor: null,
    turnId: null,
  });

  test("one shared room per route even when opened at once, and one private room per person", async () => {
    const opened = await Promise.all([store.getOrCreateRoom(roomInput("shared", null)), store.getOrCreateRoom(roomInput("shared", null))]);
    expect(opened[0].id).toBe(opened[1].id);
    const mine = await store.getOrCreateRoom(roomInput("private", ana));
    const theirs = await store.getOrCreateRoom(roomInput("private", bruno));
    expect(new Set([opened[0].id, mine.id, theirs.id]).size).toBe(3);
  });

  test("messages get consecutive seqs under concurrency and a repeated client id is one message", async () => {
    const room = await store.getOrCreateRoom(roomInput("shared", null));
    const sent = await Promise.all(Array.from({ length: 8 }, (_, index) => store.insertMessage(message(room, index % 2 ? bruno : ana, `m${index}`))));
    expect(sent.map((item) => item.message.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const first = await store.insertMessage(message(room, ana, "oi", "c-1"));
    const again = await store.insertMessage(message(room, ana, "oi", "c-1"));
    expect(again.created).toBe(false);
    expect(again.message.id).toBe(first.message.id);
    expect((await store.findRoom(room.id))?.lastSeq).toBe(9);
    expect((await store.listMessages(room.id, { afterSeq: 7, limit: 10 })).map((item) => item.seq)).toEqual([8, 9]);
    expect((await store.listAuthors(room.id)).map((author) => author.userId).sort()).toEqual([ana, bruno].sort());
    await store.setLastRead(room.id, ana, 5);
    await store.setLastRead(room.id, ana, 3);
    expect(await store.getLastRead(room.id, ana)).toBe(5);
  });

  test("a confirmation is decided once", async () => {
    const room = await store.getOrCreateRoom(roomInput("shared", null));
    const trigger = await store.insertMessage(message(room, ana, "cria a linha"));
    const turn = await store.insertTurn({
      roomId: room.id,
      organizationId: orgId,
      projectId,
      siteId,
      triggerMessageId: trigger.message.id,
      speakerUserId: ana,
      speakerKind: "member",
      speakerOrgRole: "owner",
      pagesSessionId: null,
      status: "running",
      model: "test/model",
    });
    expect((await store.listOpenTurns(room.id)).map((open) => open.id)).toContain(turn.id);
    const confirmation = await store.insertConfirmation({
      roomId: room.id,
      turnId: turn.id,
      messageId: trigger.message.id,
      forUserId: ana,
      toolCallId: "call-1",
      operationId: "ravi.bases.views.rows.create",
      input: { values: { nome: "Ana" } },
      summary: "Criar linha",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const decided = await Promise.all([store.decideConfirmation(confirmation.id, "confirmed", new Date()), store.decideConfirmation(confirmation.id, "cancelled", new Date())]);
    expect(decided.filter(Boolean)).toHaveLength(1);
  });

  test("the shared room is projected into the project's Base once, and private rooms never", async () => {
    const room = await store.getOrCreateRoom(roomInput("shared", null));
    const deps = { basesAvailable: async () => true };
    const first = await projectChatRoomIntoBase({ roomId: room.id }, deps);
    expect(first?.created).toBe(10);
    expect(await projectChatRoomIntoBase({ roomId: room.id }, deps)).toEqual({ created: 0, updated: 0 });
    const [counted] = (await db.execute(sql`
      SELECT count(*)::int AS count FROM base_rows r JOIN bases b ON b.id = r.base_id
      WHERE b.project_id = ${projectId}::uuid AND b.slug = 'conversas-pages'
    `)) as unknown as Array<{ count: number }>;
    expect(counted?.count).toBe(10);
    const mine = await store.getOrCreateRoom(roomInput("private", ana));
    await store.insertMessage(message(mine, ana, "só meu"));
    expect(await projectChatRoomIntoBase({ roomId: mine.id }, deps)).toBeNull();
  });
});
