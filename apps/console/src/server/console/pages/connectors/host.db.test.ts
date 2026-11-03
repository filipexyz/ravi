import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { basesCallerFromConsoleWorkspace, handleBasesRequest } from "@/server/console/bases";
import type { PagesPrivateAuthRepository, PagesSessionRecord } from "@/server/console/pages/auth";
import { db, schema } from "@/server/db";
import { basesPolicyFixture } from "../../../../../tests/review/bases-policy-fixture";

import {
  BASES_CHARTS_DATA_ACTION_ID,
  BASES_CONNECTOR_ACTION_IDS,
  BASES_VIEWS_DESCRIBE_ACTION_ID,
  BASES_VIEWS_QUERY_ACTION_ID,
  BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID,
  BASES_VIEWS_ROWS_CREATE_ACTION_ID,
  BASES_VIEWS_ROWS_GET_ACTION_ID,
  BASES_VIEWS_ROWS_UPDATE_ACTION_ID,
  curatedPlatformUsesSnapshot,
  PAGES_THEME_GET_ACTION_ID,
} from "./catalog";
import {
  execPagesConnector,
  getPagesConnectorCatalog,
  pagesConnectorExecErrorBody,
  type PagesConnectorHostDeps,
  type PagesConnectorSite,
} from "./host";

// End-to-end `ravi.bases.*` connector execs against the real Bases services.
// Runs only with BASES_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database; creates and deletes its own fixtures.
const url = process.env.BASES_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

process.env.RAVI_PAGES_AUTH_SESSION_SECRET ??= "test_pages_auth_secret_1234567890";

type J = any;

const SESSION_TOKEN = "sessionabcdefghijklmnopqrstuvwxyz123456";
const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const owner = { id: randomUUID(), email: `bases-conn-${suffix}-owner@example.test` };
const pageViewer = { id: randomUUID(), email: `bases-conn-${suffix}-viewer@example.test` };
const projectA = { id: randomUUID(), slug: `bases-conn-a-${suffix}` };
const projectB = { id: randomUUID(), slug: `bases-conn-b-${suffix}` };
const siteA = { id: randomUUID(), host: `bc-a-${suffix}.ravi.page.test` };
const siteB = { id: randomUUID(), host: `bc-b-${suffix}.ravi.page.test` };
const sessionId = randomUUID();

let membershipRole = "viewer";
let policy: Awaited<ReturnType<typeof basesPolicyFixture>>;

function connectorSite(): PagesConnectorSite {
  return {
    id: siteA.id,
    organizationId: orgId,
    projectId: projectA.id,
    defaultHostname: siteA.host,
    defaultVisibility: "private",
    status: "active",
    activeReleaseId: null,
  };
}

function sessionRecord(overrides: Partial<PagesSessionRecord> = {}): PagesSessionRecord {
  return {
    id: sessionId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    issuedForHost: siteA.host,
    issuedFromClaimCodeId: randomUUID(),
    lastRequestId: null,
    lastUsedAt: null,
    metadataJson: {},
    organizationId: orgId,
    projectId: projectA.id,
    revokedAt: null,
    sessionTokenHash: "hash",
    siteId: siteA.id,
    status: "active",
    updatedAt: new Date(),
    userId: pageViewer.id,
    ...overrides,
  };
}

function authRepository(session: PagesSessionRecord): PagesPrivateAuthRepository {
  return {
    async transaction() { throw new Error("unexpected_issuance"); },
    async assertBrowserSource() { throw new Error("unexpected_issuance"); },
    async findClaimCodeByHash() { return null; },
    async consumeClaimCode() {
      return null;
    },
    async findOrganizationMembership() {
      return { role: membershipRole, status: "active" };
    },
    async findSessionByHash() {
      return session;
    },
    async findSiteByHost() {
      return null;
    },
    async insertAudit() {},
    async insertClaimCode() {
      throw new Error("unexpected_claim_code");
    },
    async insertSession() {
      throw new Error("unexpected_session");
    },
    async markSessionExpired() {},
    async touchSession() {},
  };
}

function deps(session = sessionRecord()): PagesConnectorHostDeps {
  return {
    authRepository: authRepository(session),
    findSiteByHost: async () => connectorSite(),
    insertAudit: async () => {},
    loadUsesSnapshot: async () => ({
      catalogSchemaVersion: 1,
      uses: [...BASES_CONNECTOR_ACTION_IDS].map((id) => ({ id, revision: 1 })),
    }),
  };
}

