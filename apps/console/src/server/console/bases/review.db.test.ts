import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { basesPolicyFixture, basesCliFixture } from "../../../../tests/review/bases-policy-fixture";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import postgres from "postgres";

import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import { BASES_LIMITS } from "@/shared/bases/limits";

import { basesCallerFromCliAuth, basesCallerFromConsoleWorkspace, type BasesCaller } from "./context";
import { handleBasesRequest } from "./http";
import { runBasesRead } from "./reads";
import * as repository from "./repository";
import { VIEW_INVALID_PUBLIC_REASON } from "./view-model";

// Regression tests for review findings: view writes lock before the filter
// check, replays and history through a view, view_invalid reasons, chart
// public specs, migration ledger entries, subscriber re-authorization, NUL
// input, date sentinels, the active-row cap, and statement timeouts. Runs
// only with BASES_TEST_DATABASE_URL (and DATABASE_URL); creates and deletes
// its own organization, users, project, and installation.
const url = process.env.BASES_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type J = any;
type Res = { status: number; body: J };
type TestUser = { id: string; email: string; orgRole: "owner" | "developer" | "viewer" };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const project = { id: randomUUID(), slug: `bases-rev-${suffix}` };
const installationId = randomUUID();

const makeUser = (label: string, orgRole: TestUser["orgRole"]): TestUser => ({
  id: randomUUID(),
  email: `bases-rev-${suffix}-${label}@example.test`,
  orgRole,
});
const owner = makeUser("owner", "owner");
const subscriber = makeUser("sub", "developer");
const viewerA = makeUser("va", "viewer");
const viewerB = makeUser("vb", "viewer");
const leaver = makeUser("leaver", "viewer");
const USERS = [owner, subscriber, viewerA, viewerB, leaver];
let cliSession: Awaited<ReturnType<typeof basesCliFixture>>;
let policyFixture: Awaited<ReturnType<typeof basesPolicyFixture>>;

function consoleCaller(user: TestUser): BasesCaller {
  return basesCallerFromConsoleWorkspace(
    {
      mode: "workos",
      user: { id: user.id, primaryEmail: user.email },
      organization: { id: orgId },
      membership: { role: user.orgRole },
    } as unknown as Parameters<typeof basesCallerFromConsoleWorkspace>[0],
    randomUUID(),
  );
}

function cliCaller(user: TestUser): BasesCaller {
  return basesCallerFromCliAuth(
    {
      user: { id: user.id, primaryEmail: user.email },
      organization: { id: orgId },
      membership: { role: user.orgRole },
      localInstallation: { id: installationId },
      ...cliSession(user.id),
    } as unknown as Parameters<typeof basesCallerFromCliAuth>[0],
    randomUUID(),
  );
}

let keySeq = 0;
const idem = () => `rev-${suffix}-${(keySeq += 1)}`;

async function call(caller: BasesCaller, method: string, path: string, body: unknown = {}): Promise<Res> {
  try {
    const result = await handleBasesRequest({
      caller,
      workspace: null,
      method,
      projectRef: project.slug,
      segments: path.split("/").filter(Boolean),
      body,
      searchParams: new URLSearchParams(),
      idempotencyKey: null,
    });
    return { status: result.status, body: JSON.parse(JSON.stringify(result.payload)) };
  } catch (error) {
    if (error instanceof ConsoleApiError) return { status: error.status, body: error.payload };
    throw error;
  }
}

