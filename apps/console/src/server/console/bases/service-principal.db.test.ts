import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { basesJobCaller } from "./service-principal";
import { loadBasesCallerAccess } from "./access";
import { createBase, changeBaseLifecycle } from "./bases";
import { resolveBaseScope, type BasesProjectScope } from "./scope";
import { createRowsDirect, updateRowDirect, changeRowLifecycleDirect } from "./rows";

const suite = process.env.BASES_TEST_DATABASE_URL ? describe : describe.skip;
const org = randomUUID(), other = randomUUID(), projectId = randomUUID();
let scope: BasesProjectScope;
suite("scoped internal job (real PG, no provider or network)", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values([{ id: org, name: "Job fixture", slug: org }, { id: other, name: "Other fixture", slug: other }]);
    const [project] = await db.insert(schema.projects).values({ id: projectId, organizationId: org, name: "Destination", slug: projectId }).returning();
    const caller = basesJobCaller("usage-metrics", project!, "service-fixture-request");
    scope = { caller, project: project!, access: await loadBasesCallerAccess(db, caller, project!), projectReadOnly: false };
  });
  afterAll(async () => { await db.delete(schema.organizations).where(inArray(schema.organizations.id, [org, other])); });
  test("only approved resources/operations; exact retry has one ledger effect and service provenance", async () => {
    await expect(createBase(scope, { name: "Forbidden", slug: "customer-data" })).rejects.toMatchObject({ status: 403 });
    await expect(createBase({ ...scope, project: { ...scope.project, organizationId: other } }, { name: "Wrong org", slug: "uso-dias" })).rejects.toMatchObject({ status: 403 });
    await createBase(scope, { name: "Usage", slug: "uso-dias", properties: [{ key: "name", name: "Name", type: "text" }] });
    const base = await resolveBaseScope(scope, "uso-dias");
    const input = { values: { name: "Synthetic aggregate" }, idempotencyKey: "original-service-operation" };
    const first = await createRowsDirect(base, input, null);
    const retry = await createRowsDirect(base, input, null);
    expect(retry.payload.idempotentReplay).toBe(true);
    expect(retry.payload).toMatchObject({ row: (first.payload as { row: unknown }).row });
    const entries = await db.select().from(schema.baseRowLedger).where(eq(schema.baseRowLedger.baseId, base.base.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorType: "system", actorId: null, requestId: "service-fixture-request",
      clientHintJson: { service: { principal: "console-job:usage-metrics", job: "usage-metrics" } } });
    const [audit] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, base.base.id));
    expect(audit?.metadataJson.service).toEqual({ principal: "console-job:usage-metrics", job: "usage-metrics" });
    await expect(changeRowLifecycleDirect(base, entries[0]!.rowId, "archive", { expectedVersion: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(changeBaseLifecycle(base, "archive", { expectedVersion: base.base.version })).rejects.toMatchObject({ status: 403 });
    await db.update(schema.projects).set({ status: "archived" }).where(eq(schema.projects.id, projectId));
    await expect(updateRowDirect(base, entries[0]!.rowId, { values: { name: "stale" }, expectedVersion: 1, idempotencyKey: "stale-project" }, null)).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(schema.baseRowLedger).where(eq(schema.baseRowLedger.baseId, base.base.id))).toHaveLength(1);
  });
});