async function exec(id: string, input: unknown, options: { session?: PagesSessionRecord; origin?: string | null } = {}) {
  try {
    const result = await execPagesConnector(
      {
        host: siteA.host,
        id,
        input,
        origin: "origin" in options ? options.origin : `https://${siteA.host}`,
        pagesSession: SESSION_TOKEN,
        requestId: randomUUID(),
      },
      deps(options.session),
    );
    return { status: 200, body: JSON.parse(JSON.stringify(result.output)) as J };
  } catch (error) {
    // The body the exec route returns.
    if (error instanceof ConsoleApiError) {
      return { status: error.status, body: JSON.parse(JSON.stringify(pagesConnectorExecErrorBody(error))) as J };
    }
    throw error;
  }
}

async function manage(method: string, path: string, body: unknown = {}, projectRef = projectA.slug) {
  const result = await handleBasesRequest({
    caller: basesCallerFromConsoleWorkspace(
      {
        mode: "workos",
        user: { id: owner.id, primaryEmail: owner.email },
        organization: { id: orgId },
        membership: { role: "owner" },
      } as unknown as Parameters<typeof basesCallerFromConsoleWorkspace>[0],
      randomUUID(),
    ),
    workspace: null,
    method,
    projectRef,
    segments: path.split("/").filter(Boolean),
    body,
    searchParams: new URLSearchParams(),
    idempotencyKey: null,
  });
  return JSON.parse(JSON.stringify(result.payload)) as J;
}