function expectError(res: Res, status: number, error?: string) {
  if (res.status !== status || (error && res.body?.error !== error)) {
    throw new Error(`expected ${status} ${error ?? ""}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

function expectOk(res: Res, status = 200) {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const as = {
  owner: () => consoleCaller(owner),
  a: () => consoleCaller(viewerA),
};

async function createBase(slug: string, properties: unknown[]) {
  return expectOk(await call(as.owner(), "POST", "", { slug, name: slug, properties }), 201);
}

async function createView(slug: string, body: Record<string, unknown>) {
  return expectOk(await call(as.owner(), "POST", `${slug}/views`, body), 201);
}

async function createRow(slug: string, values: Record<string, unknown>) {
  return expectOk(await call(as.owner(), "POST", `${slug}/rows`, { values, idempotencyKey: idem() }), 201).row;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb("bases review regressions (db)", () => {
  const raw = postgres(url ?? "postgres://invalid", { max: 1 });

  beforeAll(async () => {
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([{ id: orgId, slug: `bases-rev-${suffix}`, name: "Bases review test" }]);
    await db.insert(schema.organizationMemberships).values(USERS.map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })));
    await db.insert(schema.projects).values([{ id: project.id, organizationId: orgId, slug: project.slug, name: "Review" }]);
    await db.insert(schema.projectMemberships).values([
      { projectId: project.id, userId: viewerA.id, role: "viewer" },
      { projectId: project.id, userId: viewerB.id, role: "viewer" },
    ]);
    await db.insert(schema.localInstallations).values([{ id: installationId, organizationId: orgId, userId: subscriber.id, name: "sub laptop" }]);
    cliSession = await basesCliFixture(orgId, installationId, [subscriber.id]);
    policyFixture = await basesPolicyFixture(orgId, owner.id, [{ projectId: project.id, managers: [owner.id, subscriber.id],
      readers: [viewerA.id, viewerB.id, leaver.id], viewWriters: [viewerA.id, viewerB.id], installations: [installationId] }]);
  });

  afterAll(async () => {
    await raw.end();
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  // -------------------------------------------------------------------------
  // View writes lock the row before the filter check

  async function lockedRace(label: string, access: Record<string, unknown>, request: (rowId: string, viewId: string, slug: string) => Promise<Res>) {
    const slug = `race-${label}`;
    await createBase(slug, [
      { key: "name", name: "Name", type: "text" },
      { key: "stage", name: "Stage", type: "text" },
      { key: "secret", name: "Secret", type: "text" },
    ]);
    const view = await createView(slug, {
      name: "Leads",
      columns: ["name", "stage", "secret"],
      query: { filter: { prop: "stage", op: "eq", value: "Lead" }, sort: [] },
      access: { read: [{ kind: "user", userId: viewerA.id }], write: { principals: [{ kind: "user", userId: viewerA.id }], columns: ["name"], ...access } },
    });
    const row = await createRow(slug, { name: "a", stage: "Lead" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locked = raw.begin(async (tx) => {
      await tx`SELECT id FROM base_rows WHERE id = ${row.rowId}::uuid FOR UPDATE`;
      await tx`UPDATE base_rows
               SET values_json = values_json
                 || jsonb_build_object((SELECT id::text FROM base_properties WHERE base_id = base_rows.base_id AND key = 'stage'), 'Private'::text)
                 || jsonb_build_object((SELECT id::text FROM base_properties WHERE base_id = base_rows.base_id AND key = 'secret'), 'TOP-SECRET'::text),
                   version = version + 1
               WHERE id = ${row.rowId}::uuid`;
      await held;
    });
    await wait(100);
    const pending = request(row.rowId, view.id, slug);
    await wait(250);
    release();
    await locked;
    const result = await pending;
    const [after] = await db.select().from(schema.baseRows).where(eq(schema.baseRows.id, row.rowId));
    return { result, after, row };
  }

  test("a view update that races a move out of the view is not_found, never version_conflict", async () => {
    const { result, after } = await lockedRace("stale", {}, (rowId, viewId, slug) =>
      call(as.a(), "PATCH", `${slug}/views/${viewId}/rows/${rowId}`, { values: { name: "b" }, expectedVersion: 1, idempotencyKey: idem() }),
    );
    expectError(result, 404, "not_found");
    expect(JSON.stringify(result.body)).not.toContain("TOP-SECRET");
    expect(after?.version).toBe(2);
  });

  test("lastWriteWins with allowEscape cannot write a row that left the view while locked", async () => {
    const { result, after } = await lockedRace("lww", { allowEscape: true }, (rowId, viewId, slug) =>
      call(as.a(), "PATCH", `${slug}/views/${viewId}/rows/${rowId}`, { values: { name: "hijack" }, lastWriteWins: true, idempotencyKey: idem() }),
    );
    expectError(result, 404, "not_found");
    expect(after?.version).toBe(2);
    expect(JSON.stringify(after?.valuesJson)).not.toContain("hijack");
  });

  test("a view archive that races a move out of the view is not_found and archives nothing", async () => {
    const { result, after } = await lockedRace("archive", { archive: true }, (rowId, viewId, slug) =>
      call(as.a(), "POST", `${slug}/views/${viewId}/rows/${rowId}/archive`, { lastWriteWins: true }),
    );
    expectError(result, 404, "not_found");
    expect(after?.archivedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Replays through a view

  test("replays through a view return ids only once the row leaves the view or is archived", async () => {
    const slug = "replay";
    await createBase(slug, [
      { key: "name", name: "Name", type: "text" },
      { key: "stage", name: "Stage", type: "text" },
      { key: "notes", name: "Notes", type: "text" },
    ]);
    const view = await createView(slug, {
      name: "Form",
      columns: ["name", "stage", "notes"],
      query: { filter: { prop: "stage", op: "eq", value: "Lead" }, sort: [] },
      access: {
        read: [{ kind: "user", userId: viewerA.id }],
        write: { principals: [{ kind: "user", userId: viewerA.id }], columns: ["name", "stage"], create: true },
      },
    });
    const key = idem();
    const createBody = { values: { name: "x", stage: "Lead" }, idempotencyKey: key };
    const first = expectOk(await call(as.a(), "POST", `${slug}/views/${view.id}/rows`, createBody), 201);
    const rowId = first.row.rowId;

    const visible = expectOk(await call(as.a(), "POST", `${slug}/views/${view.id}/rows`, createBody), 200);
    expect(visible).toMatchObject({ idempotentReplay: true, row: { rowId, version: 1, values: { name: "x", stage: "Lead" } } });

    const updateKey = idem();
    const updateBody = { values: { name: "y" }, expectedVersion: 1, idempotencyKey: updateKey };
    expectOk(await call(as.a(), "PATCH", `${slug}/views/${view.id}/rows/${rowId}`, updateBody));

    expectOk(await call(as.owner(), "PATCH", `${slug}/rows/${rowId}`, { values: { stage: "Disqualified", notes: "internal: fraud" }, lastWriteWins: true, idempotencyKey: idem() }));
    expectError(await call(as.a(), "GET", `${slug}/views/${view.id}/rows/${rowId}`), 404, "not_found");

    const moved = expectOk(await call(as.a(), "POST", `${slug}/views/${view.id}/rows`, createBody), 200);
    expect(moved).toEqual({ row: { rowId, version: 1, values: {} }, users: {}, idempotentReplay: true });
    const movedUpdate = expectOk(await call(as.a(), "PATCH", `${slug}/views/${view.id}/rows/${rowId}`, updateBody));
    expect(movedUpdate).toEqual({ row: { rowId, version: 2, values: {} }, users: {}, idempotentReplay: true });

    expectOk(await call(as.owner(), "PATCH", `${slug}/rows/${rowId}`, { values: { stage: "Lead" }, lastWriteWins: true, idempotencyKey: idem() }));
    expectOk(await call(as.owner(), "POST", `${slug}/rows/${rowId}/archive`, { lastWriteWins: true }));
    const archived = expectOk(await call(as.a(), "POST", `${slug}/views/${view.id}/rows`, createBody), 200);
    expect(archived.row).toEqual({ rowId, version: 1, values: {} });
    expect(JSON.stringify(archived)).not.toContain("fraud");

    // Direct replays (managers) still re-read the row.
    const directKey = idem();
    const direct = expectOk(await call(as.owner(), "POST", `${slug}/rows`, { values: { name: "d" }, idempotencyKey: directKey }), 201);
    expectOk(await call(as.owner(), "PATCH", `${slug}/rows/${direct.row.rowId}`, { values: { name: "d2" }, expectedVersion: 1, idempotencyKey: idem() }));
    const directReplay = expectOk(await call(as.owner(), "POST", `${slug}/rows`, { values: { name: "d" }, idempotencyKey: directKey }), 200);
    expect(directReplay.row).toMatchObject({ rowId: direct.row.rowId, version: 2, values: { name: "d2" } });
  });

  // -------------------------------------------------------------------------
  // History, view_invalid, required properties, and charts through views

  test("history through a view hides actors and times the view does not project", async () => {
    const slug = "hist";
    await createBase(slug, [
      { key: "name", name: "Name", type: "text" },
      { key: "salary", name: "Salary", type: "number" },
    ]);
    const read = [{ kind: "project_role", minRole: "viewer" }];
    const plain = await createView(slug, { name: "Plain", columns: ["name"], access: { read } });
    const created = await createView(slug, { name: "Created", columns: ["name", "created_by", "created_time"], access: { read } });
    const full = await createView(slug, { name: "Full", columns: ["name", "updated_by", "updated_time"], access: { read } });
    const row = await createRow(slug, { name: "r", salary: 1 });
    expectOk(await call(as.owner(), "PATCH", `${slug}/rows/${row.rowId}`, { values: { name: "r2", salary: 2 }, expectedVersion: 1, idempotencyKey: idem() }));

    const hidden = expectOk(await call(as.a(), "GET", `${slug}/views/${plain.id}/rows/${row.rowId}/history`));
    expect(hidden.entries.map((entry: J) => entry.action)).toEqual(["updated", "created"]);
    for (const entry of hidden.entries) expect(entry).toMatchObject({ actorType: null, actorId: null, surface: null, createdAt: null });
    expect(hidden.users).toEqual({});

    const partly = expectOk(await call(as.a(), "GET", `${slug}/views/${created.id}/rows/${row.rowId}/history`));
    const [updatedEntry, createdEntry] = partly.entries;
    expect(updatedEntry).toMatchObject({ actorId: null, createdAt: null });
    expect(createdEntry).toMatchObject({ actorType: "user", actorId: owner.id, surface: "console" });
    expect(createdEntry.createdAt).toBeString();
    expect(Object.keys(partly.users)).toEqual([owner.id]);

    const shown = expectOk(await call(as.a(), "GET", `${slug}/views/${full.id}/rows/${row.rowId}/history`));
    for (const entry of shown.entries) {
      expect(entry.actorId).toBe(owner.id);
      expect(entry.createdAt).toBeString();
    }

    const manager = expectOk(await call(as.owner(), "GET", `${slug}/views/${plain.id}/rows/${row.rowId}/history`));
    for (const entry of manager.entries) expect(entry.actorId).toBe(owner.id);
  });

  test("view_invalid reasons name hidden properties only for managers", async () => {
    const slug = "invalid";
    const base = await createBase(slug, [
      { key: "name", name: "Name", type: "text" },
      { key: "salary", name: "Salary", type: "number" },
    ]);
    const view = await createView(slug, {
      name: "Policy",
      columns: ["name"],
      query: { filter: { not: { prop: "salary", op: "lt", value: 0 } }, sort: [] },
      access: { read: [{ kind: "project_role", minRole: "viewer" }] },
    });
    expectOk(await call(as.owner(), "POST", `${slug}/properties/salary/delete`, { expectedSchemaVersion: base.schemaVersion, confirm: true }));
    const viewer = expectError(await call(as.a(), "POST", `${slug}/views/${view.id}/query`, {}), 409, "view_invalid");
    expect(viewer.reason).toBe(VIEW_INVALID_PUBLIC_REASON);
    expect(JSON.stringify(viewer)).not.toContain("salary");
    const manager = expectError(await call(as.owner(), "POST", `${slug}/views/${view.id}/query`, {}), 409, "view_invalid");
    expect(manager.reason).toContain("salary");
  });

  test("a property made required after a form was saved makes the form view_invalid without naming it", async () => {
    const slug = "required";
    const base = await createBase(slug, [
      { key: "name", name: "Name", type: "text" },
      { key: "level", name: "Level", type: "text" },
    ]);
    const form = await createView(slug, {
      name: "Form",
      columns: ["name"],
      layout: { type: "form" },
      access: { read: [], write: { principals: [{ kind: "project_role", minRole: "viewer" }], columns: ["name"], create: true, allowEscape: true } },
    });
    expectOk(await call(as.owner(), "PATCH", `${slug}/properties/level`, { expectedSchemaVersion: base.schemaVersion, required: true }));
    const viewer = expectError(await call(as.a(), "POST", `${slug}/views/${form.id}/rows`, { values: { name: "x" }, idempotencyKey: idem() }), 409, "view_invalid");
    expect(viewer.reason).toBe(VIEW_INVALID_PUBLIC_REASON);
    expect(JSON.stringify(viewer)).not.toContain("level");
    const manager = expectError(await call(as.owner(), "POST", `${slug}/views/${form.id}/rows`, { values: { name: "x" }, idempotencyKey: idem() }), 409, "view_invalid");
    expect(manager.reason).toContain("level");
    const direct = expectError(await call(as.owner(), "POST", `${slug}/rows`, { values: { name: "x" }, idempotencyKey: idem() }), 400, "validation_failed");
    expect(direct.fieldErrors.level).toBeString();
  });

  // -------------------------------------------------------------------------
  // Writers without row read

  test("writers without row read get ids and version only, also in version_conflict current", async () => {
    const slug = "write-only";
    await createBase(slug, [
      { key: "name", name: "Name", type: "text" },
      { key: "email", name: "Email", type: "email" },
      { key: "salary", name: "Salary", type: "number" },
    ]);
    const writer = { principals: [{ kind: "user", userId: viewerA.id }] };
    const intake = await createView(slug, {
      name: "Intake",
      columns: ["name", "email", "salary"],
      layout: { type: "form" },
      access: { read: [], write: { ...writer, columns: ["name", "email", "salary"], create: true } },
    });
    const archiver = await createView(slug, {
      name: "Archiver",
      columns: ["name", "email", "salary"],
      access: { read: [], write: { ...writer, columns: [], archive: true } },
    });
    const other = await createRow(slug, { name: "Other person", email: "victim@example.com", salary: 123456 });
    const leaks = (body: J) => JSON.stringify(body).includes("victim") || JSON.stringify(body).includes("123456");

    const created = expectOk(await call(as.a(), "POST", `${slug}/views/${intake.id}/rows`, { values: { name: "Mine", salary: 1 }, idempotencyKey: idem() }), 201);
    expect(created.row.values).toEqual({});

    const stale = expectError(
      await call(as.a(), "PATCH", `${slug}/views/${intake.id}/rows/${other.rowId}`, { values: {}, expectedVersion: 999, idempotencyKey: idem() }),
      409,
      "version_conflict",
    );
    expect(stale.current).toEqual({ rowId: other.rowId, version: 1, values: {} });
    const noop = expectOk(
      await call(as.a(), "PATCH", `${slug}/views/${intake.id}/rows/${other.rowId}`, { values: {}, expectedVersion: 1, idempotencyKey: idem() }),
    );
    expect(noop.row).toEqual({ rowId: other.rowId, version: 1, values: {} });
    const staleArchive = expectError(
      await call(as.a(), "POST", `${slug}/views/${archiver.id}/rows/${other.rowId}/archive`, { expectedVersion: 999 }),
      409,
      "version_conflict",
    );
    expect(staleArchive.current).toEqual({ rowId: other.rowId, version: 1, values: {} });
    for (const body of [created, stale, noop, staleArchive]) expect(leaks(body)).toBe(false);
    expectError(await call(as.a(), "GET", `${slug}/views/${intake.id}/rows/${other.rowId}`), 403, "base_forbidden");
    const [after] = await db.select().from(schema.baseRows).where(eq(schema.baseRows.id, other.rowId));
    expect(after).toMatchObject({ version: 1, archivedAt: null });

    const chart = expectOk(
      await call(as.owner(), "POST", `${slug}/charts`, {
        viewId: intake.id,
        name: "Count",
        spec: { mark: "text", encoding: { text: { aggregate: "count", type: "quantitative" } } },
      }),
      201,
    );
    expectError(await call(as.a(), "POST", `${slug}/charts/${chart.id}/data`, {}), 403, "base_forbidden");
    expectError(await call(consoleCaller(viewerB), "POST", `${slug}/charts/${chart.id}/data`, {}), 404, "not_found");
  });

  test("rows.get never returns the values of a row that left the view between the filter match and the read", async () => {
    const slug = "get-race";
    await createBase(slug, [
      { key: "name", name: "Name", type: "text" },
      { key: "public", name: "Public", type: "checkbox" },
      { key: "amount", name: "Amount", type: "number" },
    ]);
    const view = await createView(slug, {
      name: "Public deals",
      columns: ["name", "amount"],
      query: { filter: { prop: "public", op: "eq", value: true }, sort: [] },
      access: { read: [{ kind: "user", userId: viewerA.id }] },
    });
    const row = await createRow(slug, { name: "Acme", public: true, amount: 1 });
    const original = repository.findRowRecord;
    const spy = spyOn(repository, "findRowRecord").mockImplementation(async (...args: Parameters<typeof original>) => {
      await raw`UPDATE base_rows
                SET values_json = values_json
                  || jsonb_build_object((SELECT id::text FROM base_properties WHERE base_id = base_rows.base_id AND key = 'public'), false)
                  || jsonb_build_object((SELECT id::text FROM base_properties WHERE base_id = base_rows.base_id AND key = 'amount'), 999999),
                    version = version + 1
                WHERE id = ${row.rowId}::uuid`;
      return original(...args);
    });
    try {
      const result = await call(as.a(), "GET", `${slug}/views/${view.id}/rows/${row.rowId}`);
      expect(spy).toHaveBeenCalled();
      if (result.status === 200) expect(result.body.row).toMatchObject({ version: 1, values: { name: "Acme", amount: 1 } });
      else expectError(result, 404, "not_found");
      expect(JSON.stringify(result.body)).not.toContain("999999");
    } finally {
      spy.mockRestore();
    }
    expectError(await call(as.a(), "GET", `${slug}/views/${view.id}/rows/${row.rowId}`), 404, "not_found");
  });

  test("a person preset naming a former member is view_invalid, never a field error on the preset key", async () => {
    const slug = "preset-member";
    await createBase(slug, [
      { key: "name", name: "Name", type: "text" },
      { key: "assignee", name: "Assignee", type: "person" },
    ]);
    const form = await createView(slug, {
      name: "Routed",
      columns: ["name", "assignee"],
      layout: { type: "form" },
      access: {
        read: [],
        write: { principals: [{ kind: "user", userId: viewerA.id }], columns: ["name"], create: true, allowEscape: true, set: { assignee: [leaver.id] } },
      },
    });
    expectOk(await call(as.a(), "POST", `${slug}/views/${form.id}/rows`, { values: { name: "before" }, idempotencyKey: idem() }), 201);
    await db
      .update(schema.organizationMemberships)
      .set({ status: "removed" })
      .where(and(eq(schema.organizationMemberships.organizationId, orgId), eq(schema.organizationMemberships.userId, leaver.id)));
    const viewer = expectError(await call(as.a(), "POST", `${slug}/views/${form.id}/rows`, { values: { name: "after" }, idempotencyKey: idem() }), 409, "view_invalid");
    expect(viewer.reason).toBe(VIEW_INVALID_PUBLIC_REASON);
    expect(viewer.fieldErrors).toBeUndefined();
    expect(JSON.stringify(viewer)).not.toContain("assignee");
    const manager = expectError(await call(as.owner(), "POST", `${slug}/views/${form.id}/rows`, { values: { name: "after" }, idempotencyKey: idem() }), 409, "view_invalid");
    expect(manager.reason).toContain("assignee");
    const overridden = expectOk(
      await call(as.owner(), "POST", `${slug}/views/${form.id}/rows`, { values: { name: "after", assignee: [subscriber.id] }, idempotencyKey: idem() }),
      201,
    );
    expect(overridden.row.values.assignee).toEqual([subscriber.id]);
  });

  test("archived options already stored on a row can be resent with the rest of a multi_select", async () => {
    const slug = "archived-option";
    const base = await createBase(slug, [{ key: "tags", name: "Tags", type: "multi_select", config: { options: [{ name: "A" }, { name: "B" }, { name: "Legacy" }] } }]);
    const options = base.properties[0].config.options as Array<{ id: string; name: string }>;
    const id = (name: string) => options.find((option) => option.name === name)!.id;
    const row = await createRow(slug, { tags: [id("A"), id("Legacy")] });
    expectOk(
      await call(as.owner(), "PATCH", `${slug}/properties/tags`, {
        expectedSchemaVersion: base.schemaVersion,
        config: { options: options.map((option) => (option.name === "Legacy" ? { ...option, archived: true } : option)) },
      }),
    );
    const updated = expectOk(
      await call(as.owner(), "PATCH", `${slug}/rows/${row.rowId}`, { values: { tags: [id("A"), id("B"), id("Legacy")] }, expectedVersion: 1, idempotencyKey: idem() }),
    );
    expect(updated.row.values.tags).toEqual([id("A"), id("B"), id("Legacy")]);
    const fresh = await createRow(slug, { tags: [id("A")] });
    const rejected = expectError(
      await call(as.owner(), "PATCH", `${slug}/rows/${fresh.rowId}`, { values: { tags: [id("A"), id("Legacy")] }, expectedVersion: 1, idempotencyKey: idem() }),
      400,
      "validation_failed",
    );
    expect(rejected.fieldErrors.tags).toContain("archived");
  });

  test("options re-sent by name keep their ids, so name filters still match existing rows", async () => {
    const slug = "options-by-name";
    const base = await createBase(slug, [{ key: "stage", name: "Stage", type: "select", config: { options: [{ name: "Lead" }, { name: "Won" }] } }]);
    const before = base.properties[0].config.options as Array<{ id: string; name: string; archived?: boolean }>;
    const row = await createRow(slug, { stage: "Won" });
    const updated = expectOk(
      await call(as.owner(), "PATCH", `${slug}/properties/stage`, {
        expectedSchemaVersion: base.schemaVersion,
        config: { options: [{ name: "Lead" }, { name: "won" }, { name: "Lost" }] },
      }),
    );
    const after = updated.property.config.options as Array<{ id: string; name: string; archived?: boolean }>;
    expect(after.slice(0, 2).map((option) => option.id)).toEqual(before.map((option) => option.id));
    expect(after.filter((option) => option.archived)).toEqual([]);
    const result = expectOk(await call(as.owner(), "POST", `${slug}/rows/query`, { filter: { prop: "stage", op: "eq", value: "Won" } }));
    expect(result.rows.map((r: J) => r.rowId)).toEqual([row.rowId]);
  });

  test("public chart specs drop fields that are no longer view columns", async () => {
    const slug = "charts";
    await createBase(slug, [
      { key: "name", name: "Name", type: "text" },
      { key: "salary", name: "Salary", type: "number" },
      { key: "level", name: "Level", type: "select", config: { options: [{ name: "L1" }, { name: "L2" }] } },
    ]);
    const view = await createView(slug, {
      name: "Shared",
      columns: ["name", "salary", "level"],
      access: { read: [{ kind: "project_role", minRole: "viewer" }] },
    });
    const chart = expectOk(
      await call(as.owner(), "POST", `${slug}/charts`, {
        viewId: view.id,
        name: "Pay",
        spec: { mark: "bar", encoding: { x: { field: "level", type: "nominal" }, y: { field: "salary", aggregate: "sum", type: "quantitative" } } },
      }),
      201,
    );
    const before = expectOk(await call(as.a(), "GET", `${slug}/charts/${chart.id}`));
    expect(before.spec.encoding).toEqual({ x: { field: "level", type: "nominal" }, y: { field: "salary", aggregate: "sum", type: "quantitative" } });

    expectOk(await call(as.owner(), "PATCH", `${slug}/views/${view.id}`, { expectedVersion: view.version, columns: ["name"] }));
    const listed = expectOk(await call(as.a(), "GET", `${slug}/charts`));
    const single = expectOk(await call(as.a(), "GET", `${slug}/charts/${chart.id}`));
    for (const payload of [listed, single]) {
      expect(JSON.stringify(payload)).not.toContain("salary");
      expect(JSON.stringify(payload)).not.toContain("level");
    }
    expect(single.spec.encoding).toEqual({ x: { type: "nominal" }, y: { aggregate: "sum", type: "quantitative" } });
    expectError(await call(as.a(), "POST", `${slug}/charts/${chart.id}/data`, {}), 409, "view_invalid");
    const manager = expectOk(await call(as.owner(), "GET", `${slug}/charts/${chart.id}`));
    expect(manager.spec.encoding.y.field).toBe("salary");
  });

  // -------------------------------------------------------------------------
  // Migrations and events

  const inboxItems = () =>
    db
      .select()
      .from(schema.agentInboxItems)
      .where(and(eq(schema.agentInboxItems.organizationId, orgId), eq(schema.agentInboxItems.targetId, installationId)));

  test("type migrations append ledger entries, attribution, and events for migrated rows", async () => {
    const slug = "migrate";
    const base = await createBase(slug, [{ key: "n", name: "N", type: "text" }]);
    expectOk(await call(cliCaller(subscriber), "POST", `${slug}/subscriptions`, {}), 201);
    const active = await createRow(slug, { n: "12" });
    const archived = await createRow(slug, { n: "abc" });
    expectOk(await call(as.owner(), "POST", `${slug}/rows/${archived.rowId}/archive`, { expectedVersion: 1 }));
    const [beforeRow] = await db.select().from(schema.baseRows).where(eq(schema.baseRows.id, active.rowId));
    const itemsBefore = (await inboxItems()).length;
    await wait(5);

    const migrated = expectOk(await call(consoleCaller(subscriber), "PATCH", `${slug}/properties/n`, { expectedSchemaVersion: base.schemaVersion, type: "number", confirm: true }));
    expect(migrated.report).toMatchObject({ dryRun: false, converted: 1 });

    const row = expectOk(await call(as.owner(), "GET", `${slug}/rows/${active.rowId}`)).row;
    expect(row).toMatchObject({ version: 2, values: { n: 12, updated_by: subscriber.id } });
    expect(Date.parse(row.values.updated_time)).toBeGreaterThan(beforeRow!.updatedAt.getTime());
    const history = expectOk(await call(as.owner(), "GET", `${slug}/rows/${active.rowId}/history`));
    expect(history.entries.map((entry: J) => `${entry.version}:${entry.action}`)).toEqual(["2:updated", "1:created"]);
    expect(history.entries[0]).toMatchObject({ changedKeys: ["n"], before: { n: "12" }, after: { n: 12 }, actorId: subscriber.id });

    const archivedHistory = expectOk(await call(as.owner(), "GET", `${slug}/rows/${archived.rowId}/history`));
    expect(archivedHistory.entries[0]).toMatchObject({ version: 3, action: "updated", changedKeys: ["n"], after: {} });

    const items = (await inboxItems()).slice(itemsBefore);
    expect(items.map((item) => [item.eventType, item.sourceId])).toEqual([["bases.row.updated", active.rowId]]);
    expect(items[0]?.payloadJson).toMatchObject({ rowId: active.rowId, version: 2, changedPropertyCount: 1 });
  });

  test("a multi_select to select migration reports the rows that keep only their first option as truncated", async () => {
    const slug = "truncate";
    const base = await createBase(slug, [
      { key: "tags", name: "Tags", type: "multi_select", config: { options: [{ name: "A" }, { name: "B" }, { name: "C" }] } },
    ]);
    const options = base.properties[0].config.options as Array<{ id: string; name: string }>;
    const id = (name: string) => options.find((option) => option.name === name)!.id;
    const many = await createRow(slug, { tags: [id("B"), id("A"), id("C")] });
    const one = await createRow(slug, { tags: [id("C")] });
    await createRow(slug, {});
    const archived = await createRow(slug, { tags: [id("A"), id("B")] });
    expectOk(await call(as.owner(), "POST", `${slug}/rows/${archived.rowId}/archive`, { expectedVersion: 1 }));

    const body = { expectedSchemaVersion: base.schemaVersion, type: "select" };
    const expected = { activeRows: 3, converted: 2, truncated: 1, cleared: 0, missing: 1 };
    const dryRun = expectOk(await call(as.owner(), "PATCH", `${slug}/properties/tags`, body));
    expect(dryRun.report).toMatchObject({ dryRun: true, ...expected });
    const migrated = expectOk(await call(as.owner(), "PATCH", `${slug}/properties/tags`, { ...body, confirm: true }));
    expect(migrated.report).toMatchObject({ dryRun: false, ...expected });

    expect(expectOk(await call(as.owner(), "GET", `${slug}/rows/${many.rowId}`)).row.values.tags).toBe(id("B"));
    expect(expectOk(await call(as.owner(), "GET", `${slug}/rows/${one.rowId}`)).row.values.tags).toBe(id("C"));
    const [audit] = await db
      .select({ metadata: schema.auditEvents.metadataJson })
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, "bases.property.migrated"), eq(schema.auditEvents.targetId, base.properties[0].id)));
    expect(audit?.metadata).toMatchObject({ fromType: "multi_select", toType: "select", converted: 2, truncated: 1, cleared: 0 });
  });

  test("subscribers who lose base.manage stop receiving row events", async () => {
    const slug = "notify";
    await createBase(slug, []);
    expectOk(await call(cliCaller(subscriber), "POST", `${slug}/subscriptions`, {}), 201);
    const count = async () => (await inboxItems()).length;
    const membership = and(eq(schema.organizationMemberships.organizationId, orgId), eq(schema.organizationMemberships.userId, subscriber.id));
    try {
      let before = await count();
      await createRow(slug, {});
      expect(await count()).toBe(before + 1);

      await db.update(schema.organizationMemberships).set({ role: "viewer" }).where(membership);
      const managers = policyFixture.document.rules.find(rule => rule.id === "managers-0")!;
      // The earlier former-member test intentionally removed this identity.
      // A new publication must not reassign an inactive member; leave the
      // published historical revision intact and explicitly drop that grant.
      for (const rule of policyFixture.document.rules)
        rule.principals = rule.principals.filter(p => p.kind !== "user" || p.id !== leaver.id);
      managers.principals = managers.principals.filter(p => p.kind !== "user" || p.id !== subscriber.id);
      await policyFixture.publish();
      before = await count();
      await createRow(slug, {});
      expect(await count()).toBe(before);

      await db.insert(schema.projectMemberships).values({ projectId: project.id, userId: subscriber.id, role: "viewer" });
      await createRow(slug, {});
      expect(await count()).toBe(before);

      await db
        .update(schema.projectMemberships)
        .set({ role: "developer" })
        .where(and(eq(schema.projectMemberships.projectId, project.id), eq(schema.projectMemberships.userId, subscriber.id)));
      // A role rename alone grants nothing; restore only by publishing an
      // explicit action grant through the real draft/preview/publish flow.
      managers.principals.push({ kind: "user", id: subscriber.id });
      await policyFixture.publish();
      await createRow(slug, {});
      expect(await count()).toBe(before + 1);
    } finally {
      await db.update(schema.organizationMemberships).set({ role: "developer" }).where(membership);
      await db
        .delete(schema.projectMemberships)
        .where(and(eq(schema.projectMemberships.projectId, project.id), eq(schema.projectMemberships.userId, subscriber.id)));
    }
  });

  // -------------------------------------------------------------------------
  // Input that Postgres cannot store, date sentinels, limits, timeouts

  test("NUL characters are 4xx, never 500", async () => {
    const slug = "nul";
    await createBase(slug, [{ key: "name", name: "Name", type: "text" }]);
    const value = expectError(await call(as.owner(), "POST", `${slug}/rows`, { values: { name: "a\u0000b" }, idempotencyKey: idem() }), 400, "validation_failed");
    expect(value.fieldErrors.name).toBeString();
    const body = expectError(await call(as.owner(), "POST", `${slug}/rows`, { values: { name: "ok" }, body: "x\u0000y", idempotencyKey: idem() }), 400, "validation_failed");
    expect(body.fieldErrors.body).toBeString();
    expectError(await call(as.owner(), "POST", `${slug}/rows/query`, { filter: { prop: "name", op: "contains", value: "a\u0000" } }), 400, "invalid_filter");
    expectError(await call(as.owner(), "POST", "", { slug: "nul-name", name: "a\u0000b" }), 400, "payload_invalid");
    expectError(await call(as.owner(), "GET", "a\u0000b"), 400, "payload_invalid");
  });

  test("filters with the 9999-12-31 sentinel compile and match", async () => {
    const slug = "sentinel";
    await createBase(slug, [
      { key: "name", name: "Name", type: "text" },
      { key: "due", name: "Due", type: "date", config: { includeTime: true } },
    ]);
    const row = await createRow(slug, { name: "x", due: "2030-01-01T10:00:00Z" });
    for (const filter of [
      { prop: "due", op: "on_or_before", value: "9999-12-31" },
      { prop: "due", op: "between", value: ["2020-01-01", "9999-12-31"] },
      { prop: "created_time", op: "before", value: "9999-12-31" },
      { prop: "updated_time", op: "on_or_before", value: "9999-12-31" },
    ]) {
      const result = expectOk(await call(as.owner(), "POST", `${slug}/rows/query`, { filter }));
      expect(result.rows.map((r: J) => r.rowId)).toEqual([row.rowId]);
    }
    const after = expectOk(await call(as.owner(), "POST", `${slug}/rows/query`, { filter: { prop: "due", op: "after", value: "9999-12-31" } }));
    expect(after.rows).toEqual([]);
  });

  test("concurrent creates cannot exceed the active-row cap", async () => {
    const slug = "cap";
    await createBase(slug, [{ key: "name", name: "Name", type: "text" }]);
    const limits = BASES_LIMITS as { rowsPerBase: number };
    const original = limits.rowsPerBase;
    limits.rowsPerBase = 3;
    try {
      const batch = () => call(as.owner(), "POST", `${slug}/rows`, { rows: [{ values: { name: "a" } }, { values: { name: "b" } }], idempotencyKey: idem() });
      const results = await Promise.all([batch(), batch()]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
      expect(results.find((result) => result.status === 409)?.body.error).toBe("limit_exceeded");
      const [baseRecord] = await db.select().from(schema.bases).where(and(eq(schema.bases.projectId, project.id), eq(schema.bases.slug, slug)));
      const active = await db
        .select({ id: schema.baseRows.id })
        .from(schema.baseRows)
        .where(and(eq(schema.baseRows.baseId, baseRecord!.id), isNull(schema.baseRows.archivedAt)));
      expect(active).toHaveLength(2);
    } finally {
      limits.rowsPerBase = original;
    }
  });

  test("statement timeouts are 503 query_timeout", async () => {
    let error: unknown;
    try {
      await runBasesRead(10, (tx) => tx.execute(sql`SELECT pg_sleep(1)`));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConsoleApiError);
    expect((error as ConsoleApiError).status).toBe(503);
    expect((error as ConsoleApiError).payload.error).toBe("query_timeout");
  });
});
