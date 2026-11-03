import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { inArray, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { retrieveKnowledge } from "./retrieval";

// The project route's search (`retrieveKnowledge`) against Postgres: an
// organization's first search, whichever route it comes through, starts the
// backfill once. Runs only with KNOWLEDGE_TEST_DATABASE_URL (and DATABASE_URL)
// pointing at a throwaway database with the current schema.
const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectId = randomUUID();
const userId = randomUUID();

describeDb("knowledge project-route retrieval (DB)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values([{ id: userId, primaryEmail: `knowledge-retrieval-${suffix}@example.test`, displayName: "owner" }]);
    await db.insert(schema.organizations).values([{ id: orgId, slug: `knowledge-retrieval-${suffix}`, name: "Knowledge retrieval" }]);
    await db.insert(schema.organizationMemberships).values([{ organizationId: orgId, userId, role: "owner" }]);
    await db.insert(schema.projects).values([{ id: projectId, organizationId: orgId, slug: `retrieval-${suffix}`, name: "Retrieval" }]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, [userId]));
  });

  test("the organization's first search through the project route starts the backfill, once", async () => {
    const workspace = { mode: "workos" as const, user: { id: userId }, organization: { id: orgId }, membership: { role: "owner" } };
    const scheduled: Array<{ organizationId: string; requestId: string }> = [];
    const search = (requestId: string) =>
      retrieveKnowledge({
        body: { query: "política de trocas" },
        deps: { scheduleBackfill: (input) => void scheduled.push(input) },
        projectRef: projectId,
        requestId,
        workspace,
      });

    const first = await search("req_first");
    expect(first.citations).toEqual([]);
    expect(scheduled).toEqual([{ organizationId: orgId, requestId: "req_first" }]);

    await search("req_second");
    expect(scheduled).toHaveLength(1);
  });
});