describeDb("Pages connector Bases actions (db)", () => {
  const views = {} as { portal: string; form: string; team: string; foreign: string; desk: string };
  let chartId = "";
  let statusIds: Record<string, string> = {};
  let tagIds: Record<string, string> = {};
  const rowIds: string[] = [];

  beforeAll(async () => {
    await db.insert(schema.users).values([
      { id: owner.id, primaryEmail: owner.email, displayName: "Owner" },
      { id: pageViewer.id, primaryEmail: pageViewer.email, displayName: "Viewer" },
    ]);
    await db.insert(schema.organizations).values({ id: orgId, slug: `bases-conn-${suffix}`, name: "Bases connector test" });
    await db.insert(schema.billingAccounts).values({ organizationId: orgId, provider: "manual", planKey: "free" });
    await db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, userId: owner.id, role: "owner" },
      { organizationId: orgId, userId: pageViewer.id, role: "viewer" },
    ]);
    await db.insert(schema.projects).values([
      { id: projectA.id, organizationId: orgId, slug: projectA.slug, name: "Project A" },
      { id: projectB.id, organizationId: orgId, slug: projectB.slug, name: "Project B" },
    ]);
    await db.insert(schema.projectMemberships).values({ projectId: projectA.id, userId: pageViewer.id, role: "viewer" });
    await db.insert(schema.pageSites).values([
      { id: siteA.id, organizationId: orgId, projectId: projectA.id, slug: `bc-a-${suffix}`, defaultHostname: siteA.host },
      { id: siteB.id, organizationId: orgId, projectId: projectB.id, slug: `bc-b-${suffix}`, defaultHostname: siteB.host },
    ]);
    policy = await basesPolicyFixture(orgId, owner.id, [
      { projectId: projectA.id, managers: [owner.id], viewWriters: [pageViewer.id] },
      { projectId: projectB.id, managers: [owner.id] },
    ]);

    const base = await manage("POST", "", {
      slug: "deals",
      name: "Deals",
      properties: [
        { key: "name", name: "Name", type: "text", required: true },
        { key: "status", name: "Status", type: "select", config: { options: [{ name: "Open" }, { name: "Won" }] } },
        { key: "amount", name: "Amount", type: "number" },
        { key: "email", name: "Email", type: "email" },
        { key: "secret", name: "Secret", type: "text" },
        { key: "owner", name: "Owner", type: "person" },
        { key: "tags", name: "Tags", type: "multi_select", config: { options: [{ name: "Enterprise" }, { name: "SMB" }] } },
        { key: "links", name: "Links", type: "ref" },
      ],
    });
    statusIds = Object.fromEntries(
      base.properties.find((property: J) => property.key === "status").config.options.map((option: J) => [option.name, option.id]),
    );
    tagIds = Object.fromEntries(
      base.properties.find((property: J) => property.key === "tags").config.options.map((option: J) => [option.name, option.id]),
    );
    const seeded = await manage("POST", "deals/rows", {
      idempotencyKey: `seed-${suffix}`,
      rows: [
        { values: { name: "Acme", status: "Open", amount: 100, secret: "s1", owner: [owner.id] } },
        { values: { name: "Beta", status: "Won", amount: 200, secret: "s2" } },
        { values: { name: "Gamma", status: "Won", amount: 300 } },
        { values: { name: "Delta", status: "Won", amount: 50 } },
        { values: { name: "Eps", status: "Won", amount: 10 } },
        { values: { name: "Zeta", status: "Won", amount: 5 } },
        { values: { name: "Eta", status: "Open", amount: 1 } },
      ],
    });
    rowIds.push(...seeded.rows.map((row: J) => row.rowId));

    views.portal = (
      await manage("POST", "deals/views", {
        name: "Portal",
        columns: ["name", "status", "amount"],
        query: { filter: { prop: "amount", op: "gte", value: 5 }, sort: [{ prop: "amount", dir: "desc" }] },
        access: {
          read: [{ kind: "page_viewer", siteId: siteA.id }],
          write: { principals: [{ kind: "page_viewer", siteId: siteA.id }], columns: ["status"] },
        },
      })
    ).id;
    views.form = (
      await manage("POST", "deals/views", {
        name: "Intake",
        columns: ["name", "email"],
        layout: { type: "form" },
        access: {
          read: [],
          write: { principals: [{ kind: "page_viewer", siteId: siteA.id }], columns: ["name", "email"], create: true, set: { status: "Open" } },
        },
      })
    ).id;
    views.desk = (
      await manage("POST", "deals/views", {
        name: "Desk",
        columns: ["name", "amount", "owner"],
        query: { filter: { prop: "amount", op: "gte", value: 5 } },
        access: {
          read: [{ kind: "page_viewer", siteId: siteA.id }],
          write: { principals: [{ kind: "page_viewer", siteId: siteA.id }], columns: ["amount"], archive: true },
        },
      })
    ).id;
    views.team = (
      await manage("POST", "deals/views", {
        name: "Team",
        columns: ["name", "secret"],
        access: { read: [{ kind: "project_role", minRole: "viewer" }] },
      })
    ).id;
    chartId = (
      await manage("POST", "deals/charts", {
        viewId: views.portal,
        name: "By status",
        spec: { mark: "bar", encoding: { x: { field: "status", type: "nominal" }, y: { aggregate: "count", type: "quantitative" } } },
      })
    ).id;

    await manage("POST", "", { slug: "other", name: "Other", properties: [{ key: "name", name: "Name", type: "text" }] }, projectB.slug);
    views.foreign = (
      await manage(
        "POST",
        "other/views",
        { name: "B portal", columns: ["name"], access: { read: [{ kind: "page_viewer", siteId: siteB.id }] } },
        projectB.slug,
      )
    ).id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, [owner.id, pageViewer.id]));
  });

  test("describe returns the public shape of a view granted to this site", async () => {
    const res = await exec(BASES_VIEWS_DESCRIBE_ACTION_ID, { viewId: views.portal });
    expect(res.status).toBe(200);
    expect(res.body.columns.map((column: J) => column.key)).toEqual(["name", "status", "amount"]);
    expect(res.body.capabilities).toEqual({ read: true, aggregateOnly: false, writeColumns: ["status"], create: false, archive: false, approve: [] });
    expect(res.body).not.toHaveProperty("view");
    expect(JSON.stringify(res.body)).not.toContain("secret");
    expect(JSON.stringify(res.body)).not.toContain("page_viewer");
  });

  test("query projects rows through the view policy and rejects non-projected columns", async () => {
    const res = await exec(BASES_VIEWS_QUERY_ACTION_ID, { viewId: views.portal, limit: 3 });
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual(["name", "status", "amount"]);
    expect(res.body.rows.map((row: J) => row.values.name)).toEqual(["Gamma", "Beta", "Acme"]);
    expect(Object.keys(res.body.rows[0].values).sort()).toEqual(["amount", "name", "status"]);
    expect(res.body.nextCursor).toBeString();

    const next = await exec(BASES_VIEWS_QUERY_ACTION_ID, { viewId: views.portal, limit: 3, cursor: res.body.nextCursor });
    expect(next.body.rows.map((row: J) => row.values.name)).toEqual(["Delta", "Eps", "Zeta"]);
    expect(next.body.nextCursor).toBeNull();

    const narrowed = await exec(BASES_VIEWS_QUERY_ACTION_ID, { viewId: views.portal, filter: { prop: "status", op: "eq", value: "Open" } });
    expect(narrowed.body.rows.map((row: J) => row.values.name)).toEqual(["Acme"]);

    for (const prop of ["secret", "nope"]) {
      const denied = await exec(BASES_VIEWS_QUERY_ACTION_ID, { viewId: views.portal, filter: { prop, op: "is_empty" } });
      expect(denied).toEqual({ status: 400, body: { error: "unknown_property" } });
    }
    // An unknown operator or a malformed node is invalid_filter, as on the API (Pages get the code only).
    for (const filter of [{ prop: "amount", op: "gtx", value: 1 }, { prop: "amount", op: "gt", value: 1, limit: 2 }, { or: {} }]) {
      expect(await exec(BASES_VIEWS_QUERY_ACTION_ID, { viewId: views.portal, filter })).toEqual({
        status: 400,
        body: { error: "invalid_filter" },
      });
    }
  });

  test("views without a page_viewer grant for this site, and views of another project, are not found", async () => {
    for (const viewId of [views.team, views.foreign, randomUUID()]) {
      expect((await exec(BASES_VIEWS_DESCRIBE_ACTION_ID, { viewId })).status).toBe(404);
      expect((await exec(BASES_VIEWS_QUERY_ACTION_ID, { viewId })).status).toBe(404);
    }
    // The form view admits writes only.
    expect((await exec(BASES_VIEWS_QUERY_ACTION_ID, { viewId: views.form })).status).toBe(403);
  });

  test("create through a form view is idempotent and attributed to the Pages viewer", async () => {
    const input = { viewId: views.form, values: { name: "Lead from page", email: "New@Lead.Example" }, idempotencyKey: `page-form-${suffix}` };
    const created = await exec(BASES_VIEWS_ROWS_CREATE_ACTION_ID, input);
    expect(created.status).toBe(200);
    expect(Object.keys(created.body).sort()).toEqual(["rowId", "version"]);
    expect(created.body.version).toBe(1);

    const replay = await exec(BASES_VIEWS_ROWS_CREATE_ACTION_ID, input);
    expect(replay.body).toEqual(created.body);
    const conflict = await exec(BASES_VIEWS_ROWS_CREATE_ACTION_ID, { ...input, values: { name: "Other" } });
    expect(conflict).toEqual({ status: 409, body: { error: "idempotency_conflict" } });

    const [row] = await db.select().from(schema.baseRows).where(eq(schema.baseRows.id, created.body.rowId));
    expect(row?.createdByActorType).toBe("user");
    expect(row?.createdByActorId).toBe(pageViewer.id);
    const [entry] = await db.select().from(schema.baseRowLedger).where(eq(schema.baseRowLedger.rowId, created.body.rowId));
    expect(entry).toMatchObject({ action: "created", actorType: "user", actorId: pageViewer.id, surface: "page", viewId: views.form });
    const [operation] = await db
      .select()
      .from(schema.baseOperations)
      .where(and(eq(schema.baseOperations.organizationId, orgId), eq(schema.baseOperations.sourceKind, "pages_session")));
    expect(operation?.sourceId).toBe(sessionId);

    expect(
      (await exec(BASES_VIEWS_ROWS_CREATE_ACTION_ID, { ...input, values: { name: "x", status: "Won" }, idempotencyKey: `page-form-b-${suffix}` }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await exec(BASES_VIEWS_ROWS_CREATE_ACTION_ID, { ...input, viewId: views.portal, idempotencyKey: `page-form-c-${suffix}` })).status,
    ).toBe(403);
  });

  test("update through a view checks writable columns, versions, the view filter, and Origin", async () => {
    const target = rowIds[1]!;
    const update = (values: Record<string, unknown>, expectedVersion: number, key: string, origin?: string | null) =>
      exec(
        BASES_VIEWS_ROWS_UPDATE_ACTION_ID,
        { viewId: views.portal, rowId: target, values, expectedVersion, idempotencyKey: `${key}-${suffix}` },
        origin === undefined ? {} : { origin },
      );

    expect(await update({ status: "Open" }, 1, "upd-origin", "https://evil.example")).toEqual({
      status: 401,
      body: { error: "connector_unauthorized" },
    });
    const updated = await update({ status: "Open" }, 1, "upd-ok");
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ rowId: target, version: 2, values: { name: "Beta", status: statusIds.Open, amount: 200 } });

    const stale = await update({ status: "Won" }, 1, "upd-stale");
    expect(stale).toEqual({
      status: 409,
      body: { error: "version_conflict", current: { rowId: target, version: 2, values: { name: "Beta", status: statusIds.Open, amount: 200 } } },
    });
    expect((await update({ name: "Renamed" }, 2, "upd-col")).status).toBeGreaterThanOrEqual(400);
    // Outside the view filter (amount < 5): not found, never a conflict.
    const hidden = await exec(BASES_VIEWS_ROWS_UPDATE_ACTION_ID, {
      viewId: views.portal,
      rowId: rowIds[6]!,
      values: { status: "Won" },
      expectedVersion: 1,
      idempotencyKey: `upd-hidden-${suffix}`,
    });
    expect(hidden).toEqual({ status: 404, body: { error: "not_found" } });
  });

  test("chart data returns aggregated groups only", async () => {
    const res = await exec(BASES_CHARTS_DATA_ACTION_ID, { chartId });
    expect(res.status).toBe(200);
    expect(res.body.chart).toMatchObject({ id: chartId, viewId: views.portal, name: "By status" });
    expect(res.body.groups.length).toBeGreaterThan(0);
    for (const group of res.body.groups) expect(Object.keys(group).sort()).toEqual(["x", "y"]);
    expect(JSON.stringify(res.body)).not.toContain("Acme");
  });

  test("validation_failed fieldErrors reach the exec response, keyed by the submitted keys", async () => {
    const created = await exec(BASES_VIEWS_ROWS_CREATE_ACTION_ID, {
      viewId: views.form,
      values: { name: "Lead", email: "not-an-email" },
      idempotencyKey: `page-form-invalid-${suffix}`,
    });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe("validation_failed");
    expect(Object.keys(created.body).sort()).toEqual(["error", "fieldErrors"]);
    expect(Object.keys(created.body.fieldErrors)).toEqual(["email"]);
    expect(created.body.fieldErrors.email).toBeString();

    // A non-projected column and an unknown key get the same message.
    const updated = await exec(BASES_VIEWS_ROWS_UPDATE_ACTION_ID, {
      viewId: views.portal,
      rowId: rowIds[0]!,
      values: { name: "Renamed", secret: "x", nope: 1 },
      expectedVersion: 1,
      idempotencyKey: `upd-invalid-${suffix}`,
    });
    expect(updated.status).toBe(400);
    expect(updated.body.error).toBe("validation_failed");
    expect(Object.keys(updated.body.fieldErrors).sort()).toEqual(["name", "nope", "secret"]);
    expect(new Set(Object.values(updated.body.fieldErrors)).size).toBe(1);
  });

  test("Pages read a single string for multi_select and person as a one-item array, like the API", async () => {
    const viewId = (
      await manage("POST", "deals/views", {
        name: "Tagger",
        columns: ["name", "tags", "owner"],
        access: {
          read: [{ kind: "page_viewer", siteId: siteA.id }],
          write: { principals: [{ kind: "page_viewer", siteId: siteA.id }], columns: ["name", "tags", "owner"], create: true },
        },
      })
    ).id;
    const update = (rowId: string, values: Record<string, unknown>, expectedVersion: number, key: string) =>
      exec(BASES_VIEWS_ROWS_UPDATE_ACTION_ID, { viewId, rowId, values, expectedVersion, idempotencyKey: `${key}-${suffix}` });

    const created = await exec(BASES_VIEWS_ROWS_CREATE_ACTION_ID, {
      viewId,
      values: { name: "Listed", tags: "Enterprise", owner: owner.id },
      idempotencyKey: `tags-create-scalar-${suffix}`,
    });
    expect(created.status).toBe(200);
    const rowId = created.body.rowId as string;
    expect((await manage("GET", `deals/rows/${rowId}`)).row.values).toMatchObject({
      name: "Listed",
      tags: [tagIds.Enterprise],
      owner: [owner.id],
    });

    const updated = await update(rowId, { tags: [tagIds.Enterprise, "SMB"] }, 1, "tags-update-array");
    expect(updated.body).toEqual({
      rowId,
      version: 2,
      values: { name: "Listed", tags: [tagIds.Enterprise, tagIds.SMB], owner: [owner.id] },
    });
    const single = await update(rowId, { tags: "SMB" }, 2, "tags-update-scalar");
    expect(single.body).toEqual({ rowId, version: 3, values: { name: "Listed", tags: [tagIds.SMB], owner: [owner.id] } });
    // `""` and null clear.
    const cleared = await update(rowId, { tags: "", owner: null }, 3, "tags-update-clear");
    expect(cleared.body).toEqual({ rowId, version: 4, values: { name: "Listed" } });
  });

  test("Pages read a single { type, id } for ref as a one-item array, and numeric strings convert, like the API", async () => {
    const viewId = (
      await manage("POST", "deals/views", {
        name: "Linker",
        columns: ["name", "amount", "links"],
        access: {
          read: [{ kind: "page_viewer", siteId: siteA.id }],
          write: { principals: [{ kind: "page_viewer", siteId: siteA.id }], columns: ["name", "amount", "links"], create: true },
        },
      })
    ).id;
    const link = { type: "artifact", id: "art_1" };

    // Amounts stay under the Portal and Desk filters (amount >= 5) so later tests see the same rows.
    const created = await exec(BASES_VIEWS_ROWS_CREATE_ACTION_ID, {
      viewId,
      values: { name: "Linked", amount: "3", links: link },
      idempotencyKey: `links-create-one-${suffix}`,
    });
    expect(created.status).toBe(200);
    const rowId = created.body.rowId as string;
    expect((await manage("GET", `deals/rows/${rowId}`)).row.values).toMatchObject({ name: "Linked", amount: 3, links: [link] });

    const update = (values: Record<string, unknown>, expectedVersion: number, key: string) =>
      exec(BASES_VIEWS_ROWS_UPDATE_ACTION_ID, { viewId, rowId, values, expectedVersion, idempotencyKey: `${key}-${suffix}` });
    const updated = await update({ amount: "-2.5" }, 1, "links-update-amount");
    expect(updated.body).toEqual({ rowId, version: 2, values: { name: "Linked", amount: -2.5, links: [link] } });
    const cleared = await update({ links: null }, 2, "links-update-clear");
    expect(cleared.body).toEqual({ rowId, version: 3, values: { name: "Linked", amount: -2.5 } });
  });

  test("rows.get reads one row through the view with its users; outside the filter, archived, or missing is the same not_found", async () => {
    const acme = await exec(BASES_VIEWS_ROWS_GET_ACTION_ID, { viewId: views.desk, rowId: rowIds[0]! });
    expect(acme.status).toBe(200);
    expect(acme.body).toEqual({
      rowId: rowIds[0],
      version: 1,
      values: { name: "Acme", amount: 100, owner: [owner.id] },
      users: { [owner.id]: { id: owner.id, displayName: "Owner", avatarUrl: null } },
    });
    expect(JSON.stringify(acme.body)).not.toContain("s1");

    const portal = await exec(BASES_VIEWS_ROWS_GET_ACTION_ID, { viewId: views.portal, rowId: rowIds[0]! });
    expect(portal.body).toEqual({ rowId: rowIds[0], version: 1, values: { name: "Acme", status: statusIds.Open, amount: 100 }, users: {} });

    // Eta (amount 1) is outside the filter; Eps is archived for this check.
    await db.update(schema.baseRows).set({ archivedAt: new Date() }).where(eq(schema.baseRows.id, rowIds[4]!));
    try {
      for (const rowId of [rowIds[6]!, rowIds[4]!, randomUUID()]) {
        for (const viewId of [views.desk, views.portal]) {
          expect(await exec(BASES_VIEWS_ROWS_GET_ACTION_ID, { viewId, rowId })).toEqual({ status: 404, body: { error: "not_found" } });
        }
      }
    } finally {
      await db.update(schema.baseRows).set({ archivedAt: null }).where(eq(schema.baseRows.id, rowIds[4]!));
    }

    // No page_viewer grant: not found. Write-only (form) view: no row reads.
    for (const viewId of [views.team, views.foreign]) {
      expect(await exec(BASES_VIEWS_ROWS_GET_ACTION_ID, { viewId, rowId: rowIds[0]! })).toEqual({ status: 404, body: { error: "not_found" } });
    }
    expect((await exec(BASES_VIEWS_ROWS_GET_ACTION_ID, { viewId: views.form, rowId: rowIds[0]! })).status).toBe(403);
  });

  test("rows.archive needs a write principal with archive, the row inside the filter, its version, and Origin", async () => {
    const archive = (viewId: string, rowId: string, expectedVersion: number, options: { origin?: string | null } = {}) =>
      exec(BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID, { viewId, rowId, expectedVersion }, options);
    const delta = rowIds[3]!;
    const archivedAt = async (rowId: string) =>
      (await db.select({ archivedAt: schema.baseRows.archivedAt }).from(schema.baseRows).where(eq(schema.baseRows.id, rowId)))[0]?.archivedAt;

    for (const origin of [null, "https://evil.example", `http://${siteA.host}`]) {
      expect(await archive(views.desk, delta, 1, { origin })).toEqual({ status: 401, body: { error: "connector_unauthorized" } });
    }
    // Write principals without archive (portal, form) are forbidden; views without a grant are not found.
    expect(await archive(views.portal, delta, 1)).toEqual({ status: 403, body: { error: "base_forbidden" } });
    expect(await archive(views.form, delta, 1)).toEqual({ status: 403, body: { error: "base_forbidden" } });
    expect(await archive(views.team, delta, 1)).toEqual({ status: 404, body: { error: "not_found" } });
    // Outside the view filter: not found, never a conflict.
    expect(await archive(views.desk, rowIds[6]!, 99)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await archive(views.desk, randomUUID(), 1)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await archivedAt(delta)).toBeNull();

    // A stale version returns the current row projected through the view.
    expect(await archive(views.desk, rowIds[0]!, 99)).toEqual({
      status: 409,
      body: { error: "version_conflict", current: { rowId: rowIds[0], version: 1, values: { name: "Acme", amount: 100, owner: [owner.id] } } },
    });

    expect(await archive(views.desk, delta, 1)).toEqual({ status: 200, body: { rowId: delta, version: 2 } });
    expect(await archivedAt(delta)).toBeInstanceOf(Date);
    const ledger = await db
      .select()
      .from(schema.baseRowLedger)
      .where(and(eq(schema.baseRowLedger.rowId, delta), eq(schema.baseRowLedger.action, "archived")));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ actorType: "user", actorId: pageViewer.id, surface: "page", viewId: views.desk, version: 2 });

    // The archived row left the view: a retry and a read are not found.
    expect(await archive(views.desk, delta, 2)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await exec(BASES_VIEWS_ROWS_GET_ACTION_ID, { viewId: views.desk, rowId: delta })).toEqual({ status: 404, body: { error: "not_found" } });
  });

  test("rows.get and rows.archive refuse sessions that are not human viewers", async () => {
    const capture = sessionRecord({ issuedFromClaimCodeId: null, metadataJson: { source: "pages.capture" } });
    expect(await exec(BASES_VIEWS_ROWS_GET_ACTION_ID, { viewId: views.desk, rowId: rowIds[0]! }, { session: capture })).toEqual({
      status: 403,
      body: { error: "connector_permission_required" },
    });
    expect(
      await exec(BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID, { viewId: views.desk, rowId: rowIds[0]!, expectedVersion: 1 }, { session: capture }),
    ).toEqual({ status: 403, body: { error: "connector_permission_required" } });
    const [acme] = await db.select({ archivedAt: schema.baseRows.archivedAt }).from(schema.baseRows).where(eq(schema.baseRows.id, rowIds[0]!));
    expect(acme?.archivedAt).toBeNull();
  });

  test("capture sessions and viewers without project read are refused before the service runs", async () => {
    expect(
      await exec(BASES_VIEWS_QUERY_ACTION_ID, { viewId: views.portal }, { session: sessionRecord({ issuedFromClaimCodeId: null, metadataJson: { source: "pages.capture" } }) }),
    ).toEqual({ status: 403, body: { error: "connector_permission_required" } });

    // Project access comes only from the published policy: revoking the viewer's grant refuses the exec.
    const granted = policy.document.rules;
    policy.document.rules = granted.filter((rule) => !rule.principals.some((principal) => principal.id === pageViewer.id));
    await policy.publish();
    try {
      expect(await exec(BASES_VIEWS_QUERY_ACTION_ID, { viewId: views.portal })).toEqual({
        status: 401,
        body: { error: "connector_unauthorized" },
      });
    } finally {
      policy.document.rules = granted;
      await policy.publish();
    }

    membershipRole = "billing";
    try {
      expect(await exec(BASES_VIEWS_QUERY_ACTION_ID, { viewId: views.portal })).toEqual({
        status: 403,
        body: { error: "connector_permission_required" },
      });
    } finally {
      membershipRole = "viewer";
    }
  });

  test("the host allowlist is the union of the uses of every active route", async () => {
    const describeOnly = { catalogSchemaVersion: 1, uses: [{ id: BASES_VIEWS_DESCRIBE_ACTION_ID, revision: 1 }] };
    const queryOnly = { catalogSchemaVersion: 1, uses: [{ id: BASES_VIEWS_QUERY_ACTION_ID, revision: 1 }] };
    const [artifact] = await db
      .insert(schema.artifacts)
      .values({ projectId: projectB.id, slug: `uses-${suffix}`, name: "Uses" })
      .returning();
    const [shippedWithUses, shippedWithout, shippedWithQuery] = await db
      .insert(schema.artifactVersions)
      .values([
        { artifactId: artifact!.id, versionNumber: 1, metadataJson: { connectors: describeOnly } },
        { artifactId: artifact!.id, versionNumber: 2, metadataJson: {} },
        { artifactId: artifact!.id, versionNumber: 3, metadataJson: { connectors: queryOnly } },
      ])
      .returning();
    const routes = await db
      .insert(schema.pageRoutes)
      .values([
        { organizationId: orgId, projectId: projectB.id, siteId: siteB.id, path: "/", matchType: "exact" as const },
        { organizationId: orgId, projectId: projectB.id, siteId: siteB.id, path: "/new", matchType: "exact" as const },
      ])
      .returning();
    // One release per call; `versions[i]` serves `routes[i]`. A ship has a publish row, a manual release has none.
    const release = async (
      releaseNumber: number,
      previousReleaseId: string | null,
      versions: Array<{ id: string }>,
      publishMetadata: Record<string, unknown> | null,
    ) => {
      const [created] = await db
        .insert(schema.pageSiteReleases)
        .values({ organizationId: orgId, projectId: projectB.id, siteId: siteB.id, releaseNumber, previousReleaseId })
        .returning();
      await db.insert(schema.pageReleaseRoutes).values(
        versions.map((version, index) => ({
          organizationId: orgId,
          projectId: projectB.id,
          siteId: siteB.id,
          releaseId: created!.id,
          routeId: routes[index]!.id,
          path: routes[index]!.path,
          matchType: "exact" as const,
          artifactId: artifact!.id,
          artifactVersionId: version.id,
          assetBase: "/",
        })),
      );
      if (publishMetadata) {
        await db.insert(schema.pagePublishes).values({
          organizationId: orgId,
          projectId: projectB.id,
          siteId: siteB.id,
          siteReleaseId: created!.id,
          artifactId: artifact!.id,
          artifactVersionId: versions.at(-1)!.id,
          sourceType: "upload_session",
          status: "completed",
          metadataJson: publishMetadata,
        });
      }
      return created!.id;
    };
    const allowlist = async (activeReleaseId: string) =>
      (
        await getPagesConnectorCatalog(
          { host: siteB.host, pagesSession: null, requestId: randomUUID() },
          {
            findSiteByHost: async () => ({ ...connectorSite(), id: siteB.id, projectId: projectB.id, defaultHostname: siteB.host, activeReleaseId }),
          },
        )
      ).actions
        .map((action) => action.id)
        .sort();
    const curated = curatedPlatformUsesSnapshot()
      .uses.map((item) => item.id)
      .sort();

    try {
      const shipped = await release(1, null, [shippedWithUses!], { source: {}, connectors: describeOnly });
      // `ravi.pages.theme.get` is always allowlisted, with or without uses.
      const withTheme = (...ids: string[]) => [...ids, PAGES_THEME_GET_ACTION_ID].sort();
      expect(await allowlist(shipped)).toEqual(withTheme(BASES_VIEWS_DESCRIBE_ACTION_ID));
      // A later ship of another route without uses keeps what "/" still needs.
      const shippedBare = await release(2, shipped, [shippedWithUses!, shippedWithout!], { source: {} });
      expect(await allowlist(shippedBare)).toEqual(withTheme(BASES_VIEWS_DESCRIBE_ACTION_ID));
      // A ship of "/new" with its own uses adds them; "/" keeps its own.
      const shippedQuery = await release(3, shippedBare, [shippedWithUses!, shippedWithQuery!], { source: {}, connectors: queryOnly });
      expect(await allowlist(shippedQuery)).toEqual(withTheme(BASES_VIEWS_DESCRIBE_ACTION_ID, BASES_VIEWS_QUERY_ACTION_ID));
      // Releases without a publish (a visibility change) read their own routes.
      expect(await allowlist(await release(4, shippedQuery, [shippedWithUses!, shippedWithQuery!], null))).toEqual(
        withTheme(BASES_VIEWS_DESCRIBE_ACTION_ID, BASES_VIEWS_QUERY_ACTION_ID),
      );
      // Re-shipping "/" without uses drops only "/"'s ids.
      expect(await allowlist(await release(5, shippedQuery, [shippedWithout!, shippedWithQuery!], { source: {} }))).toEqual(
        withTheme(BASES_VIEWS_QUERY_ACTION_ID),
      );
      // No active route with a snapshot: curated fallback.
      expect(await allowlist(await release(6, shippedQuery, [shippedWithout!], { source: {} }))).toEqual(curated);
      expect(curated).not.toContain(BASES_VIEWS_DESCRIBE_ACTION_ID);
    } finally {
      await db.delete(schema.pageReleaseRoutes).where(eq(schema.pageReleaseRoutes.siteId, siteB.id));
      await db.delete(schema.pagePublishes).where(eq(schema.pagePublishes.siteId, siteB.id));
      await db.delete(schema.pageSiteReleases).where(eq(schema.pageSiteReleases.siteId, siteB.id));
      await db.delete(schema.pageRoutes).where(eq(schema.pageRoutes.siteId, siteB.id));
      await db.delete(schema.artifacts).where(eq(schema.artifacts.id, artifact!.id));
    }
  });
});
